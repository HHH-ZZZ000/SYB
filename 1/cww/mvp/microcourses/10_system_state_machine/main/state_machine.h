#pragma once

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    APP_STATE_IDLE,
    APP_STATE_LISTENING,
    APP_STATE_COMMAND,
    APP_STATE_CAPTURE,
    APP_STATE_RECORD,
    APP_STATE_INFER,
    APP_STATE_SAVE,
    APP_STATE_FEEDBACK,
    APP_STATE_ERROR,
} app_state_t;

typedef enum {
    APP_EVENT_START,
    APP_EVENT_WAKE_DETECTED,
    APP_EVENT_COMMAND_DETECTED,
    APP_EVENT_ACTION_DONE,
    APP_EVENT_ACTION_FAILED,
    APP_EVENT_TIMEOUT,
    APP_EVENT_CANCEL,
    APP_EVENT_RESET,
} app_event_t;

const char *app_state_name(app_state_t state);
const char *app_event_name(app_event_t event);

/* Apply one event and return false when the event is not valid for the state. */
bool state_machine_step(app_state_t *state, app_event_t event);

#ifdef __cplusplus
}
#endif
