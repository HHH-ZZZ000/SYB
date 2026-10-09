#pragma once

#include "esp_err.h"
#include "freertos/event_groups.h"

esp_err_t button_capture_start(EventGroupHandle_t status_bits, EventBits_t wifi_ready_bit);
