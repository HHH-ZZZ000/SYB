#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"

#include "button_capture.h"
#include "config.local.h"
#include "led_feedback.h"

#define BUTTON_CHANNEL ADC_CHANNEL_0  /* GPIO1, ESP32-S3-EYE MENU resistor ladder. */
#define BUTTON_ATTEN ADC_ATTEN_DB_12
#define MENU_MIN_MV 2310
#define MENU_MAX_MV 2510
#define BUTTON_POLL_MS 20
#define BUTTON_DEBOUNCE_READS 3
#define TASK_OBSERVE_MS 120000

static const char *TAG = "BUTTON_CAPTURE";
static EventGroupHandle_t connection_bits;
static EventBits_t wifi_bit;

typedef struct {
    char body[1536];
    size_t length;
    bool overflow;
} button_response_t;

static esp_err_t response_event(esp_http_client_event_t *event)
{
    button_response_t *response = event->user_data;
    if (event->event_id == HTTP_EVENT_ON_DATA && response && event->data_len > 0) {
        size_t available = sizeof(response->body) - response->length - 1;
        size_t count = (size_t)event->data_len;
        if (count > available) {
            count = available;
            response->overflow = true;
        }
        memcpy(response->body + response->length, event->data, count);
        response->length += count;
        response->body[response->length] = '\0';
    }
    return ESP_OK;
}

static esp_err_t button_http(const char *path, const char *body, button_response_t *response, int *status)
{
    char url[256];
    int length = snprintf(url, sizeof(url), "%s%s", IMU_SERVER_BASE_URL, path);
    if (length < 0 || length >= sizeof(url)) return ESP_ERR_INVALID_SIZE;
    const esp_http_client_config_t config = {
        .url = url,
        .method = body ? HTTP_METHOD_POST : HTTP_METHOD_GET,
        .timeout_ms = 2000,
        .disable_auto_redirect = true,
        .event_handler = response_event,
        .user_data = response,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) return ESP_ERR_NO_MEM;
    esp_err_t err = ESP_OK;
    if (body) {
        err = esp_http_client_set_header(client, "Content-Type", "application/json");
        if (err == ESP_OK) err = esp_http_client_set_post_field(client, body, strlen(body));
    }
    if (err == ESP_OK) err = esp_http_client_perform(client);
    *status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    if (err == ESP_OK && response->overflow) err = ESP_ERR_INVALID_SIZE;
    return err;
}

static bool valid_request_id(const char *value)
{
    if (!value || strlen(value) != 36) return false;
    for (size_t i = 0; i < 36; ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (value[i] != '-') return false;
        } else if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) {
            return false;
        }
    }
    return value[14] == '4' && strchr("89ab", value[19]) != NULL;
}

static bool create_capture_task(char request_id[37])
{
    button_response_t response = {0};
    int status = 0;
    /* Never automatically retry POST: its response may be lost after creation. */
    esp_err_t err = button_http("/api/task/create",
        "{\"device\":\"ESP32_S3_EYE\",\"action\":\"capture_once\"}", &response, &status);
    cJSON *reply = err == ESP_OK && status == 201 ? cJSON_Parse(response.body) : NULL;
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(reply, "request_id");
    const cJSON *task_status = cJSON_GetObjectItemCaseSensitive(reply, "status");
    bool confirmed = cJSON_IsString(id) && valid_request_id(id->valuestring) &&
                     cJSON_IsString(task_status) && strcmp(task_status->valuestring, "PENDING") == 0;
    if (confirmed) memcpy(request_id, id->valuestring, 37);
    cJSON_Delete(reply);
    if (!confirmed) ESP_LOGW(TAG, "BUTTON_CREATE_UNCONFIRMED HTTP=%d error=%s", status, esp_err_to_name(err));
    return confirmed;
}

static void observe_task(const char *request_id)
{
    char path[96];
    snprintf(path, sizeof(path), "/api/task/%s", request_id);
    int64_t deadline = esp_timer_get_time() + TASK_OBSERVE_MS * 1000LL;
    while (esp_timer_get_time() < deadline) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        if (!(xEventGroupGetBits(connection_bits) & wifi_bit)) continue;
        button_response_t response = {0};
        int http_status = 0;
        esp_err_t err = button_http(path, NULL, &response, &http_status);
        if (err != ESP_OK || http_status != 200) continue;
        cJSON *reply = cJSON_Parse(response.body);
        const cJSON *id = cJSON_GetObjectItemCaseSensitive(reply, "request_id");
        const cJSON *status = cJSON_GetObjectItemCaseSensitive(reply, "status");
        bool matching = cJSON_IsString(id) && strcmp(id->valuestring, request_id) == 0 && cJSON_IsString(status);
        if (matching && strcmp(status->valuestring, "SUCCESS") == 0) {
            const cJSON *sample_id = cJSON_GetObjectItemCaseSensitive(reply, "result_sample_id");
            const cJSON *result = cJSON_GetObjectItemCaseSensitive(reply, "result");
            const cJSON *result_id = cJSON_GetObjectItemCaseSensitive(result, "id");
            if (cJSON_IsNumber(sample_id) && sample_id->valuedouble > 0 &&
                cJSON_IsNumber(result_id) && result_id->valuedouble == sample_id->valuedouble) {
                ESP_LOGI(TAG, "BUTTON_TASK_SUCCESS request_id=%s sample_id=%.0f", request_id, sample_id->valuedouble);
                led_feedback_show(LED_FEEDBACK_SUCCESS);
            } else {
                ESP_LOGW(TAG, "BUTTON_TASK_RESULT_MISSING request_id=%s", request_id);
                led_feedback_show(LED_FEEDBACK_ERROR);
            }
            cJSON_Delete(reply);
            return;
        }
        if (matching && (strcmp(status->valuestring, "FAILED") == 0 || strcmp(status->valuestring, "TIMEOUT") == 0)) {
            ESP_LOGW(TAG, "BUTTON_TASK_%s request_id=%s", status->valuestring, request_id);
            led_feedback_show(LED_FEEDBACK_ERROR);
            cJSON_Delete(reply);
            return;
        }
        cJSON_Delete(reply);
    }
    /* A local observation deadline is not evidence of a server TIMEOUT. */
    ESP_LOGW(TAG, "BUTTON_TASK_UNCONFIRMED request_id=%s", request_id);
    led_feedback_show(LED_FEEDBACK_ERROR);
}

