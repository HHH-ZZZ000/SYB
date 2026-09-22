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
#include "trace_json.hpp"

using namespace who::frame_cap;
using namespace who::lcd_disp;

static const char *TAG = "catdog_perfetto_trace";
static constexpr TickType_t kInferIntervalTicks = pdMS_TO_TICKS(500);
static constexpr UBaseType_t kInferPriority = 3;

#if PERFETTO_TRACE_JSON
static constexpr uint32_t kTraceInferLimit = 3;
static uint32_t s_preview_count = 0;
static int64_t s_preview_window_start_us = 0;
#endif

static WhoFrameCapNode *g_frame_node = nullptr;
static CatDogClassifier *g_classifier = nullptr;
static uint32_t s_infer_count = 0;
#if !PERFETTO_TRACE_JSON
static int64_t s_last_infer_end_us = 0;
#endif

extern const uint8_t catdog_mobilenet_v2_espdl_start[] asm("_binary_catdog_mobilenet_v2_espdl_start");

#if PERFETTO_TRACE_JSON
static void preview_measurement(who::cam::cam_fb_t *)
{
    const int64_t now_us = esp_timer_get_time();
    ++s_preview_count;
    if (s_preview_window_start_us == 0) {
        s_preview_window_start_us = now_us;
    }
    if (s_preview_count % 30 == 0) {
        perfetto_trace::record_complete("preview_window", "preview",
                                        s_preview_window_start_us, now_us,
                                        1, 10, xPortGetCoreID());
        s_preview_window_start_us = now_us;
    }
}
#endif

static void classifier_task(void *)
{
    while (true) {
#if PERFETTO_TRACE_JSON
        const int64_t task_start_us = esp_timer_get_time();
        const int64_t frame_peek_start_us = task_start_us;
#endif
        auto fb = g_frame_node ? g_frame_node->cam_fb_peek() : nullptr;
#if PERFETTO_TRACE_JSON
        const int64_t frame_peek_end_us = esp_timer_get_time();
#endif
        if (fb && g_classifier) {
#if PERFETTO_TRACE_JSON
            const int64_t input_prepare_start_us = esp_timer_get_time();
#else
            const int64_t start_us = esp_timer_get_time();
#endif
            dl::image::img_t img = static_cast<dl::image::img_t>(*fb);
#if PERFETTO_TRACE_JSON
            const int64_t input_prepare_end_us = esp_timer_get_time();
            const int64_t infer_start_us = input_prepare_end_us;
            g_classifier->run(img);
#else
            g_classifier->run(img);
#endif
            const int64_t end_us = esp_timer_get_time();
            ++s_infer_count;
#if PERFETTO_TRACE_JSON
            perfetto_trace::record_complete("classifier_task", "vision",
                                            task_start_us, end_us,
                                            1, 11, xPortGetCoreID());
            perfetto_trace::record_complete("frame_peek", "vision",
                                            frame_peek_start_us, frame_peek_end_us,
                                            1, 11, xPortGetCoreID());
            perfetto_trace::record_complete("input_prepare", "vision",
                                            input_prepare_start_us, input_prepare_end_us,
                                            1, 11, xPortGetCoreID());
            perfetto_trace::record_complete("infer", "vision",
                                            infer_start_us, end_us,
                                            1, 11, xPortGetCoreID());
            if (s_infer_count >= kTraceInferLimit) {
                perfetto_trace::dump();
                vTaskDelete(nullptr);
                return;
            }
#else
            const int64_t period_us = s_last_infer_end_us == 0 ? 0 : end_us - s_last_infer_end_us;
            s_last_infer_end_us = end_us;
            ESP_LOGI(TAG,
                     "[%" PRIu32 "] core=%d cpu=%dMHz infer=%.3fms period=%.3fs",
                     s_infer_count, xPortGetCoreID(),
                     (int)(esp_clk_cpu_freq() / 1000000),
                     (end_us - start_us) / 1000.0f, period_us / 1000000.0f);
#endif
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
#if PERFETTO_TRACE_JSON
    lcd_disp->set_lcd_disp_cb(preview_measurement);
    perfetto_trace::init();
#endif
    bool ok = who::WhoYield2Idle::get_instance()->run();
    for (const auto &node : frame_cap->get_all_nodes()) ok &= node->run(4096, 2, 0);
    ok &= lcd_disp->run(2560, 2, 0);
    if (!ok) {
        ESP_LOGE(TAG, "Failed to start camera capture / LCD tasks");
        return;
    }

    // Keep the microcourse's intentionally contended baseline: inference and
    // camera/LCD tasks all run on CPU0.
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
