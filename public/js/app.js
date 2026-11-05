
let _redirectingToLogin = false;

function isLoginPage() {
  const p = window.location.pathname;
  return p === "/login.html" || p.endsWith("/login.html");
}

// session 过期（服务重启、12 小时到期）时，后端对 /api/* 返回 401。
// 在此之前所有 loader 的 .catch(() => {}) 会静默吞掉它，页面停留在旧数字
// 不再更新且不提示任何东西 —— 操作员无从得知要重新登录。
function redirectToLogin() {
  if (_redirectingToLogin) return; // 并发多个请求同时 401 时只跳一次
  if (isLoginPage()) return; // 死循环防线：登录页自身永不跳转
  _redirectingToLogin = true;
  fetchEpoch += 1; // 作废所有在途请求的渲染，避免跳转途中闪出错误
  window.location.replace("/login.html"); // replace 不留历史，Back 不会再弹回来
}

async function api(url, opts = {}) {
  const epoch = opts.epoch != null ? opts.epoch : fetchEpoch;
  const { epoch: _epoch, bg: _bg, ...fetchOpts } = opts;
  if (!_bg) progressStart();
  try {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json", ...(fetchOpts.headers || {}) },
      ...fetchOpts,
    });
    // 必须在 res.json() 之前：401 的 body 只是 {error:"请先登录"}，读它没有意义。
    // cancelled 标记复用了各页面脚本已有的 `if (e && e.cancelled) return;` 约定，
    // 让跳转途中所有页面安静 return，而不是闪一屏红色错误。
    if (res.status === 401) {
      redirectToLogin();
      const err = new Error("请先登录");
      err.unauthorized = true;
      err.cancelled = true;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (epoch !== fetchEpoch) {
      const err = new Error("请求已取消");
      err.cancelled = true;
      throw err;
    }
    if (!res.ok) throw new Error(data.error || "请求失败");
    return data;
  } finally {
    if (!_bg) progressDone();
  }
}

// --- Top progress bar (NProgress-style). Only appears for loads that take
// longer than a short delay, so fast background polls never cause a flash. ---
let _progPending = 0;
let _progEl = null;
let _progShowTimer = null;
let _progVisible = false;

function ensureProgressEl() {
  if (_progEl) return _progEl;
  const el = document.createElement("div");
  el.id = "top-progress";
  el.innerHTML = '<div class="bar"></div>';
  (document.body || document.documentElement).appendChild(el);
  _progEl = el;
  return el;
}

function progressStart() {
  _progPending += 1;
  if (_progPending > 1) return;
  clearTimeout(_progShowTimer);
  _progShowTimer = setTimeout(function () {
    const el = ensureProgressEl();
    _progVisible = true;
    el.classList.remove("done");
    el.classList.add("active");
    const bar = el.querySelector(".bar");
    bar.style.width = "8%";
    requestAnimationFrame(function () {
      bar.style.width = "85%";
    });
  }, 220);
}

function progressDone() {
  _progPending = Math.max(0, _progPending - 1);
  if (_progPending > 0) return;
  clearTimeout(_progShowTimer);
  if (!_progVisible || !_progEl) return;
  _progVisible = false;
  const el = _progEl;
  const bar = el.querySelector(".bar");
  bar.style.width = "100%";
  el.classList.add("done");
  setTimeout(function () {
    el.classList.remove("active", "done");
    bar.style.width = "0%";
  }, 280);
}


