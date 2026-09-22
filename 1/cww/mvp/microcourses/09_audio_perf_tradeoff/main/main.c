#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <inttypes.h>

#include "esp_afe_sr_iface.h"
#include "esp_afe_sr_models.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_private/esp_clk.h"
#include "esp_mn_iface.h"
#include "esp_mn_models.h"
#include "esp_process_sdkconfig.h"
#include "esp_timer.h"
#include "esp_wn_iface.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "model_path.h"
#include "voice_common.h"

#include "perf_config.h"
#include "voice_benchmark.h"

static const char *TAG = "lesson09_bench";
static const esp_afe_sr_iface_t *s_afe_handle;
static srmodel_list_t *s_models;
static volatile bool s_running = true;

static const char *bench_mode_name(void)
{
#if VOICE_BENCH_MODE == VOICE_BENCH_MODE_VAD
    return "VAD";
#elif VOICE_BENCH_MODE == VOICE_BENCH_MODE_WAKENET
    return "WakeNet";
#else
    return "MultiNet";
#endif
}

static void feed_task(void *arg)
{
    esp_afe_sr_data_t *afe_data = arg;
    const int chunk = s_afe_handle->get_feed_chunksize(afe_data);
    const int channels = s_afe_handle->get_feed_channel_num(afe_data);
    int16_t *buffer = calloc((size_t)chunk * channels, sizeof(int16_t));
    if (!buffer) {
        ESP_LOGE(TAG, "feed_alloc_failed samples=%d", chunk * channels);
        s_running = false;
        vTaskDelete(NULL);
        return;
    }

    while (s_running) {
        esp_err_t err = voice_read_samples(buffer, (size_t)chunk * channels);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "feed_error=%s", esp_err_to_name(err));
            s_running = false;
            break;
        }
        s_afe_handle->feed(afe_data, buffer);
    }
    free(buffer);
    vTaskDelete(NULL);
}

