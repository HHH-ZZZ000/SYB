#include "camera_monitor.h"

#include <errno.h>
#include <inttypes.h>
#include <stdatomic.h>
#include <stdio.h>

#include "esp_camera.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "esp_timer.h"
#include "freertos/task.h"
#include "lwip/sockets.h"

#define RETRY_US 10000000LL
#define FRAME_INTERVAL_US 40000LL  /* Limit successful delivery to at most 25 FPS. */
#define PART_BOUNDARY "qma_eye_real_camera"

static const char *TAG = "CAMERA_MONITOR";
static SemaphoreHandle_t i2c_mutex;
static SemaphoreHandle_t camera_mutex;
static httpd_handle_t http_server;
static atomic_bool enabled = true;
static atomic_bool ready = false;
static atomic_bool frame_failed = false;
/* The HTTP server executes one handler at a time. This deadline belongs only
 * to that handler, and bounds a whole frame even if a slow peer makes small
 * amounts of progress before each socket timeout.
 */
static int64_t send_deadline;

/* ESP32-S3-EYE pinout, not the ESP32-CAM/WROVER example pinout.
 * SCCB must use IDF 5.4's new I2C driver and the existing bus, at 100 kHz.
 * The camera never owns, reconfigures, or deletes the QMA6100P I2C bus.
 */
static const camera_config_t camera_config = {
    .pin_pwdn = -1,
    .pin_reset = -1,
    .pin_xclk = 15,
    .pin_sccb_sda = -1,
    .pin_sccb_scl = -1,
    .sccb_i2c_port = 0,
    .pin_d0 = 11, .pin_d1 = 9, .pin_d2 = 8, .pin_d3 = 10,
    .pin_d4 = 12, .pin_d5 = 18, .pin_d6 = 17, .pin_d7 = 16,
    .pin_vsync = 6,
    .pin_href = 7,
    .pin_pclk = 13,
    .xclk_freq_hz = 20000000,
    .ledc_timer = LEDC_TIMER_0,
    .ledc_channel = LEDC_CHANNEL_0,
    .pixel_format = PIXFORMAT_JPEG,
    .frame_size = FRAMESIZE_QVGA,
    .jpeg_quality = 14,
    .fb_count = 2,
    .fb_location = CAMERA_FB_IN_PSRAM,
    .grab_mode = CAMERA_GRAB_LATEST,
};

static bool valid_frame(const camera_fb_t *frame)
{
    return frame && frame->buf && frame->len >= 4 &&
           frame->format == PIXFORMAT_JPEG && frame->width == 320 && frame->height == 240 &&
           frame->buf[0] == 0xff && frame->buf[1] == 0xd8 &&
           frame->buf[frame->len - 2] == 0xff && frame->buf[frame->len - 1] == 0xd9;
}

static esp_err_t unavailable(httpd_req_t *request)
{
    httpd_resp_set_status(request, "503 Service Unavailable");
    httpd_resp_set_type(request, "application/json");
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    httpd_resp_set_hdr(request, "Retry-After", "2");
    httpd_resp_set_hdr(request, "Connection", "close");
    return httpd_resp_sendstr(request, "{\"online\":false,\"error\":\"camera_unavailable\"}");
}

static int bounded_send(httpd_handle_t server, int socket, const char *buffer, size_t length, int flags)
{
    if (!atomic_load(&enabled) || esp_timer_get_time() >= send_deadline) return HTTPD_SOCK_ERR_TIMEOUT;
    int sent = send(socket, buffer, length, flags);
    if (sent > 0) return sent;
    if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) return HTTPD_SOCK_ERR_TIMEOUT;
    return HTTPD_SOCK_ERR_FAIL;
}

