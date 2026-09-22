#include "qma6100p.h"

#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

/* Source: QST QMA6100P Datasheet Rev E, pp. 14, 29, 33-34, 49-52.
 * The registers 0x45/0x4A/0x56/0x5F below are from the vendor's init sequence.
 * We never program NVM, and never initialize a device with an unrecognized ID.
 */
#define REG_CHIP_ID       0x00
#define REG_X_LSB         0x01
#define REG_RANGE         0x0F
#define REG_ODR           0x10
#define REG_POWER         0x11
#define REG_DATA_CTRL     0x21
#define REG_NVM_STATUS    0x33
#define REG_RESET         0x36
#define I2C_TIMEOUT_MS    100

static const char *TAG = "QMA6100P";

static esp_err_t read_registers(i2c_master_dev_handle_t device, uint8_t reg,
                                uint8_t *data, size_t count)
{
    esp_err_t err = i2c_master_transmit_receive(device, &reg, 1, data, count, I2C_TIMEOUT_MS);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Read register 0x%02X: %s", reg, esp_err_to_name(err));
    }
    return err;
}

static esp_err_t write_register(i2c_master_dev_handle_t device, uint8_t reg, uint8_t value)
{
    const uint8_t bytes[] = {reg, value};
    esp_err_t err = i2c_master_transmit(device, bytes, sizeof(bytes), I2C_TIMEOUT_MS);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Write register 0x%02X=0x%02X: %s", reg, value, esp_err_to_name(err));
    }
    return err;
}

