/**
 * @typedef {Object} Device
 * @property {string} id
 * @property {string} name
 * @property {'online'|'offline'|'unknown'} status
 * @property {number|null} lastUpdate Server receipt time in milliseconds.
 * @property {{x:number|null,y:number|null,z:number|null}} acceleration In g.
 * @property {'device_offline'|'on_demand'|'streaming'|'camera_unavailable'|'capture_failed'|'unknown'} cameraStatus
 * @property {number|null} sampleCount
 */
export const DEFAULT_DEVICE = "ESP32_S3_EYE";
export const AXES = ["acc_x", "acc_y", "acc_z"];
export const AXIS_LABELS = ["第一轴 X", "第二轴 Y", "第三轴 Z"];
export const COLORS = ["#18745b", "#b57024", "#527d9d"];
export const finite = (value) => (Number.isFinite(value) ? value : null);
export const cameraLabel = (state) => ({ device_offline: "设备离线", on_demand: "按需拍摄模式",
  streaming: "实时预览中", camera_unavailable: "摄像头不可用", capture_failed: "上次拍摄失败",
  unknown: "摄像头状态待确认" })[state] || "摄像头状态待确认";
export function validSample(sample) {
  return (
    Number.isSafeInteger(sample?.id) &&
    Number.isFinite(sample.received_at_ms) &&
    AXES.every((axis) => Number.isFinite(sample[axis]))
  );
}
export function toDevice(raw = {}, now = Date.now(), unavailable = false) {
  const id = raw.device || DEFAULT_DEVICE;
  const lastUpdate = finite(raw.received_at_ms);
  const fresh = lastUpdate !== null && now - lastUpdate <= (raw.offline_after_seconds || 10) * 1000;
  const cameraFresh =
    Number.isFinite(raw.camera?.last_frame_at_ms) && now - raw.camera.last_frame_at_ms <= 5000;
  return {
    id,
    name: id === DEFAULT_DEVICE ? "ESP32-S3-EYE" : id,
    status: unavailable ? "unknown" : fresh ? "online" : "offline",
    lastUpdate,
    acceleration: { x: finite(raw.acc_x), y: finite(raw.acc_y), z: finite(raw.acc_z) },
    cameraStatus:
      unavailable ? "unknown" : !fresh ? "device_offline"
        : cameraFresh && raw.camera?.status === "online" ? "streaming"
        : ["on_demand", "camera_unavailable", "capture_failed"].includes(raw.camera?.mode)
          ? raw.camera.mode : "unknown",
    sampleCount: finite(raw.total_samples),
    sensor: raw.sensor || "QMA6100P",
    timestamp: raw.timestamp || null,
    camera: raw.camera || null,
  };
}
export function mergeSamples(current, incoming, maximum = 2000) {
  const unique = new Map(current.map((item) => [item.id, item]));
  incoming.filter(validSample).forEach((item) => unique.set(item.id, item));
  return [...unique.values()]
    .sort((a, b) => a.received_at_ms - b.received_at_ms || a.id - b.id)
    .slice(-maximum);
}
export function windowSamples(samples, end, seconds = 20) {
  return samples.filter(
    (sample) => sample.received_at_ms >= end - seconds * 1000 && sample.received_at_ms <= end,
  );
}
