import { DEFAULT_DEVICE, cameraLabel } from "../models/Device.js";
import { element, text } from "../lib/format.js";
import { icon } from "./Icons.js";
export function CameraPanel(api) {
  const root = element(
    `<section class="panel camera-panel" data-state="unknown"><div class="panel-heading"><h2>摄像头</h2><span class="status-indicator camera-status" role="status">状态待确认</span></div><div class="camera-view"><div class="camera-frame"><img class="camera-image" alt="开发板摄像头实时画面" hidden><div class="camera-empty">${icon("camera")}<strong class="camera-message">正在读取摄像头状态</strong><span class="camera-detail"></span></div></div></div><div class="camera-footer"><span class="mono camera-size">—</span><span class="camera-fps">— 帧/秒</span><span class="camera-mode">按需拍摄</span></div><div class="camera-controls"><button type="button" class="pause-button camera-toggle" hidden>开启实时预览</button><p class="camera-control-error" role="status"></p></div></section>`,
  );
  const image = root.querySelector("img"), toggle = root.querySelector(".camera-toggle");
  let last = null, retryAt = 0, busy = false, destroyed = false;
  function stop() {
    image.hidden = true;
    image.removeAttribute("src");
    root.querySelector(".camera-empty").hidden = false;
  }
  function update(device) {
    last = device;
    const mode = device.cameraStatus, camera = device.camera || {}, enabled = camera.preview_enabled;
    const retrying = performance.now() < retryAt;
    const receiving = mode === "streaming" && enabled && !retrying;
    root.dataset.state = mode;
    const label = enabled && mode === "on_demand"
      ? camera.status === "connecting" ? "正在连接实时预览" : "实时预览暂不可用"
      : cameraLabel(mode);
    text(root, ".camera-status", retrying ? "预览连接中断" : label);
    text(root, ".camera-fps", receiving && Number.isFinite(camera.fps) ? `${camera.fps.toFixed(1)} 帧/秒` : "— 帧/秒");
    text(root, ".camera-size", receiving && camera.width && camera.height ? `${camera.width} × ${camera.height}` : "—");
    text(root, ".camera-mode", enabled ? "实时预览已开启" : "实时预览未开启");
    toggle.hidden = !api || !camera.preview_available || device.id !== DEFAULT_DEVICE;
    toggle.disabled = busy || (!enabled && device.status !== "online");
    toggle.textContent = busy ? "正在切换…" : enabled ? "关闭实时预览" : "开启实时预览";
    if (document.hidden || !receiving || device.id !== DEFAULT_DEVICE) {
      stop();
      text(root, ".camera-message", retrying ? "预览连接中断" : label);
      const detail = {
        device_offline: "ESP32 当前离线，请检查设备连接。",
        on_demand: enabled ? "尚未收到有效视频帧；可关闭预览后继续按需拍摄。" : "实时预览未开启，摄像头将在图像任务触发时拍摄。",
        camera_unavailable: "最近图像任务报告摄像头不可用，请检查设备或重新拍照确认。",
        capture_failed: "最近一次图像任务失败，不代表设备离线；可重新发起拍照。",
        unknown: "当前摄像头能力尚未确认，请通过图像任务验证。",
        streaming: "页面暂停显示；关闭实时预览可停止持续视频流。",
      };
      text(root, ".camera-detail", retrying ? "正在重试视频连接，按需拍照状态独立判断。" : detail[mode]);
      return;
    }
    if (!image.hasAttribute("src")) image.src = `/api/camera?connection=${Date.now()}`;
    image.hidden = false;
    root.querySelector(".camera-empty").hidden = image.naturalWidth > 0;
    text(root, ".camera-message", "正在接收实时画面");
    text(root, ".camera-detail", "等待真实视频画面");
  }
  toggle.addEventListener("click", async () => {
    if (!last || busy) return;
    const enabled = !last.camera?.preview_enabled;
    busy = true; text(root, ".camera-control-error", ""); update(last);
    if (!enabled) stop();
    try {
      const response = await api.fetchJson("/api/camera/preview", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
      if (!destroyed && last.id === DEFAULT_DEVICE) {
        retryAt = 0;
        update({ ...last, camera: response.camera, cameraStatus: response.camera.mode });
      }
    } catch {
      if (!destroyed) text(root, ".camera-control-error", "预览切换未确认，请检查当前状态后重试。");
    } finally { busy = false; if (!destroyed && last) update(last); }
  });
  image.addEventListener("error", () => {
    if (!image.hasAttribute("src") || document.hidden) return;
    retryAt = performance.now() + 3000;
    if (last) update(last);
  });
  image.addEventListener("load", () => { if (last) update(last); });
  const visibility = () => { if (document.hidden) stop(); else if (last) update(last); };
  document.addEventListener("visibilitychange", visibility);
  return { root, update, destroy() { destroyed = true; stop(); document.removeEventListener("visibilitychange", visibility); } };
}
