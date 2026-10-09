#include <stdint.h>

#include "driver/gpio.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "led_feedback.h"

#define FEEDBACK_LED GPIO_NUM_3

static QueueHandle_t feedback_events;

static void led_task(void *unused)
{
    led_feedback_state_t state = LED_FEEDBACK_OFF;
    int64_t started_us = esp_timer_get_time();
    bool previous_on = false;
    for (;;) {
        led_feedback_state_t next;
        if (xQueueReceive(feedback_events, &next, pdMS_TO_TICKS(25)) == pdTRUE) {
            state = next;
            started_us = esp_timer_get_time();
        }
        int64_t elapsed_ms = (esp_timer_get_time() - started_us) / 1000;
        bool on = false;
        switch (state) {
        case LED_FEEDBACK_PRESSED: on = (elapsed_ms / 100) % 2 == 0; break;
        case LED_FEEDBACK_WAITING: on = (elapsed_ms / 500) % 2 == 0; break;
        case LED_FEEDBACK_SUCCESS: on = elapsed_ms < 1000; break;
        case LED_FEEDBACK_ERROR: on = elapsed_ms < 600 && (elapsed_ms / 100) % 2 == 0; break;
        case LED_FEEDBACK_OFF: break;
        }
        if (on != previous_on) {
            /* GPIO3 is open-drain: 1 releases the pin; it never drives high. */
            gpio_set_level(FEEDBACK_LED, on ? 1 : 0);
            previous_on = on;
        }
        if ((state == LED_FEEDBACK_SUCCESS && elapsed_ms >= 1000) ||
            (state == LED_FEEDBACK_ERROR && elapsed_ms >= 600)) {
            state = LED_FEEDBACK_OFF;
        }
    }
}

esp_err_t led_feedback_start(void)
{
    const gpio_config_t config = {
        .pin_bit_mask = 1ULL << FEEDBACK_LED,
        .mode = GPIO_MODE_OUTPUT_OD,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_config(&config);
    if (err != ESP_OK) return err;
    gpio_set_level(FEEDBACK_LED, 0);
    feedback_events = xQueueCreate(1, sizeof(led_feedback_state_t));
    if (!feedback_events) return ESP_ERR_NO_MEM;
    if (xTaskCreate(led_task, "led_feedback", 2048, NULL, 2, NULL) != pdPASS) {
        vQueueDelete(feedback_events);
        feedback_events = NULL;
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

void led_feedback_show(led_feedback_state_t state)
{
    if (feedback_events) xQueueOverwrite(feedback_events, &state);
}
