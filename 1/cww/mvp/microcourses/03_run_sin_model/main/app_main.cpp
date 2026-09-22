// 第 3 集微课最小案例：ESP32 加载第 2 集量化好的 sin 模型（.espdl）并完成推理。
//
// 本示例用同一个模型、同一个输入（sin(90°)），演示 dl::Model 的三种调用方式，
// 并分别测量推理耗时：
//   run1: 手动 quantize/dequantize（int8 指针读写）
//   run2: 用 float TensorBase + assign 自动量化/反量化
//   run3: 用 input_map / output_map 指定输入输出
//
// 相比原型工程，本示例增加了：
//   1. load/build 两阶段加载，能检测模型加载失败（构造函数失败时静默，不可用）
//   2. esp_timer_get_time() 测量每次推理耗时
//   3. model->test() 板上自检（依赖第 2 集量化时 export_test_values=True）

#include "dl_model_base.hpp"
#include "esp_log.h"
#include "esp_timer.h"
#include <cmath>

static const char *TAG = "run_sin_model";

// .espdl 通过 CMake 的 target_add_aligned_binary_data 嵌入到 flash rodata
extern const uint8_t model_espdl[] asm("_binary_model_espdl_start");

static const int degree = 90;

// 两阶段加载模型：load 返回 esp_err_t，可检测加载失败；成功后再 build 分配内存。
static dl::Model *load_model(void)
{
    dl::Model *model = new dl::Model();
    // load 有多个重载且第三参均带默认值，显式传 key（const uint8_t*）消除歧义。
    esp_err_t ret = model->load((const char *)model_espdl,
                                fbs::MODEL_LOCATION_IN_FLASH_RODATA,
                                (const uint8_t *)nullptr);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "模型加载失败: %s", esp_err_to_name(ret));
        delete model;
        return NULL;
    }
    model->build(0);
    return model;
}

// run1: 展示 model->run() 的最底层用法——手动量化输入、手动反量化输出。
static void run1()
{
    dl::Model *model = load_model();
    if (!model) {
        return;
    }

    std::map<std::string, dl::TensorBase *> model_inputs = model->get_inputs();
    dl::TensorBase *model_input = model_inputs.begin()->second;
    std::map<std::string, dl::TensorBase *> model_outputs = model->get_outputs();
    dl::TensorBase *model_output = model_outputs.begin()->second;

    // 量化 float 输入并写入模型输入缓冲。
    float input_v = degree * M_PI / 180;
    // 注意：dl::quantize 第二个参数是 scale 的倒数，所以用 DL_RESCALE。
    int8_t quant_input_v = dl::quantize<int8_t>(input_v, DL_RESCALE(model_input->exponent));
    int8_t *input_ptr = (int8_t *)model_input->data;
    *input_ptr = quant_input_v;

    int64_t t0 = esp_timer_get_time();
    model->run();
    int64_t t1 = esp_timer_get_time();

    // 读出输出并反量化为 float。
    int8_t *output_ptr = (int8_t *)model_output->data;
    float output_v = dl::dequantize(*output_ptr, DL_SCALE(model_output->exponent));

    float expected = sinf(input_v);
    printf("[run1] sin(%d degree) = %f (期望 %f, 误差 %+.4f), 推理耗时 %lld us (%.3f ms)\n",
           degree, output_v, expected, output_v - expected, t1 - t0, (t1 - t0) / 1000.0f);

    delete model;
}

// run2: 与 run1 相同，但用 float TensorBase + assign，由 ESP-DL 自动完成量化/反量化。
static void run2()
{
    dl::Model *model = load_model();
    if (!model) {
        return;
    }

    dl::TensorBase *model_input = model->get_inputs().begin()->second;
    dl::TensorBase *model_output = model->get_outputs().begin()->second;

    float input_v = degree * M_PI / 180;
    // 构造形状 [1,1] 的 float 输入张量
    dl::TensorBase *input_tensor = new dl::TensorBase({1, 1}, nullptr, 0, dl::DATA_TYPE_FLOAT);
    *(float *)input_tensor->data = input_v;
    model_input->assign(input_tensor);

    int64_t t0 = esp_timer_get_time();
    model->run();
    int64_t t1 = esp_timer_get_time();

    // 构造 float 输出张量并反量化
    dl::TensorBase *output_tensor = new dl::TensorBase({1, 1}, nullptr, 0, dl::DATA_TYPE_FLOAT);
    output_tensor->assign(model_output);
    float output_v = *(float *)output_tensor->data;

    float expected = sinf(input_v);
    printf("[run2] sin(%d degree) = %f (期望 %f, 误差 %+.4f), 推理耗时 %lld us (%.3f ms)\n",
           degree, output_v, expected, output_v - expected, t1 - t0, (t1 - t0) / 1000.0f);

    delete input_tensor;
    delete output_tensor;
    delete model;
}

// run3: 用 run(user_inputs, mode, user_outputs) 显式指定输入输出映射。
static void run3()
{
    dl::Model *model = load_model();
    if (!model) {
        return;
    }

    float input_v = degree * M_PI / 180;
    dl::TensorBase *input_tensor = new dl::TensorBase({1, 1}, nullptr, 0, dl::DATA_TYPE_FLOAT);
    *(float *)input_tensor->data = input_v;
    std::string input_name = model->get_inputs().begin()->first;
    std::map<std::string, dl::TensorBase *> input_map = {{input_name, input_tensor}};

    dl::TensorBase *output_tensor = new dl::TensorBase({1, 1}, nullptr, 0, dl::DATA_TYPE_FLOAT);
    std::string output_name = model->get_outputs().begin()->first;
    std::map<std::string, dl::TensorBase *> output_map = {{output_name, output_tensor}};

    int64_t t0 = esp_timer_get_time();
    model->run(input_map, dl::RUNTIME_MODE_SINGLE_CORE, output_map);
    int64_t t1 = esp_timer_get_time();

    float output_v = *(float *)output_tensor->data;
    float expected = sinf(input_v);
    printf("[run3] sin(%d degree) = %f (期望 %f, 误差 %+.4f), 推理耗时 %lld us (%.3f ms)\n",
           degree, output_v, expected, output_v - expected, t1 - t0, (t1 - t0) / 1000.0f);

    delete input_tensor;
    delete output_tensor;
    delete model;
}

// 板上自检：用第 2 集量化时 export_test_values=True 嵌入的测试输入/输出验证推理正确性。
static void self_test()
{
    dl::Model *model = load_model();
    if (!model) {
        return;
    }
    esp_err_t ret = model->test();
    ESP_LOGI(TAG, "模型自检 test(): %s", ret == ESP_OK ? "PASS" : "FAIL");
    delete model;
}

extern "C" void app_main(void)
{
    ESP_LOGI(TAG, "第 3 集：ESP32 加载 sin 量化模型推理（输入 sin(%d degree)）", degree);
    run1();
    run2();
    run3();
    self_test();
    ESP_LOGI(TAG, "完成");
}
