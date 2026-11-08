(function () {
  "use strict";

  // 当日流水页（/bank-ledger.html）：流水表格、接单区（平台单审批 / 已跳过）、调钱、
  // 今日报表、C STATUS 与未对平报警。渠道目录与渠道管理在 bank-channels.js（2026-11 拆页），
  // 两页共用的格式化与口径在 bank-common.js。
  //
  // 渠道生命周期判定的唯一入口（镜像见 app.js 的 window.BankLifecycle，真源在
  // server/lib/bankLifecycle.js）。不要在本文件里再写 lifecycle_status 的字面量比较——
  // 改造前那些 `!== "banned"` 的反向白名单会把「已归档」当成可用账户。
  const LC = window.BankLifecycle;
  const BC = window.BankCommon;
  const {
    tr, esc, plainDisplayText, ledgerNameText, fmt, fmtMetric, parseNum,
    parseStatus, statusLabel, statusClass, statusStyleAttr,
    bankBranchOf, tabLabel, bankPickerLabel,
  } = BC;

  let bankRows = [];
  let ledgerRows = [];
  let cStatusOptions = [];
  let companyOptions = [];
  const ALL_BANKS = "all";
  let activeBankId = ALL_BANKS;
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
  let lastPendingTotal = null;
  let editingRowId = null;
  let adding = false;
  let gridPointerFocus = false;
  let trfDirection = "";
  const RECONCILE_ALARM_SOUND = "/sounds/dragon-studio-alert-444816.mp3";
  let reconcileAlarm = null;
  let reconcileRendering = false;
  let workspaceContextRequest = 0;
  let lastSkippedPendingCount = 0;

  let bankLoadRequest = 0;
  let ledgerLoadRequest = 0;
  let reportLoadRequest = 0;
  let sharedRefreshInFlight = false;
  // 后台 5 秒轮询：数据没变就不重绘（规则见 render-gate.js）。
  const renderGate = window.createRenderGate();
  // loadBanks / loadSheet / loadDailyReport 常被 .then(fn) 串起来，会收到上一步的返回值，
  // 所以只认严格的 { background: true }。
  const isBackground = (opts) => Boolean(opts) && opts.background === true;
  function gateRender(key, opts, data) {
    if (isBackground(opts)) return renderGate.changed(key, data);
    renderGate.remember(key, data);
    return true;
  }

  const GRID_FIELDS = [
    "time", "tx_id", "status", "in", "out", "help_trf",
    "bank_acc", "username", "name", "c_status", "other", "remark",
  ];
  const PROBLEM_OPTIONS = ["进错钱", "金额不对", "重复入账", "客户认领", "需要检查", "其他问题"];

  const OUT_STATUSES = new Set(["withdraw", "wrong", "cash out", "give back", "expenses", "exchange", "bank trf", "test out"]);
  // Manual IN/OUT must expose the complete directional status sets. Keep the
  // order aligned with the status settings so the dropdown is predictable.
  const IN_HELP_STATUSES = ["deposit", "cash in", "new", "bank transfer", "unclaim", "redeposit", "amopay", "test in"];
  const OUT_HELP_STATUSES = ["withdraw", "wrong", "cash out", "give back", "expenses", "exchange", "bank trf", "test out"];
  const PICKER_CLOSE = "__close__";
  const PICKER_CLOSE_LABEL = "— 关闭 —";
  const PICKER_BLANK = "__blank__";
  const PICKER_BLANK_LABEL = "— 空白 —";
  const PICKER_ADD = "__add__";

  function fmtSigned(n) {
    const v = Number(n || 0);
    if (!v) return "0.00";
    return fmt(v);
  }
  function fmtOut(n) {
    const v = Number(n || 0);
    if (!v) return "";
    return `-${fmt(Math.abs(v))}`; // 和 IN 列一样带千分位，parseOut 会去掉逗号
  }
  function parseOut(v) {
    if (v === "" || v == null) return 0;
    const n = parseFloat(String(v).replace(/,/g, ""));
    return Number.isFinite(n) ? Math.abs(n) : 0;
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
  // 能出现在录入下拉、编号里的账户。封禁与归档都不在内（规则在 bank-common.js）。
  function usableBanks() {
    return BC.usableBanks(bankRows);
  }
  // 匹配规则在 ledger-bank-pick.js（有测试）：序号后面还有字就必须整段对得上。
  function bankByPickerLabel(text) {
    const list = usableBanks();
    const id = window.matchBankByLabel(text, list.map((b, i) => ({
      id: b.id,
      label: bankPickerLabel(b, i),
      aliases: [tabLabel(b), bankBranchOf(b), b.account_name],
    })));
    return id == null ? null : list.find((b) => b.id === id) || null;
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
  // 只负责从 DOM 取值，判定规则在 ledger-bank-pick.js（有测试）。返回 { mode, id }。
  function rowBankId(tr, bankAccText, isExisting) {
    const inp = tr.querySelector('input[data-f="bank_acc"]');
    const datasetBankId = inp?.dataset.bankId ? Number(inp.dataset.bankId) : 0;
    let datasetLabel = "";
    if (datasetBankId) {
      const list = usableBanks();
      const idx = list.findIndex((b) => b.id === datasetBankId);
      if (idx >= 0) datasetLabel = bankPickerLabel(list[idx], idx);
    }
    return window.resolveRowBank({
      isExisting: Boolean(isExisting),
      cleared: inp?.dataset.bankCleared === "1",
      text: bankAccText,
      origText: inp?.dataset.origText ?? "",
      matchedId: matchBankId(bankAccText),
      datasetBankId,
      datasetLabel,
      activeBankId: activeBankId !== ALL_BANKS ? activeBankId : null,
      firstUsableId: usableBanks()[0]?.id ?? null,
    });
  }
  function cStatusNames() {
    return BC.cStatusNames(cStatusOptions);
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
    // 编辑时 BANK ACC 没动就原样保留（见 ledger-bank-pick.js），靠这个初值判断「动没动」。
    if (f === "bank_acc") attrs += ` data-orig-text="${esc(String(val ?? ""))}"`;
    // 手机上由 cstatus-sheet.js 摘掉键盘，点开走底部抽屉（见 openFieldPicker）。
    if (f === "c_status") attrs += " data-cstatus-pick";
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
    if (f === "status") showGridPicker(inp, BC.statusList().map((s) => s.label));
    else if (f === "c_status" && window.isCstatusSheetMobile?.()) {
      // 手机：底部抽屉代替贴框浮层（浮层会被键盘顶走）。新名字照桌面那样先登记成选项。
      hideGridPicker();
      window.openCstatusSheet(inp, cStatusNames(), { allowBlank: true, allowAdd: true }, (value, kind) => {
        if (kind !== "add" || !value) return;
        api("/api/banks/c-status-options", { method: "POST", body: JSON.stringify({ name: value }) })
          .then(() => loadCStatus())
          .catch(() => {});
      });
    }
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
    if (isRedepositStatus(body.status)) {
      body.bank_account_id = 0;
    } else {
      const pick = rowBankId(tr, body.bank_acc, isExisting);
      if (pick.mode === "invalid") {
        showToast("BANK ACC 无法识别，请从下拉选择，或选「— 空白 —」解绑", { tone: "warning" });
        return Promise.resolve();
      }
      if (pick.mode === "keep") {
        // 没动 BANK ACC：两个字段都不发，服务端原样保留绑定（含封禁户的历史行）。
        delete body.bank_acc;
      } else {
        body.bank_account_id = pick.id;
      }
    }
    const keepBank = !("bank_acc" in body);
    if (isRedepositStatus(body.status)) body.bank_acc = "";
    if (!keepBank && !isRedepositStatus(body.status) && !body.bank_account_id && isExisting) body.bank_acc = "";
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

  function loadBanks(opts) {
    const request = ++bankLoadRequest;
    return api("/api/banks", { bg: true }).then((d) => {
      if (request !== bankLoadRequest) return;
      bankRows = d.rows || [];
      // 筛选只认运营中的渠道（下拉里也只有它们）；?bank= 指向的户被封禁 / 归档了就回到 ALL。
      if (activeBankId !== ALL_BANKS && activeBankId && !usableBanks().find((b) => b.id === activeBankId)) {
        activeBankId = bankRows.length ? ALL_BANKS : null;
        syncBankParam();
      } else if (!bankRows.length) {
        activeBankId = null;
      } else if (activeBankId == null) {
        activeBankId = ALL_BANKS;
      }
      if (!gateRender("banks", opts, { rows: bankRows, active: activeBankId })) return;
      renderBankFilter();
      renderLivePicker();
      refreshDepositBankSelects();
    });
  }
  // 工具栏的「渠道」下拉：ALL + 运营中渠道，顺序与编号同支付渠道页。渠道目录挪到支付渠道页
  // 之后，这是本页唯一的按渠道筛选入口；选中值同步到地址栏 ?bank=，刷新与分享都还在。
  function renderBankFilter() {
    updateGridTitle();
    const sel = document.getElementById("sheet-bank-filter");
    if (!sel) return;
    const list = usableBanks();
    // 「全部渠道」走字典翻译；渠道名是租户数据，逐个 translate="no"。
    sel.innerHTML = `<option value="${ALL_BANKS}">全部渠道</option>`
      + list.map((b, i) => `<option value="${b.id}" translate="no">${esc(bankPickerLabel(b, i))}</option>`).join("");
    sel.value = activeBankId && activeBankId !== ALL_BANKS ? String(activeBankId) : ALL_BANKS;
    sel.disabled = !list.length;
  }
  function syncBankParam() {
    try {
      const url = new URL(location.href);
      if (activeBankId && activeBankId !== ALL_BANKS) url.searchParams.set("bank", String(activeBankId));
      else url.searchParams.delete("bank");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    } catch (_) {}
  }
  function setActiveBank(value) {
    activeBankId = !value || value === ALL_BANKS ? ALL_BANKS : Number(value);
    syncBankParam();
    renderBankFilter();
    return loadSheet();
  }
  function bankFromUrl() {
    try {
      const id = Number(new URLSearchParams(location.search).get("bank"));
      return Number.isInteger(id) && id > 0 ? id : ALL_BANKS;
    } catch (_) {
      return ALL_BANKS;
    }
  }
  function loadSheet(opts) {
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
      if (!gateRender("sheet", opts, { date: dateSnapshot, bank: bankSnapshot, rows: ledgerRows })) return;
      renderSheet();
    }).catch(() => {});
  }
  function loadDailyReport(opts) {
    const request = ++reportLoadRequest;
    const dateSnapshot = sheetDate;
    return api(`/api/banks/daily-report?date=${encodeURIComponent(dateSnapshot)}`, { bg: true })
      .then((d) => {
        if (request !== reportLoadRequest || dateSnapshot !== sheetDate) return;
        dailyReport = d;
        if (!gateRender("report", opts, { date: dateSnapshot, report: d })) return;
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
    return BC.loadStatusOptions().then(() => {
      populateStatusFilter();
      if (!isGridBusy()) renderSheet();
    }).catch(() => {});
  }
  function refreshPendingBadge() {
    return api("/api/banks/pending-counts", { bg: true }).then((d) => {
      const total = Number(d.total || 0);
      const platformCount = Number(d.pending_tx || 0);
      lastSkippedPendingCount = Number(d.skipped_tx || 0);
      if (typeof window.updateBankPendingBadge === "function") {
        window.updateBankPendingBadge(total);
      }
      if (typeof window.updatePlatformPendingSound === "function") {
        window.updatePlatformPendingSound(platformCount);
      }
      maybeRefreshIntake(platformCount, lastSkippedPendingCount);
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
    // 明细（时间、金额、TRANS ID、户口）是租户数据，放在 translate="no" 的那一行。
    const detail = document.getElementById("reason-modal-detail");
    if (detail) {
      detail.textContent = options?.detail || "";
      detail.hidden = !options?.detail;
    }
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

  // ---- 接单区 ---------------------------------------------------------------
  // 原来的「待处理」弹窗，2026-11 摊开到页面上（KPI 下面、今日报表上面），单子来了就看得见，
  // 不用再点按钮。手机上不占页面：底栏「待处理」把同一个节点以全屏浮层打开（MOBILE_MQ），
  // 跟以前的弹窗一样，只有一份实现。
  //
  // 刷新由 refreshPendingBadge（每 5 / 8 秒）驱动：平台单数或已跳过数一变就拉一次，
  // 数字没变也每 INTAKE_FALLBACK_MS 补拉一次（一笔进一笔出时数字不变）。
  const INTAKE_COLLAPSED_KEY = "bk-intake-collapsed";
  const INTAKE_FALLBACK_MS = 30000;
  let intakeCounts = null; // 上次画进接单区的 [平台单数, 已跳过数]
  let intakeLoadedAt = 0;

  function intakeZone() {
    return document.getElementById("bk-intake");
  }
  function setIntakeCollapsed(collapsed, persist) {
    const zone = intakeZone();
    if (!zone) return;
    zone.classList.toggle("is-collapsed", collapsed);
    document.getElementById("bk-intake-toggle")?.setAttribute("aria-expanded", collapsed ? "false" : "true");
    if (persist) {
      try { localStorage.setItem(INTAKE_COLLAPSED_KEY, collapsed ? "1" : "0"); } catch (_) {}
    }
  }
  function openIntake(tab) {
    const zone = intakeZone();
    if (!zone) return Promise.resolve();
    if (MOBILE_MQ.matches) {
      zone.classList.add("is-sheet-open");
      document.body.classList.add("bk-intake-locked");
      window.requestAnimationFrame(() => document.getElementById("bk-intake-close")?.focus());
    } else {
      setIntakeCollapsed(false, true);
      zone.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    return loadPendingPanels().then(() => {
      if (tab) switchPendingTab(tab);
    });
  }
  function closeIntakeSheet() {
    const zone = intakeZone();
    if (!zone?.classList.contains("is-sheet-open")) return;
    zone.classList.remove("is-sheet-open");
    document.body.classList.remove("bk-intake-locked");
  }
  function updateIntakeEmpty(tx, skipped) {
    const zone = intakeZone();
    if (!zone) return;
    const empty = tx + skipped === 0;
    zone.classList.toggle("is-empty", empty);
    const note = document.getElementById("bk-intake-empty");
    if (note) note.hidden = !empty;
  }
  function maybeRefreshIntake(tx, skipped) {
    const changed = !intakeCounts || intakeCounts[0] !== tx || intakeCounts[1] !== skipped;
    if (changed || Date.now() - intakeLoadedAt > INTAKE_FALLBACK_MS) {
      loadPendingPanels({ background: true }).catch(() => {});
    }
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
  // 与后端 bankReport 的 total_balance 同源（规则在 bank-common.js）。
  function totalBalance() {
    return BC.totalBalance(bankRows, dailyReport);
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
  function renderDailyPanels() {
    renderBanksPanel();
    renderReconcileAlertV2();
    renderReportPanel();
    renderCstatusPanel();
  }
  function renderBanksPanel() {
    const sumBal = document.getElementById("sum-balance");
    if (sumBal) sumBal.textContent = fmt(totalBalance());
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
    // 只拿本方的 C STATUS 名去搜：r.name 是两边叫法拼起来的「EZ68 / PK7」，本方流水里搜不到。
    // 本方没映射这家时没有可看的流水，不出按钮；同一家映射了多个名字时每个名字一个按钮。
    const focusButtons = (r) => {
      const names = Array.isArray(r.local_names) ? r.local_names : [];
      return names.map((n) =>
        `<button type="button" class="btn btn-outline btn-xs reconcile-focus" data-cstatus="${esc(n)}">${names.length > 1 ? `查看流水 <span translate="no">${esc(n)}</span>` : "查看流水"}</button>`
      ).join("");
    };
    const items = alerts.map((r) =>
      `<span class="reconcile-alert-item"><strong>${esc(r.display_name || r.name)}</strong><span>差额 ${fmtSigned(r.difference)}</span><span>IN ${fmtSigned(r.in || 0)}</span><span>OUT ${fmtSigned(r.out || 0)}</span>${focusButtons(r)}</span>`
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
    syncBankParam();
    renderBankFilter();
    loadSheet().then(() => {
      renderGrid();
      query.focus();
      query.select();
    });
  }

  // 同一份 HTML 写两处：桌面「今日报表」里的面板，和手机的 C STATUS 底部抽屉（#cstatus-drawer）。
  function renderCstatusPanel() {
    const targets = ["sheet-cstatus-rows", "cstatus-drawer-rows"]
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    if (!targets.length) return;
    const rows = dailyReport?.companyRows || [];
    const alertSet = new Set((dailyReport?.reconcileAlerts || []).map((r) => r.name));
    const badge = document.getElementById("cstatus-drawer-badge");
    if (badge) {
      badge.textContent = alertSet.size ? String(alertSet.size) : "";
      badge.hidden = !alertSet.size;
    }
    if (!rows.length) {
      targets.forEach((tbody) => { tbody.innerHTML = '<tr><td colspan="4" class="sheet-empty">No C STATUS today</td></tr>'; });
      return;
    }
    const html = rows.map((r) => `
      <tr class="${alertSet.has(r.name) ? "cstatus-unbalanced" : ""}">
        <td class="cstatus-name" translate="no">${alertSet.has(r.name) ? `<button type="button" class="cstatus-focus" data-cstatus="${esc(r.name)}">${esc(r.name)}</button>` : esc(r.name)}</td>
        <td class="num-col in-cell ${r.in ? "has-amount" : ""}" translate="no"${r.in ? ` title="${esc(fmtSigned(r.in))}"` : ""}>${r.in ? fmtSigned(r.in) : ""}</td>
        <td class="num-col out-cell ${r.out ? "has-amount" : ""}" translate="no"${r.out ? ` title="${esc(fmtSigned(r.out))}"` : ""}>${r.out ? fmtSigned(r.out) : ""}</td>
        <td class="num-col total-cell ${r.total ? "has-amount" : ""}" translate="no" title="${esc(fmtSigned(r.total))}">${fmtSigned(r.total)}</td>
      </tr>`).join("");
    targets.forEach((tbody) => { tbody.innerHTML = html; });
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
        BC.statusList().map((s) => `<option value="${esc(s.value)}">${esc(s.label)}</option>`).join("");
    }
    if (dl) {
      dl.setAttribute("translate", "no");
      dl.innerHTML = BC.statusList().map((s) => `<option value="${esc(s.label)}">`).join("");
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



  function deletedHelpTrfAmount(r) {
    return Number(r.help_amount || 0) + Number(r.trf_amount || 0);
  }
  // 确认框里「动的是哪一笔 / 哪个户口」那一行（规则与测试见 operation-target.js）。
  function ledgerTargetFor(r) {
    if (!r) return "";
    const bank = bankRows.find((b) => Number(b.id) === Number(r.bank_account_id));
    return window.ledgerTargetDetail(r, {
      statusLabel: statusLabel(inferRowStatus(r)),
      name: ledgerNameText(r.name),
      bankLabel: bank ? bankBranchOf(bank) : (bankBranchOf(r) || r.bank_acc || ""),
    });
  }
  let deletedLedgerById = new Map();
  function renderDeletedLedgerRows(rows) {
    deletedLedgerById = new Map(rows.map((r) => [Number(r.id), r]));
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
        <td class="mono">${esc(window.sqlUtcToSydney(r.deleted_at))}</td>
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
      detail: ledgerTargetFor(deletedLedgerById.get(Number(id))),
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


  // opts.silent\uff1a\u540e\u53f0\u5237\u65b0\u65f6\u53ea\u662f\u628a\u9875\u7b7e\u72b6\u6001\u753b\u56de\u53bb\uff0c\u4e0d\u7b97\u300c\u4eba\u770b\u8fc7\u4e86\u300d\uff0c\u4e0d\u80fd\u987a\u624b\u628a\u5e73\u53f0\u5f85\u5ba1\u6279
  // \u62a5\u8b66 ack \u6389\uff08\u63a5\u5355\u533a\u5e38\u9a7b\u9875\u9762\uff0c\u6bcf\u8f6e\u5237\u65b0\u90fd ack \u7684\u8bdd\u62a5\u8b66\u6c38\u8fdc\u4e0d\u4f1a\u54cd\uff09\u3002
  function switchPendingTab(tab, opts) {
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
    if (!opts?.silent && tab === "tx" && typeof window.acknowledgePlatformPendingSound === "function") {
      window.acknowledgePlatformPendingSound();
    }
  }
  function setPendingTabCounts(txCount, skippedCount) {
    lastSkippedPendingCount = Number(skippedCount || 0);
    updateIntakeEmpty(txCount, skippedCount);
    document.querySelectorAll(".pending-tab").forEach((b) => {
      const tab = b.dataset.tab;
      const n = tab === "skipped" ? skippedCount : txCount;
      const base = tab === "skipped" ? "已跳过" : "平台订单";
      // 笔数单独一个节点：整串「平台订单 (3)」不是字典 key，英文模式下会原样漏出中文。
      b.innerHTML = `<span>${base}</span>${n > 0 ? ` <span class="pending-tab-count" translate="no">(${n})</span>` : ""}`;
    });
  }
  // 审批行的两个银行下拉：固定顺序、不加位置序号、不按「上次用过」重排（规则与测试见 ledger-bank-pick.js）。
  function bankOptionsHtml(selected) {
    return window.bankSelectOptionsHtml(usableBanks(), tabLabel, selected);
  }
  function pendingBankOptionsHtml() {
    return window.bankSelectOptionsHtml(usableBanks(), tabLabel);
  }

  // ---- 实时收款银行（server/lib/bankLiveReceiving.js）---------------------------
  // 接单区顶上勾最多 3 个「现在正在收款的户」。充值单的 BANK 下拉只列它们、不预选，末尾留
  // 「其他渠道…」：客户转进了非实时的户（比如还在用旧户）时，选它就展开完整列表——不留退路
  // 会在真实对账时把人卡死。一个都没勾就是原来的完整列表。提现单不受影响。
  const OTHER_BANKS = "__other__";
  const LIVE_MAX = 3;
  let liveSaving = false;
  function liveBanks() {
    return usableBanks().filter((b) => Number(b.live_receiving));
  }
  function depositBankOptionsHtml() {
    const live = liveBanks();
    if (!live.length) return pendingBankOptionsHtml();
    return window.bankSelectOptionsHtml(live, tabLabel)
      + `<option value="${OTHER_BANKS}">其他渠道…</option>`;
  }
  // 实时名单变了：没动过的充值行就地换下拉；员工动过的行（data-dirty）与已展开完整列表的
  // 不碰——正在选的东西不能在手里被换掉。
  function refreshDepositBankSelects() {
    document.querySelectorAll('#pending-tx-rows tr[data-txid]:not([data-dirty="1"]) select.pend-bank-deposit:not([data-expanded])')
      .forEach((sel) => { sel.innerHTML = depositBankOptionsHtml(); });
  }
  function renderLivePicker() {
    const box = document.getElementById("bk-live");
    if (!box) return;
    const usable = usableBanks();
    box.hidden = !usable.length;
    if (!usable.length) return;
    const live = liveBanks();
    const open = Boolean(box.querySelector(".bk-live-pop:not([hidden])"));
    const chips = live.map((b) =>
      `<span class="bk-live-chip"><span translate="no">${esc(tabLabel(b))}</span><button type="button" class="bk-live-remove" data-id="${b.id}" aria-label="取消实时收款" title="取消实时收款"${liveSaving ? " disabled" : ""}>×</button></span>`
    ).join("");
    const full = live.length >= LIVE_MAX;
    const options = usable.map((b) => {
      const checked = Number(b.live_receiving) === 1;
      const idle = !Number(b.active);
      const disabled = liveSaving || idle || (full && !checked);
      return `<label class="bk-live-option${disabled ? " is-disabled" : ""}"><input type="checkbox" class="bk-live-check" value="${b.id}"${checked ? " checked" : ""}${disabled ? " disabled" : ""}><span translate="no">${esc(tabLabel(b))}</span>${idle ? `<small>${esc(tr("未启用"))}</small>` : ""}</label>`;
    }).join("");
    box.innerHTML = `<span class="bk-live-label">实时收款</span>`
      + (chips || `<span class="bk-live-empty">未设置实时收款银行</span>`)
      + `<button type="button" class="bk-live-add" aria-haspopup="true" aria-expanded="${open ? "true" : "false"}">+ 选择</button>`
      + `<div class="bk-live-pop"${open ? "" : " hidden"}><div class="bk-live-pop-head"><span>最多选 3 个</span><strong translate="no">${live.length} / ${LIVE_MAX}</strong></div>${options}</div>`;
  }
  function saveLiveReceiving(ids) {
    if (liveSaving) return Promise.resolve();
    liveSaving = true;
    renderLivePicker();
    return api("/api/banks/live-receiving", { method: "PUT", body: JSON.stringify({ bank_ids: ids }) })
      .then(() => loadBanks())
      .catch((e) => showToast(e.message || "保存失败", { tone: "error" }))
      .finally(() => {
        liveSaving = false;
        renderLivePicker();
        refreshDepositBankSelects();
      });
  }
  function bindLivePicker() {
    const box = document.getElementById("bk-live");
    if (!box || box.dataset.bound === "1") return;
    box.dataset.bound = "1";
    const setOpen = (open) => {
      box.querySelector(".bk-live-pop")?.toggleAttribute("hidden", !open);
      box.querySelector(".bk-live-add")?.setAttribute("aria-expanded", open ? "true" : "false");
    };
    box.addEventListener("click", (e) => {
      if (e.target.closest(".bk-live-add")) {
        setOpen(Boolean(box.querySelector(".bk-live-pop[hidden]")));
        return;
      }
      const remove = e.target.closest(".bk-live-remove");
      if (remove) saveLiveReceiving(liveBanks().map((b) => b.id).filter((id) => id !== Number(remove.dataset.id)));
    });
    box.addEventListener("change", (e) => {
      const chk = e.target.closest(".bk-live-check");
      if (!chk) return;
      const ids = liveBanks().map((b) => b.id).filter((id) => id !== Number(chk.value));
      if (chk.checked) ids.push(Number(chk.value));
      saveLiveReceiving(ids);
    });
    document.addEventListener("pointerdown", (e) => {
      if (!box.contains(e.target)) setOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !box.querySelector(".bk-live-pop[hidden]")) setOpen(false);
    });
  }
  // 待处理平台单：先画一批，「显示更多」往后追加，不重画已有的行（员工填了一半的不丢）。
  // 搜索与类型筛选规则见 pending-filter.js（有测试）。2026-11-06 员工演练：400+ 行一次全画、
  // 没有搜索和分页。
  let pendingTxAll = [];
  let pendingTxView = [];
  let pendingTxShown = 0;
  function pendingTxRowHtml(r, defaultPendTime) {
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
           <div class="pend-help-summary" hidden role="status" aria-label="调钱方向和状态"><strong>IN</strong><span translate="no">${esc(statusLabel("withdraw") || "WITHDRAW")}</span></div>`
        : `<select class="pend-mode"><option value="bank">本户</option><option value="redeposit">REDEP</option></select>`}</td>
      <td>${isWd
         ? `<select class="pend-bank">${pendingBankOptionsHtml()}</select>
           <input class="pend-cstatus" list="cstatus-datalist" data-cstatus-pick aria-label="调钱 C STATUS" placeholder="C STATUS / multiple ok" hidden>
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
        : `<select class="pend-bank pend-bank-deposit">${depositBankOptionsHtml()}</select>`}</td>
      <td><input class="pend-remark" placeholder="REMARK"></td>
      <td>
        <button type="button" class="btn btn-success btn-xs pend-approve">审批</button>
        <button type="button" class="btn btn-outline btn-xs pend-skip">跳过</button>
      </td>
    </tr>`;
  }
  function bindPendingTxRow(tr) {
    tr.dataset.bound = "1";
    // 员工动过这一行（日期、时间、模式、BANK、REMARK、拆分……）就标脏：后台刷新绝不重画它。
    const markDirty = () => { tr.dataset.dirty = "1"; };
    tr.addEventListener("input", markDirty);
    tr.addEventListener("change", markDirty);
    // 充值单选「其他渠道…」：这一行的下拉展开成完整列表（只这一行），让人重新选。
    const depositBank = tr.querySelector("select.pend-bank-deposit");
    depositBank?.addEventListener("change", () => {
      if (depositBank.value !== OTHER_BANKS) return;
      depositBank.innerHTML = pendingBankOptionsHtml();
      depositBank.dataset.expanded = "1";
      depositBank.focus();
      try { depositBank.showPicker?.(); } catch (_) {}
    });
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
    // 改成今天时时间跳到现在：留着平台单的时间（如 16:55）会落成一笔未来流水，服务端会拒（员工演练发现）。
    dateInput?.addEventListener("change", () => {
      const timeInput = tr.querySelector(".pend-time");
      if (timeInput && dateInput.value === todaySydney()) timeInput.value = nowTime();
    });
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
  }
  function updatePendingMore() {
    const count = document.getElementById("pending-more-count");
    if (count) count.textContent = pendingTxView.length ? `${pendingTxShown} / ${pendingTxView.length}` : "";
    document.getElementById("pending-more-btn")?.toggleAttribute("hidden", pendingTxShown >= pendingTxView.length);
  }
  function appendPendingTxRows(count) {
    const txBody = document.getElementById("pending-tx-rows");
    if (!txBody) return;
    const next = pendingTxView.slice(pendingTxShown, pendingTxShown + count);
    if (next.length) {
      const defaultPendTime = nowTime();
      txBody.insertAdjacentHTML("beforeend", next.map((r) => pendingTxRowHtml(r, defaultPendTime)).join(""));
      txBody.querySelectorAll("tr[data-txid]:not([data-bound])").forEach(bindPendingTxRow);
      pendingTxShown += next.length;
    }
    updatePendingMore();
  }
  function renderPendingTx() {
    const txBody = document.getElementById("pending-tx-rows");
    if (!txBody) return;
    pendingTxView = window.filterPendingRows(pendingTxAll, {
      q: document.getElementById("pending-search")?.value || "",
      type: document.getElementById("pending-type")?.value || "",
    });
    pendingTxShown = 0;
    txBody.innerHTML = pendingTxView.length ? "" : pendingEmptyRowHtml();
    appendPendingTxRows(window.PENDING_PAGE_SIZE || 50);
  }
  function pendingEmptyRowHtml() {
    return `<tr class="pending-empty-row"><td colspan="9" class="sheet-empty">${pendingTxAll.length ? "没有匹配的平台单" : "暂无待审批平台单"}</td></tr>`;
  }
  // 别人审批 / 跳过掉了一行员工正在填的单：不拿掉（填的东西还在，人能看清发生了什么），
  // 标灰、锁住，留一个「移除」。
  function markPendingRowGone(tr) {
    if (tr.classList.contains("pend-row-gone")) return;
    tr.classList.add("pend-row-gone");
    tr.querySelectorAll("input, select, button, textarea").forEach((el) => { el.disabled = true; });
    tr.lastElementChild?.insertAdjacentHTML("beforeend",
      '<span class="pend-gone-note">已被他人处理</span><button type="button" class="btn btn-outline btn-xs pend-dismiss">移除</button>');
  }
  // 后台刷新只做增量，与 renderPendingTx（搜索 / 类型筛选变了时的整块重画）分开：
  // 新单按服务端顺序（tx_time 升序）插到该在的位置，已被处理的单拿掉；员工动过的行
  // （data-dirty）绝不重画，被别人处理掉的只标灰。已经画出来的行一律原样保留。
  function syncPendingTx() {
    const txBody = document.getElementById("pending-tx-rows");
    if (!txBody) return;
    pendingTxView = window.filterPendingRows(pendingTxAll, {
      q: document.getElementById("pending-search")?.value || "",
      type: document.getElementById("pending-type")?.value || "",
    });
    const live = new Set(pendingTxAll.map((r) => String(r.tx_id)));
    const rendered = new Map();
    txBody.querySelectorAll("tr[data-txid]").forEach((row) => {
      const id = row.dataset.txid;
      if (live.has(id)) {
        if (!row.classList.contains("pend-row-gone")) rendered.set(id, row);
      } else if (row.dataset.dirty === "1") {
        markPendingRowGone(row);
      } else {
        row.remove();
      }
    });
    const limit = Math.max(pendingTxShown, window.PENDING_PAGE_SIZE || 50);
    const defaultPendTime = nowTime();
    let anchor = null;
    let shown = 0;
    for (const r of pendingTxView) {
      if (shown >= limit) break;
      let row = rendered.get(String(r.tx_id));
      if (!row) {
        const holder = document.createElement("tbody");
        holder.innerHTML = pendingTxRowHtml(r, defaultPendTime);
        row = holder.firstElementChild;
        if (anchor) anchor.after(row);
        else txBody.prepend(row);
        bindPendingTxRow(row);
      }
      anchor = row;
      shown += 1;
    }
    pendingTxShown = shown;
    const emptyRow = txBody.querySelector("tr.pending-empty-row");
    if (txBody.querySelector("tr[data-txid]")) emptyRow?.remove();
    else if (emptyRow) emptyRow.outerHTML = pendingEmptyRowHtml();
    else txBody.insertAdjacentHTML("beforeend", pendingEmptyRowHtml());
    updatePendingMore();
  }
  let pendingLoadRequest = 0;
  function loadPendingPanels(opts) {
    const request = ++pendingLoadRequest;
    const firstLoad = intakeCounts == null;
    return Promise.all([
      api("/api/banks/pending-tx", { bg: true }),
      api("/api/banks/pending-tx/skipped?limit=100", { bg: true }),
    ]).then(([tx, skipped]) => {
      if (request !== pendingLoadRequest) return;
      const txRows = tx.rows || [];
      const skippedRows = skipped.rows || [];
      intakeCounts = [txRows.length, skippedRows.length];
      intakeLoadedAt = Date.now();
      setPendingTabCounts(txRows.length, skippedRows.length);
      const activeTab = document.querySelector(".pending-tab.active")?.dataset.tab || "tx";
      if (firstLoad) switchPendingTab(txRows.length || !skippedRows.length ? "tx" : "skipped", { silent: true });
      else switchPendingTab(activeTab, { silent: true });

      pendingTxAll = txRows;
      syncPendingTx();

      // 已跳过这一页没有输入框，整块重画即可；数据没变就不碰（按钮别在人点下去之前被换掉）。
      const skippedBody = document.getElementById("pending-skipped-rows");
      if (skippedBody && gateRender("pending-skipped", opts, skippedRows)) {
        skippedBody.innerHTML = skippedRows.map((r) => {
          const skippedName = ledgerNameText(r.name);
          return `
          <tr data-txid="${esc(r.tx_id)}">
            <td translate="no">${esc(r.tx_type)}</td>
            <td class="mono">${esc(String(r.tx_time || "").slice(0, 16))}</td>
            <td class="mono" translate="no">${esc(r.tx_id)}</td>
            <td translate="no">${esc(r.username)} / ${esc(skippedName)}</td>
            <td class="num-col">${fmt(r.amount)}</td>
            <td class="mono">${esc(window.sqlUtcToSydney(r.decided_at))}</td>
            <td>${esc(r.decided_by || "")}</td>
            <td>
              <button type="button" class="btn btn-success btn-xs pend-restore">恢复</button>
              <button type="button" class="btn btn-danger btn-xs pend-delete">删除</button>
            </td>
          </tr>`;
        }).join("") || '<tr><td colspan="8" class="sheet-empty">暂无已跳过的平台单</td></tr>';
      }
    });
  }
  function addPendingSplitRow(tr, values = {}) {
    const container = tr?.querySelector(".pend-split-rows");
    if (!container) return null;
    const row = document.createElement("div");
    row.className = "pend-split-row";
    row.innerHTML = `<input class="pend-split-cstatus" list="cstatus-datalist" data-cstatus-pick value="${esc(values.c_status || "")}" aria-label="协助方 C STATUS" placeholder="协助方公司">
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
    // 后台轮询：数据和上次画的一样就不重绘，否则按钮在员工点下去之前就被换掉（员工演练 4/4）。
    return loadBanks({ background: true })
      .then(() => Promise.all([loadSheet({ background: true }), loadDailyReport({ background: true }), refreshPendingBadge()]))
      .catch(() => {})
      .finally(() => { sharedRefreshInFlight = false; });
  }

  const MOBILE_TAB_ACTIONS = ["pending", "ledger", "transfer", "channels"];
  function runMobileTab(action) {
    if (action === "pending") openIntake("tx");
    else if (action === "transfer") openTransferModal();
    // 渠道已经是独立的一页（老书签 /bank-accounts.html#channels 也会走到这里）。
    else if (action === "channels") location.href = "/bank-channels.html";
    else if (action === "ledger") {
      closeIntakeSheet();
      document.querySelector(".bkv2 .bk-grid-head")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
  function runMobileTabFromHash() {
    const action = String(location.hash || "").slice(1);
    if (!MOBILE_TAB_ACTIONS.includes(action)) return;
    // 先清掉 hash：否则刷新页面会再弹一次，关掉弹窗后地址栏也还挂着它。
    try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {}
    runMobileTab(action);
  }
  // 换公司：接单区里上一家公司的行（包括填了一半的）全部作废，不能被当成「已被他人处理」留着。
  function resetIntake() {
    intakeCounts = null;
    pendingTxAll = [];
    pendingTxShown = 0;
    const txBody = document.getElementById("pending-tx-rows");
    if (txBody) txBody.innerHTML = "";
    renderGate.remember("pending-skipped", null); // 下一轮无论数据是什么都重画已跳过
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
    // 老书签 /bank-accounts.html#channels 经 302 落到这里，hash 原样带着。
    if (location.hash === "#channels") {
      location.replace("/bank-channels.html");
      return;
    }
    sheetDate = todaySydney();
    const dateEl = document.getElementById("sheet-date");
    if (dateEl) dateEl.value = sheetDate;
    activeBankId = bankFromUrl();

    let intakeCollapsed = false;
    try { intakeCollapsed = localStorage.getItem(INTAKE_COLLAPSED_KEY) === "1"; } catch (_) {}
    setIntakeCollapsed(intakeCollapsed, false);
    document.getElementById("bk-intake-toggle")?.addEventListener("click", () => {
      setIntakeCollapsed(!intakeZone()?.classList.contains("is-collapsed"), true);
    });
    document.getElementById("bk-intake-close")?.addEventListener("click", closeIntakeSheet);
    bindLivePicker();
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && intakeZone()?.classList.contains("is-sheet-open")) closeIntakeSheet();
    });
    // 人点进接单区 = 看到了，平台待审批的报警进入静默（跟以前打开弹窗时一样）。
    intakeZone()?.addEventListener("pointerdown", () => {
      if (typeof window.acknowledgePlatformPendingSound === "function") window.acknowledgePlatformPendingSound();
    });
    // 宽屏 ↔ 手机来回切（转屏、拉窗口）时，浮层状态不能留在宽屏布局上。
    MOBILE_MQ.addEventListener?.("change", () => { if (!MOBILE_MQ.matches) closeIntakeSheet(); });
    document.getElementById("sheet-bank-filter")?.addEventListener("change", (e) => {
      editingRowId = null;
      adding = false;
      hideGridPicker();
      resetEnterSave();
      setActiveBank(e.target.value);
    });

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

    // 手机底部标签栏：在本页直接执行；从别的页点过来带着 #pending 之类的 hash，
    // 等首轮数据（渠道列表）到齐再执行——调钱表单的 BANK 下拉要靠它填。
    window.bankMobileTab = runMobileTab;
    reloadAll().then(runMobileTabFromHash, runMobileTabFromHash);

    if (typeof startSyncWatcher === "function") {
      startSyncWatcher(() => reloadAll());
    }
    if (typeof bindCompanySwitch === "function") {
      bindCompanySwitch(() => {
        resetIntake();
        return reloadAll();
      });
    }
    window.addEventListener("company-changed", refreshWorkspaceContext);
    window.addEventListener("language-changed", () => {
      renderBankFilter();
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
    // 手机上调钱 / 转出 / 待处理调钱 / 拆分协助方的 C STATUS 输入框：点开底部抽屉选（cstatus-sheet.js）。
    window.bindCstatusSheet?.(cStatusNames);
    // 手机 C STATUS 底部抽屉：开关走通用弹窗（app.js 管 × / Esc / 焦点）。点未对平的名字先关抽屉再筛流水。
    document.getElementById("cstatus-drawer-btn")?.addEventListener("click", () => {
      document.getElementById("cstatus-drawer")?.classList.add("show");
    });
    document.getElementById("cstatus-drawer-rows")?.addEventListener("click", (e) => {
      const focus = e.target.closest(".cstatus-focus");
      if (!focus) return;
      document.getElementById("cstatus-drawer")?.classList.remove("show");
      focusLedgerByCstatus(focus.dataset.cstatus || "");
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
          detail: ledgerTargetFor(ledgerRows.find((r) => Number(r.id) === id)),
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

    document.getElementById("sheet-deleted-btn")?.addEventListener("click", openDeletedLedgerModal);
    document.getElementById("deleted-ledger-close")?.addEventListener("click", () => {
      document.getElementById("deleted-ledger-modal")?.classList.remove("show");
    });
    document.getElementById("deleted-ledger-modal")?.addEventListener("click", (e) => {
      const restore = e.target.closest(".deleted-restore");
      if (restore) restoreDeletedLedger(Number(restore.dataset.id));
    });

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
    document.querySelectorAll(".pending-tab").forEach((btn) => {
      btn.addEventListener("click", () => switchPendingTab(btn.dataset.tab));
    });
    document.getElementById("pending-search")?.addEventListener("input", renderPendingTx);
    document.getElementById("pending-type")?.addEventListener("change", renderPendingTx);
    document.getElementById("pending-more-btn")?.addEventListener("click", () => appendPendingTxRows(window.PENDING_PAGE_SIZE || 50));
    document.getElementById("pending-tx-rows")?.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-txid]");
      if (!tr) return;
      const txId = tr.dataset.txid;
      if (e.target.closest(".pend-dismiss")) {
        tr.remove();
        syncPendingTx();
        return;
      }
      if (e.target.closest(".pend-skip")) {
        requestOperationReason({
          title: "跳过平台单",
          description: "请记录暂不处理这笔平台单的原因。今天内可在「已跳过」恢复；过了今天自动过期，无法恢复，这笔钱也不会入账。",
          target: `平台交易 ${txId}`,
          confirmLabel: "确认跳过",
        }).then((reason) => {
          if (!reason) return null;
          return api(`/api/banks/pending-tx/${encodeURIComponent(txId)}/skip`, {
            method: "POST",
            body: JSON.stringify({ reason }),
          }).then(() => {
            // 先拿掉这一行：它是员工自己动过的（脏行），不拿掉会被刷新当成「已被他人处理」。
            tr.remove();
            showToast("已跳过，今天内可在「已跳过」恢复", { tone: "success" });
            loadPendingPanels();
            refreshPendingBadge();
          });
        });
        return;
      }
      const approveBtn = e.target.closest(".pend-approve");
      if (!approveBtn || approveBtn.disabled) return;
      const modeEl = tr.querySelector(".pend-mode");
      const mode = modeEl ? modeEl.value : "bank";
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
      // 接单区常驻页面，连点两下的机会比弹窗多：请求在途时锁住这一行的审批按钮。
      approveBtn.disabled = true;
      api(`/api/banks/pending-tx/${encodeURIComponent(txId)}/approve`, {
        method: "POST",
        body: JSON.stringify(body),
      }).then(() => {
        tr.remove(); // 同上：先拿掉，别被刷新标成「已被他人处理」
        return reloadAll().then(() => loadPendingPanels());
      }).catch((err) => {
        approveBtn.disabled = false;
        if (mode === "split") updatePendingSplitState(tr);
        showToast(err.message || "审批失败", { tone: "error" });
      });
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
