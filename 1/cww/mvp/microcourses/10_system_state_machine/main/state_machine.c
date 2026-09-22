#include "state_machine.h"

const char *app_state_name(app_state_t state)
{
    static const char *names[] = {
        "IDLE", "LISTENING", "COMMAND", "CAPTURE", "RECORD",
        "INFER", "SAVE", "FEEDBACK", "ERROR",
    };
    return state <= APP_STATE_ERROR ? names[state] : "UNKNOWN_STATE";
}

const char *app_event_name(app_event_t event)
{
    static const char *names[] = {
        "START", "WAKE_DETECTED", "COMMAND_DETECTED", "ACTION_DONE",
        "ACTION_FAILED", "TIMEOUT", "CANCEL", "RESET",
    };
    return event <= APP_EVENT_RESET ? names[event] : "UNKNOWN_EVENT";
}

static bool is_cancel_or_reset(app_event_t event)
{
    return event == APP_EVENT_CANCEL || event == APP_EVENT_RESET;
}

bool state_machine_step(app_state_t *state, app_event_t event)
{
    if (!state || *state > APP_STATE_ERROR || event > APP_EVENT_RESET) {
        return false;
    }

    if (event == APP_EVENT_CANCEL) {
        *state = APP_STATE_IDLE;
        return true;
    }
    if (*state == APP_STATE_ERROR && event == APP_EVENT_RESET) {
        *state = APP_STATE_IDLE;
        return true;
    }
    if (*state == APP_STATE_IDLE && event == APP_EVENT_RESET) {
        return true;
    }

    switch (*state) {
        case APP_STATE_IDLE:
            if (event == APP_EVENT_START) {
                *state = APP_STATE_LISTENING;
                return true;
            }
            break;
        case APP_STATE_LISTENING:
            if (event == APP_EVENT_WAKE_DETECTED) {
                *state = APP_STATE_COMMAND;
                return true;
            }
            if (event == APP_EVENT_TIMEOUT) {
                *state = APP_STATE_ERROR;
                return false;
            }
            break;
        case APP_STATE_COMMAND:
            if (event == APP_EVENT_COMMAND_DETECTED) {
                *state = APP_STATE_CAPTURE;
                return true;
            }
            if (event == APP_EVENT_TIMEOUT) {
                *state = APP_STATE_ERROR;
                return false;
            }
            break;
        case APP_STATE_CAPTURE:
            if (event == APP_EVENT_ACTION_DONE) {
                *state = APP_STATE_RECORD;
                return true;
            }
            if (event == APP_EVENT_ACTION_FAILED) {
                *state = APP_STATE_ERROR;
                return false;
            }
            break;
        case APP_STATE_RECORD:
            if (event == APP_EVENT_ACTION_DONE) {
                *state = APP_STATE_INFER;
                return true;
            }
            if (event == APP_EVENT_ACTION_FAILED || event == APP_EVENT_TIMEOUT) {
                *state = APP_STATE_ERROR;
                return false;
            }
            break;
        case APP_STATE_INFER:
            if (event == APP_EVENT_ACTION_DONE) {
                *state = APP_STATE_SAVE;
                return true;
            }
            if (event == APP_EVENT_ACTION_FAILED) {
                *state = APP_STATE_ERROR;
                return false;
            }
            break;
        case APP_STATE_SAVE:
            if (event == APP_EVENT_ACTION_DONE) {
                *state = APP_STATE_FEEDBACK;
                return true;
            }
            if (event == APP_EVENT_ACTION_FAILED) {
                *state = APP_STATE_ERROR;
                return false;
            }
            break;
        case APP_STATE_FEEDBACK:
            if (event == APP_EVENT_ACTION_DONE) {
                *state = APP_STATE_IDLE;
                return true;
            }
            break;
        case APP_STATE_ERROR:
            break;
    }

    if (!is_cancel_or_reset(event)) {
        *state = APP_STATE_ERROR;
    }
    return false;
}
