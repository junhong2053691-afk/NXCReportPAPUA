const express = require("express");
const router = express.Router();
const { getDb } = require("../db/init");
const { computeBankDailyReport, balanceFromLedger, refreshBankBalance, bankBranchOf } = require("../lib/bankReport");
const {
  ACCOUNT_KINDS,
  listCStatusOptions,
  upsertCStatusOption,
  upsertCStatusOptions,
  logAccountEvent,
  enqueuePendingTx,
  listPendingTx,
  listSkippedPendingTx,
  approvePendingTx,
  skipPendingTx,
  restoreSkippedPendingTx,
  deleteSkippedPendingTx,
  submitTransfer,
  pendingCounts,
  bankAccLabel,
  nowSql,
  platformTxTypeForLedger,
  reopenPendingForLedger,
} = require("../lib/bankApply");
const {
  listStatusOptions,
  upsertStatusOption,
  deleteStatusOption,
} = require("../lib/bankStatusOptions");
const { listCompaniesForUser } = require("../lib/userAccess");
const { requireAdmin } = require("../middleware");
const {
  BANK_ACCOUNT_FIELDS,
  LEDGER_FIELDS,
  appendAuditEvent,
  actorFromRequest,
  diffFields,
  ledgerRefs,
  pickFields,
  requireReason,
} = require("../lib/auditLog");


function enrichBankRow(db, r, stats) {
  const s = stats || { tx_count: 0, total_in: 0, total_out: 0 };
  const bank_branch = bankBranchOf(r);
  return {
    ...r,
    bank_branch,
    bank: bank_branch,
    branch: "",
    balance: balanceFromLedger(db, r.id),
    reset_daily_balance: r.reset_daily_balance ? 1 : 0,
    tx_count: s.tx_count,
    total_in: s.total_in,
    total_out: s.total_out,
    account_kind: r.account_kind || "nominee",
    lifecycle_status: r.lifecycle_status || "active",
  };
}

const KNOWN_BANKS = [
  "ANZ", "Commonwealth Bank", "Westpac", "NAB", "Macquarie Bank",
  "St.George", "BankSA", "Bank of Queensland", "Bendigo Bank",
  "ING", "HSBC", "Suncorp", "AMP Bank", "MyState Bank",
  "Defence Bank", "Greater Bank", "P&N Bank", "Bank Australia",
  "Judo Bank", "Up Bank", "Revolut", "Heritage Bank",
  "Newcastle Permanent", "Teachers Mutual Bank", "UniBank",
  "Firefighters Mutual Bank", "Police Bank", "Delphi Bank",
  "ME Bank", "Rabobank", "Citibank", "RACQ Bank",
];

function companyId(req) {
  return req.companyId || (req.session && req.session.companyId) || "";
}

function actor(req) {
  return req.session?.user?.username || req.session?.user?.name || "";
}

function requestReason(req, res) {
  try {
    return requireReason(req.body);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
    return null;
  }
}

function normalizeKind(v) {
  const k = String(v || "nominee").trim().toLowerCase();
  return ACCOUNT_KINDS.includes(k) ? k : "nominee";
}

router.get("/", (req, res) => {
  const cid = companyId(req);
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM bank_accounts WHERE company_id = ? ORDER BY sort_order ASC, id ASC")
    .all(cid);
  const stats = db.prepare(`
    SELECT bank_account_id,
      COUNT(*) AS tx_count,
      COALESCE(SUM(amount_in), 0) AS total_in,
      COALESCE(SUM(amount_out), 0) AS total_out
    FROM bank_ledger WHERE company_id = ? GROUP BY bank_account_id
  `).all(cid);
  const statsMap = {};
  for (const s of stats) statsMap[s.bank_account_id] = s;
  const enriched = rows.map((r) => enrichBankRow(db, r, statsMap[r.id]));
  res.json({ rows: enriched });
});

router.get("/summary", (req, res) => {
  const cid = companyId(req);
  const db = getDb();
  const rows = db.prepare(`
    SELECT status,
      COUNT(*) AS cnt,
      COALESCE(SUM(amount_in), 0) AS total_in,
      COALESCE(SUM(amount_out), 0) AS total_out,
      COALESCE(SUM(help_amount), 0) AS total_help,
      COALESCE(SUM(trf_amount), 0) AS total_trf
    FROM bank_ledger WHERE company_id = ? GROUP BY status
  `).all(cid);
  res.json({ rows });
});

