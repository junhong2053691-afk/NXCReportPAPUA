setActiveNav("home");

function renderCards(d) {
  if (!guardCompanyPayload(d)) return;
  var dateEl = document.getElementById("report-date");
  if (dateEl) {
    dateEl.textContent =
      (d.companyName ? d.companyName + " \u00b7 " : "") +
      "\u62a5\u8868\u65e5: " +
      d.date;
  }
  animateValue(document.getElementById("dep-count"), d.deposits.count, { suffix: " \u7b14" });
  animateValue(document.getElementById("dep-total"), d.deposits.total, { prefix: "\u5408\u8ba1 $", decimals: 2 });
  animateValue(document.getElementById("wd-count"), d.withdrawals.count, { suffix: " \u7b14" });
  animateValue(document.getElementById("wd-total"), d.withdrawals.total, { prefix: "\u5408\u8ba1 $", decimals: 2 });
  animateValue(document.getElementById("online-count"), d.onlineToday, { suffix: " \u4eba" });
  animateValue(document.getElementById("dep-users-count"), d.depositUsersToday, { suffix: " \u4eba" });
  animateValue(document.getElementById("cust-total"), d.customers.total, {});
  animateValue(document.getElementById("cust-new"), d.customers.newToday, { prefix: "\u4eca\u65e5\u65b0\u6ce8\u518c " });
  if (d.bonus) {
    animateValue(document.getElementById("bonus-count"), d.bonus.count, { suffix: " \u7b14" });
    animateValue(document.getElementById("bonus-total"), d.bonus.total, { prefix: "\u5408\u8ba1 $", decimals: 2 });
  }
  if (d.manual) {
    animateValue(document.getElementById("manual-count"), d.manual.count, { suffix: " \u7b14" });
    animateValue(document.getElementById("manual-total"), d.manual.total, { prefix: "\u5408\u8ba1 $", decimals: 2 });
  }
  if (d.commission) {
    animateValue(document.getElementById("commission-count"), d.commission.count, { suffix: " \u7b14" });
    animateValue(document.getElementById("commission-total"), d.commission.total, { prefix: "\u5408\u8ba1 $", decimals: 2 });
  }
  if (d.winLoss) {
    const v = Number(d.winLoss.total || 0);
    const el = document.getElementById("winloss-value");
    const sign = v > 0 ? "+" : v < 0 ? "-" : "";
    el.textContent = sign + fmtMoney(Math.abs(v));
    el.classList.toggle("positive", v > 0);
    el.classList.toggle("negative", v < 0);
    document.getElementById("winloss-sub").textContent =
      "\u5145\u503c " + fmtMoney(d.winLoss.dep) + " \u00b7 \u63d0\u6b3e " + fmtMoney(d.winLoss.wd);
  }
}

function renderSyncStatus(s) {
  var el = document.getElementById("sync-status");
  if (!el) return;
  el.className = "hero-sync-detail";
  if (!s || !s.at) {
    el.textContent = "\u6570\u636e\u4f53\u68c0\u5c1a\u672a\u8fd0\u884c";
    el.dataset.state = "warning";
    renderDataHealth(s || {});
    return;
  }
  var t = new Date(s.at).toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  if (s.accessDenied) {
    el.textContent = "API \u8bbf\u95ee\u88ab\u62d2\u7edd \u00b7 \u73b0\u6709\u6570\u636e\u5df2\u4fdd\u7559";
    el.dataset.state = "error";
    renderDataHealth(s);
    return;
  }
  el.textContent = (s.ok ? "\u6570\u636e\u4f53\u68c0\u5df2\u66f4\u65b0 " : "\u540c\u6b65\u5f02\u5e38 ") + t;
  el.dataset.state = s.ok ? "healthy" : "error";
  renderDataHealth(s);
}

function escHtml(v) {
  return String(v == null ? "" : v).replace(/[&<>"]/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
  });
}

