setActiveNav("transactions");
const _txUrlDate = new URLSearchParams(location.search).get("date");
{
  const _dateInput = document.getElementById("date");
  if (_dateInput) _dateInput.value = _txUrlDate || todaySydney();
}

let currentType = "";
let currentPage = 1;
const pageSize = 100;
const txLoadGate = createRequestGate();

const TYPE_LABELS = {
  DEPOSIT: "\u5145\u503c",
  WITHDRAW: "\u63d0\u73b0",
  REDEPOSIT: "Redeposit",
  BONUS: "Bonus",
  MANUAL: "Manual",
  COMMISSION: "Commission",
};

function typeBadge(type) {
  if (type === "DEPOSIT") return '<span class="badge badge-green">\u5145\u503c</span>';
  if (type === "WITHDRAW") return '<span class="badge badge-red">\u63d0\u73b0</span>';
  if (type === "BONUS") return '<span class="badge badge-bonus">Bonus</span>';
  if (type === "MANUAL") return '<span class="badge badge-manual">Manual</span>';
  if (type === "COMMISSION") return '<span class="badge badge-commission">Commission</span>';
  return type || "-";
}

function isRedeposit(row) {
  const method = String(row.method || "").trim().toLowerCase();
  return row.type === "DEPOSIT" && (method === "redeposit" || !String(row.attachment_url || "").trim());
}

function redepositDisplay(row) {
  if (!isRedeposit(row)) return "-";
  return '<span class="badge badge-orange">\u91cd\u65b0\u5145\u503c</span>';
}

function methodDisplay(row) {
  if (row.type !== "DEPOSIT") return "-";
  const m = String(row.method || "").trim();
  if (!m) return "-";
  if (/online/i.test(m) && /manual/i.test(m)) return "\u5728\u7ebf";
  if (/online/i.test(m)) return "\u5728\u7ebf";
  if (/manual/i.test(m)) return "\u4eba\u5de5";
  return escHtml(m);
}

