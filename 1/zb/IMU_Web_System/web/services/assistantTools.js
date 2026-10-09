// Only these fixed API paths are available to the assistant. No arbitrary URLs,
// commands, device-state writes or language-model claims enter this tool layer.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEVICE = /^[A-Za-z0-9_-]{1,64}$/;
const AXES = ["acc_x", "acc_y", "acc_z"];
const TERMINAL = new Set(["SUCCESS", "FAILED", "TIMEOUT"]);
const STATES = new Set(["PENDING", "SENT", "RUNNING", ...TERMINAL]);
const LABELS = {
  PENDING: "等待设备领取任务",
  SENT: "任务已下发，等待设备回执",
  RUNNING: "设备正在采集",
};
// Firmware command_task: 1 s poll delay, 1.5 s HTTP timeout. Allow three
// normal polls plus two network timeouts for receipt. Capture itself has a
// 5 s deadline; RUNNING gets 5 s + two HTTP timeouts, once, without renewal.
export const COLLECTION_RESPONSE_TIMEOUT_MS = 6000;
export const COLLECTION_RUNNING_TIMEOUT_MS = 8000;
const fail = (code, message, extra = {}) => ({ status: "error", code, message, ...extra });
function requireValue(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { code: "invalid_response" });
}
function validSample(sample, device) {
  return (
    sample &&
    Number.isSafeInteger(sample.id) &&
    sample.id > 0 &&
    sample.device === device &&
    sample.sensor === "QMA6100P" &&
    AXES.every(
      (axis) =>
        typeof sample[axis] === "number" &&
        Number.isFinite(sample[axis]) &&
        Math.abs(sample[axis]) <= 2,
    ) &&
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sample.timestamp) &&
    Number.isFinite(Date.parse(sample.timestamp.replace(" ", "T") + "+08:00"))
  );
}
function normalizeSample(sample) {
  return { ...sample, received_at_ms: sample.received_at_ms ?? sample.received_at * 1000 };
}
function statusLabel(value) {
  return { online: "在线", offline: "离线" }[value] || "未知";
}
function sampleText(sample) {
  return `记录 ${sample.id}：X ${sample.acc_x} g，Y ${sample.acc_y} g，Z ${sample.acc_z} g。\n设备采样时间：${sample.timestamp}（北京时间）。`;
}
function errorResult(error, kind, source, extra = {}) {
  const detail = error.status
    ? `HTTP ${error.status}`
    : error.name === "AbortError"
      ? "请求超时或连接中断"
      : error.code === "invalid_response"
        ? error.message
        : "网络或接口异常";
  return fail(error.code || "api_error", `接口错误：${detail}。无法确认本次操作结果。`, {
    kind,
    source,
    httpStatus: error.status ?? null,
    ...extra,
  });
}
async function validate(api, parameters, intent) {
  requireValue(
    parameters && parameters.intent === intent && DEVICE.test(parameters.device || ""),
    "设备或操作参数无效。",
  );
  requireValue(parameters.data_type === (intent === "image_capture" ? "image" : "acceleration"), "数据类型与操作不匹配。");
  const inventory = await api.devices();
  requireValue(Array.isArray(inventory.devices), "设备列表格式异常。");
  requireValue(
    inventory.devices.some((d) => d.device === parameters.device),
    "设备不存在。",
  );
}

export function verifyImageResult(task, expected) {
  const image = task?.result;
  requireValue(task?.request_id === expected.requestId && task.device === expected.device &&
    task.action === "image_capture" && task.status === "SUCCESS" && task.image_status === "success" &&
    (!expected.interactionRequestId || task.interaction_request_id === expected.interactionRequestId), "图像任务与本次请求不匹配。");
  requireValue(image && Number.isSafeInteger(image.id) && image.id > 0 && image.id === task.result_image_id &&
    image.task_id === expected.requestId && image.device === expected.device && image.url === `/api/images/${image.id}` &&
    /^[a-f0-9]{64}$/.test(image.sha256) && image.byte_length >= 512 && image.byte_length <= 256 * 1024 &&
    image.width >= 16 && image.width <= 1600 && image.height >= 16 && image.height <= 1200 && !image.purged_at,
    "尚无本次任务的有效图片，不能使用旧图片代替。");
  requireValue([task.created_at, task.sent_at, task.started_at, task.finished_at, image.capture_time, image.received_at]
    .every(v => typeof v === "number" && Number.isFinite(v)) &&
    task.sent_at >= task.created_at && task.started_at >= task.sent_at &&
    image.capture_time >= task.started_at - 2 && image.capture_time <= image.received_at + 2 &&
    image.received_at >= task.started_at && task.finished_at >= image.received_at,
    "图片时间与本次任务不符，无法确认本次拍摄成功。");
  return image;
}

