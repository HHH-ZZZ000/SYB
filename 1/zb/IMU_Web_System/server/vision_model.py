"""Local public pretrained quality baseline, not a project-trained classifier."""
import hashlib
import math
from pathlib import Path

MODEL_NAME = "OpenCV BRISQUE LIVE-R2 (public pretrained baseline)"
MODEL_VERSION = "opencv_contrib-4.10.0/live-r2/4c44c7eec9e5+a18427f4f7ad"
MODEL_FILES = {
    "brisque_model_live.yml": "4c44c7eec9e5139830c0bb0e4a044c9cd351ba5bbc9e3798beca3243e2782ff4",
    "brisque_range_live.yml": "a18427f4f7ad087524bd0d63389649a3899b51ca6d44a4d5f8d8171f1f914a9c",
}
MODEL_DIRECTORY = Path(__file__).parent / "models" / "brisque"
SCORE_SEMANTICS = "BRISQUE 失真分数（0–100，越低越好）；不是置信度、准确率或遮挡概率。"
LIMITATION = "公开预训练基线，未针对本项目训练或校准；仅作画质参考，不能确认遮挡、环境内容或实际用途是否满足。"


class ModelUnavailable(RuntimeError):
    pass


def predict(data, directory=MODEL_DIRECTORY):
    """Run the official trained SVR on actual pixels; never download at runtime."""
    try:
        import cv2
        import numpy as np
        for name, digest in MODEL_FILES.items():
            if hashlib.sha256((Path(directory) / name).read_bytes()).hexdigest() != digest:
                raise ModelUnavailable("model_checksum_mismatch")
    except (ImportError, OSError) as error:
        raise ModelUnavailable("model_unavailable") from error
    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("image_invalid")
    features = cv2.quality.QualityBRISQUE_computeFeatures(image)
    # Degenerate spatial statistics (e.g. uniform black) can produce NaN.
    # A clamped SVR value must not conceal an undefined feature vector.
    if not np.isfinite(features).all():
        return {"score": None, "reason": "undefined_features", "runtime": cv2.__version__}
    score = float(cv2.quality.QualityBRISQUE_compute(
        image, str(Path(directory) / "brisque_model_live.yml"),
        str(Path(directory) / "brisque_range_live.yml"))[0])
    return {"score": score if math.isfinite(score) else None,
            "reason": None if math.isfinite(score) else "undefined_score", "runtime": cv2.__version__}


def decide(raw, good_max, poor_min):
    """Application quality bands, NOT labels trained by the regression model."""
    score = raw["score"]
    if score is None or not 0 <= score <= 100:
        return "unknown", "unknown", raw.get("reason") or "out_of_range"
    if score <= good_max:
        return "quality_good", "accepted", "quality_band"
    if score >= poor_min:
        return "quality_poor", "accepted", "quality_band"
    return "unknown", "unknown", "uncalibrated_middle_band"
