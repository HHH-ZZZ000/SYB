import { element, text } from "../lib/format.js";
import { DeviceCard, Measurements } from "../components/DeviceCard.js";
import { DataChart } from "../components/DataChart.js";
import { CameraPanel } from "../components/CameraPanel.js";
import { DataTable } from "../components/DataTable.js";
import { mountCaptureTask } from "../services/captureTask.js";
import { pageShell, devicePicker, alertPanel } from "./shared.js";
export function mount(container, { store, api }) {
  const root = pageShell("设备监控工作台", "惯性传感数据采集系统");
  const picker = devicePicker(store),
    alert = alertPanel(),
    device = DeviceCard(),
    measurements = Measurements(),
    chart = DataChart(),
    camera = CameraPanel(api);
  const capture = element(
    '<button type="button" class="pause-button primary-button" id="capture-button">采集一次最新数据</button>',
  );
  root.querySelector(".page-actions").append(picker.root, capture);
  const task = element(
    '<section class="panel task-panel" aria-labelledby="task-title"><div class="panel-heading"><h2 id="task-title">最近一次采集任务</h2><span id="task-status" role="status" aria-live="polite">尚未提交任务</span></div><p class="subtle task-request">任务编号：<span id="task-request-id" class="mono">—</span></p><p id="task-result">点击“采集一次最新数据”发起真实采集。</p></section>',
  );
  const grid = element('<div class="monitor-grid"></div>');
  grid.append(measurements.root, chart.root, camera.root);
  const history = element(
    '<section class="panel history-panel"><div class="panel-heading"><div><h2>最近采样记录</h2><p class="subtle">最近 6 条真实入库记录 · 北京时间</p></div><a class="text-link" href="#/history">查看历史 →</a></div></section>',
  );
  const table = DataTable();
  history.append(table.root);
  const footer = element(
    '<footer class="workspace-footer"><p>设备采样时间 <span class="sample-timestamp mono">—</span></p><span>单位 g · 标准重力加速度的倍数</span></footer>',
  );
  root.append(alert.root, device.root, task, grid, history, footer);
  container.replaceChildren(root);
  let current = null,
    disposeTask = () => {};
  const unsubscribe = store.subscribe((s) => {
    if (current !== s.device.id) {
      disposeTask();
      current = s.device.id;
      capture.disabled = false;
      text(task, "#task-status", "尚未提交任务");
      text(task, "#task-request-id", "—");
      text(task, "#task-result", "点击“采集一次最新数据”发起真实采集。");
      disposeTask = mountCaptureTask(task, capture, api, current);
    }
    picker.update(s);
    alert.update(s);
    device.update(s.device);
    measurements.update(s.device);
    chart.update(s);
    camera.update(s.device);
    table.update(
      s.samples.slice(-6).reverse(),
      s.historyError ? "历史记录加载失败，正在重试" : "暂无真实采样记录，等待设备上传",
    );
    text(footer, ".sample-timestamp", s.device.timestamp || "—");
  });
  return () => {
    unsubscribe();
    disposeTask();
    chart.destroy();
    camera.destroy();
  };
}
