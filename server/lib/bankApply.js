"use strict";

const { refreshBankBalance, bankBranchOf } = require("./bankReport");
const { SQL_OPERATING } = require("./bankLifecycle");
const { formatWallClock, todayKey } = require("./dates");
const { cleanLedgerName } = require("./displayName");
const { isDemoTenant } = require("./readConfig");
const {
  LEDGER_FIELDS,
  PENDING_FIELDS,
  appendAuditEvent,
  ledgerRefs,
  pendingRefs,
  pickFields,
  runAtomic,
  systemActor,
} = require("./auditLog");

const ACCOUNT_KINDS = ["payment_gateway", "ghost", "nominee"];
const C_STATUS_DEFAULTS = [
  { name: "EZ68", target: "ezspin68" },
  { name: "PK7", target: "pokies7bet" },
  { name: "RX66", target: "rolex66" },
  { name: "AuX6", target: "aussiex6" },
  { name: "LH", target: "" },
];

const IN_STATUSES = new Set(["deposit", "cash in", "new", "bank transfer", "unclaim", "redeposit", "amopay", "test in"]);
const OUT_STATUSES = new Set(["withdraw", "wrong", "cash out", "give back", "expenses", "exchange", "bank trf", "test out"]);
const PLATFORM_LEDGER_STATUSES = new Set(["deposit", "withdraw", "cash in"]);

function nowSql() {
  return formatWallClock();
}

function normalizeSqlDateTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  // 只有**结尾**带 Z 或带偏移才算「带时区的瞬间」，才交给 formatWallClock 去换算。
  //
  // ⚠️ 这个判定以前写成 /[TzZ]|.../，把 ISO 的**分隔符 T** 和时区标记 Z 混进了同一个
  // 字符类，于是 "2026-09-15T23:50" 这种裸时间串也被送进 Date.parse——而 ES 规范
  // 规定不带偏移的日期时间串按**进程本地时区**解析，不是按配置时区。结果同一个输入
  // 在不同实例上会被静默平移「进程 TZ 与配置 TZ 之差」那么多小时（马来实例留着
  // TZ=Australia/Sydney 就是 2 小时）。裸时间串必须走下面「原样当墙上时间」那条路。
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) return formatWallClock(raw);
  const text = raw.replace("T", " ");
  const m = text.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2}(?::\d{2})?)/);
  if (!m) return "";
  const [year, month, day] = m[1].split("-").map(Number);
  const dateCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    dateCheck.getUTCFullYear() !== year
    || dateCheck.getUTCMonth() + 1 !== month
    || dateCheck.getUTCDate() !== day
  ) return "";
  const parts = m[2].split(":");
  const hh = String(Math.min(23, Math.max(0, Number(parts[0]) || 0))).padStart(2, "0");
  const mm = String(Math.min(59, Math.max(0, Number(parts[1]) || 0))).padStart(2, "0");
  const ss = String(Math.min(59, Math.max(0, Number(parts[2]) || 0))).padStart(2, "0");
  return `${m[1]} ${hh}:${mm}:${ss}`;
}

function pendingLedgerEntryTime(pending, requested) {
  const txTime = normalizeSqlDateTime(pending?.tx_time) || nowSql();
  const reqTime = normalizeSqlDateTime(requested);
  if (String(requested || "").trim() && !reqTime) {
    throw Object.assign(new Error("入账日期或时间无效"), { status: 400 });
  }
  // Keep the platform timestamp in pending.tx_time. The separately stored
  // approval timestamp is intentionally editable and remains auditable.
  return reqTime || txTime;
}

function money(n) {
  const v = Number(n || 0);
  return Number.isFinite(v) ? Math.abs(v) : 0;
}

function auditActorValue(actor) {
  if (actor && typeof actor === "object") return actor;
  const username = String(actor || "").trim();
  return {
    type: username ? "unknown" : "unknown",
    userId: null,
    username,
    name: "",
    role: "",
  };
}

function actorUsername(actor) {
  if (actor && typeof actor === "object") return String(actor.username || actor.name || "");
  return String(actor || "");
}

function bankAccLabel(bank) {
  if (!bank) return "";
  const head = (bankBranchOf(bank) || "Bank").slice(0, 40);
  const sub = String(bank.account_name || bank.payid || "").trim().slice(0, 40);
  return sub ? `${head} (${sub})` : head;
}

