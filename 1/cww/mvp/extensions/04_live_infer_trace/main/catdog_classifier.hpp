#pragma once

#include <array>
#include <vector>

#include "dl_cls_base.hpp"
#include "dl_cls_postprocessor.hpp"
#include "dl_image_preprocessor.hpp"
#include "dl_model_base.hpp"
#include "labels.hpp"
#include "trace_json.hpp"

#if PERFETTO_TRACE_JSON
#include "esp_timer.h"
#endif

class CatDogPostprocessor : public dl::cls::ClsPostprocessor {
public:
    explicit CatDogPostprocessor(dl::Model *model) :
        dl::cls::ClsPostprocessor(model, 2, 0.0f, true, "")
    {
        m_cat_names = kCatDogLabels;
    }
};

class CatDogClassifier : public dl::cls::ClsImpl {
    bool m_ready = false;

public:
    CatDogClassifier(const char *model_path,
                     fbs::model_location_type_t location = fbs::MODEL_LOCATION_IN_FLASH_RODATA)
    {
        static const std::array<float, 3> mean = {
            0.485f * 255.0f, 0.456f * 255.0f, 0.406f * 255.0f};
        static const std::array<float, 3> std = {
            0.229f * 255.0f, 0.224f * 255.0f, 0.225f * 255.0f};
        m_model = new dl::Model(model_path, location);
        if (m_model->get_inputs().empty() || m_model->get_outputs().empty()) {
            return;
        }
        m_model->minimize();
        m_image_preprocessor = new dl::image::ImagePreprocessor(m_model, mean, std);
        m_postprocessor = new CatDogPostprocessor(m_model);
        m_ready = true;
    }

    bool is_ready() const { return m_ready; }

    std::vector<dl::cls::result_t> &run(const dl::image::img_t &img,
                                        dl::runtime_mode_t mode = dl::RUNTIME_MODE_SINGLE_CORE) override
    {
#if PERFETTO_TRACE_JSON
        const int64_t preprocess_start_us = esp_timer_get_time();
        m_image_preprocessor->preprocess(img);
        const int64_t preprocess_end_us = esp_timer_get_time();

        const int64_t model_start_us = preprocess_end_us;
        m_model->run(mode);
        const int64_t model_end_us = esp_timer_get_time();

        const int64_t postprocess_start_us = model_end_us;
        std::vector<dl::cls::result_t> &result = m_postprocessor->postprocess();
        const int64_t postprocess_end_us = esp_timer_get_time();

        perfetto_trace::record_complete("preprocess", "vision",
                                        preprocess_start_us, preprocess_end_us,
                                        1, 11, xPortGetCoreID());
        perfetto_trace::record_complete("model_infer", "vision",
                                        model_start_us, model_end_us,
                                        1, 11, xPortGetCoreID());
        perfetto_trace::record_complete("postprocess", "vision",
                                        postprocess_start_us, postprocess_end_us,
                                        1, 11, xPortGetCoreID());
        return result;
#else
        return dl::cls::ClsImpl::run(img, mode);
#endif
    }
};
