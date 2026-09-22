#include <stdio.h>

#include "esp_log.h"
#include "voice_common.h"

#define RECORD_SECONDS 10

static const char *TAG = "lesson05_record";

static esp_err_t record_audio(void)
{
    int16_t samples[VOICE_FEED_SAMPLES];
    uint32_t total_samples = 0;
    const uint32_t target_samples = VOICE_SAMPLE_RATE * RECORD_SECONDS;
    uint32_t next_log = VOICE_SAMPLE_RATE; // log every 1 second

    while (total_samples < target_samples) {
        esp_err_t err = voice_read_samples(samples, VOICE_FEED_SAMPLES);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "audio_error=%s", esp_err_to_name(err));
            return err;
        }
        total_samples += VOICE_FEED_SAMPLES;

        // Progress log every ~1 second
        if (total_samples >= next_log) {
            unsigned elapsed_ms = total_samples * 1000 / VOICE_SAMPLE_RATE;
            ESP_LOGI(TAG, "progress=%u ms samples=%lu", elapsed_ms, (unsigned long)total_samples);
            next_log += VOICE_SAMPLE_RATE;
        }
    }

    unsigned duration_ms = total_samples * 1000 / VOICE_SAMPLE_RATE;
    ESP_LOGI(TAG, "duration_ms=%u total_samples=%lu", duration_ms, (unsigned long)total_samples);
    return ESP_OK;
}

void app_main(void)
{
    ESP_ERROR_CHECK(voice_audio_init());
    ESP_LOGI(TAG, "state=START target_ms=%d", RECORD_SECONDS * 1000);

    esp_err_t err = record_audio();

    if (err == ESP_OK) {
        ESP_LOGI(TAG, "state=DONE");
    } else {
        ESP_LOGE(TAG, "state=FAILED error=%s", esp_err_to_name(err));
    }
}