static esp_err_t stream_handler(httpd_req_t *request)
{
    if (!atomic_load(&enabled) || !atomic_load(&ready)) return unavailable(request);

    esp_err_t result = httpd_resp_set_type(request,
        "multipart/x-mixed-replace; boundary=" PART_BOUNDARY);
    if (result == ESP_OK) result = httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    if (result == ESP_OK) result = httpd_resp_set_hdr(request, "Connection", "close");
    if (result == ESP_OK) result = httpd_resp_set_hdr(request, "X-Camera-Sensor", "OV2640");
    if (result == ESP_OK) result = httpd_sess_set_send_override(request->handle,
        httpd_req_to_sockfd(request), bounded_send);
    unsigned frames = 0;
    uint64_t bytes = 0;
    int64_t stats_start = esp_timer_get_time();
    ESP_LOGI(TAG, "STREAM_OPEN source=OV2640 resolution=320x240");

    while (result == ESP_OK && atomic_load(&enabled) && atomic_load(&ready)) {
        const int64_t cycle_start = esp_timer_get_time();
        if (xSemaphoreTake(camera_mutex, pdMS_TO_TICKS(500)) != pdTRUE) {
            result = ESP_ERR_TIMEOUT;
            break;
        }
        if (!atomic_load(&enabled) || !atomic_load(&ready)) {
            xSemaphoreGive(camera_mutex);
            break;
        }

        /* Only camera_mutex is held here. A slow client never holds the I2C
         * lock. Keeping this mutex until fb_return also excludes deinit.
         * esp_camera_fb_get has the driver's bounded four-second timeout.
         */
        camera_fb_t *frame = esp_camera_fb_get();
        if (!valid_frame(frame)) {
            if (frame) esp_camera_fb_return(frame);
            atomic_store(&ready, false);
            atomic_store(&frame_failed, true);
            xSemaphoreGive(camera_mutex);
            ESP_LOGW(TAG, "FRAME_FAILED; closing stream; camera retry in 10s");
            result = ESP_FAIL;
            break;
        }

        const size_t frame_bytes = frame->len;
        char header[128];
        int length = snprintf(header, sizeof(header),
            "\r\n--" PART_BOUNDARY "\r\nContent-Type: image/jpeg\r\nContent-Length: %zu\r\n\r\n",
            frame_bytes);
        if (length <= 0 || length >= (int)sizeof(header)) {
            result = ESP_ERR_INVALID_SIZE;
        } else if (!atomic_load(&enabled)) {
            result = ESP_FAIL;
        } else {
            send_deadline = esp_timer_get_time() + 2000000;
            result = httpd_resp_send_chunk(request, header, length);
            if (result == ESP_OK && atomic_load(&enabled)) {
                result = httpd_resp_send_chunk(request, (const char *)frame->buf, frame_bytes);
            } else if (result == ESP_OK) {
                result = ESP_FAIL;
            }
        }
        esp_camera_fb_return(frame);
        xSemaphoreGive(camera_mutex);
        if (result != ESP_OK) break;  /* A network error does not reset the camera. */

        ++frames;
        bytes += frame_bytes;
        int64_t now = esp_timer_get_time();
        if (now - stats_start >= 5000000) {
            const double seconds = (now - stats_start) / 1000000.0;
            ESP_LOGI(TAG, "STREAM_STATS frames=%u seconds=%.2f fps=%.2f jpeg_bytes=%" PRIu64
                     " bytes_per_second=%.0f internal_free=%u psram_free=%u",
                     frames, seconds, frames / seconds, bytes, bytes / seconds,
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
            frames = 0;
            bytes = 0;
            stats_start = now;
        }
        int64_t remaining = FRAME_INTERVAL_US - (esp_timer_get_time() - cycle_start);
        if (remaining > 0) {
            vTaskDelay(pdMS_TO_TICKS((remaining + 999) / 1000) + 1);
        } else {
            taskYIELD();
        }
    }
    /* Returning an error asks httpd to close the connection without another
     * potentially blocking send, including the camera-off path.
     */
    ESP_LOGI(TAG, "STREAM_CLOSED reason=%s enabled=%d", esp_err_to_name(result), atomic_load(&enabled));
    return ESP_FAIL;
}

static esp_err_t start_http_server(void)
{
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = 81;
    config.ctrl_port = ESP_HTTPD_DEF_CTRL_PORT + 1;
    config.task_priority = 3;
    config.stack_size = 6144;
    config.max_open_sockets = 2;
    config.max_uri_handlers = 1;
    config.backlog_conn = 1;
    config.recv_wait_timeout = 2;
    config.send_wait_timeout = 2;
    config.lru_purge_enable = true;
    esp_err_t err = httpd_start(&http_server, &config);
    if (err != ESP_OK) return err;
    const httpd_uri_t uri = {.uri = "/stream", .method = HTTP_GET, .handler = stream_handler};
    err = httpd_register_uri_handler(http_server, &uri);
    if (err != ESP_OK) {
        httpd_stop(http_server);
        http_server = NULL;
        return err;
    }
    ESP_LOGI(TAG, "HTTP_READY port=81 path=/stream; camera failures return 503");
    return ESP_OK;
}

static void camera_task(void *unused)
{
    bool initialized = false;
    int64_t camera_retry = 0, http_retry = 0;
    while (true) {
        const int64_t now = esp_timer_get_time();
        if (!http_server && now >= http_retry) {
            http_retry = now + RETRY_US;
            esp_err_t err = start_http_server();
            if (err != ESP_OK) ESP_LOGW(TAG, "HTTP_START_FAILED error=%s; retry in 10s", esp_err_to_name(err));
        }

        if (initialized && (!atomic_load(&enabled) || atomic_load(&frame_failed))) {
            atomic_store(&ready, false);
            if (xSemaphoreTake(camera_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                if (xSemaphoreTake(i2c_mutex, pdMS_TO_TICKS(500)) == pdTRUE) {
                    esp_err_t err = esp_camera_deinit();
                    xSemaphoreGive(i2c_mutex);
                    initialized = false;
                    atomic_store(&frame_failed, false);
                    camera_retry = esp_timer_get_time() + (atomic_load(&enabled) ? RETRY_US : 0);
                    ESP_LOGI(TAG, "CAMERA_OFFLINE cleanup=%s; QMA bus retained", esp_err_to_name(err));
                }
                xSemaphoreGive(camera_mutex);
            }
        }

        if (atomic_load(&enabled) && !initialized && now >= camera_retry) {
            camera_retry = now + RETRY_US;
            if (!esp_psram_is_initialized()) {
                ESP_LOGW(TAG, "PSRAM_UNAVAILABLE; camera offline; QMA acquisition continues");
            } else if (xSemaphoreTake(camera_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                if (xSemaphoreTake(i2c_mutex, pdMS_TO_TICKS(500)) == pdTRUE) {
                    ESP_LOGI(TAG, "CAMERA_INIT psram_bytes=%u psram_free=%u internal_free=%u",
                             (unsigned)esp_psram_get_size(),
                             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
                             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
                    esp_err_t err = esp_camera_init(&camera_config);
                    if (err == ESP_OK) {
                        sensor_t *sensor = esp_camera_sensor_get();
                        if (sensor && sensor->id.PID == OV2640_PID) {
                            initialized = true;
                            ESP_LOGI(TAG, "IDENTITY_OK sensor=OV2640 address=0x%02x PID=0x%02x"
                                     " VER=0x%02x MIDH=0x%02x MIDL=0x%02x",
                                     sensor->slv_addr, sensor->id.PID, sensor->id.VER,
                                     sensor->id.MIDH, sensor->id.MIDL);
                        } else {
                            esp_camera_deinit();
                            err = ESP_ERR_NOT_SUPPORTED;
                        }
                    }
                    /* esp_camera_init cleans its failed initialization. Its SCCB
                     * cleanup preserves this externally owned bus and QMA handle.
                     */
                    xSemaphoreGive(i2c_mutex);
                    if (!initialized) {
                        ESP_LOGW(TAG, "CAMERA_INIT_FAILED error=%s; retry in 10s", esp_err_to_name(err));
                    } else {
                        camera_fb_t *frame = esp_camera_fb_get();
                        bool valid = valid_frame(frame);
                        size_t length = frame ? frame->len : 0;
                        if (frame) esp_camera_fb_return(frame);
                        atomic_store(&frame_failed, !valid);
                        atomic_store(&ready, valid && atomic_load(&enabled));
                        if (valid) ESP_LOGI(TAG, "CAMERA_READY real_jpeg_bytes=%u resolution=320x240", (unsigned)length);
                        else ESP_LOGW(TAG, "FIRST_FRAME_FAILED; camera will be reinitialized");
                    }
                }
                xSemaphoreGive(camera_mutex);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

esp_err_t camera_monitor_start(SemaphoreHandle_t shared_i2c_mutex)
{
    if (!shared_i2c_mutex) return ESP_ERR_INVALID_ARG;
    if (camera_mutex) return ESP_ERR_INVALID_STATE;
    camera_mutex = xSemaphoreCreateMutex();
    if (!camera_mutex) return ESP_ERR_NO_MEM;
    i2c_mutex = shared_i2c_mutex;
    if (xTaskCreate(camera_task, "eye_camera", 6144, NULL, 2, NULL) != pdPASS) {
        vSemaphoreDelete(camera_mutex);
        camera_mutex = NULL;
        i2c_mutex = NULL;
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

void camera_monitor_set_enabled(bool value)
{
    atomic_store(&enabled, value);
    ESP_LOGI(TAG, "CAMERA_REQUEST enabled=%d", value);
}
