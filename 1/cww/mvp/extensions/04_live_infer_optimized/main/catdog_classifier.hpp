#pragma once

#include <array>
#include "dl_cls_base.hpp"
#include "dl_cls_postprocessor.hpp"
#include "dl_image_preprocessor.hpp"
#include "dl_model_base.hpp"
#include "labels.hpp"

class CatDogPostprocessor : public dl::cls::ClsPostprocessor {
public:
    CatDogPostprocessor(dl::Model *model) : dl::cls::ClsPostprocessor(model, 2, 0.0f, true, "")
    {
        m_cat_names = kCatDogLabels;
    }
};

class CatDogClassifier : public dl::cls::ClsImpl {
public:
    CatDogClassifier(const char *model_path)
    {
        static const std::array<float, 3> mean = {0.485f * 255.0f, 0.456f * 255.0f, 0.406f * 255.0f};
        static const std::array<float, 3> std = {0.229f * 255.0f, 0.224f * 255.0f, 0.225f * 255.0f};
        m_model = new dl::Model(model_path, fbs::MODEL_LOCATION_IN_FLASH_RODATA);
        if (m_model->get_inputs().empty() || m_model->get_outputs().empty()) {
            return;
        }
        m_model->minimize();
        m_image_preprocessor = new dl::image::ImagePreprocessor(m_model, mean, std);
        m_postprocessor = new CatDogPostprocessor(m_model);
        m_ready = true;
    }

    bool is_ready() const { return m_ready; }

private:
    bool m_ready = false;
};
