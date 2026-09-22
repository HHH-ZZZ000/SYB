#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "esp_log.h"
#include "voice_common.h"
#include "esp_wn_iface.h"
#include "esp_wn_models.h"
#include "model_path.h"

#define WAV_HEADER_SIZE 44

static const char *TAG = "lesson07_wakenet";

static void process_wav_file(const char *path, esp_wn_iface_t *wn_iface,
                             model_iface_data_t *wn_data, const char *word_name)
{
    FILE *file = fopen(path, "rb");
    if (!file) {
        ESP_LOGE(TAG, "cannot open %s", path);
        return;
    }

    /* 跳过 WAV 文件头 (44 bytes) */
    fseek(file, WAV_HEADER_SIZE, SEEK_SET);

    int samples_per_chunk = wn_iface->get_samp_chunksize(wn_data);
    int16_t *buffer = malloc(samples_per_chunk * sizeof(int16_t));
    if (!buffer) {
        ESP_LOGE(TAG, "malloc failed");
        fclose(file);
        return;
    }

    ESP_LOGI(TAG, "processing %s (%s)", path, word_name);
    int chunks = 0;
    while (fread(buffer, sizeof(int16_t), samples_per_chunk, file) == (size_t)samples_per_chunk) {
        chunks++;
        if (wn_iface->detect(wn_data, buffer) == WAKENET_DETECTED) {
            ESP_LOGI(TAG, "state=DETECTED word=%s chunk=%d", word_name, chunks);
        }
    }
    ESP_LOGI(TAG, "state=END word=%s chunks=%d", word_name, chunks);

    fclose(file);
    free(buffer);
}

void app_main(void)
{
    ESP_ERROR_CHECK(voice_sdcard_init());
    srmodel_list_t *models = esp_srmodel_init("model");

    /* 查找两个唤醒词模型 */
    char *wn_hiesp   = esp_srmodel_filter(models, ESP_WN_PREFIX, "hiesp");
    char *wn_hilexin = esp_srmodel_filter(models, ESP_WN_PREFIX, "hilexin");
    if (!wn_hiesp || !wn_hilexin) {
        ESP_LOGE(TAG, "WakeNet model not found: hiesp=%s hilexin=%s",
                 wn_hiesp ? "ok" : "NULL", wn_hilexin ? "ok" : "NULL");
        return;
    }

    /* 创建两个唤醒词检测实例 */
    esp_wn_iface_t *iface_hiesp   = esp_wn_handle_from_name(wn_hiesp);
    esp_wn_iface_t *iface_hilexin = esp_wn_handle_from_name(wn_hilexin);
    model_iface_data_t *data_hiesp   = iface_hiesp->create(wn_hiesp, DET_MODE_95);
    model_iface_data_t *data_hilexin = iface_hilexin->create(wn_hilexin, DET_MODE_95);

    process_wav_file("/sdcard/hiesp.wav",   iface_hiesp,   data_hiesp,   "Hi ESP");
    process_wav_file("/sdcard/hilexin.wav", iface_hilexin, data_hilexin, "Hi 乐鑫");

    iface_hiesp->destroy(data_hiesp);
    iface_hilexin->destroy(data_hilexin);
}
