#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "driver/i2c_master.h"
#include "esp_err.h"

/* QST QMA6100P Rev E: 14-bit output, +/-2 g, 4096 LSB/g. No gyroscope. */
typedef struct {
    int16_t raw[3];
    float g[3];
    bool new_data[3];
} qma6100p_sample_t;

esp_err_t qma6100p_read_id(i2c_master_dev_handle_t device, uint8_t *id);
bool qma6100p_id_matches(uint8_t id);
esp_err_t qma6100p_init(i2c_master_dev_handle_t device);
esp_err_t qma6100p_read_sample(i2c_master_dev_handle_t device, qma6100p_sample_t *sample);
