import { verifyImageResult } from "./assistantTools.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LABELS = new Set(["quality_good", "quality_poor", "unknown"]);
function check(condition) { if (!condition) throw new Error("视觉结果与指定图片不匹配或格式无效"); }
export function verifyInference(result, image, requestId) {
  check(result && UUID.test(result.inference_id) && result.request_id === requestId &&
    result.image_record_id === image.id && result.image_task_id === image.task_id &&
    result.device === image.device && result.capture_time === image.capture_time && result.image_sha256 === image.sha256 &&
    typeof result.model_name === "string" && result.model_name.length > 0 &&
    typeof result.model_version === "string" && result.model_version.length > 0 &&
    Number.isFinite(result.inference_time) && result.inference_time >= image.received_at &&
    ["accepted", "unknown", "failed"].includes(result.status));
  if (result.status === "failed") check(result.label === null && result.score === null);
  else check(LABELS.has(result.label) && (result.score === null || (Number.isFinite(result.score) && result.score >= 0 && result.score <= 100)) &&
    (result.status === "unknown") === (result.label === "unknown") && result.rejected === (result.status === "unknown") &&
    (result.status !== "accepted" || result.score !== null));
  check(typeof result.message === "string" && typeof result.score_semantics === "string" && result.policy &&
    typeof result.reason === "string" && result.label_source === "application_quality_band_not_model_class");
  return result;
}

export async function analyze_image(api, image, requestId, onUpdate = () => {}) {
  if (!image) return { kind: "vision", status: "clarify", message: "请先拍摄一张图片，在图片下点击“分析这张图片”，或提供明确编号（例如“分析图片记录 2”）。不会自行选择历史图片。" };
  const base = { kind: "vision", device: image.device, requestId: image.task_id, imageRecordId: image.id,
    source: "公开预训练画质基线 · 本地推理" };
  try {
    // Revalidate the explicit record through the same Week 7 task verifier.
    const task = await api.fetchJson(`/api/task/${image.task_id}`);
    if (task?.request_id === image.task_id && task.device === image.device && task.action === "image_capture" &&
        task.result_image_id === image.id && task.image_status === "invalid")
      return { ...base, status: "error", code: "image_invalid", imageStatus: "invalid",
        message: "指定图片已损坏或不可解码，未执行视觉推理。不会使用其他图片代替。" };
    const verified = verifyImageResult(task, { requestId: image.task_id, device: image.device });
    check(verified.id === image.id && verified.capture_time === image.capture_time && verified.sha256 === image.sha256);
    onUpdate({ ...base, status: "waiting", phase: "inferring", message: "正在分析这张图片的画质…" });
    const response = await api.fetchJson("/api/vision/infer", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ request_id: requestId, image_record_id: image.id, image_task_id: image.task_id,
        device: image.device, capture_time: image.capture_time }),
    });
    const inference = verifyInference(response, verified, requestId);
    return { ...base, image: verified, inference, status: inference.status === "failed" ? "error" : "success",
      message: `${inference.message}\n${inference.score_semantics}` };
  } catch (error) {
    if (error.code === "image_invalid") return { ...base, status: "error", code: "image_invalid", imageStatus: "invalid",
      message: "指定图片已损坏或不可解码，未取得有效推理结果。不会使用其他图片代替。" };
    return { ...base, status: "error", message: `视觉分析未取得可确认结果${error.status ? `（HTTP ${error.status}）` : "，可能超时、图片不可用或结果关联异常"}。不会使用其他图片或旧预测代替。` };
  }
}

export async function explicit_image(api, id, device) {
  check(Number.isSafeInteger(id) && id > 0);
  const task = await api.fetchJson(`/api/vision/images/${id}`);
  // Keep the exact damaged record as event evidence, never as a valid image.
  // analyze_image will recheck this same task and will not call the model.
  if (task.device === device && UUID.test(task.request_id) && task.action === "image_capture" &&
      task.status === "SUCCESS" && task.image_status === "invalid" && task.result_image_id === id &&
      task.result?.id === id && task.result.task_id === task.request_id && task.result.device === device)
    return task.result;
  const image = verifyImageResult(task, { requestId: task.request_id, device });
  check(image.id === id);
  return image;
}

export async function save_feedback(api, feedback) {
  const result = await api.fetchJson("/api/vision/feedback", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(feedback) });
  check(UUID.test(result.feedback_id) && result.inference_id === feedback.inference_id && result.kind === feedback.kind);
  if (feedback.kind === "correction") check(result.corrected_label === feedback.corrected_label);
  else check(result.new_task_id === feedback.new_task_id && result.request_id === feedback.request_id);
  return result;
}
