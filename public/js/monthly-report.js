// 月报（MONTHLY REPORT › REPORT）。口径全在服务端 server/lib/monthlyReport.js，这里只负责
// 显示与导出，不做任何二次计算（总单、WIN/LOSE、WIN RATE 都由服务端给出）。
setActiveNav("monthly-report");

const mrGate = createRequestGate();
const MR_COLS = [
  { key: "dep", kind: "money" },
  { key: "wd", kind: "money" },
  { key: "winLose", kind: "signed" },
  { key: "winRate", kind: "rate" },
  { key: "unclaim", kind: "money" },
  { key: "wrong", kind: "money" },
  { key: "expenses", kind: "money" },
  { key: "exchange", kind: "money" },
  { key: "depCount", kind: "int" },
  { key: "wdCount", kind: "int" },
  { key: "totalCount", kind: "int" },
  { key: "uniqueCust", kind: "int" },
];
// 导出表头刻意全英文：粘到 Google Sheet 后不随页面语言变化，公式引用列名也稳定。
const MR_EXPORT_HEADERS = ["DEP", "WD", "WIN/LOSE", "WIN RATE", "UNCLAIM", "WRONG", "EXPENSES", "EXCHANGE", "DEP COUNT", "WD COUNT", "TOTAL COUNT", "UNIQUE CUST"];

const mrState = { view: "month", month: todaySydney().slice(0, 7), year: todaySydney().slice(0, 4), data: null };

(function readQuery() {
  const params = new URLSearchParams(location.search);
  if (/^\d{4}$/.test(params.get("year") || "")) {
    mrState.view = "year";
    mrState.year = params.get("year");
  } else if (/^\d{4}-(0[1-9]|1[0-2])$/.test(params.get("month") || "")) {
    mrState.month = params.get("month");
    mrState.year = mrState.month.slice(0, 4);
  }
})();