esp_err_t qma6100p_read_id(i2c_master_dev_handle_t device, uint8_t *id)
{
    if (device == NULL || id == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    return read_registers(device, REG_CHIP_ID, id, 1);
}

bool qma6100p_id_matches(uint8_t id)
{
    /* Rev E p.29: high nibble is 1001; low nibble is factory-defined. */
    return (id & 0xF0) == 0x90;
}

static esp_err_t reset_and_load(i2c_master_dev_handle_t device)
{
    for (unsigned attempt = 1; attempt <= 3; ++attempt) {
        ESP_RETURN_ON_ERROR(write_register(device, REG_RESET, 0xB6), TAG, "Reset failed");
        /* 10 ms also satisfies the >=1 ms minimum with the default 100 Hz RTOS tick. */
        vTaskDelay(pdMS_TO_TICKS(10));
        ESP_RETURN_ON_ERROR(write_register(device, REG_RESET, 0x00), TAG, "Reset release failed");

        uint8_t status = 0;
        bool ready = false;
        for (unsigned poll = 0; poll < 20; ++poll) {
            ESP_RETURN_ON_ERROR(read_registers(device, REG_NVM_STATUS, &status, 1), TAG, "NVM status failed");
            if ((status & 0x05) == 0x05) {
                ready = true;
                break;
            }
            vTaskDelay(pdMS_TO_TICKS(10));
        }
        if (!ready) {
            ESP_LOGW(TAG, "Init attempt %u: NVM not ready (0x33=0x%02X)", attempt, status);
            continue;
        }

        uint8_t otp_check = 0;
        ESP_RETURN_ON_ERROR(read_registers(device, 0x45, &otp_check, 1), TAG, "OTP check failed");
        ESP_LOGI(TAG, "Init attempt %u: NVM=0x%02X OTP_CHECK=0x%02X", attempt, status, otp_check);
        if ((otp_check & 0xF0) == 0xC0) {
            return ESP_OK;
        }
        ESP_LOGW(TAG, "OTP high nibble must be 0xC; repeating documented reset sequence");
    }
    return ESP_ERR_INVALID_RESPONSE;
}

esp_err_t qma6100p_init(i2c_master_dev_handle_t device)
{
    uint8_t id;
    ESP_RETURN_ON_ERROR(qma6100p_read_id(device, &id), TAG, "Cannot read identity");
    ESP_RETURN_ON_FALSE(qma6100p_id_matches(id), ESP_ERR_NOT_SUPPORTED, TAG,
                        "Refusing register writes: unsupported CHIP_ID=0x%02X", id);
    ESP_RETURN_ON_ERROR(reset_and_load(device), TAG, "Reset/NVM check failed after bounded attempts");

    const uint8_t setup[][2] = {
        {REG_POWER, 0x80},  /* Active mode, followed by the required clock selection. */
        {REG_POWER, 0x84},  /* MCLK = 51.2 kHz. */
        {0x4A, 0x20},      /* Vendor-required power-on setting. */
        {0x56, 0x01},      /* Vendor-required power-on setting. */
        {0x5F, 0x80},      /* Begin the vendor's initialization pulse. */
    };
    for (unsigned i = 0; i < sizeof(setup) / sizeof(setup[0]); ++i) {
        ESP_RETURN_ON_ERROR(write_register(device, setup[i][0], setup[i][1]), TAG, "Power-on setup failed");
    }
    vTaskDelay(pdMS_TO_TICKS(10));
    ESP_RETURN_ON_ERROR(write_register(device, 0x5F, 0x00), TAG, "Initialization pulse release failed");
    ESP_RETURN_ON_ERROR(write_register(device, REG_RANGE, 0x01), TAG, "Range setup failed");
    ESP_RETURN_ON_ERROR(write_register(device, REG_ODR, 0x00), TAG, "ODR setup failed");

    uint8_t range, odr, power, data_ctrl;
    ESP_RETURN_ON_ERROR(read_registers(device, REG_RANGE, &range, 1), TAG, "Range readback failed");
    ESP_RETURN_ON_ERROR(read_registers(device, REG_ODR, &odr, 1), TAG, "ODR readback failed");
    ESP_RETURN_ON_ERROR(read_registers(device, REG_POWER, &power, 1), TAG, "Power readback failed");
    ESP_RETURN_ON_ERROR(read_registers(device, REG_DATA_CTRL, &data_ctrl, 1), TAG, "Shadowing readback failed");
    ESP_LOGI(TAG, "CONFIG range=0x%02X odr=0x%02X power=0x%02X data_ctrl=0x%02X",
             range, odr, power, data_ctrl);
    ESP_RETURN_ON_FALSE((range & 0x4F) == 0x01 && (odr & 0xE7) == 0x00 &&
                        (power & 0x8F) == 0x84 && (data_ctrl & 0x40) == 0,
                        ESP_ERR_INVALID_RESPONSE, TAG, "Configuration mismatch; sampling stopped");
    vTaskDelay(pdMS_TO_TICKS(100));
    ESP_LOGI(TAG, "INIT_OK sensor=QMA6100P range=+/-2g sensitivity=4096_LSB/g ODR=100Hz");
    return ESP_OK;
}

esp_err_t qma6100p_read_sample(i2c_master_dev_handle_t device, qma6100p_sample_t *sample)
{
    if (device == NULL || sample == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    uint8_t bytes[6];
    ESP_RETURN_ON_ERROR(read_registers(device, REG_X_LSB, bytes, sizeof(bytes)), TAG, "XYZ burst read failed");
    qma6100p_sample_t result;
    for (unsigned axis = 0; axis < 3; ++axis) {
        const uint8_t lsb = bytes[2 * axis];
        const uint8_t msb = bytes[2 * axis + 1];
        const uint16_t value = ((uint16_t)msb << 6) | (lsb >> 2);
        /* Explicit sign extension avoids implementation-defined signed right shifts. */
        result.raw[axis] = (value & 0x2000) ? (int32_t)value - 0x4000 : value;
        result.g[axis] = result.raw[axis] / 4096.0f;
        result.new_data[axis] = (lsb & 0x01) != 0;
    }
    *sample = result;  /* Never return stale or partially updated data on a bus failure. */
    return ESP_OK;
}
