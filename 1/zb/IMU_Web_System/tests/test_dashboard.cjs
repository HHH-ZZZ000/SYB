// Isolated startup/recovery tests. Execute the actual dashboard script without
// network access, hardware, generated measurements, or production database writes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const settle = () => new Promise((resolve) => setImmediate(resolve));

function dashboard(WebSocket) {
  const elements = new Map();
  const timers = new Map();
  const intervals = new Map();
  const listeners = new Map();
  const requests = [];
  let nextTimer = 0;
  let clock = 0;
  function element(key) {
    if (!elements.has(key)) {
      elements.set(key, {
        textContent: "", hidden: false, dataset: {}, parentElement: {},
        addEventListener() {}, getContext() { return {}; }, removeAttribute() {},
        setAttribute() {},
      });
    }
    return elements.get(key);
  }
  const document = {
    hidden: false, body: { dataset: {} },
    getElementById: element, querySelector: element, querySelectorAll: () => [],
    addEventListener: (name, callback) => listeners.set(name, callback),
  };
  const latest = {
    id: null, total_samples: 0, received_at_ms: null, server_time_ms: Date.now(),
    camera: { status: "offline", last_frame_at_ms: null, fps: null },
  };
  const context = vm.createContext({
    document, WebSocket, Intl, Date, Math, AbortController,
    performance: { now: () => clock }, location: { protocol: "http:", host: "isolated.invalid" },
    ResizeObserver: class { observe() {} }, requestAnimationFrame() {},
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay, at: clock + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval(callback, delay) { intervals.set(delay, callback); },
    async fetch(url, options) {
      assert.equal(options.method, undefined, "Dashboard must only read data");
      requests.push(url);
      return { ok: true, json: async () => url === "/api/status" ? latest : { samples: [], has_more: false } };
    },
  });
  vm.runInContext(script, context, { filename: "web/app.js" });
  return {
    document, latest, requests, timers, element,
    async timer(delay) {
      const target = clock + delay;
      while (true) {
        const entry = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        clock = entry[1].at;
        timers.delete(entry[0]);
        await entry[1].callback();
        await settle();
      }
      clock = target;
    },
    tick: () => intervals.get(500)(),
    visibility(hidden) { document.hidden = hidden; listeners.get("visibilitychange")(); },
  };
}

class Socket {
  close() { this.onclose?.(); }
}

test("missing WebSocket still starts status and repeated history polling", async () => {
  const app = dashboard(undefined);
  await settle();
  assert.ok(app.requests.includes("/api/status"));
  assert.ok(app.requests.includes("/api/history?limit=2000"));
  assert.equal(app.document.body.dataset.state, "offline");
  assert.equal(app.element("transport-status").textContent, "增量轮询 · 自动恢复推送");
  await app.timer(200);
  assert.ok(app.requests.includes("/api/history?limit=2000&after_id=0"));
});

test("constructor failures keep polling and retry until push becomes available", async () => {
  let attempts = 0;
  let socket;
  const app = dashboard(class {
    constructor() {
      if (++attempts < 3) throw new Error("Connection blocked by browser");
      return (socket = new Socket());
    }
  });
  await settle();
  assert.ok(app.requests.includes("/api/status"));
  await app.timer(200);
  await app.timer(1000);
  await app.timer(2000);
  assert.equal(attempts, 3);
  socket.onmessage({ data: JSON.stringify({ type: "snapshot", latest: app.latest }) });
  await settle();
  app.tick();
  assert.equal(app.element("transport-status").textContent, "实时推送已连接");
  assert.ok(![...app.timers.values()].some((timer) => timer.delay === 200));
  const previousReads = app.requests.length;
  socket.close();
  await settle();
  assert.ok(app.requests.length > previousReads, "Disconnect must resume polling");
});

test("hidden pages cancel failed-connection retries and resume when visible", async () => {
  let attempts = 0;
  const app = dashboard(class { constructor() { attempts++; throw new Error("Blocked"); } });
  await settle();
  app.visibility(true);
  assert.equal(app.timers.size, 0);
  app.visibility(false);
  await settle();
  assert.equal(attempts, 2);
  assert.ok(app.requests.filter((url) => url === "/api/status").length >= 2);
});
