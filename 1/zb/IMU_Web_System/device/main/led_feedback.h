#pragma once

#include "esp_err.h"

typedef enum {
    LED_FEEDBACK_OFF,
    LED_FEEDBACK_PRESSED,
    LED_FEEDBACK_WAITING,
    LED_FEEDBACK_SUCCESS,
    LED_FEEDBACK_ERROR,
} led_feedback_state_t;

esp_err_t led_feedback_start(void);
void led_feedback_show(led_feedback_state_t state);