function mapAmountFields(direction, status, amount) {
  const amt = money(amount);
  const st = String(status || "").toLowerCase().trim();
  const dir = String(direction || "").toLowerCase() === "out" ? "out" : "in";
  const fields = {
    status: st,
    amount_in: 0,
    amount_out: 0,
    help_amount: 0,
    trf_amount: 0,
  };
  if (dir === "in") {
    if (st === "bank transfer") fields.trf_amount = amt;
    else fields.amount_in = amt;
    if (!st) fields.status = "deposit";
  } else {
    if (st === "bank trf") fields.help_amount = amt;
    else fields.amount_out = amt;
    if (!st) fields.status = "withdraw";
  }
  return fields;
}

// Keep manual IN/OUT status validation in sync with the dropdown options.
const TRANSFER_IN_STATUSES = new Set(["deposit", "cash in", "new", "bank transfer", "unclaim", "redeposit", "amopay", "test in"]);
const TRANSFER_OUT_STATUSES = new Set(["withdraw", "wrong", "cash out", "give back", "expenses", "exchange", "bank trf", "test out"]);

function assertTransferStatus(direction, status) {
  const dir = String(direction || "").toLowerCase() === "in" ? "in" : "out";
  const st = String(status || "").toLowerCase().trim();
  const allowed = dir === "in" ? TRANSFER_IN_STATUSES : TRANSFER_OUT_STATUSES;
  if (!allowed.has(st)) {
    throw Object.assign(new Error(`${dir === "in" ? "IN" : "OUT"} 调钱状态无效`), { status: 400 });
  }
  return st;
}

function ensureCStatusOptions(db, companyId) {
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM bank_c_status_options WHERE company_id = ?")
    .get(companyId).n;
  if (count > 0) return;
  if (isDemoTenant()) return;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO bank_c_status_options (company_id, name, target_company_id, sort_order)
     VALUES (?, ?, ?, ?)`
  );
  C_STATUS_DEFAULTS.forEach((o, i) => {
    const target = o.target && o.target !== companyId ? o.target : "";
    ins.run(companyId, o.name, target, i + 1);
  });
}

function listCStatusOptions(db, companyId) {
  ensureCStatusOptions(db, companyId);
  return db
    .prepare(
      `SELECT name, target_company_id, reconcile_required, sort_order FROM bank_c_status_options
       WHERE company_id = ? ORDER BY sort_order ASC, name ASC`
    )
    .all(companyId);
}

function upsertCStatusOption(db, companyId, name, targetCompanyId, reconcileRequired) {
  const n = String(name || "").trim();
  if (!n) return null;
  ensureCStatusOptions(db, companyId);
  const existing = db
    .prepare("SELECT * FROM bank_c_status_options WHERE company_id = ? AND name = ?")
    .get(companyId, n);
  if (existing) {
    if (targetCompanyId != null) {
      db.prepare(
        "UPDATE bank_c_status_options SET target_company_id = ? WHERE company_id = ? AND name = ?"
      ).run(String(targetCompanyId), companyId, n);
    }
    if (reconcileRequired != null) {
      db.prepare(
        "UPDATE bank_c_status_options SET reconcile_required = ? WHERE company_id = ? AND name = ?"
      ).run(Number(reconcileRequired) ? 1 : 0, companyId, n);
    }
    return db
      .prepare("SELECT * FROM bank_c_status_options WHERE company_id = ? AND name = ?")
      .get(companyId, n);
  }
  const max = db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM bank_c_status_options WHERE company_id = ?")
    .get(companyId).m;
  db.prepare(
    `INSERT INTO bank_c_status_options (company_id, name, target_company_id, reconcile_required, sort_order)
     VALUES (?, ?, ?, ?, ?)`
  ).run(companyId, n, targetCompanyId == null ? "" : String(targetCompanyId), Number(reconcileRequired) ? 1 : 0, max + 1);
  return db
    .prepare("SELECT * FROM bank_c_status_options WHERE company_id = ? AND name = ?")
    .get(companyId, n);
}

function splitCStatusNames(value) {
  return String(value || "")
    .split(/[,\n;\/|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function linkedCompanyForCStatus(db, companyId, value) {
  for (const name of splitCStatusNames(value)) {
    const row = db
      .prepare(
        `SELECT target_company_id FROM bank_c_status_options
         WHERE company_id = ? AND name = ? AND target_company_id <> ?
         LIMIT 1`
      )
      .get(companyId, name, companyId);
    const target = String(row?.target_company_id || "").trim();
    if (target) return target;
  }
  return "";
}

function upsertCStatusOptions(db, companyId, value, targetCompanyId) {
  const names = splitCStatusNames(value);
  if (!names.length) return null;
  let last = null;
  names.forEach((name) => {
    last = upsertCStatusOption(db, companyId, name, targetCompanyId);
  });
  return last;
}

function logAccountEvent(db, { companyId, bankAccountId, event, note, user }) {
  db.prepare(
    `INSERT INTO bank_account_events (company_id, bank_account_id, event, note, actor)
     VALUES (?, ?, ?, ?, ?)`
  ).run(companyId, bankAccountId, event, String(note || ""), String(user || ""));
}

function insertLedger(db, row) {
  const result = db
    .prepare(
      `INSERT INTO bank_ledger
        (bank_account_id, company_id, entry_time, tx_id, status, amount_in, amount_out,
         help_amount, trf_amount, bank_acc, username, name, c_status, other_info, remark,
         auto_generated, transfer_group_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number(row.bank_account_id || 0),
      row.company_id,
      row.entry_time || nowSql(),
      String(row.tx_id || ""),
      String(row.status || "deposit"),
      money(row.amount_in),
      money(row.amount_out),
      money(row.help_amount),
      money(row.trf_amount),
      String(row.bank_acc || ""),
      String(row.username || ""),
      row.auto_generated ? cleanLedgerName(row.name) : String(row.name || ""),
      String(row.c_status || ""),
      String(row.other_info || ""),
      String(row.remark || ""),
      row.auto_generated ? 1 : 0,
      String(row.transfer_group_id || "")
    );
  const id = result.lastInsertRowid;
  if (row.bank_account_id) refreshBankBalance(db, Number(row.bank_account_id));
  return db.prepare("SELECT * FROM bank_ledger WHERE id = ?").get(id);
}