// "\u6570\u636e\u4f53\u68c0" panel: shows per-transaction ID reconciliation (idAudit) and
// fast-lane truncation flags so accuracy is self-evident at a glance.
function renderDataHealth(s) {
  var anchor = document.getElementById("sync-status");
  if (!anchor || !anchor.parentNode) return;
  var badge = document.getElementById("data-health-badge");
  var detail = document.getElementById("data-health-detail");
  function setHealthOpen(open) {
    if (!detail || !badge) return;
    detail.hidden = !open;
    badge.setAttribute("aria-expanded", String(open));
  }
  if (!badge) {
    badge = document.createElement("button");
    badge.type = "button";
    badge.id = "data-health-badge";
    badge.className = "data-health-badge status-pill";
    badge.setAttribute("aria-expanded", "false");
    badge.setAttribute("aria-controls", "data-health-detail");
    anchor.parentNode.appendChild(badge);

    detail = document.createElement("div");
    detail.id = "data-health-detail";
    detail.className = "health-popover glass-panel";
    detail.hidden = true;
    document.body.appendChild(detail);

    badge.addEventListener("click", function () {
      setHealthOpen(detail.hidden);
    });
    document.addEventListener("click", function (event) {
      if (detail.hidden) return;
      if (detail.contains(event.target) || badge.contains(event.target)) return;
      setHealthOpen(false);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !detail.hidden) {
        setHealthOpen(false);
        badge.focus();
      }
    });
  }

  var audit = s && s.idAudit;
  var trunc = s && s.truncation;
  var truncHits = [];
  if (trunc) {
    Object.keys(trunc).forEach(function (type) {
      if (trunc[type] && trunc[type].hit) truncHits.push({ type: type, info: trunc[type] });
    });
  }

  var state = "healthy";
  var icon = "shield-check";
  var label = "\u9010\u7b14\u5bf9\u8d26\u4e00\u81f4";
  if (!audit || !audit.days || !audit.days.length) {
    state = "neutral";
    icon = "clock-3";
    label = "\u5bf9\u8d26\u5f85\u8fd0\u884c";
  } else if (audit.ok === false) {
    state = "error";
    icon = "shield-alert";
    label = "\u5bf9\u8d26\u53d1\u73b0\u5dee\u5f02";
  } else if (truncHits.length) {
    state = "warning";
    icon = "triangle-alert";
    label = "\u6570\u636e\u53ef\u80fd\u622a\u65ad";
  }
  badge.dataset.state = state;
  badge.innerHTML = renderIcon(icon, { size: 15 }) + "<span>" + label + "</span>";
  renderIcons(badge);

  var html = '<div class="health-popover-head"><strong>\u6570\u636e\u4f53\u68c0</strong><span>' +
    (audit && audit.at ? escHtml(new Date(audit.at).toLocaleString("en-AU")) : "\u5f85\u8fd0\u884c") +
    '</span><button type="button" class="health-popover-close icon-btn" id="data-health-close" aria-label="\u5173\u95ed">×</button></div>';
  if (truncHits.length) {
    html += '<div class="health-message warning">';
    truncHits.forEach(function (hit) {
      html += "<p>" + escHtml(hit.type) + " API " + escHtml(hit.info.totalPage) +
        " \u9875\uff0c\u8d85\u8fc7\u4e0a\u9650 " + escHtml(hit.info.maxPages) + " \u9875</p>";
    });
    html += "</div>";
  }
  if (audit && audit.days && audit.days.length) {
    audit.days.forEach(function (day) {
      html += '<section class="health-day"><h3>' + escHtml(day.date) +
        '<span class="' + (day.ok ? "healthy" : "error") + '">' +
        (day.ok ? "\u4e00\u81f4" : "\u5dee\u5f02") + "</span></h3>";
      (day.types || []).forEach(function (type) {
        var issues = (type.missingCount || 0) + (type.extraCount || 0) + (type.amountMismatchCount || 0);
        html += '<div class="health-row ' + (issues ? "error" : "healthy") + '"><strong>' +
          escHtml(type.type) + "</strong><span>DB " + escHtml(type.dbCount) + " / API " +
          escHtml(type.apiCount) + (issues ? " \u00b7 \u5dee\u5f02 " + issues : " \u00b7 \u4e00\u81f4") +
          "</span></div>";
      });
      html += "</section>";
    });
  } else {
    html += '<div class="health-message neutral">\u7b49\u5f85 slow lane \u5bf9\u8d26\u5468\u671f</div>';
  }
  detail.innerHTML = html;
  var closeBtn = document.getElementById("data-health-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", function () {
      setHealthOpen(false);
      badge.focus();
    });
  }
}

