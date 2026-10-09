import { element, dateTime, number } from "../lib/format.js";
export function DataTable(label = "采样数据表格") {
  const root = element(
    '<div class="history-table-wrap" tabindex="0" role="region"><table><thead><tr><th scope="col">记录编号</th><th scope="col">接收时间 · 北京时间</th><th scope="col">X 轴 / g</th><th scope="col">Y 轴 / g</th><th scope="col">Z 轴 / g</th><th scope="col">合加速度 / g</th></tr></thead><tbody></tbody></table></div>',
  );
  root.setAttribute("aria-label", label);
  let previous = "";
  return {
    root,
    update(samples, message = "暂无采样记录") {
      const signature = JSON.stringify(samples) + message;
      if (signature === previous) return;
      previous = signature;
      const fragment = document.createDocumentFragment();
      for (const sample of samples) {
        const row = document.createElement("tr");
        [
          String(sample.id).padStart(6, "0"),
          dateTime(sample.received_at_ms),
          number(sample.acc_x),
          number(sample.acc_y),
          number(sample.acc_z),
          number(Math.hypot(sample.acc_x, sample.acc_y, sample.acc_z)),
        ].forEach((value, i) => {
          const cell = document.createElement("td");
          cell.textContent = value;
          cell.className = "mono" + (i >= 2 && i <= 4 ? ` cell-${["x", "y", "z"][i - 2]}` : "");
          row.append(cell);
        });
        fragment.append(row);
      }
      if (!samples.length) {
        const row = document.createElement("tr"),
          cell = document.createElement("td");
        cell.colSpan = 6;
        cell.className = "table-empty";
        cell.textContent = message;
        row.append(cell);
        fragment.append(row);
      }
      root.querySelector("tbody").replaceChildren(fragment);
    },
  };
}
