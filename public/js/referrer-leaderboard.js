setActiveNav("referrers");

let currentSort = "first_dep";
let currentDateFrom = todaySydney();
let currentDateTo = todaySydney();
let currentPage = 1;
const referrerLoadGate = createRequestGate();
const REFERRER_PAGE_SIZE = 50;

const SORT_LABELS = {
  first_dep: "\u9996\u5145\u4eba\u6570",
  new_regs: "\u65b0\u6ce8\u518c",
  dep_total: "\u5145\u503c\u603b\u989d",
  total_sum: "\u6392\u540d\u603b\u548c",
};

const COL_HEADERS = {
  range: {
    new_regs: "\u65b0\u6ce8\u518c",
    first_dep: "\u9996\u5145\u4eba\u6570",
    dep_users: "\u5145\u503c\u4eba\u6570",
    total_customers: "\u7d2f\u8ba1\u987e\u5ba2",
  },
  all_time: {
    new_regs: "\u7d2f\u8ba1\u987e\u5ba2",
    first_dep: "\u9996\u5145\u4eba\u6570",
    dep_users: "\u5145\u503c\u4eba\u6570",
    total_customers: "\u7efc\u5408\u5206",
  },
};

function isAllTimeMode() {
  return currentSort === "total_sum";
}

function reportUrl(referrerKey, data) {
  if (data.mode === "all_time") {
    return "/referrer-report.html?referrer=" + encodeURIComponent(referrerKey);
  }
  return (
    "/referrer-report.html?referrer=" +
    encodeURIComponent(referrerKey) +
    "&dateFrom=" +
    encodeURIComponent(data.dateFrom) +
    "&dateTo=" +
    encodeURIComponent(data.dateTo)
  );
}

function applyDateInputs() {
  document.getElementById("date-from").value = currentDateFrom;
  document.getElementById("date-to").value = currentDateTo;
}

function readDateInputs() {
  if (isAllTimeMode()) return;
  currentDateFrom = document.getElementById("date-from").value || todaySydney();
  currentDateTo = document.getElementById("date-to").value || currentDateFrom;
  if (currentDateFrom > currentDateTo) {
    const tmp = currentDateFrom;
    currentDateFrom = currentDateTo;
    currentDateTo = tmp;
    applyDateInputs();
  }
}

function updateDateFilterUi() {
  const wrap = document.getElementById("date-range-wrap");
  if (wrap) wrap.hidden = isAllTimeMode();
}

function updateColumnHeaders(mode) {
  const headers = COL_HEADERS[mode] || COL_HEADERS.range;
  document.querySelectorAll("#ref-table thead [data-col]").forEach(function (th) {
    const key = th.dataset.col;
    if (headers[key]) th.textContent = headers[key];
  });
}

