import { element } from "../lib/format.js";
import { icon } from "./Icons.js";
export const routes = [
  ["dashboard", "首页总览", "dashboard"],
  ["monitor", "设备监控", "monitor"],
  ["realtime", "实时数据", "realtime"],
  ["history", "历史数据", "history"],
  ["assistant", "智能助手", "assistant"],
  ["settings", "系统设置", "settings"],
];
export function Sidebar() {
  const root = element(
    `<aside class="sidebar"><div class="sidebar-caption">工作空间</div><nav aria-label="主导航">${routes.map(([path, title, glyph]) => `<a href="#/${path}" data-route="${path}">${icon(glyph)}<span>${title}</span></a>`).join("")}</nav></aside>`,
  );
  root.querySelectorAll("nav a").forEach((link, index) => {
    link.setAttribute("aria-label", routes[index][1]);
    link.title = routes[index][1];
  });
  return {
    root,
    destroy() {},
    activate(path) {
      root.querySelectorAll("nav a").forEach((link) => {
        const active = link.dataset.route === path;
        link.classList.toggle("active", active);
        if (active) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      });
    },
  };
}
