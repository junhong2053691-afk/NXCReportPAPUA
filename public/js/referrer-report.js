setActiveNav("referrers");

const params = new URLSearchParams(location.search);
const referrerKey = params.get("referrer") || "__organic__";
const today = todaySydney();
let currentDateFrom = params.get("dateFrom") || params.get("date") || today;
let currentDateTo = params.get("dateTo") || params.get("date") || currentDateFrom;
let currentSegment = "all";
let currentCustomerPage = 1;
const reportLoadGate = createRequestGate();
const CUSTOMER_PAGE_SIZE = 50;

function segmentLabels(data) {
  const single = data.dateFrom === data.dateTo;
  return {
    all: "\u5168\u90e8\u987e\u5ba2",
    new_today: single ? "\u4eca\u65e5\u65b0\u6ce8\u518c" : "\u533a\u95f4\u5185\u65b0\u6ce8\u518c",
    first_dep_today: single ? "\u4eca\u65e5\u9996\u5145" : "\u533a\u95f4\u5185\u9996\u5145",
  };
}

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
  document.getElementById("ref-title").textContent = data.referrer;
  document.getElementById("ref-date").textContent = "\u62a5\u8868\u65e5\u671f: " + data.date;
  const s = data.summary;
  document.getElementById("card-new").textContent = s.new_regs;
  document.getElementById("card-first-dep").textContent = s.first_dep_count;
  document.getElementById("card-dep").textContent = fmtMoney(s.dep_total);
  document.getElementById("card-wd").textContent = fmtMoney(s.wd_total);
  document.getElementById("card-total").textContent = s.total_customers + " \u4eba";

  const labels = segmentLabels(data);
  document.querySelectorAll("#segment-tabs .seg-btn").forEach(function (btn) {
    const key = btn.dataset.segment;
    if (labels[key]) btn.textContent = labels[key];
  });
}

function renderCustomers(data) {
  const tbody = document.getElementById("cust-rows");
  const hint = document.getElementById("cust-hint");
  const labels = segmentLabels(data);
  const total = data.customers.length;
  const pages = Math.max(1, Math.ceil(total / CUSTOMER_PAGE_SIZE));
  currentCustomerPage = Math.min(currentCustomerPage, pages);
  const start = (currentCustomerPage - 1) * CUSTOMER_PAGE_SIZE;
  const customers = data.customers.slice(start, start + CUSTOMER_PAGE_SIZE);
  if (hint) {
    hint.textContent =
      (labels[data.segment] || data.segment) +
      " | \u5171 " +
      total +
      " \u4eba" +
      (total > CUSTOMER_PAGE_SIZE
        ? " | \u5f53\u524d\u663e\u793a " +
          (start + 1) +
          "\u2013" +
          Math.min(start + CUSTOMER_PAGE_SIZE, total)
        : "");
  }
  if (!total) {
    renderTableState(tbody, 8, "\u6682\u65e0\u7b26\u5408\u6761\u4ef6\u7684\u5ba2\u6237");
    renderClientPager("ref-report-pager", 0, 1, CUSTOMER_PAGE_SIZE, function () {});
    return;
  }
  tbody.innerHTML = customers
    .map(function (c) {
      return (
        "<tr><td>" +
        customerLink(c.name || c.username || c.mobile || "-", c.id, c.mobile) +
        "</td><td>" +
        escHtml(c.mobile || "-") +
        "</td><td>" +
        escHtml(c.register_date_key || "-") +
        "</td><td>" +
        escHtml(c.first_dep_date || "-") +
        "</td><td>" +
        fmtMoney(c.dep_total) +
        '</td><td class="wd-cell">' +
        fmtMoney(c.wd_total) +
        "</td><td>" +
        fmtDate(c.last_login) +
        "</td><td>" +
        fmtDate(c.last_deposit) +
        "</td></tr>"
      );
    })
    .join("");
  renderClientPager(
    "ref-report-pager",
    total,
    currentCustomerPage,
    CUSTOMER_PAGE_SIZE,
    function (page) {
      currentCustomerPage = page;
      renderCustomers(data);
      document.querySelector("#cust-rows").closest(".data-surface").scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
    }
  );
}

async function loadReport(options) {
  const scrollTop = shouldScrollList(options);
  const wrap = resolveListWrap("cust-rows");
  const requestToken = reportLoadGate.begin();
  setListLoading(wrap, true);
  try {
  readDateInputs();
  const url =
    "/api/data/referrer-report?referrer=" +
    encodeURIComponent(referrerKey) +
    "&dateFrom=" +
    encodeURIComponent(currentDateFrom) +
    "&dateTo=" +
    encodeURIComponent(currentDateTo) +
    "&segment=" +
    encodeURIComponent(currentSegment);
  const data = await api(url);
  if (!reportLoadGate.isCurrent(requestToken) || !guardCompanyPayload(data)) return;
  renderSummary(data);
  renderCustomers(data);
  if (scrollTop) scrollListToTop();
  } catch (e) {
    if (e && e.cancelled) return;
    if (reportLoadGate.isCurrent(requestToken)) {
      renderTableState("cust-rows", 8, "\u63a8\u8350\u4eba\u62a5\u8868\u52a0\u8f7d\u5931\u8d25\uff1a" + (e.message || "\u8bf7\u91cd\u8bd5"), "error");
    }
  } finally {
    if (reportLoadGate.isCurrent(requestToken)) setListLoading(wrap, false);
  }
}

applyDateInputs();
document.getElementById("date-from").addEventListener("change", function () {
  currentCustomerPage = 1;
  loadReport();
});
document.getElementById("date-to").addEventListener("change", function () {
  currentCustomerPage = 1;
  loadReport();
});

document.querySelectorAll("#segment-tabs .seg-btn").forEach(function (btn) {
  btn.onclick = function () {
    document.querySelectorAll("#segment-tabs .seg-btn").forEach(function (b) {
      b.classList.remove("active");
    });
    btn.classList.add("active");
    currentSegment = btn.dataset.segment;
    currentCustomerPage = 1;
    loadReport();
  };
});

bindCompanySwitch(function () {
  currentCustomerPage = 1;
  return loadReport();
});
loadReport();
