#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "bsp/esp-bsp.h"
#include "catdog_classifier.hpp"
#include "dl_image_jpeg.hpp"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "catdog_static_infer";
static constexpr char kModelPath[] = "/sdcard/models/s3/catdog_mobilenet_v2.espdl";
static constexpr char kImagePath[] = "/sdcard/images/sample.jpg";

static bool read_file(const char *path, uint8_t **data, size_t *size)
{
    FILE *file = fopen(path, "rb");
    if (!file) {
        ESP_LOGE(TAG, "cannot open image: %s", path);
        return false;
    }
    if (fseek(file, 0, SEEK_END) != 0) {
        fclose(file);
        return false;
    }
    long length = ftell(file);
    rewind(file);
    if (length <= 0) {
        fclose(file);
        return false;
    }
    auto *buffer = static_cast<uint8_t *>(heap_caps_malloc(length, MALLOC_CAP_SPIRAM));
    if (!buffer || fread(buffer, 1, length, file) != static_cast<size_t>(length)) {
        heap_caps_free(buffer);
        fclose(file);
        return false;
    }
    fclose(file);
    *data = buffer;
    *size = static_cast<size_t>(length);
    return true;
}

extern "C" void app_main(void)
{
    esp_err_t ret = bsp_sdcard_mount();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "SD card mount failed: %s", esp_err_to_name(ret));
        return;
    }
    ESP_LOGI(TAG, "SD card mounted at /sdcard");

    CatDogClassifier classifier(kModelPath, fbs::MODEL_LOCATION_IN_SDCARD);
    if (!classifier.is_ready()) {
        ESP_LOGE(TAG, "cat/dog model load failed: %s", kModelPath);
        bsp_sdcard_unmount();
        return;
    }

    uint8_t *jpeg_data = nullptr;
    size_t jpeg_size = 0;
    if (!read_file(kImagePath, &jpeg_data, &jpeg_size)) {
        ESP_LOGE(TAG, "image read failed: %s", kImagePath);
        bsp_sdcard_unmount();
        return;
    }

    int64_t decode_start = esp_timer_get_time();
    dl::image::jpeg_img_t jpeg = {
        .data = jpeg_data,
        .data_len = jpeg_size,
    };
    auto image = dl::image::sw_decode_jpeg(
        jpeg, dl::image::DL_IMAGE_PIX_TYPE_RGB888);
    int64_t decode_us = esp_timer_get_time() - decode_start;
    heap_caps_free(jpeg_data);
    if (!image.data) {
        ESP_LOGE(TAG, "JPEG decode failed");
        bsp_sdcard_unmount();
        return;
    }
    ESP_LOGI(TAG, "decoded %s: %d x %d in %lld us",
             kImagePath, image.width, image.height, decode_us);

    int64_t infer_start = esp_timer_get_time();
    auto &results = classifier.run(image);
    int64_t infer_us = esp_timer_get_time() - infer_start;
    if (results.empty()) {
        ESP_LOGE(TAG, "classifier returned no result");
    } else {
        const auto &top1 = results.front();
        ESP_LOGI(TAG, "top1=%s score=%.6f infer=%lld us",
                 top1.cat_name, top1.score, infer_us);
    }

    heap_caps_free(image.data);
    bsp_sdcard_unmount();
}