function markBalanceLog(db, bankAccountId, txId, amount) {
  if (!txId) return;
  db.prepare(
    "INSERT OR IGNORE INTO bank_balance_log (bank_account_id, tx_id, amount) VALUES (?, ?, ?)"
  ).run(Number(bankAccountId || 0), String(txId), money(amount));
}

function enqueuePendingTx(db, companyId, mappedTxs) {
  if (!mappedTxs?.length) return 0;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO bank_tx_pending
      (company_id, tx_id, tx_type, amount, username, name, tx_time, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
  );
  let n = 0;
  for (const t of mappedTxs) {
    if (!t?.id) continue;
    const typ = String(t.type || "").toUpperCase();
    if (typ !== "DEPOSIT" && typ !== "WITHDRAW") continue;
    const logged = db.prepare("SELECT 1 FROM bank_balance_log WHERE tx_id = ?").get(t.id);
    if (logged) continue;
    const txTime = normalizeSqlDateTime(t.created_at) || nowSql();
    const info = ins.run(
      companyId,
      t.id,
      typ,
      money(t.amount),
      t.username || "",
      cleanLedgerName(t.name),
      txTime
    );
    if (info.changes) n += 1;
  }
  return n;
}

function listPendingTx(db, companyId) {
  return db
    .prepare(
      `SELECT * FROM bank_tx_pending
       WHERE company_id = ? AND state = 'pending'
       ORDER BY tx_time ASC, id ASC`
    )
    .all(companyId);
}

function expireSkippedPendingTx(db, companyId, dateKey) {
  const rows = db.prepare(
    `SELECT * FROM bank_tx_pending
     WHERE company_id = ? AND state = 'skipped' AND substr(tx_time, 1, 10) < ?`
  ).all(companyId, dateKey);
  if (!rows.length) return 0;
  return runAtomic(db, () => {
    const update = db.prepare(
      `UPDATE bank_tx_pending SET state='expired', decided_at=COALESCE(decided_at, datetime('now'))
       WHERE id=? AND company_id=? AND state='skipped'`
    );
    for (const row of rows) {
      const result = update.run(row.id, companyId);
      if (!result.changes) continue;
      const saved = db.prepare("SELECT * FROM bank_tx_pending WHERE id=?").get(row.id);
      appendAuditEvent(db, {
        companyId,
        action: "pending.expired",
        source: "system",
        actor: systemActor("\u8df3\u8fc7\u5355\u8fc7\u671f\u4efb\u52a1"),
        summary: `Skipped 平台单 ${row.tx_id} 已自动过期`,
        before: pickFields(row, PENDING_FIELDS),
        after: pickFields(saved, PENDING_FIELDS),
        metadata: { automatic: true, trigger: "day_rollover" },
        refs: pendingRefs(saved),
        dedupeKey: `system:pending_expired:${row.id}`,
      });
    }
    return rows.length;
  });
}

