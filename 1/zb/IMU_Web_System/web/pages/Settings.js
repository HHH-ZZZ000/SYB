import { element, text } from "../lib/format.js";
import { savePreferences, defaults } from "../services/preferences.js";
import { pageShell } from "./shared.js";
export function mount(container, { store }) {
  const root = pageShell("系统设置", "工作台偏好");
  const form = element(
    '<form class="settings-form"><section class="panel settings-panel"><div class="settings-description"><span class="settings-number mono">01</span><h2>设备配置</h2><p>当前设备的接入信息与硬件参数。</p></div><div class="settings-fields"><label>设备标识<input class="settings-device" readonly aria-label="设备标识"></label><label>工作台设备备注<input name="deviceName" maxlength="40" placeholder="例如：实验台 / 01"></label><p class="field-help">备注保存于当前浏览器，显示在工作台设备选择区域。</p><dl class="hardware-info"><div><dt>传感器</dt><dd>QMA6100P · 三轴加速度</dd></div><div><dt>量程 / 单位</dt><dd>±2 g / 标准重力加速度的倍数</dd></div><div><dt>摄像头</dt><dd>OV2640 · 主设备视频代理</dd></div></dl></div></section><section class="panel settings-panel"><div class="settings-description"><span class="settings-number mono">02</span><h2>数据采集与显示</h2><p>调整本机刷新与曲线显示偏好。</p></div><div class="settings-fields"><label>设备采集频率<input value="由固件配置（目标周期 100 毫秒）" readonly></label><p class="field-help">当前设备尚无远程调频接口。实际接收频率受采集和网络耗时影响；修改网页刷新周期不会改变设备采样频率。</p><div class="form-pair"><label>网页刷新周期<select name="refreshMs"><option value="200">200 毫秒</option><option value="500">500 毫秒</option><option value="1000">1 秒</option><option value="2000">2 秒</option></select></label><label>实时曲线窗口<select name="windowSeconds"><option value="20">最近 20 秒</option><option value="30">最近 30 秒</option><option value="60">最近 60 秒</option><option value="120">最近 120 秒</option></select></label></div><label>实时列表行数<select name="tableRows"><option value="10">10 条</option><option value="20">20 条</option><option value="50">50 条</option></select></label></div></section><section class="panel settings-panel"><div class="settings-description"><span class="settings-number mono">03</span><h2>用户设置</h2><p>当前浏览器的工作台显示信息。</p></div><div class="settings-fields"><label>显示名称<input name="displayName" required maxlength="40"></label><p class="field-help">显示名称仅用于本机界面；当前系统未接入用户登录或权限管理。</p></div></section><div class="settings-actions"><p class="save-message" role="status">设置仅保存在当前浏览器。</p><button type="button" class="pause-button reset-settings">恢复默认值</button><button type="submit" class="pause-button primary-button">保存设置</button></div></form>',
  );
  root.append(form);
  container.replaceChildren(root);
  function fill(prefs) {
    for (const [key, value] of Object.entries(prefs))
      if (form.elements.namedItem(key)) form.elements.namedItem(key).value = value;
  }
  fill(store.prefs);
  const unsubscribe = store.subscribe((s) => {
    form.querySelector(".settings-device").value = s.device.id;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      store.prefs = savePreferences(Object.fromEntries(new FormData(form)));
      store.emit();
      text(form, ".save-message", "设置已保存，显示偏好立即生效。");
    } catch (error) {
      text(
        form,
        ".save-message",
        error.name === "QuotaExceededError" || error.name === "SecurityError"
          ? "浏览器不允许保存本地设置，请检查存储权限。"
          : error.message,
      );
    }
  });
  form.querySelector(".reset-settings").addEventListener("click", () => {
    fill(defaults);
    text(form, ".save-message", "已填入默认值，点击“保存设置”后生效。");
  });
  return unsubscribe;
}