static void benchmark_task(void *arg)
{
    esp_afe_sr_data_t *afe_data = arg;
    voice_bench_stats_t fetch_stats;
    voice_bench_stats_t detect_stats;
    voice_bench_stats_init(&fetch_stats);
    voice_bench_stats_init(&detect_stats);

#if VOICE_BENCH_MODE == VOICE_BENCH_MODE_MULTINET
    esp_mn_iface_t *multinet = NULL;
    model_iface_data_t *multinet_data = NULL;
    char *mn_name = esp_srmodel_filter(s_models, ESP_MN_PREFIX, ESP_MN_CHINESE);
    if (!mn_name) {
        ESP_LOGE(TAG, "multinet_model_not_found");
        s_running = false;
        vTaskDelete(NULL);
        return;
    }
    multinet = esp_mn_handle_from_name(mn_name);
    multinet_data = multinet->create(mn_name, 6000);
    if (!multinet_data) {
        ESP_LOGE(TAG, "multinet_create_failed");
        s_running = false;
        vTaskDelete(NULL);
        return;
    }
    esp_mn_commands_update_from_sdkconfig(multinet, multinet_data);
    multinet->print_active_speech_commands(multinet_data);
#endif

    const int64_t start_us = esp_timer_get_time();
    const int64_t deadline_us = start_us + (int64_t)VOICE_BENCH_DURATION_MS * 1000;
    ESP_LOGI(TAG, "[BENCH] start mode=%s duration_ms=%d cpu=%" PRIu32 "MHz",
             bench_mode_name(), VOICE_BENCH_DURATION_MS,
             (uint32_t)(esp_clk_cpu_freq() / 1000000U));

    while (s_running && esp_timer_get_time() < deadline_us) {
        const int64_t fetch_start = esp_timer_get_time();
        afe_fetch_result_t *result = s_afe_handle->fetch(afe_data);
        const uint32_t fetch_us = (uint32_t)(esp_timer_get_time() - fetch_start);
        if (!result || result->ret_value == ESP_FAIL) {
            ESP_LOGE(TAG, "fetch_error");
            break;
        }

#if VOICE_BENCH_MODE == VOICE_BENCH_MODE_MULTINET
        const int64_t detect_start = esp_timer_get_time();
        esp_mn_state_t state = multinet->detect(multinet_data, result->data);
        const uint32_t detect_us = (uint32_t)(esp_timer_get_time() - detect_start);
        voice_bench_stats_add(&detect_stats, detect_us);
        if (state == ESP_MN_STATE_DETECTED) {
            esp_mn_results_t *results = multinet->get_results(multinet_data);
            ESP_LOGI(TAG, "event=COMMAND_DETECTED id=%d phrase=%s",
                     results && results->num ? results->command_id[0] : -1,
                     results && results->num ? results->string : "none");
            multinet->clean(multinet_data);
        } else if (state == ESP_MN_STATE_TIMEOUT) {
            multinet->clean(multinet_data);
        }
        ESP_LOGI(TAG, "[BENCH] stage=multinet_detect elapsed_us=%" PRIu32
                 " core=%d internal_free=%" PRIu32 " psram_free=%" PRIu32,
                 detect_us, xPortGetCoreID(),
                 (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                 (uint32_t)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
#else
        voice_bench_stats_add(&fetch_stats, fetch_us);
        ESP_LOGI(TAG, "[BENCH] stage=afe_fetch mode=%s elapsed_us=%" PRIu32
                 " core=%d internal_free=%" PRIu32 " psram_free=%" PRIu32
                 " vad=%d wake=%d",
                 bench_mode_name(), fetch_us, xPortGetCoreID(),
                 (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                 (uint32_t)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
                 result->vad_state == VAD_SPEECH,
                 result->wakeup_state == WAKENET_DETECTED);
#endif
    }

    voice_bench_stats_log(TAG, bench_mode_name(), "afe_fetch", &fetch_stats);
    voice_bench_stats_log(TAG, bench_mode_name(), "multinet_detect", &detect_stats);
    ESP_LOGI(TAG, "done mode=%s", bench_mode_name());
    s_running = false;

#if VOICE_BENCH_MODE == VOICE_BENCH_MODE_MULTINET
    multinet->destroy(multinet_data);
#endif
    s_afe_handle->destroy(afe_data);
    vTaskDelete(NULL);
}

void app_main(void)
{
    ESP_ERROR_CHECK(voice_audio_init());
    s_models = esp_srmodel_init("model");
    if (!s_models) {
        ESP_LOGE(TAG, "srmodel_init_failed");
        return;
    }

    afe_config_t *config = afe_config_init(voice_get_input_format(), s_models,
                                           AFE_TYPE_SR, AFE_MODE_LOW_COST);
    if (!config) {
        ESP_LOGE(TAG, "afe_config_init_failed");
        return;
    }
    config->vad_min_speech_ms = 128;
    config->vad_min_noise_ms = 1000;
    config->vad_mode = VAD_MODE_1;
#if VOICE_BENCH_MODE == VOICE_BENCH_MODE_VAD
    config->vad_init = true;
    config->wakenet_init = false;
    ESP_LOGI(TAG, "algorithms=VAD");
#elif VOICE_BENCH_MODE == VOICE_BENCH_MODE_WAKENET
    config->vad_init = false;
    config->wakenet_init = true;
    ESP_LOGI(TAG, "algorithms=WakeNet");
#else
    config->vad_init = false;
    config->wakenet_init = false;
    ESP_LOGI(TAG, "algorithms=MultiNet");
#endif

    s_afe_handle = esp_afe_handle_from_config(config);
    esp_afe_sr_data_t *afe_data = s_afe_handle->create_from_config(config);
    afe_config_free(config);
    if (!afe_data) {
        ESP_LOGE(TAG, "afe_create_failed");
        return;
    }

    ESP_LOGI(TAG, "ready mode=%s change main/perf_config.h to select one mode",
             bench_mode_name());
    xTaskCreatePinnedToCore(feed_task, "bench_feed", 8192, afe_data, 5, NULL, 0);
    xTaskCreatePinnedToCore(benchmark_task, "bench_run", 12288, afe_data, 5, NULL, 1);
}