function cleanDisplayName(s) {
  // Hide upstream VIP/blacklist metadata while leaving the stored source intact.
  return String(s || "")
    .replace(/<span[^>]*class="name-blacklist"[^>]*>[\s\S]*?<\/span>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function displayNameHtml(s) {
  return escHtml(cleanDisplayName(s) || "-");
}

let activeCompanyId = null;
let fetchEpoch = 0;
let currentUser = null;

function bumpFetchEpoch() {
  fetchEpoch += 1;
  return fetchEpoch;
}

async function loadCompanies() {
  const sel = document.getElementById("company-select");
  if (!sel) return;
  try {
    const data = await api("/api/companies");
    activeCompanyId = data.active;
    if (activeCompanyId) {
      api("/api/companies/active", { method: "POST", body: JSON.stringify({ id: activeCompanyId }) }).catch(function () {});
    }
    sel.innerHTML = "";
    for (const co of data.companies || []) {
      const opt = document.createElement("option");
      opt.value = co.id;
      opt.textContent = co.name + (co.has_credentials ? "" : " (未配置)");
      if (co.id === data.active) opt.selected = true;
      sel.appendChild(opt);
    }
    const operatorLocked = currentUser?.role === "operator" && (data.companies || []).length <= 1;
    sel.disabled = operatorLocked;
    sel.setAttribute("aria-disabled", operatorLocked ? "true" : "false");
    sel.title = operatorLocked ? "当前 operator 仅授权此公司" : "切换公司";
    updateCompanySyncHint(data.companies, data.active);
    updateCompactCompanyButton(data.companies, data.active);
    sel.onchange = async () => {
      const id = sel.value;
      if (id === activeCompanyId) return;
      sel.disabled = true;
      setPageLoading(true);
      bumpFetchEpoch();
      try {
        await api("/api/companies/active", { method: "POST", body: JSON.stringify({ id }) });
        activeCompanyId = id;
        delete lastSyncAtByCompany[id];
        updateCompanySyncHint(data.companies, id);
        updateCompactCompanyButton(data.companies, id);
        window.dispatchEvent(new CustomEvent("company-changed", { detail: { id } }));
      } catch (e) {
        if (!e.cancelled) {
          sel.value = activeCompanyId;
          showToast(e.message || "切换公司失败", { tone: "error", title: "切换公司失败" });
        }
      } finally {
        sel.disabled = false;
        setPageLoading(false);
      }
    };
  } catch (e) {
    console.warn("companies load failed", e.message);
  }
}

function updateCompanySyncHint(companies, activeId) {
  const el = document.getElementById("company-sync");
  if (!el) return;
  const co = (companies || []).find((c) => c.id === activeId);
  if (!co) {
    el.textContent = "\u672a\u9009\u62e9\u516c\u53f8";
    el.className = "company-sync-hint";
    return;
  }
  if (!co.has_credentials) {
    el.textContent = "API \u672a\u914d\u7f6e";
    el.className = "company-sync-hint warn";
    updateGlobalSyncState({ ok: false, message: "API \u672a\u914d\u7f6e", at: null, unconfigured: true });
    return;
  }
  const ok = co.last_sync_ok;
  const msg = co.last_sync_msg || "";
  const denied = msg.indexOf("\u62d2\u7edd\u8bbf\u95ee") !== -1 || msg.toLowerCase().indexOf("invalid access") !== -1;
  if (!co.last_sync_at) {
    el.textContent = "\u7b49\u5f85\u9996\u6b21\u540c\u6b65";
  } else if (denied) {
    el.textContent = "API \u62d2\u7edd\u8bbf\u95ee";
  } else {
    el.textContent = ok ? "\u540c\u6b65\u6b63\u5e38" : "\u540c\u6b65\u5f02\u5e38";
  }
  el.className = "company-sync-hint " + (ok === false ? "warn" : "ok");
}

function updateCompactCompanyButton(companies, activeId) {
  const btn = document.getElementById("company-compact-btn");
  if (!btn) return;
  const co = (companies || []).find((c) => c.id === activeId);
  const name = co && co.name ? co.name : "选择公司";
  const label = "切换公司：" + name;
  btn.setAttribute("aria-label", label);
  btn.setAttribute("title", label);
}

function syncAgeLabel(at) {
  if (!at) return "";
  const ms = Date.now() - new Date(at).getTime();
  if (!Number.isFinite(ms)) return "";
  if (ms < 15000) return "\u521a\u521a\u66f4\u65b0";
  if (ms < 60000) return Math.max(1, Math.floor(ms / 1000)) + "\u79d2\u524d";
  if (ms < 3600000) return Math.floor(ms / 60000) + "\u5206\u949f\u524d";
  return fmtDate(at);
}

function updateGlobalSyncState(state) {
  const root = document.getElementById("global-sync-state");
  const text = document.getElementById("global-sync-text");
  const time = document.getElementById("global-sync-time");
  if (!root || !text || !time) return;

  const message = String((state && state.message) || "");
  const denied =
    Boolean(state && state.accessDenied) ||
    /invalid access|access denied/i.test(message) ||
    message.indexOf("\u62d2\u7edd\u8bbf\u95ee") !== -1;
  const at = state && state.at;
  const age = at ? Date.now() - new Date(at).getTime() : Infinity;
  let kind = "loading";
  let label = "\u6b63\u5728\u8bfb\u53d6\u540c\u6b65\u72b6\u6001";

  if (state && state.unconfigured) {
    kind = "warning";
    label = "API \u672a\u914d\u7f6e";
  } else if (denied) {
    kind = "denied";
    label = "API \u8bbf\u95ee\u88ab\u62d2\u7edd";
  } else if (!state || !at) {
    kind = state && state.ok === false ? "warning" : "loading";
    label = "\u7b49\u5f85\u9996\u6b21\u540c\u6b65";
  } else if (state.ok === false) {
    kind = "error";
    label = "\u540c\u6b65\u5931\u8d25";
  } else if (age > 90000) {
    kind = "warning";
    label = "\u540c\u6b65\u5ef6\u8fdf";
  } else {
    kind = "healthy";
    label = state.mode === "fast" ? "\u5b9e\u65f6\u540c\u6b65\u6b63\u5e38" : "\u540c\u6b65\u6b63\u5e38";
  }

  root.dataset.state = kind;
  root.title = message || label;
  text.textContent = label;
  time.textContent = syncAgeLabel(at);
}

function startGlobalSyncWatcher() {
  let stopped = false;
  const poll = function () {
    if (stopped || document.hidden || !activeCompanyId) return;
    api("/api/data/sync-status", { bg: true })
      .then(function (state) {
        if (!state || state.companyId !== activeCompanyId) return;
        updateGlobalSyncState(state);
      })
      .catch(function (error) {
        updateGlobalSyncState({ ok: false, message: error.message || "\u8bf7\u6c42\u5931\u8d25", at: null });
      });
  };
  poll();
  const timer = setInterval(poll, 8000);
  window.addEventListener("company-changed", function () {
    updateGlobalSyncState(null);
    poll();
  });
  window.addEventListener("pagehide", function () {
    stopped = true;
    clearInterval(timer);
  }, { once: true });
}

async function loadUser() {
  try {
    const { user, companyId } = await api("/api/auth/me");
    currentUser = user;
    document.body.dataset.userRole = user.role;
    const el = document.getElementById("current-user");
    if (el) el.textContent = user.name + " (" + user.username + ")";
    const userLabel = document.querySelector(".user-label");
    if (userLabel) userLabel.textContent = user.role === "admin" ? "Admin" : "Operator";
    document.querySelectorAll("[data-page]").forEach((link) => {
      link.hidden = user.role === "operator" && link.dataset.page !== "bank-accounts";
    });
    document.querySelectorAll(".nav-group").forEach((group) => {
      if (user.role === "operator") group.hidden = true;
    });
    const adminLink = document.getElementById("nav-admin");
    if (adminLink) adminLink.hidden = user.role !== "admin";
    const csLink = document.getElementById("nav-company-settings");
    if (csLink) csLink.hidden = user.role !== "admin";
    const settingsGroup = document.getElementById("nav-settings-group");
    if (settingsGroup) settingsGroup.hidden = user.role !== "admin";
    const monthlyGroup = document.getElementById("nav-monthly-group");
    if (monthlyGroup) monthlyGroup.hidden = user.role !== "admin";
    if (companyId) activeCompanyId = companyId;
    await loadCompanies();
    return user;
  } catch {
    window.location.href = "/login.html";
  }
}

function setupLogout() {
  const btn = document.getElementById("logout-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    window.location.href = "/login.html";
  });
}

function setPageLoading(on) {
  const main = document.querySelector(".main");
  if (main) main.classList.toggle("page-loading", Boolean(on));
}

function resolveListWrap(target) {
  if (!target) {
    return document.querySelector(".table-wrap");
  }
  if (typeof target === "string") {
    const el = document.getElementById(target) || document.querySelector(target);
    return el ? el.closest(".table-wrap") || el : null;
  }
  if (target.closest) return target.closest(".table-wrap") || target;
  return target;
}

function setListLoading(target, on) {
  const wrap = resolveListWrap(target);
  if (!wrap || !wrap.classList) return;
  wrap.classList.toggle("is-loading", Boolean(on));
  wrap.setAttribute("aria-busy", on ? "true" : "false");
}

function createRequestGate() {
  let sequence = 0;
  return {
    begin: function () {
      sequence += 1;
      return sequence;
    },
    isCurrent: function (token) {
      return token === sequence;
    },
    cancel: function () {
      sequence += 1;
    },
  };
}

function renderTableState(target, colSpan, message, tone) {
  const body = typeof target === "string" ? document.getElementById(target) : target;
  if (!body) return;
  const isError = tone === "error";
  const cls = isError ? "table-state table-state-error" : "table-state";
  body.innerHTML =
    '<tr><td role="' +
    (isError ? "alert" : "status") +
    '" colspan="' +
    Number(colSpan || 1) +
    '" class="' +
    cls +
    '">' +
    escHtml(message || "\u6682\u65e0\u6570\u636e") +
    "</td></tr>";
}

function renderClientPager(target, total, page, pageSize, onPage) {
  const pager = typeof target === "string" ? document.getElementById(target) : target;
  if (!pager) return;
  const count = Math.max(0, Number(total) || 0);
  const size = Math.max(1, Number(pageSize) || 50);
  const pages = Math.max(1, Math.ceil(count / size));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  if (count <= size) {
    pager.innerHTML = "";
    pager.hidden = true;
    return;
  }
  const start = (current - 1) * size + 1;
  const end = Math.min(current * size, count);
  pager.hidden = false;
  pager.innerHTML =
    '<button type="button" class="btn btn-outline btn-sm pager-prev"' +
    (current <= 1 ? " disabled" : "") +
    ' aria-label="\u4e0a\u4e00\u9875">\u4e0a\u4e00\u9875</button>' +
    '<span class="pager-status" aria-live="polite">' +
    start +
    "\u2013" +
    end +
    " / " +
    count +
    " \u00b7 " +
    current +
    "/" +
    pages +
    "</span>" +
    '<button type="button" class="btn btn-outline btn-sm pager-next"' +
    (current >= pages ? " disabled" : "") +
    ' aria-label="\u4e0b\u4e00\u9875">\u4e0b\u4e00\u9875</button>';
  const prev = pager.querySelector(".pager-prev");
  const next = pager.querySelector(".pager-next");
  if (prev) prev.onclick = function () {
    if (current > 1) onPage(current - 1);
  };
  if (next) next.onclick = function () {
    if (current < pages) onPage(current + 1);
  };
}

function scrollListToTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
  const main = document.querySelector(".main");
  if (main) main.scrollTo({ top: 0, behavior: "smooth" });
}

