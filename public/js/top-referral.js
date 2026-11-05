// TOP REFERRAL（MONTHLY REPORT › TOP REFERRAL）。口径全在服务端 server/lib/topReferral.js，
// 这里只负责显示、抽屉与导出，不做任何二次计算（各列、TOTAL、抽屉指标都由服务端给出）。
// 推荐人名、客户姓名 / username 是租户数据，一律 translate="no"。
setActiveNav("top-referral");

const TR_ORGANIC_KEY = "__organic__";
const TR_PAGE_SIZE = 50;
const TR_DRAWER_PAGE_SIZE = 50;
const trGate = createRequestGate();
const trState = {
  view: "month",
  month: todaySydney().slice(0, 7),
  year: todaySydney().slice(0, 4),
  sort: "newMember",
  page: 1,
  data: null,
};
const trDrawer = { referrer: null, data: null, page: 1, seq: 0, lastFocus: null };

(function readQuery() {
  const params = new URLSearchParams(location.search);
  if (/^\d{4}$/.test(params.get("year") || "")) {
    trState.view = "year";
    trState.year = params.get("year");
  } else if (/^\d{4}-(0[1-9]|1[0-2])$/.test(params.get("month") || "")) {
    trState.month = params.get("month");
    trState.year = trState.month.slice(0, 4);
  }
  // 排序键只认 <select> 里有的那几个（与服务端 SORTS 对应），不在这里另抄一份名单。
  const sorts = Array.from(document.querySelectorAll("#tr-sort option")).map(function (o) { return o.value; });
  if (sorts.indexOf(params.get("sort")) >= 0) trState.sort = params.get("sort");
})();

