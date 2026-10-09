import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistantSession } from "../web/services/assistantSession.js";
import { verifyInference } from "../web/services/visionTools.js";

// Synthetic transport/model outputs in isolated tests, NOT real inference evidence.
const device = "ESP32_S3_EYE", taskId = "12345678-1234-4123-8123-123456789abc";
const iid = "87654321-1234-4123-8123-123456789abc";
const image = { id: 9, task_id: taskId, device, capture_time: 103, received_at: 104, url: "/api/images/9",
  sha256: "a".repeat(64), byte_length: 4096, width: 320, height: 240, source: "test" };
function task(interaction) { return { request_id: taskId, interaction_request_id: interaction, device, action: "image_capture",
  status: "SUCCESS", image_status: "success", created_at: 100, sent_at: 101, started_at: 102, finished_at: 104, result_image_id: 9, result: image }; }
function result(requestId) { return { inference_id: iid, request_id: requestId, image_record_id: image.id, image_task_id: taskId, device,
  capture_time: image.capture_time, image_sha256: image.sha256, model_name: "TEST ONLY", model_version: "synthetic-1", inference_time: 110,
  label: "quality_good", score: 12, status: "accepted", rejected: false, policy: { good_max: 30, poor_min: 60 }, reason: "quality_band",
  label_source: "application_quality_band_not_model_class", score_semantics: "失真分数，越低越好，不是准确率", message: "模拟结果，不计入真实推理验证" }; }
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
const tick = () => new Promise(r => setImmediate(r));
function transport(overrides = {}) {
  const calls = []; let interaction;
  return { calls, devices: async () => ({ devices: [{ device }] }),
    async fetchJson(path, options = {}) {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ path, body });
      if (path === "/api/task/create") interaction = body.interaction_request_id;
      if (overrides[path]) return overrides[path](body);
      if (path === "/api/assistant/interpret") {
        const intent = body.message === "拍一张照片" ? "image_capture" : body.message.includes("数据") ? "query_existing" : "vision_analyze";
        return { status: "ready", intent, parameters: { intent, device, data_type: intent === "query_existing" ? "acceleration" : "image",
          mode: intent === "vision_analyze" ? body.message.includes("当前") ? "image_fresh" : "image_existing" : "latest" },
          context: { device, pending: null }, devices: [{ id: device, name: device }] };
      }
      if (path === "/api/devices") return { devices: [{ device }] };
      if (path.startsWith("/api/latest?")) return { id: 1, device, status: "online", sensor: "QMA6100P", acc_x: .1, acc_y: .2, acc_z: .9,
        timestamp: "2026-09-29 12:00:00", received_at_ms: 100000 };
      if (path === "/api/task/create") return { request_id: taskId, status: "PENDING" };
      if (path === `/api/task/${taskId}`) return task(interaction);
      if (path === "/api/vision/infer") return result(body.request_id);
      if (path === "/api/vision/feedback") return { ...body, feedback_id: crypto.randomUUID(), original_label: "quality_good", original_score: 12, feedback_time: 111 };
      throw new Error(path);
    } };
}
function setup(api) {
  const session = new AssistantSession(api, null), spoken = [];
  session.attachVoice({ stopSpeaking() {}, speak(text) { spoken.push(text); } });
  return { session, spoken };
}

test("no target clarifies, no capture or arbitrary latest image read", async () => {
  const api = transport(), { session } = setup(api);
  await session.send("分析刚才拍的图片");
  assert.equal(session.messages.at(-1).status, "clarify");
  assert.equal(api.calls.length, 1);
});

test("explicit record ID resolves exactly that image through restricted endpoint", async () => {
  const api = transport({
    "/api/assistant/interpret": () => ({ status: "ready", intent: "vision_analyze",
      parameters: { intent: "vision_analyze", device, data_type: "image", mode: "image_existing", image_record_id: 9 },
      context: { device, pending: null }, devices: [{ id: device, name: device }] }),
    "/api/vision/images/9": () => task(),
  });
  const { session } = setup(api);
  await session.send("分析图片记录 9");
  assert.equal(session.messages.at(-1).inference.image_record_id, 9);
  assert.equal(api.calls.some(c => c.path === "/api/task/create"), false);
});

test("explicit/context image reuses send, verifies record and does not retake", async () => {
  const api = transport(), { session } = setup(api);
  await session.send("拍一张照片");
  await session.send("分析刚才拍的图片");
  const answer = session.messages.at(-1);
  assert.equal(answer.inference.image_record_id, image.id);
  assert.equal(answer.inference.request_id, session.currentRequestId);
  assert.equal(api.calls.filter(c => c.path === "/api/task/create").length, 1);
  assert.equal(answer.image.id, image.id);
});

test("fresh inference and retake keep capture ownership and feedback linkage", async () => {
  const api = transport(), { session } = setup(api);
  await session.send("看看当前画面是否可用", { device, retakeFrom: iid });
  const creation = api.calls.find(c => c.path === "/api/task/create").body;
  const feedback = api.calls.find(c => c.path === "/api/vision/feedback").body;
  assert.equal(creation.action, "image_capture");
  assert.equal(feedback.new_task_id, taskId);
  assert.equal(feedback.request_id, creation.interaction_request_id);
  assert.equal(session.messages.at(-1).inference.image_task_id, taskId);
});

