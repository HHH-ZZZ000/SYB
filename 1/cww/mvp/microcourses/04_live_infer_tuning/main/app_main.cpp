#include "bsp/esp-bsp.h"
#include "esp_log.h"
#include "esp_private/esp_clk.h"
#include "esp_timer.h"
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "frame_cap_pipeline.hpp"
#include "nvs_flash.h"
#include "who_frame_lcd_disp.hpp"
#include "who_yield2idle.hpp"
#include "catdog_classifier.hpp"
#include "perf_config.h"

using namespace who::frame_cap;
using namespace who::lcd_disp;
static const char *TAG = "catdog_perf_tuning";
static constexpr TickType_t kInferIntervalTicks = pdMS_TO_TICKS(500);
static constexpr UBaseType_t kInferPriority = 3;
static WhoFrameCapNode *g_frame_node = nullptr;
static CatDogClassifier *g_classifier = nullptr;
static uint32_t s_infer_count = 0;
static int64_t s_last_infer_end_us = 0;

extern const uint8_t catdog_mobilenet_v2_espdl_start[] asm("_binary_catdog_mobilenet_v2_espdl_start");

static void classifier_task(void *)
{
    while (true) {
        auto fb = g_frame_node ? g_frame_node->cam_fb_peek() : nullptr;
        if (fb && g_classifier) {
            int64_t start = esp_timer_get_time();
            dl::image::img_t img = static_cast<dl::image::img_t>(*fb);
            g_classifier->run(img);
            int64_t end = esp_timer_get_time();
            int64_t period = s_last_infer_end_us == 0 ? 0 : end - s_last_infer_end_us;
            s_last_infer_end_us = end;
            ++s_infer_count;
            ESP_LOGI(TAG,
                     "[%" PRIu32 "] core=%d cpu=%dMHz infer=%.3fms period=%.3fs",
                     s_infer_count, xPortGetCoreID(),
                     (int)(esp_clk_cpu_freq() / 1000000),
                     (end - start) / 1000.0f, period / 1000000.0f);
        }
        vTaskDelay(kInferIntervalTicks);
    }
}

extern "C" void app_main()
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);
    vTaskPrioritySet(xTaskGetCurrentTaskHandle(), 5);

    led_indicator_handle_t leds[BSP_LED_NUM];
    ESP_ERROR_CHECK(bsp_led_indicator_create(leds, NULL, BSP_LED_NUM));
    ESP_ERROR_CHECK(bsp_led_set(leds[BSP_LED_1], false));

    ESP_LOGI(TAG, "Loading cat/dog classifier from flash rodata");
    g_classifier = new CatDogClassifier((const char *)catdog_mobilenet_v2_espdl_start,
                                        fbs::MODEL_LOCATION_IN_FLASH_RODATA);
    if (!g_classifier->is_ready()) {
        ESP_LOGE(TAG, "Failed to initialize classifier");
        return;
    }

    auto frame_cap = get_preview_frame_cap_pipeline();
    g_frame_node = frame_cap->get_last_node();
    auto lcd_disp = new WhoFrameLCDDisp("LCDDisp", g_frame_node);
    bool ok = who::WhoYield2Idle::get_instance()->run();
    for (const auto &node : frame_cap->get_all_nodes()) ok &= node->run(4096, 2, 0);
    ok &= lcd_disp->run(2560, 2, 0);
    if (!ok) {
        ESP_LOGE(TAG, "Failed to start camera capture / LCD tasks");
        return;
    }

    BaseType_t task_result = xTaskCreatePinnedToCore(classifier_task, "classifier_task", 8192,
                                                     nullptr, kInferPriority,
                                                     nullptr, CATDOG_INFER_CORE);
    if (task_result != pdPASS) {
        ESP_LOGE(TAG, "Failed to start classifier task on CPU%d", CATDOG_INFER_CORE);
        return;
    }
    ESP_LOGI(TAG, "Ready: preview CPU0, inference CPU%d, CPU=%dMHz",
             CATDOG_INFER_CORE, (int)(esp_clk_cpu_freq() / 1000000));
}
