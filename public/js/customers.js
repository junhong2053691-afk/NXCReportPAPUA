setActiveNav("customers");

let currentSegment = "all";
let currentPage = 1;
const pageSize = 100;
let segmentCountsLoading = false;
let searchDebounceTimer = null;
const customerLoadGate = createRequestGate();
const segmentCountGate = createRequestGate();

const SEGMENT_LABELS = {
  all: "\u6240\u6709\u987e\u5ba2",
  dep_today: "\u4eca\u65e5\u6709\u5145\u503c",
  never_deposited: "\u6ca1\u5145\u503c\u8fc7",
  active_depositor: "\u8fdb\u8fc7\u94b1\u00b72\u5929\u5185\u5728\u7ebf",
  offline_3_7: "\u8fdb\u8fc7\u94b1\u00b73\u20137\u5929\u672a\u4e0a\u7ebf",
  offline_7plus: "\u8fdb\u8fc7\u94b1\u00b7\u8d857\u5929\u672a\u4e0a\u7ebf",
};

const SEGMENT_HINTS = {
  all: "\u5168\u90e8\u987e\u5ba2",
  dep_today: "Follow-up: \u611f\u8c22\u4eca\u65e5\u5145\u503c\uff0c\u4fc3\u590d\u5145",
  never_deposited: "Follow-up: \u9996\u5145\u8f6c\u5316\uff0c\u672a\u5145\u503c\u987e\u5ba2",
  active_depositor: "Follow-up: \u6b63\u5e38\u7ef4\u62a4\u3001\u6d3b\u52a8\u63a8\u9001",
  offline_3_7: "Follow-up: \u6e29\u548c\u5524\u9192\uff0c\u8fd1\u671f\u79bb\u7ebf",
  offline_7plus: "Follow-up: \u91cd\u70b9\u633d\u56de\uff0c\u53ef\u7ed9\u4f18\u60e0",
};

function fmtWinLoss(n) {
  if (n == null || n === "") return "-";
  const v = Number(n);
  const text = "$" + Math.abs(v).toFixed(2);
  if (v > 0) return '<span class="positive">+' + text + "</span>";
  if (v < 0) return '<span class="negative">-' + text + "</span>";
  return "$0.00";
}

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
      loadCustomers();
    }
  };
  document.getElementById("next-page").onclick = function () {
    if (currentPage < pages) {
      currentPage++;
      loadCustomers();
    }
  };
}

function updateSegmentCounts(counts) {
  if (!counts) return;
  document.querySelectorAll(".seg-btn").forEach(function (btn) {
    const key = btn.dataset.segment;
    const n = counts[key];
    if (n == null) return;
    const base = SEGMENT_LABELS[key] || key;
    btn.textContent = base + " (" + n + ")";
  });
}

function loadSegmentCounts() {
  if (segmentCountsLoading) return;
  segmentCountsLoading = true;
  const requestToken = segmentCountGate.begin();
  api("/api/data/customer-segment-counts")
    .then(function (data) {
      if (!segmentCountGate.isCurrent(requestToken) || !guardCompanyPayload(data)) return;
      updateSegmentCounts(data.counts);
    })
    .catch(function () {})
    .finally(function () {
      if (segmentCountGate.isCurrent(requestToken)) segmentCountsLoading = false;
    });
}

async function loadCustomers(options) {
  const scrollTop = shouldScrollList(options);
  const wrap = resolveListWrap("rows");
  const requestToken = customerLoadGate.begin();
  setListLoading(wrap, true);
  try {
  const q = document.getElementById("q").value.trim();
  const url =
    "/api/data/customers?segment=" +
    encodeURIComponent(currentSegment) +
    "&page=" +
    currentPage +
    "&limit=" +
    pageSize +
    "&q=" +
    encodeURIComponent(q) +
    "&counts=0";

  const data = await api(url);
  if (!customerLoadGate.isCurrent(requestToken) || !guardCompanyPayload(data)) return;
  if (data.counts) updateSegmentCounts(data.counts);
  else loadSegmentCounts();

  const summary = document.getElementById("cust-summary");
  if (summary) {
    summary.textContent =
      (SEGMENT_HINTS[data.segment] || SEGMENT_LABELS[data.segment] || data.segment) +
      " | \u5728\u7ebf: " +
      (data.inactiveDays || 2) +
      " \u5929\u5185 | \u6c89\u7720: 3\u2013" +
      (data.dormantMaxDays || 7) +
      " / 7+ \u5929";
  }

  const tbody = document.getElementById("rows");
  if (!data.rows.length) {
    renderTableState(tbody, 15, "\u6682\u65e0\u7b26\u5408\u6761\u4ef6\u7684\u5ba2\u6237");
    renderPager(data.total, data.page, data.limit);
    if (scrollTop) scrollListToTop();
    return;
  }

  tbody.innerHTML = data.rows
    .map(function (r) {
      return (
        "<tr>" +
        '<td translate="no">' +
        customerLink(r.name || r.username || "-", r.id, r.mobile) +
        "</td>" +
        '<td translate="no">' +
        escHtml(r.mobile || "-") +
        "</td>" +
        "<td>" +
        fmtDate(r.last_deposit) +
        "</td>" +
        "<td>" +
        fmtDate(r.last_login) +
        "</td>" +
        "<td>" +
        (r.dep_count > 0
          ? r.dep_count
          : r.dep_total > 0
            ? '<span title="\u6709\u5145\u503c\u603b\u989d\uff0c\u4f46\u672c\u5730\u672a\u540c\u6b65\u5230\u5177\u4f53\u7b14\u6570">\u2014</span>'
            : "0") +
        "</td>" +
        "<td>" +
        fmtMoney(r.dep_total) +
        "</td>" +
        "<td>" +
        fmtMoney(r.wd_total) +
        "</td>" +
        renderExtraCells(r) +
        "<td>" +
        fmtWinLoss(Number(r.win_loss ?? 0)) +
        "</td>" +
        '<td translate="no">' +
        escHtml(r.referrer || "-") +
        "</td>" +
        "</tr>"
      );
    })
    .join("");

  renderPager(data.total, data.page, data.limit);
  if (scrollTop) scrollListToTop();
  } catch (e) {
    if (e && e.cancelled) return;
    if (customerLoadGate.isCurrent(requestToken)) {
      renderTableState("rows", 15, "\u5ba2\u6237\u52a0\u8f7d\u5931\u8d25\uff1a" + (e.message || "\u8bf7\u91cd\u8bd5"), "error");
    }
  } finally {
    if (customerLoadGate.isCurrent(requestToken)) setListLoading(wrap, false);
  }
}

