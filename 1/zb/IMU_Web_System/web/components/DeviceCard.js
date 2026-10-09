import { element, text, count, dateTime, statusLabel, magnitude, number } from "../lib/format.js";
import { icon } from "./Icons.js";
export function DeviceCard() {
  const root = element(
    `<section class="panel device-panel" aria-label="设备与采集状态"><div class="device-identity"><span class="device-symbol">${icon("chip")}</span><div><h2 class="device-name mono"></h2><p><span class="sensor-name"></span> · 三轴加速度计</p></div></div><dl class="device-facts"><div><dt>设备状态</dt><dd class="device-status"></dd></div><div><dt>最近接收</dt><dd class="device-updated mono"></dd></div><div><dt>累计样本</dt><dd class="device-count mono"></dd></div></dl></section>`,
  );
  return {
    root,
    update(device) {
      text(root, ".device-name", device.name);
      text(root, ".sensor-name", device.sensor);
      text(root, ".device-status", `设备${statusLabel(device.status)}`);
      root.querySelector(".device-status").dataset.status = device.status;
      text(root, ".device-updated", dateTime(device.lastUpdate));
      text(root, ".device-count", count(device.sampleCount));
    },
  };
}
export function Measurements() {
  const root = element(
    `<article class="panel measurement-panel"><div class="panel-heading"><div><h2>实时测量</h2><p class="subtle value-caption">等待首次采样</p></div><span class="unit-chip">g</span></div><div class="measurements">${["x", "y", "z"].map((axis, i) => `<div class="axis-row"><span class="axis-label axis-${axis}">${axis.toUpperCase()}<span>轴</span></span><span class="reading" data-axis="${axis}">—</span><span class="unit">g</span></div>`).join("")}<div class="axis-row magnitude-row"><span class="magnitude-label"><span>合加速度</span></span><span class="reading magnitude">—</span><span class="unit">g</span></div></div><div class="measurement-footer"><span>标准重力加速度的倍数</span><span>陀螺仪模块未连接</span></div></article>`,
  );
  return {
    root,
    update(device) {
      ["x", "y", "z"].forEach((axis) =>
        text(root, `[data-axis="${axis}"]`, number(device.acceleration[axis])),
      );
      text(root, ".magnitude", number(magnitude(device.acceleration)));
      text(
        root,
        ".value-caption",
        device.lastUpdate === null
          ? "等待首次采样"
          : device.status === "online"
            ? "最新测量值"
            : "上次测量值 · 已过期",
      );
    },
  };
}
