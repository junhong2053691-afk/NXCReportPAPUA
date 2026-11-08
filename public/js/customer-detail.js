(function () {
  const SEGMENT_BADGE = {
    dep_today: "badge-green",
    active_depositor: "badge-green",
    offline_3_7: "badge-orange",
    offline_7plus: "badge-red",
    never_deposited: "badge-gray",
    all: "badge-gray",
  };
  let lastFocus = null;
  let detailRequestSeq = 0;

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;");
  }

  function ensureDrawer() {
    if (document.getElementById("customer-drawer")) return;
    const html =
      '<div id="customer-drawer-backdrop" class="customer-drawer-backdrop" aria-hidden="true">' +
      '<div id="customer-drawer" class="customer-drawer" role="dialog" aria-modal="true" aria-labelledby="cd-name" tabindex="-1">' +
      '<div class="customer-drawer-head">' +
      '<div><h2 id="cd-name">顾客详情</h2><p id="cd-sub" class="cd-sub"></p></div>' +
      '<button type="button" class="cd-close icon-btn" id="cd-close" aria-label="关闭">&times;</button>' +
      "</div>" +
      '<div class="customer-drawer-body" id="cd-body"><p class="cd-loading">加载中…</p></div>' +
      "</div></div>";
    document.body.insertAdjacentHTML("beforeend", html);
    document.getElementById("cd-close").onclick = closeCustomerDetail;
    document.getElementById("customer-drawer-backdrop").onclick = function (e) {
      if (e.target.id === "customer-drawer-backdrop") closeCustomerDetail();
    };
  }

  function drawerIsOpen() {
    const backdrop = document.getElementById("customer-drawer-backdrop");
    return Boolean(backdrop && backdrop.classList.contains("show"));
  }

  function focusableDrawerElements() {
    const drawer = document.getElementById("customer-drawer");
    if (!drawer) return [];
    return Array.from(
      drawer.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ).filter(function (node) {
      return !node.disabled && !node.hidden && node.getClientRects().length > 0;
    });
  }

  function typeBadge(type) {
    if (type === "DEPOSIT") return '<span class="badge badge-green">充值</span>';
    if (type === "WITHDRAW") return '<span class="badge badge-red">提款</span>';
    if (type === "BONUS") return '<span class="badge badge-bonus">Bonus</span>';
    if (type === "MANUAL") return '<span class="badge badge-manual">Manual</span>';
    if (type === "COMMISSION") return '<span class="badge badge-commission">Commission</span>';
    return esc(type || "-");
  }

  function renderDetail(data) {
    const c = data.customer;
    const segCls = SEGMENT_BADGE[data.segment] || "badge-gray";
    const nameEl = document.getElementById("cd-name");
    // Now holds a customer name rather than the placeholder heading, so it is
    // data. The marker is removed again when the placeholder is restored.
    nameEl.setAttribute("translate", "no");
    nameEl.textContent = cleanDisplayName(c.name || c.username || c.mobile || "顾客") || "顾客";
    document.getElementById("cd-sub").innerHTML =
      '<span class="badge ' + segCls + '">' + esc(data.segmentLabel) + "</span>" +
      (c.mobile ? ' · <span id="cd-mobile" translate="no">' + esc(c.mobile) + "</span>" : "") +
      (c.username ? ' · <span translate="no">' + esc(c.username) + "</span>" : "");

    const t = data.stats.today;
    const a = data.stats.allTime;
    const wl = Number(a.win_loss || 0);
    const wlClass = wl > 0 ? "positive" : wl < 0 ? "negative" : "muted";

    let body =
      '<div class="cd-cards">' +
      '<div class="cd-card"><div class="label">今日充值</div><div class="value">' + fmtMoney(t.dep_total) + "</div><div class=\"sub\">" + (t.dep_count || 0) + " 笔</div></div>" +
      '<div class="cd-card"><div class="label">今日提款</div><div class="value">' + fmtMoney(t.wd_total) + "</div><div class=\"sub\">" + (t.wd_count || 0) + " 笔</div></div>" +
      '<div class="cd-card"><div class="label">累计充值</div><div class="value">' + fmtMoney(a.dep_total) + "</div><div class=\"sub\">" + (a.dep_count || 0) + " 笔</div></div>" +
      '<div class="cd-card"><div class="label">累计输赢</div><div class="value ' + wlClass + '">' + (wl > 0 ? "+" : wl < 0 ? "-" : "") + fmtMoney(Math.abs(wl)) + "</div><div class=\"sub\">提款 " + fmtMoney(a.wd_total) + "</div></div>" +
      "</div>" +
      '<div class="cd-meta">' +
      "<p><b>注册</b> " + esc(c.register_date_key || c.register_date || "-") + "</p>" +
      "<p><b>最后上线</b> " + esc(fmtDate(c.last_login_date || c.last_login) || "-") + "</p>" +
      "<p><b>最后充值</b> " + esc(fmtDate(c.last_deposit) || "-") + "</p>" +
      '<p><b>推荐人</b> <span translate="no">' + esc(c.referrer || "-") + "</span></p>" +
      (c.bank_name ? '<p><b>银行</b> <span translate="no">' + esc(c.bank_name) + "</span></p>" : "") +
      "</div>" +
      '<div class="cd-actions">' +
      (c.mobile ? '<button type="button" class="btn btn-outline btn-sm" id="cd-copy">复制手机号</button>' : "") +
      '<a class="btn btn-primary btn-sm" id="cd-tx-link" href="/transactions.html">查看全部交易</a>' +
      "</div>" +
      '<h3 class="cd-section-title">最近交易</h3>' +
      '<div class="table-wrap cd-tx-table"><table data-m="title:3 meta:2,1"><thead><tr><th>时间</th><th>类型</th><th>金额</th><th>状态</th></tr></thead><tbody>';

    const txs = data.transactions || [];
    if (!txs.length) {
      body += '<tr><td colspan="4" class="empty">暂无交易记录</td></tr>';
    } else {
      body += txs
        .map(function (tx) {
          return (
            "<tr><td>" + fmtDate(tx.created_at) + "</td><td>" + typeBadge(tx.type) + "</td><td>" + fmtMoney(tx.amount) + "</td><td>" + esc(tx.status || "-") + "</td></tr>"
          );
        })
        .join("");
    }
    body += "</tbody></table></div>";
    document.getElementById("cd-body").innerHTML = body;

    const copyBtn = document.getElementById("cd-copy");
    if (copyBtn) {
      copyBtn.onclick = function () {
        navigator.clipboard.writeText(c.mobile).then(function () {
          copyBtn.textContent = "已复制";
          setTimeout(function () { copyBtn.textContent = "复制手机号"; }, 1500);
        });
      };
    }
    const txLink = document.getElementById("cd-tx-link");
    if (txLink && c.mobile) {
      txLink.href = "/transactions.html?q=" + encodeURIComponent(c.mobile);
    } else if (txLink && c.id) {
      txLink.href = "/transactions.html?q=" + encodeURIComponent(c.id);
    }
  }

  window.customerLink = function (label, id, mobile) {
    const customerId = String(id || "").trim();
    const customerMobile = String(mobile || "").trim();
    const text = label || customerMobile || "-";
    const cleanText = typeof cleanDisplayName === "function" ? cleanDisplayName(text) : String(text);
    const rendered = typeof displayNameHtml === "function" ? displayNameHtml(text) : esc(cleanText || "-");
    if (!customerId && !customerMobile) return rendered;

    const filter = customerMobile || customerId;
    let attrs =
      'href="/transactions.html?q=' +
      encodeURIComponent(filter) +
      '" class="customer-link" aria-haspopup="dialog" aria-label="' +
      esc((cleanText || "顾客") + "，查看顾客历史") +
      '"';
    if (customerId) attrs += ' data-cid="' + esc(customerId) + '"';
    if (customerMobile) attrs += ' data-cmobile="' + esc(customerMobile) + '"';
    return "<a " + attrs + ">" + rendered + "</a>";
  };

  window.openCustomerDetail = async function (opts) {
    const customerId = String((opts && opts.id) || "").trim();
    const customerMobile = String((opts && opts.mobile) || "").trim();
    if (!customerId && !customerMobile) return;

    ensureDrawer();
    const backdrop = document.getElementById("customer-drawer-backdrop");
    if (!drawerIsOpen()) {
      lastFocus = document.activeElement && typeof document.activeElement.focus === "function"
        ? document.activeElement
        : null;
    }
    const requestSeq = ++detailRequestSeq;
    backdrop.classList.add("show");
    backdrop.setAttribute("aria-hidden", "false");
    document.body.classList.add("customer-drawer-open");
    document.getElementById("cd-body").innerHTML = '<p class="cd-loading">加载中…</p>';
    const placeholderEl = document.getElementById("cd-name");
    placeholderEl.removeAttribute("translate"); // back to a translatable heading
    placeholderEl.textContent = "顾客详情";
    document.getElementById("cd-sub").textContent = "";
    window.requestAnimationFrame(function () {
      const closeButton = document.getElementById("cd-close");
      if (drawerIsOpen() && closeButton) closeButton.focus();
    });
    try {
      const q = new URLSearchParams();
      if (customerId) q.set("id", customerId);
      if (customerMobile) q.set("mobile", customerMobile);
      const data = await api("/api/data/customer-detail?" + q.toString());
      if (requestSeq !== detailRequestSeq) return;
      renderDetail(data);
    } catch (e) {
      if (requestSeq !== detailRequestSeq) return;
      document.getElementById("cd-body").innerHTML = '<p class="cd-error">' + esc(e.message || "加载失败") + "</p>";
    }
  };

  window.closeCustomerDetail = function () {
    const el = document.getElementById("customer-drawer-backdrop");
    if (!el || !el.classList.contains("show")) return;
    detailRequestSeq += 1;
    el.classList.remove("show");
    el.setAttribute("aria-hidden", "true");
    document.body.classList.remove("customer-drawer-open");
    const focus = lastFocus;
    lastFocus = null;
    if (focus && document.contains(focus)) focus.focus();
  };

  document.addEventListener("click", function (e) {
    const a = e.target.closest(".customer-link");
    if (!a) return;
    e.preventDefault();
    openCustomerDetail({ id: a.dataset.cid || "", mobile: a.dataset.cmobile || "" });
  });

  window.addEventListener("company-changed", function () {
    closeCustomerDetail();
  });

  document.addEventListener("keydown", function (e) {
    if (!drawerIsOpen()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeCustomerDetail();
      return;
    }
    if (e.key !== "Tab") return;

    e.stopImmediatePropagation();
    const drawer = document.getElementById("customer-drawer");
    const focusable = focusableDrawerElements();
    if (!focusable.length) {
      e.preventDefault();
      drawer.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === drawer || !drawer.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !drawer.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  });
})();
