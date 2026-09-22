#pragma once

#include <array>
#include <vector>

#include "dl_cls_base.hpp"
#include "dl_cls_postprocessor.hpp"
#include "dl_image_preprocessor.hpp"
#include "dl_model_base.hpp"
#include "labels.hpp"

class CatDogPostprocessor : public dl::cls::ClsPostprocessor {
public:
    CatDogPostprocessor(dl::Model *model, int topk = 2, float score_thr = 0.0f, bool need_softmax = true) :
        dl::cls::ClsPostprocessor(model, topk, score_thr, need_softmax, "")
    {
        m_cat_names = kCatDogLabels;
    }
};

class CatDogClassifier : public dl::cls::ClsImpl {
private:
    bool m_ready = false;

public:
    CatDogClassifier(const char *model_path,
                     fbs::model_location_type_t location = fbs::MODEL_LOCATION_IN_FLASH_RODATA,
                     int topk = 2,
                     float score_thr = 0.0f,
                     bool need_softmax = true)
    {
        static const std::array<float, 3> kMean = {0.485f * 255.0f, 0.456f * 255.0f, 0.406f * 255.0f};
        static const std::array<float, 3> kStd = {0.229f * 255.0f, 0.224f * 255.0f, 0.225f * 255.0f};
        m_model = new dl::Model(model_path, location);
        if (m_model->get_inputs().empty() || m_model->get_outputs().empty()) {
            ESP_LOGE("CatDogClassifier", "Model loaded but inputs/outputs are empty");
            return;
        }
        m_model->minimize();
        m_image_preprocessor = new dl::image::ImagePreprocessor(m_model, kMean, kStd);
        m_postprocessor = new CatDogPostprocessor(m_model, topk, score_thr, need_softmax);
        m_ready = true;
    }

    bool is_ready() const
    {
        return m_ready;
    }
};