const time = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const date = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
export const clockTime = (value) => (Number.isFinite(value) ? time.format(value) : "—");
export const dateTime = (value) => (Number.isFinite(value) ? date.format(value) : "—");
export const count = (value) => (Number.isFinite(value) ? value.toLocaleString("zh-CN") : "—");
export const number = (value) =>
  Number.isFinite(value) ? (Math.abs(value) < 0.0005 ? "0.000" : value.toFixed(3)) : "—";
export const magnitude = (acc) =>
  Object.values(acc).every(Number.isFinite) ? Math.hypot(acc.x, acc.y, acc.z) : null;
export const statusLabel = (status) =>
  ({ online: "在线", offline: "离线", unknown: "状态未知" })[status] || "正在连接";
export function text(root, selector, value) {
  const node = root.querySelector(selector);
  if (node && node.textContent !== String(value)) node.textContent = value;
}
export function element(markup) {
  const template = document.createElement("template");
  template.innerHTML = markup.trim(); // Callers supply static, authored markup only.
  return template.content.firstElementChild;
}
export function heading(title, subtitle) {
  const el = element(
    '<div class="page-heading"><div><p class="eyebrow"></p><h1 tabindex="-1"></h1></div><div class="page-actions"></div></div>',
  );
  text(el, "h1", title);
  text(el, ".eyebrow", subtitle);
  return el;
}
export function button(label, handler, primary = false) {
  const el = element('<button type="button" class="pause-button"></button>');
  el.textContent = label;
  el.classList.toggle("primary-button", primary);
  el.addEventListener("click", handler);
  return el;
}