function shouldScrollList(options) {
  return !options || options.scrollTop !== false;
}

const lastSyncAtByCompany = {};

function guardCompanyPayload(data) {
  if (!data || data.companyId == null) return true;
  if (!activeCompanyId) return true;
  return data.companyId === activeCompanyId;
}

// 报表导出（MONTHLY REPORT 下各页共用）。matrix 是字符串二维数组，第一行为表头。
// 值应为不带千分位的原始数字，否则粘到 Google Sheet 后被当成文本。
async function copyTableMatrix(matrix) {
  const tsv = matrix.map(function (r) { return r.join("\t"); }).join("\n");
  const ok = await writeClipboardText(tsv);
  showToast(ok ? "已复制，可直接粘贴到 Google Sheet" : "复制失败，请重试", { tone: ok ? "success" : "error" });
}

// navigator.clipboard 只在安全上下文（https / localhost）可用；直接用 http://<VPS IP> 打开
// 后台时它是 undefined，退回 execCommand。
async function writeClipboardText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {}
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) {}
  ta.remove();
  return ok;
}

function downloadTableCsv(matrix, filename) {
  const csv = matrix
    .map(function (r) {
      return r.map(function (v) { return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(",");
    })
    .join("\r\n");
  // BOM 让 Excel 按 UTF-8 打开。
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function startSyncWatcher(reloadFn) {
  if (typeof reloadFn !== "function") return;
  setInterval(function () {
    if (document.hidden || !activeCompanyId) return;
    api("/api/data/sync-status", { bg: true })
      .then(function (s) {
        if (!s || s.companyId !== activeCompanyId) return;
        const at = s.at || "";
        const prev = lastSyncAtByCompany[activeCompanyId];
        if (prev && at && prev !== at) reloadFn();
        if (at) lastSyncAtByCompany[activeCompanyId] = at;
      })
      .catch(function () {});
  }, 8000);
}

function bindCompanySwitch(reloadFn) {
  if (typeof reloadFn !== "function") return;
  window.addEventListener("company-changed", () => {
    if (typeof clearTodayLeaderboard === "function") clearTodayLeaderboard();
    setPageLoading(true);
    Promise.resolve(reloadFn())
      .catch((e) => {
        if (!e || !e.cancelled) console.error("reload failed", e);
      })
      .finally(() => setPageLoading(false));
  });
}

function setActiveNav(page) {
  document.querySelectorAll(".sidebar nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.page === page);
  });
}

function updateMobileTabbarBadge(n) {
  const badge = document.getElementById("mobile-tabbar-badge");
  if (!badge) return;
  badge.hidden = n <= 0;
  badge.textContent = n > 99 ? "99+" : String(n);
}

// 底部标签栏：支付渠道页注册了 window.bankMobileTab，就地执行；其他页面不拦，
// <a href="/bank-accounts.html#动作"> 照常跳过去，由那边读 hash 执行。
function setupMobileTabbar() {
  const bar = document.getElementById("mobile-tabbar");
  if (!bar) return;
  bar.addEventListener("click", function (e) {
    const el = e.target.closest("[data-tab-action]");
    if (!el) return;
    const action = el.dataset.tabAction;
    if (action === "menu") {
      e.preventDefault();
      const menuBtn = document.getElementById("mobile-menu-btn");
      if (menuBtn) menuBtn.click();
      return;
    }
    if (typeof window.bankMobileTab === "function") {
      e.preventDefault();
      window.bankMobileTab(action);
    }
  });
}

function updateBankPendingBadge(total) {
  const n = Number(total || 0);
  updateMobileTabbarBadge(n);
  const link = document.querySelector('.sidebar nav a[data-page="bank-accounts"]');
  if (!link) return;
  let badge = link.querySelector(".nav-pending-badge");
  if (n <= 0) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "nav-pending-badge";
    link.appendChild(badge);
  }
  badge.textContent = String(n);
  // The badge is rebuilt whenever the count appears, so the escalation state has
  // to be re-applied or it would be lost on the next poll.
  setPendingBadgeUrgent(platformPendingAlarm ? platformPendingAlarm.stage() === "loud" : false);
}

// Unapproved platform transactions used to loop a siren until somebody clicked
// it away, and the acknowledgement lived in memory only -- so a refresh started
// the siren again. It now runs through the shared escalating alarm: silent for
// the first few minutes, then one play, repeating on a slow cadence.
let platformPendingAlarm = null;

function setPendingBadgeUrgent(urgent) {
  const link = document.querySelector('.sidebar nav a[data-page="bank-accounts"]');
  const badge = link && link.querySelector(".nav-pending-badge");
  if (badge) badge.classList.toggle("nav-pending-badge--urgent", !!urgent);
}

function getPlatformPendingAlarm() {
  if (platformPendingAlarm) return platformPendingAlarm;
  if (typeof window.createEscalatingAlarm !== "function") return null;
  platformPendingAlarm = window.createEscalatingAlarm({
    soundSrc: "/sounds/platform-pending.mp3",
    keyPrefix: "bank-pending-alarm",
    scope: function () { return activeCompanyId || "__current__"; },
    onStageChange: function (stage) { setPendingBadgeUrgent(stage === "loud"); },
  });
  return platformPendingAlarm;
}

function acknowledgePlatformPendingSound() {
  const alarm = getPlatformPendingAlarm();
  if (alarm) alarm.acknowledge();
}

window.acknowledgePlatformPendingSound = acknowledgePlatformPendingSound;

function updatePlatformPendingSound(platformCount) {
  const alarm = getPlatformPendingAlarm();
  if (!alarm) return;
  // The signature deliberately leaves the count out: clearing 2 of 3 items must
  // not restart the quiet window, while going 0 -> 1 must.
  alarm.update(Number(platformCount || 0) > 0 ? "pending" : "");
}

window.updatePlatformPendingSound = updatePlatformPendingSound;

function startBankPendingWatcher() {
  const poll = function () {
    api("/api/banks/pending-counts", { bg: true })
      .then(function (d) {
        const platformCount = Number((d && d.pending_tx) || 0);
        const total = Number((d && d.total) || 0);
        updateBankPendingBadge(total);
        updatePlatformPendingSound(platformCount);
      })
      .catch(function () {});
  };
  poll();
  setInterval(poll, 8000);
  window.addEventListener("company-changed", function () {
    // Each company keeps its own timeline in storage; just silence the current
    // playback and let the next poll re-evaluate under the new scope.
    const alarm = getPlatformPendingAlarm();
    if (alarm) alarm.stop();
    poll();
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", function () {
    startBankPendingWatcher();
    setupMobileTabbar();
  });
}

function todaySydney() {
  // en-CA is not a language choice: it is how we get an ISO YYYY-MM-DD key for
  // API params and <input type="date"> values. Do NOT route this through
  // dateLocale() -- localising it breaks every date filter.
  return new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
}

function todayKey() {
  return todaySydney();
}

function fmtMoney(n) {
  if (n == null || n === "") return "-";
  return "$" + Number(n).toFixed(2);
}

function fmtExtraCount(n) {
  return Number(n || 0) > 0 ? n : "0";
}

function fmtExtraTotalCell(n, cls) {
  const v = Number(n || 0);
  if (v <= 0) return '<td class="extra-total ' + cls + '">$0.00</td>';
  return '<td class="extra-total ' + cls + '">' + fmtMoney(v) + "</td>";
}

function renderExtraCells(r) {
  return (
    '<td class="extra-count">' +
    fmtExtraCount(r.bonus_count) +
    "</td>" +
    fmtExtraTotalCell(r.bonus_total, "amt-bonus") +
    '<td class="extra-count">' +
    fmtExtraCount(r.manual_count) +
    "</td>" +
    fmtExtraTotalCell(r.manual_total, "amt-manual") +
    '<td class="extra-count">' +
    fmtExtraCount(r.commission_count) +
    "</td>" +
    fmtExtraTotalCell(r.commission_total, "amt-commission")
  );
}

function fmtDate(s) {
  if (!s) return "-";
  const raw = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw.replace("T", " ").slice(0, 16);
  return d.toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function startAutoReload(fn, seconds) {
  if (!fn) return;
  const ms = Math.max(5, Number(seconds || 10)) * 1000;
  setInterval(() => {
    if (!document.hidden) fn();
  }, ms);
}


function animateValue(el, to, opts) {
  if (!el) return;
  opts = opts || {};
  var dur = opts.duration || 550;
  var decimals = opts.decimals || 0;
  var prefix = opts.prefix || "";
  var suffix = opts.suffix || "";
  to = Number(to || 0);
  var from = el.hasAttribute("data-val") ? Number(el.getAttribute("data-val")) : 0;
  el.setAttribute("data-val", to);
  function fmt(v) { return prefix + v.toFixed(decimals) + suffix; }
  if (from === to || document.hidden) {
    el.textContent = fmt(to);
    return;
  }
  var start = performance.now();
  function frame(now) {
    var p = Math.min(1, (now - start) / dur);
    p = 1 - Math.pow(1 - p, 3);
    if (Number(el.getAttribute("data-val")) !== to) return; // superseded
    el.textContent = fmt(from + (to - from) * p);
    if (p < 1) requestAnimationFrame(frame);
    else el.textContent = fmt(to);
  }
  requestAnimationFrame(frame);
}

function applyTheme(theme) {
  const normalizedTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", normalizedTheme);
  try { localStorage.setItem("dash-theme", normalizedTheme); } catch (e) {}
  var btn = document.getElementById("theme-toggle");
  if (btn) {
    var icon = theme === "dark" ? "sun" : "moon";
    var label = theme === "dark" ? "\u5207\u6362\u5230\u65e5\u95f4\u6a21\u5f0f" : "\u5207\u6362\u5230\u591c\u95f4\u6a21\u5f0f";
    btn.innerHTML = '<i data-lucide="' + icon + '"></i>';
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
    renderIcons(btn);
  }
  window.dispatchEvent(new CustomEvent("theme-changed", { detail: { theme: normalizedTheme } }));
}

function currentTheme() {
  try { return localStorage.getItem("dash-theme") === "dark" ? "dark" : "light"; } catch (e) { return "light"; }
}

function setupTheme() {
  applyTheme(currentTheme());
  var btn = document.getElementById("theme-toggle");
  if (!btn) return;
  btn.addEventListener("click", function () {
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
  });
}

function renderIcon(name, options) {
  options = options || {};
  var size = Number(options.size || 18);
  var label = options.label ? ' aria-label="' + escHtml(options.label) + '"' : ' aria-hidden="true"';
  return '<i data-lucide="' + escHtml(name) + '" width="' + size + '" height="' + size + '"' + label + "></i>";
}

function renderIcons(root) {
  if (!window.lucide || typeof window.lucide.createIcons !== "function") {
    document.documentElement.classList.remove("lucide-ready");
    return;
  }
  try {
    window.lucide.createIcons({
      attrs: {
        "stroke-width": 1.8,
        "aria-hidden": "true",
      },
      nameAttr: "data-lucide",
    });
    document.documentElement.classList.add("lucide-ready");
  } catch (e) {
    document.documentElement.classList.remove("lucide-ready");
    console.warn("lucide render failed", e.message);
  }
}

function setupGlassMotion() {
  var reduce = false;
  try {
    reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) {}
  document.documentElement.classList.toggle("reduced-motion", Boolean(reduce));
  if (reduce || !window.gsap) return;
  try {
    window.gsap.defaults({ overwrite: "auto" });
    if (window.innerWidth > 768) {
      window.gsap.fromTo(".sidebar", { autoAlpha: 0, x: -10 }, {
        autoAlpha: 1,
        x: 0,
        duration: 0.34,
        ease: "expo.out",
        clearProps: "transform,opacity,visibility",
      });
    }
    window.gsap.fromTo([".topbar", ".page-shell"], { autoAlpha: 0, y: 8 }, {
      autoAlpha: 1,
      y: 0,
      duration: 0.34,
      stagger: 0.035,
      ease: "expo.out",
      clearProps: "transform,opacity,visibility",
    });
    window.gsap.fromTo(".card, .metric-card, .hero-core, .insight-link, .week-day", {
      autoAlpha: 0,
      y: 10,
      scale: 0.992
    }, {
      autoAlpha: 1,
      y: 0,
      scale: 1,
      duration: 0.34,
      stagger: { each: 0.025, from: "start", grid: "auto" },
      ease: "expo.out",
      clearProps: "transform,opacity,visibility"
    });

    const animated = new WeakSet();
    const activeTween = new WeakMap();
    const animateOverlay = function (overlay) {
      if (!overlay.classList.contains("show") || animated.has(overlay)) return;
      animated.add(overlay);
      const panel = overlay.querySelector(".modal, .customer-drawer");
      if (!panel) return;
      const isDrawer = panel.classList.contains("customer-drawer");
      const previous = activeTween.get(panel);
      if (previous && previous.kill) previous.kill();
      window.gsap.set(overlay, { autoAlpha: 1 });
      activeTween.set(panel, window.gsap.fromTo(panel, {
        autoAlpha: 0,
        x: isDrawer ? 28 : 0,
        y: isDrawer ? 0 : 18,
        scale: isDrawer ? 1 : 0.975
      }, {
        autoAlpha: 1,
        x: 0,
        y: 0,
        scale: 1,
        duration: isDrawer ? 0.28 : 0.26,
        ease: "expo.out",
        clearProps: "transform,opacity,visibility",
        onComplete: function () {
          activeTween.delete(panel);
        }
      }));
    };
    const animateOverlayExit = function (overlay) {
      const panel = overlay.querySelector(".modal, .customer-drawer");
      if (!panel) return;
      window.gsap.fromTo(panel, {
        autoAlpha: 1
      }, {
        autoAlpha: 0.96,
        duration: 0.12,
        ease: "power1.out",
        clearProps: "opacity,visibility"
      });
    };
    const observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        const overlay = mutation.target;
        if (!overlay.classList.contains("show")) {
          animated.delete(overlay);
          animateOverlayExit(overlay);
        } else {
          animateOverlay(overlay);
        }
      });
    });
    document.querySelectorAll(".modal-overlay, .customer-drawer-backdrop").forEach(function (overlay) {
      observer.observe(overlay, { attributes: true, attributeFilter: ["class"] });
    });
  } catch (e) {
    console.warn("glass motion failed", e.message);
  }
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = "dash-sidebar-collapsed";