function clearTodayLeaderboard() {
  var summary = document.getElementById("today-lb-summary");
  var tbody = document.getElementById("today-lb-rows");
  var empty = document.getElementById("today-lb-empty");
  if (summary) summary.textContent = "\u4eca\u65e5\u987e\u5ba2\u699c \u00b7 \u52a0\u8f7d\u4e2d\u2026";
  if (tbody) renderTableState(tbody, 11, "\u52a0\u8f7d\u4e2d\u2026");
  if (empty) empty.hidden = true;
}

var lbPage = 1;
var lbSort = "dep_total";
var lbPageSize = 50;
var lbRequestSeq = 0;

var LB_SORT_LABELS = {
  dep_total: "\u5145\u503c\u603b\u989d",
  dep_count: "\u5145\u503c\u7b14\u6570",
  max_single: "\u6700\u5927\u5355\u7b14",
  last_dep: "\u6700\u540e\u5145\u503c",
  win_loss: "\u4eca\u65e5\u8f93\u8d62",
};

function renderLbPager(data) {
  var el = document.getElementById("today-lb-pager");
  if (!el) return;
  var total = data.total || 0;
  var page = data.page || 1;
  var pages = data.pages || 1;
  if (total <= 0) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML =
    '<button class="btn btn-outline btn-sm" id="lb-prev-page"' +
    (page <= 1 ? " disabled" : "") +
    ">\u4e0a\u4e00\u9875</button>" +
    '<span class="pager-info">\u7b2c ' +
    page +
    " / " +
    pages +
    " \u9875\uff0c\u5171 " +
    total +
    " \u4eba\uff08\u6bcf\u9875 " +
    (data.limit || lbPageSize) +
    "\uff09</span>" +
    '<button class="btn btn-outline btn-sm" id="lb-next-page"' +
    (page >= pages ? " disabled" : "") +
    ">\u4e0b\u4e00\u9875</button>";
  var prev = document.getElementById("lb-prev-page");
  var next = document.getElementById("lb-next-page");
  if (prev) {
    prev.onclick = function () {
      if (lbPage > 1) {
        lbPage--;
        loadTodayLeaderboard();
      }
    };
  }
  if (next) {
    next.onclick = function () {
      if (lbPage < pages) {
        lbPage++;
        loadTodayLeaderboard();
      }
    };
  }
}

function renderTodayLeaderboard(data) {
  var summary = document.getElementById("today-lb-summary");
  var tbody = document.getElementById("today-lb-rows");
  var empty = document.getElementById("today-lb-empty");
  if (!tbody) return;

  document.querySelectorAll("#today-lb-sort-tabs .seg-btn").forEach(function (btn) {
    btn.classList.toggle("active", btn.dataset.sort === (data.sort || lbSort));
  });

  if (summary) {
    var sortLabel = data.sortLabel || LB_SORT_LABELS[data.sort] || LB_SORT_LABELS.dep_total;
    summary.textContent =
      "\u4eca\u65e5\u987e\u5ba2\u699c | \u5171 " +
      (data.total || 0) +
      " \u4eba | \u6392\u5e8f: " +
      sortLabel +
      " | \u7b2c " +
      (data.page || 1) +
      "/" +
      (data.pages || 1) +
      " \u9875";
  }

  if (!data.rows || !data.rows.length) {
    tbody.innerHTML = "";
    if (empty) empty.hidden = false;
    renderLbPager(data);
    return;
  }
  if (empty) empty.hidden = true;

  var rankBase = ((data.page || 1) - 1) * (data.limit || lbPageSize);
  tbody.innerHTML = data.rows
    .map(function (r, i) {
      return (
        "<tr><td>" +
        (rankBase + i + 1) +
        "</td><td>" +
        customerLink(r.name || "-", r.customer_id, r.mobile) +
        "</td><td>" +
        escHtml(r.mobile || "-") +
        "</td><td><strong>" +
        fmtMoney(r.dep_total) +
        "</strong></td><td>" +
        (r.dep_count || 0) +
        "</td><td class=\"wd-cell\">" +
        fmtMoney(r.wd_total) +
        "</td><td>" +
        (r.wd_count || 0) +
        "</td><td>" +
        fmtMoney(r.win_loss) +
        "</td><td>" +
        fmtMoney(r.max_single) +
        "</td><td>" +
        escHtml(fmtDate(r.last_deposit)) +
        "</td><td>" +
        escHtml(fmtDate(r.last_withdraw)) +
        "</td><td>" +
        escHtml(r.referrer || "-") +
        "</td></tr>"
      );
    })
    .join("");
  renderLbPager(data);
}

