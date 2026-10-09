import { element, text, count, dateTime, statusLabel, button } from "../lib/format.js";
import { icon } from "../components/Icons.js";
import { cameraLabel } from "../models/Device.js";
import { DataTable } from "../components/DataTable.js";
import { DataChart } from "../components/DataChart.js";
import { pageShell, StatsCards, refreshButton } from "./shared.js";
export function mount(container, { store }) {
  const root = pageShell("首页总览", "运行概况");
  root.querySelector(".page-actions").append(refreshButton(store));
  const overview = element(
    '<div class="overview-status"><span class="status-dot"></span><span class="overall-label">正在同步设备状态</span><span class="overview-last">最新采集时间 <strong class="last-update mono">—</strong></span></div>',
  );
  root.append(overview);
  const stats = StatsCards();
  root.append(stats.root);
  const grid = element('<div class="overview-grid"></div>');
  const devices = element(
    '<section class="panel devices-list"><div class="section-title"><div><h2>设备运行状态</h2><p class="subtle">实时接入 · 独立状态监测</p></div><a class="text-link" href="#/monitor">查看监控 →</a></div><div class="device-list-body"></div></section>',
  );
  const chart = DataChart("采样趋势概览");
  grid.append(chart.root, devices);
  root.append(grid);
  const bottom = element(
    '<div class="overview-bottom"><section class="panel recent-panel"><div class="section-title"><div><h2>最新采样记录</h2><p class="subtle">当前设备最近 6 条真实入库记录</p></div><a class="text-link" href="#/history">全部记录 →</a></div></section><section class="panel quick-panel"><div class="section-title"><h2>快捷入口</h2></div><div class="quick-links"></div><p class="quick-note">采集数据与视频独立监测<br>离线时保留上次真实记录</p></section></div>',
  );
  const table = DataTable();
  bottom.querySelector(".recent-panel").append(table.root);
  [
    ["realtime", "实时数据", "查看三轴传感器读数"],
    ["history", "历史数据", "查询与导出采样记录"],
  ].forEach(([path, title, sub]) => {
    const link = element(
      `<a class="quick-link" href="#/${path}">${icon(path)}<span><strong></strong><small></small></span>${icon("arrow")}</a>`,
    );
    text(link, "strong", title);
    text(link, "small", sub);
    bottom.querySelector(".quick-links").append(link);
  });
  root.append(bottom);
  container.replaceChildren(root);
  let deviceSignature = "";
  const rowsById = new Map();
  const unsubscribe = store.subscribe((s) => {
    stats.update(s);
    chart.update(s);
    const unknown = s.error || s.inventoryError,
      online = s.devices.filter((d) => d.status === "online").length;
    text(
      overview,
      ".overall-label",
      unknown
        ? "设备状态同步失败，正在重试"
        : !s.inventoryLoaded
          ? "正在同步设备状态"
          : online === s.devices.length
            ? "所有设备运行正常"
            : online
              ? `${online} 台设备在线，部分设备需要检查`
              : "当前设备均离线 · 等待恢复连接",
    );
    overview.dataset.status = unknown
      ? "unknown"
      : online === s.devices.length
        ? "online"
        : "offline";
    text(
      overview,
      ".last-update",
      s.devices
        .map((d) => d.timestamp)
        .filter(Boolean)
        .sort()
        .at(-1) || "—",
    );
    table.update(
      s.samples.slice(-6).reverse(),
      s.historyError ? "采样记录加载失败" : s.historyLoaded ? "暂无采样记录" : "正在加载采样记录…",
    );
    const signature = JSON.stringify(s.devices.map((device) => device.id));
    const rows = s.devices.map((device) => {
      let row = rowsById.get(device.id);
      if (!row) {
        row = element(
          `<div class="overview-device"><div class="device-list-top"><span class="device-symbol">${icon("chip")}</span><div><h3 class="mono"></h3><p class="subtle">QMA6100P · 三轴加速度计</p></div><span class="status-indicator"></span></div><dl><div><dt>累计样本</dt><dd class="list-count mono"></dd></div><div><dt>最近接收</dt><dd class="list-updated mono"></dd></div></dl><div class="device-list-actions"><span class="subtle camera-summary"></span></div></div>`,
        );
        row.querySelector(".device-list-actions").append(
          button("查看设备 →", () => {
            store.select(device.id);
            location.hash = "#/monitor";
          }),
        );
        rowsById.set(device.id, row);
      }
      text(row, "h3", device.name);
      text(row, ".status-indicator", statusLabel(device.status));
      row.querySelector(".status-indicator").dataset.status = device.status;
      text(row, ".list-count", count(device.sampleCount));
      text(row, ".list-updated", dateTime(device.lastUpdate));
      text(row, ".camera-summary", cameraLabel(device.cameraStatus));
      return row;
    });
    // Preserve focused controls while live readings change.
    if (signature !== deviceSignature) {
      deviceSignature = signature;
      devices.querySelector(".device-list-body").replaceChildren(...rows);
    }
  });
  return () => {
    unsubscribe();
    chart.destroy();
  };
}