function getDesktopSidebarCollapsed() {
  try {
    const saved = localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
    return saved === null ? true : saved === "1";
  } catch (e) {
    return true;
  }
}

function setDesktopSidebarCollapsed(collapsed, persist) {
  if (window.innerWidth <= 768) return;
  const value = Boolean(collapsed);
  document.documentElement.setAttribute("data-sidebar", value ? "collapsed" : "expanded");
  const btn = document.getElementById("sidebar-collapse-btn");
  if (btn) {
    const label = value ? "展开导航" : "收起导航";
    btn.setAttribute("aria-expanded", value ? "false" : "true");
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
    btn.setAttribute("data-sidebar-state", value ? "collapsed" : "expanded");
  }
  if (persist) {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, value ? "1" : "0");
    } catch (e) {}
  }
}

function setupSidebarTooltips() {
  document.querySelectorAll(".nav-stack a").forEach(function (link) {
    const label = (link.querySelector(":scope > span") || link).textContent.trim();
    if (label && !link.title) link.title = label;
  });
  document.querySelectorAll(".nav-group > summary").forEach(function (summary) {
    const label = summary.querySelector(".nav-summary-label > span");
    if (label && !summary.title) summary.title = label.textContent.trim();
  });
}

function setupDesktopSidebar() {
  const sidebar = document.getElementById("sidebar");
  const toggle = document.getElementById("sidebar-collapse-btn");
  if (!sidebar || !toggle) return;

  function applyStoredState() {
    if (window.innerWidth > 768) setDesktopSidebarCollapsed(getDesktopSidebarCollapsed(), false);
  }

  applyStoredState();
  setupSidebarTooltips();
  toggle.addEventListener("click", function () {
    const collapsed = document.documentElement.getAttribute("data-sidebar") === "collapsed";
    setDesktopSidebarCollapsed(!collapsed, true);
  });

  const compactCompany = document.getElementById("company-compact-btn");
  if (compactCompany) {
    compactCompany.addEventListener("click", function () {
      setDesktopSidebarCollapsed(false, true);
      window.setTimeout(function () {
        const select = document.getElementById("company-select");
        if (select && !select.disabled) select.focus();
      }, 220);
    });
  }

  window.addEventListener("resize", applyStoredState);
}