function trShiftMonth(monthKey, delta) {
  const y = Number(monthKey.slice(0, 4));
  const m = Number(monthKey.slice(5, 7)) - 1 + delta;
  const d = new Date(Date.UTC(y, m, 1));
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

function trPeriodQuery() {
  return trState.view === "year" ? "year=" + trState.year : "month=" + trState.month;
}

const trMoneyFmt = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function trMoney(value) {
  return trMoneyFmt.format(Number(value || 0));
}

function trNumCell(value, money) {
  const n = Number(value || 0);
  return '<td class="num-col' + (n === 0 ? " ce-zero" : "") + '">' + escHtml(money ? trMoney(n) : String(n)) + "</td>";
}

function trNetCell(value) {
  const n = Number(value || 0);
  const cls = n > 0 ? " mr-win" : n < 0 ? " mr-lose" : " ce-zero";
  return '<td class="num-col' + cls + '">' + escHtml(trMoney(n)) + "</td>";
}

function trMetricCells(m) {
  return trNumCell(m.newMember) + trNumCell(m.firstDepCount) + trNumCell(m.dep, true) + trNetCell(m.net);
}

// ---- 排行 ------------------------------------------------------------------

function trRender(data) {
  document.getElementById("tr-period").textContent = data.period;
  document.getElementById("tr-referrers").innerHTML = data.referrers
    .map(function (name) { return '<option value="' + escHtml(name) + '"></option>'; })
    .join("");

  const total = data.rows.length;
  const pages = Math.max(1, Math.ceil(total / TR_PAGE_SIZE));
  trState.page = Math.min(trState.page, pages);
  const start = (trState.page - 1) * TR_PAGE_SIZE;

  if (!total) {
    renderTableState("tr-rows", 6, "本期没有推荐人有动静", "empty");
  } else {
    document.getElementById("tr-rows").innerHTML = data.rows
      .slice(start, start + TR_PAGE_SIZE)
      .map(function (r) {
        return '<tr class="mr-row mr-clickable" tabindex="0" data-referrer="' + escHtml(r.referrer) + '"><td>' + r.rank +
          '</td><td translate="no">' + escHtml(r.referrer) + "</td>" + trMetricCells(r) + "</tr>";
      })
      .join("");
  }
  // 自然流量不给名次，和 TOTAL 一起钉在表尾，翻页也看得到。
  document.getElementById("tr-total").innerHTML =
    '<tr class="tr-organic mr-clickable" tabindex="0" data-referrer="' + TR_ORGANIC_KEY + '"><td></td><td>自然流量</td>' +
    trMetricCells(data.organic) + "</tr>" +
    "<tr><td></td><td>合计</td>" + trMetricCells(data.total) + "</tr>";

  renderClientPager("tr-pager", total, trState.page, TR_PAGE_SIZE, function (page) {
    trState.page = page;
    trRender(trState.data);
    document.getElementById("tr-table").scrollIntoView({ block: "start" });
  });
}

function trRenderControls() {
  const isYear = trState.view === "year";
  document.querySelectorAll("#tr-view-tabs .seg-btn").forEach(function (btn) {
    btn.classList.toggle("active", btn.dataset.view === trState.view);
  });
  document.getElementById("tr-prev").textContent = isYear ? "← 上一年" : "← 上个月";
  document.getElementById("tr-next").textContent = isYear ? "下一年 →" : "下个月 →";
  document.getElementById("tr-current").textContent = isYear ? "今年" : "本月";
  document.getElementById("tr-sort").value = trState.sort;
  history.replaceState(null, "", location.pathname + "?" + trPeriodQuery() + "&sort=" + trState.sort);
}

async function trLoad() {
  trRenderControls();
  // 抽屉开着时换了月份 / 年份 / 排序，抽屉跟着换期。放在排行请求之前、与它无关：
  // 排行加载失败时抽屉也不能留着上一期的数字。
  if (trDrawerIsOpen()) trOpenDrawer(trDrawer.referrer);
  const token = trGate.begin();
  const wrap = resolveListWrap("tr-rows");
  setListLoading(wrap, true);
  try {
    const data = await api("/api/data/top-referral?" + trPeriodQuery() + "&sort=" + encodeURIComponent(trState.sort));
    if (!trGate.isCurrent(token) || !guardCompanyPayload(data)) return;
    trState.data = data;
    trRender(data);
  } catch (e) {
    if (e && e.cancelled) return;
    if (trGate.isCurrent(token)) {
      trState.data = null;
      document.getElementById("tr-total").innerHTML = "";
      renderClientPager("tr-pager", 0, 1, TR_PAGE_SIZE, function () {});
      renderTableState("tr-rows", 6, "推荐人月报加载失败：" + (e.message || "请重试"), "error");
    }
  } finally {
    if (trGate.isCurrent(token)) setListLoading(wrap, false);
  }
}

// ---- 抽屉 ------------------------------------------------------------------

function trDrawerIsOpen() {
  return document.getElementById("tr-drawer-backdrop").classList.contains("show");
}

function trCard(label, value, sub, cls) {
  return '<div class="cd-card"><div class="label">' + label + '</div><div class="value' + (cls ? " " + cls : "") + '">' +
    escHtml(value) + "</div>" + (sub ? '<div class="sub">' + sub + "</div>" : "") + "</div>";
}

function trRenderDrawer() {
  const data = trDrawer.data;
  const m = data.metrics;
  const netCls = m.net > 0 ? "positive" : m.net < 0 ? "negative" : "muted";
  let html =
    '<div class="cd-cards">' +
    trCard("NEW MEMBER", String(m.newMember)) +
    trCard("FIRST DEPOSIT", trMoney(m.firstDepAmount), m.firstDepCount + " 人") +
    trCard("FIRST DAY DEPOSIT", trMoney(m.firstDayAmount), m.firstDayCount + " 笔") +
    trCard("SAME DAY DEPOSIT", trMoney(m.sameDayAmount), m.sameDayUsers + " 人") +
    trCard("REGULAR DEPOSIT", trMoney(m.regular), m.regularCount + " 笔") +
    trCard("TOTAL DEPOSIT", trMoney(m.dep), m.depCount + " 笔") +
    trCard("TOTAL WITHDRAW", trMoney(m.wd), m.wdCount + " 笔") +
    trCard("TOTAL NET", trMoney(m.net), "", netCls) +
    "</div>" +
    '<h3 class="cd-section-title">本期有动静的下线</h3>';

  const list = data.downlines;
  if (!list.length) {
    html += '<p class="cd-loading">本期没有动静</p>';
    document.getElementById("tr-drawer-body").innerHTML = html;
    return;
  }
  const pages = Math.max(1, Math.ceil(list.length / TR_DRAWER_PAGE_SIZE));
  trDrawer.page = Math.min(trDrawer.page, pages);
  const start = (trDrawer.page - 1) * TR_DRAWER_PAGE_SIZE;
  html +=
    '<div class="table-wrap cd-tx-table"><table><thead><tr><th>客户</th><th>注册日</th><th>首充日</th><th>首充额</th>' +
    "<th>本期充值</th><th>本期提现</th><th>NET</th></tr></thead><tbody>" +
    list
      .slice(start, start + TR_DRAWER_PAGE_SIZE)
      .map(function (d) {
        return '<tr><td translate="no">' + customerLink(d.name || d.username || d.id, d.id, "") + "</td>" +
          '<td translate="no">' + escHtml(d.registerDate || "-") + "</td>" +
          '<td translate="no">' + escHtml(d.firstDepDate || "-") + "</td>" +
          trNumCell(d.firstDepAmount, true) + trNumCell(d.dep, true) + trNumCell(d.wd, true) + trNetCell(d.net) + "</tr>";
      })
      .join("") +
    '</tbody></table></div><div class="pager" id="tr-drawer-pager"></div>';
  document.getElementById("tr-drawer-body").innerHTML = html;
  renderClientPager("tr-drawer-pager", list.length, trDrawer.page, TR_DRAWER_PAGE_SIZE, function (page) {
    trDrawer.page = page;
    trRenderDrawer();
    document.getElementById("tr-drawer-body").scrollTop = 0;
  });
}

async function trOpenDrawer(referrer) {
  if (!referrer) return;
  const backdrop = document.getElementById("tr-drawer-backdrop");
  const switching = referrer !== trDrawer.referrer;
  if (!trDrawerIsOpen()) {
    trDrawer.lastFocus = document.activeElement && typeof document.activeElement.focus === "function" ? document.activeElement : null;
    backdrop.classList.add("show");
    backdrop.setAttribute("aria-hidden", "false");
    document.body.classList.add("tr-drawer-open");
    window.requestAnimationFrame(function () {
      if (trDrawerIsOpen()) document.getElementById("tr-drawer-close").focus();
    });
  }
  if (switching) trDrawer.page = 1;
  trDrawer.referrer = referrer;
  const seq = ++trDrawer.seq;
  const title = document.getElementById("tr-drawer-title");
  if (referrer === TR_ORGANIC_KEY) {
    title.removeAttribute("translate");
    title.textContent = "自然流量";
  } else {
    title.setAttribute("translate", "no");
    title.textContent = referrer;
  }
  document.getElementById("tr-drawer-sub").textContent = trState.view === "year" ? trState.year : trState.month;
  document.getElementById("tr-drawer-body").innerHTML = '<p class="cd-loading">加载中…</p>';
  try {
    const data = await api(
      "/api/data/top-referral/referrer?" + trPeriodQuery() + "&referrer=" + encodeURIComponent(referrer)
    );
    if (seq !== trDrawer.seq || !guardCompanyPayload(data)) return;
    trDrawer.data = data;
    trRenderDrawer();
  } catch (e) {
    if (seq !== trDrawer.seq || (e && e.cancelled)) return;
    document.getElementById("tr-drawer-body").innerHTML = '<p class="cd-error">' + escHtml(e.message || "加载失败") + "</p>";
  }
}

function trCloseDrawer() {
  if (!trDrawerIsOpen()) return;
  trDrawer.seq += 1;
  trDrawer.referrer = null;
  trDrawer.data = null;
  const backdrop = document.getElementById("tr-drawer-backdrop");
  backdrop.classList.remove("show");
  backdrop.setAttribute("aria-hidden", "true");
  document.body.classList.remove("tr-drawer-open");
  const focus = trDrawer.lastFocus;
  trDrawer.lastFocus = null;
  if (focus && document.contains(focus)) focus.focus();
}

// 客户详情抽屉（customer-detail.js）叠在上层时，它的 keydown 监听先注册、并且
// stopImmediatePropagation，所以 Esc / Tab 只作用于最上层那一个抽屉。
document.addEventListener("keydown", function (e) {
  if (!trDrawerIsOpen()) return;
  if (e.key === "Escape") {
    e.preventDefault();
    trCloseDrawer();
    return;
  }
  if (e.key !== "Tab") return;
  const drawer = document.getElementById("tr-drawer");
  const focusable = Array.from(
    drawer.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
  ).filter(function (node) { return !node.disabled && !node.hidden && node.getClientRects().length > 0; });
  if (!focusable.length) {
    e.preventDefault();
    drawer.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !drawer.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !drawer.contains(active))) {
    e.preventDefault();
    first.focus();
  }
});

