#include <errno.h>
#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "cJSON.h"
#include "driver/i2c_master.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "config.local.h"
#include "qma6100p.h"
#include "camera_monitor.h"

#define WIFI_READY BIT0
#define SENSOR_READY BIT1
#define UPLOAD_PAUSED BIT2
#define UPLOAD_INTERVAL_MS 100
#define DEVICE_NAME "ESP32_S3_EYE"
#define SENSOR_NAME "QMA6100P"

static const char *TAG = "IMU";
static EventGroupHandle_t status_bits;
static QueueHandle_t samples;
static i2c_master_bus_handle_t bus;
static SemaphoreHandle_t i2c_mutex;
/* Used only by the upload task; reuse allocation and HTTP connection when supported. */
static esp_http_client_handle_t http_client;

typedef struct {
    qma6100p_sample_t acceleration;
    int64_t monotonic_us;
    time_t sampled_at;
    unsigned sequence;
} measurement_t;

typedef struct {
    char body[256];
    size_t length;
    bool overflow;
} http_response_t;

static esp_err_t http_event(esp_http_client_event_t *event)
{
    http_response_t *response = event->user_data;
    if (event->event_id == HTTP_EVENT_ON_DATA && response != NULL && event->data_len > 0) {
        size_t available = sizeof(response->body) - response->length - 1;
        size_t length = (size_t)event->data_len;
        if (length > available) {
            length = available;
            response->overflow = true;
        }
        memcpy(response->body + response->length, event->data, length);
        response->length += length;
        response->body[response->length] = '\0';
    }
    return ESP_OK;
}

static esp_err_t http_request(const char *path, const char *payload, http_response_t *response, int *status)
{
    char url[192];
    int length = snprintf(url, sizeof(url), "%s%s", IMU_SERVER_BASE_URL, path);
    if (length < 0 || length >= sizeof(url)) return ESP_ERR_INVALID_SIZE;
    const esp_http_client_config_t config = {
        .url = url, .timeout_ms = 1500, .disable_auto_redirect = true,
        .event_handler = http_event, .user_data = response,
    };
    if (http_client == NULL) http_client = esp_http_client_init(&config);
    if (http_client == NULL) return ESP_ERR_NO_MEM;
    esp_http_client_handle_t client = http_client;
    esp_err_t err = esp_http_client_set_url(client, url);
    if (err == ESP_OK) err = esp_http_client_set_user_data(client, response);
    if (err == ESP_OK) err = esp_http_client_set_method(client, payload ? HTTP_METHOD_POST : HTTP_METHOD_GET);
    if (err == ESP_OK) {
        err = esp_http_client_set_post_field(client, payload, payload ? strlen(payload) : 0);
        /* IDF 5.4 clears the body before removing Content-Type. On the first
         * GET that header does not exist; ESP_ERR_NOT_FOUND is harmless here. */
        if (payload == NULL && err == ESP_ERR_NOT_FOUND) err = ESP_OK;
    }
    if (payload != NULL) {
        if (err == ESP_OK) err = esp_http_client_set_header(client, "Content-Type", "application/json");
    }
    if (err == ESP_OK) err = esp_http_client_perform(client);
    *status = esp_http_client_get_status_code(client);
    if (response->overflow && err == ESP_OK) err = ESP_ERR_INVALID_SIZE;
    /* A failed request must not leave a stale socket or response buffer behind. */
    if (err != ESP_OK) {
        esp_http_client_cleanup(client);
        http_client = NULL;
    } else {
        esp_http_client_set_user_data(client, NULL);
    }
    return err;
}