function listSkippedPendingTx(db, companyId, limit = 100, dateKey = todayKey()) {
  expireSkippedPendingTx(db, companyId, dateKey);
  return db
    .prepare(
      `SELECT * FROM bank_tx_pending
       WHERE company_id = ? AND state = 'skipped' AND substr(tx_time, 1, 10) = ?
       ORDER BY decided_at DESC, id DESC
       LIMIT ?`
    )
    .all(companyId, dateKey, Math.min(300, Math.max(1, Number(limit || 100))));
}

function approvePendingTx(db, companyId, txId, body, actor) {
  const pending = db
    .prepare("SELECT * FROM bank_tx_pending WHERE company_id = ? AND tx_id = ? AND state = 'pending'")
    .get(companyId, txId);
  if (!pending) throw Object.assign(new Error("Pending not found"), { status: 404 });

  const mode = String(body.mode || "bank");
  const remark = String(body.remark || "").trim();
  const approvedBy = actorUsername(actor);
  const entryTime = pendingLedgerEntryTime(pending, body.entry_time);

  let splitRows = null;
  let splitSelfAmount = 0;
  let splitSelfBankId = 0;
  let splitSelfBank = null;
  if (mode === "help_split") {
    if (pending.tx_type !== "WITHDRAW") {
      throw Object.assign(new Error("只有 withdraw 平台单可以拆分调钱"), { status: 400 });
    }
    const pendingTotalCents = Math.round(money(pending.amount) * 100);
    splitSelfAmount = money(body.self_amount);
    if (Math.round(splitSelfAmount * 100) > pendingTotalCents) {
      throw Object.assign(new Error(`本户自付不能超过平台单金额 ${money(pending.amount).toFixed(2)}`), { status: 400 });
    }
    if (!Array.isArray(body.splits) || body.splits.length < 1 || body.splits.length > 50) {
      throw Object.assign(new Error("请至少添加 1 个协助方"), { status: 400 });
    }
    const seen = new Set();
    splitRows = body.splits.map((row) => {
      const cStatus = String(row?.c_status || "").trim();
      const amount = money(row?.amount);
      const key = cStatus.toLowerCase();
      if (!cStatus) throw Object.assign(new Error("每个协助方都要填写 C STATUS"), { status: 400 });
      if (!amount) throw Object.assign(new Error("每个协助金额必须大于 0"), { status: 400 });
      if (seen.has(key)) throw Object.assign(new Error("C STATUS 不能重复"), { status: 400 });
      seen.add(key);
      return { c_status: cStatus, amount };
    });
    const allocationCount = (splitSelfAmount > 0 ? 1 : 0) + splitRows.length;
    if (allocationCount < 2) {
      throw Object.assign(new Error("拆分至少需要 2 个分配项"), { status: 400 });
    }
    splitSelfBankId = Number(body.self_bank_account_id || 0);
    if (splitSelfAmount > 0) {
      if (!splitSelfBankId) {
        throw Object.assign(new Error("本户自付请填写银行账户"), { status: 400 });
      }
      splitSelfBank = db
        .prepare(`SELECT * FROM bank_accounts WHERE id = ? AND company_id = ? AND ${SQL_OPERATING}`)
        .get(splitSelfBankId, companyId);
      if (!splitSelfBank) {
        throw Object.assign(new Error("本户自付银行账户无效、已封禁或已归档"), { status: 400 });
      }
    } else {
      splitSelfBankId = 0;
    }
    const splitTotalCents = Math.round(splitSelfAmount * 100)
      + splitRows.reduce((sum, row) => sum + Math.round(row.amount * 100), 0);
    if (splitTotalCents !== pendingTotalCents) {
      throw Object.assign(
        new Error(`拆分金额必须等于平台单金额 ${money(pending.amount).toFixed(2)}`),
        { status: 400 }
      );
    }
  }

  const finishAudit = (ledgers, modeName, transferGroupId = "") => {
    const saved = db.prepare("SELECT * FROM bank_tx_pending WHERE id=?").get(pending.id);
    appendAuditEvent(db, {
      companyId,
      action: "pending.approved",
      source: "user",
      actor: auditActorValue(actor),
      summary: `审批平台单 ${pending.tx_id}（${modeName}）`,
      reason: String(body.reason || "").trim(),
      before: pickFields(pending, PENDING_FIELDS),
      after: pickFields(saved, PENDING_FIELDS),
      metadata: {
        approve_mode: modeName,
        transfer_group_id: transferGroupId,
        generated_ledger_ids: ledgers.map((row) => row.id),
      },
      refs: pendingRefs(saved, ledgers),
    });
  };

  return runAtomic(db, () => {
    if (mode === "help_split") {
      const splitGroupId = makeTransferGroupId();
      const splitParts = (splitSelfAmount > 0 ? 1 : 0) + splitRows.length;
      const ledgers = [];
      if (splitSelfAmount > 0) {
        ledgers.push(insertLedger(db, {
          bank_account_id: splitSelfBankId,
          company_id: companyId,
          entry_time: entryTime,
          tx_id: pending.tx_id,
          ...mapAmountFields("out", "withdraw", splitSelfAmount),
          bank_acc: bankAccLabel(splitSelfBank),
          username: pending.username,
          name: pending.name,
          other_info: `${pending.tx_type} ${money(pending.amount).toFixed(2)} split self ${splitSelfAmount.toFixed(2)}`,
          remark,
          auto_generated: 1,
          transfer_group_id: splitGroupId,
        }));
      }
      splitRows.forEach((row, index) => {
        upsertCStatusOptions(db, companyId, row.c_status, null);
        ledgers.push(insertLedger(db, {
          bank_account_id: 0,
          company_id: companyId,
          entry_time: entryTime,
          tx_id: pending.tx_id,
          // The split still comes in as IN, but it belongs to the original
          // withdraw platform order and should keep the WITHDRAW status.
          ...mapAmountFields("in", "withdraw", row.amount),
          username: pending.username,
          name: pending.name,
          c_status: row.c_status,
          other_info: `${pending.tx_type} ${money(pending.amount).toFixed(2)} split ${index + 1 + (splitSelfAmount > 0 ? 1 : 0)}/${splitParts}`,
          remark,
          auto_generated: 1,
          transfer_group_id: splitGroupId,
        }));
      });
      markBalanceLog(db, splitSelfBankId, pending.tx_id, pending.amount);
      db.prepare(
        `UPDATE bank_tx_pending SET state='approved', bank_account_id=?, approve_mode='help_split',
          c_status=?, approved_entry_time=?, approved_at=datetime('now'), approved_by=?,
          decided_at=datetime('now'), decided_by=? WHERE id=?`
      ).run(
        splitSelfBankId,
        splitRows.map((row) => row.c_status).join(", "),
        entryTime,
        approvedBy,
        approvedBy,
        pending.id
      );
      finishAudit(ledgers, "help_split", splitGroupId);
      return {
        ledgers,
        pending,
        transfer_group_id: splitGroupId,
      };
    }

    if (mode === "redeposit") {
      const ledger = insertLedger(db, {
        bank_account_id: 0,
        company_id: companyId,
        entry_time: entryTime,
        tx_id: pending.tx_id,
        status: "redeposit",
        amount_in: 0,
        amount_out: 0,
        help_amount: 0,
        trf_amount: 0,
        username: pending.username,
        name: pending.name,
        other_info: `${pending.tx_type} ${money(pending.amount).toFixed(2)}`,
        remark: remark || "No cash movement",
        auto_generated: 1,
      });
      markBalanceLog(db, 0, pending.tx_id, 0);
      db.prepare(
        `UPDATE bank_tx_pending SET state='approved', bank_account_id=0, approve_mode='redeposit',
          approved_entry_time=?, approved_at=datetime('now'), approved_by=?,
          decided_at=datetime('now'), decided_by=? WHERE id=?`
      ).run(entryTime, approvedBy, approvedBy, pending.id);
      finishAudit([ledger], "redeposit");
      return { ledger, pending };
    }

    if (mode === "help") {
      if (pending.tx_type !== "WITHDRAW") {
        throw Object.assign(new Error("只有 withdraw 平台单可以调钱"), { status: 400 });
      }
      // A withdraw help is always inbound for the company whose customer
      // needs the payout. The helper company records its CASH OUT separately.
      const direction = "in";
      const status = "cash in";
      const cStatus = String(body.c_status || "").trim();
      if (!cStatus) {
        throw Object.assign(new Error("调钱请填写 C STATUS"), { status: 400 });
      }
      if (cStatus) upsertCStatusOptions(db, companyId, cStatus, null);
      const bankId = body.bank_account_id ? Number(body.bank_account_id) : 0;
      let bank = null;
      if (bankId) {
        bank = db
          .prepare(`SELECT * FROM bank_accounts WHERE id = ? AND company_id = ? AND ${SQL_OPERATING}`)
          .get(bankId, companyId);
        if (!bank) throw Object.assign(new Error("银行账户无效、已封禁或已归档"), { status: 400 });
      }
      // Keep the business direction/status as CASH IN, but place helped money
      // in the shared HELP TRF column so it is visually distinct from cash
      // received by this company's own bank account.
      const amounts = {
        ...mapAmountFields(direction, status, pending.amount),
        amount_in: 0,
        trf_amount: money(pending.amount),
      };
      const ledger = insertLedger(db, {
        bank_account_id: bankId,
        company_id: companyId,
        entry_time: entryTime,
        tx_id: pending.tx_id,
        ...amounts,
        bank_acc: bank ? bankAccLabel(bank) : "",
        username: pending.username,
        name: pending.name,
        c_status: cStatus,
        remark,
        auto_generated: 1,
        transfer_group_id: "",
      });
      markBalanceLog(db, bankId || 0, pending.tx_id, pending.amount);
      db.prepare(
        `UPDATE bank_tx_pending SET state='approved', bank_account_id=?, approve_mode='help',
          c_status=?, approved_entry_time=?, approved_at=datetime('now'), approved_by=?,
          decided_at=datetime('now'), decided_by=? WHERE id=?`
      ).run(bankId, cStatus, entryTime, approvedBy, approvedBy, pending.id);
      finishAudit([ledger], "help");
      return { ledger, pending };
    }

    const bankId = Number(body.bank_account_id);
    if (!bankId) throw Object.assign(new Error("请选择银行账户"), { status: 400 });
    const bank = db
      .prepare(`SELECT * FROM bank_accounts WHERE id = ? AND company_id = ? AND ${SQL_OPERATING}`)
      .get(bankId, companyId);
    if (!bank) throw Object.assign(new Error("银行账户无效、已封禁或已归档"), { status: 400 });

    const isDep = pending.tx_type === "DEPOSIT";
    const ledger = insertLedger(db, {
      bank_account_id: bankId,
      company_id: companyId,
      entry_time: entryTime,
      tx_id: pending.tx_id,
      status: isDep ? "deposit" : "withdraw",
      amount_in: isDep ? money(pending.amount) : 0,
      amount_out: isDep ? 0 : money(pending.amount),
      bank_acc: bankAccLabel(bank),
      username: pending.username,
      name: pending.name,
      remark,
      auto_generated: 1,
    });
    markBalanceLog(db, bankId, pending.tx_id, pending.amount);
    db.prepare(
      `UPDATE bank_tx_pending SET state='approved', bank_account_id=?, approve_mode='bank',
        approved_entry_time=?, approved_at=datetime('now'), approved_by=?,
        decided_at=datetime('now'), decided_by=? WHERE id=?`
    ).run(bankId, entryTime, approvedBy, approvedBy, pending.id);
    finishAudit([ledger], "bank");
    return { ledger, pending };
  });
}

