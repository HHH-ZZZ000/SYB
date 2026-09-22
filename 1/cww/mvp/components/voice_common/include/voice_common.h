#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdint.h>

#include "driver/gpio.h"
#include "esp_err.h"
#include "freertos/FreeRTOS.h"

#ifdef __cplusplus
extern "C" {
#endif

#define VOICE_SAMPLE_RATE 16000
#define VOICE_CHANNELS 1
#define VOICE_BITS_PER_SAMPLE 16
#define VOICE_FEED_SAMPLES 160
#define VOICE_RECORD_BUTTON_GPIO GPIO_NUM_0

esp_err_t voice_audio_init(void);
/** Read sample_count mono samples from the board microphone. */
esp_err_t voice_read_samples(int16_t *samples, size_t sample_count);
/* Compatibility wrappers; new code should use voice_read_samples(). */
esp_err_t voice_audio_read(int16_t *samples, size_t sample_count);
esp_err_t voice_get_feed_data(int16_t *buffer, size_t sample_count);
const char *voice_get_input_format(void);
esp_err_t voice_sdcard_init(void);
void voice_button_init(void);
bool voice_button_pressed(void);

esp_err_t voice_wav_write_header(FILE *file, uint32_t data_size);
esp_err_t voice_wav_patch_header(FILE *file, uint32_t data_size);

#ifdef __cplusplus
}
#endif
