import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantSession } from "../web/services/assistantSession.js";
import { AssistantVoice } from "../web/services/assistantVoice.js";

// Deliberately non-aborting transports reproduce late replies. No real device,
// microphone or speaker is used by these interaction ownership tests.
const device = "ESP32_S3_EYE";
const taskId = "12345678-1234-4123-8123-123456789abc";
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function sample(id = 1) {
  return { id, device, sensor: "QMA6100P", acc_x: .1, acc_y: -.2, acc_z: .9,
    timestamp: "2026-01-01 08:00:01", received_at: 1767225601, received_at_ms: 1767225601000, status: "online" };
}
function taskResult() {
  return { request_id: taskId, device, action: "capture_once", status: "SUCCESS",
    created_at: 1767225600, sent_at: 1767225600, finished_at: 1767225601,
    result_sample_id: 2, result: sample(2) };
}
function ready(message) {
  return { status: "ready", intent: message.includes("采集") ? "collect_new" : "query_existing",
    parameters: { intent: message.includes("采集") ? "collect_new" : "query_existing", device, data_type: "acceleration", mode: "latest" },
    context: { device, pending: null }, devices: [{ id: device, name: device }] };
}
function api(overrides = {}) {
  const calls = [];
  return { calls, devices: async () => ({ devices: [{ device }] }),
    async fetchJson(path, options = {}) {
      calls.push(path);
      if (overrides[path]) return overrides[path](options);
      if (path === "/api/assistant/interpret") return ready(JSON.parse(options.body).message);
      if (path === "/api/devices") return { devices: [{ device }] };
      if (path.startsWith("/api/latest?")) return sample();
      if (path === "/api/task/create") return { request_id: taskId, status: "PENDING" };
      if (path === `/api/task/${taskId}`) return taskResult();
      throw new Error(`Unexpected path: ${path}`);
    } };
}
function audio(session) {
  const spoken = []; let cancels = 0, recognizer;
  const voice = new AssistantVoice({
    Recognition: class { constructor() { recognizer = this; } start() {} stop() {} abort() {} }, secure: true,
    Utterance: class { constructor(text) { this.text = text; } },
    synthesis: { getVoices: () => [], speak: u => spoken.push(u), cancel: () => cancels++ },
    onChange: () => session.syncSpeech(), onTranscript: text => session.send(text),
  });
  session.attachVoice(voice);
  return { voice, spoken, get cancels() { return cancels; }, get recognizer() { return recognizer; } };
}

test("A interpret arriving after B cannot change state, context, result, TTS or create a task", async () => {
  const a = deferred(); let count = 0;
  const transport = api({ "/api/assistant/interpret": opts => ++count === 1 ? a.promise : ready(JSON.parse(opts.body).message) });
  const session = new AssistantSession(transport, null), sound = audio(session);
  const first = session.send("重新采集一次"); const oldId = session.currentRequestId;
  await session.send("查看上次数据");
  const current = session.currentRequestId, result = structuredClone(session.messages.at(-1));
  assert.notEqual(current, oldId);
  assert.equal(sound.spoken.length, 1);
  a.resolve(ready("重新采集一次")); await first; await tick();
  assert.deepEqual(session.messages.at(-1), result);
  assert.equal(session.currentRequestId, current);
  assert.equal(session.busy, false);
  assert.equal(sound.spoken.length, 1);
  assert.equal(transport.calls.includes("/api/task/create"), false);
  assert.ok(session.events.some(e => e.event === "stale result ignored" && e.request_id === oldId));
  sound.voice.dispose();
});

test("cancel waiting keeps task ID as evidence, drops resume storage, and ignores late SUCCESS", async () => {
  const response = deferred(), polled = deferred(), memory = new Map();
  const transport = api({ [`/api/task/${taskId}`]: () => { polled.resolve(); return response.promise; } });
  const storage = { getItem: k => memory.get(k), setItem: (k,v) => memory.set(k,v), removeItem: k => memory.delete(k) };
  const session = new AssistantSession(transport, storage), sound = audio(session);
  const operation = session.send("重新采集一次"); await polled.promise;
  const id = session.currentRequestId;
  assert.notEqual(id, taskId);
  assert.equal(session.messages.at(-1).task_id, taskId);
  await session.send("取消"); await operation;
  assert.equal(session.currentRequestId, null);
  assert.equal(session.state, "cancelled"); assert.equal(session.busy, false);
  assert.equal(session.pendingTask, null); assert.equal(session.shortContext, null);
  assert.equal(memory.size, 0);
  assert.equal(new AssistantSession(transport, storage).pendingTask, null);
  const cancelled = structuredClone(session.messages.at(-1));
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.task_id, taskId);
  assert.match(cancelled.message, /仍可能执行/);
  response.resolve(taskResult()); await tick();
  assert.deepEqual(session.messages.at(-1), cancelled);
  assert.equal(sound.spoken.length, 0);
  assert.equal(session.requests.get(id).cancelled, true);
  sound.voice.dispose();
});

