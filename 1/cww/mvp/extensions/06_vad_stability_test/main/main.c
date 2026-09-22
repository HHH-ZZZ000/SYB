#include <stdio.h>
#include <stdlib.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_afe_sr_iface.h"
#include "esp_afe_sr_models.h"
#include "esp_vadn_models.h"
#include "voice_common.h"
#include "model_path.h"

#define TEST_WINDOW_MS 30000
static const char *TAG = "ext06_vad";
static const esp_afe_sr_iface_t *afe_handle;
static srmodel_list_t *models;

static void feed_task(void *arg)
{
    esp_afe_sr_data_t *data = arg;
    int chunk = afe_handle->get_feed_chunksize(data);
    int channels = afe_handle->get_feed_channel_num(data);
    int16_t *buffer = malloc(chunk * sizeof(int16_t) * channels);
    assert(buffer);
    while (true) {
        ESP_ERROR_CHECK(voice_read_samples(buffer, (size_t)chunk * channels));
        afe_handle->feed(data, buffer);
    }
}

static void detect_task(void *arg)
{
    esp_afe_sr_data_t *data = arg;
    int previous = -1;
    int speech_events = 0;
    int state_changes = 0;
    TickType_t window_start = xTaskGetTickCount();
    TickType_t speech_start = 0;
    while (true) {
        afe_fetch_result_t *result = afe_handle->fetch(data);
        if (!result || result->ret_value == ESP_FAIL) {
            ESP_LOGE(TAG, "fetch_error");
            break;
        }
        int state = result->vad_state == VAD_SPEECH;
        if (state != previous) {
            state_changes++;
            if (state) {
                speech_events++;
                speech_start = xTaskGetTickCount();
            } else if (speech_start != 0) {
                ESP_LOGI(TAG, "segment_duration_ms=%u",
                         (unsigned)pdTICKS_TO_MS(xTaskGetTickCount() - speech_start));
                speech_start = 0;
            }
            ESP_LOGI(TAG, "state=%s", state ? "SPEECH" : "NOISE");
            previous = state;
        }
        if (xTaskGetTickCount() - window_start >= pdMS_TO_TICKS(TEST_WINDOW_MS)) {
            ESP_LOGI(TAG, "summary window_ms=%d speech_events=%d state_changes=%d",
                     TEST_WINDOW_MS, speech_events, state_changes);
            speech_events = 0;
            state_changes = 0;
            window_start = xTaskGetTickCount();
        }
    }
    vTaskDelete(NULL);
}

void app_main(void)
{
    ESP_ERROR_CHECK(voice_audio_init());
    models = esp_srmodel_init("model");
    afe_config_t *config = afe_config_init(voice_get_input_format(), models, AFE_TYPE_SR, AFE_MODE_LOW_COST);
    config->vad_min_speech_ms = 128;
    config->vad_min_noise_ms = 1000;
    config->vad_mode = VAD_MODE_1;
    afe_handle = esp_afe_handle_from_config(config);
    esp_afe_sr_data_t *data = afe_handle->create_from_config(config);
    afe_config_free(config);
    ESP_LOGI(TAG, "scenario=run quiet/speech/noise separately");
    xTaskCreatePinnedToCore(feed_task, "afe_feed", 8192, data, 5, NULL, 0);
    xTaskCreatePinnedToCore(detect_task, "vad_test", 8192, data, 5, NULL, 1);
}
