"use strict";

(() => {
  const AXES = ["acc_x", "acc_y", "acc_z"];
  const COLORS = ["#18745b", "#b57024", "#527d9d"];
  const $ = (id) => document.getElementById(id);
  const timeFormat = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const numberFormat = new Intl.NumberFormat("zh-CN");
  const MAX_SAMPLES = 2000;
  const state = {
    latest: null, samples: [], historyCursor: null, windowSeconds: 60,
    loading: true, historyLoaded: false, connectionError: false, historyError: false,
    paused: false, frozenSamples: [], frozenAt: 0,
    serverTime: Date.now(), syncedAt: performance.now(),
    camera: null, cameraStatusFailed: false, tableDirty: true,
  };
  let pollTimer, statusTimer, reconnectTimer;
  let pollInFlight = false, statusInFlight = false, historyRequest = null;
  let socket = null, socketReady = false, lastSocketMessage = 0;
  let reconnectDelay = 1000, pollDelay = 200;
  let cameraRetryAt = 0, cameraFailed = false;
  let renderQueued = false;
  const requests = new Set();

  function setText(id, value) {
    const element = $(id);
    if (element.textContent !== value) element.textContent = value;
  }

  function serverNow() {
    return state.serverTime + performance.now() - state.syncedAt;
  }

  function displayNumber(value) {
    if (!Number.isFinite(value)) return "—";
    // Avoid displaying -0.000 after rounding small negative sensor noise.
    if (Math.abs(value) < 0.0005) return "0.000";
    return Math.abs(value) >= 10000 ? value.toExponential(2) : value.toFixed(3);
  }

  async function fetchJson(path) {
    const controller = new AbortController();
    requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(path, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
      requests.delete(controller);
    }
  }

  function updateStatus() {
    const sample = state.latest;
    const hasSample = sample?.id != null;
    const age = hasSample ? Math.max(0, (serverNow() - sample.received_at_ms) / 1000) : null;
    const online = hasSample && age <= (sample.offline_after_seconds || 10);
    const mode = state.connectionError ? "error" : state.loading ? "loading" : online ? "online" : "offline";
    document.body.dataset.state = mode;
    const labels = { error: "服务器连接异常", loading: "正在连接", online: "设备在线", offline: "设备离线" };
    $("header-status-text").textContent = labels[mode];
    setText("network-status", state.connectionError ? "服务器连接异常" : state.loading ? "服务器连接中" : "服务器已连接");
    setText("transport-status", socketReady ? "实时推送已连接" : state.connectionError ? "正在重试连接" : "增量轮询 · 自动恢复推送");
    $("connection-text").textContent = {
      error: "服务器无法连接", loading: "正在连接…", online: "设备在线", offline: hasSample ? "设备离线" : "等待设备连接",
    }[mode];
    $("last-received").textContent = age == null ? "—" : age < 1 ? "刚刚" : age < 60 ? `${Math.floor(age)} 秒前` : age < 3600 ? `${Math.floor(age / 60)} 分钟前` : `${Math.floor(age / 3600)} 小时前`;
    document.querySelectorAll(".value-caption").forEach((element) => {
      element.textContent = hasSample ? mode === "online" ? "最新测量值" : "上次测量值 · 已过期" : "等待首次采样";
    });
    const alert = $("alert");
    alert.hidden = mode === "online" || mode === "loading";
    alert.textContent = mode === "error"
      ? "无法连接服务器，正在自动重试。当前保留的上次测量值可能已过期。"
      : hasSample
        ? "⚠ 数据未更新，请检查设备连接。"
        : "⚠ 尚未收到设备数据，请检查连接，等待设备首次上传。";
    const recent = state.samples.filter((item) => item.received_at_ms >= serverNow() - 10000);
    const span = recent.length > 1 ? recent[recent.length - 1].received_at_ms - recent[0].received_at_ms : 0;
    setText("data-rate", online && age < 2 && span >= 1000
      ? `近 10 秒实际接收：${((recent.length - 1) * 1000 / span).toFixed(1)} 次/秒`
      : online ? "数据接收频率：正在统计" : "当前无新数据 · 保留历史记录");
  }

  function updateMeasurements(sample) {
    setText("device-name", !sample.device || sample.device === "ESP32_S3_EYE" ? "ESP32-S3-EYE" : sample.device);
    setText("sensor-name", sample.sensor || "QMA6100P");
    setText("header-time", sample.received_at_ms == null ? "—" : timeFormat.format(sample.received_at_ms));
    setText("sample-timestamp", sample.timestamp || "—");
    setText("sample-count", Number.isFinite(sample.total_samples) ? numberFormat.format(sample.total_samples) : "—");
    // The total comes from the server, not the bounded chart cache.
    setText("history-count", Number.isFinite(sample.total_samples) ? `共 ${numberFormat.format(sample.total_samples)} 条记录` : "等待统计");
    AXES.forEach((axis) => { setText(axis, displayNumber(sample[axis])); });
    setText("acc-magnitude", displayNumber(AXES.every((axis) => Number.isFinite(sample[axis]))
      ? Math.hypot(...AXES.map((axis) => sample[axis])) : null));
  }

  function syncClock(value) {
    if (!Number.isFinite(value)) return;
    state.serverTime = value;
    state.syncedAt = performance.now();
  }

  function validSample(sample) {
    return Number.isSafeInteger(sample?.id) && Number.isFinite(sample.received_at_ms)
      && AXES.every((axis) => Number.isFinite(sample[axis]));
  }

  function mergeSamples(samples) {
    const combined = [...state.samples, ...samples.filter(validSample)];
    const unique = new Map(combined.map((sample) => [sample.id, sample]));
    state.samples = [...unique.values()].sort((a, b) => a.received_at_ms - b.received_at_ms || a.id - b.id).slice(-MAX_SAMPLES);
    state.tableDirty = true;
    if (!state.paused) requestRender();
  }

  function acceptLatest(latest) {
    syncClock(latest.server_time_ms);
    // A status request started before a push must not replace a newer measurement.
    if (state.latest?.id != null && (latest.id == null || latest.id < state.latest.id)) return;
    state.latest = { ...state.latest, ...latest };
    if (validSample(latest)) mergeSamples([latest]);
    updateMeasurements(state.latest);
  }

  function acceptSample(sample, total) {
    if (!validSample(sample)) return;
    mergeSamples([sample]);
    if (state.latest?.id != null && sample.id < state.latest.id) return;
    state.latest = { ...state.latest, ...sample, offline_after_seconds: 10 };
    if (Number.isFinite(total)) state.latest.total_samples = total;
    updateMeasurements(state.latest);
  }

  function loadHistory() {
    if (historyRequest) return historyRequest;
    historyRequest = (async () => {
      try {
        const suffix = state.historyCursor == null ? "" : `&after_id=${state.historyCursor}`;
        let result = await fetchJson(`/api/history?limit=${MAX_SAMPLES}${suffix}`);
        // Bound catch-up work after suspension; never fill gaps with generated points.
        if (result.has_more) result = await fetchJson(`/api/history?limit=${MAX_SAMPLES}`);
        const samples = result.samples.filter(validSample);
        if (samples.length) {
          mergeSamples(samples);
          const newest = samples.reduce((best, item) => item.id > best.id ? item : best);
          state.historyCursor = newest.id;
          acceptSample(newest);
        } else if (state.historyCursor == null) {
          state.historyCursor = 0;
        }
        state.historyLoaded = true;
        state.historyError = false;
        state.tableDirty = true;
      } catch (error) {
        if (!document.hidden) { state.historyError = true; state.tableDirty = true; }
        throw error;
      } finally {
        historyRequest = null;
        $("history-error").hidden = !state.historyError;
        if (!state.paused) requestRender();
      }
    })();
    return historyRequest;
  }

  async function pollFallback() {
    if (pollInFlight || document.hidden || socketReady) return;
    pollInFlight = true;
    try {
      await loadHistory();
      state.connectionError = false;
      state.loading = false;
      pollDelay = 200;
    } catch (error) {
      if (!document.hidden) {
        if (!socketReady) state.connectionError = true;
        state.loading = false;
        pollDelay = Math.min(5000, pollDelay * 2);
      }
    } finally {
      pollInFlight = false;
      updateStatus();
      clearTimeout(pollTimer);
      if (!document.hidden && !socketReady) pollTimer = setTimeout(pollFallback, pollDelay);
    }
  }

  function stopCamera() {
    const image = $("camera-image");
    image.hidden = true;
    image.removeAttribute("src");
    $("camera-empty").hidden = false;
  }

  function updateCamera() {
    const camera = state.camera;
    const recentFrame = Number.isFinite(camera?.last_frame_at_ms) && serverNow() - camera.last_frame_at_ms <= 5000;
    let mode = camera?.status || "connecting";
    if (state.cameraStatusFailed || (mode === "online" && !recentFrame)) mode = "offline";
    if (cameraFailed && performance.now() < cameraRetryAt) mode = "offline";
    document.querySelector(".camera-panel").dataset.state = mode;
    setText("camera-status", { online: "摄像头在线", offline: "摄像头离线", connecting: "正在连接" }[mode] || "摄像头离线");
    setText("camera-fps", mode === "online" && Number.isFinite(camera?.fps) ? `${camera.fps.toFixed(1)} FPS` : "— FPS");
    setText("camera-mode", mode === "online" ? "实时" : "等待视频流");
    if (document.hidden || mode !== "online") {
      stopCamera();
      setText("camera-message", mode === "connecting" ? "正在检查摄像头连接" : "摄像头离线");
      setText("camera-detail", "等待视频流 · 连接恢复后自动重试");
      return;
    }
    const image = $("camera-image");
    if (!image.hasAttribute("src")) {
      cameraFailed = false;
      setText("camera-message", "正在接收实时画面");
      setText("camera-detail", "等待真实视频画面");
      image.src = `/api/camera?connection=${Date.now()}`;
    }
    image.hidden = false;
    // Some browsers do not dispatch MJPEG load until the stream ends.
    $("camera-empty").hidden = image.naturalWidth > 0;
  }

  async function pollStatus() {
    if (statusInFlight || document.hidden) return;
    statusInFlight = true;
    try {
      const result = await fetchJson("/api/status");
      state.loading = false;
      state.connectionError = false;
      state.cameraStatusFailed = false;
      state.camera = result.camera;
      acceptLatest(result);
      if (!state.historyLoaded || state.historyError) loadHistory().catch(() => {});
    } catch (error) {
      if (!document.hidden) {
        state.cameraStatusFailed = true;
        if (!socketReady) state.connectionError = true;
        state.loading = false;
      }
    } finally {
      statusInFlight = false;
      updateStatus();
      updateCamera();
      clearTimeout(statusTimer);
      if (!document.hidden) statusTimer = setTimeout(pollStatus, state.connectionError ? 4000 : 2000);
    }
  }

  function scheduleSocketReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSocket, reconnectDelay);
    reconnectDelay = Math.min(15000, reconnectDelay * 2);
  }

  function connectSocket() {
    if (document.hidden || socket || typeof WebSocket !== "function") return;
    let current;
    try {
      current = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/telemetry`);
    } catch (error) {
      // A browser restriction can throw before onerror exists. Keep HTTP
      // polling and camera startup working, and retry push with backoff.
      scheduleSocketReconnect();
      return;
    }
    socket = current;
    lastSocketMessage = performance.now();
    current.onmessage = (event) => {
      if (socket !== current || document.hidden) return;
      try {
        const message = JSON.parse(event.data);
        if (!["snapshot", "sample", "heartbeat"].includes(message.type)) return;
        lastSocketMessage = performance.now();
        socketReady = true;
        reconnectDelay = 1000;
        state.connectionError = false;
        state.loading = false;
        clearTimeout(pollTimer);
        syncClock(message.server_time_ms);
        if (message.type === "snapshot") {
          acceptLatest(message.latest);
          loadHistory().catch(() => {});
        } else if (message.type === "sample") {
          acceptSample(message.sample, message.total_samples);
        }
      } catch (error) {
        current.close();
      }
    };
    current.onerror = () => { current.close(); };
    current.onclose = () => {
      if (socket !== current) return;
      socket = null;
      socketReady = false;
      if (document.hidden) return;
      pollFallback();
      scheduleSocketReconnect();
    };
  }

  function renderHistoryTable() {
    if (!state.tableDirty) return;
    state.tableDirty = false;
    const samples = [...state.samples].sort((a, b) => b.id - a.id).slice(0, 6);
    const rows = document.createDocumentFragment();
    for (const sample of samples) {
      const row = document.createElement("tr");
      const values = [numberFormat.format(sample.id), timeFormat.format(sample.received_at_ms),
        ...AXES.map((axis) => displayNumber(sample[axis])), displayNumber(Math.hypot(...AXES.map((axis) => sample[axis])))];
      for (const value of values) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      rows.append(row);
    }
    if (!samples.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 6;
      cell.className = "table-empty";
      cell.textContent = state.historyError ? "历史记录加载失败，正在重试" : state.historyLoaded ? "暂无真实采样记录，等待设备上传" : "正在加载历史记录…";
      row.append(cell);
      rows.append(row);
    }
    $("history-rows").replaceChildren(rows);
  }

  function chartBounds(values, minimumPadding) {
    let low = values.length ? Math.min(...values) : -1;
    let high = values.length ? Math.max(...values) : 1;
    const padding = Math.max((high - low) * 0.12, minimumPadding);
    low -= padding;
    high += padding;
    const roughStep = (high - low) / 4;
    const power = 10 ** Math.floor(Math.log10(roughStep));
    const step = [1, 2, 2.5, 5, 10].find((factor) => factor * power >= roughStep) * power;
    return { low: Math.floor(low / step) * step, high: Math.ceil(high / step) * step, step };
  }

  class SignalChart {
    constructor(prefix, keys) {
      this.canvas = $(`${prefix}-chart`);
      this.context = this.canvas.getContext("2d");
      this.empty = $(`${prefix}-empty`);
      this.tooltip = $(`${prefix}-tooltip`);
      this.keys = keys;
      this.pointerX = null;
      this.canvas.addEventListener("pointermove", (event) => {
        this.pointerX = event.clientX - this.canvas.getBoundingClientRect().left;
        requestRender();
      });
      this.canvas.addEventListener("pointerleave", () => {
        this.pointerX = null;
        this.tooltip.hidden = true;
        requestRender();
      });
      this.resizeObserver = new ResizeObserver(requestRender);
      this.resizeObserver.observe(this.canvas.parentElement);
    }

    draw(samples, end) {
      const width = this.canvas.clientWidth;
      const height = this.canvas.clientHeight;
      if (!width || !height) return;
      const ratio = window.devicePixelRatio || 1;
      const pixelWidth = Math.round(width * ratio);
      const pixelHeight = Math.round(height * ratio);
      if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
        this.canvas.width = pixelWidth;
        this.canvas.height = pixelHeight;
      }
      const ctx = this.context;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const start = end - state.windowSeconds * 1000;
      const visible = samples.filter((sample) => sample.received_at_ms >= start && sample.received_at_ms <= end);
      const values = visible.flatMap((sample) => this.keys.map((key) => sample[key]));
      const bounds = chartBounds(values, 0.05);
      const stepExponent = Math.floor(Math.log10(bounds.step));
      const fractionalStep = Math.abs(bounds.step / 10 ** stepExponent - 2.5) < 1e-8;
      const tickDecimals = Math.max(0, -stepExponent + (fractionalStep ? 1 : 0));
      const left = 46, right = width - 8, top = 10, bottom = height - 30;
      const x = (timestamp) => left + (timestamp - start) / (end - start) * (right - left);
      const y = (value) => bottom - (value - bounds.low) / (bounds.high - bounds.low) * (bottom - top);
      ctx.font = '12px Consolas, "Liberation Mono", monospace';
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (let value = bounds.low; value <= bounds.high + bounds.step / 2; value += bounds.step) {
        const row = y(value);
        ctx.strokeStyle = Math.abs(value) < 1e-9 ? "#dce2e5" : "#edf0f2";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(left, row); ctx.lineTo(right, row); ctx.stroke();
        ctx.fillStyle = "#737f88";
        const label = Math.abs(value) >= 1000 ? value.toExponential(1) : value.toFixed(tickDecimals);
        ctx.fillText(label.replace(/^-0(\.0+)?$/, "0"), left - 9, row);
      }
      // Endpoint labels are inset; leave enough room for full HH:mm:ss labels.
      const divisions = Math.max(1, Math.min(4, Math.floor((right - left) / 96)));
      for (let i = 0; i <= divisions; i++) {
        const timestamp = start + (end - start) * i / divisions;
        ctx.textAlign = i === 0 ? "left" : i === divisions ? "right" : "center";
        ctx.fillStyle = "#737f88";
        ctx.fillText(timeFormat.format(timestamp), x(timestamp), height - 12);
      }
      ctx.save();
      ctx.beginPath(); ctx.rect(left - 2, top - 2, right - left + 4, bottom - top + 4); ctx.clip();
      this.keys.forEach((key, index) => {
        ctx.strokeStyle = COLORS[index];
        ctx.fillStyle = COLORS[index];
        ctx.lineWidth = 1.6;
        ctx.lineJoin = "round";
        ctx.beginPath();
        visible.forEach((sample, sampleIndex) => {
          const previous = visible[sampleIndex - 1];
          if (!previous || sample.received_at_ms - previous.received_at_ms > 10000) ctx.moveTo(x(sample.received_at_ms), y(sample[key]));
          else ctx.lineTo(x(sample.received_at_ms), y(sample[key]));
        });
        ctx.stroke();
        // Dots also make a single real sample visible before a line can be drawn.
        visible.forEach((sample, index) => {
          if (visible.length < 3 || index === visible.length - 1 || !index || sample.received_at_ms - visible[index - 1].received_at_ms > 10000) {
            ctx.beginPath(); ctx.arc(x(sample.received_at_ms), y(sample[key]), 2.2, 0, Math.PI * 2); ctx.fill();
          }
        });
      });
      ctx.restore();
      this.empty.hidden = visible.length > 0;
      if (!visible.length) {
        this.empty.querySelector("strong").textContent = state.connectionError ? "服务器连接不可用" : state.historyError ? "历史数据加载失败" : !state.historyLoaded ? "正在加载历史数据…" : state.samples.length ? "当前时间窗口内暂无采样" : "等待传感器数据";
        this.empty.querySelector("span:last-child").textContent = state.connectionError || state.historyError ? "正在自动重试，服务器恢复后将继续加载。" : "设备上传数据后显示测量值。";
      }
      this.canvas.closest(".chart-panel").querySelector(".chart-point-count").textContent = numberFormat.format(visible.length);
      this.tooltip.hidden = true;
      if (visible.length && this.pointerX != null && this.pointerX >= left && this.pointerX <= right) {
        const nearest = visible.reduce((best, sample) => Math.abs(x(sample.received_at_ms) - this.pointerX) < Math.abs(x(best.received_at_ms) - this.pointerX) ? sample : best);
        const position = x(nearest.received_at_ms);
        ctx.strokeStyle = "#a7b2ba"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(position, top); ctx.lineTo(position, bottom); ctx.stroke(); ctx.setLineDash([]);
        this.tooltip.textContent = [timeFormat.format(nearest.received_at_ms), ...this.keys.map((key, index) => `${"XYZ"[index]} 轴  ${displayNumber(nearest[key])}`)].join("\n");
        this.tooltip.hidden = false;
        this.tooltip.style.left = `${Math.max(0, Math.min(position + 12, width - this.tooltip.offsetWidth - 4))}px`;
        this.tooltip.style.top = "12px";
      }
    }
  }

  const charts = [new SignalChart("acc", AXES)];

  function requestRender() {
    if (renderQueued || document.hidden) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const samples = state.paused ? state.frozenSamples : state.samples;
      const end = state.paused ? state.frozenAt : serverNow();
      charts.forEach((chart) => chart.draw(samples, end));
    });
  }

  document.querySelectorAll("[data-window]").forEach((button) => {
    button.addEventListener("click", () => {
      state.windowSeconds = Number(button.dataset.window);
      document.querySelectorAll("[data-window]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      requestRender();
    });
  });
  $("pause-button").addEventListener("click", () => {
    state.paused = !state.paused;
    state.frozenSamples = state.paused ? state.samples.slice() : [];
    state.frozenAt = serverNow();
    $("pause-button").setAttribute("aria-pressed", String(state.paused));
    $("pause-label").textContent = state.paused ? "恢复曲线" : "冻结曲线";
    $("pause-icon").querySelector("path").setAttribute("d", state.paused ? "M5 3l7 5-7 5Z" : "M5 3v10M11 3v10");
    $("chart-mode").textContent = state.paused ? "曲线已冻结 · 测量值继续更新" : "按服务器接收时间 · 实时数据";
    requestRender();
  });
  document.addEventListener("visibilitychange", () => {
    clearTimeout(pollTimer);
    clearTimeout(statusTimer);
    clearTimeout(reconnectTimer);
    if (document.hidden) {
      requests.forEach((controller) => controller.abort());
      const previous = socket;
      socket = null;
      socketReady = false;
      previous?.close();
      stopCamera();
    } else {
      updateStatus();
      connectSocket();
      pollStatus();
      pollFallback();
      requestRender();
    }
  });
  $("camera-image").addEventListener("error", () => {
    if (!$("camera-image").hasAttribute("src") || document.hidden) return;
    cameraFailed = true;
    cameraRetryAt = performance.now() + 3000;
    updateCamera();
  });
  $("camera-image").addEventListener("load", () => { if (!document.hidden) updateCamera(); });
  // Update stale state even while an HTTP request is still waiting for its timeout.
  setInterval(() => {
    if (document.hidden) return;
    if (socket && performance.now() - lastSocketMessage > 6000) socket.close();
    updateStatus();
    updateCamera();
    if (!state.paused) requestRender();
  }, 500);
  setInterval(() => { if (!document.hidden) renderHistoryTable(); }, 1000);
  requestRender();
  connectSocket();
  pollStatus();
  pollFallback();
})();
