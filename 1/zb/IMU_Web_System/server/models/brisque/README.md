# Public pretrained baseline

Official OpenCV BRISQUE SVR, trained on LIVE-R2. Source release: **opencv_contrib 4.10.0**.
This is a quality regression model, not an occlusion classifier; it has no class-confidence output.

- [Model](https://github.com/opencv/opencv_contrib/blob/4.10.0/modules/quality/samples/brisque_model_live.yml)
- [Feature range](https://github.com/opencv/opencv_contrib/blob/4.10.0/modules/quality/samples/brisque_range_live.yml)
- [Official implementation](https://github.com/opencv/opencv_contrib/blob/4.10.0/modules/quality/src/qualitybrisque.cpp)
- [Documentation](https://docs.opencv.org/4.10.0/d8/d99/classcv_1_1quality_1_1QualityBRISQUE.html)

The two small official files are included, with the upstream Apache-2.0 LICENSE.
SHA-256 is checked in `server/vision_model.py` before every inference; no silent replacement or download.
No training or calibration on this project's camera has been performed.
