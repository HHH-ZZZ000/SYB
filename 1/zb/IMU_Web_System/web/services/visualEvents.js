const KEY = "imu-visual-events-v1";
export const DEFAULT_VISUAL_COOLDOWN_MS = 120000;
export const VISUAL_EVENT_PRIORITY = ["device_unavailable", "capture_failed", "image_invalid", "visual_uncertain"];

// Only structured execution evidence is classified; no keyword guesses from answers.
export function visualEventOf(result) {
  if (!["image", "vision"].includes(result?.kind)) return null;
  if (["device_offline", "device_unresponsive"].includes(result.code) ||
      result.imageStatus === "unavailable" || result.deviceError === "camera_unavailable")
    return { event_type: "device_unavailable", category: "device", question: null };
  if (["FAILED", "TIMEOUT"].includes(result.taskStatus))
    return { event_type: "capture_failed", category: "device", question: "本次拍摄失败，是否重新拍摄一张？" };
  if (result.code === "image_invalid" || result.imageStatus === "invalid")
    return { event_type: "image_invalid", category: "device", question: "当前图片不可用，是否重新拍摄一张？" };
  if (result.inference?.status === "unknown")
    return { event_type: "visual_uncertain", category: "model", question: "当前画面无法可靠判断，是否重新拍摄一张？" };
  return null;
}

export class VisualEventLog {
  constructor(storage, { now = () => Date.now(), cooldownMs } = {}) {
    this.storage = storage; this.now = now; this.records = []; this.cooldowns = new Map();
    this.cooldownMs = DEFAULT_VISUAL_COOLDOWN_MS;
    try {
      const saved = JSON.parse(storage?.getItem(KEY) || "null");
      if (saved) {
        this.records = Array.isArray(saved.events) ? saved.events.filter(e =>
          typeof e.event_id === "string" && VISUAL_EVENT_PRIORITY.includes(e.event_type)).slice(-100) : [];
        this.cooldowns = new Map((Array.isArray(saved.cooldowns) ? saved.cooldowns : []).filter(pair =>
          Array.isArray(pair) && typeof pair[0] === "string" && Number.isFinite(pair[1]) && pair[1] > now()).slice(-100));
        this.setCooldown(saved.cooldown_ms, false);
      }
    } catch { /* Optional tab storage cannot block task processing. */ }
    if (cooldownMs !== undefined) this.setCooldown(cooldownMs);
  }
  setCooldown(ms, save = true) {
    if (!Number.isInteger(ms) || ms < 1000 || ms > 3600000) throw new Error("冷却时间须为 1–3600 秒。");
    this.cooldownMs = ms;
    if (save) this.persist();
  }
  key(event) { return `${event.device_id}|${event.event_type}`; }
  cooldownUntil(event) { return this.cooldowns.get(this.key(event)) || null; }
  append(event) {
    this.records.push(event); if (this.records.length > 100) this.records.shift();
    this.persist(); return event;
  }
  decide(event, decision, status = decision) {
    event.decision = decision; event.status = status;
    event.decision_time = this.now(); event.decision_category = "interaction";
    if (status === "ignored") {
      event.cooldown_until = event.decision_time + this.cooldownMs;
      this.cooldowns.set(this.key(event), event.cooldown_until);
      if (this.cooldowns.size > 100) this.cooldowns.delete(this.cooldowns.keys().next().value);
    }
    this.persist();
  }
  persist() {
    try { this.storage?.setItem(KEY, JSON.stringify({ cooldown_ms: this.cooldownMs,
      events: this.records, cooldowns: [...this.cooldowns] })); } catch { /* Memory log stays available. */ }
  }
}