test("retake feedback failure preserves confirmed task and resumes linkage without recapture", async () => {
  let unavailable = true;
  const api = transport({ "/api/vision/feedback": body => {
    if (unavailable) throw Object.assign(new Error("feedback unavailable"), { status: 503 });
    return { ...body, feedback_id: crypto.randomUUID() };
  } });
  const { session } = setup(api);
  await session.send("看看当前画面是否可用", { device, retakeFrom: iid });
  const originalInteraction = session.currentRequestId;
  assert.equal(session.pendingTask.requestId, taskId);
  assert.equal(session.messages.at(-1).resumable, true);
  assert.match(session.messages.at(-1).message, /任务已创建.*HTTP 503/);
  assert.doesNotMatch(session.messages.at(-1).message, /提交结果未确认/);
  assert.equal(api.calls.some(c => c.path === "/api/vision/infer"), false);
  await session.resume(); // Still unavailable: retain the same confirmed task.
  assert.equal(session.pendingTask.requestId, taskId);
  assert.match(session.messages.at(-1).message, /重拍关联保存未确认/);
  unavailable = false;
  await session.resume();
  assert.equal(session.messages.at(-1).inference.image_task_id, taskId);
  assert.equal(session.pendingTask, null);
  assert.equal(api.calls.filter(c => c.path === "/api/task/create").length, 1);
  assert.ok(api.calls.filter(c => c.path === "/api/vision/feedback")
    .every(c => c.body.request_id === originalInteraction && c.body.new_task_id === taskId));
  assert.notEqual(session.currentRequestId, originalInteraction);
});

test("cancel during retake feedback cannot restore pending task or speak late results", async () => {
  const entered = deferred(), late = deferred(); let feedback;
  const api = transport({ "/api/vision/feedback": body => {
    feedback = body; entered.resolve(); return late.promise;
  } });
  const { session, spoken } = setup(api);
  const operation = session.send("看看当前画面是否可用", { device, retakeFrom: iid });
  await entered.promise;
  session.cancel(); await operation;
  late.resolve({ ...feedback, feedback_id: crypto.randomUUID() }); await tick();
  assert.equal(session.pendingTask, null);
  assert.equal(session.messages.at(-1).status, "cancelled");
  assert.equal(spoken.length, 0);
  assert.equal(api.calls.some(c => c.path === "/api/vision/infer"), false);
});

test("wrong image/task/request/time/hash result rejected", async () => {
  for (const mutate of [r => r.image_record_id++, r => r.image_task_id = iid, r => r.device = "OTHER",
    r => r.request_id = iid, r => r.capture_time++, r => r.image_sha256 = "b".repeat(64), r => r.model_version = ""]) {
    const value = result(taskId); mutate(value);
    assert.throws(() => verifyInference(value, image, taskId));
  }
});

test("cancelled slow inference cannot overwrite or speak over new request", async () => {
  const late = deferred(), entered = deferred(); let original;
  const api = transport({ "/api/vision/infer": body => { original = body.request_id; entered.resolve(); return late.promise; } });
  const { session, spoken } = setup(api);
  const operation = session.send("分析这张图片", { image }); await entered.promise;
  session.cancel(); await operation;
  const cancelled = structuredClone(session.messages.at(-1));
  await session.send("查看上次数据");
  const current = structuredClone(session.messages.at(-1));
  late.resolve(result(original)); await tick();
  assert.deepEqual(session.messages[1], cancelled);
  assert.deepEqual(session.messages.at(-1), current);
  assert.equal(spoken.length, 1);
  assert.equal(session.messages.some(m => m.inference), false);
});

test("model failure has no fake judgment and correction never rewrites prediction or speaks", async () => {
  const api = transport(), { session, spoken } = setup(api);
  await session.send("分析这张图片", { image });
  const answer = session.messages.at(-1), original = structuredClone(answer.inference);
  await session.correct(answer, "occluded");
  assert.deepEqual(answer.inference, original);
  assert.equal(answer.feedback[0].corrected_label, "occluded");
  assert.equal(spoken.length, 1);
  const failedApi = transport({ "/api/vision/infer": body => ({ ...result(body.request_id), status: "failed", label: null, score: null, message: "模型不可用" }) });
  const { session: failed, spoken: failureSpeech } = setup(failedApi);
  await failed.send("分析这张图片", { image });
  assert.equal(failed.messages.at(-1).status, "error");
  assert.match(failureSpeech[0], /模型不可用/);
});

test("offline retake does not reuse old image or call model", async () => {
  const api = transport({ [`/api/latest?device=${device}`]: () => ({ device, id: 1, status: "offline" }) });
  const { session, spoken } = setup(api); session.imageContext = image;
  await session.send("看看当前画面是否可用");
  assert.match(spoken[0], /离线/);
  assert.equal(session.imageContext, null);
  assert.equal(api.calls.some(c => ["/api/task/create", "/api/vision/infer"].includes(c.path)), false);
});
