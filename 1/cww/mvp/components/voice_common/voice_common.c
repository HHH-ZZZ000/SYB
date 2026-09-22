#include "voice_common.h"

#include <stdio.h>
#include <string.h>

#include "esp_vfs_fat.h"
#include "sdmmc_cmd.h"
#include "driver/sdmmc_host.h"
#include "driver/i2s_std.h"
#include "driver/gpio.h"

/* ESP32-S3-EYE 板级引脚定义 */
#define I2S_MIC_BCLK  GPIO_NUM_41
#define I2S_MIC_WS    GPIO_NUM_42
#define I2S_MIC_DIN   GPIO_NUM_2

#define SDMMC_BUS_WIDTH 1
#define GPIO_SDMMC_CLK  GPIO_NUM_39
#define GPIO_SDMMC_CMD  GPIO_NUM_38
#define GPIO_SDMMC_D0   GPIO_NUM_40

static i2s_chan_handle_t rx_handle = NULL;

static void put_u16(uint8_t *p, uint16_t value)
{
    p[0] = (uint8_t)(value & 0xff);
    p[1] = (uint8_t)(value >> 8);
}

static void put_u32(uint8_t *p, uint32_t value)
{
    p[0] = (uint8_t)(value & 0xff);
    p[1] = (uint8_t)(value >> 8);
    p[2] = (uint8_t)(value >> 16);
    p[3] = (uint8_t)(value >> 24);
}

esp_err_t voice_audio_init(void)
{
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
    esp_err_t ret = i2s_new_channel(&chan_cfg, NULL, &rx_handle);
    if (ret != ESP_OK) {
        return ret;
    }

    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(VOICE_SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(32, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = GPIO_NUM_NC,
            .bclk = I2S_MIC_BCLK,
            .ws   = I2S_MIC_WS,
            .dout = GPIO_NUM_NC,
            .din  = I2S_MIC_DIN,
            .invert_flags = {
                .mclk_inv = false,
                .bclk_inv = false,
                .ws_inv   = false,
            },
        },
    };
    std_cfg.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT;

    ret = i2s_channel_init_std_mode(rx_handle, &std_cfg);
    if (ret != ESP_OK) {
        return ret;
    }

    return i2s_channel_enable(rx_handle);
}

esp_err_t voice_read_samples(int16_t *samples, size_t sample_count)
{
    if (!samples || sample_count == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    /* 读取 32-bit I2S 样本，右移 14 位转为 16-bit 后返回 */
    int32_t raw32[sample_count];
    size_t bytes_read;
    esp_err_t err = i2s_channel_read(rx_handle, raw32, sample_count * sizeof(int32_t),
                                     &bytes_read, portMAX_DELAY);
    if (err != ESP_OK) {
        return err;
    }

    for (size_t i = 0; i < sample_count; ++i) {
        samples[i] = (int16_t)(raw32[i] >> 14);
    }
    return ESP_OK;
}

esp_err_t voice_audio_read(int16_t *samples, size_t sample_count)
{
    return voice_read_samples(samples, sample_count);
}

esp_err_t voice_get_feed_data(int16_t *buffer, size_t sample_count)
{
    return voice_read_samples(buffer, sample_count);
}

const char *voice_get_input_format(void)
{
    return "MN";
}

esp_err_t voice_sdcard_init(void)
{
    esp_vfs_fat_sdmmc_mount_config_t mount_config = {
        .format_if_mount_failed = false,
        .max_files = 4,
        .allocation_unit_size = 16 * 1024,
    };
    sdmmc_host_t host = SDMMC_HOST_DEFAULT();
    sdmmc_slot_config_t slot_config = SDMMC_SLOT_CONFIG_DEFAULT();
    slot_config.width = SDMMC_BUS_WIDTH;
    slot_config.clk = GPIO_SDMMC_CLK;
    slot_config.cmd = GPIO_SDMMC_CMD;
    slot_config.d0  = GPIO_SDMMC_D0;
    slot_config.flags |= SDMMC_SLOT_FLAG_INTERNAL_PULLUP;

    sdmmc_card_t *card;
    esp_err_t ret = esp_vfs_fat_sdmmc_mount("/sdcard", &host, &slot_config, &mount_config, &card);
    if (ret == ESP_OK) {
        sdmmc_card_print_info(stdout, card);
    }
    return ret;
}

void voice_button_init(void)
{
    gpio_config_t config = {
        .pin_bit_mask = 1ULL << VOICE_RECORD_BUTTON_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&config));
}

bool voice_button_pressed(void)
{
    static int previous = 1;
    int current = gpio_get_level(VOICE_RECORD_BUTTON_GPIO);
    bool pressed = (previous == 1 && current == 0);
    previous = current;
    return pressed;
}

esp_err_t voice_wav_write_header(FILE *file, uint32_t data_size)
{
    if (!file) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t header[44] = {0};
    memcpy(header, "RIFF", 4);
    put_u32(header + 4, 36 + data_size);
    memcpy(header + 8, "WAVEfmt ", 8);
    put_u32(header + 16, 16);
    put_u16(header + 20, 1);
    put_u16(header + 22, VOICE_CHANNELS);
    put_u32(header + 24, VOICE_SAMPLE_RATE);
    put_u32(header + 28, VOICE_SAMPLE_RATE * VOICE_CHANNELS * VOICE_BITS_PER_SAMPLE / 8);
    put_u16(header + 32, VOICE_CHANNELS * VOICE_BITS_PER_SAMPLE / 8);
    put_u16(header + 34, VOICE_BITS_PER_SAMPLE);
    memcpy(header + 36, "data", 4);
    put_u32(header + 40, data_size);

    return fwrite(header, sizeof(header), 1, file) == 1 ? ESP_OK : ESP_FAIL;
}

esp_err_t voice_wav_patch_header(FILE *file, uint32_t data_size)
{
    if (!file || fseek(file, 0, SEEK_SET) != 0) {
        return ESP_ERR_INVALID_ARG;
    }
    esp_err_t err = voice_wav_write_header(file, data_size);
    fflush(file);
    return err;
}
