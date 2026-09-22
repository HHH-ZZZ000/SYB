#include <stdio.h>
#include <stdlib.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_afe_sr_iface.h"
#include "esp_afe_sr_models.h"
#include "voice_common.h"
#include "model_path.h"

static const char *TAG = "ext07_wakenet";
static const esp_afe_sr_iface_t *afe_handle;

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
    TickType_t listening_until = 0;
    while (true) {
        afe_fetch_result_t *result = afe_handle->fetch(data);
        if (!result || result->ret_value == ESP_FAIL) {
            ESP_LOGE(TAG, "fetch_error");
            break;
        }
        if (result->wakeup_state == WAKENET_DETECTED) {
            ESP_LOGI(TAG, "state=WAKE_DETECTED word_index=%d", result->wake_word_index);
            listening_until = xTaskGetTickCount() + pdMS_TO_TICKS(3000);
        }
        if (listening_until != 0 && xTaskGetTickCount() >= listening_until) {
            ESP_LOGI(TAG, "state=WAIT_WAKE");
            listening_until = 0;
        }
    }
    vTaskDelete(NULL);
}

void app_main(void)
{
    ESP_ERROR_CHECK(voice_audio_init());
    srmodel_list_t *models = esp_srmodel_init("model");
    afe_config_t *config = afe_config_init(voice_get_input_format(), models, AFE_TYPE_SR, AFE_MODE_LOW_COST);
    afe_handle = esp_afe_handle_from_config(config);
    esp_afe_sr_data_t *data = afe_handle->create_from_config(config);
    afe_config_free(config);
    ESP_LOGI(TAG, "state=WAIT_WAKE word=Hi ESP");
    xTaskCreatePinnedToCore(feed_task, "afe_feed", 8192, data, 5, NULL, 0);
    xTaskCreatePinnedToCore(detect_task, "wake_detect", 8192, data, 5, NULL, 1);
}
