#include <stdio.h>
#include <sys/stat.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "voice_common.h"

#define RECORD_SECONDS 10
#define RECORD_PATH "/sdcard/lesson05_record.wav"

static const char *TAG = "ext05_record";

static esp_err_t record_and_verify(void)
{
    FILE *file = fopen(RECORD_PATH, "wb+");
    if (!file) {
        ESP_LOGE(TAG, "storage_error=open path=%s", RECORD_PATH);
        return ESP_FAIL;
    }
    esp_err_t err = voice_wav_write_header(file, 0);
    if (err != ESP_OK) {
        fclose(file);
        return err;
    }

    int16_t samples[VOICE_FEED_SAMPLES];
    uint32_t data_size = 0;
    const uint32_t target_samples = VOICE_SAMPLE_RATE * RECORD_SECONDS;
    ESP_LOGI(TAG, "state=RECORDING target_ms=%d", RECORD_SECONDS * 1000);
    while (data_size / sizeof(int16_t) < target_samples) {
        esp_err_t err = voice_read_samples(samples, VOICE_FEED_SAMPLES);
        if (err != ESP_OK) {
            fclose(file);
            ESP_LOGE(TAG, "audio_error=%s", esp_err_to_name(err));
            return err;
        }
        if (fwrite(samples, sizeof(int16_t), VOICE_FEED_SAMPLES, file) != VOICE_FEED_SAMPLES) {
            fclose(file);
            ESP_LOGE(TAG, "storage_error=write");
            return ESP_FAIL;
        }
        data_size += VOICE_FEED_SAMPLES * sizeof(int16_t);
    }
    err = voice_wav_patch_header(file, data_size);
    fclose(file);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "storage_error=header");
        return err;
    }

    struct stat st;
    if (stat(RECORD_PATH, &st) != 0) {
        ESP_LOGE(TAG, "verify_error=stat");
        return ESP_FAIL;
    }
    unsigned duration_ms = data_size * 1000 / (VOICE_SAMPLE_RATE * sizeof(int16_t));
    ESP_LOGI(TAG, "state=DONE path=%s duration_ms=%u file_bytes=%ld", RECORD_PATH, duration_ms, (long)st.st_size);
    ESP_LOGI(TAG, "verify=playback_required_on_host_or_audio_player");
    return ESP_OK;
}

void app_main(void)
{
    ESP_ERROR_CHECK(voice_audio_init());
    ESP_ERROR_CHECK(voice_sdcard_init());

    // Verify SD card mount point is accessible
    struct stat st;
    if (stat("/sdcard", &st) != 0 || !S_ISDIR(st.st_mode)) {
        ESP_LOGE(TAG, "SD card not found at /sdcard — check that a FAT32-formatted card is inserted");
        ESP_LOGE(TAG, "hint: power cycle the board after inserting the SD card");
        return;
    }
    ESP_LOGI(TAG, "SD card detected");

    voice_button_init();
    ESP_LOGI(TAG, "ready: press GPIO%d", VOICE_RECORD_BUTTON_GPIO);
    while (true) {
        if (voice_button_pressed()) {
            ESP_LOGI(TAG, "state=START");
            ESP_LOGI(TAG, "result=%s", record_and_verify() == ESP_OK ? "ok" : "failed");
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}
