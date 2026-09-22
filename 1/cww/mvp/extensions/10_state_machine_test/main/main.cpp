#include "bsp/esp-bsp.h"
#include "catdog_classifier.hpp"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lvgl.h"
#include "nvs_flash.h"
#include "who_frame_lcd_disp.hpp"
#include "who_yield2idle.hpp"

#include "frame_cap_pipeline.hpp"
#include "real_actions.hpp"
#include "state_machine.h"
#include "test_config.h"
#include "voice_common.h"

using namespace who::frame_cap;
using namespace who::lcd_disp;

static const char *TAG = "lesson10_real";
#if !BSP_CONFIG_NO_GRAPHIC_LIB
static lv_obj_t *s_status_label = nullptr;
#endif

static void set_lcd_status(const char *text)
{
#if !BSP_CONFIG_NO_GRAPHIC_LIB
    if (s_status_label) {
        bsp_display_lock(0);
        lv_label_set_text(s_status_label, text);
        bsp_display_unlock();
    }
#endif
    ESP_LOGI(TAG, "[LCD] status=%s", text);
}

extern const uint8_t catdog_mobilenet_v2_espdl_start[] asm("_binary_catdog_mobilenet_v2_espdl_start");

static void dispatch_event(app_state_t *state, app_event_t event)
{
    app_state_t previous = *state;
    const bool accepted = state_machine_step(state, event);
    ESP_LOGI(TAG, "[STATE] %s %s -> %s event=%s accepted=%s",
             accepted ? "transition" : "error",
             app_state_name(previous), app_state_name(*state), app_event_name(event),
             accepted ? "yes" : "no");
}

static bool run_real_record(WhoFrameCapNode *frame_node, CatDogClassifier *classifier)
{
    if (!real_actions_init(frame_node, classifier, set_lcd_status)) {
        set_lcd_status("ERROR: ACTION INIT");
        return false;
    }
    app_state_t state = APP_STATE_IDLE;
    bool feedback_reached = false;
    dispatch_event(&state, APP_EVENT_START);
    dispatch_event(&state, APP_EVENT_WAKE_DETECTED);
#if REAL_ACTION_SCENARIO == REAL_SCENARIO_CANCEL
    dispatch_event(&state, APP_EVENT_CANCEL);
#elif REAL_ACTION_SCENARIO == REAL_SCENARIO_COMMAND_TIMEOUT
    dispatch_event(&state, APP_EVENT_TIMEOUT);
#else
    dispatch_event(&state, APP_EVENT_COMMAND_DETECTED);
#endif

    if (state == APP_STATE_CAPTURE) {
        dispatch_event(&state, real_action_capture() ? APP_EVENT_ACTION_DONE : APP_EVENT_ACTION_FAILED);
    }
    if (state == APP_STATE_RECORD) {
#if REAL_ACTION_SCENARIO == REAL_SCENARIO_RECORD_TIMEOUT
        ESP_LOGI(TAG, "record_timeout=injected");
        dispatch_event(&state, APP_EVENT_TIMEOUT);
#else
        dispatch_event(&state, real_action_record() ? APP_EVENT_ACTION_DONE : APP_EVENT_ACTION_FAILED);
#endif
    }
    if (state == APP_STATE_INFER) {
        dispatch_event(&state, real_action_infer() ? APP_EVENT_ACTION_DONE : APP_EVENT_ACTION_FAILED);
    }
    if (state == APP_STATE_SAVE) {
        dispatch_event(&state, real_action_save() ? APP_EVENT_ACTION_DONE : APP_EVENT_ACTION_FAILED);
    }
    if (state == APP_STATE_FEEDBACK) {
        ESP_LOGI(TAG, "feedback=record_complete");
        set_lcd_status("SUCCESS - RECORD SAVED");
        dispatch_event(&state, APP_EVENT_ACTION_DONE);
        feedback_reached = true;
    }
    const bool ok = feedback_reached && state == APP_STATE_IDLE;
    if (!ok) {
        ESP_LOGE(TAG, "record_failed final_state=%s", app_state_name(state));
        dispatch_event(&state, APP_EVENT_RESET);
        set_lcd_status("IDLE - READY");
        real_actions_cleanup_failed();
    }
    real_actions_release();
    return ok;
}

extern "C" void app_main(void)
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    led_indicator_handle_t leds[BSP_LED_NUM];
    ESP_ERROR_CHECK(bsp_led_indicator_create(leds, NULL, BSP_LED_NUM));
    ESP_ERROR_CHECK(bsp_led_set(leds[BSP_LED_1], false));

    auto classifier = new CatDogClassifier(
        (const char *)catdog_mobilenet_v2_espdl_start,
        fbs::MODEL_LOCATION_IN_FLASH_RODATA);
    if (!classifier->is_ready()) {
        ESP_LOGE(TAG, "classifier_init_failed");
        delete classifier;
        return;
    }

    auto frame_cap = get_preview_frame_cap_pipeline();
    WhoFrameCapNode *frame_node = frame_cap->get_last_node();
    auto lcd_disp = new WhoFrameLCDDisp("LCDDisp", frame_node);
#if !BSP_CONFIG_NO_GRAPHIC_LIB
    bsp_display_lock(0);
    s_status_label = lv_label_create(lv_scr_act());
    lv_obj_align(s_status_label, LV_ALIGN_TOP_MID, 0, 4);
    bsp_display_unlock();
#endif
    bool ok = who::WhoYield2Idle::get_instance()->run();
    for (const auto &node : frame_cap->get_all_nodes()) {
        ok &= node->run(4096, 2, 0);
    }
    ok &= lcd_disp->run(2560, 2, 0);
    if (!ok) {
        ESP_LOGE(TAG, "preview_init_failed");
        return;
    }

    ESP_ERROR_CHECK(voice_audio_init());
    ESP_ERROR_CHECK(voice_sdcard_init());
    voice_button_init();
    set_lcd_status("IDLE - READY");
    ESP_LOGI(TAG, "ready: press GPIO%d to start one real record", VOICE_RECORD_BUTTON_GPIO);
    while (true) {
        if (voice_button_pressed()) {
            ESP_LOGI(TAG, "record_start");
            run_real_record(frame_node, classifier);
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}
