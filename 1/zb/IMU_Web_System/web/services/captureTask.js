import { AXES } from "../models/Device.js";
// Task protocol and Chinese status/error handling extracted from the existing dashboard.
export function mountCaptureTask(panel, captureButton, api, deviceId) {
  const AXIS_TEXT = { acc_x: "第一轴", acc_y: "第二轴", acc_z: "第三轴" };
  const state = { latest: { device: deviceId } };
  const $ = (id) => (id === "capture-button" ? captureButton : panel.querySelector("#" + id));
  const setText = (id, value) => {
    const node = $(id);
    if (node.textContent !== value) node.textContent = value;
  };
  const fetchJson = (...args) => api.fetchJson(...args);
  let disposed = false,
    captureTaskId = null,
    taskTimer,
    latestTaskTimer,
    taskInFlight = false,
    latestTaskInFlight = false,
    taskActive = false;
  const storageKey =
    deviceId === "ESP32_S3_EYE" ? "imu-last-capture" : "imu-last-capture:" + deviceId;
  try {
    captureTaskId = sessionStorage.getItem(storageKey);
  } catch {}
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      captureTaskId || "",
    )
  )
    captureTaskId = null;
  const STATUS_TEXT = {
    PENDING: "等待设备",
    SENT: "任务已下发",
    RUNNING: "正在采集",
    SUCCESS: "采集完成",
    FAILED: "执行失败",
    TIMEOUT: "任务超时",
  };
  const TASK_ERROR_TEXT = {
    "task timeout": "任务超时，未能及时收到设备执行结果。",
    capture_queue_busy: "设备采集队列繁忙，请稍后重试。",
    capture_timeout: "设备采集超时，请检查传感器连接。",
    sensor_or_clock_error: "传感器读取或设备时间同步异常，请检查设备。",
    sensor_error: "传感器读取异常，请检查设备。",
    invalid_sensor_result: "本次采样结果无效，请检查传感器。",
    upload_unconfirmed: "采样结果上传尚未确认，请检查设备与服务器连接。",
  };
  function statusText(labels, status, fallback = "未知状态") {
    return Object.hasOwn(labels, status) ? labels[status] : fallback;
  }

  function taskErrorText(error) {
    return error
      ? statusText(TASK_ERROR_TEXT, error, "任务执行异常，请根据任务编号查看服务器记录。")
      : "等待本次任务的真实采样结果，不使用历史读数替代。";
  }

  function displayNumber(value) {
    if (!Number.isFinite(value)) return "—";
    // Avoid displaying -0.000 after rounding small negative sensor noise.
    if (Math.abs(value) < 0.0005) return "0.000";
    return Math.abs(value) >= 10000
      ? value.toExponential(2).replace("e", "×10^")
      : value.toFixed(3);
  }

  async function pollCaptureTask() {
    if (!captureTaskId || taskInFlight || document.hidden || disposed) return;
    taskInFlight = true;
    const requestId = captureTaskId;
    try {
      const task = await fetchJson(`/api/task/${requestId}`);
      if (disposed || requestId !== captureTaskId) return;
      taskActive = !["SUCCESS", "FAILED", "TIMEOUT"].includes(task.status);
      setText("task-status", statusText(STATUS_TEXT, task.status));
      setText("task-request-id", requestId);
      if (task.status === "SUCCESS") {
        const sample = task.result;
        setText(
          "task-result",
          sample &&
            sample.id === task.result_sample_id &&
            AXES.every((axis) => Number.isFinite(sample[axis]))
            ? `采样记录编号：${sample.id} · ${AXES.map((axis) => `${AXIS_TEXT[axis]} ${displayNumber(sample[axis])} 倍`).join(" · ")} · 采样时间 ${sample.timestamp}`
            : "任务已完成，但关联结果不可用，请检查服务器记录。",
        );
      } else {
        setText("task-result", taskErrorText(task.error));
      }
    } catch (error) {
      if (disposed || requestId !== captureTaskId) return;
      if (error.status === 404 || error.status === 400) {
        taskActive = false;
        setText("task-status", "任务不存在或编号无效");
        setText("task-result", "请确认连接的是创建该任务的服务器。");
        try {
          sessionStorage.removeItem(storageKey);
        } catch (_) {
          /* Optional persistence. */
        }
      } else {
        taskActive = true;
        if (!(document.hidden || disposed)) setText("task-status", "任务状态查询失败，正在重试");
      }
    } finally {
      taskInFlight = false;
      if (disposed) return;
      $("capture-button").disabled = taskActive;
      clearTimeout(taskTimer);
      if (taskActive && !(document.hidden || disposed))
        taskTimer = setTimeout(pollCaptureTask, 1000);
    }
  }

  async function pollLatestCaptureTask() {
    if (latestTaskInFlight || document.hidden || disposed) return;
    latestTaskInFlight = true;
    try {
      const { task } = await fetchJson(`/api/task/latest?device=${encodeURIComponent(deviceId)}`);
      if (disposed) return;
      // Keep an active Web request visible; otherwise adopt the newest task,
      // including one created by the physical MENU button.
      if (task?.request_id && task.request_id !== captureTaskId && !taskActive && !taskInFlight) {
        captureTaskId = task.request_id;
        try {
          sessionStorage.setItem(storageKey, captureTaskId);
        } catch (_) {
          /* Optional persistence. */
        }
        taskActive = true;
        $("capture-button").disabled = true;
        pollCaptureTask();
      }
    } catch (_) {
      // A discovery failure must not replace a known task's status or result.
    } finally {
      latestTaskInFlight = false;
      if (disposed) return;
      clearTimeout(latestTaskTimer);
      if (!(document.hidden || disposed)) latestTaskTimer = setTimeout(pollLatestCaptureTask, 2000);
    }
  }

  const capture = async () => {
    if (taskActive || taskInFlight) return;
    taskActive = true;
    $("capture-button").disabled = true;
    clearTimeout(taskTimer);
    setText("task-status", "正在提交任务…");
    setText("task-request-id", "—");
    setText("task-result", "等待服务器生成任务编号。");
    captureTaskId = null;
    try {
      sessionStorage.removeItem(storageKey);
    } catch (_) {
      /* Optional persistence. */
    }
    try {
      // Do not abort a creation on tab hiding or automatically POST it again.
      const task = await fetchJson(
        "/api/task/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            device: state.latest?.device || "ESP32_S3_EYE",
            action: "capture_once",
          }),
        },
        false,
      );
      captureTaskId = task.request_id;
      try {
        sessionStorage.setItem(storageKey, captureTaskId);
      } catch (_) {
        /* Optional persistence. */
      }
      if (disposed) return;
      setText("task-request-id", captureTaskId);
      setText("task-status", `任务已提交，${STATUS_TEXT.PENDING}`);
      await pollCaptureTask();
    } catch (error) {
      if (disposed) return;
      taskActive = false;
      $("capture-button").disabled = false;
      setText("task-status", "提交结果未确认");
      setText("task-result", "请求失败或超时；请核对服务器任务记录后再重试，避免重复创建。");
    }
  };

  captureButton.addEventListener("click", capture);
  const visibility = () => {
    clearTimeout(taskTimer);
    clearTimeout(latestTaskTimer);
    if (!document.hidden && !disposed) {
      if (captureTaskId) pollCaptureTask();
      pollLatestCaptureTask();
    }
  };
  document.addEventListener("visibilitychange", visibility);
  pollLatestCaptureTask();
  if (captureTaskId) {
    taskActive = true;
    captureButton.disabled = true;
    setText("task-request-id", captureTaskId);
    pollCaptureTask();
  }
  return () => {
    disposed = true;
    clearTimeout(taskTimer);
    clearTimeout(latestTaskTimer);
    document.removeEventListener("visibilitychange", visibility);
    captureButton.removeEventListener("click", capture);
  };
}