// ---- 导出 ------------------------------------------------------------------

// 推荐人名是租户数据：以 = + - @ 开头的会被 Sheet / Excel 当公式执行，前缀 ' 让它按文本处理；
// 名字里的 tab / 换行会让 TSV 错列，换成空格。只作用于名字，数字列原样输出。
function trSafeText(text) {
  const flat = String(text).replace(/[\t\r\n]+/g, " ");
  return /^[=+\-@]/.test(flat) ? "'" + flat : flat;
}

// 列顺序照平台的 Top Referrer Report（去掉 MOBILE 与 AVG DAILY MEMBER），粘回 Sheet 对得齐。
const TR_EXPORT_COLUMNS = [
  ["NEW MEMBER", "newMember", false],
  ["FIRST DEPOSIT COUNT", "firstDepCount", false],
  ["FIRST DEPOSIT AMOUNT", "firstDepAmount", true],
  ["FIRST DAY DEPOSIT COUNT", "firstDayCount", false],
  ["FIRST DAY DEPOSIT AMOUNT", "firstDayAmount", true],
  ["SAME DAY DEPOSIT USER", "sameDayUsers", false],
  ["SAME DAY DEPOSIT AMOUNT", "sameDayAmount", true],
  ["TOTAL DEPOSIT COUNT", "depCount", false],
  ["TOTAL DEPOSIT", "dep", true],
  ["REGULAR DEPOSIT COUNT", "regularCount", false],
  ["REGULAR DEPOSIT", "regular", true],
  ["TOTAL WITHDRAW COUNT", "wdCount", false],
  ["TOTAL WITHDRAW", "wd", true],
  ["TOTAL NET", "net", true],
];