function renderRows(data) {
  const tbody = document.getElementById("rows");
  const summary = document.getElementById("ref-summary");
  const allTime = data.mode === "all_time";
  const totalRows = data.rows.length;
  const pages = Math.max(1, Math.ceil(totalRows / REFERRER_PAGE_SIZE));
  currentPage = Math.min(currentPage, pages);
  const start = (currentPage - 1) * REFERRER_PAGE_SIZE;
  const pageRows = data.rows.slice(start, start + REFERRER_PAGE_SIZE);
  updateColumnHeaders(data.mode || "range");

  if (summary) {
    summary.textContent = allTime
      ? "\u5168\u90e8\u63a8\u8350\u4eba\u7d2f\u8ba1 | \u6392\u540d\u603b\u548c | \u5171 " + data.total + " \u4e2a"
      : "\u62a5\u8868\u65e5\u671f: " +
        data.date +
        " | \u6392\u5e8f: " +
        (SORT_LABELS[data.sort] || data.sort) +
        " | \u5171 " +
        data.total +
        " \u4e2a\u63a8\u8350\u4eba";
  }

  if (!data.rows.length) {
    renderTableState(
      tbody,
      9,
      allTime ? "\u6682\u65e0\u63a8\u8350\u4eba\u6570\u636e" : "\u8be5\u65e5\u671f\u6682\u65e0\u63a8\u8350\u4eba\u6570\u636e"
    );
    renderClientPager("referrer-pager", 0, 1, REFERRER_PAGE_SIZE, function () {});
    return;
  }

  var html = pageRows
    .map(function (r) {
      var lastCol = allTime ? r.activity_sum : r.total_customers;
      return (
        "<tr><td>" +
        r.rank +
        '</td><td><a class="ref-link" href="' +
        reportUrl(r.referrer_key, data) +
        '">' +
        escHtml(r.referrer || "-") +
        "</a></td><td>" +
        r.new_regs +
        "</td><td><strong>" +
        r.first_dep_count +
        "</strong></td><td>" +
        r.dep_users +
        "</td><td>" +
        fmtMoney(r.dep_total) +
        '</td><td class="wd-cell">' +
        fmtMoney(r.wd_total) +
        "</td><td>" +
        fmtMoney(r.net_total) +
        "</td><td>" +
        lastCol +
        "</td></tr>"
      );
    })
    .join("");

  if (data.totals) {
    var t = data.totals;
    var lastTotal = allTime ? t.activity_sum : "-";
    html +=
      '<tr class="total-row"><td></td><td><strong>\u603b\u548c</strong></td><td><strong>' +
      t.new_regs +
      "</strong></td><td><strong>" +
      t.first_dep_count +
      "</strong></td><td><strong>" +
      t.dep_users +
      "</strong></td><td><strong>" +
      fmtMoney(t.dep_total) +
      "</strong></td><td class=\"wd-cell\"><strong>" +
      fmtMoney(t.wd_total) +
      "</strong></td><td><strong>" +
      fmtMoney(t.net_total) +
      "</strong></td><td><strong>" +
      lastTotal +
      "</strong></td></tr>";
  }

  tbody.innerHTML = html;
  renderClientPager("referrer-pager", totalRows, currentPage, REFERRER_PAGE_SIZE, function (page) {
    currentPage = page;
    renderRows(data);
    document.getElementById("ref-table").scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  });
}

async function loadLeaderboard(options) {
  const scrollTop = shouldScrollList(options);
  const wrap = resolveListWrap("rows");
  const requestToken = referrerLoadGate.begin();
  setListLoading(wrap, true);
  try {
  readDateInputs();
  updateDateFilterUi();
  const q = document.getElementById("q").value.trim();
  let url = "/api/data/referrer-leaderboard?sort=" + encodeURIComponent(currentSort) + "&q=" + encodeURIComponent(q);
  if (!isAllTimeMode()) {
    url += "&dateFrom=" + encodeURIComponent(currentDateFrom) + "&dateTo=" + encodeURIComponent(currentDateTo);
  }
  const data = await api(url);
  if (!referrerLoadGate.isCurrent(requestToken) || !guardCompanyPayload(data)) return;
  renderRows(data);
  if (scrollTop) scrollListToTop();
  } catch (e) {
    if (e && e.cancelled) return;
    if (referrerLoadGate.isCurrent(requestToken)) {
      renderTableState("rows", 9, "\u63a8\u8350\u4eba\u699c\u52a0\u8f7d\u5931\u8d25\uff1a" + (e.message || "\u8bf7\u91cd\u8bd5"), "error");
    }
  } finally {
    if (referrerLoadGate.isCurrent(requestToken)) setListLoading(wrap, false);
  }
}

applyDateInputs();
updateDateFilterUi();
document.getElementById("date-from").addEventListener("change", function () {
  currentPage = 1;
  loadLeaderboard();
});
document.getElementById("date-to").addEventListener("change", function () {
  currentPage = 1;
  loadLeaderboard();
});
document.getElementById("search-btn").onclick = function () {
  currentPage = 1;
  loadLeaderboard();
};
document.getElementById("q").addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    currentPage = 1;
    loadLeaderboard();
  }
});

document.querySelectorAll("#sort-tabs .seg-btn").forEach(function (btn) {
  btn.onclick = function () {
    document.querySelectorAll("#sort-tabs .seg-btn").forEach(function (b) {
      b.classList.remove("active");
    });
    btn.classList.add("active");
    currentSort = btn.dataset.sort;
    currentPage = 1;
    loadLeaderboard();
  };
});

bindCompanySwitch(function () {
  currentPage = 1;
  return loadLeaderboard();
});
loadLeaderboard();
setInterval(function () {
  if (!document.hidden) loadLeaderboard({ scrollTop: false });
}, 30000);
