import { DEFAULT_DEVICE, toDevice, validSample, mergeSamples } from "../models/Device.js";

// One shared transport for all routes. Page changes never create extra sockets.
export class TelemetryStore {
  constructor(api, prefs, env = globalThis) {
    this.api = api;
    this.prefs = prefs;
    this.env = env;
    this.listeners = new Set();
    this.selected = DEFAULT_DEVICE;
    this.raw = new Map();
    this.samples = [];
    this.loading = true;
    this.error = false;
    this.historyError = false;
    this.historyLoaded = false;
    this.inventoryError = false;
    this.inventoryLoaded = false;
    this.cursor = null;
    this.serverTime = Date.now();
    this.syncedAt = env.performance.now();
    this.socket = null;
    this.socketReady = false;
    this.generation = 0;
    this.retryDelay = 1000;
    this.running = false;
    this.timers = new Map();
    this.jobs = new Map();
  }
  now() {
    return this.serverTime + this.env.performance.now() - this.syncedAt;
  }
  syncClock(value) {
    if (Number.isFinite(value)) {
      this.serverTime = value;
      this.syncedAt = this.env.performance.now();
    }
  }
  snapshot() {
    const now = this.now();
    const devices = [...this.raw.values()].map((raw) => toDevice(raw, now, this.error));
    const device =
      devices.find((d) => d.id === this.selected) || toDevice({ device: this.selected }, now, true);
    return {
      devices,
      device,
      samples: this.samples,
      now,
      loading: this.loading,
      error: this.error,
      historyError: this.historyError,
      historyLoaded: this.historyLoaded,
      inventoryError: this.inventoryError,
      inventoryLoaded: this.inventoryLoaded,
      socketReady: this.socketReady,
      prefs: this.prefs,
    };
  }
  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }
  emit() {
    const snapshot = this.snapshot();
    this.listeners.forEach((fn) => fn(snapshot));
  }
  acceptLatest(raw) {
    this.syncClock(raw.server_time_ms);
    const id = raw.device || this.selected,
      previous = this.raw.get(id);
    // Preserve newer pushed measurements while still accepting independent camera state.
    const stale = previous?.id != null && (raw.id == null || raw.id < previous.id);
    this.raw.set(
      id,
      stale
        ? { ...previous, ...(raw.camera ? { camera: raw.camera } : {}) }
        : { ...previous, ...raw, device: id },
    );
    if (id === this.selected && validSample(raw)) this.samples = mergeSamples(this.samples, [raw]);
  }
  acceptSample(sample, total) {
    if (!validSample(sample) || sample.device !== this.selected) return;
    this.acceptLatest({ ...sample, ...(Number.isFinite(total) ? { total_samples: total } : {}) });
  }
  schedule(key, fn, delay) {
    this.env.clearTimeout(this.timers.get(key));
    if (this.running && !this.env.document.hidden)
      this.timers.set(key, this.env.setTimeout(fn, delay));
  }
  async history() {
    const generation = this.generation;
    if (this.jobs.get("history")?.generation === generation)
      return this.jobs.get("history").promise;
    const promise = (async () => {
      try {
        let result = await this.api.history(this.selected, this.cursor);
        if (generation !== this.generation) return;
        if (result.has_more) result = await this.api.history(this.selected, null);
        if (generation !== this.generation) return;
        const samples = result.samples
          .filter(validSample)
          .filter((row) => row.device === this.selected);
        this.samples = mergeSamples(this.samples, samples);
        if (samples.length) {
          const newest = samples.reduce((a, b) => (a.id > b.id ? a : b));
          this.cursor = newest.id;
          this.acceptSample(newest);
        } else if (this.cursor == null) this.cursor = 0;
        this.historyLoaded = true;
        this.historyError = false;
      } catch (error) {
        if (generation === this.generation && !this.env.document.hidden) this.historyError = true;
        throw error;
      } finally {
        if (generation === this.generation) {
          this.jobs.delete("history");
          this.emit();
        }
      }
    })();
    this.jobs.set("history", { generation, promise });
    return promise;
  }
  async poll() {
    if (!this.running || this.env.document.hidden || this.socketReady || this.jobs.has("poll"))
      return;
    const generation = this.generation;
    this.jobs.set("poll", true);
    try {
      await this.history();
      if (generation === this.generation) {
        this.error = false;
        this.loading = false;
      }
    } catch {
      if (generation === this.generation && !this.socketReady) {
        this.error = true;
        this.loading = false;
      }
    } finally {
      if (generation === this.generation) {
        this.jobs.delete("poll");
        this.emit();
        this.schedule("poll", () => this.poll(), this.error ? 4000 : this.prefs.refreshMs);
      }
    }
  }
  async status() {
    if (!this.running || this.env.document.hidden || this.jobs.has("status")) return;
    const generation = this.generation;
    this.jobs.set("status", true);
    try {
      const raw = await this.api.status(this.selected);
      if (generation !== this.generation) return;
      this.acceptLatest(raw);
      this.error = false;
      this.loading = false;
      if (this.historyError || !this.historyLoaded) this.history().catch(() => {});
    } catch {
      if (generation === this.generation) {
        if (!this.socketReady) this.error = true;
        this.loading = false;
      }
    } finally {
      if (generation === this.generation) {
        this.jobs.delete("status");
        this.emit();
        this.schedule("status", () => this.status(), 2000);
      }
    }
  }
  async inventory() {
    if (!this.running || this.env.document.hidden || this.jobs.has("inventory")) return;
    const generation = this.generation;
    this.jobs.set("inventory", true);
    try {
      const result = await this.api.devices();
      if (generation !== this.generation) return;
      result.devices.forEach((raw) => this.acceptLatest(raw));
      this.inventoryLoaded = true;
      this.inventoryError = false;
    } catch {
      if (generation === this.generation) this.inventoryError = true;
    } finally {
      if (generation === this.generation) {
        this.jobs.delete("inventory");
        this.emit();
        this.schedule("inventory", () => this.inventory(), 5000);
      }
    }
  }
  connect() {
    const env = this.env;
    if (!this.running || env.document.hidden || this.socket || typeof env.WebSocket !== "function")
      return;
    const retry = () => {
      this.schedule("retry", () => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(15000, this.retryDelay * 2);
    };
    let socket;
    try {
      socket = new env.WebSocket(
        `${env.location.protocol === "https:" ? "wss:" : "ws:"}//${env.location.host}/ws/telemetry?device=${encodeURIComponent(this.selected)}`,
      );
    } catch {
      retry();
      return;
    }
    this.socket = socket;
    this.lastMessage = env.performance.now();
    socket.onmessage = (event) => {
      if (this.socket !== socket || env.document.hidden) return;
      try {
        const message = JSON.parse(event.data);
        if (!["snapshot", "sample", "heartbeat"].includes(message.type)) return;
        this.lastMessage = env.performance.now();
        this.socketReady = true;
        this.retryDelay = 1000;
        this.error = false;
        this.loading = false;
        env.clearTimeout(this.timers.get("poll"));
        this.syncClock(message.server_time_ms);
        if (message.type === "snapshot") {
          this.acceptLatest(message.latest);
          this.history().catch(() => {});
        }
        if (message.type === "sample") this.acceptSample(message.sample, message.total_samples);
      } catch {
        socket.close();
      }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.socketReady = false;
      this.emit();
      this.poll();
      retry();
    };
  }
  suspend() {
    this.generation++;
    this.timers.forEach((timer) => this.env.clearTimeout(timer));
    this.timers.clear();
    this.jobs.clear();
    this.api.abort();
    const previous = this.socket;
    this.socket = null;
    this.socketReady = false;
    previous?.close();
  }
  resume() {
    if (this.running) {
      this.connect();
      this.status();
      this.poll();
      this.inventory();
      this.emit();
    }
  }
  select(id) {
    if (id === this.selected) return;
    this.suspend();
    this.selected = id;
    this.samples = [];
    this.cursor = null;
    this.historyLoaded = false;
    this.historyError = false;
    this.loading = true;
    this.resume();
  }
  async refresh() {
    await Promise.allSettled([this.status(), this.inventory(), this.history()]);
    this.emit();
    return !this.error && !this.historyError && !this.inventoryError;
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.visibility = () => {
      if (this.env.document.hidden) this.suspend();
      else this.resume();
    };
    this.env.document.addEventListener("visibilitychange", this.visibility);
    this.interval = this.env.setInterval(() => {
      if (this.env.document.hidden) return;
      if (this.socket && this.env.performance.now() - this.lastMessage > 6000) this.socket.close();
      this.emit();
    }, 200);
    this.resume();
  }
  stop() {
    this.running = false;
    this.suspend();
    this.env.clearInterval(this.interval);
    this.env.document.removeEventListener("visibilitychange", this.visibility);
  }
}