function skipPendingTx(db, companyId, txId, actor, reason) {
  const pending = db
    .prepare("SELECT * FROM bank_tx_pending WHERE company_id = ? AND tx_id = ? AND state = 'pending'")
    .get(companyId, txId);
  if (!pending) throw Object.assign(new Error("Pending not found"), { status: 404 });
  return runAtomic(db, () => {
    db.prepare(
      `UPDATE bank_tx_pending SET state='skipped', decided_at=datetime('now'), decided_by=? WHERE id=?`
    ).run(actorUsername(actor), pending.id);
    const saved = db.prepare("SELECT * FROM bank_tx_pending WHERE id=?").get(pending.id);
    appendAuditEvent(db, {
      companyId,
      action: "pending.skipped",
      source: "user",
      actor: auditActorValue(actor),
      summary: `跳过平台单 ${pending.tx_id}`,
      reason,
      before: pickFields(pending, PENDING_FIELDS),
      after: pickFields(saved, PENDING_FIELDS),
      refs: pendingRefs(saved),
    });
    return saved;
  });
}

function restoreSkippedPendingTx(db, companyId, txId, actor, reason) {
  const skipped = db
    .prepare("SELECT * FROM bank_tx_pending WHERE company_id = ? AND tx_id = ? AND state = 'skipped'")
    .get(companyId, txId);
  if (!skipped) throw Object.assign(new Error("Skipped pending not found"), { status: 404 });
  return runAtomic(db, () => {
    db.prepare(
      `UPDATE bank_tx_pending
       SET state='pending', decided_at=NULL, decided_by='', bank_account_id=0, approve_mode='', c_status=''
       WHERE id=?`
    ).run(skipped.id);
    const saved = db.prepare("SELECT * FROM bank_tx_pending WHERE id = ?").get(skipped.id);
    appendAuditEvent(db, {
      companyId,
      action: "pending.restored",
      source: "user",
      actor: auditActorValue(actor),
      summary: `恢复平台单 ${skipped.tx_id} 到待处理`,
      reason,
      before: pickFields(skipped, PENDING_FIELDS),
      after: pickFields(saved, PENDING_FIELDS),
      refs: pendingRefs(saved),
    });
    return saved;
  });
}

