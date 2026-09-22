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

static const char *TAG = "ext08_command";
static const esp_afe_sr_iface_t *afe_handle;
static srmodel_list_t *models;

static const char *action_for_command(int id)
{
    switch (id) {
        case 1: return "LOOK";
        case 2: return "CAPTURE";
        case 3: return "REPEAT";
        default: return "UNKNOWN";
    }
}

static void app_action(int id, const char *phrase)
{
    ESP_LOGI(TAG, "callback action=%s command_id=%d phrase=%s result=%s",
             action_for_command(id), id, phrase, id <= 3 ? "accepted" : "ignored");
}

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
    char *name = esp_srmodel_filter(models, ESP_MN_PREFIX, ESP_MN_CHINESE);
    esp_mn_iface_t *multinet = esp_mn_handle_from_name(name);
    model_iface_data_t *model_data = multinet->create(name, 6000);
    esp_mn_commands_update_from_sdkconfig(multinet, model_data);
    multinet->print_active_speech_commands(model_data);
    bool listening = false;
    int wake_count = 0;
    int command_count = 0;
    int timeout_count = 0;

    while (true) {
        afe_fetch_result_t *result = afe_handle->fetch(data);
        if (!result || result->ret_value == ESP_FAIL) {
            ESP_LOGE(TAG, "fetch_error");
            break;
        }
        if (result->wakeup_state == WAKENET_DETECTED) {
            wake_count++;
            listening = true;
            multinet->clean(model_data);
            ESP_LOGI(TAG, "wake count=%d", wake_count);
        }
        if (!listening) {
            continue;
        }
        esp_mn_state_t state = multinet->detect(model_data, result->data);
        if (state == ESP_MN_STATE_DETECTED) {
            esp_mn_results_t *mn = multinet->get_results(model_data);
            if (mn && mn->num > 0) {
                command_count++;
                app_action(mn->command_id[0], mn->string);
            }
            listening = false;
            afe_handle->enable_wakenet(data);
        } else if (state == ESP_MN_STATE_TIMEOUT) {
            timeout_count++;
            ESP_LOGI(TAG, "command_timeout count=%d", timeout_count);
            listening = false;
            afe_handle->enable_wakenet(data);
        }
        if ((wake_count % 10 == 0) && command_count + timeout_count == wake_count) {
            ESP_LOGI(TAG, "summary wake=%d command=%d timeout=%d", wake_count, command_count, timeout_count);
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
    esp_afe_sr_data_t *data = afe_handle->create_from_config(config);
    afe_config_free(config);
    ESP_LOGI(TAG, "ready: Hi ESP then say a configured command");
    xTaskCreatePinnedToCore(feed_task, "afe_feed", 8192, data, 5, NULL, 0);
    xTaskCreatePinnedToCore(detect_task, "command_action", 12288, data, 5, NULL, 1);
}
