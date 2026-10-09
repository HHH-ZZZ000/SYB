const KEY = "imu-platform-preferences-v1";
export const defaults = {
  displayName: "实验台操作员",
  deviceName: "",
  refreshMs: 500,
  windowSeconds: 20,
  tableRows: 20,
};
export function loadPreferences() {
  try {
    return validatePreferences({ ...defaults, ...JSON.parse(localStorage.getItem(KEY) || "{}") });
  } catch {
    return { ...defaults };
  }
}
export function validatePreferences(value) {
  if (
    ![200, 500, 1000, 2000].includes(Number(value.refreshMs)) ||
    ![20, 30, 60, 120].includes(Number(value.windowSeconds)) ||
    ![10, 20, 50].includes(Number(value.tableRows))
  )
    throw new Error("请选择有效的刷新周期、曲线窗口和列表行数。");
  const displayName = String(value.displayName || "").trim();
  if (!displayName || displayName.length > 40) throw new Error("显示名称须为 1–40 个字符。");
  return {
    displayName,
    deviceName: String(value.deviceName || "")
      .trim()
      .slice(0, 40),
    refreshMs: Number(value.refreshMs),
    windowSeconds: Number(value.windowSeconds),
    tableRows: Number(value.tableRows),
  };
}
export function savePreferences(value) {
  const prefs = validatePreferences(value);
  localStorage.setItem(KEY, JSON.stringify(prefs));
  return prefs;
}
