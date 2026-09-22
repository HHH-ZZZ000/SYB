#include <stdio.h>
#include <stdlib.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_afe_sr_iface.h"
#include "esp_afe_sr_models.h"
#include "voice_common.h"
#include "esp_mn_iface.h"
#include "esp_mn_models.h"
#include "model_path.h"
#include "esp_process_sdkconfig.h"

static const char *TAG = "lesson08_multinet";
static const esp_afe_sr_iface_t *afe_handle;
static srmodel_list_t *models;

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

static void detect_task(void *arg)
{
    esp_afe_sr_data_t *afe_data = arg;
    char *name = esp_srmodel_filter(models, ESP_MN_PREFIX, ESP_MN_CHINESE);
    esp_mn_iface_t *multinet = esp_mn_handle_from_name(name);
    model_iface_data_t *model_data = multinet->create(name, 6000);
    esp_mn_commands_update_from_sdkconfig(multinet, model_data);
    multinet->print_active_speech_commands(model_data);
    bool listening = false;

    ESP_LOGI(TAG, "state=WAIT_WAKE word=Hi ESP");
    while (true) {
        afe_fetch_result_t *result = afe_handle->fetch(afe_data);
        if (!result || result->ret_value == ESP_FAIL) {
            ESP_LOGE(TAG, "fetch_error");
            break;
        }
        if (result->wakeup_state == WAKENET_DETECTED) {
            listening = true;
            multinet->clean(model_data);
            ESP_LOGI(TAG, "state=LISTEN_COMMAND");
        }
        if (!listening) {
            continue;
        }

        esp_mn_state_t state = multinet->detect(model_data, result->data);
        if (state == ESP_MN_STATE_DETECTED) {
            esp_mn_results_t *mn = multinet->get_results(model_data);
            if (mn && mn->num > 0) {
                ESP_LOGI(TAG, "state=COMMAND_DETECTED id=%d phrase=%s prob=%.3f",
                         mn->command_id[0], mn->string, mn->prob[0]);
            }
            listening = false;
            afe_handle->enable_wakenet(afe_data);
            ESP_LOGI(TAG, "state=WAIT_WAKE");
        } else if (state == ESP_MN_STATE_TIMEOUT) {
            ESP_LOGI(TAG, "state=COMMAND_TIMEOUT");
            listening = false;
            afe_handle->enable_wakenet(afe_data);
            ESP_LOGI(TAG, "state=WAIT_WAKE");
        }
    }
    multinet->destroy(model_data);
    vTaskDelete(NULL);
}

void app_main(void)
{
    ESP_ERROR_CHECK(voice_audio_init());
    models = esp_srmodel_init("model");
    afe_config_t *config = afe_config_init(voice_get_input_format(), models, AFE_TYPE_SR, AFE_MODE_LOW_COST);
    afe_handle = esp_afe_handle_from_config(config);
    esp_afe_sr_data_t *afe_data = afe_handle->create_from_config(config);
    afe_config_free(config);
    xTaskCreatePinnedToCore(feed_task, "afe_feed", 8192, afe_data, 5, NULL, 0);
    xTaskCreatePinnedToCore(detect_task, "command_detect", 12288, afe_data, 5, NULL, 1);
}