function setupMobileNav() {
  const btn = document.getElementById("mobile-menu-btn");
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebar-backdrop");
  if (!btn || !sidebar) return;
  let returnFocus = null;
  const focusableSelector = 'a[href], button:not([disabled]), summary, select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function closeSidebar() {
    sidebar.classList.remove("open");
    if (backdrop) backdrop.classList.remove("show");
    document.body.style.overflow = "";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "\u6253\u5f00\u5bfc\u822a");
    btn.classList.remove("is-open");
    if (returnFocus && window.innerWidth <= 768) returnFocus.focus();
  }
  function openSidebar() {
    returnFocus = document.activeElement;
    sidebar.classList.add("open");
    if (backdrop) backdrop.classList.add("show");
    document.body.style.overflow = "hidden";
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-label", "\u5173\u95ed\u5bfc\u822a");
    btn.classList.add("is-open");
    const first = sidebar.querySelector(focusableSelector);
    if (first) {
      window.setTimeout(function () {
        if (sidebar.classList.contains("open")) first.focus();
      }, 60);
    }
  }
  btn.addEventListener("click", function () {
    if (sidebar.classList.contains("open")) closeSidebar();
    else openSidebar();
  });
  if (backdrop) backdrop.addEventListener("click", closeSidebar);
  sidebar.querySelectorAll("nav a").forEach(function (a) {
    a.addEventListener("click", closeSidebar);
  });
  window.addEventListener("resize", function () {
    if (window.innerWidth > 768) closeSidebar();
  });
  document.addEventListener("keydown", function (event) {
    if (!sidebar.classList.contains("open")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeSidebar();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(sidebar.querySelectorAll(focusableSelector)).filter(function (el) {
      return !el.hidden && el.offsetParent !== null;
    });
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

const appModalState = {
  registered: new WeakSet(),
  wasOpen: new WeakMap(),
  openedAt: new WeakMap(),
  lastFocus: new WeakMap(),
  pointerStartedOnBackdrop: new WeakMap(),
  sequence: 0,
  domObserver: null,
};

const appModalFocusableSelector =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let activeAppDialog = null;

function appUiLabel(zh, en) {
  // currentLang lives in i18n.js; degrade to Chinese if that script failed to load.
  return (typeof currentLang === "function" ? currentLang() : "zh") === "en" ? en : zh;
}

function ensureGlobalFeedbackUi() {
  if (!document.body) return null;
  if (!document.getElementById("app-toast-stack")) {
    const stack = document.createElement("div");
    stack.id = "app-toast-stack";
    stack.className = "app-toast-stack";
    stack.setAttribute("aria-live", "polite");
    stack.setAttribute("aria-relevant", "additions");
    document.body.appendChild(stack);
  }
  if (!document.getElementById("app-dialog-overlay")) {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div class="modal-overlay app-dialog-overlay" id="app-dialog-overlay" aria-hidden="true">' +
        '<div class="modal app-dialog" data-tone="info">' +
          '<h2 id="app-dialog-title">' + appUiLabel("确认操作", "Confirm action") + "</h2>" +
          '<p class="app-dialog-message" id="app-dialog-message"></p>' +
          '<div class="app-dialog-prompt" id="app-dialog-prompt" hidden>' +
            '<label for="app-dialog-input" id="app-dialog-label">' + appUiLabel("请输入", "Enter a value") + "</label>" +
            '<input id="app-dialog-input" autocomplete="off">' +
            '<small class="form-hint" id="app-dialog-hint"></small>' +
          "</div>" +
          '<p class="form-error" id="app-dialog-error" role="alert" aria-live="polite"></p>' +
          '<div class="actions">' +
            '<button class="btn btn-outline btn-sm" id="app-dialog-cancel" type="button" data-modal-dismiss>' + appUiLabel("取消", "Cancel") + "</button>" +
            '<button class="btn btn-primary btn-sm" id="app-dialog-confirm" type="button">' + appUiLabel("确认", "Confirm") + "</button>" +
          "</div>" +
        "</div>" +
      "</div>"
    );
  }
  const overlay = document.getElementById("app-dialog-overlay");
  if (overlay.dataset.feedbackBound !== "1") {
    overlay.dataset.feedbackBound = "1";
    const cancel = document.getElementById("app-dialog-cancel");
    const confirm = document.getElementById("app-dialog-confirm");
    cancel.addEventListener("click", function () {
      if (!activeAppDialog) return;
      settleAppDialog(activeAppDialog.kind === "prompt" ? null : false);
    });
    confirm.addEventListener("click", function () {
      if (!activeAppDialog) return;
      if (activeAppDialog.kind === "confirm") {
        settleAppDialog(true);
        return;
      }
      const input = document.getElementById("app-dialog-input");
      const error = document.getElementById("app-dialog-error");
      const value = String(input.value || "");
      if (activeAppDialog.options.required && !value.trim()) {
        error.textContent = activeAppDialog.options.requiredMessage || appUiLabel("请填写此项", "This field is required");
        input.focus();
        return;
      }
      settleAppDialog(value);
    });
    document.getElementById("app-dialog-input").addEventListener("input", function () {
      document.getElementById("app-dialog-error").textContent = "";
    });
    document.getElementById("app-dialog-input").addEventListener("keydown", function (event) {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      confirm.click();
    });
    registerModalOverlay(overlay);
  }
  return {
    toastStack: document.getElementById("app-toast-stack"),
    dialogOverlay: document.getElementById("app-dialog-overlay"),
  };
}

function removeAppToast(toast) {
  if (!toast || toast.dataset.removing === "1") return;
  toast.dataset.removing = "1";
  toast.classList.add("is-leaving");
  window.setTimeout(function () {
    toast.remove();
  }, document.documentElement.classList.contains("reduced-motion") ? 0 : 180);
}

function showToast(message, options) {
  options = options || {};
  const ui = ensureGlobalFeedbackUi();
  if (!ui) return function () {};
  const tone = ["success", "error", "warning", "info"].includes(options.tone) ? options.tone : "info";
  const toast = document.createElement("div");
  toast.className = "app-toast";
  toast.dataset.tone = tone;
  toast.setAttribute("role", tone === "error" ? "alert" : "status");

  const icon = document.createElement("span");
  icon.className = "app-toast-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = renderIcon(
    tone === "success" ? "circle-check" : tone === "error" ? "circle-alert" : tone === "warning" ? "triangle-alert" : "info",
    { size: 18 }
  );
  const copy = document.createElement("div");
  copy.className = "app-toast-copy";
  if (options.title) {
    const title = document.createElement("strong");
    title.textContent = String(options.title);
    copy.appendChild(title);
  }
  const body = document.createElement("span");
  body.textContent = String(message == null ? "" : message);
  copy.appendChild(body);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "app-toast-close icon-btn";
  close.setAttribute("aria-label", appUiLabel("关闭通知", "Close notification"));
  close.innerHTML = renderIcon("x", { size: 17 }) + '<span class="icon-fallback" aria-hidden="true">×</span>';
  close.addEventListener("click", function () { removeAppToast(toast); });
  toast.append(icon, copy, close);
  ui.toastStack.appendChild(toast);
  renderIcons(toast);
  window.requestAnimationFrame(function () { toast.classList.add("is-visible"); });

  const defaultDuration = tone === "error" ? 7000 : tone === "warning" ? 6000 : 4000;
  const duration = options.duration == null ? defaultDuration : Number(options.duration);
  if (duration > 0) window.setTimeout(function () { removeAppToast(toast); }, duration);
  return function () { removeAppToast(toast); };
}

function settleAppDialog(value) {
  const state = activeAppDialog;
  if (!state) return;
  activeAppDialog = null;
  const overlay = document.getElementById("app-dialog-overlay");
  if (overlay) overlay.classList.remove("show");
  const input = document.getElementById("app-dialog-input");
  if (input) input.value = "";
  state.resolve(value);
}

function openAppDialog(kind, options) {
  options = options || {};
  const ui = ensureGlobalFeedbackUi();
  if (!ui) return Promise.resolve(kind === "prompt" ? null : false);
  if (activeAppDialog) settleAppDialog(activeAppDialog.kind === "prompt" ? null : false);

  const overlay = ui.dialogOverlay;
  const dialog = overlay.querySelector(".app-dialog");
  const title = document.getElementById("app-dialog-title");
  const message = document.getElementById("app-dialog-message");
  const promptWrap = document.getElementById("app-dialog-prompt");
  const label = document.getElementById("app-dialog-label");
  const input = document.getElementById("app-dialog-input");
  const hint = document.getElementById("app-dialog-hint");
  const error = document.getElementById("app-dialog-error");
  const cancel = document.getElementById("app-dialog-cancel");
  const confirm = document.getElementById("app-dialog-confirm");
  const tone = options.tone === "danger" ? "danger" : options.tone === "warning" ? "warning" : "info";

  dialog.dataset.tone = tone;
  title.textContent = options.title || (kind === "prompt" ? appUiLabel("请输入", "Enter a value") : appUiLabel("确认操作", "Confirm action"));
  message.textContent = options.message || "";
  message.hidden = !options.message;
  error.textContent = "";
  promptWrap.hidden = kind !== "prompt";
  cancel.textContent = options.cancelLabel || appUiLabel("取消", "Cancel");
  confirm.textContent = options.confirmLabel || appUiLabel("确认", "Confirm");
  confirm.className = "btn btn-sm " + (tone === "danger" ? "btn-danger" : "btn-primary");
  cancel.toggleAttribute("data-modal-initial-focus", kind === "confirm");
  input.toggleAttribute("data-modal-initial-focus", kind === "prompt");

  if (kind === "prompt") {
    label.textContent = options.label || appUiLabel("请输入", "Enter a value");
    input.type = options.inputType === "password" ? "password" : "text";
    input.value = options.defaultValue == null ? "" : String(options.defaultValue);
    input.placeholder = options.placeholder || "";
    input.required = Boolean(options.required);
    input.maxLength = Number(options.maxLength || 500);
    input.autocomplete = options.autocomplete || (input.type === "password" ? "new-password" : "off");
    hint.textContent = options.hint || "";
    hint.hidden = !options.hint;
  }

  return new Promise(function (resolve) {
    activeAppDialog = { kind: kind, options: options, resolve: resolve };
    overlay.classList.add("show");
  });
}

function showConfirmDialog(options) {
  if (typeof options === "string") options = { message: options };
  return openAppDialog("confirm", options);
}

function showPromptDialog(options) {
  if (typeof options === "string") options = { message: options };
  return openAppDialog("prompt", options);
}

window.showToast = showToast;
window.showConfirmDialog = showConfirmDialog;
window.showPromptDialog = showPromptDialog;

// 支付渠道生命周期判定。后端真源在 server/lib/bankLifecycle.js，这里是镜像——两边的
// 状态字面量由 server/tests/bank-lifecycle.test.js 做静态断言守着，别单边改。
//
// 三态：active（运营中）→ banned（封禁中 / 待清理）→ archived（已归档，终态）。
// 空值按 schema 默认归 active；枚举外的任何值归 archived（失败关闭）——绝不能让一个
// 来历不明的状态被当成可以收钱、进合计的账户。
window.BankLifecycle = Object.freeze({
  LIFECYCLE: Object.freeze({ ACTIVE: "active", BANNED: "banned", ARCHIVED: "archived" }),
  statusOf: function (account) {
    if (!account) return "archived";
    var raw = String(account.lifecycle_status == null ? "" : account.lifecycle_status).trim();
    if (!raw) return "active";
    return (raw === "active" || raw === "banned" || raw === "archived") ? raw : "archived";
  },
  isOperating: function (account) { return window.BankLifecycle.statusOf(account) === "active"; },
  isBanned: function (account) { return window.BankLifecycle.statusOf(account) === "banned"; },
  isArchived: function (account) { return window.BankLifecycle.statusOf(account) === "archived"; },
  isUsableForEntry: function (account) { return window.BankLifecycle.isOperating(account); },
  // 与后端 bankReport 的汇总口径同源：PG 的钱不是自有资金，不计合计。
  isCountedInTotals: function (account) {
    if (!window.BankLifecycle.isOperating(account)) return false;
    return String(account.account_kind || "nominee") !== "payment_gateway";
  },
});

function getOpenModalOverlays() {
  return Array.from(document.querySelectorAll(".modal-overlay.show"))
    .filter(function (overlay) { return overlay.querySelector(".modal"); })
    .sort(function (a, b) {
      return Number(appModalState.openedAt.get(a) || 0) - Number(appModalState.openedAt.get(b) || 0);
    });
}

function getTopModalOverlay() {
  const overlays = getOpenModalOverlays();
  return overlays.length ? overlays[overlays.length - 1] : null;
}

function updateModalStack() {
  const overlays = getOpenModalOverlays();
  overlays.forEach(function (overlay, index) {
    overlay.style.zIndex = "calc(var(--z-modal) + " + index * 2 + ")";
    overlay.setAttribute("aria-hidden", index === overlays.length - 1 ? "false" : "true");
  });
  document.body.classList.toggle("modal-open", overlays.length > 0);
}

function preferredModalFocus(dialog) {
  return dialog.querySelector("[data-modal-initial-focus]:not([disabled])") ||
    dialog.querySelector('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]):not(.modal-close), a[href], [tabindex]:not([tabindex="-1"])');
}

function syncModalOverlay(overlay) {
  const open = overlay.classList.contains("show");
  const wasOpen = Boolean(appModalState.wasOpen.get(overlay));
  const dialog = overlay.querySelector(".modal");
  appModalState.wasOpen.set(overlay, open);
  if (open && !wasOpen) {
    appModalState.lastFocus.set(overlay, document.activeElement);
    appModalState.openedAt.set(overlay, ++appModalState.sequence);
    updateModalStack();
    window.setTimeout(function () {
      if (getTopModalOverlay() !== overlay) return;
      const target = preferredModalFocus(dialog);
      if (target) target.focus();
      else {
        dialog.tabIndex = -1;
        dialog.focus();
      }
    }, 60);
    return;
  }
  if (!open && wasOpen) {
    overlay.style.zIndex = "";
    overlay.setAttribute("aria-hidden", "true");
    updateModalStack();
    const previous = appModalState.lastFocus.get(overlay);
    if (previous && previous.isConnected) window.setTimeout(function () { previous.focus(); }, 0);
  }
}

function requestModalDismiss(overlay) {
  if (!overlay || getTopModalOverlay() !== overlay) return false;
  if (
    overlay.getAttribute("aria-busy") === "true" ||
    overlay.dataset.modalBusy === "true" ||
    overlay.querySelector('[aria-busy="true"]')
  ) return false;
  const dialog = overlay.querySelector(".modal");
  const dismissControl = Array.from(
    dialog.querySelectorAll('[data-modal-dismiss], [id*="cancel"], [id*="close"], [data-action="close"]')
  ).find(function (control) {
    return !control.classList.contains("modal-close") && !control.disabled;
  });
  if (dismissControl) dismissControl.click();
  else overlay.classList.remove("show");
  return true;
}

function registerModalOverlay(overlay) {
  if (!overlay || appModalState.registered.has(overlay)) return;
  const dialog = overlay.querySelector(".modal");
  if (!dialog) return;
  appModalState.registered.add(overlay);
  appModalState.wasOpen.set(overlay, false);
  if (overlay.getAttribute("role") === "dialog") {
    overlay.removeAttribute("role");
    overlay.removeAttribute("aria-modal");
    overlay.removeAttribute("aria-labelledby");
  }
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const heading = dialog.querySelector("h1, h2");
  if (heading) {
    if (!heading.id) heading.id = (overlay.id || "modal") + "-title";
    dialog.setAttribute("aria-labelledby", heading.id);
  }
  dialog.querySelectorAll('[id$="-err"], .form-error').forEach(function (error) {
    error.setAttribute("role", "alert");
    error.setAttribute("aria-live", "polite");
  });
  if (!dialog.querySelector(":scope > .modal-close")) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "modal-close icon-btn";
    close.setAttribute("aria-label", appUiLabel("关闭弹窗", "Close dialog"));
    close.setAttribute("title", appUiLabel("关闭", "Close"));
    close.innerHTML = renderIcon("x", { size: 19 }) + '<span class="icon-fallback" aria-hidden="true">×</span>';
    close.addEventListener("click", function () { requestModalDismiss(overlay); });
    dialog.prepend(close);
    dialog.classList.add("has-modal-close");
    renderIcons(close);
  }
  overlay.setAttribute("aria-hidden", overlay.classList.contains("show") ? "false" : "true");
  overlay.addEventListener("pointerdown", function (event) {
    appModalState.pointerStartedOnBackdrop.set(overlay, event.target === overlay);
  });
  overlay.addEventListener("click", function (event) {
    const startedOnBackdrop = Boolean(appModalState.pointerStartedOnBackdrop.get(overlay));
    appModalState.pointerStartedOnBackdrop.set(overlay, false);
    if (!startedOnBackdrop || event.target !== overlay || getTopModalOverlay() !== overlay) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    requestModalDismiss(overlay);
  });
  const observer = new MutationObserver(function () { syncModalOverlay(overlay); });
  observer.observe(overlay, { attributes: true, attributeFilter: ["class"] });
  syncModalOverlay(overlay);
}