function deleteSkippedPendingTx(db, companyId, txId, actor, reason) {
  const skipped = db
    .prepare("SELECT * FROM bank_tx_pending WHERE company_id = ? AND tx_id = ? AND state = 'skipped'")
    .get(companyId, txId);
  if (!skipped) throw Object.assign(new Error("Skipped pending not found"), { status: 404 });
  return runAtomic(db, () => {
    db.prepare(
      `UPDATE bank_tx_pending
       SET state='deleted', decided_at=datetime('now'), decided_by=?
       WHERE id=? AND company_id=? AND state='skipped'`
    ).run(actorUsername(actor), skipped.id, companyId);
    const saved = db.prepare("SELECT * FROM bank_tx_pending WHERE id=?").get(skipped.id);
    appendAuditEvent(db, {
      companyId,
      action: "pending.deleted",
      source: "user",
      actor: auditActorValue(actor),
      summary: `删除已跳过平台单 ${skipped.tx_id}`,
      reason,
      before: pickFields(skipped, PENDING_FIELDS),
      after: pickFields(saved, PENDING_FIELDS),
      refs: pendingRefs(saved),
    });
    return saved;
  });
}

function platformTxTypeForLedger(db, row) {
  if (!row?.auto_generated || !String(row.tx_id || "").trim()) return "";
  const status = String(row.status || "").trim().toLowerCase();
  if (!PLATFORM_LEDGER_STATUSES.has(status)) return "";

  const pending = db
    .prepare("SELECT tx_type FROM bank_tx_pending WHERE company_id = ? AND tx_id = ?")
    .get(row.company_id, row.tx_id);
  const pendingType = String(pending?.tx_type || "").toUpperCase();
  if (pendingType === "DEPOSIT" || pendingType === "WITHDRAW") return pendingType;

  const transaction = db
    .prepare("SELECT type FROM transactions WHERE company_id = ? AND id = ?")
    .get(row.company_id, row.tx_id);
  const transactionType = String(transaction?.type || "").toUpperCase();
  return transactionType === "DEPOSIT" || transactionType === "WITHDRAW" ? transactionType : "";
}

