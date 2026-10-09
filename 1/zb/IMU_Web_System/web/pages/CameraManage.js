import { element, text, statusLabel, button } from "../lib/format.js";
import { icon } from "../components/Icons.js";
import { CameraPanel } from "../components/CameraPanel.js";
import { cameraLabel } from "../models/Device.js";
import { pageShell, refreshButton } from "./shared.js";
export function mount(container, { store, api }) {
  const root = pageShell("摄像头管理", "视频设备");
  root.querySelector(".page-actions").append(refreshButton(store));
  const note = element(
    '<p class="section-note">视频连接状态独立于加速度传感器。选择设备查看对应视频预览。</p>',
  );
  const grid = element(
    '<div class="camera-manage-grid"><section class="panel camera-list-panel"><div class="section-title"><h2>设备摄像头列表</h2></div><div class="camera-list"></div></section><div class="camera-preview-column"></div></div>',
  );
  const camera = CameraPanel(api);
  grid.querySelector(".camera-preview-column").append(camera.root);
  root.append(note, grid);
  container.replaceChildren(root);
  let previous = "";
  const unsubscribe = store.subscribe((s) => {
    camera.update(s.device);
    const signature = JSON.stringify(s.devices.map((d) => [d.id, d.cameraStatus])) + s.device.id;
    if (signature === previous) return;
    previous = signature;
    const rows = s.devices.map((device) => {
      const row = button("", () => store.select(device.id));
      row.className = "camera-list-item";
      row.classList.toggle("selected", s.device.id === device.id);
      row.setAttribute("aria-pressed", String(s.device.id === device.id));
      row.innerHTML = `${icon("camera")}<span><strong class="camera-device-name"></strong><small class="camera-model">OV2640 · 视频预览</small></span><span class="status-indicator"></span>`;
      text(row, ".camera-device-name", device.name);
      text(row, ".status-indicator", cameraLabel(device.cameraStatus));
      row.querySelector(".status-indicator").dataset.status = device.cameraStatus;
      if (device.id !== "ESP32_S3_EYE") text(row, ".camera-model", "视频源待配置");
      return row;
    });
    grid.querySelector(".camera-list").replaceChildren(...rows);
  });
  return () => {
    unsubscribe();
    camera.destroy();
  };
}
