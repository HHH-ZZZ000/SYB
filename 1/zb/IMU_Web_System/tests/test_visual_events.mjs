import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistantSession } from "../web/services/assistantSession.js";
import { AssistantVoice } from "../web/services/assistantVoice.js";
import { ApiClient } from "../web/services/api.js";
import { VisualEventLog, visualEventOf } from "../web/services/visualEvents.js";

// Isolated synthetic transports/recognition events. These are software tests,
// not evidence that BRISQUE, a real microphone, or ESP32 executed successfully.
const device = "ESP32_S3_EYE";
const tick = () => new Promise(r => setImmediate(r));
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function fixture(options = {}) {
  const calls = [], tasks = new Map(), spoken = [];
  let record = 9, clock = 1000000;
  const controls = { online: true, mode: "on_demand", inferenceStatus: "unknown", taskStatus: "SUCCESS", ...options };
  function createTask(interaction) {
    const id = record++, taskId = crypto.randomUUID();
    const image = { id, task_id: taskId, device, capture_time: 103 + id, received_at: 104 + id,
      url: `/api/images/${id}`, sha256: "a".repeat(64), byte_length: 4096, width: 320, height: 240, source: "synthetic_test" };
    const task = { request_id: taskId, interaction_request_id: interaction, device, action: "image_capture", status: "SUCCESS",
      image_status: "success", created_at: 100 + id, sent_at: 101 + id, started_at: 102 + id, finished_at: 104 + id,
      result_image_id: id, result: image };
    tasks.set(taskId, task); return task;
  }
  const original = createTask(null);
  function inference(body) {
    const image = tasks.get(body.image_task_id).result;
    const unknown = controls.inferenceStatus === "unknown";
    return { inference_id: crypto.randomUUID(), request_id: body.request_id, image_record_id: image.id,
      image_task_id: image.task_id, device, capture_time: image.capture_time, image_sha256: image.sha256,
      model_name: "TEST ONLY", model_version: "synthetic-1", inference_time: 110 + image.id, score: unknown ? 45 : 12,
      status: unknown ? "unknown" : "accepted", label: unknown ? "unknown" : "quality_good", rejected: unknown,
      policy: { good_max: 30, poor_min: 60 }, reason: "test_quality_band", label_source: "application_quality_band_not_model_class",
      score_semantics: "模拟失真分数，不是准确率", message: "模拟反馈，非真实模型证据" };
  }
  const api = { devices: async () => ({ devices: [{ device }] }), async fetchJson(path, options = {}) {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, body });
    if (controls.override?.[path]) return controls.override[path](body);
    if (path === "/api/assistant/interpret") {
      const intent = body.message.includes("数据") ? "query_existing" : body.message === "拍一张照片" ? "image_capture" : "vision_analyze";
      return { status: "ready", intent, parameters: { intent, device, data_type: intent === "query_existing" ? "acceleration" : "image",
        mode: intent === "vision_analyze" ? body.message.includes("当前") ? "image_fresh" : "image_existing" : "latest",
        ...(body.message === "分析图片记录9" ? { image_record_id: 9 } : {}) }, context: { device, pending: null }, devices: [{ id: device, name: device }] };
    }
    if (path === "/api/devices") return { devices: [{ device }] };
    if (path.startsWith("/api/latest?")) return { id: 1, device, status: controls.online ? "online" : "offline", sensor: "QMA6100P",
      acc_x: .1, acc_y: .2, acc_z: .9, timestamp: "2026-09-30 12:00:00", received_at_ms: 100000 };
    if (path.startsWith("/api/status?")) return { device, status: controls.online ? "online" : "offline",
      camera: { mode: controls.mode, last_capture: controls.lastCapture } };
    if (path === "/api/task/create") {
      const task = createTask(body.interaction_request_id);
      if (controls.taskStatus !== "SUCCESS") Object.assign(task, { status: controls.taskStatus, error: controls.taskError || "capture_error",
        image_status: controls.imageStatus || "failed", result: null, result_image_id: null });
      return { request_id: task.request_id, status: "PENDING" };
    }
    if (path.startsWith("/api/task/")) return tasks.get(path.slice("/api/task/".length));
    if (path === "/api/vision/images/9") return original;
    if (path === "/api/vision/infer") return inference(body);
    if (path === "/api/vision/feedback") return { ...body, feedback_id: crypto.randomUUID(), feedback_time: 200,
      original_label: "unknown", original_score: 45 };
    throw new Error(`Unhandled test API ${path}`);
  } };
  const session = new AssistantSession(api, options.storage || null, { now: () => clock, cooldownMs: options.cooldownMs || 120000 });
  session.chooseDevice(device);
  session.attachVoice({ stopSpeaking() {}, speak(text, id, valid) { if (valid()) spoken.push({ text, id }); } });
  const analyze = () => session.send("分析这张图片", { image: original.result });
  return { api, session, controls, original, calls, tasks, spoken, analyze, inference,
    advance: ms => clock += ms, get creates() { return calls.filter(c => c.path === "/api/task/create").length; } };
}

