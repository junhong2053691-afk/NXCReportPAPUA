setActiveNav("daily-archive");

let currentDate = null;
let currentSort = "dep_total";
let currentPage = 1;
let quickDates = [];
const archiveDateGate = createRequestGate();
const archiveLeaderboardGate = createRequestGate();

function shiftDate(dateKey, delta) {
  const p = dateKey.split("-").map(Number);
  const t = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  t.setUTCDate(t.getUTCDate() + delta);
  return t.toISOString().slice(0, 10);
}

function readUrlDate() {
  const q = new URLSearchParams(location.search).get("date");
  return q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : null;
}

function setUrlDate(dateKey) {
  const u = new URL(location.href);
  u.searchParams.set("date", dateKey);
  history.replaceState(null, "", u.pathname + u.search);
}

function renderCards(d) {
  if (!guardCompanyPayload(d)) return;
  const dateEl = document.getElementById("report-date");
  const hintEl = document.getElementById("report-hint");
  if (dateEl) {
    dateEl.textContent =
      (d.companyName ? d.companyName + " \u00b7 " : "") +
      "\u62a5\u8868\u65e5: " +
      d.date +
      (d.isToday ? " (\u4eca\u65e5)" : "");
  }
  if (hintEl) {
    hintEl.classList.remove("negative");
    hintEl.textContent = d.isHistorical
      ? "\u5386\u53f2\u5feb\u7167 \u00b7 \u5145\u63d0/Bonus/\u8f93\u8d62\u6765\u81ea\u5df2\u540c\u6b65\u4ea4\u6613"
      : "\u5b9e\u65f6\u6570\u636e";
    if (d.customersTotalSource === "unavailable") {
      hintEl.textContent += " \u00b7 \u603b\u987e\u5ba2\u65e0\u5f53\u65e5\u5feb\u7167";
    }
  }
  document.getElementById("dep-count").textContent = d.deposits.count + " \u7b14";
  document.getElementById("dep-total").textContent = "\u5408\u8ba1 " + fmtMoney(d.deposits.total);
  document.getElementById("wd-count").textContent = d.withdrawals.count + " \u7b14";
  document.getElementById("wd-total").textContent = "\u5408\u8ba1 " + fmtMoney(d.withdrawals.total);
  document.getElementById("online-count").textContent = d.onlineToday + " \u4eba";
  document.getElementById("dep-users-count").textContent = d.depositUsersToday + " \u4eba";
  const custTotal = d.customers.total;
  document.getElementById("cust-total").textContent =
    custTotal == null ? "\u2014" : String(custTotal);
  document.getElementById("cust-new").textContent = "\u65b0\u6ce8\u518c " + d.customers.newToday;
  if (d.bonus) {
    document.getElementById("bonus-count").textContent = d.bonus.count + " \u7b14";
    document.getElementById("bonus-total").textContent = "\u5408\u8ba1 " + fmtMoney(d.bonus.total);
  }
  if (d.manual) {
    document.getElementById("manual-count").textContent = d.manual.count + " \u7b14";
    document.getElementById("manual-total").textContent = "\u5408\u8ba1 " + fmtMoney(d.manual.total);
  }
  if (d.commission) {
    document.getElementById("commission-count").textContent = d.commission.count + " \u7b14";
    document.getElementById("commission-total").textContent = "\u5408\u8ba1 " + fmtMoney(d.commission.total);
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
  const txLink = document.getElementById("tx-link");
  if (txLink) txLink.href = "/transactions.html?date=" + encodeURIComponent(d.date);
  if (d.monthWinLoss) {
    const m = d.monthWinLoss;
    const ml = document.getElementById("month-wl-label");
    const mv = document.getElementById("month-wl-value");
    const ms = document.getElementById("month-wl-sub");
    if (ml) ml.textContent = (m.label || m.month) + " \u51c0\u8f93\u8d62";
    if (mv) {
      const v = Number(m.total || 0);
      const sign = v > 0 ? "+" : v < 0 ? "-" : "";
      mv.textContent = sign + fmtMoney(Math.abs(v));
      mv.classList.toggle("positive", v > 0);
      mv.classList.toggle("negative", v < 0);
    }
    if (ms) {
      ms.textContent =
        (m.from || "") +
        " \u81f3 " +
        (m.to || "") +
        (m.isComplete ? " \u00b7 \u6574\u6708\u7d2f\u8ba1" : " \u00b7 \u5f53\u6708\u7d2f\u8ba1\u81f3\u4eca") +
        " \u00b7 \u5145\u503c " +
        fmtMoney(m.dep) +
        " \u00b7 \u63d0\u6b3e " +
        fmtMoney(m.wd);
    }
  }
  const lbTitle = document.getElementById("lb-title");
  if (lbTitle) lbTitle.textContent = d.date + " \u987e客\u699c";
}

function renderQuickDates() {
  const wrap = document.getElementById("quick-dates");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!quickDates.length) return;
  const label = document.createElement("span");
  label.className = "archive-quick-label";
  label.textContent = "\u5feb\u6377: ";
  wrap.appendChild(label);
  quickDates.slice(0, 14).forEach(function (d) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "archive-date-chip" + (d === currentDate ? " active" : "");
    btn.textContent = d.slice(5);
    btn.title = d;
    btn.onclick = function () {
      loadDate(d);
    };
    wrap.appendChild(btn);
  });
}

