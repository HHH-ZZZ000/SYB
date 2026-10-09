import { element, text, count } from "../lib/format.js";
import { DataChart } from "../components/DataChart.js";
import { DataTable } from "../components/DataTable.js";
import { Measurements } from "../components/DeviceCard.js";
import { pageShell, devicePicker, alertPanel, refreshButton } from "./shared.js";
export function mount(container, { store }) {
  const root = pageShell("实时数据", "传感器数据流");
  const picker = devicePicker(store),
    alert = alertPanel();
  root.querySelector(".page-actions").append(picker.root, refreshButton(store));
  root.append(alert.root);
  const chart = DataChart(),
    measurements = Measurements(),
    grid = element('<div class="realtime-grid"></div>');
  grid.append(chart.root, measurements.root);
  root.append(grid);
  const list = element(
    '<section class="panel history-panel"><div class="panel-heading"><div><h2>实时采样数据</h2><p class="subtle live-count">持续接收真实入库记录</p></div><label class="inline-control">时间排序 <select aria-label="实时数据时间排序"><option value="desc">最新在前</option><option value="asc">最早在前</option></select></label></div></section>',
  );
  const table = DataTable("实时采样数据表格");
  list.append(table.root);
  root.append(list);
  container.replaceChildren(root);
  let last;
  function renderTable() {
    if (!last) return;
    const rows = last.samples.slice(-last.prefs.tableRows);
    table.update(
      list.querySelector("select").value === "desc" ? rows.reverse() : rows,
      last.historyError ? "数据加载失败，正在重试" : "当前暂无传感器数据",
    );
    text(
      list,
      ".live-count",
      `展示最近 ${last.prefs.tableRows} 条 · 累计 ${count(last.device.sampleCount)} 条 · 冻结曲线时列表继续更新`,
    );
  }
  list.querySelector("select").addEventListener("change", renderTable);
  const unsubscribe = store.subscribe((s) => {
    last = s;
    picker.update(s);
    alert.update(s);
    chart.update(s);
    measurements.update(s.device);
    renderTable();
  });
  return () => {
    unsubscribe();
    chart.destroy();
  };
}
