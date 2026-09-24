setActiveNav("deposit-leaderboard");

let currentSort = "total";
let currentPage = 1;
const pageSize = 100;
const leaderboardLoadGate = createRequestGate();

const SORT_LABELS = {
  total: "\u9ed8\u8ba4\u00b7\u5145\u503c\u603b\u989d",
  volume: "\u5355\u91cf\u6700\u591a",
  max_single: "\u5355\u5f20\u5145\u503c\u6700\u5927",
};

function renderPager(total, page, limit) {
  const el = document.getElementById("pager");
  if (!el) return;
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) {
    el.innerHTML = total ? '<span class="pager-info">\u5171 ' + total + " \u4eba</span>" : "";
    return;
  }
  el.innerHTML =
    '<button class="btn btn-outline btn-sm" id="prev-page"' +
    (page <= 1 ? " disabled" : "") +
    ">\u4e0a\u4e00\u9875</button>" +
    '<span class="pager-info">\u7b2c ' +
    page +
    " / " +
    pages +
    " \u9875\uff0c\u5171 " +
    total +
    " \u4eba</span>" +
    '<button class="btn btn-outline btn-sm" id="next-page"' +
    (page >= pages ? " disabled" : "") +
    ">\u4e0b\u4e00\u9875</button>";
  document.getElementById("prev-page").onclick = function () {
    if (currentPage > 1) {
      currentPage--;
      loadLeaderboard();
    }
  };
  document.getElementById("next-page").onclick = function () {
    if (currentPage < pages) {
      currentPage++;
      loadLeaderboard();
    }
  };
}

async function loadLeaderboard(options) {
  const scrollTop = shouldScrollList(options);
  const wrap = resolveListWrap("rows");
  const requestToken = leaderboardLoadGate.begin();
  setListLoading(wrap, true);
  try {
  const q = document.getElementById("q").value.trim();
  const url =
    "/api/data/deposit-leaderboard?sort=" +
    encodeURIComponent(currentSort) +
    "&page=" +
    currentPage +
    "&limit=" +
    pageSize +
    "&q=" +
    encodeURIComponent(q);
  const data = await api(url, { bg: !scrollTop });
  if (!leaderboardLoadGate.isCurrent(requestToken) || !guardCompanyPayload(data)) return;
  const summary = document.getElementById("lb-summary");
  if (summary) {
    summary.textContent =
      "\u6392\u5e8f: " +
      (SORT_LABELS[data.sort] || data.sort) +
      " | \u5171 " +
      data.total +
      " \u4eba | \u2014 \u8868\u793a\u6709\u5145\u503c\u603b\u989d\u4f46\u672c\u5730\u672a\u540c\u6b65\u5230\u7b14\u6570";
  }
  const tbody = document.getElementById("rows");
  if (!data.rows.length) {
    renderTableState(tbody, 15, "\u6682\u65e0\u7b26\u5408\u6761\u4ef6\u7684\u5145\u503c\u5ba2\u6237");
    renderPager(data.total, data.page, data.limit);
    if (scrollTop) scrollListToTop();
    return;
  }
  const rankBase = (data.page - 1) * data.limit;
  tbody.innerHTML = data.rows
    .map(function (r, i) {
      return (
        "<tr><td>" +
        (rankBase + i + 1) +
        "</td><td>" +
        customerLink(r.name || r.username || "-", r.id, r.mobile) +
        "</td><td>" +
        escHtml(r.mobile || "-") +
        "</td><td>" +
        fmtDate(r.last_deposit_show || r.last_deposit) +
        "</td><td>" +
        fmtDate(r.last_login_show || r.last_login || r.last_login_date) +
        "</td><td>" +
        fmtMoney(r.dep_total) +
        "</td><td>" +
        (r.dep_count > 0
          ? r.dep_count
          : r.dep_total > 0
            ? '<span title="\u6709\u5145\u503c\u603b\u989d\uff0c\u4f46\u672c\u5730\u672a\u540c\u6b65\u5230\u5177\u4f53\u7b14\u6570\uff08\u53ef\u80fd\u5728\u540c\u6b65\u7a97\u53e3\u4e4b\u524d\u5145\u503c\uff09">\u2014</span>'
            : "0") +
        "</td><td>" +
        (r.max_single_deposit > 0
          ? fmtMoney(r.max_single_deposit)
          : r.dep_total > 0
            ? '<span title="\u672c\u5730\u672a\u540c\u6b65\u5230\u5145\u503c\u660e\u7ec6">\u2014</span>'
            : fmtMoney(0)) +
        "</td>" +
        renderExtraCells(r) +
        "<td>" +
        escHtml(r.referrer || "-") +
        "</td></tr>"
      );
    })
    .join("");
  renderPager(data.total, data.page, data.limit);
  if (scrollTop) scrollListToTop();
  } catch (e) {
    if (e && e.cancelled) return;
    if (leaderboardLoadGate.isCurrent(requestToken)) {
      renderTableState("rows", 15, "\u5145\u503c\u699c\u52a0\u8f7d\u5931\u8d25\uff1a" + (e.message || "\u8bf7\u91cd\u8bd5"), "error");
    }
  } finally {
    if (leaderboardLoadGate.isCurrent(requestToken)) setListLoading(wrap, false);
  }
}

document.querySelectorAll("#sort-tabs .seg-btn").forEach(function (btn) {
  btn.addEventListener("click", function () {
    document.querySelectorAll("#sort-tabs .seg-btn").forEach(function (b) {
      b.classList.remove("active");
    });
    btn.classList.add("active");
    currentSort = btn.dataset.sort || "total";
    currentPage = 1;
    loadLeaderboard();
  });
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

bindCompanySwitch(loadLeaderboard);
loadLeaderboard();
startAutoReload(function () { loadLeaderboard({ scrollTop: false }); }, 10);
