#include "real_actions.hpp"

#include <cstdio>
#include <cstring>
#include <inttypes.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "who_cam_define.hpp"
#include "who_frame_cap_node.hpp"

#include "catdog_classifier.hpp"
#include "test_config.h"
#include "voice_common.h"

static const char *TAG = "state_actions";
static who::frame_cap::WhoFrameCapNode *s_frame_node = nullptr;
static CatDogClassifier *s_classifier = nullptr;
static uint8_t *s_image = nullptr;
static size_t s_image_len = 0;
static uint16_t s_image_width = 0;
static uint16_t s_image_height = 0;
static const char *s_label = "unknown";
static float s_score = 0.0f;
static uint32_t s_record_id = 0;
static char s_audio_path[64];
static int64_t s_timestamp_us = 0;
static real_status_cb_t s_status_cb = nullptr;

static void set_status(const char *text)
{
    if (s_status_cb) {
        s_status_cb(text);
    }
}

bool real_actions_init(who::frame_cap::WhoFrameCapNode *frame_node,
                       CatDogClassifier *classifier,
                       real_status_cb_t status_cb)
{
    s_frame_node = frame_node;
    s_classifier = classifier;
    s_status_cb = status_cb;
    s_timestamp_us = esp_timer_get_time();
    return s_frame_node != nullptr && s_classifier != nullptr;
}

bool real_action_capture(void)
{
    const int64_t start = esp_timer_get_time();
    set_status("CAPTURE");
#if REAL_ACTION_SCENARIO == REAL_SCENARIO_FAIL_CAPTURE
    ESP_LOGE(TAG, "capture_failed=injected");
    set_status("ERROR: CAPTURE TEST");
    ESP_LOGI(TAG, "[ACTION] capture_ms=%lld result=failed reason=injected",
             (long long)((esp_timer_get_time() - start) / 1000));
    return false;
#endif
    who::cam::cam_fb_t *fb = s_frame_node ? s_frame_node->cam_fb_peek() : nullptr;
    if (!fb || !fb->buf || fb->len == 0) {
        ESP_LOGE(TAG, "capture_failed=no_frame");
        set_status("ERROR: NO FRAME");
        ESP_LOGI(TAG, "[ACTION] capture_ms=%lld result=failed reason=no_frame",
                 (long long)((esp_timer_get_time() - start) / 1000));
        return false;
    }

    uint8_t *copy = static_cast<uint8_t *>(heap_caps_malloc(fb->len, MALLOC_CAP_SPIRAM));
    if (!copy) {
        ESP_LOGE(TAG, "capture_failed=psram_alloc bytes=%u", (unsigned)fb->len);
        set_status("ERROR: CAPTURE RAM");
        ESP_LOGI(TAG, "[ACTION] capture_ms=%lld result=failed reason=psram_alloc",
                 (long long)((esp_timer_get_time() - start) / 1000));
        return false;
    }
    memcpy(copy, fb->buf, fb->len);
    if (s_image) {
        heap_caps_free(s_image);
    }
    s_image = copy;
    s_image_len = fb->len;
    s_image_width = fb->width;
    s_image_height = fb->height;
    ESP_LOGI(TAG, "capture_done width=%u height=%u bytes=%u",
             s_image_width, s_image_height, (unsigned)s_image_len);
    ESP_LOGI(TAG, "[ACTION] capture_ms=%lld result=ok",
             (long long)((esp_timer_get_time() - start) / 1000));
    set_status("CAPTURE COMPLETE");
    return true;
}