function setupModalAccessibility() {
  ensureGlobalFeedbackUi();
  document.querySelectorAll(".modal-overlay").forEach(registerModalOverlay);
  if (!appModalState.domObserver) {
    appModalState.domObserver = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (!(node instanceof Element)) return;
          if (node.matches(".modal-overlay")) registerModalOverlay(node);
          node.querySelectorAll(".modal-overlay").forEach(registerModalOverlay);
        });
      });
    });
    appModalState.domObserver.observe(document.body, { childList: true, subtree: true });
  }

  window.addEventListener("language-changed", function () {
    document.querySelectorAll(".modal-close").forEach(function (button) {
      button.setAttribute("aria-label", appUiLabel("关闭弹窗", "Close dialog"));
      button.setAttribute("title", appUiLabel("关闭", "Close"));
    });
    document.querySelectorAll(".app-toast-close").forEach(function (button) {
      button.setAttribute("aria-label", appUiLabel("关闭通知", "Close notification"));
    });
  });

  document.addEventListener("keydown", function (event) {
    const overlay = getTopModalOverlay();
    if (!overlay) return;
    const dialog = overlay.querySelector(".modal");
    if (!dialog) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      requestModalDismiss(overlay);
      return;
    }
    if (event.key !== "Tab") return;
    event.stopImmediatePropagation();
    const focusable = Array.from(dialog.querySelectorAll(appModalFocusableSelector)).filter(function (el) {
      return el.offsetParent !== null;
    });
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (!dialog.contains(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, true);
}

// Apply saved theme as early as possible to minimize flash.
try {
  document.documentElement.setAttribute(
    "data-theme",
    localStorage.getItem("dash-theme") === "dark" ? "dark" : "light"
  );
  document.documentElement.setAttribute(
    "data-lang",
    localStorage.getItem("dash-lang") === "en" ? "en" : "zh"
  );
  document.documentElement.setAttribute(
    "data-sidebar",
    localStorage.getItem("dash-sidebar-collapsed") === "0" ? "expanded" : "collapsed"
  );
} catch (e) {}

document.addEventListener("DOMContentLoaded", () => {
  if (!window.location.pathname.includes("login")) {
    loadUser().then(function (user) {
      if (user) startGlobalSyncWatcher();
    });
    setupLogout();
    setupDesktopSidebar();
    setupMobileNav();
    setupModalAccessibility();
    setupLanguage();
    setupTheme();
    renderIcons();
    setupGlassMotion();
  }
});
