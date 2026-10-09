import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantSession } from "../web/services/assistantSession.js";
import { collect_new_data, verifyImageResult } from "../web/services/assistantTools.js";

// Synthetic transport responses only; real JPEG/hardware checks are separate.
const device = "ESP32_S3_EYE", taskId = "12345678-1234-4123-8123-123456789abc";
const tick = () => new Promise(r => setImmediate(r));
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
const parameters = { intent: "image_capture", data_type: "image", device, mode: "latest" };
function success(interaction) {
  return { request_id: taskId, interaction_request_id: interaction, device, action: "image_capture", status: "SUCCESS", image_status: "success",
    created_at: 100, sent_at: 101, started_at: 102, finished_at: 104, result_image_id: 9,
    result: { id: 9, task_id: taskId, device, capture_time: 103, received_at: 104, url: "/api/images/9",
      sha256: "a".repeat(64), byte_length: 4096, width: 320, height: 240, source: "ESP32-S3-EYE/OV2640" } };
}
function transport(overrides = {}) {
  const calls = [], bodies = [];
  let interaction;
  return { calls, bodies, devices: async () => ({ devices: [{ device }] }),
    async fetchJson(path, options = {}) {
      calls.push(path);
      if (path === "/api/task/create") { bodies.push(JSON.parse(options.body)); interaction = bodies.at(-1).interaction_request_id; }
      if (overrides[path]) return overrides[path](options, interaction);
      if (path === "/api/assistant/interpret") {
        const text = JSON.parse(options.body).message, image = !text.includes("数据");
        return { status: "ready", intent: image ? "image_capture" : "query_existing",
          parameters: image ? parameters : { intent: "query_existing", data_type: "acceleration", device, mode: "latest" },
          context: { device, pending: null }, devices: [{ id: device, name: device }] };
      }
      if (path === "/api/devices") return { devices: [{ device }] };
      if (path.startsWith("/api/latest?")) return { id: 1, device, status: "online", sensor: "QMA6100P", acc_x: .1, acc_y: .2, acc_z: .9,
        timestamp: "2026-09-29 12:00:00", received_at_ms: 100000 };
      if (path === "/api/task/create") return { request_id: taskId, status: "PENDING" };
      if (path === `/api/task/${taskId}`) return success(interaction);
      throw new Error(path);
    } };
}
function speech(session) {
  const spoken = [];
  session.attachVoice({ stopSpeaking() {}, speak(text) { spoken.push(text); } });
  return spoken;
}

test("image request reuses session, task POST, ownership and verified result", async () => {
  const api = transport(), session = new AssistantSession(api, null), spoken = speech(session);
  await session.send("拍一张照片");
  assert.equal(api.bodies.length, 1);
  assert.equal(api.bodies[0].action, "image_capture");
  assert.equal(api.bodies[0].interaction_request_id, session.currentRequestId);
  assert.notEqual(session.currentRequestId, taskId);
  assert.equal(session.messages.at(-1).task_id, taskId);
  assert.equal(session.messages.at(-1).image.task_id, taskId);
  assert.equal(session.messages.at(-1).status, "success");
  assert.match(spoken[0], /本次拍照成功/);
});

test("offline image request fails quickly without creating a task", async () => {
  const api = transport({ [`/api/latest?device=${device}`]: () => ({ id: 1, device, status: "offline" }) });
  const session = new AssistantSession(api, null), spoken = speech(session);
  await session.send("拍一张照片");
  assert.equal(api.bodies.length, 0);
  assert.equal(session.messages.at(-1).code, "device_offline");
  assert.match(spoken[0], /离线/); assert.doesNotMatch(spoken[0], /成功/);
});

test("camera failure ignores an injected old image and never speaks success", async () => {
  const api = transport({ [`/api/task/${taskId}`]: () => ({ ...success(), status: "FAILED", image_status: "unavailable", error: "camera_unavailable" }) });
  const session = new AssistantSession(api, null), spoken = speech(session);
  await session.send("拍一张照片");
  assert.equal(session.messages.at(-1).status, "error");
  assert.equal(session.messages.at(-1).image, undefined);
  assert.match(spoken[0], /不可用/); assert.doesNotMatch(spoken[0], /成功/);
});

test("different task, interaction, old time, record and URL cannot masquerade as this result", () => {
  const expected = { requestId: taskId, device, interactionRequestId: "interaction-a" };
  const mutations = [t => t.result.task_id = "old-task", t => t.result.id = 8,
    t => t.interaction_request_id = "interaction-b", t => t.result.capture_time = 90,
    t => t.result.url = "/api/images/8", t => t.result.byte_length = 0,
    t => t.image_status = "invalid"];
  for (const mutate of mutations) { const t = success("interaction-a"); mutate(t); assert.throws(() => verifyImageResult(t, expected)); }
});

test("cancelled image wait cannot show or speak late JPEG over a newer request", async () => {
  const late = deferred(), polled = deferred();
  const api = transport({ [`/api/task/${taskId}`]: () => { polled.resolve(); return late.promise; } });
  const session = new AssistantSession(api, null), spoken = speech(session);
  const operation = session.send("拍一张照片"); await polled.promise;
  const original = session.currentRequestId;
  session.cancel(); await operation;
  const cancelled = structuredClone(session.messages.at(-1));
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.task_id, taskId);
  assert.equal(session.pendingTask, null); assert.equal(spoken.length, 0);
  await session.send("查看上次数据");
  const current = session.currentRequestId, latest = structuredClone(session.messages.at(-1));
  late.resolve(success(original)); await tick();
  assert.equal(session.currentRequestId, current);
  assert.deepEqual(session.messages.at(-1), latest);
  assert.deepEqual(session.messages[1], cancelled);
  assert.equal(spoken.length, 1);
  assert.equal(session.messages.some(m => m.image), false);
});

test("late image creation response after cancel is audit-only, never starts polling", async () => {
  const late = deferred(), posted = deferred();
  const api = transport({ "/api/task/create": () => { posted.resolve(); return late.promise; } });
  const session = new AssistantSession(api, null);
  const operation = session.send("拍一张照片"); await posted.promise;
  session.cancel(); await operation;
  late.resolve({ request_id: taskId, status: "PENDING" }); await tick();
  assert.equal(api.calls.includes(`/api/task/${taskId}`), false);
  assert.equal(session.currentRequestId, null);
  assert.ok(session.events.some(e => e.event === "task linked" && e.task_id === taskId));
});

test("short image wait timeout keeps exact task for resume, never reads latest image", async () => {
  let clock = 0;
  const api = transport({ [`/api/task/${taskId}`]: () => ({ request_id: taskId, device, status: "SENT", action: "image_capture" }) });
  let expected;
  const result = await collect_new_data(api, parameters, { now: () => clock, sleep: async ms => { clock += ms; }, onCreated: t => expected = t });
  assert.equal(clock, 6000); assert.equal(result.resumable, true);
  assert.equal(result.requestId, taskId); assert.equal(expected.action, "image_capture");
  assert.equal(result.image, undefined); assert.doesNotMatch(result.message, /成功/);
});