function channelDisplay(row) {
  if (row.type !== "DEPOSIT") return "-";
  const payid = String(row.payid || "").trim();
  const bank = String(row.bank_name || "").trim();
  if (payid) return "PayID";
  if (!bank) return "-";
  const upper = bank.toUpperCase();
  if (upper.startsWith("PAYID")) return "PayID";
  const code = bank.split(/[\s(]/)[0].toUpperCase();
  const labels = { PAYID: "PayID", AMPBL: "AMP", PIG: "PIG", PIC: "PIC", CBA: "CBA", WBC: "Westpac", ANZ: "ANZ", NAB: "NAB" };
  return labels[code] || code;
}

function renderDepositPanels(data, date) {
  const panel = document.getElementById("dep-channels");
  if (!panel) return;
  const show = !currentType || currentType === "DEPOSIT" || currentType === "REDEPOSIT";
  if (!show) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const channels = data.depositChannels || [];
  const redeposit = data.redepositSummary;
  if (!channels.length && !redeposit) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  let html = "<h2>\u5145\u503c\u6982\u89c8\uff08" + escHtml(date) + "\uff09</h2>";
  if (redeposit && redeposit.count > 0) {
    html +=
      '<p class="panel-note">Redeposit ' +
      redeposit.count +
      " \u7b14 \u00b7 " +
      fmtMoney(redeposit.total) +
      " \uff08\u65e0 Attachment\uff09</p>";
  }
  if (channels.length && currentType !== "REDEPOSIT") {
    html += '<div class="cards metric-grid dep-channel-grid">';
    html += channels
      .map(function (c) {
        return (
          '<div class="card metric-card blue dep-channel-card"><div class="label">' +
          escHtml(c.label) +
          '</div><div class="value">' +
          c.count +
          ' \u7b14</div><div class="sub">\u5408\u8ba1 ' +
          fmtMoney(c.total) +
          "</div></div>"
        );
      })
      .join("");
    html += "</div>";
  }
  panel.innerHTML = html;
}

function renderPager(total, page, limit) {
  const el = document.getElementById("pager");
  if (!el) return;
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) {
    el.innerHTML = total ? '<span class="pager-info">\u5171 ' + total + " \u7b14</span>" : "";
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
    " \u7b14</span>" +
    '<button class="btn btn-outline btn-sm" id="next-page"' +
    (page >= pages ? " disabled" : "") +
    ">\u4e0b\u4e00\u9875</button>";
  document.getElementById("prev-page").onclick = function () {
    if (currentPage > 1) {
      currentPage--;
      loadTransactions();
    }
  };
  document.getElementById("next-page").onclick = function () {
    if (currentPage < pages) {
      currentPage++;
      loadTransactions();
    }
  };
}

async function loadTransactions(options) {
  const scrollTop = shouldScrollList(options);
  const wrap = resolveListWrap("rows");
  const requestToken = txLoadGate.begin();
  setListLoading(wrap, true);
  try {
  const q = document.getElementById("q").value.trim();
  const date = document.getElementById("date").value;
  const url =
    "/api/data/transactions?page=" +
    currentPage +
    "&limit=" +
    pageSize +
    "&q=" +
    encodeURIComponent(q) +
    "&date=" +
    encodeURIComponent(date) +
    (currentType ? "&type=" + encodeURIComponent(currentType) : "");

  const data = await api(url);
  if (!txLoadGate.isCurrent(requestToken)) return;
  const summary = document.getElementById("tx-summary");
  if (summary) {
    const label = TYPE_LABELS[currentType] || "\u5168\u90e8";
    summary.textContent = "\u5f53\u524d: " + label;
  }

  renderDepositPanels(data, data.depositChannelDate || date);

  const tbody = document.getElementById("rows");
  if (!data.rows.length) {
    renderTableState(tbody, 10, "\u6682\u65e0\u7b26\u5408\u6761\u4ef6\u7684\u4ea4\u6613");
    renderPager(data.total, data.page, data.limit);
    if (scrollTop) scrollListToTop();
    return;
  }

  tbody.innerHTML = data.rows
    .map(function (r) {
      return (
        "<tr><td>" +
        fmtDate(r.created_at) +
        "</td><td>" +
        typeBadge(r.type) +
        "</td><td>" +
        redepositDisplay(r) +
        '</td><td translate="no">' +
        customerLink(r.name || "-", r.customer_id, r.mobile) +
        '</td><td translate="no">' +
        escHtml(r.mobile || "-") +
        "</td><td>" +
        fmtMoney(r.amount) +
        "</td><td>" +
        methodDisplay(r) +
        '</td><td translate="no">' +
        escHtml(channelDisplay(r)) +
        '</td><td translate="no">' +
        escHtml(r.status || "-") +
        '</td><td><div class="tx-id-cell"><span>' +
        escHtml(r.id || "-") +
        '</span><a class="tx-audit-link admin-audit-link" href="/audit-history.html?tx_id=' +
        encodeURIComponent(r.id || "") +
        '" aria-label="查看这笔交易的操作历史"><i data-lucide="history"></i>历史</a></div>' +
        "</td></tr>"
      );
    })
    .join("");
  if (window.lucide) window.lucide.createIcons();

  renderPager(data.total, data.page, data.limit);
  if (scrollTop) scrollListToTop();
  } catch (e) {
    if (e && e.cancelled) return;
    if (txLoadGate.isCurrent(requestToken)) {
      renderTableState("rows", 10, "\u4ea4\u6613\u52a0\u8f7d\u5931\u8d25\uff1a" + (e.message || "\u8bf7\u91cd\u8bd5"), "error");
    }
  } finally {
    if (txLoadGate.isCurrent(requestToken)) setListLoading(wrap, false);
  }
}

document.querySelectorAll("#type-tabs .seg-btn").forEach(function (btn) {
  btn.addEventListener("click", function () {
    document.querySelectorAll("#type-tabs .seg-btn").forEach(function (b) {
      b.classList.remove("active");
    });
    btn.classList.add("active");
    currentType = btn.dataset.type || "";
    currentPage = 1;
    loadTransactions();
  });
});

document.getElementById("search-btn").onclick = function () {
  currentPage = 1;
  loadTransactions();
};
document.getElementById("q").addEventListener("keydown", function (event) {
  if (event.key === "Enter") {
    currentPage = 1;
    loadTransactions();
  }
});

bindCompanySwitch(loadTransactions);
loadTransactions();
startAutoReload(function () { loadTransactions({ scrollTop: false }); }, 10);