test("normal accepted picture: no event, confirmation, or new task", async () => {
  const f = fixture({ inferenceStatus: "accepted" }); await f.analyze();
  assert.equal(f.session.state, "idle"); assert.equal(f.session.awaitingVisualEvent, null);
  assert.equal(f.session.visualEvents.records.length, 0); assert.equal(f.creates, 0);
  assert.equal(f.calls.some(c => c.path.startsWith("/api/status?")), false);
});
test("unknown: one prompt with exact request/image/task/inference IDs, no device action", async () => {
  const f = fixture(); await f.analyze();
  const answer = f.session.messages.at(-1), event = f.session.awaitingVisualEvent;
  assert.equal(f.session.state, "awaiting_confirmation");
  assert.equal(event.request_id, f.session.currentRequestId); assert.equal(event.inference_id, answer.inference.inference_id);
  assert.equal(event.image_record_id, 9); assert.equal(event.image_task_id, f.original.request_id);
  assert.notEqual(event.event_id, event.request_id); assert.notEqual(event.request_id, event.image_task_id);
  assert.equal(event.category, "model"); assert.equal(event.event_type, "visual_uncertain");
  assert.equal(f.creates, 0); assert.equal(f.spoken.length, 1); assert.match(f.spoken[0].text, /是否重新拍摄/);
  f.session.emit(); f.session.syncSpeech();
  assert.equal(f.session.visualEvents.records.length, 1); assert.equal(f.spoken.length, 1);
});
for (const [text, target] of [["是", false], ["重拍", false], ["重新拍一张", false], ["确认", false], ["重新拍摄", true]]) {
  test(`confirmation ${text}${target ? " via button target" : " via text"}: fresh task/image/inference`, async () => {
    const f = fixture(); await f.analyze();
    const old = f.session.messages.at(-1), event = f.session.awaitingVisualEvent;
    f.controls.inferenceStatus = "accepted";
    await f.session.send(text, target ? { visualEventId: event.event_id } : {});
    const answer = f.session.messages.at(-1);
    assert.equal(event.status, "confirmed"); assert.equal(f.creates, 1);
    assert.notEqual(answer.request_id, old.request_id); assert.notEqual(answer.task_id, old.task_id);
    assert.notEqual(answer.image.id, old.image.id); assert.notEqual(answer.inference.inference_id, old.inference.inference_id);
    assert.equal(event.new_task_id, answer.task_id); assert.equal(event.decision_request_id, answer.request_id);
    assert.equal(answer.inference.image_task_id, answer.task_id); assert.equal(answer.inference.request_id, answer.request_id);
    assert.equal(old.image.id, 9); assert.equal(old.inference.label, "unknown");
    const feedback = f.calls.find(c => c.path === "/api/vision/feedback").body;
    assert.equal(feedback.inference_id, old.inference.inference_id); assert.equal(feedback.new_task_id, answer.task_id);
    assert.equal(f.session.state, "idle");
  });
}
for (const text of ["不用", "忽略", "算了", "不拍了"]) {
  test(`refusal ${text}: idle, no task, no repeated speech, persisted cooldown`, async () => {
    const saved = storage(), f = fixture({ storage: saved }); await f.analyze();
    const event = f.session.awaitingVisualEvent, count = f.spoken.length;
    await f.session.send(text);
    assert.equal(f.creates, 0); assert.equal(f.session.state, "idle"); assert.equal(f.session.awaitingVisualEvent, null);
    assert.equal(event.status, "ignored"); assert.equal(event.decision, "ignored");
    assert.equal(event.decision_category, "interaction"); assert.equal(event.cooldown_until - event.decision_time, 120000);
    assert.equal(f.spoken.length, count); assert.equal(f.session.requests.get(event.request_id).cancelled, false);
    assert.equal(JSON.parse(saved.getItem("imu-visual-events-v1")).events[0].decision, "ignored");
  });
}
test("cooldown records the next event silently; expiry allows a new question", async () => {
  const f = fixture({ cooldownMs: 3000 }); await f.analyze(); await f.session.send("忽略");
  const spoken = f.spoken.length;
  await f.analyze();
  const second = f.session.messages.at(-1).visual_event;
  assert.equal(second.status, "suppressed"); assert.equal(second.reason, "cooldown");
  assert.equal(f.session.awaitingVisualEvent, null); assert.equal(f.spoken.length, spoken);
  assert.doesNotMatch(f.session.messages.at(-1).message, /请重新拍摄|是否重新拍摄/);
  f.advance(3001); await f.analyze();
  assert.equal(f.session.awaitingVisualEvent.status, "awaiting_confirmation");
  assert.equal(f.session.visualEvents.records.length, 3); assert.equal(f.creates, 0);
});
test("configuration, per-device/type cooldown, bounded log, reload cannot restore active prompts", () => {
  const saved = storage(), log = new VisualEventLog(saved, { now: () => 1000 });
  assert.throws(() => log.setCooldown(0)); assert.throws(() => log.setCooldown(3601000));
  log.setCooldown(9000);
  const event = { event_id: crypto.randomUUID(), device_id: device, event_type: "visual_uncertain" };
  log.append(event); log.decide(event, "ignored");
  assert.equal(log.cooldownUntil(event), 10000);
  assert.equal(log.cooldownUntil({ ...event, event_type: "image_invalid" }), null);
  assert.equal(log.cooldownUntil({ ...event, device_id: "OTHER" }), null);
  const reloaded = new VisualEventLog(saved, { now: () => 2000 });
  assert.equal(reloaded.cooldownMs, 9000); assert.equal(reloaded.cooldownUntil(event), 10000);
  for (let i = 0; i < 105; i++) reloaded.append({ ...event, event_id: crypto.randomUUID() });
  assert.equal(reloaded.records.length, 100);
  assert.equal(new AssistantSession({}, saved).awaitingVisualEvent, null);
});
for (const settings of [{ online: false }, { mode: "camera_unavailable" }]) {
  test(`device unavailable takes precedence over old unknown: ${JSON.stringify(settings)}`, async () => {
    const f = fixture(settings); await f.analyze();
    const answer = f.session.messages.at(-1);
    assert.equal(answer.visual_event.event_type, "device_unavailable"); assert.equal(answer.visual_event.category, "device");
    assert.equal(answer.status, "error"); assert.equal(f.session.awaitingVisualEvent, null); assert.equal(f.creates, 0);
    assert.doesNotMatch(f.spoken[0].text, /是否重新拍摄|拍照成功/);
  });
}
test("offline new capture: no task, null absent evidence IDs, no prompt", async () => {
  const f = fixture({ online: false }); await f.session.send("拍一张照片");
  const event = f.session.messages.at(-1).visual_event;
  assert.equal(event.event_type, "device_unavailable");
  for (const key of ["inference_id", "image_record_id", "image_task_id"]) assert.equal(event[key], null);
  assert.equal(f.creates, 0); assert.equal(f.session.state, "idle");
});
test("device disconnects after the prompt: confirmation rechecks online state, no task", async () => {
  const f = fixture(); await f.analyze(); const original = f.session.awaitingVisualEvent;
  f.controls.online = false; await f.session.send("确认");
  assert.equal(original.status, "confirmed"); assert.equal(f.creates, 0);
  assert.equal(f.session.messages.at(-1).visual_event.event_type, "device_unavailable");
  assert.equal(f.session.awaitingVisualEvent, null);
});
test("failed capture is a device event, never a model uncertainty; confirmed retry has no old-image fallback", async () => {
  const f = fixture({ taskStatus: "FAILED" }); await f.session.send("拍一张照片");
  const answer = f.session.messages.at(-1), event = f.session.awaitingVisualEvent;
  assert.equal(event.event_type, "capture_failed"); assert.equal(event.category, "device"); assert.equal(event.inference_id, null);
  assert.equal(event.image_task_id, answer.task_id); assert.equal(answer.image, undefined);
  assert.equal(f.calls.some(c => c.path === "/api/vision/infer"), false);
  f.controls.taskStatus = "SUCCESS"; f.controls.inferenceStatus = "accepted";
  await f.session.send("重拍");
  assert.equal(f.creates, 2); assert.notEqual(f.session.messages.at(-1).task_id, answer.task_id);
  assert.equal(f.session.messages.at(-1).inference.status, "accepted");
});
test("camera hardware failure has higher priority than failed capture", async () => {
  const f = fixture({ taskStatus: "FAILED", taskError: "camera_unavailable", imageStatus: "unavailable" });
  await f.session.send("拍一张照片");
  assert.equal(f.session.messages.at(-1).visual_event.event_type, "device_unavailable");
  assert.equal(f.session.awaitingVisualEvent, null);
});
test("latest failed task outranks analysis of an older unknown image with separate evidence ID", async () => {
  const failingTask = crypto.randomUUID(), f = fixture({ mode: "capture_failed", lastCapture: { request_id: failingTask, finished_at: 120 } });
  await f.analyze(); const answer = f.session.messages.at(-1);
  assert.equal(answer.visual_event.event_type, "capture_failed");
  assert.equal(answer.visual_event.image_task_id, f.original.request_id);
  assert.equal(answer.visual_event.device_evidence_task_id, failingTask);
  assert.match(answer.message, /设备拍摄问题/);
});
for (const explicit of [false, true]) {
  test(`damaged ${explicit ? "explicit ID" : "context"} image: no inference, source-bound image_invalid event`, async () => {
    const f = fixture(); f.original.image_status = "invalid";
    if (explicit) await f.session.send("分析图片记录9"); else await f.analyze();
    const event = f.session.awaitingVisualEvent;
    assert.equal(event.event_type, "image_invalid"); assert.equal(event.image_record_id, 9);
    assert.equal(event.image_task_id, f.original.request_id); assert.equal(event.inference_id, null);
    assert.equal(f.calls.some(c => c.path === "/api/vision/infer"), false); assert.equal(f.creates, 0);
  });
}
test("decoder error during inference is image_invalid; generic HTTP errors do not invent damage", async () => {
  for (const code of ["image_invalid", undefined]) {
    const f = fixture({ override: { "/api/vision/infer": () => { throw Object.assign(new Error("test"), { status: 400, code }); } } });
    await f.analyze();
    assert.equal(f.session.messages.at(-1).visual_event?.event_type, code);
  }
});
test("API preserves only real decoder error code, not unrelated server messages", async () => {
  const original = globalThis.fetch;
  try {
    for (const value of ["image_invalid", "Invalid capture_time."]) {
      globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: value }) });
      await assert.rejects(new ApiClient().fetchJson("/api/vision/infer"), e => e.status === 400 && e.code === (value === "image_invalid" ? value : undefined));
    }
  } finally { globalThis.fetch = original; }
});
test("device status failure defers prompt; never guesses online/offline", async () => {
  const f = fixture({ override: { [`/api/status?device=${device}`]: () => { throw new Error("offline API"); } } });
  await f.analyze(); assert.equal(f.session.messages.at(-1).visual_event.status, "deferred");
  assert.equal(f.session.awaitingVisualEvent, null); assert.equal(f.creates, 0);
});
test("cancel awaiting confirmation and stale button cannot execute", async () => {
  const f = fixture(); await f.analyze(); const event = f.session.awaitingVisualEvent;
  await f.session.send("取消当前任务");
  assert.equal(event.status, "cancelled"); assert.equal(f.session.currentRequestId, null);
  await f.session.send("重新拍摄", { visualEventId: event.event_id });
  assert.equal(f.creates, 0); assert.equal(f.session.awaitingVisualEvent, null);
});
test("new text request supersedes prompt; stale confirmation cannot affect it", async () => {
  const f = fixture(); await f.analyze(); const event = f.session.awaitingVisualEvent;
  await f.session.send("查看上次数据"); const current = f.session.currentRequestId;
  assert.equal(event.status, "superseded"); assert.equal(f.session.messages.at(-1).kind, "existing");
  await f.session.send("重新拍摄", { visualEventId: event.event_id });
  assert.equal(f.session.currentRequestId, current); assert.equal(f.creates, 0);
});
for (const phase of ["inference", "availability"]) {
  test(`late ${phase} after cancel/supersede cannot ask, speak, or act`, async () => {
    for (const cancel of [false, true]) {
      const entered = deferred(), late = deferred(); let pendingBody;
      const path = phase === "inference" ? "/api/vision/infer" : `/api/status?device=${device}`;
      const f = fixture({ override: { [path]: body => { pendingBody = body; entered.resolve(); return late.promise; } } });
      const operation = f.analyze(); await entered.promise;
      if (cancel) f.session.cancel(); else await f.session.send("查看上次数据");
      await operation; const count = f.spoken.length;
      late.resolve(phase === "inference" ? f.inference(pendingBody) : { device, status: "online", camera: { mode: "on_demand" } });
      await tick();
      assert.equal(f.session.visualEvents.records.length, 0); assert.equal(f.session.awaitingVisualEvent, null);
      assert.equal(f.spoken.length, count); assert.equal(f.creates, 0);
    }
  });
}
test("duplicate confirmation during creation cannot create another task; cancellation isolates late image", async () => {
  const entered = deferred(), late = deferred(), f = fixture(); await f.analyze();
  f.controls.override = { "/api/task/create": () => { entered.resolve(); return late.promise; } };
  const retake = f.session.send("确认"); await entered.promise;
  await f.session.send("是"); assert.equal(f.creates, 1);
  f.session.cancel(); await retake;
  const count = f.spoken.length; late.resolve({ request_id: crypto.randomUUID(), status: "PENDING" }); await tick();
  assert.equal(f.session.currentRequestId, null); assert.equal(f.session.awaitingVisualEvent, null); assert.equal(f.spoken.length, count);
  assert.equal(f.calls.filter(c => c.path === "/api/vision/infer").length, 1);
});
test("human usable correction ends suggestion without changing original prediction or taking a photo", async () => {
  const f = fixture(); await f.analyze(); const answer = f.session.messages.at(-1), event = f.session.awaitingVisualEvent;
  await f.session.correct(answer, "usable");
  assert.equal(answer.inference.label, "unknown"); assert.equal(answer.feedback[0].corrected_label, "usable");
  assert.equal(event.decision, "human_usable"); assert.equal(event.status, "ignored");
  assert.equal(f.creates, 0); assert.equal(f.session.state, "idle");
});
test("changing the device invalidates that device's unanswered prompt", async () => {
  const f = fixture(); await f.analyze(); const event = f.session.awaitingVisualEvent;
  f.session.chooseDevice("OTHER"); assert.equal(event.status, "superseded");
  await f.session.send("重新拍摄", { visualEventId: event.event_id }); assert.equal(f.creates, 0);
});
test("voice final transcripts use the exact same confirm/refuse entry as text/buttons", async () => {
  for (const transcript of ["重新拍一张", "算了"]) {
    const f = fixture(); await f.analyze(); const event = f.session.awaitingVisualEvent;
    let recognizer, operation;
    class Recognition { constructor() { recognizer = this; } start() {} abort() {} stop() {} }
    const voice = new AssistantVoice({ Recognition, secure: true, synthesis: null, Utterance: null,
      setTimer: () => 1, clearTimer() {}, onTranscript: text => operation = f.session.send(text) });
    voice.start(); recognizer.onaudiostart();
    recognizer.onresult({ results: [Object.assign([{ transcript }], { isFinal: true })] }); recognizer.onend();
    await operation; voice.dispose();
    assert.equal(event.status, transcript === "算了" ? "ignored" : "confirmed");
    assert.equal(f.creates, transcript === "算了" ? 0 : 1);
  }
});
test("structured event classification prioritizes device > capture > invalid > uncertain", () => {
  const base = { kind: "vision", inference: { status: "unknown" } };
  assert.equal(visualEventOf({ ...base, code: "device_offline", taskStatus: "FAILED", imageStatus: "invalid" }).event_type, "device_unavailable");
  assert.equal(visualEventOf({ ...base, taskStatus: "FAILED", imageStatus: "invalid" }).event_type, "capture_failed");
  assert.equal(visualEventOf({ ...base, imageStatus: "invalid" }).event_type, "image_invalid");
  assert.equal(visualEventOf({ ...base, inference: { status: "failed" } }), null);
  assert.equal(visualEventOf({ ...base, kind: "existing" }), null);
});
