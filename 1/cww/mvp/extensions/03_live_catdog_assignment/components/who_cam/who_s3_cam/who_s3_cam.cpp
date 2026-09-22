#include "who_s3_cam.hpp"
#include "esp_err.h"
#include "esp_log.h"

static const char *TAG = "WhoS3Cam";

namespace who {
namespace cam {

WhoS3Cam::WhoS3Cam(const pixformat_t pixel_format,
                   const framesize_t frame_size,
                   const uint8_t fb_count,
                   bool vertical_flip,
                   bool horizontal_flip) :
    WhoCam(fb_count, resolution[frame_size].width, resolution[frame_size].height), m_format(pixel_format)
{
    camera_config_t camera_config = {};
    camera_config.pin_pwdn = -1;
    camera_config.pin_reset = BSP_CAMERA_RST;
    camera_config.pin_xclk = BSP_CAMERA_GPIO_XCLK;
    camera_config.pin_sccb_sda = BSP_I2C_SDA;
    camera_config.pin_sccb_scl = BSP_I2C_SCL;
    camera_config.pin_d7 = BSP_CAMERA_D7;
    camera_config.pin_d6 = BSP_CAMERA_D6;
    camera_config.pin_d5 = BSP_CAMERA_D5;
    camera_config.pin_d4 = BSP_CAMERA_D4;
    camera_config.pin_d3 = BSP_CAMERA_D3;
    camera_config.pin_d2 = BSP_CAMERA_D2;
    camera_config.pin_d1 = BSP_CAMERA_D1;
    camera_config.pin_d0 = BSP_CAMERA_D0;
    camera_config.pin_vsync = BSP_CAMERA_VSYNC;
    camera_config.pin_href = BSP_CAMERA_HSYNC;
    camera_config.pin_pclk = BSP_CAMERA_PCLK;
    camera_config.xclk_freq_hz = BSP_CAMERA_XCLK_CLOCK_MHZ * 1000000;
    camera_config.ledc_timer = LEDC_TIMER_1;
    camera_config.ledc_channel = LEDC_CHANNEL_1;
    camera_config.pixel_format = pixel_format;
    camera_config.frame_size = frame_size;
    camera_config.jpeg_quality = 12;
    camera_config.fb_count = fb_count;
    camera_config.fb_location = CAMERA_FB_IN_PSRAM;
    camera_config.grab_mode = CAMERA_GRAB_LATEST;
    if (pixel_format == PIXFORMAT_JPEG) {
        camera_config.xclk_freq_hz = 20000000;
    }
    ESP_ERROR_CHECK(esp_camera_init(&camera_config));
    ESP_ERROR_CHECK(esp_camera_set_psram_mode(true));
    ESP_ERROR_CHECK(set_flip(!vertical_flip, !horizontal_flip));
}

WhoS3Cam::~WhoS3Cam()
{
    ESP_ERROR_CHECK(esp_camera_deinit());
}

cam_fb_t *WhoS3Cam::cam_fb_get()
{
    camera_fb_t *fb = esp_camera_fb_get();
    int i = get_cam_fb_index();
    m_cam_fbs[i] = cam_fb_t(*fb);
    return &m_cam_fbs[i];
}

void WhoS3Cam::cam_fb_return(cam_fb_t *fb)
{
    esp_camera_fb_return((camera_fb_t *)fb->ret);
}

esp_err_t WhoS3Cam::set_flip(bool vertical_flip, bool horizontal_flip)
{
    if (!vertical_flip & !horizontal_flip) {
        return ESP_OK;
    }
    sensor_t *s = esp_camera_sensor_get();
    if (vertical_flip) {
        if (s->set_vflip(s, 1) != 0) {
            ESP_LOGE(TAG, "Failed to mirror the frame vertically.");
            return ESP_FAIL;
        }
    }
    if (horizontal_flip) {
        if (s->set_hmirror(s, 1) != 0) {
            ESP_LOGE(TAG, "Failed to mirror the frame horizontally.");
            return ESP_FAIL;
        }
    }
    return ESP_OK;
}

int WhoS3Cam::get_cam_fb_index()
{
    static int i = 0;
    int index = i;
    i = (i + 1) % m_fb_count;
    return index;
}

} // namespace cam
} // namespace who
