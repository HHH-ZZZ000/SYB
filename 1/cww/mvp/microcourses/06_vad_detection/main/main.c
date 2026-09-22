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

static const char *TAG = "lesson06_vad";
static const esp_afe_sr_iface_t *afe_handle;
static srmodel_list_t *models;

// Task 1: 从麦克风读取 PCM 音频，不断喂给 AFE 处理
static void feed_task(void *arg)
{
    esp_afe_sr_data_t *afe_data = arg;
    int chunk = afe_handle->get_feed_chunksize(afe_data);
    int channels = afe_handle->get_feed_channel_num(afe_data);
    int16_t *buffer = malloc(chunk * sizeof(int16_t) * channels);
    assert(buffer);
    while (true) {
        ESP_ERROR_CHECK(voice_read_samples(buffer, (size_t)chunk * channels));
        afe_handle->feed(afe_data, buffer);
    }
}

// Task 2: 从 AFE 取 VAD 结果，只在状态变化时输出 SPEECH / NOISE
static void detect_task(void *arg)
{
    esp_afe_sr_data_t *afe_data = arg;
    int previous = -1;
    ESP_LOGI(TAG, "ready: speak into the microphone");
    while (true) {
        afe_fetch_result_t *result = afe_handle->fetch(afe_data);
        if (!result || result->ret_value == ESP_FAIL) {
            ESP_LOGE(TAG, "fetch_error");
            break;
        }
        int state = result->vad_state == VAD_SPEECH;
        if (state != previous) {
            ESP_LOGI(TAG, "state=%s", state ? "SPEECH" : "NOISE");
            previous = state;
        }
    }
    vTaskDelete(NULL);
}

void app_main(void)
{
    // 初始化板载麦克风：16 kHz, 单声道, 16-bit
    ESP_ERROR_CHECK(voice_audio_init());

    // 从 spiffs 分区加载 SR 模型（VAD 模型在 srmodel 中）
    models = esp_srmodel_init("model");

    // 配置 AFE（音频前端）：SR 模式，低功耗，含 VAD
    afe_config_t *config = afe_config_init(voice_get_input_format(), models, AFE_TYPE_SR, AFE_MODE_LOW_COST);
    config->vad_min_speech_ms = 128;   // 持续说话 >128ms 才判为 SPEECH，防突发噪声误触发
    config->vad_min_noise_ms = 1000;   // 持续安静 >1s 才切回 NOISE，防止说话间隙频繁切换
    config->vad_mode = VAD_MODE_1;     // 中等灵敏度

    afe_handle = esp_afe_handle_from_config(config);
    esp_afe_sr_data_t *afe_data = afe_handle->create_from_config(config);
    afe_config_free(config);

    // feed_task 在 CPU0 采集音频，detect_task 在 CPU1 做 VAD 检测
    xTaskCreatePinnedToCore(feed_task, "afe_feed", 8192, afe_data, 5, NULL, 0);
    xTaskCreatePinnedToCore(detect_task, "vad_detect", 8192, afe_data, 5, NULL, 1);
}