function imageText(image) {
  const captured = new Date(image.capture_time * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  return `图片记录 ${image.id}；拍摄时间：${captured}（北京时间）。`;
}

// A SUCCESS flag alone is never sufficient: bind ID, device, sample and times.
export function verifyTaskResult(task, expected) {
  requireValue(
    task?.request_id === expected.requestId &&
      task.device === expected.device &&
      task.action === "capture_once",
    "任务与本次请求不匹配。",
  );
  const sample = task.result;
  requireValue(
    task.status === "SUCCESS" &&
      validSample(sample, expected.device) &&
      sample.id === task.result_sample_id,
    "任务尚无有效的关联采样结果。",
  );
  requireValue(
    [task.created_at, task.sent_at, task.finished_at, sample.received_at].every(
      (v) => typeof v === "number" && Number.isFinite(v),
    ) &&
      task.sent_at >= task.created_at &&
      sample.received_at >= task.sent_at &&
      task.finished_at >= sample.received_at &&
      (expected.baselineId == null || sample.id > expected.baselineId),
    "记录不是本次任务下发后产生的新结果。",
  );
  const captured = Date.parse(sample.timestamp.replace(" ", "T") + "+08:00");
  // Device timestamps have one-second precision. A stale device clock is shown
  // as unverifiable instead of relabelling its old timestamp as 'latest'.
  requireValue(
    captured >= task.created_at * 1000 - 2000 && captured <= sample.received_at * 1000 + 5000,
    "设备采样时间与本次任务不符，请检查设备时钟。",
  );
  return normalizeSample(sample);
}

export async function query_existing_data(api, parameters, { lastTask } = {}) {
  const kind = "existing";
  let source = "/api/devices";
  try {
    await validate(api, parameters, "query_existing");
    const device = parameters.device;
    requireValue(["latest", "history", "last_task"].includes(parameters.mode), "查询方式无效。");
    source = `/api/latest?device=${encodeURIComponent(device)}`;
    const latest = await api.fetchJson(source);
    requireValue(
      latest.device === device && ["online", "offline"].includes(latest.status),
      "设备状态返回异常。",
    );
    let samples,
      total,
      task = null;
    if (parameters.mode === "last_task") {
      if (lastTask?.device === device && UUID.test(lastTask.requestId)) {
        source = `/api/task/${lastTask.requestId}`;
        task = await api.fetchJson(source);
      } else {
        source = `/api/task/latest?device=${encodeURIComponent(device)}`;
        task = (await api.fetchJson(source)).task;
      }
      if (!task)
        return {
          kind,
          status: "empty",
          device,
          source,
          message: `设备 ${device} 尚无已有采集任务记录。未触发新采集。`,
        };
      requireValue(
        UUID.test(task.request_id || "") && task.device === device && STATES.has(task.status),
        "已有任务返回异常。",
      );
      if (task.status !== "SUCCESS")
        return {
          kind,
          status: "task_state",
          device,
          source,
          requestId: task.request_id,
          taskStatus: task.status,
          message: `已有任务 ${task.request_id} 当前状态：${LABELS[task.status] || (task.status === "FAILED" ? "执行失败" : "采集超时")}。尚无可确认的采样结果，未触发新采集。`,
        };
      if (task.action === "image_capture") {
        const image = verifyImageResult(task, { requestId: task.request_id, device });
        return { kind, status: "success", image, device, source, requestId: task.request_id, taskStatus: task.status,
          message: `这是已有图像记录，未触发新拍摄。设备 ${device}。${imageText(image)}` };
      }
      samples = [verifyTaskResult(task, { requestId: task.request_id, device })];
      total = 1;
    } else if (parameters.mode === "history") {
      requireValue(
        Number.isInteger(parameters.limit) && parameters.limit >= 1 && parameters.limit <= 100,
        "查询条数必须为 1 到 100。",
      );
      const filter = {
        device,
        start: parameters.start || "",
        end: parameters.end || "",
        order: "desc",
        page: 1,
        page_size: parameters.limit,
      };
      source = `/api/records?${new URLSearchParams(filter)}`;
      const response = await api.fetchJson(source);
      requireValue(
        Array.isArray(response.samples) &&
          Number.isSafeInteger(response.total) &&
          response.total >= response.samples.length,
        "历史记录返回异常。",
      );
      samples = response.samples;
      total = response.total;
    } else {
      samples = latest.id === null ? [] : [latest];
      total = samples.length;
    }
    requireValue(
      samples.every((s) => validSample(s, device) && Number.isFinite(s.received_at_ms)),
      "已有采样数据无效。",
    );
    if (!samples.length)
      return {
        kind,
        status: "empty",
        device,
        deviceStatus: latest.status,
        source,
        message: `设备 ${device} 在本次查询范围内没有已有记录。当前状态：${statusLabel(latest.status)}。未触发新采集。`,
      };
    return {
      kind,
      status: "success",
      device,
      deviceStatus: latest.status,
      source,
      samples,
      total,
      requestId: task?.request_id,
      taskStatus: task?.status,
      message: `查询到已有数据，未触发新采集。设备 ${device}，当前状态：${statusLabel(latest.status)}。\n${sampleText(samples[0])}${samples.length > 1 ? `\n共匹配 ${total} 条，展示最近 ${samples.length} 条；时间筛选依据服务器接收时间。` : ""}`,
    };
  } catch (error) {
    return errorResult(error, kind, source, { device: parameters?.device });
  }
}

export async function wait_for_collection(api, expected, options = {}) {
  const isImage = expected.action === "image_capture";
  const {
    onUpdate = () => {},
    timeoutMs = COLLECTION_RESPONSE_TIMEOUT_MS,
    runningTimeoutMs = isImage ? 12000 : COLLECTION_RUNNING_TIMEOUT_MS,
    pollMs = 1000,
    now = () => performance.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  const kind = isImage ? "image" : "new",
    source = `/api/task/${expected.requestId}`;
  let last = null;
  try {
    requireValue(
      UUID.test(expected.requestId || "") && DEVICE.test(expected.device || ""),
      "任务编号或设备无效。",
    );
    const started = now();
    let deadline = started + timeoutMs;
    let sawRunning = false;
    do {
      // Read the exact task, never /api/latest, while waiting for a new result.
      const remaining = deadline - now();
      if (remaining <= 0) break;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      let task;
      try {
        task = await api.fetchJson(source, { signal: controller.signal }, false);
      } catch (error) {
        if (controller.signal.aborted && now() >= deadline) break;
        throw error;
      } finally {
        clearTimeout(timer);
      }
      requireValue(
        task?.request_id === expected.requestId &&
          task.device === expected.device &&
          STATES.has(task.status),
        "返回任务与本次请求不匹配。",
      );
      last = task.status;
      if (last === "RUNNING" && !sawRunning) {
        sawRunning = true;
        deadline = Math.max(deadline, now() + runningTimeoutMs);
      }
      if (last === "SUCCESS") {
        if (isImage) {
          const image = verifyImageResult(task, expected);
          return { kind, status: "success", imageStatus: "success", device: expected.device, source,
            requestId: expected.requestId, taskStatus: last, image,
            message: `本次拍照成功，已核验任务、设备、图片记录及时间。\n设备 ${expected.device}。${imageText(image)}` };
        }
        const sample = verifyTaskResult(task, expected);
        return {
          kind,
          status: "success",
          device: expected.device,
          source,
          requestId: expected.requestId,
          taskStatus: last,
          samples: [sample],
          message: `本次新采集成功，已核验任务编号、设备、关联记录及时间。\n设备 ${expected.device}。${sampleText(sample)}`,
        };
      }
      if (last === "FAILED" || last === "TIMEOUT")
        return fail(
          last === "FAILED" ? "device_failed" : "task_timeout",
          last === "FAILED"
            ? (isImage ? `本次拍照失败，未取得有效图片。${({ camera_unavailable: "摄像头初始化或采集不可用", image_invalid: "图像无效或拍摄时间不符", camera_clock_unavailable: "设备时钟未就绪" })[task.error] || task.error || "设备执行失败"}。不会使用旧图片代替。` : `设备执行失败，未取得本次有效采样结果。设备返回：${task.error || "未提供原因"}。`)
            : "采集任务已超时，未收到本次有效执行结果。",
          {
            kind,
            source,
            device: expected.device,
            requestId: expected.requestId,
            taskStatus: last,
            ...(isImage ? { imageStatus: task.image_status || "failed", deviceError: task.error || null,
              imageRecordId: task.result_image_id || null } : {}),
          },
        );
      onUpdate({
        kind,
        status: "waiting",
        device: expected.device,
        requestId: expected.requestId,
        taskStatus: last,
        source,
        phase: last === "RUNNING" ? "running" : "waiting_device",
        ...(isImage ? { imageStatus: last === "RUNNING" ? "capturing" : "waiting" } : {}),
        message: `${last === "RUNNING" ? LABELS[last] : "等待 ESP32 响应"}（已等待 ${Math.floor((now() - started) / 1000)} 秒），尚未取得本次有效结果。`,
      });
      if (now() >= deadline) break;
      await sleep(Math.min(pollMs, deadline - now()));
    } while (true);
    return fail(
      last === "PENDING" || last === "SENT" ? "device_unresponsive" : "wait_timeout",
      `${last === "PENDING" || last === "SENT" ? "设备无响应，尚未收到本次执行回执" : "等待超时，本次任务仍未完成"}。任务未被取消，可继续查询同一任务；请勿将已有数据视为本次结果。`,
      {
        kind,
        device: expected.device,
        source,
        requestId: expected.requestId,
        taskStatus: last,
        resumable: true,
      },
    );
  } catch (error) {
    return errorResult(error, kind, source, {
      device: expected.device,
      requestId: expected.requestId,
      taskStatus: last,
      resumable: !TERMINAL.has(last) && error.status !== 404 && error.status !== 400,
    });
  }
}

export async function collect_new_data(api, parameters, options = {}) {
  const isImage = parameters?.intent === "image_capture";
  const kind = isImage ? "image" : "new";
  let source = "/api/devices",
    expected = null;
  try {
    options.onUpdate?.({ kind, status: "waiting", phase: "checking_device", message: "正在检查设备在线状态…" });
    await validate(api, parameters, isImage ? "image_capture" : "collect_new");
    requireValue(!parameters.start && !parameters.end, "新采集不能附带历史时间范围。");
    source = `/api/latest?device=${encodeURIComponent(parameters.device)}`;
    const before = await api.fetchJson(source);
    requireValue(
      before.device === parameters.device &&
        ["online", "offline"].includes(before.status) &&
        (before.id === null || Number.isSafeInteger(before.id)),
      "无法确认设备状态或采集前的记录编号。",
    );
    // Reuse the server's exact online judgement; never derive a second local
    // threshold or mistake a stored sample for a new collection result.
    if (before.status === "offline")
      return fail("device_offline", `${parameters.device} 当前离线，无法${isImage ? "开始拍照" : "发起新的实时采集"}。请检查设备连接后重试。`, {
        kind, device: parameters.device, deviceStatus: "offline", source,
      });
    source = "/api/task/create";
    options.onUpdate?.({ kind, status: "waiting", phase: "creating_task", message: isImage ? "正在创建单张拍照任务…" : "正在创建采集任务…" });
    // Intentionally only one POST. A lost response is not permission to retry.
    const created = await api.fetchJson(
      source,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device: parameters.device, action: isImage ? "image_capture" : "capture_once",
          ...(isImage && options.interactionRequestId ? { interaction_request_id: options.interactionRequestId } : {}) }),
      },
      false,
    );
    requireValue(
      UUID.test(created.request_id || "") && created.status === "PENDING",
      "创建任务的响应无效，提交结果未确认，请先检查最近采集任务。",
    );
    expected = {
      requestId: created.request_id,
      device: parameters.device,
      baselineId: before.id ?? 0,
      ...(isImage ? { action: "image_capture", interactionRequestId: options.interactionRequestId } : {}),
    };
    await options.onCreated?.(expected);
    return await wait_for_collection(api, expected, options);
  } catch (error) {
    const result = errorResult(error, kind, source, {
      device: parameters?.device,
      requestId: expected?.requestId,
    });
    if (expected) {
      // Creation was confirmed; a failed follow-up must not hide the live task.
      result.resumable = true;
      result.message = `采集任务已创建，但后续关联处理失败${error.status ? `（HTTP ${error.status}）` : ""}。可继续查询同一任务并重试保存关联，不会重复创建任务。`;
    } else if (source === "/api/task/create")
      result.message += "提交结果未确认；不会自动重发，请先查看最近采集任务。";
    return result;
  }
}