function renderLeaderboard(data) {
  const summary = document.getElementById("day-lb-summary");
  const tbody = document.getElementById("day-lb-rows");
  const empty = document.getElementById("day-lb-empty");
  const pager = document.getElementById("day-lb-pager");
  if (!tbody) return;
  if (!data.rows || !data.rows.length) {
    if (summary) summary.textContent = data.date + " \u00b7 \u6682\u65e0\u5145\u503c\u987e\u5ba2";
    tbody.innerHTML = "";
    if (empty) empty.hidden = false;
    if (pager) pager.innerHTML = "";
    return;
  }
  if (empty) empty.hidden = true;
  if (summary) {
    summary.textContent =
      data.date + " \u00b7 " + (data.sortLabel || "") + " \u00b7 \u5171 " + data.total + " \u4eba";
  }
  tbody.innerHTML = data.rows
    .map(function (r, i) {
      const rank = (data.page - 1) * data.limit + i + 1;
      const wl = Number(r.win_loss || 0);
      const wlClass = wl > 0 ? "positive" : wl < 0 ? "negative" : "";
      return (
        "<tr><td>" +
        rank +
        "</td><td>" +
        (typeof customerLink === "function" ? customerLink(r.name || "-", r.customer_id, r.mobile) : displayNameHtml(r.name || '-')) +
        "</td><td>" +
        escHtml(r.mobile || '-') +
        "</td><td>" +
        fmtMoney(r.dep_total) +
        "</td><td>" +
        r.dep_count +
        "</td><td>" +
        fmtMoney(r.wd_total) +
        "</td><td>" +
        r.wd_count +
        '</td><td class="' +
        wlClass +
        '">' +
        fmtMoney(wl) +
        "</td><td>" +
        fmtMoney(r.max_single) +
        "</td><td>" +
        fmtDate(r.last_deposit) +
        "</td><td>" +
        escHtml(r.referrer || '-') +
        "</td></tr>"
      );
    })
    .join("");
  if (pager) {
    pager.innerHTML =
      data.pages > 1
        ? '<button class="btn btn-outline btn-sm" id="lb-prev"' +
          (data.page <= 1 ? " disabled" : "") +
          ">\u4e0a\u4e00\u9875</button> \u7b2c " +
          data.page +
          " / " +
          data.pages +
          ' \u9875 <button class="btn btn-outline btn-sm" id="lb-next"' +
          (data.page >= data.pages ? " disabled" : "") +
          ">\u4e0b\u4e00\u9875</button>"
        : "";
    const prev = document.getElementById("lb-prev");
    const next = document.getElementById("lb-next");
    if (prev) prev.onclick = function () {
      if (data.page > 1) {
        currentPage = data.page - 1;
        loadLeaderboard();
      }
    };
    if (next) next.onclick = function () {
      if (data.page < data.pages) {
        currentPage = data.page + 1;
        loadLeaderboard();
      }
    };
  }
}

