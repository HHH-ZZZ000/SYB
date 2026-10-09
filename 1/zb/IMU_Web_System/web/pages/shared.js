import { element, text, heading, button, count } from "../lib/format.js";
export function pageShell(title, subtitle) {
  const root = element('<div class="module-page"></div>');
  root.append(heading(title, subtitle));
  return root;
}
export function devicePicker(store) {
  const root = element(
    '<label class="device-picker">当前设备 <select aria-label="当前设备"></select><span class="device-alias subtle"></span></label>',
  );
  const select = root.querySelector("select");
  let signature = "";
  select.addEventListener("change", () => store.select(select.value));
  return {
    root,
    update(s) {
      const devices = s.devices.length ? s.devices : [s.device],
        next = JSON.stringify(devices.map((d) => [d.id, d.name]));
      if (next !== signature) {
        signature = next;
        select.replaceChildren(
          ...devices.map((device) => {
            const option = document.createElement("option");
            option.value = device.id;
            option.textContent = device.name;
            return option;
          }),
        );
      }
      select.value = s.device.id;
      text(root, ".device-alias", s.prefs.deviceName);
    },
  };
}
export function alertPanel() {
  const root = element('<div class="alert" role="status" hidden></div>');
  return {
    root,
    update(s) {
      root.hidden = !s.error && (s.loading || s.device.status === "online");
      root.textContent = s.error
        ? "无法连接服务器，正在自动重试。保留的上次测量值可能已过期。"
        : s.device.lastUpdate === null
          ? "尚未收到设备数据，请检查连接，等待设备首次上传。"
          : "数据未更新，请检查设备连接。当前显示上次真实测量值。";
    },
  };
}
export function refreshButton(store) {
  const root = button("刷新数据", async () => {
    root.disabled = true;
    root.textContent = "正在刷新…";
    try {
      const ok = await store.refresh();
      root.textContent = ok ? "已刷新" : "刷新失败 · 重试";
    } finally {
      root.disabled = false;
    }
  });
  return root;
}
export function StatsCards() {
  const root = element(
    '<div class="stats-grid"><article class="panel stat-card"><span>接入设备</span><strong class="stat-total mono">—</strong><small>当前平台设备总数</small></article><article class="panel stat-card"><span><i class="status-dot online"></i>在线设备</span><strong class="stat-online mono">—</strong><small>最近 10 秒有采样入库</small></article><article class="panel stat-card"><span><i class="status-dot offline"></i>离线设备</span><strong class="stat-offline mono">—</strong><small>等待设备恢复连接</small></article><article class="panel stat-card"><span>累计采样记录</span><strong class="stat-samples mono">—</strong><small>所有接入设备的真实记录</small></article></div>',
  );
  return {
    root,
    update(s) {
      const known = s.inventoryLoaded && !s.inventoryError && !s.error;
      text(root, ".stat-total", s.inventoryLoaded ? count(s.devices.length) : "—");
      text(
        root,
        ".stat-online",
        known ? count(s.devices.filter((d) => d.status === "online").length) : "—",
      );
      text(
        root,
        ".stat-offline",
        known ? count(s.devices.filter((d) => d.status === "offline").length) : "—",
      );
      text(
        root,
        ".stat-samples",
        s.inventoryLoaded
          ? count(s.devices.reduce((sum, d) => sum + (d.sampleCount || 0), 0))
          : "—",
      );
    },
  };
}