function loadTodayLeaderboard(options) {
  const scrollTop = shouldScrollList(options);
  const wrap = document.querySelector(".home-rank-table");
  const requestSeq = ++lbRequestSeq;
  setListLoading(wrap, true);
  // Only wipe rows on user-initiated loads (sort/page/company switch). Silent
  // auto-refresh keeps existing rows so the page height never collapses — which
  // is what caused the scroll to jump back to the top on every refresh.
  if (scrollTop) clearTodayLeaderboard();
  const prevScrollY = window.scrollY;
  return api(
    "/api/data/today-customer-leaderboard?page=" +
      lbPage +
      "&limit=" +
      lbPageSize +
      "&sort=" +
      encodeURIComponent(lbSort),
    { bg: !scrollTop }
  )
    .then(function (data) {
      if (requestSeq !== lbRequestSeq) return data;
      renderTodayLeaderboard(data);
      if (scrollTop) scrollListToTop();
      else window.scrollTo(0, prevScrollY);
      return data;
    })
    .catch(function (e) {
      if (e && e.cancelled) return;
      console.error("today lb", e);
      var summary = document.getElementById("today-lb-summary");
      if (summary) summary.textContent = "\u4eca\u65e5\u987e\u5ba2\u699c\u52a0\u8f7d\u5931\u8d25";
    })
    .finally(function () {
      if (requestSeq === lbRequestSeq) setListLoading(wrap, false);
    });
}

function showLoadError(msg) {
  var el = document.getElementById("sync-status");
  if (!el || !msg) return;
  el.textContent = msg;
  el.dataset.state = "error";
}

function compactMoney(value) {
  var n = Number(value || 0);
  var abs = Math.abs(n);
  var sign = n < 0 ? "-" : "";
  if (abs >= 1000000) return sign + "$" + (abs / 1000000).toFixed(1) + "m";
  if (abs >= 1000) return sign + "$" + (abs / 1000).toFixed(1) + "k";
  return sign + fmtMoney(abs);
}

