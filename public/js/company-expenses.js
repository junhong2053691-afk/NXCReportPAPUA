// 往来账（MONTHLY REPORT › COMPANY EXPENSES）。口径全在服务端 server/lib/companyExpenses.js，
// 这里只负责显示与导出，不做任何二次计算（每格 NET 与合计都由服务端给出）。
// 列名是租户数据（C STATUS 名），一律 translate="no"。
setActiveNav("company-expenses");

const ceGate = createRequestGate();
const ceState = { view: "month", month: todaySydney().slice(0, 7), year: todaySydney().slice(0, 4), data: null };

(function readQuery() {
  const params = new URLSearchParams(location.search);
  if (/^\d{4}$/.test(params.get("year") || "")) {
    ceState.view = "year";
    ceState.year = params.get("year");
  } else if (/^\d{4}-(0[1-9]|1[0-2])$/.test(params.get("month") || "")) {
    ceState.month = params.get("month");
    ceState.year = ceState.month.slice(0, 4);
  }
})();

function ceShiftMonth(monthKey, delta) {
  const y = Number(monthKey.slice(0, 4));
  const m = Number(monthKey.slice(5, 7)) - 1 + delta;
  const d = new Date(Date.UTC(y, m, 1));
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

const ceNumFmt = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function ceCell(value) {
  const n = Number(value || 0);
  return '<td class="num-col' + (n === 0 ? " ce-zero" : "") + '">' + escHtml(ceNumFmt.format(n)) + "</td>";
}

function cePeriodRows(data) {
  return ceState.view === "year"
    ? data.months.map(function (m) { return { label: m.month, row: m }; })
    : data.days.map(function (d) { return { label: d.date, row: d }; });
}

function ceRender(data) {
  const isYear = ceState.view === "year";
  document.getElementById("ce-period").textContent = isYear ? data.year : data.month;
  document.getElementById("ce-hint").hidden = !isYear;

  document.getElementById("ce-head").innerHTML =
    "<tr><th>" + (isYear ? "月份" : "日期") + "</th>" +
    data.columns.map(function (name) { return '<th translate="no">' + escHtml(name) + "</th>"; }).join("") +
    "<th>EXCHANGE</th></tr>";

  if (!data.columns.length) {
    document.getElementById("ce-total").innerHTML = "";
    renderTableState("ce-rows", 1, "没有往来方：请先在「支付渠道」页设置 C STATUS", "empty");
    return;
  }

  document.getElementById("ce-rows").innerHTML = cePeriodRows(data)
    .map(function (p) {
      const cls = ["mr-row"];
      if (p.row.future) cls.push("mr-future");
      if (isYear) cls.push("mr-clickable");
      const attrs = isYear ? ' data-month="' + escHtml(p.label) + '" tabindex="0"' : "";
      return '<tr class="' + cls.join(" ") + '"' + attrs + '><td translate="no">' + escHtml(p.label) + "</td>" +
        p.row.nets.map(ceCell).join("") + ceCell(p.row.exchange) + "</tr>";
    })
    .join("");
  document.getElementById("ce-total").innerHTML =
    "<tr><td>合计</td>" + data.total.map(ceCell).join("") + ceCell(data.exchange_total) + "</tr>";
}

function ceRenderControls() {
  const isYear = ceState.view === "year";
  document.querySelectorAll("#ce-view-tabs .seg-btn").forEach(function (btn) {
    btn.classList.toggle("active", btn.dataset.view === ceState.view);
  });
  document.getElementById("ce-prev").textContent = isYear ? "← 上一年" : "← 上个月";
  document.getElementById("ce-next").textContent = isYear ? "下一年 →" : "下个月 →";
  document.getElementById("ce-current").textContent = isYear ? "今年" : "本月";
  const params = isYear ? "?year=" + ceState.year : "?month=" + ceState.month;
  history.replaceState(null, "", location.pathname + params);
}

async function ceLoad() {
  ceRenderControls();
  const token = ceGate.begin();
  const wrap = resolveListWrap("ce-rows");
  setListLoading(wrap, true);
  try {
    const query = ceState.view === "year" ? "year=" + ceState.year : "month=" + ceState.month;
    const data = await api("/api/data/company-expenses?" + query);
    if (!ceGate.isCurrent(token) || !guardCompanyPayload(data)) return;
    ceState.data = data;
    ceRender(data);
  } catch (e) {
    if (e && e.cancelled) return;
    if (ceGate.isCurrent(token)) {
      ceState.data = null;
      document.getElementById("ce-total").innerHTML = "";
      const cols = document.querySelectorAll("#ce-head th").length || 1;
      renderTableState("ce-rows", cols, "往来账加载失败：" + (e.message || "请重试"), "error");
    }
  } finally {
    if (ceGate.isCurrent(token)) setListLoading(wrap, false);
  }
}

// 往来方名字是可编辑的租户数据：以 = + - @ 开头的会被 Sheet / Excel 当公式执行，前缀 ' 让它
// 按文本处理；名字里的 tab / 换行会让 TSV 错列，换成空格。只作用于名字，数字列（含负数）原样输出。
function ceSafeText(text) {
  const flat = String(text).replace(/[\t\r\n]+/g, " ");
  return /^[=+\-@]/.test(flat) ? "'" + flat : flat;
}

function ceExportMatrix() {
  const data = ceState.data;
  if (!data) return null;
  const header = [ceState.view === "year" ? "MONTH" : "DATE"].concat(data.columns.map(ceSafeText), ["EXCHANGE"]);
  const raw = function (v) { return Number(v || 0).toFixed(2); };
  const body = cePeriodRows(data).map(function (p) { return [p.label].concat(p.row.nets.map(raw), [raw(p.row.exchange)]); });
  return [header].concat(body, [["TOTAL"].concat(data.total.map(raw), [raw(data.exchange_total)])]);
}

function ceCopy() {
  const matrix = ceExportMatrix();
  if (matrix) copyTableMatrix(matrix);
}

function ceCsv() {
  const matrix = ceExportMatrix();
  if (!matrix) return;
  const period = ceState.view === "year" ? ceState.data.year : ceState.data.month;
  const company = String(activeCompanyId || "company").replace(/[^\w-]+/g, "_");
  downloadTableCsv(matrix, "company-expenses-" + company + "-" + period + ".csv");
}

function ceStep(delta) {
  if (ceState.view === "year") ceState.year = String(Number(ceState.year) + delta);
  else ceState.month = ceShiftMonth(ceState.month, delta);
  ceLoad();
}

function ceOpenMonth(monthKey) {
  ceState.view = "month";
  ceState.month = monthKey;
  ceLoad();
}

document.getElementById("ce-prev").onclick = function () { ceStep(-1); };
document.getElementById("ce-next").onclick = function () { ceStep(1); };
document.getElementById("ce-current").onclick = function () {
  if (ceState.view === "year") ceState.year = todaySydney().slice(0, 4);
  else ceState.month = todaySydney().slice(0, 7);
  ceLoad();
};
document.querySelectorAll("#ce-view-tabs .seg-btn").forEach(function (btn) {
  btn.onclick = function () {
    if (btn.dataset.view === ceState.view) return;
    if (btn.dataset.view === "year") ceState.year = ceState.month.slice(0, 4);
    else ceState.month = ceState.year === todaySydney().slice(0, 4) ? todaySydney().slice(0, 7) : ceState.year + "-01";
    ceState.view = btn.dataset.view;
    ceLoad();
  };
});
document.getElementById("ce-rows").addEventListener("click", function (event) {
  const tr = event.target.closest("tr[data-month]");
  if (tr) ceOpenMonth(tr.dataset.month);
});
document.getElementById("ce-rows").addEventListener("keydown", function (event) {
  if (event.key !== "Enter" && event.key !== " ") return;
  const tr = event.target.closest("tr[data-month]");
  if (!tr) return;
  event.preventDefault();
  ceOpenMonth(tr.dataset.month);
});
document.getElementById("ce-copy").onclick = ceCopy;
document.getElementById("ce-csv").onclick = ceCsv;

bindCompanySwitch(ceLoad);
ceLoad();