function trExportMatrix() {
  const data = trState.data;
  if (!data) return null;
  const line = function (name, m) {
    return [name].concat(TR_EXPORT_COLUMNS.map(function (c) {
      return c[2] ? Number(m[c[1]] || 0).toFixed(2) : String(m[c[1]] || 0);
    }));
  };
  const header = ["NAME"].concat(TR_EXPORT_COLUMNS.map(function (c) { return c[0]; }));
  const body = data.rows.map(function (r) { return line(trSafeText(r.referrer), r); });
  return [header].concat(body, [line("ORGANIC", data.organic), line("TOTAL", data.total)]);
}

function trCopy() {
  const matrix = trExportMatrix();
  if (matrix) copyTableMatrix(matrix);
}

function trCsv() {
  const matrix = trExportMatrix();
  if (!matrix) return;
  const company = String(activeCompanyId || "company").replace(/[^\w-]+/g, "_");
  downloadTableCsv(matrix, "top-referral-" + company + "-" + trState.data.period + ".csv");
}

// ---- 事件 ------------------------------------------------------------------

function trStep(delta) {
  if (trState.view === "year") trState.year = String(Number(trState.year) + delta);
  else trState.month = trShiftMonth(trState.month, delta);
  trState.page = 1;
  trLoad();
}

document.getElementById("tr-prev").onclick = function () { trStep(-1); };
document.getElementById("tr-next").onclick = function () { trStep(1); };
document.getElementById("tr-current").onclick = function () {
  if (trState.view === "year") trState.year = todaySydney().slice(0, 4);
  else trState.month = todaySydney().slice(0, 7);
  trState.page = 1;
  trLoad();
};
document.querySelectorAll("#tr-view-tabs .seg-btn").forEach(function (btn) {
  btn.onclick = function () {
    if (btn.dataset.view === trState.view) return;
    if (btn.dataset.view === "year") trState.year = trState.month.slice(0, 4);
    else trState.month = trState.year === todaySydney().slice(0, 4) ? todaySydney().slice(0, 7) : trState.year + "-01";
    trState.view = btn.dataset.view;
    trState.page = 1;
    trLoad();
  };
});
document.getElementById("tr-sort").onchange = function () {
  trState.sort = this.value;
  trState.page = 1;
  trLoad();
};

// 搜索框：选中（或敲回车时完全等于）某个推荐人才打开抽屉；名单里没有的名字不做任何事。
function trSearchPick() {
  const input = document.getElementById("tr-search");
  const name = input.value.trim();
  if (!name || !trState.data || trState.data.referrers.indexOf(name) < 0) return;
  trOpenDrawer(name);
}
document.getElementById("tr-search").addEventListener("change", trSearchPick);
document.getElementById("tr-search").addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    e.preventDefault();
    trSearchPick();
  }
});

function trRowReferrer(event) {
  const tr = event.target.closest("tr[data-referrer]");
  return tr ? tr.dataset.referrer : null;
}
["tr-rows", "tr-total"].forEach(function (id) {
  const el = document.getElementById(id);
  el.addEventListener("click", function (event) {
    const ref = trRowReferrer(event);
    if (ref) trOpenDrawer(ref);
  });
  el.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const ref = trRowReferrer(event);
    if (!ref) return;
    event.preventDefault();
    trOpenDrawer(ref);
  });
});

document.getElementById("tr-drawer-close").onclick = trCloseDrawer;
document.getElementById("tr-drawer-backdrop").onclick = function (e) {
  if (e.target.id === "tr-drawer-backdrop") trCloseDrawer();
};
document.getElementById("tr-copy").onclick = trCopy;
document.getElementById("tr-csv").onclick = trCsv;

bindCompanySwitch(function () {
  trCloseDrawer();
  document.getElementById("tr-search").value = "";
  trState.page = 1;
  return trLoad();
});
trLoad();