router.get("/suggestions", (req, res) => {
  const cid = companyId(req);
  const field = String(req.query.field || "bank_branch");
  const q = String(req.query.q || "").trim().toLowerCase();
  const db = getDb();

  if (field === "c_status") {
    const options = listCStatusOptions(db, cid).map((o) => o.name);
    const suggestions = q ? options.filter((s) => s.toLowerCase().includes(q)) : options;
    return res.json({ suggestions: suggestions.slice(0, 12) });
  }

  const dbRows = db
    .prepare("SELECT DISTINCT bank_branch, bank, branch FROM bank_accounts WHERE company_id = ? ORDER BY bank_branch, bank")
    .all(cid)
    .map((r) => bankBranchOf(r))
    .filter(Boolean);
  const all = [...new Set([...dbRows, ...KNOWN_BANKS])];
  const suggestions = q ? all.filter((s) => s.toLowerCase().startsWith(q)) : all.slice(0, 10);
  res.json({ suggestions: suggestions.slice(0, 12) });
});

router.get("/c-status-options", (req, res) => {
  const cid = companyId(req);
  const db = getDb();
  const options = listCStatusOptions(db, cid);
  const companies = listCompaniesForUser(db, req.session.user);
  res.json({ options, companies });
});

// 以下 STATUS / C STATUS 的写操作全部要求 admin。
// 对应页面 /bank-settings.html 本来就由 requireAdminPage 保护，但 API 之前
// 只挂了 requireLogin（server/index.js 的 /api/banks），operator 可以直接 curl，
// 篡改全公司的 STATUS 配置（影响对账与所有流水显示），也是 XSS 提权的入口。
router.post("/c-status-options", requireAdmin, (req, res) => {
  const cid = companyId(req);
  const name = String(req.body.name || "").trim();
  const target = req.body.target_company_id != null ? String(req.body.target_company_id).trim() : "";
  const reconcileRequired = req.body.reconcile_required == null ? null : Number(req.body.reconcile_required) ? 1 : 0;
  if (!name) return res.status(400).json({ error: "name required" });
  const row = upsertCStatusOption(getDb(), cid, name, target, reconcileRequired);
  res.json({ row });
});

router.delete("/c-status-options/:name", requireAdmin, (req, res) => {
  const cid = companyId(req);
  const name = decodeURIComponent(req.params.name || "").trim();
  getDb()
    .prepare("DELETE FROM bank_c_status_options WHERE company_id = ? AND name = ?")
    .run(cid, name);
  res.json({ ok: true });
});

router.get("/status-options", (req, res) => {
  const cid = companyId(req);
  res.json({ options: listStatusOptions(getDb(), cid) });
});

