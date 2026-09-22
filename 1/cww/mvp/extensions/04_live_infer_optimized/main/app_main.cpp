#include "bsp/esp-bsp.h"
#include "esp_clk_tree.h"
#include "esp_heap_caps.h"
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
#include "trace_json.hpp"

using namespace who::frame_cap;
using namespace who::lcd_disp;

static const char *TAG = "catdog_live_infer_optimized";
static constexpr TickType_t kInferIntervalTicks = pdMS_TO_TICKS(500);
static constexpr UBaseType_t kPreviewPriority = 2;
static constexpr BaseType_t kInferCore = 1;
static constexpr UBaseType_t kInferPriority = 3;
#if PERFETTO_TRACE_JSON
static constexpr uint32_t kTraceInferLimit = 3;
#endif

static WhoFrameCapNode *g_frame_node = nullptr;
static CatDogClassifier *g_classifier = nullptr;
static uint32_t g_infer_count = 0;
static uint32_t g_preview_count = 0;
#if !PERFETTO_TRACE_JSON
static int64_t g_last_infer_end = 0;
#endif
static int64_t g_preview_window_start = 0;

extern const uint8_t catdog_mobilenet_v2_espdl_start[] asm("_binary_catdog_mobilenet_v2_espdl_start");

static void preview_measurement(who::cam::cam_fb_t *)
{
    const int64_t now = esp_timer_get_time();
    g_preview_count++;
    if (g_preview_window_start == 0) {
        g_preview_window_start = now;
    }
    if (g_preview_count % 30 == 0) {
#if PERFETTO_TRACE_JSON
        perfetto_trace::record_complete("preview_window", "preview",
                                        g_preview_window_start, now,
                                        1, 10, xPortGetCoreID());
#else
        const double elapsed_s = (now - g_preview_window_start) / 1000000.0;
        ESP_LOGI(TAG, "preview frames=%" PRIu32 " fps=%.2f", g_preview_count, 30.0 / elapsed_s);
#endif
        g_preview_window_start = now;
    }
}

static void classifier_task(void *)
{
    while (true) {
#if PERFETTO_TRACE_JSON
        const int64_t task_start = esp_timer_get_time();
        const int64_t frame_peek_start = task_start;
#endif
        auto fb = g_frame_node ? g_frame_node->cam_fb_peek() : nullptr;
#if PERFETTO_TRACE_JSON
        const int64_t frame_peek_end = esp_timer_get_time();
#endif
        if (fb && g_classifier) {
#if PERFETTO_TRACE_JSON
            const int64_t input_prepare_start = esp_timer_get_time();
#endif
#if !PERFETTO_TRACE_JSON
            const int64_t start = esp_timer_get_time();
#endif
            dl::image::img_t img = static_cast<dl::image::img_t>(*fb);
#if PERFETTO_TRACE_JSON
            const int64_t input_prepare_end = esp_timer_get_time();
            const int64_t infer_start = input_prepare_end;
            g_classifier->run(img);
#else
            auto &results = g_classifier->run(img);
#endif
            const int64_t end = esp_timer_get_time();
            g_infer_count++;
#if PERFETTO_TRACE_JSON
            perfetto_trace::record_complete("classifier_task", "vision",
                                            task_start, end,
                                            1, 11, xPortGetCoreID());
            perfetto_trace::record_complete("frame_peek", "vision",
                                            frame_peek_start, frame_peek_end,
                                            1, 11, xPortGetCoreID());
            perfetto_trace::record_complete("input_prepare", "vision",
                                            input_prepare_start, input_prepare_end,
                                            1, 11, xPortGetCoreID());
            perfetto_trace::record_complete("infer", "vision",
                                            infer_start, end,
                                            1, 11, xPortGetCoreID());
            if (g_infer_count >= kTraceInferLimit) {
                perfetto_trace::dump();
                vTaskDelete(nullptr);
                return;
            }
#else
            const double period = g_last_infer_end == 0 ? 0.0 : (end - g_last_infer_end) / 1000000.0;
            g_last_infer_end = end;
            const double frame_age_ms = (end - (int64_t)fb->timestamp.tv_sec * 1000000 - fb->timestamp.tv_usec) / 1000.0;
            ESP_LOGI(TAG, "infer[%" PRIu32 "] core=%d cpu=%dMHz infer=%.3fms period=%.3fs frame_age=%.3fms heap=%" PRIu32 " psram=%" PRIu32 " %s %.4f",
                     g_infer_count, xPortGetCoreID(), esp_clk_cpu_freq() / 1000000,
                     (end - start) / 1000.0, period, frame_age_ms,
                     static_cast<uint32_t>(esp_get_free_heap_size()),
                     static_cast<uint32_t>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM)),
                     results.empty() ? "none" : results[0].cat_name,
                     results.empty() ? 0.0f : results[0].score);
#endif
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

#if PERFETTO_TRACE_JSON
    perfetto_trace::init();
#endif

    led_indicator_handle_t leds[BSP_LED_NUM];
    ESP_ERROR_CHECK(bsp_led_indicator_create(leds, NULL, BSP_LED_NUM));
    ESP_ERROR_CHECK(bsp_led_set(leds[BSP_LED_1], false));

    ESP_LOGI(TAG, "Loading classifier");
    g_classifier = new CatDogClassifier((const char *)catdog_mobilenet_v2_espdl_start);
    if (!g_classifier->is_ready()) {
        ESP_LOGE(TAG, "Classifier initialization failed");
        return;
    }

    auto frame_cap = get_preview_frame_cap_pipeline();
    g_frame_node = frame_cap->get_last_node();
    auto lcd_disp = new WhoFrameLCDDisp("LCDDisp", g_frame_node);
    lcd_disp->set_lcd_disp_cb(preview_measurement);

    bool ok = who::WhoYield2Idle::get_instance()->run();
    for (const auto &node : frame_cap->get_all_nodes()) {
        ok &= node->run(4096, kPreviewPriority, 0);
    }
    ok &= lcd_disp->run(2560, kPreviewPriority, 0);
    if (!ok) {
        ESP_LOGE(TAG, "Failed to start preview pipeline");
        return;
    }

    // Optimization: isolate inference on CPU1 and leave camera/LCD on CPU0.
    xTaskCreatePinnedToCore(classifier_task, "classifier_task", 8192, nullptr, kInferPriority, nullptr, kInferCore);
    ESP_LOGI(TAG, "Ready: preview CPU0 priority=%u, inference CPU%d priority=%u, CPU=%dMHz",
             kPreviewPriority, kInferCore, kInferPriority, esp_clk_cpu_freq() / 1000000);
}
