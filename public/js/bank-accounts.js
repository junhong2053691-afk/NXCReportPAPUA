(function () {
  "use strict";

  // 渠道生命周期判定的唯一入口（镜像见 app.js 的 window.BankLifecycle，真源在
  // server/lib/bankLifecycle.js）。不要在本文件里再写 lifecycle_status 的字面量比较——
  // 改造前那些 `!== "banned"` 的反向白名单会把「已归档」当成可用账户。
  const LC = window.BankLifecycle;

  let bankRows = [];
  let ledgerRows = [];
  let cStatusOptions = [];
  let companyOptions = [];
  const ALL_BANKS = "all";
  let activeBankId = ALL_BANKS;
  // 手机上渠道列表默认折叠（CSS 只在 ≤700 认这个类）。放模块级是因为渠道栏每 5 秒
  // 随 refreshSharedWorkspace 整块重渲染，存在 DOM 上会被冲掉。
  let directoryOpen = false;
  // 手机上流水卡片默认只显示摘要，点开的那几张记在这里（同上，整块重渲染不能丢）。
  const openLedgerCards = new Set();
  const MOBILE_MQ = window.matchMedia ? window.matchMedia("(max-width: 700px)") : { matches: false };
  let sheetDate = "";
  let dailyReport = null;
  let saveLock = false;
  let transferSubmitting = false;
  let gridPickerInput = null;
  let gridPickerIndex = 0;
  let enterSaveCount = 0;
  let enterSaveRow = null;
  let enterSaveTimer = null;
  let editingBankId = null;
  let bankModalReturnToList = false;
  let lastPendingTotal = null;
  let editingRowId = null;
  let adding = false;
  let gridPointerFocus = false;
  let trfDirection = "";
  let bankReorderBusy = false;
  let draggedBankId = null;
  const RECONCILE_ALARM_SOUND = "/sounds/dragon-studio-alert-444816.mp3";
  let reconcileAlarm = null;
  let reconcileRendering = false;
  let workspaceContextRequest = 0;
  let lastSkippedPendingCount = 0;
  // 渠道管理弹窗的视图状态。每个页签各自记页码（切回来还在原处），搜索词与展开集合
  // 跨页签共享。BKD_PAGE_SIZE 把同时渲染的行数钉死，列表再长也不会拖慢弹窗。
  let bkdTab = "operating";
  const bkdPage = { operating: 1, banned: 1, archived: 1 };
  let bkdQuery = "";
  const bkdExpanded = new Set();
  const BKD_PAGE_SIZE = 20;

  let bankLoadRequest = 0;
  let ledgerLoadRequest = 0;
  let reportLoadRequest = 0;
  let sharedRefreshInFlight = false;
  const PENDING_BANK_RANK_STORAGE_PREFIX = "bank-pending-last-bank:";

  const GRID_FIELDS = [
    "time", "tx_id", "status", "in", "out", "help_trf",
    "bank_acc", "username", "name", "c_status", "other", "remark",
  ];
  const PROBLEM_OPTIONS = ["进错钱", "金额不对", "重复入账", "客户认领", "需要检查", "其他问题"];

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
  const OUT_STATUSES = new Set(["withdraw", "wrong", "cash out", "give back", "expenses", "exchange", "bank trf", "test out"]);
  // Manual IN/OUT must expose the complete directional status sets. Keep the
  // order aligned with the status settings so the dropdown is predictable.
  const IN_HELP_STATUSES = ["deposit", "cash in", "new", "bank transfer", "unclaim", "redeposit", "amopay", "test in"];
  const OUT_HELP_STATUSES = ["withdraw", "wrong", "cash out", "give back", "expenses", "exchange", "bank trf", "test out"];
  const KIND_LABEL = { nominee: "人头", ghost: "幽灵", payment_gateway: "PaymentGateway" };
  const PICKER_CLOSE = "__close__";
  const PICKER_CLOSE_LABEL = "— 关闭 —";
  const PICKER_BLANK = "__blank__";
  const PICKER_BLANK_LABEL = "— 空白 —";
  const PICKER_ADD = "__add__";

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
    return Number(n || 0).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtMetric(n) {
    const v = Number(n || 0);
    return Number.isInteger(v) ? String(v) : fmt(v);
  }
  function fmtSigned(n) {
    const v = Number(n || 0);
    if (!v) return "0.00";
    return fmt(v);
  }
  function fmtOut(n) {
    const v = Number(n || 0);
    if (!v) return "";
    return (-Math.abs(v)).toFixed(2);
  }
  function parseNum(v) {
    if (v === "" || v == null) return 0;
    const n = parseFloat(String(v).replace(/,/g, ""));
    return Number.isFinite(n) ? Math.abs(n) : 0;
  }
  function parseOut(v) {
    if (v === "" || v == null) return 0;
    const n = parseFloat(String(v).replace(/,/g, ""));
    return Number.isFinite(n) ? Math.abs(n) : 0;
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
  let STATUS_COLORS = {
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
  function inferRowStatus(r) {
    const st = String(r?.status || "").trim();
    if (st) return st;
    if (Number(r?.amount_in || 0) > 0) return "deposit";
    if (Number(r?.amount_out || 0) > 0) return "withdraw";
    if (Number(r?.trf_amount || 0) > 0) return "bank transfer";
    if (Number(r?.help_amount || 0) > 0) return "bank trf";
    return "";
  }
  function helpTrfAmount(r) {
    return Number(r.help_amount || 0) + Number(r.trf_amount || 0);
  }
  function splitHelpTrf(status, amount) {
    if (!amount) return { help_amount: 0, trf_amount: 0 };
    return OUT_STATUSES.has(status)
      ? { help_amount: amount, trf_amount: 0 }
      : { help_amount: 0, trf_amount: amount };
  }
  function isRedepositStatus(status) {
    return parseStatus(status) === "redeposit";
  }
  // 能出现在录入下拉、渠道 rail、编号与拖拽排序里的账户。封禁与归档都不在内。
  function usableBanks() {
    return bankRows.filter(LC.isOperating);
  }
  function tabLabel(r) {
    const head = (bankBranchOf(r) || "Bank").slice(0, 12);
    const sub = (r.account_name || r.payid || "").slice(0, 16);
    return sub ? `${head} (${sub})` : head;
  }
  function bankBranchOf(r) {
    if (!r) return "";
    const bb = String(r.bank_branch || "").trim();
    if (bb) return bb;
    const bank = String(r.bank || "").trim();
    const branch = String(r.branch || "").trim();
    return branch ? `${bank} ${branch}`.trim() : bank;
  }
  function bankPickerLabel(b, index) {
    return `${index + 1}. ${tabLabel(b)}`;
  }
  function bankByPickerLabel(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    const numMatch = t.match(/^(\d+)(?:\.\s*|\s+|$)/);
    const list = usableBanks();
    if (numMatch) {
      const idx = Number(numMatch[1]) - 1;
      if (idx >= 0 && idx < list.length) return list[idx];
    }
    const upper = t.toUpperCase();
    return list.find((b) =>
      bankPickerLabel(b, list.indexOf(b)).toUpperCase() === upper
      || tabLabel(b).toUpperCase() === upper
      || bankBranchOf(b).toUpperCase() === upper
      || String(b.account_name || "").toUpperCase() === upper
    ) || null;
  }
  /** Sydney wall-clock HH:MM in 24-hour (h23). */
  function nowTime() {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Australia/Sydney",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    let hh = Number(parts.find((p) => p.type === "hour")?.value);
    let mm = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(hh)) hh = 0;
    if (!Number.isFinite(mm)) mm = 0;
    if (hh === 24) hh = 0; // some engines emit 24:xx at midnight
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  /** Normalize user/time-input to 24h HH:MM (or HH:MM:SS). */
  function normalizeTime24(timeStr) {
    const raw = String(timeStr || "").trim();
    if (!raw) return nowTime();
    const m = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return nowTime();
    let hh = Number(m[1]);
    let mm = Number(m[2]);
    let ss = m[3] != null ? Number(m[3]) : null;
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return nowTime();
    if (hh === 24) hh = 0;
    hh = Math.min(23, Math.max(0, hh));
    mm = Math.min(59, Math.max(0, mm));
    if (ss != null && Number.isFinite(ss)) {
      ss = Math.min(59, Math.max(0, ss));
      return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    }
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  function defaultBankForNewRow() {
    const list = usableBanks();
    if (activeBankId !== ALL_BANKS && activeBankId) {
      return list.find((b) => b.id === activeBankId) || list[0] || null;
    }
    return list[0] || null;
  }
  function defaultBankLabel() {
    const b = defaultBankForNewRow();
    if (!b) return "";
    const list = usableBanks();
    const idx = list.findIndex((x) => x.id === b.id);
    return bankPickerLabel(b, idx >= 0 ? idx : 0);
  }
  function bankAccDisplay(r) {
    if (!r) return "";
    const list = usableBanks();
    const b = bankRows.find((x) => x.id === r.bank_account_id);
    if (b) {
      const idx = list.findIndex((x) => x.id === b.id);
      return bankPickerLabel(b, idx >= 0 ? idx : 0);
    }
    if (r.bank_acc) {
      const matched = bankByPickerLabel(r.bank_acc);
      if (matched) {
        const idx = list.findIndex((x) => x.id === matched.id);
        return bankPickerLabel(matched, idx >= 0 ? idx : 0);
      }
      return r.bank_acc;
    }
    return bankBranchOf(r) || "";
  }
  function bankPickerOptions() {
    return usableBanks().map((b, i) => bankPickerLabel(b, i));
  }
  function matchBankId(text) {
    return bankByPickerLabel(text)?.id ?? null;
  }
  function setBankAccInput(inp, bank) {
    if (!inp || !bank) return;
    const list = usableBanks();
    const idx = list.findIndex((b) => b.id === bank.id);
    inp.value = bankPickerLabel(bank, idx >= 0 ? idx : 0);
    inp.dataset.bankId = String(bank.id);
  }
  function rowBankId(tr, bankAccText) {
    const inp = tr.querySelector('input[data-f="bank_acc"]');
    const text = String(bankAccText || "").trim();
    if (inp?.dataset.bankCleared === "1") return 0;
    const matched = matchBankId(bankAccText);
    if (matched) return matched;
    if (inp?.dataset.bankId) {
      const id = Number(inp.dataset.bankId);
      const list = usableBanks();
      const bank = list.find((b) => b.id === id);
      const idx = list.findIndex((b) => b.id === id);
      const label = bank ? bankPickerLabel(bank, idx >= 0 ? idx : 0) : "";
      if (!text || label.toUpperCase() === text.toUpperCase()) return id;
    }
    if (!text && activeBankId !== ALL_BANKS && activeBankId) return activeBankId;
    return usableBanks()[0]?.id ?? null;
  }
  function cStatusNames() {
    return cStatusOptions.map((o) => o.name);
  }
  function entryDateTime(timeStr) {
    const t = normalizeTime24(timeStr);
    const part = t.length === 5 ? `${t}:00` : t;
    return `${sheetDate} ${part}`;
  }
  function timeFromSql(value, fallback) {
    const text = String(value || "").replace("T", " ");
    const m = text.match(/\s(\d{1,2}:\d{2})(?::\d{2})?/);
    return m ? normalizeTime24(m[1]) : fallback;
  }

  function dateFromSql(value, fallback) {
    const text = String(value || "").trim();
    const m = text.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : fallback;
  }

  function compactDateLabel(value) {
    const m = String(value || "").match(/^\d{4}-(\d{2})-(\d{2})$/);
    if (!m) return "—";
    const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    return `${m[2]} ${months[Number(m[1]) - 1] || ""}`.trim();
  }

  function pendingEntryDateTime(dateValue, timeStr) {
    const date = dateFromSql(dateValue, sheetDate || todaySydney());
    const t = normalizeTime24(timeStr);
    const part = t.length === 5 ? `${t}:00` : t;
    return `${date} ${part}`;
  }

  function rowValues(r, isNew) {
    return {
      time: r ? String(r.entry_time || "").slice(11, 16) : nowTime(),
      tx_id: r?.tx_id || "",
      status: r ? statusLabel(inferRowStatus(r)) : "",
      in: r && Number(r.amount_in) ? fmt(r.amount_in) : "",
      out: r ? fmtOut(r.amount_out) : "",
      help_trf: r && helpTrfAmount(r) ? fmt(helpTrfAmount(r)) : "",
      bank_acc: isNew ? defaultBankLabel() : bankAccDisplay(r),
      username: r?.username || "",
      name: ledgerNameText(r?.name || ""),
      c_status: r?.c_status || "",
      other: r?.other_info || "",
      remark: r?.remark || "",
    };
  }
  function readRow(tr) {
    const g = (f) => tr.querySelector(`input[data-f="${f}"]`)?.value.trim() ?? "";
    const status = parseStatus(g("status"));
    const helpTrf = parseNum(g("help_trf"));
    const { help_amount, trf_amount } = splitHelpTrf(status, helpTrf);
    return {
      entry_time: entryDateTime(g("time")),
      tx_id: g("tx_id"),
      status,
      amount_in: parseNum(g("in")),
      amount_out: parseOut(g("out")),
      help_amount,
      trf_amount,
      bank_acc: g("bank_acc"),
      username: g("username"),
      name: g("name"),
      c_status: g("c_status"),
      other_info: g("other"),
      remark: g("remark"),
    };
  }
  function rowHasData(body, isExisting) {
    // An existing row may intentionally be cleared to remove its cash movement.
    // Keep the guard for new rows so an accidental blank row is not inserted.
    if (isExisting) return true;
    return !!(body.amount_in || body.amount_out || body.help_amount || body.trf_amount
      || body.tx_id || body.username || body.name || body.other_info || body.remark);
  }
  function gridCellHtml(f, val, bankId) {
    const num = f === "in" || f === "out" || f === "help_trf";
    const pick = f === "status" || f === "c_status" || f === "bank_acc" || f === "other";
    const stCls = f === "status" && val ? statusClass(parseStatus(val)) : "";
    const cls = ["sheet-cell", `field-${f.replace(/_/g, "-")}`, num ? "sheet-num" : "", f === "time" ? "sheet-time" : "", f === "tx_id" ? "mono" : "", pick ? "sheet-pick" : "", stCls].filter(Boolean).join(" ");
    let attrs = ` data-f="${f}" class="${cls}" value="${esc(String(val ?? ""))}" autocomplete="off" spellcheck="false"`;
    if (f === "status") attrs += ` style="${statusStyleAttr(val)}"`;
    if (f === "bank_acc" && bankId) attrs += ` data-bank-id="${bankId}"`;
    if (num) attrs += ' inputmode="decimal"';
    if (f === "time") attrs += ' type="time" step="60"';
    // The <input value> is never translated (value is not in I18N_ATTRS, and
    // readRow/parseStatus read it back to write bank_ledger), but mark the cell
    // so that stays true by construction rather than by accident.
    return `<td class="${pick ? "cell-pick" : ""}" translate="no"><input${attrs}></td>`;
  }

  function resetEnterSave() {
    enterSaveCount = 0;
    enterSaveRow = null;
    if (enterSaveTimer) {
      clearTimeout(enterSaveTimer);
      enterSaveTimer = null;
    }
  }
  function tryDoubleEnterSave(tr, colIdx) {
    if (enterSaveRow === tr) enterSaveCount += 1;
    else {
      enterSaveRow = tr;
      enterSaveCount = 1;
    }
    if (enterSaveTimer) clearTimeout(enterSaveTimer);
    enterSaveTimer = setTimeout(resetEnterSave, 900);
    if (enterSaveCount >= 2) {
      resetEnterSave();
      hideGridPicker();
      commitRow(tr).then(() => focusNewRow(0));
      return true;
    }
    return false;
  }
  function getPickerItems() {
    const p = document.getElementById("grid-picker");
    return p ? [...p.querySelectorAll(".ac-item")] : [];
  }
  function highlightPickerItem(idx) {
    const items = getPickerItems();
    if (!items.length) return;
    gridPickerIndex = Math.max(0, Math.min(idx, items.length - 1));
    items.forEach((li, i) => li.classList.toggle("active", i === gridPickerIndex));
    items[gridPickerIndex].scrollIntoView({ block: "nearest" });
  }
  function movePickerSelection(delta) {
    highlightPickerItem(gridPickerIndex + delta);
  }
  function confirmGridPicker() {
    const items = getPickerItems();
    const inp = gridPickerInput;
    if (!items.length || !inp) {
      hideGridPicker();
      return;
    }
    const val = items[gridPickerIndex].dataset.v;
    const f = inp.getAttribute("data-f");
    if (val === PICKER_CLOSE) {
      hideGridPicker();
      inp.focus();
      return;
    }
    if (val === PICKER_BLANK) {
      inp.value = "";
      if (f === "bank_acc") {
        delete inp.dataset.bankId;
        inp.dataset.bankCleared = "1";
      }
      hideGridPicker();
      inp.focus();
      return;
    }
    if (val === PICKER_ADD) {
      const name = String(inp.value || "").trim();
      hideGridPicker();
      if (name && inp.getAttribute("data-f") === "c_status") {
        api("/api/banks/c-status-options", { method: "POST", body: JSON.stringify({ name }) })
          .then(() => loadCStatus().then(() => { inp.value = name; }))
          .catch(() => { inp.value = name; });
      } else if (name) {
        inp.value = name;
      }
      if (f === "bank_acc" && name) delete inp.dataset.bankCleared;
      inp.focus();
      return;
    }
    inp.value = val;
    if (f === "bank_acc") {
      delete inp.dataset.bankCleared;
      const bank = bankByPickerLabel(val);
      if (bank) inp.dataset.bankId = String(bank.id);
      else delete inp.dataset.bankId;
    }
    if (f === "status") {
      inp.className = inp.className.replace(/status-[\w-]+/g, "").trim();
      inp.classList.add(statusClass(parseStatus(val)));
      inp.setAttribute("style", statusStyleAttr(val));
    }
    hideGridPicker();
    inp.focus();
    inp.select();
  }
  function hideGridPicker() {
    const p = document.getElementById("grid-picker");
    if (p) p.style.display = "none";
    gridPickerInput = null;
    gridPickerIndex = 0;
  }
  function isGridPickerOpen() {
    const p = document.getElementById("grid-picker");
    return !!(p && p.style.display === "block");
  }
  function buildPickerRows(options, allowAdd, field) {
    const first = field === "bank_acc" || field === "c_status" || field === "other"
      ? { v: PICKER_BLANK, label: PICKER_BLANK_LABEL }
      : { v: PICKER_CLOSE, label: PICKER_CLOSE_LABEL };
    const rows = [first, ...options.map((o) => ({ v: o, label: o }))];
    if (allowAdd) rows.push({ v: PICKER_ADD, label: "+ 添加当前输入" });
    return rows;
  }
  // 浮层是 fixed + 视口坐标，输入框一动它就得跟着重算。手机上点输入框会弹键盘、页面跟着滚，
  // 不重算的话浮层会停在原处压住别的字段。
  function placeGridPicker(picker, inp) {
    const rect = inp.getBoundingClientRect();
    const w = Math.max(rect.width, 180);
    picker.style.left = `${Math.max(4, rect.left)}px`;
    picker.style.width = `${Math.min(w, 320)}px`;
    picker.style.minWidth = "0";
    picker.style.maxWidth = "320px";
    const maxH = 240;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    if (spaceBelow < 160 && spaceAbove > spaceBelow) {
      picker.style.top = `${Math.max(4, rect.top - Math.min(maxH, spaceAbove) - 2)}px`;
    } else {
      picker.style.top = `${rect.bottom + 2}px`;
    }
  }
  function followGridPicker() {
    if (!isGridPickerOpen() || !gridPickerInput) return;
    const rect = gridPickerInput.getBoundingClientRect();
    // 输入框整个滚出视口（或已被重渲染掉）就收起，别让浮层悬在不相干的内容上。
    if (!gridPickerInput.isConnected || rect.bottom < 0 || rect.top > window.innerHeight) {
      hideGridPicker();
      return;
    }
    placeGridPicker(document.getElementById("grid-picker"), gridPickerInput);
  }
  function showGridPicker(inp, options, allowAdd) {
    let picker = document.getElementById("grid-picker");
    if (!picker) {
      picker = document.createElement("ul");
      picker.id = "grid-picker";
      picker.className = "ac-dropdown grid-picker";
      document.body.appendChild(picker);
    }
    const field = inp.getAttribute("data-f");
    const rows = buildPickerRows(options, allowAdd, field);
    placeGridPicker(picker, inp);
    picker.innerHTML = rows.map((o) =>
      `<li class="ac-item" data-v="${esc(o.v)}">${esc(o.label)}</li>`
    ).join("");
    gridPickerInput = inp;
    picker.style.display = "block";
    const cur = String(inp.value || "").trim().toUpperCase();
    let startIdx = cur
      ? rows.findIndex((o) => o.v !== PICKER_CLOSE && o.v !== PICKER_BLANK && o.v !== PICKER_ADD && String(o.label).trim().toUpperCase() === cur)
      : rows.findIndex((o) => o.v === PICKER_BLANK);
    highlightPickerItem(startIdx < 0 ? 0 : startIdx);
    picker.onmousedown = (e) => {
      const li = e.target.closest(".ac-item");
      if (!li) return;
      e.preventDefault();
      gridPickerIndex = getPickerItems().indexOf(li);
      confirmGridPicker();
    };
  }
  function isPickField(inp) {
    const f = inp?.getAttribute?.("data-f");
    return f === "status" || f === "c_status" || f === "bank_acc" || f === "other";
  }
  function insertCurrentTime(tr, inp) {
    const timeInp = tr?.querySelector('input[data-f="time"]');
    if (!timeInp) return;
    timeInp.value = nowTime();
    if (inp !== timeInp) {
      timeInp.focus();
      timeInp.select();
    }
  }
  function openFieldPicker(inp) {
    const f = inp.getAttribute("data-f");
    if (f === "status") showGridPicker(inp, STATUS_LIST.map((s) => s.label));
    else if (f === "c_status") showGridPicker(inp, cStatusNames(), true);
    else if (f === "bank_acc") showGridPicker(inp, bankPickerOptions());
    else if (f === "other") showGridPicker(inp, PROBLEM_OPTIONS, true);
  }
  function roCellHtml(f, val) {
    const num = f === "in" || f === "out" || f === "help_trf";
    const parsedStatus = f === "status" ? parseStatus(val) : "";
    const stCls = f === "status" ? statusClass(parsedStatus) : "";
    const cls = ["ro-cell", `field-${f.replace(/_/g, "-")}`, num ? "sheet-num" : "", f === "time" ? "sheet-time" : "", f === "tx_id" ? "mono" : "", stCls].filter(Boolean).join(" ");
    const text = f === "status" ? statusLabel(parsedStatus) : (f === "name" ? plainDisplayText(val) : String(val ?? ""));
    const style = f === "status" ? ` style="${statusStyleAttr(parsedStatus)}"` : "";
    // translate="no": every GRID_FIELD is data (remark, other_info, name,
    // username, c_status, bank_acc, tx_id, amounts) or a tenant-defined STATUS
    // label from bank_status_options. It also covers the title attribute, which
    // is in I18N_ATTRS and would otherwise run the cell text through the engine.
    return `<td class="${cls}" translate="no" title="${esc(text)}"${style}>${esc(text)}</td>`;
  }
  function buildGridRow(r, no, isNew) {
    const id = r?.id;
    if (!isNew && editingRowId !== id) {
      const v = rowValues(r, false);
      // aria-expanded 只在手机卡片模式下有意义，且必须在这里渲染：每 5 秒整块重渲染会冲掉点击时设的值。
      const expandedAttr = MOBILE_MQ.matches ? ` aria-expanded="${openLedgerCards.has(id) ? "true" : "false"}"` : "";
      return `<tr class="sheet-grid-row sheet-row-ro${openLedgerCards.has(id) ? " m-open" : ""}" data-id="${id}"${expandedAttr}>
        <td class="col-no">${no}</td>
        ${GRID_FIELDS.map((f) => roCellHtml(f, v[f])).join("")}
        <td class="col-act"><a class="sheet-history admin-audit-link" href="/audit-history.html?ledger_id=${id}" title="\u67e5\u770b\u64cd\u4f5c\u5386\u53f2" aria-label="\u67e5\u770b\u6d41\u6c34\u64cd\u4f5c\u5386\u53f2">${renderIcon("history", { size: 15 })}<span class="icon-fallback">\u53f2</span></a><button type="button" class="sheet-edit" data-id="${id}" title="\u7f16\u8f91\u6d41\u6c34" aria-label="\u7f16\u8f91\u6d41\u6c34">${renderIcon("pencil", { size: 15 })}<span class="icon-fallback">\u7f16</span></button><button type="button" class="sheet-del" data-id="${id}" title="\u5220\u9664\u6d41\u6c34" aria-label="\u5220\u9664\u6d41\u6c34">${renderIcon("trash-2", { size: 15 })}<span class="icon-fallback">\u5220</span></button></td>
      </tr>`;
    }
    const v = rowValues(r, isNew);
    const bankId = isNew ? defaultBankForNewRow()?.id : r?.bank_account_id;
    return `<tr class="sheet-grid-row${isNew ? " grid-row-new" : " grid-row-editing"}"${id ? ` data-id="${id}"` : ""}>
      <td class="col-no">${isNew ? "+" : no}</td>
      ${GRID_FIELDS.map((f) => gridCellHtml(f, v[f], f === "bank_acc" ? bankId : null)).join("")}
      <td class="col-act"><button type="button" class="sheet-save" title="\u4fdd\u5b58\u6d41\u6c34" aria-label="\u4fdd\u5b58\u6d41\u6c34">${renderIcon("check", { size: 16 })}<span class="icon-fallback">\u5b58</span></button><button type="button" class="sheet-cancel" title="\u53d6\u6d88\u7f16\u8f91" aria-label="\u53d6\u6d88\u7f16\u8f91">${renderIcon("x", { size: 16 })}<span class="icon-fallback">\u6d88</span></button></td>
    </tr>`;
  }
  function startEditRow(id) {
    adding = false;
    editingRowId = id;
    hideGridPicker();
    resetEnterSave();
    renderGrid();
    const tr = document.querySelector("#sheet-grid .grid-row-editing");
    if (tr) focusGridCell(tr, 0);
  }
  function cancelEditRow() {
    editingRowId = null;
    hideGridPicker();
    resetEnterSave();
    renderGrid();
  }
  function startAdding() {
    editingRowId = null;
    adding = true;
    hideGridPicker();
    resetEnterSave();
    renderGrid();
    focusNewRow(0);
  }
  function stopAdding() {
    adding = false;
    hideGridPicker();
    resetEnterSave();
    renderGrid();
  }
  function isGridBusy() {
    // The state flags are authoritative. Checking the DOM here keeps a stale
    // editing row alive after a successful save, because renderGrid has not
    // replaced the old row yet.
    return adding || editingRowId != null;
  }
  function focusGridCell(tr, colIdx) {
    if (enterSaveRow && enterSaveRow !== tr) resetEnterSave();
    hideGridPicker();
    const inputs = tr?.querySelectorAll("input[data-f]");
    const el = inputs?.[colIdx];
    if (el) { el.focus(); el.select(); }
  }
  function focusNewRow(colIdx) {
    const tr = document.querySelector("#sheet-grid .grid-row-new");
    if (tr) focusGridCell(tr, colIdx ?? 0);
  }
  function resetNewRow(tr) {
    const v = rowValues(null, true);
    const bank = defaultBankForNewRow();
    GRID_FIELDS.forEach((f) => {
      const el = tr.querySelector(`input[data-f="${f}"]`);
      if (!el) return;
      if (f === "bank_acc" && bank) setBankAccInput(el, bank);
      else el.value = v[f];
    });
  }
  function commitRow(tr) {
    if (saveLock || !tr) return Promise.resolve();
    const id = tr.dataset.id ? Number(tr.dataset.id) : null;
    const isExisting = Boolean(id);
    if (!usableBanks().length && !isRedepositStatus(tr.querySelector('input[data-f="status"]')?.value)) {
      showToast("请先添加支付渠道", { tone: "warning" });
      return Promise.resolve();
    }
    const body = readRow(tr);
    body.bank_account_id = isRedepositStatus(body.status) ? 0 : rowBankId(tr, body.bank_acc);
    if (isRedepositStatus(body.status)) body.bank_acc = "";
    if (!isRedepositStatus(body.status) && !body.bank_account_id && isExisting) body.bank_acc = "";
    if (!isRedepositStatus(body.status) && !body.bank_account_id && !isExisting) {
      showToast("请选择 BANK ACC", { tone: "warning" });
      return Promise.resolve();
    }
    if (!rowHasData(body, Boolean(id))) {
      showToast("请填写金额或备注后再保存", { tone: "warning" });
      return Promise.resolve();
    }
    saveLock = true;
    const saveButton = tr.querySelector(".sheet-save");
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.setAttribute("aria-busy", "true");
    }
    const url = id ? `/api/banks/ledger/${id}` : "/api/banks/ledger";
    const method = id ? "PUT" : "POST";
    return api(url, { method, body: JSON.stringify(body) })
      .then(() => {
        showToast(id ? "已更新" : "已保存", { tone: "success" });
        if (id) {
          editingRowId = null;
          hideGridPicker();
          resetEnterSave();
          renderGrid();
        } else {
          // Leaving the saved values in the entry row invites a second Enter that
          // books the same money twice, and the balance would still reconcile.
          resetNewRow(tr);
          stopAdding();
        }
        return loadBanks().then(loadSheet).then(loadDailyReport);
      })
      .catch((err) => { showToast(`保存失败：${err?.message || "请求失败"}`, { tone: "error" }); })
      .finally(() => {
        saveLock = false;
        if (saveButton) {
          saveButton.disabled = false;
          saveButton.removeAttribute("aria-busy");
        }
      });
  }

  function handleGridKeydown(e) {
    const inp = e.target;
    if (!inp.matches("#sheet-grid input[data-f]")) return;
    const tr = inp.closest("tr");
    const rows = [...document.querySelectorAll("#sheet-grid .sheet-grid-row")];
    const rowIdx = rows.indexOf(tr);
    const fields = [...tr.querySelectorAll("input[data-f]")];
    const colIdx = fields.indexOf(inp);

    if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === ";" || e.code === "Semicolon")) {
      e.preventDefault();
      insertCurrentTime(tr, inp);
      return;
    }
    const field = inp.getAttribute("data-f");
    if (!isGridPickerOpen() && field === "bank_acc" && /^[1-9]$/.test(e.key)) {
      const n = Number(e.key);
      const list = usableBanks();
      if (n <= list.length) {
        e.preventDefault();
        setBankAccInput(inp, list[n - 1]);
        return;
      }
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        if (colIdx > 0) focusGridCell(tr, colIdx - 1);
        else if (rowIdx > 0) focusGridCell(rows[rowIdx - 1], GRID_FIELDS.length - 1);
      } else if (colIdx < GRID_FIELDS.length - 1) {
        focusGridCell(tr, colIdx + 1);
      } else {
        commitRow(tr).then(() => focusNewRow(0));
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (isGridPickerOpen()) {
        confirmGridPicker();
        return;
      }
      const f = inp.getAttribute("data-f");
      if (f === "status" || f === "c_status" || f === "bank_acc" || f === "other") {
        resetEnterSave();
        openFieldPicker(inp);
        return;
      }
      tryDoubleEnterSave(tr, colIdx);
      return;
    }
    if (isGridPickerOpen()) {
      if (e.key === "ArrowDown") { e.preventDefault(); movePickerSelection(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); movePickerSelection(-1); return; }
      if (e.key === "Escape") { e.preventDefault(); hideGridPicker(); inp.focus(); return; }
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (rowIdx < rows.length - 1) focusGridCell(rows[rowIdx + 1], colIdx);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (rowIdx > 0) focusGridCell(rows[rowIdx - 1], colIdx);
      return;
    }
    if (e.key === "ArrowLeft") {
      const start = inp.selectionStart ?? 0;
      const end = inp.selectionEnd ?? 0;
      if (start !== end || start > 0) return;
      e.preventDefault();
      if (colIdx > 0) focusGridCell(tr, colIdx - 1);
      else if (rowIdx > 0) focusGridCell(rows[rowIdx - 1], GRID_FIELDS.length - 1);
      return;
    }
    if (e.key === "ArrowRight") {
      const val = String(inp.value || "");
      const start = inp.selectionStart ?? 0;
      const end = inp.selectionEnd ?? 0;
      if (start !== end || start < val.length) return;
      e.preventDefault();
      if (colIdx < GRID_FIELDS.length - 1) focusGridCell(tr, colIdx + 1);
      else if (rowIdx < rows.length - 1) focusGridCell(rows[rowIdx + 1], 0);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (tr.classList.contains("grid-row-new")) {
        if (rowHasData(readRow(tr))) {
          resetNewRow(tr);
          focusGridCell(tr, colIdx);
        } else {
          stopAdding();
        }
      } else if (tr.classList.contains("grid-row-editing")) {
        cancelEditRow();
      }
    }
  }

  function loadBanks() {
    const request = ++bankLoadRequest;
    return api("/api/banks", { bg: true }).then((d) => {
      if (request !== bankLoadRequest) return;
      bankRows = d.rows || [];
      if (activeBankId !== ALL_BANKS && activeBankId && !bankRows.find((b) => b.id === activeBankId)) {
        activeBankId = bankRows.length ? ALL_BANKS : null;
      } else if (!bankRows.length) {
        activeBankId = null;
      } else if (activeBankId == null) {
        activeBankId = ALL_BANKS;
      }
      renderTabs();
    });
  }
  function loadSheet() {
    const request = ++ledgerLoadRequest;
    if (!bankRows.length) {
      if (isGridBusy()) return Promise.resolve();
      ledgerRows = [];
      renderSheet();
      return Promise.resolve();
    }
    const dateSnapshot = sheetDate;
    const bankSnapshot = activeBankId;
    const pageSize = 500;
    const fetchPage = (offset) => {
      const q = new URLSearchParams({
        dateFrom: dateSnapshot,
        dateTo: dateSnapshot,
        limit: pageSize,
        offset,
      });
      if (bankSnapshot !== ALL_BANKS && bankSnapshot) q.set("bankId", bankSnapshot);
      return api(`/api/banks/ledger?${q}`, { bg: true });
    };
    return fetchPage(0).then((first) => {
      const total = Number(first.total || 0);
      const offsets = [];
      for (let offset = pageSize; offset < total; offset += pageSize) offsets.push(offset);
      return Promise.all(offsets.map(fetchPage)).then((pages) => [first, ...pages]);
    }).then((pages) => {
      if (request !== ledgerLoadRequest || dateSnapshot !== sheetDate || bankSnapshot !== activeBankId || isGridBusy()) return;
      ledgerRows = pages.flatMap((page) => page.rows || []);
      renderSheet();
    }).catch(() => {});
  }
  function loadDailyReport() {
    const request = ++reportLoadRequest;
    const dateSnapshot = sheetDate;
    return api(`/api/banks/daily-report?date=${encodeURIComponent(dateSnapshot)}`, { bg: true })
      .then((d) => {
        if (request !== reportLoadRequest || dateSnapshot !== sheetDate) return;
        dailyReport = d;
        renderDailyPanels();
      })
      .catch(() => {});
  }
  function loadCStatus() {
    return api("/api/banks/c-status-options", { bg: true }).then((d) => {
      cStatusOptions = d.options || [];
      companyOptions = d.companies || [];
      populateCstatusOptions();
      fillCompanySelects();
    }).catch(() => {});
  }
  function loadStatusOptions() {
    return api("/api/banks/status-options", { bg: true }).then((d) => {
      const rows = (d.options || []).filter((s) => Number(s.active) !== 0);
      if (rows.length) {
        STATUS_LIST = rows.map((s) => ({
          value: String(s.value || "").trim(),
          label: String(s.label || s.value || "").trim(),
          color: String(s.color || "").trim(),
        })).filter((s) => s.value && s.label);
        rebuildStatusLookups();
      }
      populateStatusFilter();
      if (!isGridBusy()) renderSheet();
    }).catch(() => {});
  }
  function refreshPendingBadge() {
    return api("/api/banks/pending-counts", { bg: true }).then((d) => {
      const total = Number(d.total || 0);
      const platformCount = Number(d.pending_tx || 0);
      lastSkippedPendingCount = Number(d.skipped_tx || 0);
      const pendingEl = document.getElementById("sheet-pending-count");
      if (pendingEl) {
        pendingEl.textContent = String(total);
        pendingEl.style.display = total > 0 ? "" : "none";
      }
      if (typeof window.updateBankPendingBadge === "function") {
        window.updateBankPendingBadge(total);
      }
      if (typeof window.updatePlatformPendingSound === "function") {
        window.updatePlatformPendingSound(platformCount);
      }
      updatePendingWorkspaceSummary(platformCount, lastSkippedPendingCount);
      if (lastPendingTotal != null && total > lastPendingTotal) {
        showToast(`有 ${total} 笔待审批`, { tone: "warning" });
      }
      lastPendingTotal = total;
    }).catch(() => {});
  }
  let reasonModalResolve = null;
  let reasonModalLastFocus = null;

  function closeReasonModal(value) {
    const modal = document.getElementById("reason-modal");
    if (!modal?.classList.contains("show")) return;
    modal.classList.remove("show");
    const resolve = reasonModalResolve;
    reasonModalResolve = null;
    if (resolve) resolve(value || null);
    if (reasonModalLastFocus && document.contains(reasonModalLastFocus)) reasonModalLastFocus.focus();
    reasonModalLastFocus = null;
  }

  function bindReasonModal() {
    const modal = document.getElementById("reason-modal");
    if (!modal || modal.dataset.bound === "1") return;
    modal.dataset.bound = "1";
    const input = document.getElementById("reason-modal-input");
    const error = document.getElementById("reason-modal-error");
    const count = document.getElementById("reason-modal-count");
    document.getElementById("reason-modal-cancel")?.addEventListener("click", () => closeReasonModal(null));
    document.getElementById("reason-modal-confirm")?.addEventListener("click", () => {
      const value = String(input?.value || "").trim();
      if (!value) {
        if (error) error.textContent = "\u8bf7\u586b\u5199\u64cd\u4f5c\u539f\u56e0";
        input?.focus();
        return;
      }
      closeReasonModal(value);
    });
    input?.addEventListener("input", () => {
      if (count) count.textContent = `${input.value.length} / 500`;
      if (error) error.textContent = "";
    });
  }

  function requestOperationReason(options) {
    bindReasonModal();
    const modal = document.getElementById("reason-modal");
    const input = document.getElementById("reason-modal-input");
    if (!modal || !input) return Promise.resolve(null);
    if (reasonModalResolve) reasonModalResolve(null);
    reasonModalLastFocus = document.activeElement;
    document.getElementById("reason-modal-title").textContent = options?.title || "\u586b\u5199\u64cd\u4f5c\u539f\u56e0";
    document.getElementById("reason-modal-description").textContent = options?.description || "\u6b64\u64cd\u4f5c\u4f1a\u5199\u5165\u6c38\u4e45\u5ba1\u8ba1\u8bb0\u5f55\u3002";
    document.getElementById("reason-modal-target").textContent = options?.target || "";
    document.getElementById("reason-modal-confirm").textContent = options?.confirmLabel || "\u786e\u8ba4";
    document.getElementById("reason-modal-error").textContent = "";
    document.getElementById("reason-modal-count").textContent = "0 / 500";
    input.value = "";
    modal.classList.add("show");
    window.requestAnimationFrame(() => input.focus());
    return new Promise((resolve) => {
      reasonModalResolve = resolve;
    });
  }

  function updatePendingWorkspaceSummary(txCount, skippedCount) {
    const summary = document.getElementById("bk-pending-summary");
    if (!summary) return;
    const tx = Number(txCount || 0);
    const skipped = Number(skippedCount || 0);
    const total = tx + skipped;
    const text = document.getElementById("bk-pending-summary-text");
    const txEl = document.getElementById("bk-pending-platform-count");
    const skippedEl = document.getElementById("bk-pending-skipped-count");
    if (txEl) txEl.textContent = String(tx);
    if (skippedEl) skippedEl.textContent = String(skipped);
    summary.hidden = false;
    if (total <= 0) {
      if (text) text.textContent = "暂无待处理";
      return;
    }
    const parts = [];
    if (tx) parts.push(`平台接单 ${tx}`);
    if (skipped) parts.push(`Skipped ${skipped}`);
    if (text) text.textContent = parts.join(" · ") + " · 请尽快处理";
  }

  function updateWorkspaceCompanyContext() {
    const companyEl = document.getElementById("bk-current-company");
    const dateEl = document.getElementById("bk-current-date");
    const select = document.getElementById("company-select");
    if (companyEl) {
      const option = select?.selectedOptions?.[0];
      const name = option?.textContent?.trim() || select?.value || "未选择公司";
      companyEl.textContent = name;
      companyEl.title = name;
      if (select && !select.options.length) {
        window.setTimeout(updateWorkspaceCompanyContext, 180);
      }
    }
    if (dateEl) dateEl.textContent = sheetDate || todaySydney();
  }

  function formatWorkspaceSyncTime(at) {
    if (!at) return "";
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return String(at);
    return new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Sydney",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function updateWorkspaceSyncContext(state) {
    const syncEl = document.getElementById("bk-current-sync");
    const timeEl = document.getElementById("bk-current-sync-time");
    const wrap = syncEl?.closest(".bk-context-sync");
    if (!syncEl || !wrap) return;
    const message = String(state?.message || "");
    const denied = Boolean(state?.accessDenied) || /invalid access|access denied/i.test(message);
    const at = state?.at;
    const age = at ? Date.now() - new Date(at).getTime() : Infinity;
    let kind = "loading";
    let label = "等待首次同步";
    if (state?.unconfigured) {
      kind = "warning";
      label = "API 未配置";
    } else if (denied) {
      kind = "denied";
      label = "API 访问被拒绝";
    } else if (state?.ok === false) {
      kind = "error";
      label = "同步失败";
    } else if (at && age > 90000) {
      kind = "warning";
      label = "同步延迟";
    } else if (at) {
      kind = "healthy";
      label = state?.mode === "fast" ? "实时同步正常" : "同步正常";
    }
    wrap.dataset.state = kind;
    syncEl.textContent = label;
    syncEl.title = message || label;
    if (timeEl) timeEl.textContent = at ? `最后同步 ${formatWorkspaceSyncTime(at)}` : "暂无同步时间";
  }

  function refreshWorkspaceContext() {
    const request = ++workspaceContextRequest;
    updateWorkspaceCompanyContext();
    return api("/api/data/sync-status", { bg: true })
      .then((state) => {
        if (request !== workspaceContextRequest) return;
        updateWorkspaceCompanyContext();
        updateWorkspaceSyncContext(state);
      })
      .catch((error) => {
        if (request !== workspaceContextRequest) return;
        updateWorkspaceSyncContext({ ok: false, message: error?.message || "同步状态读取失败" });
      });
  }

  function renderFooterTotals() {
    let tin = 0, tout = 0, thelp = 0;
    for (const r of ledgerRows) {
      tin += Number(r.amount_in || 0);
      tout += Number(r.amount_out || 0);
      thelp += helpTrfAmount(r);
    }
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = fmt(v); };
    set("total-in", tin);
    set("total-out", tout ? -tout : 0);
    set("total-help-trf", thelp);
    set("sum-in", tin);
    set("sum-out", tout ? -tout : 0);
    set("sum-help", thelp);
  }
  function renderGrid() {
    const tbody = document.getElementById("sheet-grid");
    if (!tbody) return;
    const q = (document.getElementById("sheet-search")?.value || "").trim().toLowerCase();
    const sf = document.getElementById("sheet-status-filter")?.value || "";
    const filtered = ledgerRows.filter((r) => {
      const rowStatus = inferRowStatus(r);
      if (sf && rowStatus !== sf) return false;
      if (!q) return true;
      const hay = [statusLabel(rowStatus), r.tx_id, r.username, r.name, r.bank_acc, r.c_status, r.other_info, r.remark].join(" ").toLowerCase();
      return hay.includes(q);
    });
    const rowsHtml = filtered.map((r, i) => buildGridRow(r, i + 1, false)).join("");
    const emptyHtml = !rowsHtml && !adding
      ? `<tr><td colspan="14" class="sheet-empty">${q || sf ? "\u6ca1\u6709\u5339\u914d\u7b5b\u9009\u6761\u4ef6\u7684\u6d41\u6c34" : "\u5f53\u5929\u6682\u65e0\u6d41\u6c34"}</td></tr>`
      : "";
    tbody.innerHTML = rowsHtml + emptyHtml + (adding ? buildGridRow(null, "+", true) : "");
    renderIcons(tbody);
  }
  function renderSheet() {
    renderFooterTotals();
    renderGrid();
  }
  // 与后端 bankReport 的 total_balance 同源（isCountedInTotals）：封禁 / 归档 / PG 都不计。
  function isBalanceExcluded(b) {
    return !LC.isCountedInTotals(b);
  }
  function totalBalance() {
    if (dailyReport?.totals?.total_balance != null) {
      return Number(dailyReport.totals.total_balance);
    }
    return bankRows.reduce((s, r) => isBalanceExcluded(r) ? s : s + Number(r.balance || 0), 0);
  }
  function updateGridTitle() {
    const el = document.getElementById("bk-grid-title");
    if (!el) return;
    if (activeBankId === ALL_BANKS || !activeBankId) {
      el.textContent = tr("流水 · 全部渠道");
    } else {
      const b = bankRows.find((x) => x.id === activeBankId);
      el.textContent = b ? `${tr("流水")} · ${tabLabel(b)}` : tr("流水");
    }
  }
  function bankDisplayBalance(b) {
    const stats = (dailyReport?.bankRows || []).find((r) => r.id === b.id);
    return Number(stats?.balance ?? b.balance ?? 0);
  }
  function bankDirectoryCopyText(b) {
    const fields = [
      ["BSB", b?.bsb],
      ["ACCOUNT", b?.account_number],
      ["PAYID", b?.payid],
    ].filter(([, value]) => String(value ?? "").trim());
    return fields.length
      ? fields.map(([label, value]) => `${label} : ${String(value).trim()}`).join("\n")
      : "未填写银行资料";
  }
  function bankDirectoryInfoHtml(b) {
    const fields = [
      ["BSB", b.bsb],
      ["ACCOUNT", b.account_number],
      ["PAYID", b.payid],
    ].filter(([, value]) => String(value ?? "").trim());
    if (!fields.length) return '<div class="bk-bank-info bk-bank-info-empty">未填写银行资料</div>';
    return `<div class="bk-bank-info" title="点击复制完整银行资料">${fields.map(([label, value]) => {
      return `<span class="bk-bank-info-line"><span class="bk-bank-info-label">${label}</span><span class="bk-bank-info-value" translate="no">${esc(String(value).trim())}</span></span>`;
    }).join("")}</div>`;
  }
  function bankDirectoryStats(b) {
    const stats = (dailyReport?.bankRows || []).find((r) => r.id === b.id);
    return {
      txCount: Number(stats?.tx_count ?? 0),
      outflow: Math.abs(Number(stats?.total_outflow ?? b.total_outflow ?? 0)),
      displayBalance: bankDisplayBalance(b),
      excluded: isBalanceExcluded(b),
      isPG: String(b.account_kind || "nominee") === "payment_gateway",
      overAlert: alertThresholdReached(b),
    };
  }
  // 与后端 bankAlerts.js 的判定口径保持一致：阈值 > 0、运营中、余额 ≥ 阈值。
  // 这里只是给列表加个视觉提示，真正的报警判定在服务端。
  function alertThresholdReached(b) {
    const threshold = Number(b.alert_threshold || 0);
    if (!(threshold > 0)) return false;
    if (!LC.isOperating(b)) return false;
    return Math.round(bankDisplayBalance(b) * 100) >= Math.round(threshold * 100);
  }
  function bankDirectoryStatusHtml(b, stats) {
    const alertFlag = stats.overAlert
      ? '<span class="bk-flag bk-flag-alert" title="余额已达报警阈值">⚠️</span>'
      : "";
    if (stats.isPG) {
      return '<span class="bk-flag bk-flag-pg" title="PaymentGateway balance is excluded from total">PG</span>' + alertFlag;
    }
    return (
      (b.active
        ? '<span class="bk-flag bk-flag-active" title="Active channel">Active</span>'
        : '<span class="bk-flag bk-flag-idle">Inactive</span>') + alertFlag
    );
  }
  function bankDirectoryRowHtml(b, index) {
    const stats = bankDirectoryStats(b);
    const selected = b.id === activeBankId;
    const bankLabel = bankBranchOf(b) || "未命名渠道";
    const accountName = String(b.account_name || "").trim();
    const nameHtml = accountName ? `<div class="bk-channel-sub"><span class="bk-name-label">NAME</span><span translate="no">${esc(accountName)}</span></div>` : "";
    return `<article class="bk-bank-row${selected ? " active" : ""}${stats.isPG ? " bk-bank-row-pg" : ""}" data-id="${b.id}" data-bank-select="${b.id}" tabindex="0" draggable="true" aria-selected="${selected ? "true" : "false"}">
<div class="bk-col-order"><button type="button" class="bk-order-handle" draggable="true" aria-label="Drag ${esc(bankLabel)} to reorder" title="Drag to reorder"><i data-lucide="grip-vertical"></i></button><span class="bk-row-no">${index + 1}</span></div>
<div class="bk-col-channel"><span class="bk-field-group-label bk-channel-label">BANK BRANCH</span><div class="bk-channel-name"><strong translate="no">${esc(bankLabel)}</strong>${bankDirectoryStatusHtml(b, stats)}</div>${nameHtml}<div class="bk-channel-meta"><span class="kind-tag kind-${esc(b.account_kind || "nominee")}">${esc(KIND_LABEL[b.account_kind] || b.account_kind || "人头")}</span></div></div>
<div class="bk-col-info"><span class="bk-field-group-label">银行资料</span>${bankDirectoryInfoHtml(b)}</div>
<div class="bk-col-balance"><div class="bk-metric-grid"><div class="bk-metric bk-metric-balance"><span>BALANCE</span><strong class="bk-row-balance${stats.excluded ? " bk-balance-excluded" : ""}">${fmt(stats.displayBalance)}</strong></div><div class="bk-metric"><span>COUNT</span><strong>${fmtMetric(stats.txCount)}</strong></div><div class="bk-metric bk-metric-outflow"><span>TOTAL OUTFLOW</span><strong>${fmt(stats.outflow)}</strong></div></div>${stats.excluded ? '<span class="bk-row-flow bk-excluded-note">不计入总余额</span>' : ""}</div>
<div class="bk-col-actions"><button type="button" class="bk-copy-btn" data-copy-bank-id="${b.id}" title="Copy complete bank information"><i data-lucide="copy"></i><span>Copy info</span></button></div>
</article>`;
  }
  function renderBankDirectory() {
    const box = document.getElementById("sheet-tabs");
    if (!box) return;
    updateGridTitle();
    if (!bankRows.length) {
      box.innerHTML = `<div class="bk-rail-empty">${esc(tr("还没有支付渠道"))} - ${esc(tr("点右上角「+ 新渠道」添加"))}</div>`;
      return;
    }
    const railBanks = bankRows.filter(LC.isOperating);
    // 只数封禁中的。归档账户已经退役清零，把它们算进「已封渠道」就等于把这个入口
    // 变回一个只会越堆越大的数字——那正是要消灭的东西。
    const bannedCount = bankRows.filter(LC.isBanned).length;
    box.innerHTML = `<section class="bk-directory${directoryOpen ? " is-open" : ""}" aria-label="Payment channels">
<button type="button" class="bk-directory-toggle" aria-expanded="${directoryOpen ? "true" : "false"}" aria-controls="bk-channel-list"><span>渠道列表</span><i data-lucide="chevron-down"></i></button>
<button type="button" class="bk-directory-summary${activeBankId === ALL_BANKS ? " active" : ""}" data-bank-select="all" aria-pressed="${activeBankId === ALL_BANKS ? "true" : "false"}"><span class="bk-summary-kicker">ALL CHANNELS</span><span class="bk-summary-copy"><strong>全部渠道</strong><span>点击渠道行可筛选流水</span></span><span class="bk-summary-balance"><small>总余额</small><strong>${fmt(totalBalance())}</strong></span><span class="bk-summary-count">${railBanks.length} 个渠道</span></button>
<div class="bk-channel-list" id="bk-channel-list" role="list" aria-label="Payment channel list"><div class="bk-channel-list-head" aria-hidden="true"><span class="bk-col-order">排序</span><span class="bk-col-channel">BANK BRANCH / NAME</span><span class="bk-col-info">BSB / ACCOUNT / PAYID</span><span class="bk-col-balance">BALANCE / COUNT / TOTAL OUTFLOW</span><span class="bk-col-actions">操作</span></div>${railBanks.map((b, i) => bankDirectoryRowHtml(b, i)).join("")}</div>
${bannedCount > 0 ? `<button type="button" class="bk-banned-summary" id="rail-banned-btn"><span class="bk-flag bk-flag-banned">封禁</span><span>已封渠道</span><strong>${bannedCount}</strong><small>点击查看详情</small></button>` : ""}
</section>`;
    renderIcons(box);
  }
  function renderTabs() {
    renderBankDirectory();
  }
  function writeBankClipboard(text) {
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
  function copyBankDirectoryInfo(bankId) {
    const bank = bankRows.find((row) => row.id === Number(bankId));
    if (!bank) return;
    writeBankClipboard(bankDirectoryCopyText(bank))
      .then(() => showToast("已复制完整银行资料", { tone: "success" }))
      .catch(() => showToast("复制失败", { tone: "error" }));
  }
  function persistBankDirectoryOrder(ordered) {
    if (bankReorderBusy) return;
    bankReorderBusy = true;
    const visibleIds = new Set(ordered.map((b) => b.id));
    bankRows = ordered.concat(bankRows.filter((b) => !visibleIds.has(b.id)));
    renderTabs();
    const requests = ordered.map((bank, index) => api(`/api/banks/${bank.id}`, {
      method: "PUT",
      body: JSON.stringify({ sort_order: index }),
      bg: true,
    }));
    Promise.all(requests)
      .then(() => loadBanks())
      .then(() => showToast("渠道顺序已保存", { tone: "success" }))
      .catch(() => {
        showToast("渠道顺序保存失败", { tone: "error" });
        return loadBanks().catch(() => {});
      })
      .finally(() => { bankReorderBusy = false; });
  }
  function moveBankDirectoryRow(bankId, targetIndex) {
    if (bankReorderBusy) return;
    const ordered = usableBanks().slice();
    const sourceIndex = ordered.findIndex((b) => b.id === Number(bankId));
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= ordered.length || sourceIndex === targetIndex) return;
    const [moved] = ordered.splice(sourceIndex, 1);
    ordered.splice(targetIndex, 0, moved);
    persistBankDirectoryOrder(ordered);
  }
  function renderDailyPanels() {
    renderBanksPanel();
    renderReconcileAlertV2();
    renderReportPanel();
    renderCstatusPanel();
  }
  function renderBanksPanel() {
    const sumBal = document.getElementById("sum-balance");
    if (sumBal) sumBal.textContent = fmt(totalBalance());
    renderTabs();
  }
  function reportValClass(label, value, isMetric) {
    if (isMetric) return "";
    const v = Number(value || 0);
    if (label === "DEPOSIT" || label === "CASH IN" || (v > 0 && label !== "WITHDRAW" && label !== "CASH OUT" && label !== "EXPENSES" && label !== "WRONG")) {
      return v > 0 ? "report-pos" : "";
    }
    if (v < 0 || label === "WITHDRAW" || label === "CASH OUT" || label === "EXPENSES" || label === "WRONG") {
      return v ? "report-neg" : "";
    }
    return "";
  }
  function renderReportPanel() {
    const tbody = document.getElementById("sheet-report-rows");
    if (!tbody) return;
    const pairs = dailyReport?.reportPairs;
    if (pairs?.length) {
      tbody.innerHTML = pairs.map((p) => {
        const leftCls = reportValClass(p.leftLabel, p.leftValue, false);
        const leftVal = fmtSigned(p.leftValue);
        const right = p.rightLabel
          ? `<td class="report-label">${esc(p.rightLabel)}</td><td class="num-col report-val">${p.rightIsMetric === false ? fmtSigned(p.rightValue) : fmtMetric(p.rightValue)}</td>`
          : `<td></td><td></td>`;
        return `<tr><td class="report-label">${esc(p.leftLabel)}</td><td class="num-col report-val ${leftCls}">${leftVal}</td>${right}</tr>`;
      }).join("");
      return;
    }
    const rows = dailyReport?.reportRows || [];
    tbody.innerHTML = rows.length
      ? rows.map((r) => {
        const val = r.isMetric ? fmtMetric(r.amount) : fmtSigned(r.amount);
        return `<tr><td class="report-label">${esc(r.label)}</td><td class="num-col report-val">${val}</td></tr>`;
      }).join("")
      : '<tr><td colspan="4" class="sheet-empty">—</td></tr>';
  }
  function reconcileScope() {
    const company = document.getElementById("company-select")?.value || "default";
    return `${company}:${sheetDate || ""}`;
  }
  function reconcileAmountKey(value) {
    const amount = Number(value || 0);
    return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
  }
  function reconcileSignature(alerts) {
    return alerts.map((r) => {
      const source = String(r.source_company_id || "").trim();
      const target = String(r.target_company_id || "").trim();
      const name = String(r.name || "").trim();
      if (!source && !target && !name) return "";
      return `${source}:${target}:${name}:${reconcileAmountKey(r.difference)}`;
    }).filter(Boolean).sort().join("|");
  }
  // The previous implementation wrote one key per signature, so every distinct
  // difference left a key behind forever. Sweep them once.
  function purgeLegacyReconcileKeys() {
    try {
      Object.keys(localStorage)
        .filter((k) => k.indexOf("bank-reconcile-ok:") === 0)
        .forEach((k) => localStorage.removeItem(k));
    } catch (_) {}
  }
  function getReconcileAlarm() {
    if (reconcileAlarm) return reconcileAlarm;
    if (typeof window.createEscalatingAlarm !== "function") return null;
    purgeLegacyReconcileKeys();
    reconcileAlarm = window.createEscalatingAlarm({
      soundSrc: RECONCILE_ALARM_SOUND,
      keyPrefix: "bank-reconcile-alarm",
      scope: reconcileScope,
      // renderDailyPanels only runs on the 5 minute loadDailyReport loop, far too
      // coarse to drive escalation, so the alarm ticks itself and asks for a redraw.
      onStageChange: () => renderReconcileAlertV2(),
    });
    return reconcileAlarm;
  }
  function acknowledgeReconcileAlarm() {
    const alarm = getReconcileAlarm();
    if (!alarm) return;
    alarm.acknowledge();
    renderReconcileAlertV2();
  }
  function renderReconcileAlertV2() {
    const box = document.getElementById("reconcile-alert");
    if (!box) return;
    // update() can fire onStageChange, which lands back here; render once.
    if (reconcileRendering) return;
    reconcileRendering = true;
    try {
      renderReconcileAlertBody(box);
    } finally {
      reconcileRendering = false;
    }
  }
  function renderReconcileAlertBody(box) {
    const alerts = dailyReport?.reconcileAlerts || [];
    const alarm = getReconcileAlarm();
    if (!alerts.length) {
      if (alarm) alarm.update("");
      box.hidden = true;
      box.innerHTML = "";
      box.classList.remove("reconcile-alarming");
      return;
    }
    if (alarm) alarm.update(reconcileSignature(alerts));
    const loud = !!alarm && alarm.stage() === "loud";
    box.hidden = false;
    box.classList.toggle("reconcile-alarming", loud);
    const items = alerts.map((r) =>
      `<span class="reconcile-alert-item"><strong>${esc(r.display_name || r.name)}</strong><span>差额 ${fmtSigned(r.difference)}</span><span>IN ${fmtSigned(r.in || 0)}</span><span>OUT ${fmtSigned(r.out || 0)}</span><button type="button" class="btn btn-outline btn-xs reconcile-focus" data-cstatus="${esc(r.name || "")}">查看流水</button></span>`
    ).join("");
    let noteText = "";
    if (loud) noteText = alarm.blocked() ? "点击页面后声音可用" : "";
    else if (alarm && alarm.acked()) noteText = "已暂停，20分钟后复查";
    else noteText = "已记录，5分钟内未处理会提醒";
    const note = noteText ? `<span class="reconcile-alert-note">${noteText}</span>` : "";
    box.innerHTML = `<span class="reconcile-alert-title">检查账目</span><span class="reconcile-alert-text">C STATUS 未对平：</span>${items}${note}<button type="button" class="btn btn-outline btn-xs reconcile-ok">OK</button>`;
  }

  function focusLedgerByCstatus(name) {
    const query = document.getElementById("sheet-search");
    if (!query || !name) return;
    activeBankId = ALL_BANKS;
    const statusFilter = document.getElementById("sheet-status-filter");
    if (statusFilter) statusFilter.value = "";
    query.value = name;
    renderTabs();
    loadSheet().then(() => {
      renderGrid();
      query.focus();
      query.select();
    });
  }

  function renderCstatusPanel() {
    const tbody = document.getElementById("sheet-cstatus-rows");
    if (!tbody) return;
    const rows = dailyReport?.companyRows || [];
    const alertSet = new Set((dailyReport?.reconcileAlerts || []).map((r) => r.name));
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="sheet-empty">No C STATUS today</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((r) => `
      <tr class="${alertSet.has(r.name) ? "cstatus-unbalanced" : ""}">
        <td class="cstatus-name" translate="no">${alertSet.has(r.name) ? `<button type="button" class="cstatus-focus" data-cstatus="${esc(r.name)}">${esc(r.name)}</button>` : esc(r.name)}</td>
        <td class="num-col in-cell ${r.in ? "has-amount" : ""}" translate="no"${r.in ? ` title="${esc(fmtSigned(r.in))}"` : ""}>${r.in ? fmtSigned(r.in) : ""}</td>
        <td class="num-col out-cell ${r.out ? "has-amount" : ""}" translate="no"${r.out ? ` title="${esc(fmtSigned(r.out))}"` : ""}>${r.out ? fmtSigned(r.out) : ""}</td>
        <td class="num-col total-cell ${r.total ? "has-amount" : ""}" translate="no" title="${esc(fmtSigned(r.total))}">${fmtSigned(r.total)}</td>
      </tr>`).join("");
  }

  function populateStatusFilter() {
    const sel = document.getElementById("sheet-status-filter");
    const dl = document.getElementById("status-datalist");
    // STATUS labels come from bank_status_options, which each company edits on
    // the payment-settings page, so they are tenant data even when they read
    // like UI copy. parseStatus/statusLabel also round-trip them back into
    // bank_ledger.status, so they must never be translated.
    if (sel) {
      sel.setAttribute("translate", "no");
      sel.innerHTML = '<option value="">ALL</option>' +
        STATUS_LIST.map((s) => `<option value="${esc(s.value)}">${esc(s.label)}</option>`).join("");
    }
    if (dl) {
      dl.setAttribute("translate", "no");
      dl.innerHTML = STATUS_LIST.map((s) => `<option value="${esc(s.label)}">`).join("");
    }
  }
  function populateCstatusOptions() {
    const dl = document.getElementById("cstatus-datalist");
    if (!dl) return;
    dl.setAttribute("translate", "no"); // bank_c_status_options.name is tenant data
    dl.innerHTML = cStatusNames().map((o) => `<option value="${esc(o)}">`).join("");
  }
  function fillCompanySelects() {
    const opts = '<option value="">—</option>' + companyOptions.map((c) =>
      `<option value="${esc(c.id)}" translate="no">${esc(c.name || c.id)}</option>`
    ).join("");
    const el = document.getElementById("cs-new-company");
    if (!el) return;
    const cur = el.value;
    el.innerHTML = opts;
    el.value = cur;
  }
  function fillBankSelect(selId, includeEmpty) {
    const sel = document.getElementById(selId);
    if (!sel) return;
    const list = usableBanks();
    sel.innerHTML = (includeEmpty ? '<option value="">— 不绑银行 —</option>' : "")
      + list.map((b, i) => `<option value="${b.id}" translate="no">${esc(bankPickerLabel(b, i))}</option>`).join("");
  }

  function openBankModal(row) {
    const listModal = document.getElementById("banks-list-modal");
    bankModalReturnToList = Boolean(listModal?.classList.contains("show"));
    listModal?.classList.remove("show");
    editingBankId = row ? row.id : null;
    document.getElementById("bank-modal-title").textContent = row ? "编辑支付渠道" : "新增支付渠道";
    document.getElementById("f-kind").value = row?.account_kind || "nominee";
    document.getElementById("f-bankbranch").value = bankBranchOf(row);
    document.getElementById("f-name").value = row?.account_name || "";
    document.getElementById("f-bsb").value = row?.bsb || "";
    document.getElementById("f-account").value = row?.account_number || "";
    document.getElementById("f-payid").value = row?.payid || "";
    document.getElementById("f-note").value = row?.note || "";
    // 0 表示未启用，显示为空而不是 "0"，和 placeholder「留空 = 不启用」对齐。
    const threshold = Number(row?.alert_threshold || 0);
    document.getElementById("f-alert-threshold").value = threshold > 0 ? String(threshold) : "";
    document.getElementById("f-reset-daily").checked = Boolean(row?.reset_daily_balance);
    document.getElementById("bank-modal-err").textContent = "";
    document.getElementById("bank-modal").classList.add("show");
    window.requestAnimationFrame(() => document.getElementById("f-bankbranch")?.focus());
  }
  function restoreBanksListModal(focusSelector) {
    // 从编辑弹窗回到列表：保住原来的页签 / 页码 / 搜索词，否则改完一个账户就被甩回
    // 运营中页签的顶部，还得重新找回刚才那一行。
    openBanksListModal({ keepState: true });
    window.requestAnimationFrame(() => {
      (document.querySelector(focusSelector) || document.querySelector(".bkd-tab.active"))?.focus();
    });
  }
  function closeBankModal({ restoreList = true } = {}) {
    const shouldRestoreList = restoreList && bankModalReturnToList;
    document.getElementById("bank-modal").classList.remove("show");
    editingBankId = null;
    bankModalReturnToList = false;
    if (shouldRestoreList) restoreBanksListModal("#add-bank-btn");
  }
  function saveBankModal() {
    const bank_branch = document.getElementById("f-bankbranch").value.trim();
    const account_name = document.getElementById("f-name").value.trim();
    const account_number = document.getElementById("f-account").value.trim();
    const payid = document.getElementById("f-payid").value.trim();
    if (!bank_branch && !account_name && !account_number && !payid) {
      document.getElementById("bank-modal-err").textContent = "请至少填写 BankBranch、NAME、ACCOUNT 或 PAYID 其中一项";
      return;
    }
    const thresholdRaw = document.getElementById("f-alert-threshold").value.replace(/,/g, "").trim();
    if (thresholdRaw && !(Number(thresholdRaw) >= 0)) {
      document.getElementById("bank-modal-err").textContent = "余额上限报警必须是不小于 0 的数字";
      return;
    }
    const body = {
      bank_branch, account_name,
      bsb: document.getElementById("f-bsb").value.trim(),
      account_number, payid,
      note: document.getElementById("f-note").value.trim(),
      account_kind: document.getElementById("f-kind").value,
      reset_daily_balance: document.getElementById("f-reset-daily").checked ? 1 : 0,
      alert_threshold: thresholdRaw ? Number(thresholdRaw) : 0,
    };
    const wasNew = !editingBankId;
    const shouldRestoreList = bankModalReturnToList;
    const url = editingBankId ? `/api/banks/${editingBankId}` : "/api/banks";
    const method = editingBankId ? "PUT" : "POST";
    api(url, { method, body: JSON.stringify(body) })
      .then((d) => {
        closeBankModal({ restoreList: false });
        if (d.row && wasNew) activeBankId = d.row.id;
        return loadBanks().then(loadSheet).then(loadDailyReport).then(() => {
          if (shouldRestoreList) restoreBanksListModal(wasNew ? "#add-bank-btn" : `.bkd-edit-btn[data-id="${d.row?.id || ""}"]`);
        });
      })
      .catch((e) => {
        document.getElementById("bank-modal-err").textContent = e.message || "保存失败，请重试";
      });
  }

  function bkdTxRow(r, dir) {
    const amt = dir === "in"
      ? Number(r.amount_in || 0) + Number(r.trf_amount || 0)
      : Number(r.amount_out || 0) + Number(r.help_amount || 0);
    const name = ledgerNameText(r.name);
    return `<tr>
      <td class="mono">${esc(String(r.entry_time || "").slice(0, 16))}</td>
      <td translate="no"><span class="status-chip ${statusClass(r.status)}">${esc(statusLabel(r.status))}</span></td>
      <td class="mono">${esc(r.tx_id || "")}</td>
      <td class="mono bkd-amt ${dir === "in" ? "bkd-in" : "bkd-out"}">${dir === "in" ? "+" : "-"}${fmt(amt)}</td>
      <td translate="no">${esc(r.username || "")}${name ? ` · ${esc(name)}` : ""}</td>
    </tr>`;
  }

  function bkdTxRowFull(r, dir) {
    const amt = dir === "in"
      ? Number(r.amount_in || 0) + Number(r.trf_amount || 0)
      : Number(r.amount_out || 0) + Number(r.help_amount || 0);
    const user = [r.username, ledgerNameText(r.name), r.c_status].filter(Boolean).join(" · ");
    return `<tr>
      <td class="mono">${esc(String(r.entry_time || "").slice(0, 16))}</td>
      <td translate="no"><span class="status-chip ${statusClass(r.status)}">${esc(statusLabel(r.status))}</span></td>
      <td class="mono">${esc(r.tx_id || "")}</td>
      <td class="mono bkd-amt ${dir === "in" ? "bkd-in" : "bkd-out"}">${dir === "in" ? "+" : "-"}${fmt(amt)}</td>
      <td class="bkd-user-full" translate="no">${esc(user || "-")}</td>
      <td class="bkd-remark-full" translate="no">${esc(r.remark || "")}</td>
    </tr>`;
  }

  function downloadBkdCsv(bank, recentIn, recentOut) {
    const rows = [
      ["DIR", "TIME", "STATUS", "TRANS ID", "AMOUNT", "USERNAME", "NAME", "C STATUS", "REMARK"],
      ...recentIn.map((r) => ["IN", String(r.entry_time || "").slice(0, 16), statusLabel(r.status), r.tx_id || "", Number(r.amount_in || 0) + Number(r.trf_amount || 0), r.username || "", ledgerNameText(r.name), r.c_status || "", r.remark || ""]),
      ...recentOut.map((r) => ["OUT", String(r.entry_time || "").slice(0, 16), statusLabel(r.status), r.tx_id || "", -(Number(r.amount_out || 0) + Number(r.help_amount || 0)), r.username || "", ledgerNameText(r.name), r.c_status || "", r.remark || ""]),
    ];
    const csv = rows.map((row) => row.map((cell) => {
      const text = String(cell ?? "");
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join(",")).join("\r\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${bankBranchOf(bank) || "bank"}-recent-transactions.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // 值一侧全是租户数据（银行名、户名、BSB、账号、PayID、备注、金额），一律 translate="no"：
  // 否则中英切换会去动它们，也挡不住浏览器自带的自动翻译。标签一侧照常翻译。
  function bkdInfoPair(label, val, mono) {
    if (!val && val !== 0) return "";
    return `<div class="bkd-pair"><span class="bkd-pair-label">${esc(label)}</span><span class="bkd-pair-val${mono ? " mono" : ""}" translate="no">${esc(String(val))}</span></div>`;
  }

  function loadBkdDetail(bankId, bodyEl) {
    const b = bankRows.find((r) => r.id === bankId);
    if (!b) return;
    bodyEl.dataset.loaded = "1";
    Promise.all([
      api(`/api/banks/${bankId}/recent-transactions`, { bg: true }),
      api(`/api/banks/${bankId}/events`, { bg: true }),
    ]).then(([txData, evData]) => {
      const recentIn = txData.recentIn || [];
      const recentOut = txData.recentOut || [];
      const events = evData.rows || [];

      const bannedEvent = events.find((e) => e.event === "banned");
      const bannedInfo = bannedEvent
        ? `<div class="bkd-ban-info">封禁于 <strong>${esc(String(bannedEvent.created_at || "").slice(0, 10))}</strong>${bannedEvent.actor ? ` · ${esc(bannedEvent.actor)}` : ""}${bannedEvent.note ? ` · ${esc(bannedEvent.note)}` : ""}</div>`
        : "";

      const infoGrid = `<div class="bkd-info-grid">
        ${bannedInfo}
        ${bkdInfoPair("银行", bankBranchOf(b))}
        ${bkdInfoPair("户名", b.account_name)}
        ${bkdInfoPair("BSB", b.bsb, true)}
        ${bkdInfoPair("账号 ACC", b.account_number, true)}
        ${bkdInfoPair("PayID", b.payid)}
        ${bkdInfoPair("余额", fmt(bankDisplayBalance(b)))}
        ${bkdInfoPair("备注", b.note)}
        <div class="bkd-pair"><span class="bkd-pair-label">状态</span><span class="bkd-pair-val">${
          LC.isArchived(b)
            ? '<span class="bk-flag bk-flag-archived">已归档</span>'
            : LC.isBanned(b)
              ? '<span class="bk-flag bk-flag-banned">封禁中</span>'
              : (b.active ? '<span class="bk-flag bk-flag-active">使用中</span>' : "未启用")
        }</span></div>
      </div>`;

      const txSection = `<div class="bkd-tx-toolbar"><button type="button" class="btn btn-outline btn-xs bkd-download-btn">下载 Excel</button></div><div class="bkd-tx-wrap">
        <div class="bkd-tx-col">
          <div class="bkd-tx-title bkd-tx-in-title">最近 10 笔入账</div>
          ${recentIn.length
            ? `<table class="bkd-tx-table"><thead><tr><th>时间</th><th>STATUS</th><th>TRANS ID</th><th>IN</th><th>USER / NAME / C STATUS</th><th>REMARK</th></tr></thead><tbody>${recentIn.map((r) => bkdTxRowFull(r, "in")).join("")}</tbody></table>`
            : '<p class="bkd-empty">暂无入账记录</p>'}
        </div>
        <div class="bkd-tx-col">
          <div class="bkd-tx-title bkd-tx-out-title">最近 10 笔出账</div>
          ${recentOut.length
            ? `<table class="bkd-tx-table"><thead><tr><th>时间</th><th>STATUS</th><th>TRANS ID</th><th>OUT</th><th>USER / NAME / C STATUS</th><th>REMARK</th></tr></thead><tbody>${recentOut.map((r) => bkdTxRowFull(r, "out")).join("")}</tbody></table>`
            : '<p class="bkd-empty">暂无出账记录</p>'}
        </div>
      </div>`;

      const evList = events.slice(0, 10).map((e) =>
        `<li><strong>${esc(e.event)}</strong><span class="bkd-ev-time"> ${esc(String(e.created_at || "").slice(0, 16))}</span>${e.actor ? ` · ${esc(e.actor)}` : ""}${e.note ? ` · ${esc(e.note)}` : ""}</li>`
      ).join("") || "<li>暂无记录</li>";
      const evSection = `<details class="bkd-events-wrap"><summary>操作历史</summary><ul class="bkd-events-list">${evList}</ul></details>`;

      bodyEl.innerHTML = `<div class="bkd-detail">${infoGrid}${txSection}${evSection}</div>`;
      bodyEl.querySelector(".bkd-download-btn")?.addEventListener("click", () => downloadBkdCsv(b, recentIn, recentOut));
    }).catch(() => {
      bodyEl.innerHTML = '<div class="bkd-empty">加载失败，请重试</div>';
    });
  }

  // 「账户里还剩多少钱」的权威口径：后端 enrichBankRow 塞进来的 balance，就是无上界的
  // balanceFromLedger。待清条和归档按钮的可用性都用它，两者永不打架。
  // 刻意不用 bankDisplayBalance()——那是页面显示口径，对每日归零账户只给当日净额，
  // 拿它判断「清干净了没有」会把累计还有钱的账户当成空的。
  function bankLedgerBalance(b) {
    return Number(b.balance || 0);
  }
  function isBkdCleared(b) {
    return Math.round(bankLedgerBalance(b) * 100) === 0;
  }

  function bkdPredicate(tab) {
    if (tab === "banned") return LC.isBanned;
    if (tab === "archived") return LC.isArchived;
    if (tab === "operating") return LC.isOperating;
    return null;
  }

  function bkdFiltered(tab) {
    const pred = bkdPredicate(tab) || LC.isOperating;
    const q = bkdQuery.trim().toLowerCase();
    return bankRows.filter((b) => {
      if (!pred(b)) return false;
      if (!q) return true;
      return [bankBranchOf(b), b.account_name, b.account_number, b.payid, b.bsb, b.note]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }

  function buildBkdItem(b) {
    const status = LC.statusOf(b);
    const banned = status === "banned";
    const archived = status === "archived";
    const idx = usableBanks().findIndex((x) => x.id === b.id);
    const noTag = idx >= 0 ? `<span class="bk-no">${idx + 1}</span>` : "";
    const excludedNote = isBalanceExcluded(b)
      ? `<span class="bkd-excl-tag">${esc(tr("不计汇总"))}</span>`
      : "";
    const statusTag = archived
      ? `<span class="bk-flag bk-flag-archived">${esc(tr("已归档"))}</span>`
      : banned
        ? `<span class="bk-flag bk-flag-banned">${esc(tr("封禁中"))}</span>`
        : (b.active ? `<span class="bk-flag bk-flag-active">${esc(tr("使用中"))}</span>` : "");

    // 操作按钮按状态分化。已归档行不给编辑、不给「使用中」复选框——服务端已强制
    // active = 0，UI 上也要让「归档即惰性」成立：要改资料先取消归档。
    let acts = "";
    if (archived) {
      acts = `<button type="button" class="btn btn-outline btn-xs bkd-unarchive-btn" data-id="${b.id}">${esc(tr("取消归档"))}</button>`;
    } else if (banned) {
      const archiveBtn = isBkdCleared(b)
        ? `<button type="button" class="btn btn-outline btn-xs bkd-archive-btn" data-id="${b.id}">${esc(tr("归档"))}</button>`
        : `<button type="button" class="btn btn-outline btn-xs bkd-archive-btn" data-id="${b.id}" disabled title="${esc(tr("尚余"))} ${esc(fmt(bankLedgerBalance(b)))} ${esc(tr("待清"))}">${esc(tr("归档"))}</button>`;
      acts =
        `<button type="button" class="btn btn-outline btn-xs bkd-edit-btn" data-id="${b.id}">${esc(tr("编辑"))}</button>`
        + `<button type="button" class="btn btn-outline btn-xs bkd-unban-btn" data-id="${b.id}">${esc(tr("解封"))}</button>`
        + archiveBtn;
    } else {
      acts =
        `<button type="button" class="btn btn-outline btn-xs bkd-edit-btn" data-id="${b.id}">${esc(tr("编辑"))}</button>`
        + `<input type="checkbox" class="bank-active-chk" data-id="${b.id}" title="${esc(tr("使用中（新充值自动入账）"))}"${b.active ? " checked" : ""}>`
        + `<button type="button" class="btn btn-outline btn-xs bkd-ban-btn" data-id="${b.id}">${esc(tr("封禁"))}</button>`;
    }

    const expanded = bkdExpanded.has(b.id);
    const cls = `bkd-item${banned ? " bkd-item-banned" : ""}${archived ? " bkd-item-archived" : ""}`;
    // 银行名与户名是租户数据，必须 translate="no"：否则中英切换会把
    // 「Public Bank Amy」改成「Public 银行 Amy」，顺带也挡住浏览器自带的自动翻译。
    return `<div class="${cls}" data-id="${b.id}">
  <div class="bkd-item-head">
    ${noTag}
    <span class="kind-tag kind-${esc(b.account_kind || "nominee")}">${esc(KIND_LABEL[b.account_kind] || b.account_kind || "人头")}</span>
    <span class="bkd-item-name" translate="no">${esc(bankBranchOf(b) || "Bank")}<span class="bkd-item-sub"> ${esc(b.account_name || "")}</span></span>
    ${statusTag}
    ${excludedNote}
    <span class="bkd-item-bal" translate="no">${fmt(bankDisplayBalance(b))}</span>
    <div class="bkd-item-acts">
      ${acts}
      <button type="button" class="btn btn-outline btn-xs bkd-toggle-btn" data-id="${b.id}" aria-expanded="${expanded ? "true" : "false"}">${expanded ? "▾" : "▸"}</button>
    </div>
  </div>
  <div class="bkd-item-body" id="bkd-body-${b.id}"${expanded ? "" : " hidden"} data-loaded="0">
    <div class="bkd-loading">${esc(tr("加载中..."))}</div>
  </div>
</div>`;
  }

  // \u5e38\u9a7b\u5f85\u6e05\u6761\u3002\u53ea\u770b\u5c01\u7981\u4e2d\u7684\u8d26\u6237\uff1a\u5f52\u6863\u7684\u5df2\u88ab\u95f8\u95e8\u4fdd\u8bc1\u6e05\u96f6\uff0c\u8fd0\u8425\u4e2d\u7684\u672c\u6765\u5c31\u5728\u7528\u3002
  function renderBkdCleanupBar() {
    const bar = document.getElementById("bkd-cleanup-bar");
    if (!bar) return;
    const dirty = bankRows.filter((b) => LC.isBanned(b) && !isBkdCleared(b));
    const total = dirty.reduce((s, b) => s + bankLedgerBalance(b), 0);
    bar.classList.toggle("is-alert", dirty.length > 0);
    bar.classList.toggle("is-clean", dirty.length === 0);
    if (!dirty.length) {
      bar.innerHTML = `<span>${esc(tr("\u5c01\u7981\u4e2d\u65e0\u5f85\u6e05\u7406"))}</span>`;
      return;
    }
    // \u6570\u5b57\u5404\u81ea\u72ec\u7acb\u6210\u8282\u70b9\uff0c\u6587\u672c\u8282\u70b9\u91cc\u4e0d\u6df7\u53d8\u91cf\u2014\u2014i18n \u5f15\u64ce\u6309\u6574\u4e32\u67e5\u5b57\u5178\uff0c\u6df7\u4e86\u5c31\u5f97\u5199
    // phrase \u89c4\u5219\uff0c\u800c\u53cd\u5411\u89c4\u5219\u5f88\u5bb9\u6613\u8bef\u547d\u4e2d\u771f\u5b9e\u6570\u636e\u3002
    bar.innerHTML =
      `<span>${esc(tr("\u5c01\u7981\u4e2d\u5f85\u6e05\u7406"))}</span>`
      + `<strong translate="no">${dirty.length}</strong>`
      + `<span>${esc(tr("\u6237 \u00b7 \u5408\u8ba1"))}</span>`
      + `<strong translate="no">${esc(fmt(total))}</strong>`;
  }

  function renderBkdTabs() {
    const wrap = document.getElementById("bkd-tabs");
    if (!wrap) return;
    const counts = {
      operating: bankRows.filter(LC.isOperating).length,
      banned: bankRows.filter(LC.isBanned).length,
      archived: bankRows.filter(LC.isArchived).length,
    };
    wrap.querySelectorAll(".bkd-tab").forEach((btn) => {
      const tab = btn.dataset.tab;
      const on = tab === bkdTab;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
      btn.tabIndex = on ? 0 : -1;
      // \u8ba1\u6570\u662f\u300c\u8fd9\u4e2a\u72b6\u6001\u4e00\u5171\u51e0\u4e2a\u300d\uff0c\u4e0d\u53d7\u641c\u7d22\u5f71\u54cd\uff1b\u641c\u7d22\u547d\u4e2d\u6570\u7531\u5206\u9875\u5668\u8868\u8fbe\u3002
      // \u539f\u59cb\u6807\u7b7e\u5b58\u8fdb dataset\uff0c\u907f\u514d\u53cd\u590d\u8ffd\u52a0 (n) \u65f6\u628a\u4e0a\u4e00\u6b21\u7684\u62ec\u53f7\u4e5f\u5f53\u6210\u6807\u7b7e\u3002
      if (!btn.dataset.label) btn.dataset.label = btn.textContent.trim().replace(/\s*\(\d+\)$/, "");
      const n = counts[tab] || 0;
      btn.textContent = n > 0 ? `${btn.dataset.label} (${n})` : btn.dataset.label;
    });
  }

  function bkdEmptyText(tab) {
    if (tab === "banned") return tr("\u6682\u65e0\u5c01\u7981\u6e20\u9053");
    if (tab === "archived") return tr("\u6682\u65e0\u5df2\u5f52\u6863\u6e20\u9053");
    return tr("\u6682\u65e0\u8fd0\u8425\u6e20\u9053");
  }

  function renderBkdPanel() {
    const panel = document.getElementById("bkd-panel");
    if (!panel) return;
    const rows = bkdFiltered(bkdTab);
    // \u9875\u7801\u94b3\u4f4d\u5fc5\u987b\u5728\u5207\u7247\u4e4b\u524d\uff1a\u5f52\u6863\u6389\u6700\u540e\u4e00\u9875\u6700\u540e\u4e00\u884c\u4e4b\u540e\u9875\u7801\u4f1a\u8d85\u754c\uff0c\u5426\u5219\u9762\u677f\u7a7a\u767d
    // \u800c\u5206\u9875\u5668\u8fd8\u505c\u5728\u7b2c 3 \u9875\u3002
    const pages = Math.max(1, Math.ceil(rows.length / BKD_PAGE_SIZE));
    const page = Math.min(Math.max(1, bkdPage[bkdTab] || 1), pages);
    bkdPage[bkdTab] = page;
    const slice = rows.slice((page - 1) * BKD_PAGE_SIZE, page * BKD_PAGE_SIZE);

    panel.innerHTML = slice.length
      ? slice.map(buildBkdItem).join("")
      : `<div class="bkd-empty">${esc(bkdQuery.trim() ? tr("\u6ca1\u6709\u5339\u914d\u7684\u6e20\u9053") : bkdEmptyText(bkdTab))}</div>`;

    // \u8d26\u6237\u5c11\u4e8e\u4e00\u9875\u65f6 renderClientPager \u81ea\u5df1\u9690\u85cf\uff0c\u6240\u4ee5\u73b0\u72b6\u4e0b\u96f6\u89c6\u89c9\u4ee3\u4ef7\uff0c\u89c4\u6a21\u957f\u4e0a\u53bb\u81ea\u52a8\u751f\u6548\u3002
    renderClientPager("bkd-pager", rows.length, page, BKD_PAGE_SIZE, (p) => {
      bkdPage[bkdTab] = p;
      renderBkdPanel();
      panel.scrollTop = 0;
    });
    renderIcons(panel);

    // \u5c55\u5f00\u72b6\u6001\u8de8\u5206\u9875\u4e0e\u9875\u7b7e\u4fdd\u7559\uff0c\u660e\u7ec6\u6bcf\u6b21\u91cd\u65b0\u62c9\uff1a\u4f59\u989d\u548c\u6700\u8fd1\u6d41\u6c34\u6b63\u662f\u5c01\u7981 / \u5ba1\u6279\u4e4b\u540e
    // \u4f1a\u53d8\u7684\u4e1c\u897f\uff0c\u5728\u8fd9\u91cc\u505a\u7f13\u5b58\u7b49\u4e8e\u62ff\u6570\u636e\u51c6\u786e\u6362\u4e00\u6b21\u7f51\u7edc\u8bf7\u6c42\u3002
    slice.forEach((b) => {
      if (!bkdExpanded.has(b.id)) return;
      const bodyEl = document.getElementById(`bkd-body-${b.id}`);
      if (bodyEl && bodyEl.dataset.loaded === "0") loadBkdDetail(b.id, bodyEl);
    });
  }

  function switchBkdTab(tab) {
    if (!bkdPredicate(tab)) return;
    bkdTab = tab;
    renderBkdTabs();
    renderBkdPanel();
    const panel = document.getElementById("bkd-panel");
    if (panel) panel.scrollTop = 0;
  }

  // opts.tab \u6307\u5b9a\u8fdb\u6765\u65f6\u505c\u5728\u54ea\u4e2a\u9875\u7b7e\uff1bopts.keepState \u7528\u4e8e\u300c\u64cd\u4f5c\u5b8c\u91cd\u5f00\u300d\u2014\u2014\u4fdd\u4f4f\u9875\u7b7e\u3001
  // \u9875\u7801\u3001\u641c\u7d22\u8bcd\u548c\u5c55\u5f00\u72b6\u6001\uff0c\u5426\u5219\u6bcf\u70b9\u4e00\u6b21\u5c01\u7981\u90fd\u4f1a\u88ab\u7529\u56de\u8fd0\u8425\u4e2d\u9875\u7b7e\u7684\u9876\u90e8\u3002
  //
  // \u4e09\u9875\u7b7e\u7684\u7ed3\u6784\u6027\u4f5c\u7528\uff1a\u540c\u4e00\u65f6\u523b\u53ea\u6e32\u67d3\u4e00\u4e2a\u9875\u7b7e\uff0c\u6240\u4ee5\u5c01\u7981\u7684\u6e20\u9053\u518d\u591a\u4e5f\u4e0d\u53ef\u80fd\u628a\u8fd0\u8425\u4e2d
  // \u7684\u6324\u51fa\u89c6\u91ce\u3002\u8fd9\u4e0d\u662f\u9760\u300c\u9ed8\u8ba4\u6298\u53e0\u300d\u7684\u81ea\u89c9\uff0c\u662f\u7269\u7406\u4e0a\u505a\u4e0d\u5230\u3002
  function openBanksListModal(opts) {
    const o = opts || {};
    if (!o.keepState) {
      bkdTab = o.tab || "operating";
      bkdPage.operating = 1;
      bkdPage.banned = 1;
      bkdPage.archived = 1;
      bkdQuery = "";
      bkdExpanded.clear();
      const search = document.getElementById("bkd-search");
      if (search) search.value = "";
    }
    renderBkdCleanupBar();
    renderBkdTabs();
    renderBkdPanel();
    document.getElementById("banks-list-modal").classList.add("show");
  }

  // \u5c01\u7981 / \u89e3\u5c01 / \u5f52\u6863 / \u53d6\u6d88\u5f52\u6863 / \u52fe\u9009\u4f7f\u7528\u4e2d\u7edf\u4e00\u8d70\u8fd9\u91cc\uff1a\u5b58\u8fd8\u6eda\u52a8\u4f4d\u7f6e\u3001\u4fdd\u4f4f\u9875\u7b7e\uff0c
  // \u5e76\u628a\u7126\u70b9\u515c\u5e95\u5230\u5f53\u524d\u9875\u7b7e\u6309\u94ae\u2014\u2014\u5f52\u6863\u6210\u529f\u540e\u90a3\u4e00\u884c\u4f1a\u79bb\u5f00\u5f53\u524d\u9875\u7b7e\uff0cfocusSelector
  // \u67e5\u4e0d\u5230\uff0c\u7126\u70b9\u5c31\u4f1a\u6389\u5230 <body>\uff0c\u952e\u76d8\u64cd\u4f5c\u7684\u4eba\u4f1a\u4e22\u5931\u4f4d\u7f6e\u3002
  function bkdMutate(promise, focusSelector) {
    const panel = document.getElementById("bkd-panel");
    const top = panel ? panel.scrollTop : 0;
    return promise
      .then(() => loadBanks())
      .then(() => {
        openBanksListModal({ keepState: true });
        const p = document.getElementById("bkd-panel");
        if (p) p.scrollTop = top;
        const el = focusSelector ? document.querySelector(focusSelector) : null;
        (el || document.querySelector(".bkd-tab.active"))?.focus();
      })
      .then(() => loadDailyReport())
      .catch((e) => {
        if (e && e.cancelled) return;
        showToast(e?.message || tr("\u64cd\u4f5c\u5931\u8d25"), { tone: "error" });
      });
  }

  function deletedHelpTrfAmount(r) {
    return Number(r.help_amount || 0) + Number(r.trf_amount || 0);
  }
  function renderDeletedLedgerRows(rows) {
    const tbody = document.getElementById("deleted-ledger-rows");
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="sheet-empty">暂无最近删除流水</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((r) => {
      const bankName = bankBranchOf(r) || r.bank_acc || "";
      const userName = [r.username, ledgerNameText(r.name)].filter(Boolean).join(" · ");
      return `<tr data-id="${r.id}">
        <td class="mono">${esc(String(r.deleted_at || "").slice(0, 16))}</td>
        <td class="mono">${esc(String(r.entry_time || "").slice(0, 16))}</td>
        <td translate="no"><span class="status-chip ${statusClass(r.status)}">${esc(statusLabel(r.status))}</span></td>
        <td class="mono">${esc(r.tx_id || "")}</td>
        <td class="num-col">${Number(r.amount_in || 0) ? fmt(r.amount_in) : ""}</td>
        <td class="num-col out-cell">${Number(r.amount_out || 0) ? "-" + fmt(Math.abs(r.amount_out)) : ""}</td>
        <td class="num-col">${deletedHelpTrfAmount(r) ? fmt(deletedHelpTrfAmount(r)) : ""}</td>
        <td translate="no">${esc(bankName)}</td>
        <td translate="no">${esc(userName)}</td>
        <td><button type="button" class="btn btn-success btn-xs deleted-restore" data-id="${r.id}">恢复</button></td>
      </tr>`;
    }).join("");
  }
  function loadDeletedLedgerRows() {
    const tbody = document.getElementById("deleted-ledger-rows");
    if (tbody) tbody.innerHTML = '<tr><td colspan="10" class="sheet-empty">加载中...</td></tr>';
    return api("/api/banks/ledger/deleted?limit=80", { bg: true })
      .then((d) => renderDeletedLedgerRows(d.rows || []))
      .catch((e) => {
        if (tbody) tbody.innerHTML = `<tr><td colspan="10" class="sheet-empty">加载失败：${esc(e.message || "请重试")}</td></tr>`;
      });
  }
  function openDeletedLedgerModal() {
    document.getElementById("deleted-ledger-modal")?.classList.add("show");
    loadDeletedLedgerRows();
  }
  function restoreDeletedLedger(id) {
    if (!id) return;
    requestOperationReason({
      title: "恢复流水",
      description: "恢复后会重算银行余额，并写入永久审计记录。",
      target: `已删除流水 #${id}`,
      confirmLabel: "确认恢复",
    }).then((reason) => {
      if (!reason) return null;
      return api(`/api/banks/ledger/deleted/${id}/restore`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }).then(() => {
        showToast("已恢复流水", { tone: "success" });
        return loadBanks().then(loadSheet).then(loadDailyReport).then(loadDeletedLedgerRows);
      }).catch((error) => showToast(error.message || "恢复失败", { tone: "error" }));
    });
  }

  function loadBankEvents(id) {
    const bodyEl = document.getElementById(`bkd-body-${id}`);
    if (bodyEl) loadBkdDetail(id, bodyEl);
  }

  function setupAC(inputId, dropId, field) {
    const inp = document.getElementById(inputId);
    if (!inp) return;
    inp.addEventListener("input", () => {
      api(`/api/banks/suggestions?field=${field}&q=${encodeURIComponent(inp.value.trim())}`, { bg: true })
        .then((d) => {
          const el = document.getElementById(dropId);
          if (!el) return;
          const items = d.suggestions || [];
          if (!items.length) { el.style.display = "none"; return; }
          // 定位策略交给 CSS，这里只配合：
          // 表格里的下拉是 position:fixed（.ac-sheet），要逃出 .sheet-table-wrap 的滚动
          // 容器，所以得写视口坐标；modal 里的是 absolute，靠 CSS 的 top/left 贴住
          // .ac-wrap。对后者绝不能写 inline 坐标 —— .modal 带 transform + backdrop-filter，
          // 会成为 containing block，视口坐标等于把 .modal 的位置再加一次（实测偏
          // 464×47px，下拉直接跑到 modal 外面，用户看不到任何补全建议）。
          const rect = inp.getBoundingClientRect();
          if (getComputedStyle(el).position === "fixed") {
            el.style.left = `${rect.left}px`;
            el.style.top = `${rect.bottom + 2}px`;
            el.style.width = `${Math.max(rect.width, 120)}px`;
          } else {
            el.style.left = "";
            el.style.top = "";
            el.style.width = "";
          }
          el.innerHTML = items.map((s) => `<li class="ac-item">${esc(s)}</li>`).join("");
          el.style.display = "block";
          el.querySelectorAll(".ac-item").forEach((li) => {
            li.addEventListener("mousedown", (e) => {
              e.preventDefault();
              inp.value = li.textContent;
              el.style.display = "none";
            });
          });
        });
    });
    inp.addEventListener("blur", () => {
      setTimeout(() => {
        const el = document.getElementById(dropId);
        if (el) el.style.display = "none";
      }, 150);
    });
  }

  function openPendingModal(initialTab) {
    const tabs = document.querySelector(".pending-tabs");
    if (tabs) {
      tabs.setAttribute("role", "tablist");
      tabs.setAttribute("aria-label", "\u5f85\u5ba1\u6279\u7c7b\u578b");
    }
    document.getElementById("pending-modal").classList.add("show");
    loadPendingPanels().then(() => {
      if (initialTab) switchPendingTab(initialTab);
    });
  }
  function switchPendingTab(tab) {
    document.querySelectorAll(".pending-tab").forEach((b) => {
      const active = b.dataset.tab === tab;
      b.classList.toggle("active", active);
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", active ? "true" : "false");
      b.tabIndex = active ? 0 : -1;
    });
    const txPanel = document.getElementById("pending-tx-panel");
    const skippedPanel = document.getElementById("pending-skipped-panel");
    if (txPanel) {
      txPanel.hidden = tab !== "tx";
      txPanel.style.display = tab === "tx" ? "" : "none";
    }
    if (skippedPanel) {
      skippedPanel.hidden = tab !== "skipped";
      skippedPanel.style.display = tab === "skipped" ? "" : "none";
    }
    if (tab === "tx" && typeof window.acknowledgePlatformPendingSound === "function") {
      window.acknowledgePlatformPendingSound();
    }
  }
  function setPendingTabCounts(txCount, skippedCount) {
    lastSkippedPendingCount = Number(skippedCount || 0);
    updatePendingWorkspaceSummary(txCount, skippedCount);
    document.querySelectorAll(".pending-tab").forEach((b) => {
      const tab = b.dataset.tab;
      const n = tab === "skipped" ? skippedCount : txCount;
      const base = tab === "skipped" ? "已跳过" : "平台订单";
      b.textContent = n > 0 ? `${base} (${n})` : base;
    });
  }
  function bankOptionsHtml(selected) {
    return '<option value="">—</option>' + usableBanks().map((b, i) =>
      `<option value="${b.id}" translate="no"${String(selected) === String(b.id) ? " selected" : ""}>${esc(bankPickerLabel(b, i))}</option>`
    ).join("");
  }
  function pendingBankRankCompanyId() {
    return String(document.getElementById("company-select")?.value || "").trim();
  }
  function pendingBankRankStorageKey(companyId = pendingBankRankCompanyId()) {
    return companyId ? `${PENDING_BANK_RANK_STORAGE_PREFIX}${companyId}` : "";
  }
  function lastPendingBankId(companyId = pendingBankRankCompanyId()) {
    const key = pendingBankRankStorageKey(companyId);
    if (!key) return 0;
    try {
      const bankId = Number(localStorage.getItem(key) || 0);
      if (bankId && usableBanks().some((b) => b.id === bankId)) return bankId;
      if (bankId) localStorage.removeItem(key);
    } catch (_) {}
    return 0;
  }
  function rememberPendingBank(bankId, companyId = pendingBankRankCompanyId()) {
    const id = Number(bankId || 0);
    const key = pendingBankRankStorageKey(companyId);
    if (!id || !key || !usableBanks().some((b) => b.id === id)) return;
    try { localStorage.setItem(key, String(id)); } catch (_) {}
  }
  function pendingBankOptionsHtml() {
    const banks = usableBanks().slice();
    const lastBankId = lastPendingBankId();
    const lastBankIndex = banks.findIndex((b) => b.id === lastBankId);
    if (lastBankIndex > 0) banks.unshift(banks.splice(lastBankIndex, 1)[0]);
    return '<option value="">—</option>' + banks.map((b, i) =>
      `<option value="${b.id}" translate="no">${esc(bankPickerLabel(b, i))}</option>`
    ).join("");
  }
  function loadPendingPanels() {
    return Promise.all([
      api("/api/banks/pending-tx", { bg: true }),
      api("/api/banks/pending-tx/skipped?limit=100", { bg: true }),
    ]).then(([tx, skipped]) => {
      const txRows = tx.rows || [];
      const skippedRows = skipped.rows || [];
      setPendingTabCounts(txRows.length, skippedRows.length);
      const activeTab = document.querySelector(".pending-tab.active")?.dataset.tab;
      if (!activeTab) switchPendingTab(txRows.length ? "tx" : (skippedRows.length ? "skipped" : "tx"));
      else switchPendingTab(activeTab);

      const txBody = document.getElementById("pending-tx-rows");
      const defaultPendTime = nowTime();
      txBody.innerHTML = txRows.map((r) => {
        const isWd = r.tx_type === "WITHDRAW";
        const pendTime = timeFromSql(r.tx_time, defaultPendTime);
        const pendDate = dateFromSql(r.tx_time, sheetDate || todaySydney());
        const pendName = ledgerNameText(r.name);
        return `<tr data-txid="${esc(r.tx_id)}" data-tx-time="${esc(r.tx_time || "")}" data-pending-amount="${esc(r.amount)}">
          <td translate="no">${esc(r.tx_type)}</td>
          <td><div class="pend-datetime"><label class="pend-date" title="调整入账日期（平台日期 ${esc(pendDate)}）"><span class="pend-date-label" aria-hidden="true">${esc(compactDateLabel(pendDate))}</span><input class="pend-date-input" type="date" value="${esc(pendDate)}" aria-label="入账日期，平台原始日期 ${esc(pendDate)}"></label><input class="pend-time" type="time" step="60" value="${esc(pendTime)}" title="${esc(r.tx_time || "")}" aria-label="入账时间"></div></td>
          <td class="mono" translate="no">${esc(r.tx_id)}</td>
          <td translate="no">${esc(r.username)} / ${esc(pendName)}</td>
          <td>${fmt(r.amount)}</td>
          <td>${isWd
             ? `<select class="pend-mode"><option value="bank">本户</option><option value="help">调钱</option><option value="split">拆分调钱</option><option value="redeposit">REDEP</option></select>
               <div class="pend-help-summary" hidden role="status" aria-label="调钱方向和状态"><strong>IN</strong><span translate="no">${esc(statusLabel("cash in") || "CASH IN")}</span></div>`
            : `<select class="pend-mode"><option value="bank">本户</option><option value="redeposit">REDEP</option></select>`}</td>
          <td>${isWd
             ? `<select class="pend-bank">${pendingBankOptionsHtml()}</select>
               <input class="pend-cstatus" list="cstatus-datalist" aria-label="调钱 C STATUS" placeholder="C STATUS / multiple ok" hidden>
               <div class="pend-split-panel" hidden>
                 <div class="pend-split-summary"><span>已分配 <b class="pend-split-total">0.00</b> / ${esc(fmt(r.amount))}</span><span class="pend-split-remaining">剩余 ${esc(fmt(r.amount))}</span></div>
                 <div class="pend-split-self-label">本户自付</div>
                 <div class="pend-split-columns pend-split-self-columns"><span>BANK</span><span>AMT</span></div>
                 <div class="pend-split-self">
                   <select class="pend-split-self-bank" aria-label="本户自付银行账户">${bankOptionsHtml()}</select>
                   <input class="pend-split-self-amount" inputmode="decimal" aria-label="本户自付金额" placeholder="0.00">
                 </div>
                 <div class="pend-split-columns"><span>C STATUS</span><span>AMT</span><span></span></div>
                 <div class="pend-split-rows"></div>
                 <button type="button" class="btn btn-outline btn-xs pend-split-add">+ 添加协助方</button>
                 <p class="pend-split-error" role="alert" aria-live="polite"></p>
               </div>`
            : `<select class="pend-bank">${pendingBankOptionsHtml()}</select>`}</td>
          <td><input class="pend-remark" placeholder="REMARK"></td>
          <td>
            <button type="button" class="btn btn-success btn-xs pend-approve">审批</button>
            <button type="button" class="btn btn-outline btn-xs pend-skip">跳过</button>
          </td>
        </tr>`;
      }).join("") || '<tr><td colspan="9" class="sheet-empty">暂无待审批平台单</td></tr>';

      txBody.querySelectorAll("tr[data-txid]").forEach((tr) => {
        const mode = tr.querySelector(".pend-mode");
        const dateInput = tr.querySelector(".pend-date-input");
        const syncPendingDateLabel = () => {
          const date = dateInput?.value || dateFromSql(tr.dataset.txTime, sheetDate || todaySydney());
          const label = tr.querySelector(".pend-date-label");
          if (label) label.textContent = compactDateLabel(date);
          const control = tr.querySelector(".pend-date");
          if (control) control.title = `调整入账日期（平台日期 ${dateFromSql(tr.dataset.txTime, date)}）`;
        };
        dateInput?.addEventListener("input", syncPendingDateLabel);
        dateInput?.addEventListener("change", syncPendingDateLabel);
        const syncHelp = () => {
          const help = mode && mode.value === "help";
          const split = mode && mode.value === "split";
          const redeposit = mode && mode.value === "redeposit";
          tr.querySelector(".pend-help-summary")?.toggleAttribute("hidden", !help);
          tr.querySelector(".pend-cstatus")?.toggleAttribute("hidden", !help);
          const bank = tr.querySelector(".pend-bank");
          if (bank) bank.hidden = help || split || redeposit;
          const splitPanel = tr.querySelector(".pend-split-panel");
          if (splitPanel) splitPanel.hidden = !split;
          if (split) {
            const splitRows = tr.querySelector(".pend-split-rows");
            if (splitRows && !splitRows.children.length) {
              addPendingSplitRow(tr);
            }
            updatePendingSplitState(tr);
          } else {
            const approve = tr.querySelector(".pend-approve");
            if (approve) approve.disabled = false;
          }
        };
        mode?.addEventListener("change", syncHelp);
        tr.querySelector(".pend-split-add")?.addEventListener("click", () => {
          addPendingSplitRow(tr);
          updatePendingSplitState(tr);
        });
        tr.querySelector(".pend-split-self-amount")?.addEventListener("input", () => updatePendingSplitState(tr));
        tr.querySelector(".pend-split-self-bank")?.addEventListener("change", () => updatePendingSplitState(tr));
        tr.querySelector(".pend-split-rows")?.addEventListener("input", () => updatePendingSplitState(tr));
        tr.querySelector(".pend-split-rows")?.addEventListener("click", (event) => {
          if (!event.target.closest(".pend-split-remove")) return;
          event.target.closest(".pend-split-row")?.remove();
          updatePendingSplitState(tr);
        });
        syncHelp();
      });

      const skippedBody = document.getElementById("pending-skipped-rows");
      if (skippedBody) {
        skippedBody.innerHTML = skippedRows.map((r) => {
          const skippedName = ledgerNameText(r.name);
          return `
          <tr data-txid="${esc(r.tx_id)}">
            <td translate="no">${esc(r.tx_type)}</td>
            <td class="mono">${esc(String(r.tx_time || "").slice(0, 16))}</td>
            <td class="mono" translate="no">${esc(r.tx_id)}</td>
            <td translate="no">${esc(r.username)} / ${esc(skippedName)}</td>
            <td class="num-col">${fmt(r.amount)}</td>
            <td class="mono">${esc(String(r.decided_at || "").slice(0, 16))}</td>
            <td>${esc(r.decided_by || "")}</td>
            <td>
              <button type="button" class="btn btn-success btn-xs pend-restore">Restore</button>
              <button type="button" class="btn btn-danger btn-xs pend-delete">删除</button>
            </td>
          </tr>`;
        }).join("") || '<tr><td colspan="8" class="sheet-empty">No skipped platform orders</td></tr>';
      }
    });
  }
  function addPendingSplitRow(tr, values = {}) {
    const container = tr?.querySelector(".pend-split-rows");
    if (!container) return null;
    const row = document.createElement("div");
    row.className = "pend-split-row";
    row.innerHTML = `<input class="pend-split-cstatus" list="cstatus-datalist" value="${esc(values.c_status || "")}" aria-label="协助方 C STATUS" placeholder="例如 EZ">
      <input class="pend-split-amount" inputmode="decimal" value="${esc(values.amount || "")}" aria-label="协助金额" placeholder="金额">
      <button type="button" class="btn btn-outline btn-xs pend-split-remove" title="删除协助方" aria-label="删除协助方">${renderIcon("x", { size: 14 })}</button>`;
    container.appendChild(row);
    return row;
  }

  function pendingSplitRows(tr) {
    return [...(tr?.querySelectorAll(".pend-split-row") || [])].map((row) => ({
      c_status: row.querySelector(".pend-split-cstatus")?.value.trim() || "",
      amount: row.querySelector(".pend-split-amount")?.value.trim() || "",
    }));
  }

  function updatePendingSplitState(tr) {
    const rows = pendingSplitRows(tr);
    const targetCents = Math.round(parseNum(tr?.dataset.pendingAmount || 0) * 100);
    const selfAmountCents = Math.round(parseNum(tr?.querySelector(".pend-split-self-amount")?.value || 0) * 100);
    const selfBank = tr?.querySelector(".pend-split-self-bank");
    const seen = new Set();
    let helperTotalCents = 0;
    let invalid = false;
    let duplicate = false;
    rows.forEach((row) => {
      const key = row.c_status.toLowerCase();
      const amountCents = Math.round(parseNum(row.amount) * 100);
      if (!row.c_status || amountCents <= 0) invalid = true;
      if (key && seen.has(key)) duplicate = true;
      if (key) seen.add(key);
      helperTotalCents += amountCents;
    });
    const totalCents = selfAmountCents + helperTotalCents;
    const remainingCents = targetCents - totalCents;
    const totalEl = tr?.querySelector(".pend-split-total");
    const remainingEl = tr?.querySelector(".pend-split-remaining");
    const errorEl = tr?.querySelector(".pend-split-error");
    if (selfBank) selfBank.disabled = selfAmountCents <= 0;
    if (totalEl) totalEl.textContent = fmt(totalCents / 100);
    if (remainingEl) {
      remainingEl.textContent = remainingCents >= 0
        ? `剩余 ${fmt(remainingCents / 100)}`
        : `超出 ${fmt(Math.abs(remainingCents) / 100)}`;
    }
    let error = "";
    if (selfAmountCents > 0 && !selfBank?.value) error = "请选择本户自付银行账户";
    else if (invalid) error = "请填写每个协助方和金额";
    else if (duplicate) error = "C STATUS 不能重复";
    else if (selfAmountCents > targetCents) error = `本户自付不能超过 ${fmt(targetCents / 100)}`;
    else if (rows.length < 1) error = "请至少添加 1 个协助方";
    else if ((selfAmountCents > 0 ? 1 : 0) + rows.length < 2) error = "请至少填写 2 个分配项";
    else if (remainingCents > 0) error = `还差 ${fmt(remainingCents / 100)}`;
    else if (remainingCents < 0) error = `超出 ${fmt(Math.abs(remainingCents) / 100)}`;
    if (errorEl) errorEl.textContent = error;
    const approve = tr?.querySelector(".pend-approve");
    const splitMode = tr?.querySelector(".pend-mode")?.value === "split";
    const allocationCount = (selfAmountCents > 0 ? 1 : 0) + rows.length;
    const valid = splitMode && rows.length >= 1 && allocationCount >= 2 && !invalid && !duplicate
      && (selfAmountCents <= 0 || !!selfBank?.value) && selfAmountCents <= targetCents && remainingCents === 0;
    if (approve && splitMode) {
      approve.disabled = !valid;
      approve.title = valid ? "按拆分金额审批" : (error || "请完成拆分");
    }
    return valid;
  }

  const TRANSFER_DEFAULT_STATUS = { in: "bank transfer", out: "bank trf" };

  function parseTransferAmount(value) {
    const text = String(value ?? "").replace(/,/g, "").trim();
    if (!text) return { state: "empty", text };
    if (text === "+" || text === "-") return { state: "partial", text };
    if (!/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))$/.test(text)) {
      return { state: "invalid", text };
    }
    const amount = Number(text);
    if (!Number.isFinite(amount)) return { state: "invalid", text };
    if (amount === 0) return { state: "zero", text, amount };
    return {
      state: "valid",
      text,
      amount,
      direction: amount < 0 ? "out" : "in",
      magnitudeText: text.replace(/^[+-]/, ""),
    };
  }

  function setTransferStatusOptions(direction, preferredStatus) {
    const st = document.getElementById("trf-status");
    if (!st || !direction) return "";
    const list = direction === "in" ? IN_HELP_STATUSES : OUT_HELP_STATUSES;
    const current = String(st.value || "").trim();
    st.innerHTML = list.map((s) => `<option value="${esc(s)}">${esc(statusLabel(s) || s)}</option>`).join("");
    const wanted = String(preferredStatus || "").trim();
    const selected = list.includes(wanted)
      ? wanted
      : (list.includes(current) ? current : TRANSFER_DEFAULT_STATUS[direction]);
    st.value = selected;
    st.disabled = false;
    return selected;
  }

  function resetTransferStatus() {
    const st = document.getElementById("trf-status");
    if (!st) return;
    st.innerHTML = '<option value="">请先输入金额</option>';
    st.value = "";
    st.disabled = true;
  }

  function renderTransferPreview(parsed) {
    const preview = document.getElementById("trf-dir-preview");
    const state = document.getElementById("trf-dir-state");
    const detail = document.getElementById("trf-dir-detail");
    const title = document.getElementById("trf-title");
    if (!preview || !state || !detail) return;

    if (parsed?.state === "valid") {
      const directionLabel = parsed.direction === "in" ? "调入 IN" : "调出 OUT";
      const signedMagnitude = `${parsed.direction === "in" ? "+" : "-"}${parsed.magnitudeText}`;
      const status = document.getElementById("trf-status")?.value || TRANSFER_DEFAULT_STATUS[parsed.direction];
      preview.dataset.direction = parsed.direction;
      state.textContent = directionLabel;
      detail.textContent = `金额 ${signedMagnitude} · STATUS ${statusLabel(status) || status}`;
      if (title) title.textContent = directionLabel;
      return;
    }

    preview.dataset.direction = "empty";
    state.textContent = "输入金额";
    detail.textContent = parsed?.state === "invalid"
      ? "格式示例：100 或 -100"
      : "正数 = IN · 负数 = OUT";
    if (title) title.textContent = "HELP TRF";
  }

  function syncTransferFormForAmount() {
    const parsed = parseTransferAmount(document.getElementById("trf-amount")?.value);
    if (parsed.state === "valid") {
      const status = document.getElementById("trf-status")?.value || "";
      trfDirection = parsed.direction;
      setTransferStatusOptions(parsed.direction, status);
    } else {
      trfDirection = "";
      resetTransferStatus();
    }
    renderTransferPreview(parsed);
    return parsed;
  }

  function openTransferModal() {
    trfDirection = "";
    fillBankSelect("trf-bank", true);
    fillCompanySelects();
    resetTransferStatus();
    const setVal = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.value = v;
    };
    setVal("trf-time", nowTime());
    setVal("trf-amount", "");
    setVal("trf-name", "");
    setVal("trf-remark", "");
    setVal("trf-cstatus", "");
    const err = document.getElementById("trf-err");
    if (err) err.textContent = "";
    syncTransferFormForAmount();
    // Prefer active bank card when opening transfer form
    const bankSel = document.getElementById("trf-bank");
    if (bankSel && activeBankId !== ALL_BANKS && activeBankId) {
      bankSel.value = String(activeBankId);
    }
    document.getElementById("transfer-modal")?.classList.add("show");
  }

  function openCstatusModal() {
    renderCstatusManage();
    fillCompanySelects();
    const nameInput = document.getElementById("cs-new-name");
    const companySelect = document.getElementById("cs-new-company");
    if (nameInput) nameInput.value = "";
    if (companySelect) companySelect.value = "";
    document.getElementById("cstatus-modal").classList.add("show");
  }
  function renderCstatusManage() {
    const tbody = document.getElementById("cs-rows");
    tbody.innerHTML = cStatusOptions.map((o) => `
      <tr data-name="${esc(o.name)}">
        <td translate="no">${esc(o.name)}</td>
        <td translate="no">${esc(o.target_company_id || "")}</td>
        <td><input type="checkbox" class="cs-reconcile" aria-label="需要对平"${o.target_company_id ? "" : " disabled"}${Number(o.reconcile_required) ? " checked" : ""}></td>
        <td><button type="button" class="btn btn-outline btn-xs cs-del" data-name="${esc(o.name)}">删</button></td>
      </tr>`).join("") || '<tr><td colspan="4">—</td></tr>';
  }

  function reloadAll() {
    return loadStatusOptions()
      .then(loadCStatus)
      .then(loadBanks)
      .then(() => Promise.all([loadSheet(), loadDailyReport(), refreshPendingBadge(), refreshWorkspaceContext()]));
  }

  function refreshSharedWorkspace() {
    if (document.hidden || isGridBusy() || sharedRefreshInFlight) return Promise.resolve();
    sharedRefreshInFlight = true;
    return loadBanks()
      .then(() => Promise.all([loadSheet(), loadDailyReport(), refreshPendingBadge()]))
      .catch(() => {})
      .finally(() => { sharedRefreshInFlight = false; });
  }

  const MOBILE_TAB_ACTIONS = ["pending", "ledger", "transfer", "channels"];
  function runMobileTab(action) {
    if (action === "pending") openPendingModal();
    else if (action === "transfer") openTransferModal();
    else if (action === "channels") openBanksListModal({ tab: "operating" });
    else if (action === "ledger") document.querySelector(".bkv2 .bk-grid-head")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function runMobileTabFromHash() {
    const action = String(location.hash || "").slice(1);
    if (!MOBILE_TAB_ACTIONS.includes(action)) return;
    // 先清掉 hash：否则刷新页面会再弹一次，关掉弹窗后地址栏也还挂着它。
    try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {}
    runMobileTab(action);
  }

  function applyUpperCollapsed(collapsed) {
    const wrap = document.getElementById("sheet-upper-wrap");
    const btn = document.getElementById("sheet-collapse-btn");
    if (!wrap || !btn) return;
    wrap.classList.toggle("collapsed", collapsed);
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    btn.textContent = collapsed ? tr("今日报表 ▸") : tr("今日报表 ▾");
    try { localStorage.setItem("sheet-upper-collapsed", collapsed ? "1" : "0"); } catch (_) {}
  }

  document.addEventListener("DOMContentLoaded", () => {
    sheetDate = todaySydney();
    const dateEl = document.getElementById("sheet-date");
    if (dateEl) dateEl.value = sheetDate;

    let upperCollapsed = true;
    try {
      const saved = localStorage.getItem("sheet-upper-collapsed");
      if (saved === "0") upperCollapsed = false;
      else if (saved === "1") upperCollapsed = true;
    } catch (_) {}
    applyUpperCollapsed(upperCollapsed);
    document.getElementById("sheet-collapse-btn")?.addEventListener("click", () => {
      const wrap = document.getElementById("sheet-upper-wrap");
      applyUpperCollapsed(!wrap?.classList.contains("collapsed"));
    });

    populateStatusFilter();
    setupAC("f-bankbranch", "ac-bankbranch", "bank_branch");

    // 手机底部标签栏：在本页直接执行；从别的页点过来带着 #pending 之类的 hash，
    // 等首轮数据（渠道列表）到齐再执行——调钱表单的 BANK 下拉要靠它填。
    window.bankMobileTab = runMobileTab;
    reloadAll().then(runMobileTabFromHash, runMobileTabFromHash);

    if (typeof startSyncWatcher === "function") {
      startSyncWatcher(() => reloadAll());
    }
    if (typeof bindCompanySwitch === "function") {
      bindCompanySwitch(() => reloadAll());
    }
    window.addEventListener("company-changed", refreshWorkspaceContext);
    window.addEventListener("language-changed", () => {
      renderTabs();
      renderGrid();
      applyUpperCollapsed(document.getElementById("sheet-upper-wrap")?.classList.contains("collapsed"));
    });
    setInterval(refreshSharedWorkspace, 5000);
    window.addEventListener("focus", refreshSharedWorkspace);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshSharedWorkspace();
    });
    setInterval(refreshPendingBadge, 8000);
    // Patrol linked C STATUS reconciliation every five minutes.
    setInterval(loadDailyReport, 5 * 60 * 1000);
    document.getElementById("reconcile-alert")?.addEventListener("click", (e) => {
      const focus = e.target.closest(".reconcile-focus");
      if (focus) {
        focusLedgerByCstatus(focus.dataset.cstatus || "");
        return;
      }
      if (e.target.closest(".reconcile-ok")) acknowledgeReconcileAlarm();
    });
    document.getElementById("sheet-cstatus-rows")?.addEventListener("click", (e) => {
      const focus = e.target.closest(".cstatus-focus");
      if (focus) focusLedgerByCstatus(focus.dataset.cstatus || "");
    });

    document.getElementById("sheet-date")?.addEventListener("change", (e) => {
      sheetDate = e.target.value || todaySydney();
      updateWorkspaceCompanyContext();
      editingRowId = null;
      adding = false;
      hideGridPicker();
      resetEnterSave();
      loadSheet();
      loadDailyReport();
    });
    document.getElementById("sheet-search")?.addEventListener("input", renderGrid);
    document.getElementById("sheet-status-filter")?.addEventListener("change", renderGrid);

    document.getElementById("sheet-tabs")?.addEventListener("click", (e) => {
      if (e.target.closest(".bk-directory-toggle")) {
        directoryOpen = !directoryOpen;
        renderTabs();
        return;
      }
      const bannedBtn = e.target.closest("#rail-banned-btn");
      if (bannedBtn) { openBanksListModal({ tab: "banned" }); return; }
      const copyBankBtn = e.target.closest("[data-copy-bank-id]");
      if (copyBankBtn) {
        e.stopPropagation();
        copyBankDirectoryInfo(copyBankBtn.dataset.copyBankId);
        return;
      }
      const bankSelector = e.target.closest("[data-bank-select]");
      if (bankSelector && (!e.target.closest("button") || bankSelector.classList.contains("bk-directory-summary"))) {
        activeBankId = bankSelector.dataset.bankSelect === "all" ? ALL_BANKS : Number(bankSelector.dataset.bankSelect);
        renderTabs();
        loadSheet();
        return;
      }
      const copy = e.target.closest(".bk-copy[data-copy]");
      if (copy) {
        e.stopPropagation();
        const text = copy.dataset.copy || "";
        if (text && navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text)
            .then(() => showToast(`已复制 ${text}`, { tone: "success" }))
            .catch(() => showToast("复制失败", { tone: "error" }));
        }
        return;
      }
      return;
    });

    const bankDirectory = document.getElementById("sheet-tabs");
    bankDirectory?.addEventListener("keydown", (e) => {
      const row = e.target.closest(".bk-bank-row");
      if (!row || e.target.closest("button")) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      activeBankId = Number(row.dataset.id);
      renderTabs();
      loadSheet();
    });
    bankDirectory?.addEventListener("dragstart", (e) => {
      const row = e.target.closest(".bk-bank-row");
      if (!row || bankReorderBusy) return;
      draggedBankId = Number(row.dataset.id);
      row.classList.add("is-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(draggedBankId));
      }
    });
    bankDirectory?.addEventListener("dragover", (e) => {
      const row = e.target.closest(".bk-bank-row");
      if (!row || draggedBankId == null || Number(row.dataset.id) === draggedBankId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      bankDirectory.querySelectorAll(".bk-bank-row.is-drag-over").forEach((el) => el.classList.remove("is-drag-over"));
      row.classList.add("is-drag-over");
    });
    bankDirectory?.addEventListener("drop", (e) => {
      const row = e.target.closest(".bk-bank-row");
      if (!row || draggedBankId == null) return;
      e.preventDefault();
      const targetIndex = usableBanks().findIndex((b) => b.id === Number(row.dataset.id));
      moveBankDirectoryRow(draggedBankId, targetIndex);
      draggedBankId = null;
      bankDirectory.querySelectorAll(".bk-bank-row.is-drag-over, .bk-bank-row.is-dragging").forEach((el) => el.classList.remove("is-drag-over", "is-dragging"));
    });
    bankDirectory?.addEventListener("dragend", () => {
      draggedBankId = null;
      bankDirectory.querySelectorAll(".bk-bank-row.is-drag-over, .bk-bank-row.is-dragging").forEach((el) => el.classList.remove("is-drag-over", "is-dragging"));
    });

    const grid = document.getElementById("sheet-grid");
    grid?.addEventListener("keydown", handleGridKeydown, true);
    grid?.addEventListener("pointerdown", (e) => {
      if (!e.target.matches("input[data-f]")) return;
      gridPointerFocus = true;
      setTimeout(() => { gridPointerFocus = false; }, 0);
    }, true);
    grid?.addEventListener("focusin", (e) => {
      if (!e.target.matches("input[data-f]")) return;
      if (!isPickField(e.target) || e.target !== gridPickerInput) hideGridPicker();
      if (!gridPointerFocus && e.target.getAttribute("data-f") !== "time") {
        setTimeout(() => e.target.select(), 0);
      }
      if (e.target.getAttribute("data-f") === "status") {
        setTimeout(() => {
          if (document.activeElement === e.target) openFieldPicker(e.target);
        }, 0);
      }
    });
    grid?.addEventListener("input", (e) => {
      if (e.target.matches('input[data-f="bank_acc"]') && e.target.value.trim()) {
        delete e.target.dataset.bankCleared;
      }
    });
    grid?.addEventListener("change", (e) => {
      if (e.target.matches('input[data-f="time"]')) e.target.value = normalizeTime24(e.target.value);
    });
    grid?.addEventListener("click", (e) => {
      const inp = e.target.closest("input[data-f]");
      if (inp && isPickField(inp)) openFieldPicker(inp);
      if (inp?.getAttribute("data-f") === "time" && typeof inp.showPicker === "function") {
        try { inp.showPicker(); } catch (_) {}
      }
      const editBtn = e.target.closest(".sheet-edit");
      if (editBtn) {
        startEditRow(Number(editBtn.dataset.id));
        return;
      }
      const saveBtn = e.target.closest(".sheet-save");
      if (saveBtn) {
        const tr = saveBtn.closest("tr");
        const isNew = tr?.classList.contains("grid-row-new");
        commitRow(tr).then(() => { if (isNew) focusNewRow(0); });
        return;
      }
      const cancelBtn = e.target.closest(".sheet-cancel");
      if (cancelBtn) {
        if (cancelBtn.closest("tr")?.classList.contains("grid-row-new")) stopAdding();
        else cancelEditRow();
        return;
      }
      const del = e.target.closest(".sheet-del");
      if (del) {
        const id = Number(del.dataset.id);
        if (!id) return;
        requestOperationReason({
          title: "删除流水",
          description: "流水会进入最近删除；如关联平台单，可能同时恢复为待处理。",
          target: `账单流水 #${id}`,
          confirmLabel: "确认删除",
        }).then((reason) => {
          if (!reason) return null;
          return api(`/api/banks/ledger/${id}`, {
            method: "DELETE",
            body: JSON.stringify({ reason }),
          }).then((result) => {
            showToast(result?.reopened ? "已删除，平台订单已恢复到待接单" : "已删除，可在最近删除恢复", { tone: "success" });
            return loadBanks().then(loadSheet).then(loadDailyReport).then(refreshPendingBadge).then(loadPendingPanels);
          }).catch((error) => showToast(error.message || "删除失败", { tone: "error" }));
        });
        return;
      }
      // 手机：点只读卡片的空白处展开 / 收起（按钮、链接、输入框上面已各自处理）。
      if (MOBILE_MQ.matches && !e.target.closest("button, a, input")) {
        const card = e.target.closest("tr.sheet-row-ro[data-id]");
        if (card) {
          const id = Number(card.dataset.id);
          if (openLedgerCards.has(id)) openLedgerCards.delete(id);
          else openLedgerCards.add(id);
          card.classList.toggle("m-open", openLedgerCards.has(id));
          card.setAttribute("aria-expanded", openLedgerCards.has(id) ? "true" : "false");
        }
      }
    });

    document.getElementById("add-bank-btn")?.addEventListener("click", () => openBankModal(null));
    document.getElementById("bank-cancel-btn")?.addEventListener("click", closeBankModal);
    document.getElementById("bank-save-btn")?.addEventListener("click", saveBankModal);
    document.getElementById("sheet-manage-banks")?.addEventListener("click", () => openBanksListModal({ tab: "operating" }));
    document.getElementById("sheet-deleted-btn")?.addEventListener("click", openDeletedLedgerModal);
    document.getElementById("deleted-ledger-close")?.addEventListener("click", () => {
      document.getElementById("deleted-ledger-modal")?.classList.remove("show");
    });
    document.getElementById("deleted-ledger-modal")?.addEventListener("click", (e) => {
      const restore = e.target.closest(".deleted-restore");
      if (restore) restoreDeletedLedger(Number(restore.dataset.id));
    });
    document.getElementById("banks-list-close")?.addEventListener("click", () => {
      document.getElementById("banks-list-modal").classList.remove("show");
    });
    document.getElementById("banks-list-modal")?.addEventListener("click", async (e) => {
      const tabBtn = e.target.closest(".bkd-tab");
      if (tabBtn) {
        switchBkdTab(tabBtn.dataset.tab);
        return;
      }
      const toggle = e.target.closest(".bkd-toggle-btn");
      if (toggle) {
        const id = Number(toggle.dataset.id);
        const bodyEl = document.getElementById(`bkd-body-${id}`);
        if (!bodyEl) return;
        const open = !bodyEl.hidden;
        bodyEl.hidden = open;
        // \u5c55\u5f00\u96c6\u5408\u662f\u6e32\u67d3\u7684\u771f\u6e90\uff1a\u7ffb\u9875\u6216\u5207\u9875\u7b7e\u540e\u91cd\u65b0\u6e32\u67d3\u65f6\uff0c\u9760\u5b83\u6062\u590d\u5c55\u5f00\u72b6\u6001\u3002
        if (open) bkdExpanded.delete(id);
        else bkdExpanded.add(id);
        toggle.setAttribute("aria-expanded", open ? "false" : "true");
        toggle.textContent = open ? "\u25b8" : "\u25be";
        if (!open && bodyEl.dataset.loaded === "0") loadBkdDetail(id, bodyEl);
        return;
      }
      const edit = e.target.closest(".bkd-edit-btn");
      if (edit) {
        const row = bankRows.find((b) => String(b.id) === edit.dataset.id);
        if (row) openBankModal(row);
        return;
      }
      const ban = e.target.closest(".bkd-ban-btn");
      if (ban) {
        const note = await showPromptDialog({
          title: "\u5c01\u7981\u652f\u4ed8\u6e20\u9053",
          message: "\u5c01\u7981\u540e\u8be5\u6e20\u9053\u5c06\u4e0d\u518d\u53c2\u4e0e\u5f53\u524d\u8fd0\u8425\uff0c\u5e76\u8fdb\u5165\u300c\u5c01\u7981\u4e2d\u300d\u5f85\u6e05\u7406\u961f\u5217\u3002",
          label: "\u5c01\u7981\u539f\u56e0\uff08\u53ef\u7559\u7a7a\uff09",
          maxLength: 500,
          confirmLabel: "\u786e\u8ba4\u5c01\u7981",
        });
        if (note == null) return;
        bkdMutate(
          api(`/api/banks/${ban.dataset.id}`, {
            method: "PUT",
            body: JSON.stringify({ ban: true, ban_note: note }),
          })
        );
        return;
      }
      const unban = e.target.closest(".bkd-unban-btn");
      if (unban) {
        bkdMutate(
          api(`/api/banks/${unban.dataset.id}`, { method: "PUT", body: JSON.stringify({ unban: true }) })
        );
        return;
      }
      const archive = e.target.closest(".bkd-archive-btn");
      if (archive) {
        const note = await showPromptDialog({
          title: "\u5f52\u6863\u652f\u4ed8\u6e20\u9053",
          message: "\u5f52\u6863\u540e\u8be5\u6e20\u9053\u4e0d\u518d\u51fa\u73b0\u5728\u4efb\u4f55\u5217\u8868\u3001\u4e0b\u62c9\u4e0e Telegram \u63a8\u9001\u4e2d\uff0c\u5386\u53f2\u6d41\u6c34\u5168\u90e8\u4fdd\u7559\u3002\u968f\u65f6\u53ef\u5728\u300c\u5df2\u5f52\u6863\u300d\u9875\u7b7e\u53d6\u6d88\u5f52\u6863\u3002",
          label: "\u5f52\u6863\u539f\u56e0\uff08\u53ef\u7559\u7a7a\uff09",
          maxLength: 500,
          confirmLabel: "\u786e\u8ba4\u5f52\u6863",
        });
        if (note == null) return;
        bkdMutate(
          api(`/api/banks/${archive.dataset.id}`, {
            method: "PUT",
            body: JSON.stringify({ archive: true, archive_note: note }),
          }).then(() => {
            // \u5f52\u6863\u6210\u529f\u540e\u90a3\u4e00\u884c\u79bb\u5f00\u5f53\u524d\u9875\u7b7e\uff0c\u4e0d\u8bf4\u4e00\u58f0\u4eba\u4f1a\u4ee5\u4e3a\u6e20\u9053\u88ab\u5220\u4e86\u3002
            showToast(tr("\u5df2\u5f52\u6863\uff0c\u53ef\u5728\u300c\u5df2\u5f52\u6863\u300d\u9875\u7b7e\u67e5\u770b"), { tone: "success" });
          })
        );
        return;
      }
      const unarchive = e.target.closest(".bkd-unarchive-btn");
      if (unarchive) {
        bkdMutate(
          api(`/api/banks/${unarchive.dataset.id}`, {
            method: "PUT",
            body: JSON.stringify({ unarchive: true }),
          }).then(() => {
            // \u53d6\u6d88\u5f52\u6863\u56de\u843d\u5230\u300c\u5c01\u7981\u4e2d\u300d\u800c\u4e0d\u662f\u76f4\u63a5\u590d\u6d3b\uff0c\u8981\u518d\u663e\u5f0f\u89e3\u5c01\u4e00\u6b21\u624d\u56de\u8fd0\u8425\u3002
            showToast(tr("\u5df2\u53d6\u6d88\u5f52\u6863\uff0c\u73b0\u5728\u5728\u300c\u5c01\u7981\u4e2d\u300d\u9875\u7b7e"), { tone: "success" });
          })
        );
        return;
      }
      const chk = e.target.closest(".bank-active-chk");
      if (chk) {
        bkdMutate(
          api(`/api/banks/${chk.dataset.id}`, {
            method: "PUT",
            body: JSON.stringify({ active: chk.checked ? 1 : 0 }),
          })
        );
        return;
      }
    });

    // \u641c\u7d22\u6846\u5728\u9762\u677f\u5916\u9762\uff0c\u6240\u4ee5\u4e0d\u4f1a\u88ab\u91cd\u6e32\u67d3\u51b2\u6389\u7126\u70b9\u3002\u4e0d\u52a0 debounce\uff1a\u8fc7\u6ee4\u7684\u662f\u5341\u51e0\u884c\u7684
    // \u6570\u7ec4\uff0c\u6e32\u67d3\u884c\u6570\u53c8\u88ab\u5206\u9875\u9489\u6b7b\u5728 20 \u4ee5\u5185\u3002
    document.getElementById("bkd-search")?.addEventListener("input", (e) => {
      bkdQuery = e.target.value || "";
      bkdPage[bkdTab] = 1;
      renderBkdPanel();
    });

    document.getElementById("sheet-pending-btn")?.addEventListener("click", () => openPendingModal());
    document.getElementById("bk-pending-platform")?.addEventListener("click", () => openPendingModal("tx"));
    document.getElementById("bk-pending-skipped")?.addEventListener("click", () => openPendingModal("skipped"));
    document.getElementById("bk-pending-open-all")?.addEventListener("click", () => openPendingModal());
    const moreMenu = document.querySelector(".bk-more-menu");
    const moreSummary = moreMenu?.querySelector("summary");
    const morePopover = moreMenu?.querySelector(".bk-more-popover");
    const moreHome = morePopover?.parentElement;
    const restoreMorePopover = () => {
      if (!morePopover) return;
      if (moreHome && morePopover.parentNode !== moreHome) moreHome.appendChild(morePopover);
      morePopover.style.width = "";
      morePopover.style.left = "";
      morePopover.style.top = "";
    };
    const positionMorePopover = () => {
      if (!moreMenu?.open || !moreSummary || !morePopover) return;
      const anchor = moreSummary.getBoundingClientRect();
      const padding = 12;
      const width = Math.min(220, Math.max(150, window.innerWidth - padding * 2));
      morePopover.style.width = `${width}px`;
      const box = morePopover.getBoundingClientRect();
      let left = Math.min(anchor.right - box.width, window.innerWidth - box.width - padding);
      let top = anchor.bottom + 6;
      left = Math.max(padding, left);
      if (top + box.height > window.innerHeight - padding && anchor.top - box.height - 6 >= padding) {
        top = anchor.top - box.height - 6;
      }
      morePopover.style.left = `${left}px`;
      morePopover.style.top = `${Math.max(padding, top)}px`;
    };
    moreMenu?.addEventListener("toggle", () => {
      if (!moreMenu.open) {
        restoreMorePopover();
        return;
      }
      if (morePopover && morePopover.parentNode !== document.body) document.body.appendChild(morePopover);
      window.requestAnimationFrame(positionMorePopover);
    });
    morePopover?.addEventListener("click", (e) => {
      if (!e.target.closest(".bk-more-item")) return;
      if (moreMenu) moreMenu.open = false;
      restoreMorePopover();
    });
    document.addEventListener("pointerdown", (e) => {
      if (!moreMenu?.open) return;
      if (moreSummary?.contains(e.target) || morePopover?.contains(e.target)) return;
      moreMenu.open = false;
      restoreMorePopover();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !moreMenu?.open) return;
      e.preventDefault();
      moreMenu.open = false;
      restoreMorePopover();
      moreSummary?.focus();
    });
    window.addEventListener("resize", positionMorePopover);
    window.addEventListener("scroll", positionMorePopover, true);
    window.addEventListener("resize", followGridPicker);
    window.addEventListener("scroll", followGridPicker, true);
    window.visualViewport?.addEventListener("resize", followGridPicker);
    document.getElementById("trf-amount")?.addEventListener("input", () => {
      syncTransferFormForAmount();
    });
    document.getElementById("trf-status")?.addEventListener("change", () => {
      const parsed = parseTransferAmount(document.getElementById("trf-amount")?.value);
      if (parsed.state === "valid") renderTransferPreview(parsed);
    });
    document.getElementById("pending-close")?.addEventListener("click", () => {
      document.getElementById("pending-modal").classList.remove("show");
    });
    document.querySelectorAll(".pending-tab").forEach((btn) => {
      btn.addEventListener("click", () => switchPendingTab(btn.dataset.tab));
    });
    document.getElementById("pending-tx-rows")?.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-txid]");
      if (!tr) return;
      const txId = tr.dataset.txid;
      if (e.target.closest(".pend-skip")) {
        requestOperationReason({
          title: "跳过平台单",
          description: "请记录暂不处理这笔平台单的原因。",
          target: `平台交易 ${txId}`,
          confirmLabel: "确认跳过",
        }).then((reason) => {
          if (!reason) return null;
          return api(`/api/banks/pending-tx/${encodeURIComponent(txId)}/skip`, {
            method: "POST",
            body: JSON.stringify({ reason }),
          }).then(() => { showToast("Skipped，可在 Skipped tab 恢复", { tone: "success" }); loadPendingPanels(); refreshPendingBadge(); });
        });
        return;
      }
      if (!e.target.closest(".pend-approve")) return;
      const modeEl = tr.querySelector(".pend-mode");
      const mode = modeEl ? modeEl.value : "bank";
      const companyId = pendingBankRankCompanyId();
      if (mode === "split" && !updatePendingSplitState(tr)) return;
      const body = {
        mode: mode === "split" ? "help_split" : mode,
        bank_account_id: mode === "help" || mode === "split" || mode === "redeposit" ? null : (Number(tr.querySelector(".pend-bank")?.value || 0) || null),
        remark: tr.querySelector(".pend-remark")?.value || "",
        entry_time: pendingEntryDateTime(
          tr.querySelector(".pend-date-input")?.value || dateFromSql(tr.dataset.txTime, sheetDate || todaySydney()),
          tr.querySelector(".pend-time")?.value || nowTime()
        ),
      };
      if (mode === "help") {
        // A helped withdraw is inbound for this company. Keep these values
        // fixed so the compact summary and the server always agree.
        body.direction = "in";
        body.status = "cash in";
        body.c_status = tr.querySelector(".pend-cstatus")?.value || "";
      }
      if (mode === "split") {
        body.self_amount = parseNum(tr.querySelector(".pend-split-self-amount")?.value || 0);
        body.self_bank_account_id = Number(tr.querySelector(".pend-split-self-bank")?.value || 0) || null;
        body.splits = pendingSplitRows(tr);
      }
      api(`/api/banks/pending-tx/${encodeURIComponent(txId)}/approve`, {
        method: "POST",
        body: JSON.stringify(body),
      }).then(() => {
        if (mode === "bank") rememberPendingBank(body.bank_account_id, companyId);
        return reloadAll().then(loadPendingPanels);
      }).catch((err) => showToast(err.message || "审批失败", { tone: "error" }));
    });
    document.getElementById("pending-skipped-rows")?.addEventListener("click", (e) => {
      const restore = e.target.closest(".pend-restore");
      const remove = e.target.closest(".pend-delete");
      if (!restore && !remove) return;
      const tr = (restore || remove).closest("tr[data-txid]");
      const txId = tr?.dataset.txid || "";
      if (!txId) return;
      if (restore) {
        requestOperationReason({
          title: "恢复待处理",
          description: "平台单会重新出现在待处理列表。",
          target: `平台交易 ${txId}`,
          confirmLabel: "确认恢复",
        }).then((reason) => {
          if (!reason) return null;
          return api(`/api/banks/pending-tx/${encodeURIComponent(txId)}/restore`, {
            method: "POST",
            body: JSON.stringify({ reason }),
          }).then(() => { showToast("已恢复到待处理", { tone: "success" }); loadPendingPanels(); refreshPendingBadge(); });
        });
        return;
      }
      requestOperationReason({
        title: "删除已跳过平台单",
        description: "删除后当天不能再恢复，请说明原因。",
        target: `平台交易 ${txId}`,
        confirmLabel: "确认删除",
      }).then((reason) => {
        if (!reason) return null;
        return api(`/api/banks/pending-tx/${encodeURIComponent(txId)}/skipped`, {
          method: "DELETE",
          body: JSON.stringify({ reason }),
        }).then(() => { showToast("已删除跳过记录", { tone: "success" }); loadPendingPanels(); refreshPendingBadge(); })
          .catch((err) => showToast(err.message || "删除失败", { tone: "error" }));
      });
    });
    document.getElementById("sheet-transfer-btn")?.addEventListener("click", () => openTransferModal());
    document.getElementById("trf-cancel")?.addEventListener("click", () => {
      document.getElementById("transfer-modal").classList.remove("show");
    });
    document.getElementById("trf-submit")?.addEventListener("click", () => {
      const g = (id) => document.getElementById(id);
      if (transferSubmitting) return;
      const amountInput = g("trf-amount");
      const parsed = parseTransferAmount(amountInput?.value);
      const err = g("trf-err");
      if (parsed.state !== "valid") {
        if (err) {
          err.textContent = parsed.state === "invalid"
            ? "金额格式无效，请输入 100 或 -100"
            : (parsed.state === "zero" ? "金额不能为 0" : "请输入金额，例如 100 或 -100");
        }
        amountInput?.focus();
        return;
      }
      syncTransferFormForAmount();
      const body = {
        direction: parsed.direction,
        status: g("trf-status")?.value || "",
        c_status: (g("trf-cstatus")?.value || "").trim(),
        amount: parsed.magnitudeText,
        bank_account_id: Number(g("trf-bank")?.value || 0) || null,
        entry_time: entryDateTime(g("trf-time")?.value || nowTime()),
        name: (g("trf-name")?.value || "").trim(),
        remark: (g("trf-remark")?.value || "").trim(),
      };
      transferSubmitting = true;
      const submit = g("trf-submit");
      const cancel = g("trf-cancel");
      const transferModal = g("transfer-modal");
      if (submit) {
        submit.disabled = true;
        submit.setAttribute("aria-busy", "true");
      }
      if (cancel) cancel.disabled = true;
      if (transferModal) transferModal.dataset.modalBusy = "true";
      if (err) err.textContent = "";
      api("/api/banks/ledger/transfer", { method: "POST", body: JSON.stringify(body) })
        .then((result) => {
          g("transfer-modal")?.classList.remove("show");
          reloadAll();
          showToast(result?.counterparty_required ? "本方调钱已保存，请对方公司另外录入" : "调钱已保存", { tone: "success" });
        })
        .catch((e) => {
          if (err) err.textContent = e.message || "失败";
          else showToast(e.message || "保存失败", { tone: "error" });
        })
        .finally(() => {
          transferSubmitting = false;
          if (submit) {
            submit.disabled = false;
            submit.removeAttribute("aria-busy");
          }
          if (cancel) cancel.disabled = false;
          if (transferModal) delete transferModal.dataset.modalBusy;
        });
    });

    document.getElementById("cstatus-manage-btn")?.addEventListener("click", openCstatusModal);
    document.getElementById("cs-close")?.addEventListener("click", () => {
      document.getElementById("cstatus-modal").classList.remove("show");
    });
    document.getElementById("cs-add-btn")?.addEventListener("click", () => {
      const name = document.getElementById("cs-new-name").value.trim();
      const target = document.getElementById("cs-new-company").value;
      if (!name) return;
      api("/api/banks/c-status-options", {
        method: "POST",
        body: JSON.stringify({
          name,
          target_company_id: target,
        }),
      }).then(() => {
        document.getElementById("cs-new-name").value = "";
        return loadCStatus().then(renderCstatusManage).then(loadDailyReport);
      });
    });
    document.getElementById("cs-rows")?.addEventListener("click", (e) => {
      const btn = e.target.closest(".cs-del");
      if (!btn) return;
      api(`/api/banks/c-status-options/${encodeURIComponent(btn.dataset.name)}`, { method: "DELETE" })
        .then(() => loadCStatus().then(renderCstatusManage).then(loadDailyReport));
    });
    // 只传 name + flag：banks.js 把未传的 target_company_id 当作「保持原值」。
    document.getElementById("cs-rows")?.addEventListener("change", (e) => {
      const box = e.target.closest(".cs-reconcile");
      if (!box) return;
      const name = box.closest("tr")?.dataset.name;
      if (!name) return;
      api("/api/banks/c-status-options", {
        method: "POST",
        body: JSON.stringify({ name, reconcile_required: box.checked ? 1 : 0 }),
      })
        .then(() => loadCStatus().then(renderCstatusManage).then(loadDailyReport))
        .catch((err) => {
          box.checked = !box.checked;
          showToast(err.message || "保存失败", { tone: "error" });
        });
    });
  });
})();
