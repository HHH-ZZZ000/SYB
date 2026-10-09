import { element, text, clockTime } from "../lib/format.js";
import { icon } from "./Icons.js";
export function Navbar(store) {
  const root = element(
    `<header class="system-header"><a class="brand" href="#/dashboard" aria-label="智能传感监控平台首页"><span class="brand-mark">${icon("realtime")}</span><span>智能传感<span class="brand-light">监控平台</span></span><span class="system-tag">实验台 / 01</span></a><div class="header-meta"><details class="connection-details"><summary class="status-indicator network-status"><span class="network-label" role="status">服务器连接中</span></summary><div class="connection-popover"><span class="subtle">实时连接</span><span class="transport-label"></span></div></details><span class="header-divider"></span><div class="header-updated"><span class="micro-label">最近接收</span><span class="header-clock mono">—</span></div><a class="user-chip" href="#/settings" aria-label="用户设置"><span class="avatar">用</span><span class="user-name"></span></a></div></header>`,
  );
  const unsubscribe = store.subscribe((s) => {
    document.body.dataset.state = s.error ? "error" : s.loading ? "loading" : s.device.status;
    text(
      root,
      ".network-label",
      s.error ? "服务器连接异常" : s.loading ? "服务器连接中" : "服务器已连接",
    );
    text(
      root,
      ".transport-label",
      s.socketReady ? "实时推送已连接" : s.error ? "正在重试连接" : "增量轮询 · 自动恢复推送",
    );
    const updates = s.devices.map((d) => d.lastUpdate).filter(Number.isFinite);
    text(root, ".header-clock", clockTime(updates.length ? Math.max(...updates) : null));
    text(root, ".user-name", s.prefs.displayName);
  });
  return { root, destroy: unsubscribe };
}
