#include "bsp/esp-bsp.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "frame_cap_pipeline.hpp"
#include "nvs_flash.h"
#include "who_frame_lcd_disp.hpp"
#include "who_yield2idle.hpp"
#include "catdog_classifier.hpp"

using namespace who::frame_cap;
using namespace who::lcd_disp;

static const char *TAG = "camera_catdog_live";
static constexpr TickType_t kInferIntervalTicks = pdMS_TO_TICKS(500);

static WhoFrameCapNode *g_frame_node = nullptr;
static CatDogClassifier *g_classifier = nullptr;
static uint32_t s_frame_count = 0;

// Reference the embedded model binary
extern const uint8_t catdog_mobilenet_v2_espdl_start[] asm("_binary_catdog_mobilenet_v2_espdl_start");

static void classifier_task(void *arg)
{
    (void)arg;
    while (true) {
        if (g_frame_node && g_classifier) {
            auto fb = g_frame_node->cam_fb_peek();
            if (fb) {
                int64_t start = esp_timer_get_time();
                dl::image::img_t img = static_cast<dl::image::img_t>(*fb);
                auto &results = g_classifier->run(img);
                int64_t elapsed = esp_timer_get_time() - start;
                s_frame_count++;
                if (!results.empty()) {
                    ESP_LOGI(TAG, "[%lu] %s: %.4f (推理耗时 %lld us / %.3f ms)",
                             s_frame_count, results[0].cat_name, results[0].score,
                             elapsed, elapsed / 1000.0f);
                }
            }
        }
        vTaskDelay(kInferIntervalTicks);
    }
}

extern "C" void app_main(void)
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    vTaskPrioritySet(xTaskGetCurrentTaskHandle(), 5);

    // Turn off green LED (BSP_LED_1)
    led_indicator_handle_t leds[BSP_LED_NUM];
    ESP_ERROR_CHECK(bsp_led_indicator_create(leds, NULL, BSP_LED_NUM));
    ESP_ERROR_CHECK(bsp_led_set(leds[BSP_LED_1], false));

    // Load classifier from flash rodata
    ESP_LOGI(TAG, "Loading cat/dog classifier from flash rodata");
    g_classifier = new CatDogClassifier(
        (const char *)catdog_mobilenet_v2_espdl_start,
        fbs::MODEL_LOCATION_IN_FLASH_RODATA);
    if (!g_classifier->is_ready()) {
        ESP_LOGE(TAG, "Failed to initialize classifier");
        return;
    }
    ESP_LOGI(TAG, "Classifier loaded successfully");

    // Build camera preview pipeline (3 frame buffers to save PSRAM)
    auto frame_cap = get_preview_frame_cap_pipeline();
    g_frame_node = frame_cap->get_last_node();
    auto lcd_disp = new WhoFrameLCDDisp("LCDDisp", g_frame_node);

    // Start all tasks
    bool ok = who::WhoYield2Idle::get_instance()->run();
    for (const auto &frame_cap_node : frame_cap->get_all_nodes()) {
        ok &= frame_cap_node->run(4096, 2, 0);
    }
    ok &= lcd_disp->run(2560, 2, 0);
    if (!ok) {
        ESP_LOGE(TAG, "Failed to start camera capture / LCD tasks");
        return;
    }

    // Start inference task (stack 8192, priority 3, no core affinity)
    xTaskCreate(classifier_task, "classifier_task", 8192, nullptr, 3, nullptr);

    ESP_LOGI(TAG, "System ready — camera preview + periodic inference running");
}