document.querySelectorAll(".seg-btn").forEach(function (btn) {
  btn.addEventListener("click", function () {
    document.querySelectorAll(".seg-btn").forEach(function (b) {
      b.classList.remove("active");
    });
    btn.classList.add("active");
    currentSegment = btn.dataset.segment;
    currentPage = 1;
    loadCustomers();
  });
});

document.getElementById("search-btn").onclick = function () {
  currentPage = 1;
  loadCustomers();
};

document.getElementById("q").addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    currentPage = 1;
    loadCustomers();
  }
});
document.getElementById("q").addEventListener("input", function () {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(function () {
    currentPage = 1;
    loadCustomers();
  }, 400);
});

function getSelectedExportSegments() {
  const allEl = document.getElementById("exp-all");
  if (allEl && allEl.checked) return ["all"];
  const segs = [];
  document.querySelectorAll(".export-segments input[data-segment]").forEach(function (cb) {
    if (cb.checked) segs.push(cb.dataset.segment);
  });
  return segs.length ? segs : ["all"];
}

function syncExportSegmentChecks(changed) {
  const allEl = document.getElementById("exp-all");
  const others = document.querySelectorAll(".export-segments input[data-segment]");
  if (changed === allEl && allEl.checked) {
    others.forEach(function (cb) {
      cb.checked = false;
    });
  } else if (changed && changed.dataset && changed.dataset.segment && changed.checked) {
    allEl.checked = false;
  }
  if (!allEl.checked) {
    const any = Array.from(others).some(function (cb) {
      return cb.checked;
    });
    if (!any) allEl.checked = true;
  }
}

function openExportModal() {
  const format = document.getElementById("export-format");
  const all = document.getElementById("exp-all");
  if (format) format.value = "csv";
  if (all) all.checked = true;
  document.querySelectorAll('.export-segments input[data-segment]').forEach(function (checkbox) {
    checkbox.checked = false;
  });
  document.getElementById("export-modal").classList.add("show");
  const hint = document.getElementById("export-hint");
  if (hint) {
    hint.textContent =
      "\u5c06\u4f7f\u7528\u5f53\u524d\u641c\u7d22\u6761\u4ef6\u8fc7\u6ee4\uff08\u5982\u6709\u586b\u5199\uff09";
  }
}

function closeExportModal() {
  document.getElementById("export-modal").classList.remove("show");
}

function downloadExport() {
  const segments = getSelectedExportSegments();
  const format = document.getElementById("export-format").value;
  const q = document.getElementById("q").value.trim();
  const url =
    "/api/data/customers/export?format=" +
    encodeURIComponent(format) +
    "&segments=" +
    encodeURIComponent(segments.join(",")) +
    "&q=" +
    encodeURIComponent(q);
  // 不能 location.href：整页跳转带不了 X-Company-Id 头，会导出 session 默认那家而不是本标签页的公司。
  closeExportModal();
  fetch(url, { headers: companyHeaders() })
    .then(async (res) => {
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 403 && data.code === "COMPANY_NOT_ALLOWED") return resetTabCompany();
        throw new Error(data.error || "导出失败");
      }
      const disp = res.headers.get("Content-Disposition") || "";
      const m = /filename="([^"]+)"/.exec(disp);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = m ? m[1] : "phones-export";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    })
    .catch((e) => showToast(e.message || "导出失败", { tone: "error", title: "导出失败" }));
}

document.getElementById("export-btn").onclick = openExportModal;
document.getElementById("export-cancel").onclick = closeExportModal;
document.getElementById("export-confirm").onclick = downloadExport;

document.querySelectorAll(".export-segments input").forEach(function (cb) {
  cb.addEventListener("change", function () {
    syncExportSegmentChecks(cb);
  });
});

bindCompanySwitch(function () {
  document.querySelectorAll(".seg-btn").forEach(function (btn) {
    const key = btn.dataset.segment;
    btn.textContent = SEGMENT_LABELS[key] || key;
  });
  loadSegmentCounts();
  loadCustomers();
});
loadCustomers();
loadSegmentCounts();
startSyncWatcher(function () {
  loadSegmentCounts();
  loadCustomers({ scrollTop: false });
});
