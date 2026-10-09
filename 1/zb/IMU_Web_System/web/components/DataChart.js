import { AXES, AXIS_LABELS, COLORS, windowSamples } from "../models/Device.js";
import { element, text, clockTime } from "../lib/format.js";
export function chartOption(samples, end, seconds, selected) {
  return {
    animation: false,
    color: COLORS,
    textStyle: { fontFamily: "Segoe UI, Microsoft YaHei, sans-serif" },
    grid: { left: 44, right: 20, top: 22, bottom: 32 },
    tooltip: { trigger: "axis", renderMode: "richText", confine: true },
    xAxis: {
      type: "time",
      min: end - seconds * 1000,
      max: end,
      axisLabel: { color: "#737f88", formatter: clockTime, hideOverlap: true },
      axisLine: { lineStyle: { color: "#dde2e5" } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      min: -2,
      max: 2,
      splitLine: { lineStyle: { color: "#edf0f2" } },
      axisLabel: { color: "#737f88" },
    },
    series: AXES.map((axis, i) => ({
      id: axis,
      name: AXIS_LABELS[i],
      type: "line",
      showSymbol: samples.length === 1,
      symbolSize: 5,
      lineStyle: { width: 1.8 },
      connectNulls: false,
      data: selected[i]
        ? samples.flatMap((row, index) => {
            const point = [row.received_at_ms, row[axis]];
            return index && row.received_at_ms - samples[index - 1].received_at_ms > 1500
              ? [[row.received_at_ms - 1, null], point]
              : [point];
          })
        : [],
    })),
  };
}
export function DataChart(title = "实时加速度趋势") {
  const root = element(
    `<section class="panel chart-panel"><div class="trends-toolbar"><div><h2></h2><p class="subtle chart-mode"></p></div><button type="button" class="pause-button chart-pause" aria-pressed="false">Ⅱ 冻结曲线</button></div><div class="chart-meta"><span class="subtle">加速度 / g</span><div class="axis-switches" aria-label="选择显示的坐标轴">${AXES.map((axis, i) => `<button type="button" class="axis-toggle axis-${["x", "y", "z"][i]}" data-axis="${i}" aria-pressed="true">${["X", "Y", "Z"][i]} 轴</button>`).join("")}</div></div><div class="chart-container"><div class="echart" role="img" aria-label="三轴加速度趋势图，读数见测量卡片或数据表"></div><div class="chart-empty"><span class="empty-icon">⌁</span><strong>正在加载采样数据</strong><span>设备上传后显示真实曲线</span></div></div><div class="chart-footer"><span>当前窗口 <span class="chart-point-count mono">0</span> 个采样点</span><span>北京时间</span></div></section>`,
  );
  text(root, "h2", title);
  let chart = null,
    observer = null,
    last = null,
    paused = false,
    frozen = null,
    lastDraw = 0;
  const selected = [true, true, true];
  const draw = (force = false) => {
    if (!last) return;
    const now = performance.now();
    if (!force && now - lastDraw < last.prefs.refreshMs) return;
    lastDraw = now;
    if (!chart && root.isConnected) {
      if (!window.echarts) {
        text(root, ".chart-empty strong", "图表库加载失败，请重新加载页面");
        return;
      }
      chart = window.echarts.init(root.querySelector(".echart"));
      observer = new ResizeObserver(() => chart?.resize());
      observer.observe(root.querySelector(".echart"));
    }
    const snapshot = paused ? frozen : last;
    const end = Math.max(snapshot.now, snapshot.samples.at(-1)?.received_at_ms || 0);
    const samples = windowSamples(snapshot.samples, end, snapshot.prefs.windowSeconds);
    text(
      root,
      ".chart-mode",
      paused ? "曲线已冻结 · 测量值继续更新" : `最近${snapshot.prefs.windowSeconds}秒实时数据`,
    );
    text(root, ".chart-point-count", samples.length);
    const message = last.error
      ? "服务器连接不可用"
      : last.historyError
        ? "历史数据加载失败"
        : !last.historyLoaded
          ? "正在加载采样数据"
          : !selected.some(Boolean)
            ? "请选择至少一个坐标轴"
            : "当前时间窗口内暂无采样";
    text(root, ".chart-empty strong", message);
    root.querySelector(".chart-empty").hidden = samples.length > 0 && selected.some(Boolean);
    chart?.setOption(chartOption(samples, end, snapshot.prefs.windowSeconds, selected));
  };
  root.querySelector(".chart-pause").addEventListener("click", () => {
    if (!last) return;
    paused = !paused;
    frozen = paused ? { ...last, samples: last.samples.slice(), prefs: { ...last.prefs } } : null;
    text(root, ".chart-pause", paused ? "▷ 继续曲线" : "Ⅱ 冻结曲线");
    root.querySelector(".chart-pause").setAttribute("aria-pressed", String(paused));
    draw(true);
  });
  root.querySelectorAll(".axis-toggle").forEach((button) =>
    button.addEventListener("click", () => {
      const index = Number(button.dataset.axis);
      selected[index] = !selected[index];
      button.setAttribute("aria-pressed", String(selected[index]));
      draw(true);
    }),
  );
  return {
    root,
    update(snapshot) {
      if (last && last.device.id !== snapshot.device.id) {
        paused = false;
        frozen = null;
        lastDraw = 0;
        text(root, ".chart-pause", "Ⅱ 冻结曲线");
        root.querySelector(".chart-pause").setAttribute("aria-pressed", "false");
      }
      last = snapshot;
      if (!paused || !chart) draw();
    },
    destroy() {
      observer?.disconnect();
      chart?.dispose();
      chart = null;
    },
  };
}