router.post("/status-options", requireAdmin, (req, res) => {
  const cid = companyId(req);
  try {
    res.json({ row: upsertStatusOption(getDb(), cid, req.body || {}) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.put("/status-options/:value", requireAdmin, (req, res) => {
  const cid = companyId(req);
  try {
    res.json({
      row: upsertStatusOption(getDb(), cid, {
        ...(req.body || {}),
        value: decodeURIComponent(req.params.value || ""),
      }),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.delete("/status-options/:value", requireAdmin, (req, res) => {
  const cid = companyId(req);
  deleteStatusOption(getDb(), cid, decodeURIComponent(req.params.value || ""));
  res.json({ ok: true });
});

router.get("/daily-report", (req, res) => {
  const cid = companyId(req);
  const db = getDb();
  try {
    res.json(computeBankDailyReport(db, cid, { date: req.query.date }));
  } catch (e) {
    console.error("[banks] daily-report:", e);
    res.status(500).json({ error: e.message });
  }
});

router.get("/pending-counts", (req, res) => {
  res.json(pendingCounts(getDb(), companyId(req)));
});

router.get("/pending-tx", (req, res) => {
  const cid = companyId(req);
  const rows = listPendingTx(getDb(), cid);
  res.json({ rows, count: rows.length });
});

router.get("/pending-tx/skipped", (req, res) => {
  const cid = companyId(req);
  const rows = listSkippedPendingTx(getDb(), cid, req.query.limit);
  res.json({ rows, count: rows.length });
});

router.post("/pending-tx/:txId/approve", (req, res) => {
  try {
    const result = approvePendingTx(getDb(), companyId(req), req.params.txId, req.body || {}, actorFromRequest(req));
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post("/pending-tx/:txId/skip", (req, res) => {
  try {
    const reason = requireReason(req.body);
    const row = skipPendingTx(getDb(), companyId(req), req.params.txId, actorFromRequest(req), reason);
    res.json({ row });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post("/pending-tx/:txId/restore", (req, res) => {
  try {
    const reason = requireReason(req.body);
    const row = restoreSkippedPendingTx(getDb(), companyId(req), req.params.txId, actorFromRequest(req), reason);
    res.json({ row });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.delete("/pending-tx/:txId/skipped", (req, res) => {
  try {
    const reason = requireReason(req.body);
    const row = deleteSkippedPendingTx(getDb(), companyId(req), req.params.txId, actorFromRequest(req), reason);
    res.json({ row });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Cross-company transfers are recorded independently by each company.
// A linked C STATUS only tells the operator which counterparty should record
// the matching row; no automatic mirror row is created.
router.post("/ledger/transfer", (req, res) => {
  try {
    const result = submitTransfer(getDb(), companyId(req), req.body || {}, actorFromRequest(req));
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post("/", (req, res) => {
  const cid = companyId(req);
  const {
    bank_branch: bankBranchBody = "",
    account_name = "", bsb = "", account_number = "", payid = "", note = "",
    account_kind = "nominee",
    reset_daily_balance = 0,
  } = req.body;
  const bank_branch = String(bankBranchBody || req.body.bank || "").trim();
  const name = String(account_name || "").trim();
  if (!bank_branch && !name && !account_number && !payid) {
    return res.status(400).json({ error: "请至少填写 BankBranch / NAME / 账号 / PAYID 之一" });
  }
  const db = getDb();
  const maxOrder = db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM bank_accounts WHERE company_id = ?")
    .get(cid).m;
  const kind = normalizeKind(account_kind);
  const row = runAtomic(db, () => {
    const result = db
      .prepare(
        `INSERT INTO bank_accounts
          (company_id, bank, branch, bank_branch, account_name, bsb, account_number, payid,
           balance, active, reset_daily_balance, account_kind, lifecycle_status, note, sort_order, updated_at)
         VALUES (?, ?, '', ?, ?, ?, ?, ?, 0, 1, ?, ?, 'active', ?, ?, datetime('now'))`
      )
      .run(
        cid, bank_branch, bank_branch, name, bsb.trim(), String(account_number).trim(),
        String(payid).trim(), reset_daily_balance ? 1 : 0, kind, String(note || "").trim(), maxOrder + 1
      );
    const saved = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(result.lastInsertRowid);
    logAccountEvent(db, {
      companyId: cid,
      bankAccountId: saved.id,
      event: "created",
      note: kind,
      user: actor(req),
    });
    appendAuditEvent(db, {
      companyId: cid,
      action: "bank_account.created",
      source: "user",
      actor: actorFromRequest(req),
      summary: `新增银行账户 #${saved.id}`,
      after: pickFields(saved, BANK_ACCOUNT_FIELDS),
      refs: [{ type: "bank_account", id: saved.id }],
    });
    return saved;
  });
  res.json({ row: enrichBankRow(db, row) });
});

router.put("/:id", (req, res) => {
  const cid = companyId(req);
  const id = Number(req.params.id);
  const db = getDb();
  const existing = db.prepare("SELECT * FROM bank_accounts WHERE id = ? AND company_id = ?").get(id, cid);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const allowed = [
    "bank_branch", "account_name", "bsb", "account_number", "payid", "balance",
    "active", "reset_daily_balance", "note", "sort_order", "account_kind", "lifecycle_status",
  ];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      let v = req.body[key];
      if (key === "account_kind") v = normalizeKind(v);
      if (key === "reset_daily_balance") v = v ? 1 : 0;
      sets.push(`${key} = ?`);
      vals.push(v);
    }
  }
  if (req.body.bank_branch !== undefined) {
    sets.push("bank = ?");
    vals.push(String(req.body.bank_branch).trim());
    sets.push("branch = ?");
    vals.push("");
  }

  // Ban / unban helpers
  if (req.body.ban === true) {
    sets.push("lifecycle_status = ?");
    vals.push("banned");
    sets.push("active = ?");
    vals.push(0);
  }
  if (req.body.unban === true) {
    sets.push("lifecycle_status = ?");
    vals.push("active");
  }

  if (!sets.length) return res.status(400).json({ error: "No fields to update" });
  sets.push("updated_at = datetime('now')");
  vals.push(id, cid);
  const row = runAtomic(db, () => {
    db.prepare(`UPDATE bank_accounts SET ${sets.join(", ")} WHERE id = ? AND company_id = ?`).run(...vals);
    const saved = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(id);
    let event = "updated";
    let action = "bank_account.updated";
    if (req.body.ban === true) {
      event = "banned";
      action = "bank_account.banned";
    } else if (req.body.unban === true) {
      event = "unbanned";
      action = "bank_account.unbanned";
    }
    logAccountEvent(db, {
      companyId: cid,
      bankAccountId: id,
      event,
      note: req.body.ban_note || "",
      user: actor(req),
    });
    const changes = diffFields(existing, saved, BANK_ACCOUNT_FIELDS.filter((field) => field !== "updated_at"));
    if (changes.changed.length || event !== "updated") {
      appendAuditEvent(db, {
        companyId: cid,
        action,
        source: "user",
        actor: actorFromRequest(req),
        summary: `${event === "updated" ? "更新" : event === "banned" ? "封禁" : "解封"}银行账户 #${id}`,
        reason: String(req.body.ban_note || "").trim(),
        before: changes.before,
        after: changes.after,
        metadata: { changed_fields: changes.changed },
        refs: [{ type: "bank_account", id }],
      });
    }
    return saved;
  });

  res.json({ row: enrichBankRow(db, row) });
});

const LEDGER_STATUSES_IN = [
  "deposit", "cash in", "new", "bank transfer", "unclaim", "redeposit", "amopay", "test in",
];
const LEDGER_STATUSES_OUT = [
  "withdraw", "wrong", "cash out", "give back", "expenses", "exchange", "bank trf", "test out",
];
const LEDGER_STATUSES = [...LEDGER_STATUSES_IN, ...LEDGER_STATUSES_OUT];

function normalizeLedgerStatus(status, amounts = {}) {
  const st = String(status || "").trim().toLowerCase();
  if (st) return st;
  if (Number(amounts.amount_in || 0) > 0) return "deposit";
  if (Number(amounts.amount_out || 0) > 0) return "withdraw";
  if (Number(amounts.trf_amount || 0) > 0) return "bank transfer";
  if (Number(amounts.help_amount || 0) > 0) return "bank trf";
  return "deposit";
}

function normalizeLedgerAmount(value) {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.abs(n) : null;
}

function readLedgerAmounts(body, keys) {
  const values = {};
  for (const key of keys) {
    if (body[key] === undefined) continue;
    const value = normalizeLedgerAmount(body[key]);
    if (value == null) return null;
    values[key] = value;
  }
  return values;
}

function runAtomic(db, fn) {
  if (typeof db.transaction === "function") return db.transaction(fn)();
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch (_) {}
    throw e;
  }
}

function archiveDeletedLedger(db, row, user) {
  const result = db.prepare(`
    INSERT INTO bank_ledger_deleted
      (original_id, bank_account_id, company_id, entry_time, tx_id, status,
       amount_in, amount_out, help_amount, trf_amount, bank_acc, username, name,
       c_status, other_info, remark, auto_generated, transfer_group_id,
       created_at, updated_at, deleted_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.bank_account_id,
    row.company_id,
    row.entry_time,
    row.tx_id,
    row.status,
    row.amount_in,
    row.amount_out,
    row.help_amount,
    row.trf_amount,
    row.bank_acc,
    row.username,
    row.name,
    row.c_status,
    row.other_info,
    row.remark,
    row.auto_generated,
    row.transfer_group_id || "",
    row.created_at || "",
    row.updated_at || "",
    user || ""
  );
  return result.lastInsertRowid;
}

router.get("/ledger", (req, res) => {
  const cid = companyId(req);
  const db = getDb();
  const bankId = req.query.bankId ? Number(req.query.bankId) : null;
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));
  const offset = Math.max(0, Number(req.query.offset || 0));
  const dateFrom = req.query.dateFrom || "";
  const dateTo = req.query.dateTo || "";

  let joinWhere = "l.company_id = ?";
  let countWhere = "company_id = ?";
  const params = [cid];
  if (bankId) {
    joinWhere += " AND l.bank_account_id = ?";
    countWhere += " AND bank_account_id = ?";
    params.push(bankId);
  }
  if (dateFrom) {
    joinWhere += " AND l.entry_time >= ?";
    countWhere += " AND entry_time >= ?";
    params.push(dateFrom + " 00:00:00");
  }
  if (dateTo) {
    joinWhere += " AND l.entry_time <= ?";
    countWhere += " AND entry_time <= ?";
    params.push(dateTo + " 23:59:59");
  }

  const rows = db
    .prepare(
      `SELECT l.*, b.bank_branch, b.bank, b.branch, b.account_name, b.account_number, b.bsb
       FROM bank_ledger l LEFT JOIN bank_accounts b ON l.bank_account_id = b.id
       WHERE ${joinWhere}
       ORDER BY l.entry_time ASC, l.id ASC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM bank_ledger WHERE ${countWhere}`).get(...params).n;
  res.json({ rows, total, statuses: listStatusOptions(db, cid).filter((s) => s.active).map((s) => s.value) });
});

router.get("/ledger/deleted", (req, res) => {
  const cid = companyId(req);
  const db = getDb();
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const rows = db.prepare(`
    SELECT d.*, b.bank_branch, b.bank, b.branch, b.account_name, b.account_number, b.bsb
    FROM bank_ledger_deleted d
    LEFT JOIN bank_accounts b ON d.bank_account_id = b.id
    WHERE d.company_id = ?
    ORDER BY d.deleted_at DESC, d.id DESC
    LIMIT ?
  `).all(cid, limit);
  res.json({ rows, total: rows.length });
});

router.post("/ledger", (req, res) => {
  const cid = companyId(req);
  const db = getDb();
  const {
    bank_account_id = 0, entry_time = "", tx_id = "", status = "deposit",
    amount_in = 0, amount_out = 0, help_amount = 0, trf_amount = 0,
    bank_acc = "", username = "", name = "", c_status = "",
    other_info = "", remark = "",
  } = req.body;
  const amounts = readLedgerAmounts({ amount_in, amount_out, help_amount, trf_amount }, ["amount_in", "amount_out", "help_amount", "trf_amount"]);
  if (!amounts) return res.status(400).json({ error: "金额必须是有效数字" });
  const ledgerStatus = normalizeLedgerStatus(status, amounts);
  const finalBankAccountId = ledgerStatus === "redeposit" ? 0 : Number(bank_account_id);
  const finalBankAcc = ledgerStatus === "redeposit" ? "" : String(bank_acc).trim();

  if (finalBankAccountId) {
    const ba = db
      .prepare("SELECT id FROM bank_accounts WHERE id = ? AND company_id = ? AND lifecycle_status != 'banned'")
      .get(finalBankAccountId, cid);
    if (!ba) return res.status(400).json({ error: "银行账户不属于当前公司" });
  }
  const row = runAtomic(db, () => {
    if (c_status) upsertCStatusOptions(db, cid, String(c_status).trim(), null);
    const result = db.prepare(`
      INSERT INTO bank_ledger
        (bank_account_id, company_id, entry_time, tx_id, status, amount_in, amount_out, help_amount, trf_amount, bank_acc, username, name, c_status, other_info, remark, auto_generated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      finalBankAccountId, cid,
      entry_time || nowSql(),
      String(tx_id).trim(), ledgerStatus, amounts.amount_in, amounts.amount_out,
      amounts.help_amount, amounts.trf_amount,
      finalBankAcc, String(username).trim(), String(name).trim(),
      String(c_status).trim(), String(other_info).trim(), String(remark).trim()
    );
    const saved = db.prepare("SELECT * FROM bank_ledger WHERE id = ?").get(result.lastInsertRowid);
    if (finalBankAccountId) refreshBankBalance(db, finalBankAccountId);
    appendAuditEvent(db, {
      companyId: cid,
      action: "ledger.created",
      source: "user",
      actor: actorFromRequest(req),
      summary: `新增账单流水 #${saved.id}`,
      after: pickFields(saved, LEDGER_FIELDS),
      refs: ledgerRefs(saved),
    });
    return saved;
  });
  res.json({ row });
});

router.put("/ledger/:id", (req, res) => {
  const cid = companyId(req);
  const id = Number(req.params.id);
  const db = getDb();
  const existing = db.prepare("SELECT * FROM bank_ledger WHERE id = ? AND company_id = ?").get(id, cid);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const amountKeys = ["amount_in", "amount_out", "help_amount", "trf_amount"];
  const parsedAmounts = readLedgerAmounts(req.body, amountKeys);
  if (!parsedAmounts) return res.status(400).json({ error: "金额必须是有效数字" });
  Object.assign(req.body, parsedAmounts);
  const nextStatus = req.body.status !== undefined
    ? normalizeLedgerStatus(req.body.status, {
        amount_in: req.body.amount_in ?? existing.amount_in,
        amount_out: req.body.amount_out ?? existing.amount_out,
        help_amount: req.body.help_amount ?? existing.help_amount,
        trf_amount: req.body.trf_amount ?? existing.trf_amount,
      })
    : String(existing.status || "");
  if (nextStatus === "redeposit") {
    req.body.status = "redeposit";
    req.body.bank_account_id = 0;
    req.body.bank_acc = "";
  } else if (req.body.bank_account_id) {
    const ba = db
      .prepare("SELECT id FROM bank_accounts WHERE id = ? AND company_id = ? AND lifecycle_status != 'banned'")
      .get(Number(req.body.bank_account_id), cid);
    if (!ba) return res.status(400).json({ error: "é“¶è¡Œè´¦æˆ·ä¸å±žäºŽå½“å‰å…¬å¸" });
  }

  const allowed = [
    "entry_time", "tx_id", "status", "amount_in", "amount_out", "help_amount", "trf_amount",
    "bank_acc", "username", "name", "c_status", "other_info", "remark", "bank_account_id",
  ];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      sets.push(`${key} = ?`);
      if (key === "status") {
        vals.push(normalizeLedgerStatus(req.body.status, {
          amount_in: req.body.amount_in ?? existing.amount_in,
          amount_out: req.body.amount_out ?? existing.amount_out,
          help_amount: req.body.help_amount ?? existing.help_amount,
          trf_amount: req.body.trf_amount ?? existing.trf_amount,
        }));
      } else {
        vals.push(req.body[key]);
      }
    }
  }
  if (!sets.length) return res.status(400).json({ error: "No fields" });
  sets.push("updated_at = datetime('now')");
  vals.push(id, cid);
  const row = runAtomic(db, () => {
    if (req.body.c_status) upsertCStatusOptions(db, cid, String(req.body.c_status).trim(), null);
    db.prepare(`UPDATE bank_ledger SET ${sets.join(", ")} WHERE id = ? AND company_id = ?`).run(...vals);
    const saved = db.prepare("SELECT * FROM bank_ledger WHERE id = ?").get(id);
    refreshBankBalance(db, existing.bank_account_id);
    if (saved.bank_account_id && saved.bank_account_id !== existing.bank_account_id) {
      refreshBankBalance(db, saved.bank_account_id);
    }
    const changes = diffFields(existing, saved, LEDGER_FIELDS.filter((field) => field !== "updated_at"));
    if (changes.changed.length) {
      appendAuditEvent(db, {
        companyId: cid,
        action: "ledger.updated",
        source: "user",
        actor: actorFromRequest(req),
        summary: `修改账单流水 #${id}`, 
        before: changes.before,
        after: changes.after,
        metadata: { changed_fields: changes.changed },
        refs: ledgerRefs(saved),
      });
    }
    return saved;
  });
  res.json({ row });
});

router.post("/ledger/deleted/:deletedId/restore", (req, res) => {
  const cid = companyId(req);
  const reason = requestReason(req, res);
  if (reason == null) return;
  const deletedId = Number(req.params.deletedId);
  const db = getDb();
  const deleted = db.prepare("SELECT * FROM bank_ledger_deleted WHERE id = ? AND company_id = ?").get(deletedId, cid);
  if (!deleted) return res.status(404).json({ error: "Deleted ledger not found" });

  let restoredId = 0;
  let restoredPlatformOrder = false;
  runAtomic(db, () => {
    const exists = db.prepare("SELECT 1 FROM bank_ledger WHERE id = ?").get(deleted.original_id);
    const columns = exists
      ? `(bank_account_id, company_id, entry_time, tx_id, status, amount_in, amount_out,
          help_amount, trf_amount, bank_acc, username, name, c_status, other_info, remark,
          auto_generated, transfer_group_id, created_at, updated_at)`
      : `(id, bank_account_id, company_id, entry_time, tx_id, status, amount_in, amount_out,
          help_amount, trf_amount, bank_acc, username, name, c_status, other_info, remark,
          auto_generated, transfer_group_id, created_at, updated_at)`;
    const values = exists
      ? `?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`
      : `?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`;
    const params = exists
      ? [
          deleted.bank_account_id, deleted.company_id, deleted.entry_time, deleted.tx_id, deleted.status,
          deleted.amount_in, deleted.amount_out, deleted.help_amount, deleted.trf_amount,
          deleted.bank_acc, deleted.username, deleted.name, deleted.c_status, deleted.other_info,
          deleted.remark, deleted.auto_generated, deleted.transfer_group_id || "",
          deleted.created_at || "", deleted.updated_at || "",
        ]
      : [
          deleted.original_id, deleted.bank_account_id, deleted.company_id, deleted.entry_time, deleted.tx_id,
          deleted.status, deleted.amount_in, deleted.amount_out, deleted.help_amount, deleted.trf_amount,
          deleted.bank_acc, deleted.username, deleted.name, deleted.c_status, deleted.other_info,
          deleted.remark, deleted.auto_generated, deleted.transfer_group_id || "",
          deleted.created_at || "", deleted.updated_at || "",
        ];
    const result = db.prepare(`INSERT INTO bank_ledger ${columns} VALUES (${values})`).run(...params);
    restoredId = exists ? result.lastInsertRowid : deleted.original_id;
    db.prepare("DELETE FROM bank_ledger_deleted WHERE id = ? AND company_id = ?").run(deletedId, cid);

    const txType = platformTxTypeForLedger(db, deleted);
    const hasDeletedSibling = deleted.transfer_group_id
      ? db
          .prepare(
            `SELECT 1 FROM bank_ledger_deleted
             WHERE company_id = ? AND transfer_group_id = ? LIMIT 1`
          )
          .get(cid, deleted.transfer_group_id)
      : null;
    if (txType && !hasDeletedSibling && reopenPendingForLedger(db, deleted)) {
      const bank = deleted.transfer_group_id
        ? db
            .prepare(
              `SELECT bank_account_id FROM bank_ledger
               WHERE company_id = ? AND transfer_group_id = ? AND bank_account_id > 0
               ORDER BY id ASC LIMIT 1`
            )
            .get(cid, deleted.transfer_group_id)
        : null;
      const bankId = Number(bank?.bank_account_id || deleted.bank_account_id || 0);
      const pending = db
        .prepare("SELECT amount FROM bank_tx_pending WHERE company_id = ? AND tx_id = ?")
        .get(cid, deleted.tx_id);
      db.prepare(
        `UPDATE bank_tx_pending
         SET state='approved', bank_account_id=?, approve_mode='restored', c_status=?,
             approved_entry_time=?, approved_at=datetime('now'), approved_by=?,
             decided_at=datetime('now'), decided_by=?
         WHERE company_id=? AND tx_id=?`
      ).run(
        bankId,
        deleted.c_status || "",
        deleted.entry_time || "",
        actor(req),
        actor(req),
        cid,
        deleted.tx_id
      );
      db.prepare(
        `INSERT OR REPLACE INTO bank_balance_log (bank_account_id, tx_id, amount)
         VALUES (?, ?, ?)`
      ).run(bankId, deleted.tx_id, Number(pending?.amount || deleted.amount_in || deleted.amount_out || 0));
      restoredPlatformOrder = true;
    }
    const restored = db.prepare("SELECT * FROM bank_ledger WHERE id = ?").get(restoredId);
    refreshBankBalance(db, deleted.bank_account_id);
    appendAuditEvent(db, {
      companyId: cid,
      action: "ledger.restored",
      source: "user",
      actor: actorFromRequest(req),
      summary: `恢复账单流水 #${restoredId}`,
      reason,
      before: pickFields({ ...deleted, id: deleted.original_id }, LEDGER_FIELDS),
      after: pickFields(restored, LEDGER_FIELDS),
      metadata: {
        deleted_archive_id: deletedId,
        restored_platform_order: restoredPlatformOrder,
      },
      refs: ledgerRefs(restored),
    });
  });

  const row = db.prepare("SELECT * FROM bank_ledger WHERE id = ?").get(restoredId);
  res.json({ ok: true, row, restored_platform_order: restoredPlatformOrder });
});

router.delete("/ledger/:id", (req, res) => {
  const cid = companyId(req);
  const reason = requestReason(req, res);
  if (reason == null) return;
  const id = Number(req.params.id);
  const db = getDb();
  const existing = db.prepare("SELECT * FROM bank_ledger WHERE id = ? AND company_id = ?").get(id, cid);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const rowsToDelete = existing.auto_generated && existing.transfer_group_id
    ? db
        .prepare(
          `SELECT * FROM bank_ledger
           WHERE company_id = ? AND transfer_group_id = ? AND auto_generated = 1
           ORDER BY id ASC`
        )
        .all(cid, existing.transfer_group_id)
    : [existing];
  const result = runAtomic(db, () => {
    const archivedIds = rowsToDelete.map((row) => archiveDeletedLedger(db, row, actor(req)));
    const deleteStmt = db.prepare("DELETE FROM bank_ledger WHERE id = ? AND company_id = ?");
    rowsToDelete.forEach((row) => deleteStmt.run(row.id, cid));
    const reopened = reopenPendingForLedger(db, existing);
    for (const row of rowsToDelete) refreshBankBalance(db, row.bank_account_id);
    appendAuditEvent(db, {
      companyId: cid,
      action: "ledger.deleted",
      source: "user",
      actor: actorFromRequest(req),
      summary: rowsToDelete.length > 1
        ? `删除拆分流水组 ${existing.transfer_group_id}（${rowsToDelete.length} 条）`
        : `删除账单流水 #${existing.id}`,
      reason,
      before: rowsToDelete.map((row) => pickFields(row, LEDGER_FIELDS)),
      after: null,
      metadata: { archived_ids: archivedIds, reopened_pending: reopened },
      refs: rowsToDelete.flatMap((row) => ledgerRefs(row)),
    });
    return { archivedIds, reopened };
  });
  res.json({ ok: true, deletedId: result.archivedIds[0], deletedIds: result.archivedIds, reopened: result.reopened });
});

router.get("/:id/recent-transactions", (req, res) => {
  const cid = companyId(req);
  const id = Number(req.params.id);
  const db = getDb();
  const existing = db.prepare("SELECT id FROM bank_accounts WHERE id = ? AND company_id = ?").get(id, cid);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const recentIn = db.prepare(`
    SELECT entry_time, tx_id, status, amount_in, trf_amount, username, name, c_status, remark
    FROM bank_ledger WHERE bank_account_id = ? AND (amount_in > 0 OR trf_amount > 0)
    ORDER BY entry_time DESC, id DESC LIMIT 10
  `).all(id);
  const recentOut = db.prepare(`
    SELECT entry_time, tx_id, status, amount_out, help_amount, username, name, c_status, remark
    FROM bank_ledger WHERE bank_account_id = ? AND (amount_out > 0 OR help_amount > 0)
    ORDER BY entry_time DESC, id DESC LIMIT 10
  `).all(id);
  res.json({ recentIn, recentOut });
});

router.get("/:id/events", (req, res) => {
  const cid = companyId(req);
  const id = Number(req.params.id);
  const db = getDb();
  const existing = db.prepare("SELECT id FROM bank_accounts WHERE id = ? AND company_id = ?").get(id, cid);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const rows = db
    .prepare(
      "SELECT * FROM bank_account_events WHERE company_id = ? AND bank_account_id = ? ORDER BY created_at DESC, id DESC"
    )
    .all(cid, id);
  res.json({ rows });
});

router.delete("/:id", (req, res) => {
  const cid = companyId(req);
  const reason = requestReason(req, res);
  if (reason == null) return;
  const id = Number(req.params.id);
  const db = getDb();
  const existing = db.prepare("SELECT * FROM bank_accounts WHERE id = ? AND company_id = ?").get(id, cid);
  if (!existing) return res.status(404).json({ error: "Not found" });
  runAtomic(db, () => {
    db.prepare("DELETE FROM bank_accounts WHERE id = ? AND company_id = ?").run(id, cid);
    appendAuditEvent(db, {
      companyId: cid,
      action: "bank_account.deleted",
      source: "user",
      actor: actorFromRequest(req),
      summary: `删除银行账户 #${id}`,
      reason,
      before: pickFields(existing, BANK_ACCOUNT_FIELDS),
      after: null,
      refs: [{ type: "bank_account", id }],
    });
  });
  res.json({ ok: true });
});

module.exports = router;
module.exports.enqueuePendingTx = enqueuePendingTx;
module.exports.bankAccLabel = bankAccLabel;
