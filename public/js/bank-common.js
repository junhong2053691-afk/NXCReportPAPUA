// 当日流水（bank-ledger.js）与支付渠道（bank-channels.js）两页共用的格式化与口径。
// 2026-11 拆页时从 bank-accounts.js 抽出来，函数体原样搬运。
//
// 只提供函数，不持有页面数据：bankRows / dailyReport 由各页自己保存、调用时传进来。
// 唯一的模块内状态是 STATUS 词表——它是全公司配置（「支付设置」页可改），每次页面加载
// 由 loadStatusOptions() 填一次，两页语义相同。
(function () {
  "use strict";

  const LC = window.BankLifecycle;
  const KIND_LABEL = { nominee: "人头", ghost: "幽灵", payment_gateway: "PaymentGateway" };

  function tr(s) {
    return typeof window.dashT === "function" ? window.dashT(s) : s;
  }
  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function plainDisplayText(value) {
    const template = document.createElement("template");
    template.innerHTML = String(value == null ? "" : value);
    return (template.content.textContent || "").trim();
  }
  function ledgerNameText(value) {
    const text = typeof cleanDisplayName === "function"
      ? cleanDisplayName(value)
      : plainDisplayText(value);
    return text
      .replace(/\s*[（(][\s\S]*[）)]\s*$/, "")
      .trim();
  }
  function fmt(n) {
    return window.moneyText(n); // 不出 -0.00（display-format.js）
  }
  function fmtMetric(n) {
    const v = Number(n || 0);
    return Number.isInteger(v) ? String(v) : fmt(v);
  }
  function parseNum(v) {
    if (v === "" || v == null) return 0;
    const n = parseFloat(String(v).replace(/,/g, ""));
    return Number.isFinite(n) ? Math.abs(n) : 0;
  }

  // ---- STATUS 词表 ----------------------------------------------------------
  let STATUS_LIST = [
    { n: 0, value: "redeposit", label: "0. REDEP" },
    { n: 1, value: "deposit", label: "1. DEPOSIT" },
    { n: 2, value: "withdraw", label: "2. WITHDRAW" },
    { n: 3, value: "wrong", label: "3. WRONG" },
    { n: 4, value: "cash in", label: "4. CASH IN" },
    { n: 5, value: "cash out", label: "5. CASH OUT" },
    { n: 6, value: "give back", label: "6. GIVE BACK" },
    { n: 7, value: "expenses", label: "7. EXPENSES" },
    { n: 8, value: "exchange", label: "8. EXCHANGE" },
    { n: 9, value: "new", label: "9. NEW" },
    { value: "bank trf", label: "BANK TRF" },
    { value: "bank transfer", label: "BANK TRANSFER" },
    { value: "unclaim", label: "UNCLAIM" },
    { value: "amopay", label: "AMOPAY" },
    { value: "test in", label: "TEST IN" },
    { value: "test out", label: "TEST OUT" },
  ];
  let STATUS_BY_NUM = Object.fromEntries(STATUS_LIST.filter((s) => s.n != null).map((s) => [s.n, s.value]));
  let STATUS_BY_LABEL = Object.fromEntries(STATUS_LIST.map((s) => [s.label.toUpperCase(), s.value]));
  let STATUS_LABEL = Object.fromEntries(STATUS_LIST.map((s) => [s.value, s.label]));
  const STATUS_COLORS = {
    redeposit: { accent: "#ca8a04", tint: "rgba(202,138,4,.12)", text: "#713f12" },
    deposit: { accent: "#10b981", tint: "rgba(16,185,129,.13)", text: "#065f46" },
    withdraw: { accent: "#e11d48", tint: "rgba(225,29,72,.12)", text: "#991b1b" },
    wrong: { accent: "#f59e0b", tint: "rgba(245,158,11,.14)", text: "#92400e" },
    "cash in": { accent: "#2563eb", tint: "rgba(37,99,235,.12)", text: "#1e40af" },
    "cash out": { accent: "#f43f5e", tint: "rgba(244,63,94,.12)", text: "#9f1239" },
    "give back": { accent: "#7c3aed", tint: "rgba(124,58,237,.12)", text: "#5b21b6" },
    expenses: { accent: "#64748b", tint: "rgba(100,116,139,.12)", text: "#475569" },
    exchange: { accent: "#0ea5e9", tint: "rgba(14,165,233,.12)", text: "#0369a1" },
    new: { accent: "#22c55e", tint: "rgba(34,197,94,.13)", text: "#166534" },
    "bank trf": { accent: "#06b6d4", tint: "rgba(6,182,212,.13)", text: "#155e75" },
    "bank transfer": { accent: "#14b8a6", tint: "rgba(20,184,166,.13)", text: "#115e59" },
    unclaim: { accent: "#94a3b8", tint: "rgba(148,163,184,.14)", text: "#475569" },
    amopay: { accent: "#a855f7", tint: "rgba(168,85,247,.12)", text: "#6b21a8" },
    "test in": { accent: "#059669", tint: "rgba(5,150,105,.12)", text: "#047857" },
    "test out": { accent: "#f97316", tint: "rgba(249,115,22,.13)", text: "#9a3412" },
  };
  function hexToRgba(hex, alpha) {
    const m = String(hex || "").trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return `rgba(100,116,139,${alpha})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  function rebuildStatusLookups() {
    STATUS_BY_NUM = Object.fromEntries(STATUS_LIST.filter((s) => s.n != null).map((s) => [s.n, s.value]));
    STATUS_BY_LABEL = Object.fromEntries(STATUS_LIST.map((s) => [String(s.label || "").toUpperCase(), s.value]));
    STATUS_LABEL = Object.fromEntries(STATUS_LIST.map((s) => [s.value, s.label]));
    STATUS_LIST.forEach((s) => {
      if (!s.color) return;
      STATUS_COLORS[s.value] = { accent: s.color, tint: hexToRgba(s.color, 0.13), text: s.color };
    });
  }
  function statusList() {
    return STATUS_LIST;
  }
  // 从 /api/banks/status-options 拉一次租户配置的词表；为空就沿用上面的默认表。
  function loadStatusOptions() {
    return api("/api/banks/status-options", { bg: true }).then((d) => {
      const rows = (d.options || []).filter((s) => Number(s.active) !== 0);
      if (!rows.length) return;
      STATUS_LIST = rows.map((s) => ({
        value: String(s.value || "").trim(),
        label: String(s.label || s.value || "").trim(),
        color: String(s.color || "").trim(),
      })).filter((s) => s.value && s.label);
      rebuildStatusLookups();
    });
  }
  function parseStatus(text) {
    const t = String(text || "").trim();
    if (!t) return "deposit";
    const numMatch = t.match(/^(\d+)(?:\.\s*|\s+)/);
    if (numMatch && STATUS_BY_NUM[Number(numMatch[1])] != null) return STATUS_BY_NUM[Number(numMatch[1])];
    const upper = t.toUpperCase();
    if (STATUS_BY_LABEL[upper]) return STATUS_BY_LABEL[upper];
    if (upper === "REDEP" || upper === "REDEPOSIT") return "redeposit";
    const byVal = STATUS_LIST.find((s) => s.value === t.toLowerCase());
    if (byVal) return byVal.value;
    const byPartial = STATUS_LIST.find((s) => upper.includes(s.label.replace(/^\d+\.\s*/, "").toUpperCase()));
    return byPartial ? byPartial.value : t.toLowerCase();
  }
  function statusLabel(status) {
    return STATUS_LABEL[status] || String(status || "").toUpperCase();
  }
  function statusClass(status) {
    // Every caller splices this into a class="..." attribute unescaped, so the
    // whitelist here is what keeps a stored status from closing the attribute.
    const s = String(status || "").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
    return "status-" + s;
  }
  // 只把租户配的【色相】交给 CSS（--ledger-status-accent 来自
  // bank_status_options.color，在「支付设置」页可改），底色/字色/色条
  // 一律由 style.css 的「状态色：单一真值来源」块派生：
  //     color: color-mix(in srgb, var(--st) 70%, var(--text) 30%)
  // --text 随主题翻转，所以暗色模式不再沿用浅色那套原始高饱和值。
  //
  // 这里【绝对不能再内联 background/color/!important】：内联 !important
  // 压过作者样式表里的一切，正是它让原先 146 行状态色 CSS 全部失效
  // （包括 56 行专门为暗色写的补丁，从未生效过）。
  function statusStyleAttr(status) {
    const c = STATUS_COLORS[parseStatus(status)];
    const accent = (c && c.accent) || "#64748b";
    return `--ledger-status-accent:${accent};`;
  }

  // ---- 渠道 ------------------------------------------------------------------
  function bankBranchOf(r) {
    if (!r) return "";
    const bb = String(r.bank_branch || "").trim();
    if (bb) return bb;
    const bank = String(r.bank || "").trim();
    const branch = String(r.branch || "").trim();
    return branch ? `${bank} ${branch}`.trim() : bank;
  }
  function tabLabel(r) {
    const head = (bankBranchOf(r) || "Bank").slice(0, 12);
    const sub = (r.account_name || r.payid || "").slice(0, 16);
    return sub ? `${head} (${sub})` : head;
  }
  function bankPickerLabel(b, index) {
    return `${index + 1}. ${tabLabel(b)}`;
  }
  // 能出现在录入下拉、渠道列表、编号与拖拽排序里的账户。封禁与归档都不在内。
  function usableBanks(rows) {
    return (rows || []).filter(LC.isOperating);
  }
  // 与后端 bankReport 的 total_balance 同源（isCountedInTotals）：封禁 / 归档 / PG 都不计。
  function isBalanceExcluded(b) {
    return !LC.isCountedInTotals(b);
  }
  function totalBalance(rows, report) {
    if (report?.totals?.total_balance != null) {
      return Number(report.totals.total_balance);
    }
    return (rows || []).reduce((s, r) => isBalanceExcluded(r) ? s : s + Number(r.balance || 0), 0);
  }
  // 页面显示口径（跟随每日归零），不是「户里还剩多少」——那个看 bank_accounts.balance。
  function bankDisplayBalance(b, report) {
    const stats = (report?.bankRows || []).find((r) => r.id === b.id);
    return Number(stats?.balance ?? b.balance ?? 0);
  }
  // 与后端 bankAlerts.js 的判定口径保持一致：阈值 > 0、运营中、余额 ≥ 阈值。
  // 这里只是给列表加个视觉提示，真正的报警判定在服务端。
  function alertThresholdReached(b, report) {
    const threshold = Number(b.alert_threshold || 0);
    if (!(threshold > 0)) return false;
    if (!LC.isOperating(b)) return false;
    return Math.round(bankDisplayBalance(b, report) * 100) >= Math.round(threshold * 100);
  }

  // 银行资料（BSB / ACCOUNT / PAYID）的展示与复制。当日流水的银行列表与支付渠道页共用。
  function bankInfoFields(b) {
    return [
      ["BSB", b?.bsb],
      ["ACCOUNT", b?.account_number],
      ["PAYID", b?.payid],
    ].filter(([, value]) => String(value ?? "").trim());
  }
  function bankCopyText(b) {
    const fields = bankInfoFields(b);
    return fields.length
      ? fields.map(([label, value]) => `${label} : ${String(value).trim()}`).join("\n")
      : "未填写银行资料";
  }
  function bankInfoHtml(b) {
    const fields = bankInfoFields(b);
    if (!fields.length) return '<div class="bk-bank-info bk-bank-info-empty">未填写银行资料</div>';
    return `<div class="bk-bank-info" title="点击复制完整银行资料">${fields.map(([label, value]) => {
      return `<span class="bk-bank-info-line"><span class="bk-bank-info-label">${label}</span><span class="bk-bank-info-value" translate="no">${esc(String(value).trim())}</span></span>`;
    }).join("")}</div>`;
  }
  function writeClipboard(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied ? Promise.resolve() : Promise.reject(new Error("copy failed"));
  }
  function copyBankInfo(bank) {
    if (!bank) return;
    writeClipboard(bankCopyText(bank))
      .then(() => showToast("已复制完整银行资料", { tone: "success" }))
      .catch(() => showToast("复制失败", { tone: "error" }));
  }

  function cStatusNames(options) {
    // is_self = 本公司自己的名字（别家怎么叫我），录入时不能填，服务端也会拒（见 bankApply.selfCStatusNames）。
    return (options || []).filter((o) => !Number(o.is_self)).map((o) => o.name);
  }

  window.BankCommon = {
    KIND_LABEL,
    tr, esc, plainDisplayText, ledgerNameText, fmt, fmtMetric, parseNum,
    statusList, loadStatusOptions, parseStatus, statusLabel, statusClass, statusStyleAttr,
    bankBranchOf, tabLabel, bankPickerLabel, usableBanks, isBalanceExcluded, totalBalance,
    bankDisplayBalance, cStatusNames, alertThresholdReached, bankInfoHtml, bankCopyText, copyBankInfo,
  };
})();