test("cancel during task creation records late task ID only in bounded audit, without polling", async () => {
  const creation = deferred(), sent = deferred();
  const transport = api({ "/api/task/create": () => { sent.resolve(); return creation.promise; } });
  const session = new AssistantSession(transport, null);
  const operation = session.send("重新采集一次"); await sent.promise;
  const id = session.currentRequestId;
  session.cancel(); await operation;
  assert.match(session.messages.at(-1).message, /仍可能执行/);
  const cancelled = structuredClone(session.messages.at(-1));
  creation.resolve({ request_id: taskId, status: "PENDING" }); await tick();
  assert.equal(session.requests.get(id).task_id, taskId);
  assert.deepEqual(session.messages.at(-1), cancelled);
  assert.equal(transport.calls.includes(`/api/task/${taskId}`), false);
  assert.equal(session.pendingTask, null);
});

test("new query replaces a waiting collection; late task cannot change B or its speech", async () => {
  const response = deferred(), polled = deferred();
  const transport = api({ [`/api/task/${taskId}`]: () => { polled.resolve(); return response.promise; } });
  const session = new AssistantSession(transport, null), sound = audio(session);
  const operation = session.send("重新采集一次"); await polled.promise;
  await session.send("查看上次数据");
  const current = session.currentRequestId, text = session.messages.at(-1).message;
  response.resolve(taskResult()); await operation; await tick();
  assert.equal(session.currentRequestId, current);
  assert.equal(session.messages.at(-1).message, text);
  assert.equal(session.messages.at(-1).kind, "existing");
  assert.equal(sound.spoken.length, 1);
  assert.equal(session.pendingTask, null);
  sound.voice.dispose();
});

test("stop speech preserves result and current request; late speech callbacks cannot affect a new request", async () => {
  const session = new AssistantSession(api(), null), sound = audio(session);
  await session.send("查看上次数据");
  const result = structuredClone(session.messages.at(-1)), id = session.currentRequestId;
  const old = sound.spoken[0]; old.onstart(); assert.equal(session.state, "speaking");
  await session.send("停止播报");
  assert.equal(sound.cancels, 1); assert.equal(sound.voice.outputState, "idle");
  assert.equal(session.state, "idle"); assert.equal(session.currentRequestId, id);
  assert.deepEqual(session.messages.at(-1), result);
  await session.send("查看上次数据"); const next = session.currentRequestId;
  sound.spoken.at(-1).onstart();
  old.onend(); old.onerror();
  assert.equal(session.state, "speaking"); assert.equal(session.currentRequestId, next);
  await session.send("取消当前任务");
  assert.equal(session.currentRequestId, null); assert.equal(session.state, "cancelled");
  assert.equal(sound.voice.outputState, "idle"); sound.voice.dispose();
});

test("speech stop during execution does not cancel it; voice cancellation uses send", async () => {
  const response = deferred(), polled = deferred();
  const session = new AssistantSession(api({ [`/api/task/${taskId}`]: () => { polled.resolve(); return response.promise; } }), null);
  const sound = audio(session);
  const operation = session.send("重新采集一次"); await polled.promise;
  const id = session.currentRequestId;
  await session.send("停止播报");
  assert.equal(session.currentRequestId, id); assert.equal(session.busy, true);
  sound.voice.start(); sound.recognizer.onaudiostart();
  sound.recognizer.onresult({ results: [Object.assign([{ transcript: "停止这个任务" }], { isFinal: true })] });
  sound.recognizer.onend(); await operation;
  assert.equal(session.currentRequestId, null); assert.equal(session.busy, false);
  response.resolve(taskResult()); await tick();
  assert.equal(sound.spoken.length, 0); sound.voice.dispose();
});

test("cancel interruptible polling sleep immediately releases the request", async () => {
  const session = new AssistantSession(api({ [`/api/task/${taskId}`]: () => ({ request_id: taskId, device, status: "PENDING" }) }), null);
  const waiting = deferred();
  session.subscribe(s => { if(s.messages.at(-1)?.phase === "waiting_device") waiting.resolve(); });
  const operation = session.send("重新采集一次"); await waiting.promise; await tick();
  const start = performance.now(); session.cancel(); await operation;
  assert.ok(performance.now() - start < 200);
  assert.equal(session.busy, false);
});
