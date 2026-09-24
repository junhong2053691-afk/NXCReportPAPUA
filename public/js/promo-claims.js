setActiveNav("promos");

let currentDateFrom = todaySydney();
let currentDateTo = todaySydney();
let backfillRunning = false;
let currentPage = 1;
const promoLoadGate = createRequestGate();
const PROMO_PAGE_SIZE = 50;

function applyDateInputs() {
  document.getElementById("date-from").value = currentDateFrom;
  document.getElementById("date-to").value = currentDateTo;
}

function readDateInputs() {
  currentDateFrom = document.getElementById("date-from").value || todaySydney();
  currentDateTo = document.getElementById("date-to").value || currentDateFrom;
  if (currentDateFrom > currentDateTo) {
    const tmp = currentDateFrom;
    currentDateFrom = currentDateTo;
    currentDateTo = tmp;
    applyDateInputs();
  }
}

function renderTotals(data) {
  const t = data.bonusTotal || data.totals || {};
  document.getElementById("total-users").textContent = (t.claim_users || 0) + " \u4eba\uff08\u53bb\u91cd\uff09";
  document.getElementById("total-count").textContent = (t.claim_count || 0) + " \u7b14";
  document.getElementById("total-amount").textContent = fmtMoney(t.total_amount || 0);
}

function renderRows(data) {
  const tbody = document.getElementById("rows");
  const summary = document.getElementById("promo-summary");
  const rows = data.rows || [];
  const totalRows = rows.length;
  const pages = Math.max(1, Math.ceil(totalRows / PROMO_PAGE_SIZE));
  currentPage = Math.min(currentPage, pages);
  const start = (currentPage - 1) * PROMO_PAGE_SIZE;
  const pageRows = rows.slice(start, start + PROMO_PAGE_SIZE);
  renderTotals(data);

  if (summary) {
    let text =
      "\u62a5\u8868\u65e5\u671f: " +
      data.date +
      " | \u5171 " +
      (data.total || 0) +
      " \u4e2a\u6d3b\u52a8 | \u5404\u6d3b\u52a8\u4eba\u6570\u4e0d\u53ef\u76f8\u52a0";
    if (data.unknownPending > 0) {
      text += " | " + data.unknownPending + " \u7b14\u5f85\u540c\u6b65\u6d3b\u52a8\u540d";
    }
    summary.textContent = text;
  }

  if (!data.rows || !data.rows.length) {
    renderTableState(tbody, 5, "\u8be5\u65e5\u671f\u6682\u65e0 Bonus \u9886\u53d6\u8bb0\u5f55");
    renderClientPager("promo-pager", 0, 1, PROMO_PAGE_SIZE, function () {});
    return;
  }

  let html = pageRows
    .map(function (r) {
      const name =
        r.is_unknown
          ? '<span class="muted">' + escHtml(r.promo_name || "-") + "</span>"
          : "<strong>" + escHtml(r.promo_name || "-") + "</strong>";
      return (
        "<tr><td>" +
        r.rank +
        "</td><td>" +
        name +
        "</td><td>" +
        r.claim_users +
        "</td><td>" +
        r.claim_count +
        "</td><td>" +
        fmtMoney(r.total_amount) +
        "</td></tr>"
      );
    })
    .join("");

  if (data.bonusTotal) {
    const t = data.bonusTotal;
    html +=
      '<tr class="total-row"><td></td><td><strong>Bonus \u9886\u53d6\u603b\u548c</strong><div class="table-subnote">' +
      (t.promo_count || 0) +
      " \u4e2a\u5df2\u8bc6\u522b\u6d3b\u52a8</div></td><td><strong>" +
      t.claim_users +
      "</strong></td><td><strong>" +
      t.claim_count +
      "</strong></td><td><strong>" +
      fmtMoney(t.total_amount) +
      "</strong></td></tr>";
  }

  tbody.innerHTML = html;
  renderClientPager("promo-pager", totalRows, currentPage, PROMO_PAGE_SIZE, function (page) {
    currentPage = page;
    renderRows(data);
    document.getElementById("rows").closest(".data-surface").scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  });
}

async function loadPromoClaims(options) {
  const scrollTop = shouldScrollList(options);
  const wrap = resolveListWrap("rows");
  const requestToken = promoLoadGate.begin();
  setListLoading(wrap, true);
  readDateInputs();
  const q = document.getElementById("q").value.trim();
  const url =
    "/api/data/promo-claims?dateFrom=" +
    encodeURIComponent(currentDateFrom) +
    "&dateTo=" +
    encodeURIComponent(currentDateTo) +
    "&q=" +
    encodeURIComponent(q);
  try {
    const data = await api(url);
    if (!promoLoadGate.isCurrent(requestToken) || !guardCompanyPayload(data)) return;
    renderRows(data);
    if (scrollTop) scrollListToTop();
  } catch (e) {
    if (e && e.cancelled) return;
    if (promoLoadGate.isCurrent(requestToken)) {
      renderTableState("rows", 5, "\u6d3b\u52a8\u9886\u53d6\u52a0\u8f7d\u5931\u8d25\uff1a" + (e.message || "\u8bf7\u91cd\u8bd5"), "error");
    }
  } finally {
    if (promoLoadGate.isCurrent(requestToken)) setListLoading(wrap, false);
  }
}

async function runBackfill() {
  if (backfillRunning) return;
  const btn = document.getElementById("backfill-btn");
  backfillRunning = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "\u540c\u6b65\u4e2d...";
  }
  try {
    const res = await api("/api/data/promo-claims/backfill", { method: "POST" });
    showToast(
      "\u5df2\u66f4\u65b0 " + (res.updated || 0) + " \u7b14\u6d3b\u52a8\u540d\n\u5f85\u540c\u6b65: " + (res.missingAfter || 0) + " \u7b14",
      { tone: "success", title: "\u540c\u6b65\u5b8c\u6210", duration: 7000 }
    );
    loadPromoClaims();
  } catch (e) {
    showToast("\u540c\u6b65\u5931\u8d25: " + (e.message || e), { tone: "error" });
  } finally {
    backfillRunning = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "\u540c\u6b65\u6d3b\u52a8\u540d";
    }
  }
}

document.getElementById("search-btn").onclick = function () {
  currentPage = 1;
  loadPromoClaims();
};
document.getElementById("q").addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    currentPage = 1;
    loadPromoClaims();
  }
});
document.getElementById("backfill-btn").onclick = runBackfill;
document.getElementById("date-from").addEventListener("change", function () {
  currentPage = 1;
  loadPromoClaims();
});
document.getElementById("date-to").addEventListener("change", function () {
  currentPage = 1;
  loadPromoClaims();
});

applyDateInputs();
bindCompanySwitch(function () {
  currentPage = 1;
  return loadPromoClaims();
});
loadPromoClaims();
startAutoReload(function () { loadPromoClaims({ scrollTop: false }); }, 15);