function reopenPendingForLedger(db, row) {
  const txType = platformTxTypeForLedger(db, row);
  if (!txType) return false;

  // The balance log is the sync-side de-duplication key. Remove it before
  // re-approval so the order can be applied to a different bank if needed.
  db.prepare("DELETE FROM bank_balance_log WHERE tx_id = ?").run(row.tx_id);

  const pending = db
    .prepare("SELECT id FROM bank_tx_pending WHERE company_id = ? AND tx_id = ?")
    .get(row.company_id, row.tx_id);
  if (pending) {
    db.prepare(
      `UPDATE bank_tx_pending
       SET state='pending', bank_account_id=0, approve_mode='', c_status='',
           decided_at=NULL, decided_by=''
       WHERE company_id=? AND tx_id=?`
    ).run(row.company_id, row.tx_id);
    return true;
  }

  const transaction = db
    .prepare(
      `SELECT id, type, amount, username, name, created_at
       FROM transactions WHERE company_id = ? AND id = ?`
    )
    .get(row.company_id, row.tx_id);
  if (!transaction || String(transaction.type || "").toUpperCase() !== txType) return false;
  db.prepare(
    `INSERT OR IGNORE INTO bank_tx_pending
      (company_id, tx_id, tx_type, amount, username, name, tx_time, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).run(
    row.company_id,
    transaction.id,
    txType,
    money(transaction.amount || row.amount_in || row.amount_out),
    transaction.username || row.username || "",
    cleanLedgerName(transaction.name || row.name),
    normalizeSqlDateTime(transaction.created_at) || row.entry_time || nowSql()
  );
  return true;
}

function makeTransferGroupId() {
  return `trf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function submitTransfer(db, fromCompanyId, body, actor) {
  const toCompanyId = String(body.to_company_id || "").trim();
  const submittedCStatus = String(body.c_status || "").trim();
  const direction = String(body.direction || "out").toLowerCase() === "in" ? "in" : "out";
  const status = assertTransferStatus(direction, String(body.status || (direction === "out" ? "bank trf" : "bank transfer")));
  const amountText = String(body.amount ?? "").replace(/,/g, "").trim();
  const amountNumber = Number(amountText);
  const amount = Number.isFinite(amountNumber) ? Math.abs(amountNumber) : 0;
  const remark = String(body.remark || "").trim();
  const name = String(body.name || "").trim();
  const entryTime = normalizeSqlDateTime(body.entry_time) || nowSql();
  const isTestStatus = status === "test in" || status === "test out";

  if (!amount) throw Object.assign(new Error("金额无效"), { status: 400 });

  const bankId = body.bank_account_id ? Number(body.bank_account_id) : 0;
  let bank = null;
  if (bankId) {
    bank = db
      .prepare(`SELECT * FROM bank_accounts WHERE id = ? AND company_id = ? AND ${SQL_OPERATING}`)
      .get(bankId, fromCompanyId);
    if (!bank) throw Object.assign(new Error("银行账户无效、已封禁或已归档"), { status: 400 });
  }
  if (isTestStatus && !bankId) {
    throw Object.assign(new Error("test in/out 请选择本司银行"), { status: 400 });
  }

  // Prefer the existing C STATUS association. The form does not need to repeat it.
  let targetCompany = toCompanyId || linkedCompanyForCStatus(db, fromCompanyId, submittedCStatus);
  if (targetCompany && targetCompany === fromCompanyId) {
    throw Object.assign(new Error("不能调给本公司"), { status: 400 });
  }
  const cStatus = submittedCStatus;
  if (cStatus) {
    upsertCStatusOptions(db, fromCompanyId, cStatus, targetCompany || null);
  }

  const groupId = makeTransferGroupId();
  const amounts = mapAmountFields(direction, status, amount);

  return runAtomic(db, () => {
    const ledger = insertLedger(db, {
      bank_account_id: bankId,
      company_id: fromCompanyId,
      entry_time: entryTime,
      ...amounts,
      bank_acc: bank ? bankAccLabel(bank) : "",
      name,
      c_status: cStatus,
      remark,
      auto_generated: 0,
      transfer_group_id: groupId,
    });

    appendAuditEvent(db, {
      companyId: fromCompanyId,
      action: "transfer.created",
      source: "user",
      actor: auditActorValue(actor),
      summary: `创建调钱流水 #${ledger.id}`,
      reason: String(body.reason || "").trim(),
      after: pickFields(ledger, LEDGER_FIELDS),
      metadata: { direction, target_company_id: targetCompany || "", counterparty_required: Boolean(targetCompany) },
      refs: ledgerRefs(ledger),
    });

    return {
      ledger,
      transfer_group_id: groupId,
      counterparty_required: Boolean(targetCompany),
    };
  });
}

function pendingCounts(db, companyId) {
  const tx = db
    .prepare("SELECT COUNT(*) AS n FROM bank_tx_pending WHERE company_id = ? AND state = 'pending'")
    .get(companyId).n;
  const dateKey = todayKey();
  expireSkippedPendingTx(db, companyId, dateKey);
  const skipped = db
    .prepare(
      `SELECT COUNT(*) AS n FROM bank_tx_pending
       WHERE company_id = ? AND state = 'skipped' AND substr(tx_time, 1, 10) = ?`
    )
    .get(companyId, dateKey).n;
  return {
    company_id: companyId,
    pending_tx: tx,
    skipped_tx: skipped,
    total: tx,
  };
}

module.exports = {
  ACCOUNT_KINDS,
  C_STATUS_DEFAULTS,
  IN_STATUSES,
  OUT_STATUSES,
  bankAccLabel,
  mapAmountFields,
  ensureCStatusOptions,
  listCStatusOptions,
  upsertCStatusOption,
  upsertCStatusOptions,
  logAccountEvent,
  insertLedger,
  enqueuePendingTx,
  listPendingTx,
  listSkippedPendingTx,
  approvePendingTx,
  skipPendingTx,
  restoreSkippedPendingTx,
  deleteSkippedPendingTx,
  submitTransfer,
  pendingCounts,
  platformTxTypeForLedger,
  reopenPendingForLedger,
  nowSql,
  normalizeSqlDateTime,
};