static void handle_press(void)
{
    ESP_LOGI(TAG, "button pressed");
    led_feedback_show(LED_FEEDBACK_PRESSED);
    vTaskDelay(pdMS_TO_TICKS(450));  /* Make local acknowledgement visible even with no network. */
    if (!(xEventGroupGetBits(connection_bits) & wifi_bit)) {
        ESP_LOGW(TAG, "BUTTON_OFFLINE; no server receipt claimed");
        led_feedback_show(LED_FEEDBACK_ERROR);
        return;
    }
    char request_id[37] = {0};
    if (!create_capture_task(request_id)) {
        led_feedback_show(LED_FEEDBACK_ERROR);
        return;
    }
    ESP_LOGI(TAG, "BUTTON_TASK_CREATED request_id=%s", request_id);
    led_feedback_show(LED_FEEDBACK_WAITING);
    observe_task(request_id);
}

static void button_task(void *unused)
{
    adc_oneshot_unit_handle_t adc = NULL;
    adc_cali_handle_t calibration = NULL;
    const adc_oneshot_unit_init_cfg_t unit_config = {.unit_id = ADC_UNIT_1};
    const adc_oneshot_chan_cfg_t channel_config = {.bitwidth = ADC_BITWIDTH_DEFAULT, .atten = BUTTON_ATTEN};
    esp_err_t err = adc_oneshot_new_unit(&unit_config, &adc);
    if (err == ESP_OK) err = adc_oneshot_config_channel(adc, BUTTON_CHANNEL, &channel_config);
#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
    const adc_cali_curve_fitting_config_t cali_config = {
        .unit_id = ADC_UNIT_1, .chan = BUTTON_CHANNEL, .atten = BUTTON_ATTEN,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    if (err == ESP_OK) err = adc_cali_create_scheme_curve_fitting(&cali_config, &calibration);
#else
    if (err == ESP_OK) err = ESP_ERR_NOT_SUPPORTED;
#endif
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "MENU ADC unavailable: %s", esp_err_to_name(err));
        if (adc) adc_oneshot_del_unit(adc);
        vTaskDelete(NULL);
        return;
    }
    ESP_LOGI(TAG, "MENU button ready GPIO1 ADC1_CH0 range=%d..%d mV", MENU_MIN_MV, MENU_MAX_MV);
    bool armed = true;
    unsigned pressed_reads = 0, released_reads = 0;
    int64_t last_read_error = 0;
    for (;;) {
        int raw = 0, millivolts = 0;
        err = adc_oneshot_read(adc, BUTTON_CHANNEL, &raw);
        if (err == ESP_OK) err = adc_cali_raw_to_voltage(calibration, raw, &millivolts);
        if (err == ESP_OK) {
            bool pressed = millivolts >= MENU_MIN_MV && millivolts <= MENU_MAX_MV;
            if (pressed) {
                released_reads = 0;
                if (armed && ++pressed_reads >= BUTTON_DEBOUNCE_READS) {
                    armed = false;
                    pressed_reads = 0;
                    handle_press();
                }
            } else {
                pressed_reads = 0;
                if (!armed && ++released_reads >= BUTTON_DEBOUNCE_READS) armed = true;
            }
        } else if (esp_timer_get_time() - last_read_error >= 5000000) {
            ESP_LOGW(TAG, "MENU ADC read failed: %s", esp_err_to_name(err));
            last_read_error = esp_timer_get_time();
        }
        vTaskDelay(pdMS_TO_TICKS(BUTTON_POLL_MS));
    }
}

esp_err_t button_capture_start(EventGroupHandle_t status_bits, EventBits_t wifi_ready_bit)
{
    if (!status_bits || !wifi_ready_bit) return ESP_ERR_INVALID_ARG;
    connection_bits = status_bits;
    wifi_bit = wifi_ready_bit;
    return xTaskCreate(button_task, "button_capture", 8192, NULL, 3, NULL) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
