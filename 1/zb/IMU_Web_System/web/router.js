const loaders = {
  dashboard: () => import("./pages/Dashboard.js"),
  monitor: () => import("./pages/DeviceMonitor.js"),
  realtime: () => import("./pages/RealTimeData.js"),
  history: () => import("./pages/HistoryData.js"),
  assistant: () => import("./pages/Assistant.js"),
  cameras: () => import("./pages/CameraManage.js"),
  settings: () => import("./pages/Settings.js"),
};
export function startRouter(container, context, onRoute) {
  let cleanup = () => {},
    version = 0,
    active = null;
  async function navigate() {
    if (location.hash === "#page-content") {
      container.focus();
      return;
    }
    const path = location.hash.replace(/^#\//, "") || "dashboard";
    if (!Object.hasOwn(loaders, path)) {
      location.replace("#/dashboard");
      return;
    }
    if (active === path) return;
    const token = ++version;
    cleanup();
    cleanup = () => {};
    active = path;
    onRoute(path);
    container.setAttribute("aria-busy", "true");
    container.textContent = "正在加载模块…";
    try {
      const page = await loaders[path]();
      if (token !== version) return;
      cleanup = page.mount(container, context) || (() => {});
      container.removeAttribute("aria-busy");
      const title = container.querySelector("h1");
      document.title = `${document.body.dataset.testMode ? "[测试数据] " : ""}${title?.textContent || "首页总览"} · 智能传感监控平台`;
      title?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    } catch (error) {
      if (token !== version) return;
      active = null;
      container.removeAttribute("aria-busy");
      container.textContent = "模块加载失败，请重新加载页面。";
      console.error(error);
    }
  }
  window.addEventListener("hashchange", navigate);
  navigate();
  return () => {
    version++;
    cleanup();
    window.removeEventListener("hashchange", navigate);
  };
}