bool real_action_record(void)
{
    const int64_t start = esp_timer_get_time();
    set_status("RECORDING 10s");
#if REAL_ACTION_SCENARIO == REAL_SCENARIO_FAIL_RECORD
    ESP_LOGE(TAG, "record_failed=injected");
    set_status("ERROR: RECORD TEST");
    ESP_LOGI(TAG, "[ACTION] record_ms=%lld result=failed reason=injected",
             (long long)((esp_timer_get_time() - start) / 1000));
    return false;
#endif
    if (!s_image) {
        ESP_LOGE(TAG, "record_failed=no_captured_image");
        set_status("ERROR: NO IMAGE");
        ESP_LOGI(TAG, "[ACTION] record_ms=%lld result=failed reason=no_image",
                 (long long)((esp_timer_get_time() - start) / 1000));
        return false;
    }
    s_record_id++;
    snprintf(s_audio_path, sizeof(s_audio_path), "/sdcard/memory_%06" PRIu32 ".wav", s_record_id);
    FILE *file = fopen(s_audio_path, "wb+");
    if (!file || voice_wav_write_header(file, 0) != ESP_OK) {
        ESP_LOGE(TAG, "record_failed=open path=%s", s_audio_path);
        if (file) fclose(file);
        remove(s_audio_path);
        set_status("ERROR: RECORD OPEN");
        ESP_LOGI(TAG, "[ACTION] record_ms=%lld result=failed reason=open",
                 (long long)((esp_timer_get_time() - start) / 1000));
        return false;
    }

    int16_t samples[VOICE_FEED_SAMPLES];
    const uint32_t target_samples = VOICE_SAMPLE_RATE * 10;
    uint32_t total_samples = 0;
    while (total_samples < target_samples) {
        if (voice_read_samples(samples, VOICE_FEED_SAMPLES) != ESP_OK ||
            fwrite(samples, sizeof(int16_t), VOICE_FEED_SAMPLES, file) != VOICE_FEED_SAMPLES) {
            ESP_LOGE(TAG, "record_failed=audio_or_write");
            fclose(file);
            remove(s_audio_path);
            set_status("ERROR: RECORD WRITE");
            ESP_LOGI(TAG, "[ACTION] record_ms=%lld result=failed reason=audio_or_write",
                     (long long)((esp_timer_get_time() - start) / 1000));
            return false;
        }
        total_samples += VOICE_FEED_SAMPLES;
    }
    const uint32_t data_size = total_samples * sizeof(int16_t);
    const bool ok = voice_wav_patch_header(file, data_size) == ESP_OK;
    fclose(file);
    ESP_LOGI(TAG, "record_%s path=%s duration_ms=%" PRIu32 " elapsed_ms=%lld",
             ok ? "done" : "failed", s_audio_path,
             total_samples * 1000 / VOICE_SAMPLE_RATE,
             (long long)((esp_timer_get_time() - start) / 1000));
    ESP_LOGI(TAG, "[ACTION] record_ms=%lld result=%s duration_ms=%" PRIu32,
             (long long)((esp_timer_get_time() - start) / 1000),
             ok ? "ok" : "failed", total_samples * 1000 / VOICE_SAMPLE_RATE);
    if (!ok) {
        remove(s_audio_path);
        set_status("ERROR: RECORD HEADER");
    } else {
        set_status("RECORD COMPLETE");
    }
    return ok;
}

bool real_action_infer(void)
{
    const int64_t start = esp_timer_get_time();
    set_status("INFER CAT/DOG");
#if REAL_ACTION_SCENARIO == REAL_SCENARIO_FAIL_INFER
    ESP_LOGE(TAG, "infer_failed=injected");
    set_status("ERROR: INFER TEST");
    ESP_LOGI(TAG, "[ACTION] infer_ms=%lld result=failed reason=injected",
             (long long)((esp_timer_get_time() - start) / 1000));
    return false;
#endif
    if (!s_image || !s_classifier) {
        ESP_LOGE(TAG, "infer_failed=missing_input");
        set_status("ERROR: INFER INPUT");
        ESP_LOGI(TAG, "[ACTION] infer_ms=%lld result=failed reason=missing_input",
                 (long long)((esp_timer_get_time() - start) / 1000));
        return false;
    }
    dl::image::img_t image = {
        .data = s_image,
        .width = s_image_width,
        .height = s_image_height,
        .pix_type = dl::image::DL_IMAGE_PIX_TYPE_RGB565LE,
    };
    auto &results = s_classifier->run(image);
    if (results.empty()) {
        ESP_LOGE(TAG, "infer_failed=no_result");
        set_status("ERROR: INFER RESULT");
        ESP_LOGI(TAG, "[ACTION] infer_ms=%lld result=failed reason=no_result",
                 (long long)((esp_timer_get_time() - start) / 1000));
        return false;
    }
    s_label = results[0].cat_name;
    s_score = results[0].score;
    ESP_LOGI(TAG, "infer_done label=%s score=%.4f elapsed_ms=%lld",
             s_label, s_score, (long long)((esp_timer_get_time() - start) / 1000));
    ESP_LOGI(TAG, "[ACTION] infer_ms=%lld result=ok",
             (long long)((esp_timer_get_time() - start) / 1000));
    return true;
}