function loadLeaderboard() {
  const requestToken = archiveLeaderboardGate.begin();
  return api(
    "/api/data/day-leaderboard?date=" +
      encodeURIComponent(currentDate) +
      "&sort=" +
      encodeURIComponent(currentSort) +
      "&page=" +
      currentPage
  ).then(function (data) {
    if (!archiveLeaderboardGate.isCurrent(requestToken) || !guardCompanyPayload(data)) return;
    renderLeaderboard(data);
  }).catch(function (error) {
    if (error && error.cancelled) return;
    if (archiveLeaderboardGate.isCurrent(requestToken)) {
      renderTableState("day-lb-rows", 11, "\u5f53\u65e5\u5ba2\u6237\u699c\u52a0\u8f7d\u5931\u8d25\uff1a" + (error.message || "\u8bf7\u91cd\u8bd5"), "error");
    }
  });
}

function loadDate(dateKey) {
  const requestToken = archiveDateGate.begin();
  currentDate = dateKey;
  currentPage = 1;
  const input = document.getElementById("report-day");
  if (input) input.value = dateKey;
  setUrlDate(dateKey);
  renderQuickDates();
  const nextBtn = document.getElementById("next-day");
  if (nextBtn) nextBtn.disabled = dateKey >= todaySydney();
  return api("/api/data/dashboard?date=" + encodeURIComponent(dateKey))
    .then(function (d) {
      if (!archiveDateGate.isCurrent(requestToken) || !guardCompanyPayload(d)) return;
      renderCards(d);
      return loadLeaderboard();
    })
    .catch(function (e) {
      if (e && e.cancelled) return;
      if (!archiveDateGate.isCurrent(requestToken)) return;
      const hint = document.getElementById("report-hint");
      if (hint) {
        hint.textContent = "\u65e5\u62a5\u52a0\u8f7d\u5931\u8d25\uff1a" + (e.message || "\u8bf7\u91cd\u8bd5");
        hint.classList.add("negative");
      }
      renderTableState("day-lb-rows", 11, "\u65e5\u62a5\u52a0\u8f7d\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5", "error");
    });
}

function bindControls() {
  document.getElementById("report-day").addEventListener("change", function () {
    const v = this.value;
    if (v) loadDate(v);
  });
  document.getElementById("prev-day").onclick = function () {
    if (currentDate) loadDate(shiftDate(currentDate, -1));
  };
  document.getElementById("next-day").onclick = function () {
    if (currentDate && currentDate < todaySydney()) loadDate(shiftDate(currentDate, 1));
  };
  document.getElementById("yesterday-btn").onclick = function () {
    loadDate(shiftDate(todaySydney(), -1));
  };
  document.getElementById("today-btn").onclick = function () {
    location.href = "/";
  };
  document.querySelectorAll("#day-lb-sort-tabs .seg-btn").forEach(function (btn) {
    btn.onclick = function () {
      document.querySelectorAll("#day-lb-sort-tabs .seg-btn").forEach(function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      currentSort = btn.dataset.sort || "dep_total";
      currentPage = 1;
      loadLeaderboard();
    };
  });
}

function boot() {
  bindControls();
  const start = readUrlDate() || shiftDate(todaySydney(), -1);
  api("/api/data/report-dates?limit=30")
    .then(function (r) {
      quickDates = r.dates || [];
      return loadDate(start);
    })
    .catch(function () {
      return loadDate(start);
    });
}

window.addEventListener("company-changed", function () {
  currentPage = 1;
  api("/api/data/report-dates?limit=30")
    .then(function (r) {
      quickDates = r.dates || [];
      renderQuickDates();
      return loadDate(currentDate || shiftDate(todaySydney(), -1));
    })
    .catch(function () {
      loadDate(currentDate || shiftDate(todaySydney(), -1));
    });
});

boot();
