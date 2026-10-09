import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  query_existing_data,
  collect_new_data,
  wait_for_collection,
  verifyTaskResult,
  COLLECTION_RESPONSE_TIMEOUT_MS,
  COLLECTION_RUNNING_TIMEOUT_MS,
} from "../web/services/assistantTools.js";
import { AssistantSession } from "../web/services/assistantSession.js";
import { AssistantVoice } from "../web/services/assistantVoice.js";

const device = "ESP32_S3_EYE";
let child, url, api;
const calls = [];
before(async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const python =
    process.env.PYTHON ||
    (process.platform === "win32" ? `${root}.venv/Scripts/python.exe` : "python3");
  child = spawn(python, ["tests/assistant_fixture.py"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${stderr}`)), 15000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Fixture exited ${code}: ${stderr}`));
    });
    createInterface({ input: child.stdout }).once("line", (line) => {
      clearTimeout(timer);
      resolve(JSON.parse(line).url);
    });
  });
  api = {
    async fetchJson(path, options = {}) {
      calls.push([options.method || "GET", path]);
      const response = await fetch(url + path, options);
      if (!response.ok) throw Object.assign(new Error("HTTP error"), { status: response.status });
      return response.json();
    },
    devices() {
      return this.fetchJson("/api/devices");
    },
  };
});
after(async () => {
  if (child && child.exitCode === null) {
    const exit = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.end("stop\n");
    await exit;
  }
});
async function parse(message, context = { device }) {
  return api.fetchJson("/api/assistant/interpret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, context }),
  });
}
function creationCount() {
  return calls.filter(([method, path]) => method === "POST" && path === "/api/task/create").length;
}
async function respond(requestId, fail = false) {
  return api.fetchJson("/__fixture__/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: requestId, fail }),
  });
}
function fastClock() {
  let clock = 0;
  return {
    timeoutMs: 10,
    pollMs: 5,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
}

test("1. 查看上次数据 reads an existing record and never creates a task", async () => {
  const beforeCount = creationCount();
  const parsed = await parse("查看上次数据");
  const result = await query_existing_data(api, parsed.parameters);
  assert.equal(result.status, "success");
  assert.equal(result.kind, "existing");
  assert.equal(result.samples[0].timestamp, "2026-01-01 08:00:00");
  assert.equal(creationCount(), beforeCount);
});
test("2-3. new collection creates exactly one task and returns its new result, never a newer periodic row", async () => {
  const old = await query_existing_data(api, (await parse("查看上次数据")).parameters);
  const beforeCount = creationCount();
  let responsePromise;
  const updates = [];
  const result = await collect_new_data(api, (await parse("重新采集一次")).parameters, {
    pollMs: 5,
    timeoutMs: 3000,
    onCreated: (task) => {
      responsePromise = respond(task.requestId);
    },
    onUpdate: (state) => updates.push(state),
  });
  await responsePromise;
  assert.equal(creationCount(), beforeCount + 1);
  assert.equal(result.status, "success", result.message);
  assert.equal(result.kind, "new");
  assert.equal(result.samples[0].acc_x, 0.42);
  assert.ok(result.samples[0].id > old.samples[0].id);
  assert.notEqual(result.samples[0].timestamp, old.samples[0].timestamp);
  assert.match(result.source, new RegExp(result.requestId));
  const latest = await api.fetchJson(`/api/latest?device=${device}`);
  assert.equal(latest.acc_x, 0.88);
  assert.ok(latest.id > result.samples[0].id);
  assert.ok(updates.every((u) => u.status === "waiting" && !u.message.includes("成功")));
});
test("4. missing device asks for clarification without creating even when inventory has one device", async () => {
  const count = creationCount();
  const parsed = await parse("重新采集一次", {});
  assert.equal(parsed.status, "clarify");
  assert.equal(parsed.parameters, null);
  assert.equal(creationCount(), count);
});
test("5. nonexistent device is rejected by both interpreter and restricted tools", async () => {
  const count = creationCount();
  assert.equal((await parse("重新采集设备FAKE99")).status, "invalid");
  const params = { ...(await parse("重新采集一次")).parameters, device: "FAKE99" };
  const result = await collect_new_data(api, params);
  assert.equal(result.status, "error");
  assert.match(result.message, /设备不存在/);
  assert.equal(creationCount(), count);
});
test("6. no device response reaches bounded wait and does not report success", async () => {
  const result = await collect_new_data(api, (await parse("获取最新数据")).parameters, fastClock());
  assert.equal(result.code, "device_unresponsive");
  assert.match(result.message, /设备无响应/);
  assert.ok(!result.message.includes("成功"));
  assert.equal(result.samples, undefined);
  assert.equal(result.resumable, true);
});
test("7. interface failure and ambiguous POST result are errors and never retried", async () => {
  const params = (await parse("重新采集一次")).parameters;
  let posts = 0;
  const broken = {
    ...api,
    async fetchJson(path, opts) {
      if (path === "/api/task/create") {
        posts++;
        throw Object.assign(new Error("offline"), { status: 503 });
      }
      return api.fetchJson(path, opts);
    },
  };
  const result = await collect_new_data(broken, params);
  assert.equal(posts, 1);
  assert.equal(result.status, "error");
  assert.equal(result.httpStatus, 503);
  assert.match(result.message, /提交结果未确认/);
  const readFailure = await query_existing_data(
    {
      devices: async () => {
        throw new Error("offline");
      },
    },
    { ...params, intent: "query_existing", mode: "latest" },
  );
  assert.equal(readFailure.status, "error");
});
test("8. 看看刚才的数据 only queries existing records", async () => {
  const count = creationCount();
  const parsed = await parse("看看刚才的数据");
  assert.equal(parsed.intent, "query_existing");
  const result = await query_existing_data(api, parsed.parameters);
  assert.equal(result.kind, "existing");
  assert.equal(creationCount(), count);
});
test("device failure is returned with real error and no invented samples", async () => {
  let responsePromise;
  const result = await collect_new_data(api, (await parse("重新采集一次")).parameters, {
    pollMs: 5,
    timeoutMs: 3000,
    onCreated: (task) => {
      responsePromise = respond(task.requestId, true);
    },
  });
  await responsePromise;
  assert.equal(result.code, "device_failed");
  assert.match(result.message, /sensor_error/);
  assert.equal(result.samples, undefined);
});
test("server TIMEOUT and mismatched SUCCESS evidence never become successful replies", async () => {
  const requestId = "12345678-1234-4123-8123-123456789abc";
  const expected = { requestId, device, baselineId: 1 };
  const base = { request_id: requestId, device, status: "TIMEOUT", error: "task timeout" };
  const timeout = await wait_for_collection({ fetchJson: async () => base }, expected);
  assert.equal(timeout.code, "task_timeout");
  const success = {
    ...base,
    status: "SUCCESS",
    action: "capture_once",
    created_at: 1790000000,
    sent_at: 1790000001,
    finished_at: 1790000002,
    result_sample_id: 2,
    result: {
      id: 2,
      device,
      sensor: "QMA6100P",
      timestamp: "2026-01-01 08:00:00",
      received_at: 1790000002,
      acc_x: 0.1,
      acc_y: 0.2,
      acc_z: 0.9,
    },
  };
  for (const task of [
    success,
    { ...success, device: "OTHER" },
    { ...success, result_sample_id: 99 },
    { ...success, result: { ...success.result, received_at: 1 } },
  ]) {
    assert.throws(() => verifyTaskResult(task, expected));
    assert.equal(
      (await wait_for_collection({ fetchJson: async () => task }, expected)).status,
      "error",
    );
  }
});
test("history date filters use existing records API and preserve sample times", async () => {
  const params = (await parse("查询2020-01-01的历史数据")).parameters;
  const result = await query_existing_data(api, params);
  assert.equal(result.status, "empty");
  assert.match(result.source, /^\/api\/records\?/);
});
test("conversation reuses explicit device and clarification context without executing unknown intent", async () => {
  const memory = new Map();
  const storage = {
    getItem: (key) => memory.get(key),
    setItem: (key, value) => memory.set(key, value),
    removeItem: (key) => memory.delete(key),
  };
  const session = new AssistantSession(api, storage);
  const count = creationCount();
  await session.send("查看上次数据");
  assert.equal(session.messages.at(-1).status, "clarify");
  await session.send("ESP32-S3-EYE");
  assert.equal(session.messages.at(-1).status, "success");
  assert.equal(session.context.device, device);
  await session.send("看看刚才的数据");
  assert.equal(session.messages.at(-1).kind, "existing");
  assert.equal(creationCount(), count);
});

test("limited clarification supplements the original collection intent and clears after completion/cancel", async () => {
  const session = new AssistantSession({
    ...api,
    async fetchJson(path, options) {
      const result = await api.fetchJson(path, options);
      if (path === "/api/task/create") await respond(result.request_id);
      return result;
    },
  }, null);
  const count = creationCount();
  await session.send("重新采集一次");
  assert.equal(session.state, "clarifying");
  assert.equal(session.shortContext.pending.intent, "collect_new");
  assert.deepEqual(session.shortContext.missing, ["device"]);
  const firstId = session.currentRequestId;
  await session.send("ESP32-S3-EYE");
  assert.equal(session.messages.at(-1).status, "success");
  assert.equal(session.messages.at(-1).kind, "new");
  assert.equal(creationCount(), count + 1);
  assert.equal(session.requests.get(session.currentRequestId).context_from, firstId);
  assert.notEqual(session.messages.at(-1).request_id, session.messages.at(-1).task_id);
  assert.equal(session.shortContext, null);
  assert.equal(session.context.pending, null);
  session.chooseDevice(null);
  await session.send("重新采集一次");
  await session.send("算了");
  assert.equal(session.shortContext, null); assert.equal(session.currentRequestId, null);
  await session.send("ESP32-S3-EYE");
  assert.equal(session.messages.at(-1).status, "clarify");
  assert.equal(creationCount(), count + 1);
  session.chooseDevice(null);
  await session.send("重新采集一次");
  await session.send("查看上次数据 ESP32-S3-EYE");
  assert.equal(session.messages.at(-1).kind, "existing");
  assert.equal(creationCount(), count + 1);
  assert.equal(session.shortContext, null);
});

test("conversation replaces pending submissions and resumes only the original task", async () => {
  const requestId = "12345678-1234-4123-8123-123456789abc";
  const memory = new Map([
    ["imu-assistant-task", JSON.stringify({ requestId, device, baselineId: 0 })],
  ]);
  const storage = {
    getItem: (key) => memory.get(key),
    setItem: (key, value) => memory.set(key, value),
    removeItem: (key) => memory.delete(key),
  };
  const requests = [];
  const restored = new AssistantSession(
    {
      fetchJson: async (path) => {
        requests.push(path);
        return { request_id: requestId, device, status: "TIMEOUT" };
      },
    },
    storage,
  );
  assert.equal(restored.context.device, device);
  await restored.resume();
  assert.deepEqual(requests, [`/api/task/${requestId}`]);
  assert.equal(restored.messages.at(-1).code, "task_timeout");
  assert.equal(memory.has("imu-assistant-task"), false);

  const releases = [];
  let
    posts = 0;
  const session = new AssistantSession(
    {
      fetchJson: async () => {
        posts++;
        await new Promise((resolve) => {
          releases.push(resolve);
        });
        return {
          status: "clarify",
          message: "请选择设备",
          context: { device: null, pending: null },
          devices: [],
        };
      },
    },
    storage,
  );
  const first = session.send("重新采集一次");
  const second = session.send("查看上次数据");
  assert.equal(posts, 2);
  releases[1]();
  await second;
  const current = session.currentRequestId;
  releases[0]();
  await first;
  assert.equal(session.currentRequestId, current);
  assert.equal(session.busy, false);
});

test("查询刚才采集的结果 reads the explicitly remembered task even after later tasks", async () => {
  let responsePromise, task;
  const fresh = await collect_new_data(api, (await parse("重新采集一次")).parameters, {
    pollMs: 5,
    timeoutMs: 3000,
    onCreated: (expected) => {
      task = expected;
      responsePromise = respond(expected.requestId);
    },
  });
  await responsePromise;
  assert.equal(fresh.status, "success");
  const count = creationCount();
  const oldResult = await query_existing_data(api, (await parse("看看刚才采集的结果")).parameters, {
    lastTask: task,
  });
  assert.equal(oldResult.kind, "existing");
  assert.equal(oldResult.requestId, task.requestId);
  assert.equal(oldResult.samples[0].id, fresh.samples[0].id);
  assert.equal(oldResult.samples[0].timestamp, fresh.samples[0].timestamp);
  assert.equal(creationCount(), count);
});

test("voice event text enters the existing HTTP assistant: query, new task, and failed device", async () => {
  let recognizer, pending, failDevice = false, offline = false;
  const spoken = [];
  class Recognition {
    constructor() { recognizer = this; }
    start() {} stop() {} abort() {}
  }
  const voice = new AssistantVoice({
    Recognition, secure: true,
    Utterance: class { constructor(text) { this.text = text; } },
    synthesis: { getVoices: () => [], speak: (u) => spoken.push(u), cancel() {} },
    onTranscript: (text) => { pending = session.send(text); },
  });
  const session = new AssistantSession({
    ...api,
    async fetchJson(path, options) {
      const result = await api.fetchJson(path, options);
      if (offline && path.startsWith("/api/latest?")) return { ...result, status: "offline" };
      if (path === "/api/task/create") await respond(result.request_id, failDevice);
      return result;
    },
  }, null);
  session.chooseDevice(device);
  let busy = false;
  session.subscribe((state) => {
    if (busy && !state.busy) voice.speak(state.messages.at(-1).message);
    busy = state.busy;
  });
  async function say(text) {
    voice.start(); recognizer.onaudiostart(); voice.stop();
    recognizer.onresult({results: [Object.assign([{transcript: text}], {isFinal: true})]});
    recognizer.onend(); await pending;
    return session.messages.at(-1);
  }
  try {
    const count = creationCount();
    assert.equal((await say("查看上次数据")).kind, "existing");
    assert.equal(creationCount(), count);
    const fresh = await say("重新采集一次");
    assert.equal(creationCount(), count + 1);
    assert.equal(fresh.status, "success");
    const task = await api.fetchJson(`/api/task/${fresh.task_id}`);
    assert.equal(task.result_sample_id, fresh.samples[0].id);
    assert.equal(fresh.samples[0].acc_x, 0.42);
    assert.equal(spoken.at(-1).text, fresh.message);
    failDevice = true;
    const failed = await say("重新采集一次");
    assert.equal(failed.code, "device_failed");
    assert.equal(spoken.at(-1).text, failed.message);
    assert.ok(!spoken.at(-1).text.includes("成功"));
    spoken.at(-1).onerror();
    assert.equal(session.messages.at(-1).message, failed.message);
    // The existing bounded-wait tool determines no-response; the voice layer only reads it.
    const absent = await collect_new_data(api, (await parse("重新采集一次")).parameters, fastClock());
    voice.speak(absent.message);
    assert.equal(absent.code, "device_unresponsive");
    assert.equal(spoken.at(-1).text, absent.message);
    assert.ok(!spoken.at(-1).text.includes("成功"));
    offline = true;
    const offlineCount = creationCount();
    const voiceOffline = await say("重新采集一次");
    assert.equal(voiceOffline.code, "device_offline");
    await session.send("重新采集一次");
    assert.equal(session.messages.at(-1).message, voiceOffline.message);
    assert.equal(spoken.at(-1).text, voiceOffline.message);
    assert.equal(creationCount(), offlineCount);
  } finally { voice.dispose(); }
});

test("offline precheck rejects before POST; unknown status fails closed", async () => {
  const parameters = (await parse("重新采集一次")).parameters;
  for (const status of ["offline", "unknown", undefined]) {
    const paths = [];
    const local = {
      devices: () => api.devices(),
      fetchJson: async (path) => {
        paths.push(path);
        assert.match(path, /^\/api\/latest\?/);
        return { device, id: 1, status };
      },
    };
    const result = await collect_new_data(local, parameters);
    assert.equal(result.code, status === "offline" ? "device_offline" : "invalid_response");
    assert.equal(result.requestId, undefined);
    assert.equal(result.samples, undefined);
    assert.equal(paths.length, 1);
  }
});

test("online precheck uses server status; disappearance uses 6 s receipt budget and preserves task", async () => {
  let clock = 0;
  const requestId = "12345678-1234-4123-8123-123456789abc";
  const progress = [], paths = [];
  const local = {
    devices: async () => ({ devices: [{ device }] }),
    fetchJson: async (path) => {
      paths.push(path);
      if (path.startsWith("/api/latest?")) return { device, id: 1, status: "online" };
      return { request_id: requestId, device, status: "PENDING" };
    },
  };
  const result = await collect_new_data(local, { intent: "collect_new", device, data_type: "acceleration" }, {
    now: () => clock, sleep: async (ms) => { clock += ms; }, onUpdate: (p) => progress.push(p),
  });
  assert.equal(clock, COLLECTION_RESPONSE_TIMEOUT_MS);
  assert.equal(clock, 6000);
  assert.equal(result.code, "device_unresponsive");
  assert.equal(result.requestId, requestId);
  assert.equal(result.resumable, true);
  assert.equal(paths.filter(p => p === "/api/task/create").length, 1);
  assert.deepEqual(progress.slice(0, 3).map(p => p.phase), ["checking_device", "creating_task", "waiting_device"]);
  assert.match(progress.at(-1).message, /已等待 5 秒/);
});

test("RUNNING receives one bounded capture window; repeated progress never renews it", async () => {
  let clock = 0;
  const requestId = "12345678-1234-4123-8123-123456789abc";
  const result = await wait_for_collection({ fetchJson: async () => ({
    request_id: requestId, device, status: clock < 2000 ? "SENT" : "RUNNING",
  }) }, { requestId, device }, { now: () => clock, sleep: async (ms) => { clock += ms; } });
  assert.equal(clock, 2000 + COLLECTION_RUNNING_TIMEOUT_MS);
  assert.equal(result.code, "wait_timeout");
  assert.equal(result.resumable, true);
  assert.equal(result.taskStatus, "RUNNING");
});

test("an in-flight task read cannot extend the receipt deadline", async () => {
  const requestId = "12345678-1234-4123-8123-123456789abc";
  const started = performance.now();
  const result = await wait_for_collection({ fetchJson: (path, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("deadline"), { name: "AbortError" })), { once: true });
  }) }, { requestId, device }, { timeoutMs: 40 });
  assert.ok(performance.now() - started < 1000);
  assert.equal(result.resumable, true);
  assert.notEqual(result.status, "success");
});
