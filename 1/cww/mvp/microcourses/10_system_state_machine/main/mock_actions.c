#include "mock_actions.h"

#include "esp_log.h"

#include "state_config.h"

static const char *TAG = "lesson10_mock";

app_event_t mock_action_event(app_state_t state)
{
    switch (state) {
        case APP_STATE_LISTENING:
            ESP_LOGI(TAG, "mock action=wait_wake result=detected");
            return STATE_MACHINE_SCENARIO == STATE_SCENARIO_TIMEOUT
                       ? APP_EVENT_TIMEOUT : APP_EVENT_WAKE_DETECTED;
        case APP_STATE_COMMAND:
            ESP_LOGI(TAG, "mock action=recognize_command result=detected");
            if (STATE_MACHINE_SCENARIO == STATE_SCENARIO_CANCEL) {
                return APP_EVENT_CANCEL;
            }
            return STATE_MACHINE_SCENARIO == STATE_SCENARIO_TIMEOUT
                       ? APP_EVENT_TIMEOUT : APP_EVENT_COMMAND_DETECTED;
        case APP_STATE_CAPTURE:
            ESP_LOGI(TAG, "mock action=capture result=%s",
                     STATE_MACHINE_SCENARIO == STATE_SCENARIO_FAIL_RECORD ? "done" : "done");
            return APP_EVENT_ACTION_DONE;
        case APP_STATE_RECORD:
            ESP_LOGI(TAG, "mock action=record result=%s",
                     STATE_MACHINE_SCENARIO == STATE_SCENARIO_FAIL_RECORD ? "failed" : "done");
            return STATE_MACHINE_SCENARIO == STATE_SCENARIO_FAIL_RECORD
                       ? APP_EVENT_ACTION_FAILED : APP_EVENT_ACTION_DONE;
        case APP_STATE_INFER:
            ESP_LOGI(TAG, "mock action=infer result=done");
            return APP_EVENT_ACTION_DONE;
        case APP_STATE_SAVE:
            ESP_LOGI(TAG, "mock action=save result=done");
            return APP_EVENT_ACTION_DONE;
        case APP_STATE_FEEDBACK:
            ESP_LOGI(TAG, "mock action=feedback result=done");
            return APP_EVENT_ACTION_DONE;
        default:
            return APP_EVENT_ACTION_FAILED;
    }
}
