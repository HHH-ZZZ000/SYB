import { element, text, count, button } from "../lib/format.js";
import { DataTable } from "../components/DataTable.js";
import { pageShell, devicePicker } from "./shared.js";
export function mount(container, { store, api }) {
  const root = pageShell("历史数据", "采样记录查询");
  const picker = devicePicker(store);
  root.querySelector(".page-actions").append(picker.root);
  const form = element(
    '<form class="panel filter-panel"><label>开始时间 · 北京时间<input name="start" type="datetime-local" step="1" aria-label="开始时间"></label><label>结束时间 · 北京时间<input name="end" type="datetime-local" step="1" aria-label="结束时间"></label><label>时间排序<select name="order" aria-label="历史数据时间排序"><option value="desc">最新在前</option><option value="asc">最早在前</option></select></label><button class="pause-button primary-button" type="submit">查询数据</button><button class="pause-button" type="reset">重置</button></form>',
  );
  const note = element(
    '<p class="query-message" role="status">按服务器接收时间查询。留空可查看全部历史记录。</p>',
  );
  const list = element(
    '<section class="panel history-panel"><div class="panel-heading"><div><h2>历史采样记录</h2><p class="subtle query-count">正在加载…</p></div><a class="pause-button export-link" aria-disabled="true">导出筛选结果 CSV</a></div></section>',
  );
  const table = DataTable("历史采样记录表格");
  list.append(table.root);
  const pager = element(
    '<div class="table-pagination"><span class="page-info mono"></span><div class="pagination-actions"></div></div>',
  );
  list.append(pager);
  root.append(form, note, list);
  container.replaceChildren(root);
  let filters = { device: store.selected, order: "desc", start: "", end: "" },
    page = 1,
    total = 0,
    busy = false,
    disposed = false,
    controller = null,
    requestId = 0,
    dirty = false;
  const previous = button("上一页", () => {
      page--;
      query();
    }),
    next = button("下一页", () => {
      page++;
      query();
    });
  pager.querySelector(".pagination-actions").append(previous, next);
  function updatePager() {
    previous.disabled = busy || dirty || page <= 1;
    next.disabled = busy || dirty || page * 20 >= total;
    text(pager, ".page-info", `第 ${page} / ${Math.max(1, Math.ceil(total / 20))} 页`);
  }
  function invalidateExport() {
    const link = list.querySelector(".export-link");
    link.removeAttribute("href");
    link.setAttribute("aria-disabled", "true");
  }
  async function query() {
    dirty = false;
    const id = ++requestId;
    controller?.abort();
    controller = new AbortController();
    busy = true;
    updatePager();
    invalidateExport();
    note.textContent = "正在查询历史记录…";
    table.update([], "正在加载…");
    try {
      const result = await api.queryHistory({ ...filters, page, page_size: 20 }, controller.signal);
      if (disposed || id !== requestId) return;
      total = result.total;
      table.update(result.samples, "当前筛选范围内没有采样记录");
      text(list, ".query-count", `共 ${count(total)} 条记录 · 每页 20 条`);
      note.textContent = "查询完成。导出包含本次筛选的全部记录。";
      const link = list.querySelector(".export-link");
      link.href = `/api/records/export?${new URLSearchParams(filters)}`;
      link.setAttribute("aria-disabled", String(!total));
      if (!total) link.removeAttribute("href");
    } catch (error) {
      if (disposed || id !== requestId) return;
      total = 0;
      table.update([], "查询失败，请重试");
      text(list, ".query-count", "记录数量暂不可用");
      note.textContent = "历史数据查询失败，请检查服务器连接后重新查询。";
    } finally {
      if (!disposed && id === requestId) {
        busy = false;
        updatePager();
      }
    }
  }
  function apply() {
    const values = Object.fromEntries(new FormData(form));
    if (values.start && values.end && values.start > values.end) {
      note.textContent = "开始时间不能晚于结束时间。";
      return;
    }
    filters = { ...values, device: store.selected };
    page = 1;
    query();
  }
  form.addEventListener("input", () => {
    dirty = true;
    requestId++;
    controller?.abort();
    busy = false;
    invalidateExport();
    updatePager();
    note.textContent = "筛选条件已修改，请点击查询。";
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    apply();
  });
  form.addEventListener("reset", () => {
    queueMicrotask(() => {
      if (!disposed) apply();
    });
  });
  const unsubscribe = store.subscribe((s) => {
    picker.update(s);
    if (filters.device !== s.device.id) {
      filters.device = s.device.id;
      page = 1;
      query();
    }
  });
  query();
  return () => {
    disposed = true;
    requestId++;
    controller?.abort();
    unsubscribe();
  };
}