function renderWeekSummary(rows) {
  var strip = document.getElementById("week-strip");
  var empty = document.getElementById("week-empty");
  var summary = document.getElementById("week-summary");
  if (!strip || !empty || !summary) return;
  if (!rows || !rows.length) {
    strip.innerHTML = "";
    empty.hidden = false;
    summary.textContent = "\u65e0\u5386\u53f2\u6570\u636e";
    return;
  }
  empty.hidden = true;
  var values = rows.map(function (row) {
    var dep = Number(row.dep_total || 0);
    var wd = Number(row.wd_total || row.withdraw_total || 0);
    return Number(row.win_loss != null ? row.win_loss : dep - wd);
  });
  var maxAbs = Math.max.apply(null, values.map(function (value) { return Math.abs(value); }).concat([1]));
  var totalDep = 0;
  var totalWd = 0;
  strip.innerHTML = rows.map(function (row, index) {
    var dep = Number(row.dep_total || 0);
    var wd = Number(row.wd_total || row.withdraw_total || 0);
    var net = values[index];
    totalDep += dep;
    totalWd += wd;
    var date = String(row.date || "");
    var dateObj = new Date(date + "T00:00:00");
    // Weekday names are rendered by Intl, not by the dictionary, so this is the
    // one place that has to follow the language itself. dateLocale() lives in
    // i18n.js; fall back to zh-CN if that script failed to load.
    var weekLocale = typeof window.dashDateLocale === "function" ? window.dashDateLocale() : "zh-CN";
    var weekday = Number.isNaN(dateObj.getTime()) ? date.slice(5) : dateObj.toLocaleDateString(weekLocale, {
      weekday: "short",
      month: "numeric",
      day: "numeric",
    });
    var state = net > 0 ? "is-positive" : net < 0 ? "is-negative" : "is-neutral";
    var opacity = (.04 + Math.abs(net) / maxAbs * .12).toFixed(3);
    var sign = net > 0 ? "+" : "";
    var label = date + "\uff0c\u51c0\u989d " + sign + compactMoney(net) + "\uff0c\u5145\u503c " +
      fmtMoney(dep) + "\uff0c\u63d0\u73b0 " + fmtMoney(wd);
    return '<a class="week-day ' + state + '" style="--week-opacity:' + opacity +
      '" href="/daily-archive.html?date=' + encodeURIComponent(date) + '" aria-label="' +
      escHtml(label) + '" title="' + escHtml(label) + '"><span class="week-date">' +
      escHtml(weekday) + '</span><strong class="week-net">' + sign + compactMoney(net) +
      '</strong><span class="week-flow">\u5145 ' + compactMoney(dep) + '<br>\u63d0 ' +
      compactMoney(wd) + "</span></a>";
  }).join("");
  var totalNet = totalDep - totalWd;
  summary.textContent = "\u7d2f\u8ba1\u51c0\u989d " + (totalNet > 0 ? "+" : "") + compactMoney(totalNet);
}

var lastWeekRows = null;

// Weekday names come from Intl, so unlike the rest of the page the translation
// engine cannot re-translate them in place on a toggle: re-render instead.
window.addEventListener("language-changed", function () {
  if (lastWeekRows) renderWeekSummary(lastWeekRows);
});

function loadWeekSummary() {
  return api("/api/data/trend?days=7", { bg: true })
    .then(function (trend) {
      lastWeekRows = trend.rows || [];
      renderWeekSummary(lastWeekRows);
    })
    .catch(function (error) {
      if (error && error.cancelled) return;
      var empty = document.getElementById("week-empty");
      var summary = document.getElementById("week-summary");
      if (empty) {
        empty.hidden = false;
        empty.textContent = "\u8fd1 7 \u65e5\u6570\u636e\u52a0\u8f7d\u5931\u8d25\uff0c\u8bf7\u5237\u65b0\u91cd\u8bd5";
      }
      if (summary) summary.textContent = "\u52a0\u8f7d\u5931\u8d25";
    });
}

function refreshHome(opts) {
  var bg = opts && opts.bg;
  var dashReq = api("/api/data/dashboard", { bg: bg })
    .then(function (d) {
      renderCards(d);
      loadTodayLeaderboard({ scrollTop: false });
      api("/api/data/sync-status", { bg: true }).then(renderSyncStatus).catch(function () {});
      loadWeekSummary();
      return d;
    })
    .catch(function (e) {
      if (e && e.cancelled) return;
      showLoadError("\u6570\u636e\u52a0\u8f7d\u5931\u8d25\uff0c\u8bf7\u5237\u65b0\u9875\u9762\u6216\u91cd\u542f\u670d\u52a1");
    });
  return dashReq;
}

document.querySelectorAll("#today-lb-sort-tabs .seg-btn").forEach(function (btn) {
  btn.addEventListener("click", function () {
    document.querySelectorAll("#today-lb-sort-tabs .seg-btn").forEach(function (b) {
      b.classList.remove("active");
    });
    btn.classList.add("active");
    lbSort = btn.dataset.sort || "dep_total";
    lbPage = 1;
    loadTodayLeaderboard();
  });
});

bindCompanySwitch(function () {
  lbPage = 1;
  refreshHome();
});
refreshHome();

setInterval(function () {
  if (document.hidden) return;
  refreshHome({ bg: true });
}, 15000);
startSyncWatcher(function () {
  refreshHome({ bg: true });
});
