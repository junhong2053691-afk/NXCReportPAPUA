setActiveNav("customer-return");

const today = todaySydney();
let currentDateFrom = today;
let currentDateTo = today;
let currentSegment = "all";
let currentPage = 1;
const returnLoadGate = createRequestGate();
const RETURN_PAGE_SIZE = 50;

const SEGMENT_LABELS = {
  all: "\u56de\u6d41\u5145\u503c\uff08\u22653\u5929\uff09",
  gap_3: "\u6c89\u9ed83~6\u5929\u56de\u6d41",
  gap_7: "\u6c89\u9ed87\u5929+\u91cd\u70b9\u633d\u56de",
};

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

function renderSummary(data) {
  const s = data.summary;
  document.getElementById("report-date").textContent = "\u62a5\u8868\u65e5\u671f: " + data.date;
  document.getElementById("card-return-users").textContent = s.return_users + " \u4eba";
  document.getElementById("card-return-deps").textContent = s.return_dep_count + " \u7b14";
  document.getElementById("card-return-total").textContent = fmtMoney(s.return_dep_total);
  document.getElementById("card-recover-pool").textContent = s.recover_pool + " \u4eba";
  document.getElementById("card-offline-37").textContent = s.offline_3_7 + " \u4eba";
  document.getElementById("card-return-rate").textContent = s.return_rate_pct + "%";
  document.getElementById("report-hint").textContent = data.hint || "";
}

function renderRows(data) {
  const tbody = document.getElementById("rows");
  const empty = document.getElementById("empty");
  const rows = data.rows || [];
  const totalRows = rows.length;
  const pages = Math.max(1, Math.ceil(totalRows / RETURN_PAGE_SIZE));
  currentPage = Math.min(currentPage, pages);
  const start = (currentPage - 1) * RETURN_PAGE_SIZE;
  const pageRows = rows.slice(start, start + RETURN_PAGE_SIZE);
  document.getElementById("table-summary").textContent =
    (SEGMENT_LABELS[data.segment] || data.segment) +
    " | \u5171 " +
    data.total +
    " \u4eba";

  if (!rows.length) {
    tbody.innerHTML = "";
    if (empty) empty.hidden = false;
    renderClientPager("return-pager", 0, 1, RETURN_PAGE_SIZE, function () {});
    return;
  }
  if (empty) empty.hidden = true;
  tbody.innerHTML = pageRows
    .map(function (r, i) {
      return (
        "<tr><td>" +
        (start + i + 1) +
        "</td><td>" +
        customerLink(r.name || "-", r.customer_id, r.mobile) +
        "</td><td>" +
        escHtml(r.mobile || "-") +
        "</td><td><strong>" +
        r.silent_days +
        "\u5929</strong></td><td>" +
        escHtml(r.prev_dep_date || "-") +
        "</td><td>" +
        escHtml(r.first_return_date || "-") +
        "</td><td>" +
        r.return_dep_count +
        "</td><td>" +
        fmtMoney(r.return_dep_total) +
        "</td><td>" +
        fmtMoney(r.dep_total) +
        "</td><td>" +
        escHtml(r.last_login_date || "-") +
        "</td><td>" +
        escHtml(r.referrer || "-") +
        "</td></tr>"
      );
    })
    .join("");
  renderClientPager("return-pager", totalRows, currentPage, RETURN_PAGE_SIZE, function (page) {
    currentPage = page;
    renderRows(data);
    document.getElementById("rows").closest(".data-surface").scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  });
}

async function loadReport(options) {
  const scrollTop = shouldScrollList(options);
  const wrap = resolveListWrap("rows");
  const requestToken = returnLoadGate.begin();
  setListLoading(wrap, true);
  document.querySelectorAll(".cards .value").forEach((el) => {
    el.textContent = "\u2026";
  });
  try {
  readDateInputs();
  const q = document.getElementById("q").value.trim();
  const data = await api(
    "/api/data/customer-return-report?dateFrom=" +
      encodeURIComponent(currentDateFrom) +
      "&dateTo=" +
      encodeURIComponent(currentDateTo) +
      "&segment=" +
      encodeURIComponent(currentSegment) +
      (q ? "&q=" + encodeURIComponent(q) : "")
  );
  if (!returnLoadGate.isCurrent(requestToken) || !guardCompanyPayload(data)) return;
  renderSummary(data);
  renderRows(data);
  if (scrollTop) scrollListToTop();
  } catch (e) {
    if (e && e.cancelled) return;
    if (returnLoadGate.isCurrent(requestToken)) {
      renderTableState("rows", 11, "\u56de\u6d41\u62a5\u8868\u52a0\u8f7d\u5931\u8d25\uff1a" + (e.message || "\u8bf7\u91cd\u8bd5"), "error");
    }
  } finally {
    if (returnLoadGate.isCurrent(requestToken)) setListLoading(wrap, false);
  }
}

document.getElementById("search-btn").onclick = function () {
  currentPage = 1;
  loadReport();
};
document.getElementById("q").addEventListener("keydown", function (event) {
  if (event.key === "Enter") {
    currentPage = 1;
    loadReport();
  }
});
document.getElementById("date-from").addEventListener("change", function () {
  currentPage = 1;
  loadReport();
});
document.getElementById("date-to").addEventListener("change", function () {
  currentPage = 1;
  loadReport();
});

document.querySelectorAll("#segment-tabs .seg-btn").forEach(function (btn) {
  btn.onclick = function () {
    document.querySelectorAll("#segment-tabs .seg-btn").forEach(function (b) {
      b.classList.remove("active");
    });
    btn.classList.add("active");
    currentSegment = btn.dataset.segment;
    currentPage = 1;
    loadReport();
  };
});

applyDateInputs();
bindCompanySwitch(function () {
  currentPage = 1;
  return loadReport();
});
loadReport();