static bool sync_clock(void)
{
    http_response_t response = {0};
    int status = 0;
    esp_err_t err = http_request("/api/time", NULL, &response, &status);
    if (err == ESP_OK && status == 200 && response.length == 10) {
        char *end;
        errno = 0;
        int64_t epoch = strtoll(response.body, &end, 10);
        if (!errno && *end == '\0' && epoch >= 1700000000LL && epoch < 4102444800LL) {
            struct timeval value = {.tv_sec = epoch, .tv_usec = 0};
            if (settimeofday(&value, NULL) == 0) {
                ESP_LOGI(TAG, "CLOCK_SYNC_OK source=Flask/api/time timezone=UTC+08:00");
                return true;
            }
        }
    }
    ESP_LOGW(TAG, "CLOCK_SYNC_FAILED HTTP=%d error=%s; retry in 10s", status, esp_err_to_name(err));
    return false;
}

static esp_err_t connect_sensor(i2c_master_dev_handle_t *device)
{
    const uint8_t addresses[] = {0x12, 0x13};
    for (unsigned i = 0; i < sizeof(addresses); ++i) {
        if (i2c_master_probe(bus, addresses[i], 100) != ESP_OK) continue;
        i2c_device_config_t config = {
            .dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = addresses[i], .scl_speed_hz = 100000,
        };
        esp_err_t err = i2c_master_bus_add_device(bus, &config, device);
        if (err != ESP_OK) return err;
        uint8_t id = 0;
        err = qma6100p_read_id(*device, &id);
        if (err == ESP_OK && qma6100p_id_matches(id)) {
            ESP_LOGI(TAG, "IDENTITY_OK sensor=QMA6100P address=0x%02X id=0x%02X", addresses[i], id);
            err = qma6100p_init(*device);
            if (err == ESP_OK) return ESP_OK;
        } else {
            ESP_LOGE(TAG, "Unrecognized sensor at 0x%02X id=0x%02X; no configuration written", addresses[i], id);
        }
        i2c_master_bus_rm_device(*device);
        *device = NULL;
    }
    return ESP_ERR_NOT_FOUND;
}

