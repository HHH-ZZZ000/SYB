#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "voice_common.h"

#include "mock_actions.h"
#include "state_machine.h"

static const char *TAG = "lesson10_state";

static void dispatch_event(app_state_t *state, app_event_t event)
{
    app_state_t previous = *state;
    bool accepted = state_machine_step(state, event);
    ESP_LOGI(TAG, "[STATE] %s %s -> %s event=%s accepted=%s",
             accepted ? "transition" : "error",
             app_state_name(previous), app_state_name(*state),
             app_event_name(event), accepted ? "yes" : "no");
}

static void run_demo(void)
{
    app_state_t state = APP_STATE_IDLE;
    dispatch_event(&state, APP_EVENT_START);

    while (state != APP_STATE_IDLE && state != APP_STATE_ERROR) {
        vTaskDelay(pdMS_TO_TICKS(100));
        dispatch_event(&state, mock_action_event(state));
    }

    if (state == APP_STATE_ERROR) {
        ESP_LOGI(TAG, "error_path_reset_to_idle");
        dispatch_event(&state, APP_EVENT_RESET);
    }
}

void app_main(void)
{
    voice_button_init();
    ESP_LOGI(TAG, "ready: press GPIO%d to run the state-machine demo", VOICE_RECORD_BUTTON_GPIO);
    while (true) {
        if (voice_button_pressed()) {
            run_demo();
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}