bool real_action_save(void)
{
    const int64_t start = esp_timer_get_time();
    set_status("SAVING MEMORY");
#if REAL_ACTION_SCENARIO == REAL_SCENARIO_FAIL_SAVE
    ESP_LOGE(TAG, "save_failed=injected");
    set_status("ERROR: SAVE TEST");
    ESP_LOGI(TAG, "[ACTION] save_ms=%lld result=failed reason=injected",
             (long long)((esp_timer_get_time() - start) / 1000));
    return false;
#endif
    if (!s_image || s_audio_path[0] == '\0') {
        ESP_LOGE(TAG, "save_failed=missing_artifacts");
        set_status("ERROR: MISSING FILE");
        ESP_LOGI(TAG, "[ACTION] save_ms=%lld result=failed reason=missing_artifacts",
                 (long long)((esp_timer_get_time() - start) / 1000));
        return false;
    }
    char image_path[64];
    char meta_path[64];
    snprintf(image_path, sizeof(image_path), "/sdcard/memory_%06" PRIu32 ".rgb565", s_record_id);
    snprintf(meta_path, sizeof(meta_path), "/sdcard/memory_%06" PRIu32 ".txt", s_record_id);
    FILE *image = fopen(image_path, "wb");
    FILE *meta = fopen(meta_path, "w");
    if (!image || !meta || fwrite(s_image, 1, s_image_len, image) != s_image_len) {
        ESP_LOGE(TAG, "save_failed=write");
        if (image) fclose(image);
        if (meta) fclose(meta);
        remove(image_path);
        remove(meta_path);
        set_status("ERROR: SD WRITE");
        ESP_LOGI(TAG, "[ACTION] save_ms=%lld result=failed reason=write",
                 (long long)((esp_timer_get_time() - start) / 1000));
        return false;
    }
    int metadata_size = fprintf(meta,
                                "timestamp=%" PRId64 "\ntimestamp_source=esp_timer\n"
                                "width=%u\nheight=%u\nformat=RGB565\nimage=%s\n"
                                "audio=%s\nlabel=%s\nscore=%.4f\n",
                                s_timestamp_us, s_image_width, s_image_height,
                                image_path, s_audio_path, s_label, s_score);
    bool ok = metadata_size > 0 && fflush(image) == 0 && fflush(meta) == 0;
    const bool image_close_ok = fclose(image) == 0;
    const bool meta_close_ok = fclose(meta) == 0;
    ok = image_close_ok && meta_close_ok && ok;
    if (!ok) {
        ESP_LOGE(TAG, "save_failed=metadata_or_close");
        remove(image_path);
        remove(meta_path);
        set_status("ERROR: SD FINALIZE");
        ESP_LOGI(TAG, "[ACTION] save_ms=%lld result=failed reason=metadata_or_close",
                 (long long)((esp_timer_get_time() - start) / 1000));
        return false;
    }
    ESP_LOGI(TAG, "[ACTION] save_ms=%lld result=ok",
             (long long)((esp_timer_get_time() - start) / 1000));
    ESP_LOGI(TAG, "save_done image=%s audio=%s meta=%s", image_path, s_audio_path, meta_path);
    ESP_LOGI(TAG, "[RESULT] image=%s audio=%s label=%s timestamp=%" PRId64,
             image_path, s_audio_path, s_label, s_timestamp_us);
    return true;
}

void real_actions_release(void)
{
    if (s_image) {
        heap_caps_free(s_image);
        s_image = nullptr;
    }
    s_image_len = 0;
    s_audio_path[0] = '\0';
    s_label = "unknown";
    s_score = 0.0f;
    s_status_cb = nullptr;
}

void real_actions_cleanup_failed(void)
{
    if (s_audio_path[0] != '\0') {
        remove(s_audio_path);
    }
}