static void sensor_task(void *unused)
{
    i2c_master_dev_handle_t sensor = NULL;
    unsigned sequence = 0, stale = 0;
    while (true) {
        if (sensor == NULL) {
            xSemaphoreTake(i2c_mutex, portMAX_DELAY);
            esp_err_t connected = connect_sensor(&sensor);
            xSemaphoreGive(i2c_mutex);
            if (connected != ESP_OK) {
                ESP_LOGE(TAG, "SENSOR_OFFLINE; no upload; retry in 5s");
                vTaskDelay(pdMS_TO_TICKS(5000));
                continue;
            }
            stale = 0;
        }
        measurement_t sample = {0};
        xSemaphoreTake(i2c_mutex, portMAX_DELAY);
        esp_err_t err = qma6100p_read_sample(sensor, &sample.acceleration);
        xSemaphoreGive(i2c_mutex);
        bool fresh = err == ESP_OK && sample.acceleration.new_data[0] &&
                     sample.acceleration.new_data[1] && sample.acceleration.new_data[2];
        if (!fresh) {
            xEventGroupClearBits(status_bits, SENSOR_READY);
            xQueueReset(samples);
            if (err != ESP_OK || ++stale >= 20) {
                ESP_LOGE(TAG, "SENSOR_READ_FAILED; samples cleared; reinitializing");
                xSemaphoreTake(i2c_mutex, portMAX_DELAY);
                i2c_master_bus_rm_device(sensor);
                xSemaphoreGive(i2c_mutex);
                sensor = NULL;
                vTaskDelay(pdMS_TO_TICKS(1000));
            }
        } else {
            stale = 0;
            sample.sequence = ++sequence;
            sample.monotonic_us = esp_timer_get_time();
            sample.sampled_at = time(NULL);
            xQueueOverwrite(samples, &sample);
            xEventGroupSetBits(status_bits, SENSOR_READY);
            if (sequence % 5 == 1) {
                const float *g = sample.acceleration.g;
                ESP_LOGI(TAG, "ACC seq=%u X=%+.5f g Y=%+.5f g Z=%+.5f g MAG=%.5f g",
                         sequence, g[0], g[1], g[2], sqrtf(g[0]*g[0] + g[1]*g[1] + g[2]*g[2]));
            }
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(status_bits, WIFI_READY);
        const wifi_event_sta_disconnected_t *event = data;
        ESP_LOGW(TAG, "WIFI_DISCONNECTED reason=%u; automatic retry within 5s", event->reason);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *event = data;
        xEventGroupSetBits(status_bits, WIFI_READY);
        ESP_LOGI(TAG, "WIFI_CONNECTED ip=" IPSTR, IP2STR(&event->ip_info.ip));
    } else if (base == IP_EVENT && id == IP_EVENT_STA_LOST_IP) {
        xEventGroupClearBits(status_bits, WIFI_READY);
    }
}

static void uploader_task(void *unused)
{
    int64_t last_connect = -5000000, last_sync_attempt = -10000000, last_sync_success = -3600000000LL;
    int64_t last_upload = 0;
    unsigned last_sequence = 0;
    while (true) {
        int64_t now = esp_timer_get_time();
        EventBits_t bits = xEventGroupGetBits(status_bits);
        if (!(bits & WIFI_READY)) {
            if (now - last_connect >= 5000000) {
                last_connect = now;
                ESP_LOGI(TAG, "WIFI_CONNECTING (2.4 GHz)");
                esp_err_t err = esp_wifi_connect();
                if (err != ESP_OK && err != ESP_ERR_WIFI_CONN) ESP_LOGW(TAG, "Wi-Fi connect: %s", esp_err_to_name(err));
            }
        } else {
            if ((time(NULL) < 1700000000LL || now - last_sync_success >= 3600000000LL) &&
                    now - last_sync_attempt >= 10000000) {
                last_sync_attempt = now;
                if (sync_clock()) last_sync_success = esp_timer_get_time();
            }
        }
        now = esp_timer_get_time();
        if ((bits & WIFI_READY) && !(bits & UPLOAD_PAUSED) && (bits & SENSOR_READY) && now - last_upload >= UPLOAD_INTERVAL_MS * 1000) {
            measurement_t sample;
            if (xQueuePeek(samples, &sample, 0) == pdTRUE && sample.sequence != last_sequence &&
                    now - sample.monotonic_us < 1000000 && sample.sampled_at >= 1700000000LL) {
                last_sequence = sample.sequence;
                last_upload = now;
                struct tm wall_time;
                localtime_r(&sample.sampled_at, &wall_time);
                char timestamp[20], payload[256];
                strftime(timestamp, sizeof(timestamp), "%Y-%m-%d %H:%M:%S", &wall_time);
                const float *g = sample.acceleration.g;
                int length = snprintf(payload, sizeof(payload),
                    "{\"device\":\"" DEVICE_NAME "\",\"sensor\":\"" SENSOR_NAME "\","
                    "\"acc_x\":%.5f,\"acc_y\":%.5f,\"acc_z\":%.5f,\"timestamp\":\"%s\"}",
                    g[0], g[1], g[2], timestamp);
                if (length > 0 && length < sizeof(payload) && isfinite(g[0]) && isfinite(g[1]) && isfinite(g[2])) {
                    http_response_t response = {0};
                    int status = 0;
                    esp_err_t err = http_request("/api/upload", payload, &response, &status);
                    cJSON *reply = err == ESP_OK ? cJSON_Parse(response.body) : NULL;
                    cJSON *row_id = cJSON_GetObjectItemCaseSensitive(reply, "id");
                    if (status == 201 && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(reply, "ok")) && cJSON_IsNumber(row_id)) {
                        ESP_LOGI(TAG, "HTTP_OK status=201 id=%.0f seq=%u payload=%s", row_id->valuedouble, sample.sequence, payload);
                    } else {
                        ESP_LOGW(TAG, "HTTP_FAILED status=%d error=%s; next cycle uses a new real sample", status, esp_err_to_name(err));
                    }
                    cJSON_Delete(reply);
                }
            }
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

static void console_task(void *unused)
{
    char command[32];
    ESP_LOGI(TAG, "USB commands: pause / resume / wifi-reconnect / camera-off / camera-on");
    while (true) {
        if (fgets(command, sizeof(command), stdin) != NULL) {
            command[strcspn(command, "\r\n")] = '\0';
            if (strcmp(command, "pause") == 0) {
                xEventGroupSetBits(status_bits, UPLOAD_PAUSED);
                ESP_LOGI(TAG, "UPLOAD_PAUSED; any in-flight request may finish; sensor still reads real data");
            } else if (strcmp(command, "resume") == 0) {
                xEventGroupClearBits(status_bits, UPLOAD_PAUSED);
                ESP_LOGI(TAG, "UPLOAD_RESUMED; only fresh samples will be sent");
            } else if (strcmp(command, "wifi-reconnect") == 0) {
                esp_wifi_disconnect();
                ESP_LOGI(TAG, "WIFI_DISCONNECT_REQUESTED; automatic reconnection remains enabled");
            } else if (strcmp(command, "camera-off") == 0) {
                camera_monitor_set_enabled(false);
            } else if (strcmp(command, "camera-on") == 0) {
                camera_monitor_set_enabled(true);
            } else if (command[0]) {
                ESP_LOGW(TAG, "Unknown command; use pause / resume / wifi-reconnect / camera-off / camera-on");
            }
        } else {
            clearerr(stdin);
            vTaskDelay(pdMS_TO_TICKS(50));
        }
    }
}

void app_main(void)
{
    vTaskDelay(pdMS_TO_TICKS(3000));
    if (strlen(IMU_WIFI_SSID) == 0 || strlen(IMU_WIFI_SSID) > 32 || strlen(IMU_WIFI_PASSWORD) > 64) {
        ESP_LOGE(TAG, "Invalid local Wi-Fi configuration; rerun configure.py");
        return;
    }
    ESP_LOGI(TAG, "START device=" DEVICE_NAME " sensor=" SENSOR_NAME " units=g server=" IMU_SERVER_BASE_URL);
    setenv("TZ", "CST-8", 1);
    tzset();
    status_bits = xEventGroupCreate();
    samples = xQueueCreate(1, sizeof(measurement_t));
    i2c_mutex = xSemaphoreCreateMutex();
    if (!status_bits || !samples || !i2c_mutex) { ESP_LOGE(TAG, "Not enough memory to initialize acquisition"); return; }
    const i2c_master_bus_config_t i2c_config = {
        .i2c_port = I2C_NUM_0, .sda_io_num = GPIO_NUM_4, .scl_io_num = GPIO_NUM_5,
        .clk_source = I2C_CLK_SRC_DEFAULT, .glitch_ignore_cnt = 7, .flags.enable_internal_pullup = true,
    };
    ESP_ERROR_CHECK(i2c_new_master_bus(&i2c_config, &bus));
    ESP_ERROR_CHECK(nvs_flash_init());  /* Never erase existing NVS automatically. */
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    wifi_config_t wifi = {0};
    memcpy(wifi.sta.ssid, IMU_WIFI_SSID, strlen(IMU_WIFI_SSID));
    memcpy(wifi.sta.password, IMU_WIFI_PASSWORD, strlen(IMU_WIFI_PASSWORD));
    wifi.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    wifi.sta.threshold.authmode = strlen(IMU_WIFI_PASSWORD) ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    wifi.sta.pmf_cfg.capable = true;
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    if (xTaskCreate(sensor_task, "qma_sensor", 4096, NULL, 5, NULL) != pdPASS ||
        xTaskCreate(uploader_task, "imu_upload", 8192, NULL, 4, NULL) != pdPASS ||
        xTaskCreate(console_task, "imu_console", 3072, NULL, 3, NULL) != pdPASS) {
        ESP_LOGE(TAG, "Task creation failed; restart required");
    }
    esp_err_t camera_err = camera_monitor_start(i2c_mutex);
    if (camera_err != ESP_OK) ESP_LOGW(TAG, "Camera unavailable: %s; real QMA acquisition continues", esp_err_to_name(camera_err));
}
