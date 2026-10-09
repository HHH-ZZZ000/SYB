#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

/* Start once, after creating I2C0 on GPIO4/GPIO5. The caller retains ownership
 * of shared_i2c_mutex and the bus for the lifetime of this module.
 * ESP_OK means the supervisor started; actual camera readiness is established
 * only after detecting OV2640 and acquiring a real JPEG frame.
 */
esp_err_t camera_monitor_start(SemaphoreHandle_t shared_i2c_mutex);

/* Nonblocking request. Disabling closes the active stream and releases camera
 * resources after any bounded frame acquisition/send has finished. The HTTP
 * service stays available on port 81 and returns 503 while the camera is off.
 */
void camera_monitor_set_enabled(bool enabled);

/* One explicitly requested fresh frame. Caller frees jpeg with free().
 * capture_time_us is device wall time mapped from the frame's DMA timestamp.
 */
esp_err_t camera_monitor_capture(uint8_t **jpeg, size_t *length, int64_t *capture_time_us);