function shiftMonth(monthKey, delta) {
  const y = Number(monthKey.slice(0, 4));
  const m = Number(monthKey.slice(5, 7)) - 1 + delta;
  const d = new Date(Date.UTC(y, m, 1));
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

const numFmt = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtCell(value, kind) {
  if (kind === "rate") return value == null ? "—" : (value > 0 ? "+" : "") + (value * 100).toFixed(2) + "%";
  if (kind === "int") return String(value || 0);
  const n = Number(value || 0);
  if (kind === "signed" && n > 0) return "+" + numFmt.format(n);
  return numFmt.format(n);
}

// 导出给 Google Sheet / CSV 用的原始值：不带千分位，否则粘贴后被当成文本而不是数字。
function rawCell(value, kind) {
  if (kind === "rate") return value == null ? "" : (value * 100).toFixed(2) + "%";
  if (kind === "int") return String(value || 0);
  return Number(value || 0).toFixed(2);
}

function signClass(value, kind) {
  if (kind !== "signed" && kind !== "rate") return "";
  const n = Number(value || 0);
  if (value == null || n === 0) return "";
  return n > 0 ? " mr-win" : " mr-lose";
}

function rowCells(row) {
  return MR_COLS.map(function (col) {
    const value = row[col.key];
    let text = escHtml(fmtCell(value, col.kind));
    if (col.key === "winLose" && Number(value) !== 0) {
      text += ' <span class="mr-tag">' + (Number(value) > 0 ? "WIN" : "LOSE") + "</span>";
    }
    return '<td class="num-col' + signClass(value, col.kind) + '">' + text + "</td>";
  }).join("");
}

function periodRows(data) {
  return mrState.view === "year"
    ? data.months.map(function (m) { return { label: m.month, row: m }; })
    : data.days.map(function (d) { return { label: d.date, row: d }; });
}

function render(data) {
  const isYear = mrState.view === "year";
  document.getElementById("mr-period").textContent = isYear ? data.year : data.month;
  document.getElementById("mr-first-col").textContent = isYear ? "月份" : "日期";
  document.getElementById("mr-hint").hidden = !isYear;

  document.getElementById("mr-rows").innerHTML = periodRows(data)
    .map(function (p) {
      const cls = ["mr-row"];
      if (p.row.future) cls.push("mr-future");
      if (isYear) cls.push("mr-clickable");
      const attrs = isYear ? ' data-month="' + escHtml(p.label) + '" tabindex="0"' : "";
      return '<tr class="' + cls.join(" ") + '"' + attrs + '><td translate="no">' + escHtml(p.label) + "</td>" + rowCells(p.row) + "</tr>";
    })
    .join("");
  document.getElementById("mr-total").innerHTML = '<tr class="mr-total-row"><td>合计</td>' + rowCells(data.total) + "</tr>";
}

function renderControls() {
  const isYear = mrState.view === "year";
  document.querySelectorAll("#mr-view-tabs .seg-btn").forEach(function (btn) {
    btn.classList.toggle("active", btn.dataset.view === mrState.view);
  });
  document.getElementById("mr-prev").textContent = isYear ? "← 上一年" : "← 上个月";
  document.getElementById("mr-next").textContent = isYear ? "下一年 →" : "下个月 →";
  document.getElementById("mr-current").textContent = isYear ? "今年" : "本月";
  const params = isYear ? "?year=" + mrState.year : "?month=" + mrState.month;
  history.replaceState(null, "", location.pathname + params);
}

async function loadReport() {
  renderControls();
  const token = mrGate.begin();
  const wrap = resolveListWrap("mr-rows");
  setListLoading(wrap, true);
  try {
    const query = mrState.view === "year" ? "year=" + mrState.year : "month=" + mrState.month;
    const data = await api("/api/data/monthly-report?" + query);
    if (!mrGate.isCurrent(token) || !guardCompanyPayload(data)) return;
    mrState.data = data;
    render(data);
  } catch (e) {
    if (e && e.cancelled) return;
    if (mrGate.isCurrent(token)) {
      mrState.data = null;
      document.getElementById("mr-total").innerHTML = "";
      renderTableState("mr-rows", MR_COLS.length + 1, "月报加载失败：" + (e.message || "请重试"), "error");
    }
  } finally {
    if (mrGate.isCurrent(token)) setListLoading(wrap, false);
  }
}

function exportMatrix() {
  const data = mrState.data;
  if (!data) return null;
  const header = [mrState.view === "year" ? "MONTH" : "DATE"].concat(MR_EXPORT_HEADERS);
  const body = periodRows(data).map(function (p) {
    return [p.label].concat(MR_COLS.map(function (col) { return rawCell(p.row[col.key], col.kind); }));
  });
  const total = ["TOTAL"].concat(MR_COLS.map(function (col) { return rawCell(data.total[col.key], col.kind); }));
  return [header].concat(body, [total]);
}

function copyTable() {
  const matrix = exportMatrix();
  if (matrix) copyTableMatrix(matrix);
}

function downloadCsv() {
  const matrix = exportMatrix();
  if (!matrix) return;
  const period = mrState.view === "year" ? mrState.data.year : mrState.data.month;
  const company = String(activeCompanyId || "company").replace(/[^\w-]+/g, "_");
  downloadTableCsv(matrix, "monthly-report-" + company + "-" + period + ".csv");
}

function step(delta) {
  if (mrState.view === "year") mrState.year = String(Number(mrState.year) + delta);
  else mrState.month = shiftMonth(mrState.month, delta);
  loadReport();
}

function openMonth(monthKey) {
  mrState.view = "month";
  mrState.month = monthKey;
  loadReport();
}

document.getElementById("mr-prev").onclick = function () { step(-1); };
document.getElementById("mr-next").onclick = function () { step(1); };
document.getElementById("mr-current").onclick = function () {
  if (mrState.view === "year") mrState.year = todaySydney().slice(0, 4);
  else mrState.month = todaySydney().slice(0, 7);
  loadReport();
};
document.querySelectorAll("#mr-view-tabs .seg-btn").forEach(function (btn) {
  btn.onclick = function () {
    if (btn.dataset.view === mrState.view) return;
    if (btn.dataset.view === "year") mrState.year = mrState.month.slice(0, 4);
    else mrState.month = mrState.year === todaySydney().slice(0, 4) ? todaySydney().slice(0, 7) : mrState.year + "-01";
    mrState.view = btn.dataset.view;
    loadReport();
  };
});
document.getElementById("mr-rows").addEventListener("click", function (event) {
  const tr = event.target.closest("tr[data-month]");
  if (tr) openMonth(tr.dataset.month);
});
document.getElementById("mr-rows").addEventListener("keydown", function (event) {
  if (event.key !== "Enter" && event.key !== " ") return;
  const tr = event.target.closest("tr[data-month]");
  if (!tr) return;
  event.preventDefault();
  openMonth(tr.dataset.month);
});
document.getElementById("mr-copy").onclick = copyTable;
document.getElementById("mr-csv").onclick = downloadCsv;

bindCompanySwitch(loadReport);
loadReport();
