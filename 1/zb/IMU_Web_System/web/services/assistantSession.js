import { query_existing_data, collect_new_data, wait_for_collection } from "./assistantTools.js";
import { analyze_image, explicit_image, save_feedback } from "./visionTools.js";
import { VisualEventLog, visualEventOf } from "./visualEvents.js";

const CANCEL = /^(取消|算了|停止这个任务|取消当前任务|不用了|停止)[。！!\s]*$/;
const STOP_SPEECH = /^停止播报[。！!\s]*$/;
const VISUAL_CONFIRM = /^(重拍|是|确认|好的?|重新拍(?:摄)?(?:一张)?|重新拍一张照片)[。！!\s]*$/;
const VISUAL_IGNORE = /^(不用|不用了|忽略|算了|不拍了|不需要|不要|否)[。！!\s]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const aborted = () => Object.assign(new Error("Request no longer current"), { name: "AbortError" });
function interactionId() {
  // randomUUID is secure-context-only; keep text entry working on LAN HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Stop awaiting even if a transport cannot abort. Its eventual value is never
// allowed back into the interaction; a late POST ID is retained for audit only.
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(aborted());
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

// One conversation survives route changes. Only one interaction owns results.
export class AssistantSession {
  constructor(api, storage, visualOptions = {}) {
    this.api = api;
    if (storage === undefined) {
      try { storage = globalThis.sessionStorage; } catch { storage = null; }
    }
    this.storage = storage;
    this.visualEvents = new VisualEventLog(storage, visualOptions);
    this.awaitingVisualEvent = null;
    this.context = { device: null, pending: null };
    this.shortContext = null;
    this.messages = [];
    this.devices = [];
    this.listeners = new Set();
    this.requests = new Map();
    this.events = []; // Bounded metadata only: no user text, samples or secrets.
    this.currentRequestId = null;
    this.state = "idle";
    this.busy = false;
    this.pendingTask = null;
    this.lastTask = null;
    this.imageContext = null; // Only an explicitly displayed, verified result; never a database "latest image".
    this.voice = null;
    this.autoSpeak = () => false;
    try {
      const saved = JSON.parse(storage?.getItem("imu-assistant-task") || "null");
      if (UUID.test(saved?.requestId || "") && /^[A-Za-z0-9_-]{1,64}$/.test(saved?.device || "") &&
          Number.isSafeInteger(saved.baselineId) && saved.baselineId >= 0) {
        this.pendingTask = saved;
        this.lastTask = saved;
        this.context.device = saved.device;
      }
    } catch { /* Optional storage must never block real requests. */ }
  }
  subscribe(listener) { this.listeners.add(listener); listener(this); return () => this.listeners.delete(listener); }
  emit() { this.listeners.forEach((fn) => fn(this)); }
  audit(event, request) {
    this.events.push({ event, category: "interaction", request_id: request?.request_id ?? null, task_id: request?.task_id ?? null,
      state: request?.status ?? this.state, cancelled: !!request?.cancelled, stale: !!request?.stale });
    if (this.events.length > 30) this.events.shift();
  }
  isCurrent(request) {
    return request?.request_id === this.currentRequestId && !request.cancelled && !request.stale;
  }
  attachVoice(voice, autoSpeak = () => true) {
    this.voice = voice; this.autoSpeak = autoSpeak;
    return () => { if (this.voice === voice) this.voice = null; };
  }
  syncSpeech() {
    const request = this.requests.get(this.currentRequestId);
    if (!this.isCurrent(request) || this.busy) return;
    const speaking = this.voice?.utteranceRequestId === this.currentRequestId &&
      ["generating", "playing"].includes(this.voice.outputState);
    const next = speaking ? "speaking" : ["clarifying", "awaiting_confirmation"].includes(request.status) ? request.status : "idle";
    if (this.state !== next) { this.state = next; this.emit(); }
  }
  stopSpeaking() {
    this.voice?.stopSpeaking();
    this.syncSpeech();
    this.audit("tts stopped", this.requests.get(this.currentRequestId));
  }
  speakCurrent() {
    const request = this.requests.get(this.currentRequestId);
    if (!this.isCurrent(request) || this.busy || !request.answer || request.answer.status === "waiting") return;
    const question = this.awaitingVisualEvent?.request_id === request.request_id ? this.awaitingVisualEvent.question : null;
    this.voice?.speak([request.answer.message, question].filter(Boolean).join("\n"), request.request_id, () => this.isCurrent(request));
    this.syncSpeech();
  }
  chooseDevice(device) {
    if (this.awaitingVisualEvent && this.awaitingVisualEvent.device_id !== device) {
      this.invalidate(this.requests.get(this.currentRequestId), false);
      this.state = "idle"; this.stopSpeaking();
    }
    if (this.imageContext?.device !== device) this.imageContext = null;
    this.context.device = device || null;
    if (this.shortContext) this.shortContext.device = this.context.device;
    this.emit();
  }
  clearContext() { this.context.pending = null; this.shortContext = null; }
  rememberTask(task) {
    // requestId here is the legacy backend task identifier, never an interaction ID.
    this.pendingTask = task;
    if (task) this.lastTask = task;
    try {
      if (task) this.storage?.setItem("imu-assistant-task", JSON.stringify(task));
      else this.storage?.removeItem("imu-assistant-task");
    } catch { /* Visible task IDs remain available without storage. */ }
  }
  async loadDevices() {
    try {
      const response = await this.api.devices();
      this.devices = response.devices.map((d) => ({ id: d.device, name: d.device === "ESP32_S3_EYE" ? "ESP32-S3-EYE" : d.device }));
      this.inventoryError = false;
    } catch { this.inventoryError = true; }
    this.emit();
  }
  invalidate(request, cancelled) {
    if (!request) return;
    if (this.awaitingVisualEvent?.request_id === request.request_id) {
      this.visualEvents.decide(this.awaitingVisualEvent, cancelled ? "cancelled" : "superseded");
      this.awaitingVisualEvent = null;
    }
    request.cancelled = cancelled;
    request.stale = !cancelled;
    request.status = cancelled ? "cancelled" : "stale";
    request.controller.abort();
    if (request.answer && (cancelled || request.answer.status === "waiting")) Object.assign(request.answer, {
      status: request.status,
      message: `${cancelled ? "当前助手请求已取消" : "此请求已被新请求替代"}，后续结果不会再影响当前对话。${request.taskSubmitted || request.task_id ? "后端不支持取消接口，设备任务仍可能执行并保存数据。" : ""}`,
    });
    this.audit(cancelled ? "request cancelled" : "request superseded", request);
  }
  cancel() {
    this.invalidate(this.requests.get(this.currentRequestId), true);
    this.currentRequestId = null;
    this.busy = false;
    this.state = "cancelled";
    this.clearContext();
    this.rememberTask(null); // A cancelled request must not auto-resume on reload.
    this.lastTask = null;
    this.stopSpeaking();
    this.emit();
  }
  begin(text, continuationContext = null) {
    const previous = this.requests.get(this.currentRequestId);
    if (previous && (this.busy || this.state === "clarifying" || this.pendingTask || this.awaitingVisualEvent)) this.invalidate(previous, false);
    this.stopSpeaking();
    this.rememberTask(null);
    this.clearContext();
    const request = { request_id: interactionId(), text, status: "executing", created_at: Date.now(),
      cancelled: false, stale: false, task_id: null, controller: new AbortController(),
      context_from: continuationContext?.request_id ?? null };
    this.requests.set(request.request_id, request);
    if (this.requests.size > 20) this.requests.delete(this.requests.keys().next().value);
    this.currentRequestId = request.request_id;
    if (continuationContext?.visual_event) {
      request.confirmedVisualEvent = continuationContext.visual_event;
      request.confirmedVisualEvent.decision_request_id = request.request_id;
      this.visualEvents.persist();
    }
    this.busy = true; this.state = "executing";
    this.messages.push({ role: "user", message: text, request_id: request.request_id });
    request.answer = { role: "assistant", status: "waiting", message: "正在理解请求…", request_id: request.request_id };
    this.messages.push(request.answer);
    this.audit("request created", request);
    this.emit();
    return request;
  }
  scopedApi(request) {
    const session = this;
    return {
      devices() { return this.fetchJson("/api/devices"); },
      async fetchJson(path, options = {}) {
        if (!session.isCurrent(request)) throw aborted();
        const controller = new AbortController();
        const abort = () => controller.abort();
        const signals = [request.controller.signal, options.signal].filter(Boolean);
        for (const signal of signals) {
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }
        if (path === "/api/task/create") request.taskSubmitted = true;
        try {
          const pending = session.api.fetchJson(path, { ...options, signal: controller.signal }, false).then((result) => {
            if (path === "/api/task/create" && UUID.test(result?.request_id || "")) {
              request.task_id = result.request_id;
              session.audit("task linked", request);
            }
            if (!session.isCurrent(request)) {
              if (!request.loggedStale) { request.loggedStale = true; session.audit("stale result ignored", request); }
              throw aborted();
            }
            return result;
          });
          return await abortable(pending, controller.signal);
        } finally {
          for (const signal of signals) signal.removeEventListener("abort", abort);
        }
      },
    };
  }
  wait(request, ms) {
    let timer;
    const delay = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
    return abortable(delay, request.controller.signal).finally(() => clearTimeout(timer));
  }
  apply(request, result) {
    // Stamp transport results at the boundary; backend request_id names a task.
    const { requestId: task_id, ...body } = result;
    const response = { ...body, request_id: request.request_id, ...(task_id ? { task_id } : {}) };
    if (response.request_id !== this.currentRequestId || !this.isCurrent(request)) return;
    Object.assign(request.answer, response);
    if (task_id) request.task_id = task_id;
    request.status = result.visual_event?.status === "awaiting_confirmation" ? "awaiting_confirmation"
      : result.status === "waiting" ? "waiting" : result.status === "clarify" ? "clarifying" : result.status;
    this.state = ["waiting", "clarifying", "awaiting_confirmation"].includes(request.status) ? request.status : "idle";
    this.emit();
  }
  finish(request) {
    if (!this.isCurrent(request)) return;
    this.busy = false;
    if (request.status !== "clarifying") this.clearContext();
    this.state = ["clarifying", "awaiting_confirmation"].includes(request.status) ? request.status : "idle";
    this.emit();
    if (this.autoSpeak() && !request.suppressAutoSpeak) this.speakCurrent();
  }
  async visualResult(request, result) {
    const candidate = visualEventOf(result);
    if (!candidate || !this.isCurrent(request) || request.visualEvent) return result;
    let evidence = candidate;
    let availability = null;
    if (candidate.question) {
      try {
        availability = await this.scopedApi(request).fetchJson(`/api/status?device=${encodeURIComponent(result.device)}`);
        if (availability.device !== result.device || !["online", "offline"].includes(availability.status)) throw new Error("Invalid device status");
        if (availability.status === "offline" || availability.camera?.mode === "camera_unavailable")
          evidence = { event_type: "device_unavailable", category: "device", question: null };
        else if (availability.camera?.mode === "capture_failed" && candidate.event_type === "visual_uncertain" &&
            Number.isFinite(availability.camera.last_capture?.finished_at) &&
            availability.camera.last_capture.finished_at >= result.image.capture_time)
          evidence = { event_type: "capture_failed", category: "device", question: "最近拍摄任务失败，是否重新拍摄一张？" };
      } catch {
        if (!this.isCurrent(request)) return result;
        availability = null; // A failed status read is not evidence of an offline device.
      }
    }
    if (!this.isCurrent(request)) return result;
    const event = { event_id: interactionId(), request_id: request.request_id,
      inference_id: result.inference?.inference_id || null,
      image_record_id: result.image?.id || result.imageRecordId || null,
      image_task_id: result.image?.task_id || result.requestId || request.task_id || null,
      device_id: result.device, event_type: evidence.event_type, category: evidence.category,
      event_time: this.visualEvents.now(), status: "recorded", question: evidence.question,
      decision: null, decision_time: null, cooldown_until: null };
    if (evidence.event_type !== candidate.event_type && availability?.camera?.last_capture)
      event.device_evidence_task_id = availability.camera.last_capture.request_id;
    if (evidence.question) {
      event.cooldown_until = this.visualEvents.cooldownUntil(event);
      if (event.cooldown_until > event.event_time) {
        event.status = "suppressed"; event.reason = "cooldown"; request.suppressAutoSpeak = true;
      } else if (!availability || result.resumable) {
        event.status = "deferred"; event.reason = result.resumable ? "task_still_pending" : "device_status_unconfirmed";
      } else {
        event.status = "awaiting_confirmation"; this.awaitingVisualEvent = event;
      }
    }
    request.visualEvent = this.visualEvents.append(event);
    if (evidence.event_type === "device_unavailable" && candidate.event_type !== "device_unavailable")
      result = { ...result, status: "error", message: availability.status === "offline"
        ? "设备当前离线，暂时无法重新拍摄。原图片和推理记录仍保留。"
        : "最近设备回执显示摄像头不可用，暂时无法重新拍摄。原图片和推理记录仍保留。" };
    else if (evidence.event_type === "capture_failed" && candidate.event_type === "visual_uncertain")
      result = { ...result, status: "error", message: "最近拍摄任务执行失败。原图片的未知结果仍保留，当前优先反馈设备拍摄问题。" };
    if (event.status === "suppressed" && candidate.event_type === "visual_uncertain")
      result = { ...result, message: `本次视觉结果仍为未知 / 拒识；同类提示处于冷却中，本次不再询问。\n${result.inference.score_semantics}` };
    return { ...result, visual_event: event };
  }
  async decideVisual(event, decision, text) {
    const owner = this.requests.get(event.request_id);
    if (event !== this.awaitingVisualEvent || event.status !== "awaiting_confirmation" || !this.isCurrent(owner) || this.busy) return;
    this.visualEvents.decide(event, decision);
    this.awaitingVisualEvent = null; owner.status = owner.answer.status; this.state = "idle";
    this.stopSpeaking();
    if (decision === "ignored") {
      this.messages.push({ role: "user", message: text, request_id: owner.request_id });
      this.emit(); return; // No task call and no automatic reply/speech after refusal.
    }
    return this.send("看看当前画面是否可用", { device: event.device_id,
      ...(event.inference_id ? { retakeFrom: event.inference_id } : {}), confirmedVisualEvent: event });
  }
  async send(message, target = {}) {
    const text = message.trim();
    if (!text) return;
    if (STOP_SPEECH.test(text)) { this.stopSpeaking(); return; }
    if (target.visualEventId && target.visualEventId !== this.awaitingVisualEvent?.event_id) return;
    if (this.awaitingVisualEvent && VISUAL_CONFIRM.test(text)) return this.decideVisual(this.awaitingVisualEvent, "confirmed", text);
    if (this.awaitingVisualEvent && VISUAL_IGNORE.test(text)) return this.decideVisual(this.awaitingVisualEvent, "ignored", text);
    if (this.busy && VISUAL_CONFIRM.test(text) && this.requests.get(this.currentRequestId)?.confirmedVisualEvent) return;
    if (CANCEL.test(text)) { this.cancel(); return; }
    // Keep only the prior unfinished parameter set. The existing parser decides
    // whether this turn supplements it or explicitly starts a different action.
    const prior = this.shortContext;
    const context = { device: target.image?.device || target.device || this.context.device, pending: prior?.pending ?? null };
    const request = this.begin(text, target.confirmedVisualEvent ? { visual_event: target.confirmedVisualEvent } : prior);
    const api = this.scopedApi(request);
    try {
      const parsed = await api.fetchJson("/api/assistant/interpret", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text, context }),
      });
      if (!this.isCurrent(request)) return;
      this.context = parsed.context;
      this.devices = parsed.devices;
      if (parsed.status !== "ready") {
        if (parsed.status === "clarify" && parsed.context?.pending) this.shortContext = {
          request_id: request.request_id, pending: parsed.context.pending, device: parsed.context.device,
          missing: parsed.context.device ? ["parameters"] : ["device"],
        };
        this.apply(request, { status: parsed.status, message: parsed.message });
        return;
      }
      this.clearContext();
      let result;
      const analyzing = parsed.intent === "vision_analyze";
      if (parsed.intent === "query_existing") {
        result = await query_existing_data(api, parsed.parameters, { lastTask: this.lastTask });
      } else if (analyzing && parsed.parameters.mode === "image_existing") {
        const image = parsed.parameters.image_record_id
          ? await explicit_image(api, parsed.parameters.image_record_id, parsed.parameters.device)
          : target.image || this.imageContext;
        result = await analyze_image(api, image?.device === parsed.parameters.device ? image : null,
          request.request_id, (progress) => this.apply(request, progress));
      } else if (parsed.intent === "collect_new" || parsed.intent === "image_capture" || analyzing) {
        if (parsed.intent === "image_capture" || analyzing) this.imageContext = null;
        const parameters = analyzing ? { ...parsed.parameters, intent: "image_capture", mode: "latest" } : parsed.parameters;
        result = await collect_new_data(api, parameters, {
          interactionRequestId: request.request_id,
          sleep: (ms) => this.wait(request, ms),
          onCreated: async (task) => {
            if (!this.isCurrent(request)) return;
            request.task_id = task.requestId;
            request.answer.task_id = task.requestId;
            if (analyzing) task.analyzeAfterCapture = true;
            if (target.retakeFrom) task.retakeFrom = target.retakeFrom;
            this.rememberTask(task); this.emit();
            if (request.confirmedVisualEvent) {
              request.confirmedVisualEvent.new_task_id = task.requestId; this.visualEvents.persist();
            }
            if (target.retakeFrom) await save_feedback(api, { kind: "retake", inference_id: target.retakeFrom,
              request_id: request.request_id, new_task_id: task.requestId });
          },
          onUpdate: (progress) => this.apply(request, progress),
        });
        if (!this.isCurrent(request)) return;
        if (!result.resumable) this.rememberTask(null);
        if (analyzing && result.status === "success" && result.image)
          result = await analyze_image(api, result.image, request.request_id, (progress) => this.apply(request, progress));
      } else { throw new Error("Unsupported intent"); }
      if (this.isCurrent(request) && result.status === "success" && result.image) this.imageContext = result.image;
      result = await this.visualResult(request, result);
      this.apply(request, result);
    } catch (error) {
      this.apply(request, { status: "error", message: `请求接口失败${error.status ? `（HTTP ${error.status}）` : "或连接中断"}，未取得可确认的结果。` });
    } finally { this.finish(request); }
  }
  async resume() {
    if (!this.pendingTask) return;
    const task = this.pendingTask;
    const request = this.begin("继续查询本次任务");
    request.task_id = task.requestId;
    this.rememberTask(task);
    this.apply(request, { status: "waiting", kind: task.action === "image_capture" ? "image" : "new", requestId: task.requestId, message: "继续查询同一采集任务，不会创建新任务。" });
    try {
      const api = this.scopedApi(request);
      if (task.retakeFrom) {
        try {
          // Use the original capture interaction, not this new resume interaction.
          // The backend makes repeated saves for the same image task idempotent.
          await save_feedback(api, { kind: "retake", inference_id: task.retakeFrom,
            request_id: task.interactionRequestId, new_task_id: task.requestId });
        } catch (error) {
          this.apply(request, { status: "error", kind: "image", requestId: task.requestId, resumable: true,
            message: `图像任务已创建，但重拍关联保存未确认${error.status ? `（HTTP ${error.status}）` : ""}。可继续查询同一任务并重试，不会重复拍摄。` });
          return;
        }
      }
      let result = await wait_for_collection(api, task, {
        sleep: (ms) => this.wait(request, ms), onUpdate: (progress) => this.apply(request, progress),
      });
      if (!this.isCurrent(request)) return;
      if (task.analyzeAfterCapture && result.status === "success" && result.image)
        result = await analyze_image(api, result.image, request.request_id, (progress) => this.apply(request, progress));
      if (this.isCurrent(request) && result.status === "success" && result.image) this.imageContext = result.image;
      result = await this.visualResult(request, result);
      this.apply(request, result);
      if (!result.resumable) this.rememberTask(null);
    } finally { this.finish(request); }
  }
  async correct(message, label) {
    if (!this.messages.includes(message) || !message.inference || message.savingFeedback) return;
    message.savingFeedback = true; message.feedbackError = ""; this.emit();
    try {
      const result = await save_feedback(this.api, { inference_id: message.inference.inference_id,
        kind: "correction", corrected_label: label });
      (message.feedback ||= []).push(result); // Append human feedback; never rewrite inference or trigger speech.
      if (label === "usable" && this.awaitingVisualEvent?.inference_id === message.inference.inference_id &&
          this.isCurrent(this.requests.get(message.request_id))) {
        this.visualEvents.decide(this.awaitingVisualEvent, "human_usable", "ignored");
        this.awaitingVisualEvent = null;
        this.requests.get(message.request_id).status = message.status;
        this.state = "idle"; this.stopSpeaking();
      }
    } catch { message.feedbackError = "人工纠正未保存，请检查连接后重试。"; }
    finally { message.savingFeedback = false; this.emit(); }
  }
}
