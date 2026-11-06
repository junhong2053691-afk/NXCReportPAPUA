const express = require("express");
const router = express.Router();
const { getDb } = require("../db/init");
const { computeBankDailyReport, balanceFromLedger, refreshBankBalance, bankBranchOf } = require("../lib/bankReport");
const { evaluateBalanceAlert, clearFired } = require("../lib/bankAlerts");
const {
  LIFECYCLE,
  SQL_OPERATING,
  isArchived,
  statusOf,
  archiveBlockReason,
} = require("../lib/bankLifecycle");
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
  drainBannedAccount,
  assertNotSelfCStatus,
  pendingCounts,
  bankAccLabel,
  nowSql,
  normalizeSqlDateTime,
  platformTxTypeForLedger,
  reopenPendingForLedger,
  restoreConflictForDeleted,
} = require("../lib/bankApply");
const {
  isValidStatusValue,
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

// 只认 resolveCompany 算出来的值。不能回退到 session：撤销授权后 session 里还留着旧公司，
// 回退等于让被撤销的 operator 继续读写。挂载处的 requireCompany 保证这里非空。
function companyId(req) {
  return req.companyId || "";
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

// 生命周期状态机：active ──封禁──> banned ──归档(闸门)──> archived
//                        <──解封──        <──取消归档──
//
// 两条刻意的设计：
//  1. **不允许 active 直接归档**（archive 要求当前是 banned）。这样每个归档背后都有一条
//     带原因的 banned 事件，而且「封禁中」页签成为通往归档的唯一入口——待清理队列没法
//     被绕过。
//  2. **unarchive 回落到 banned 而不是 active**。取消归档只是把账户捞回可见的待清理
//     队列，要回到运营还得再显式解封一次。这与「解封不自动恢复 active 列」是同一种
//     谨慎：让钱重新流动永远需要一次明确的人为动作。
const LIFECYCLE_OPS = {
  ban: {
    status: LIFECYCLE.BANNED,
    active: 0,
    event: "banned",
    action: "bank_account.banned",
    label: "封禁",
  },
  unban: {
    status: LIFECYCLE.ACTIVE,
    event: "unbanned",
    action: "bank_account.unbanned",
    label: "解封",
  },
  archive: {
    status: LIFECYCLE.ARCHIVED,
    active: 0,
    event: "archived",
    action: "bank_account.archived",
    label: "归档",
    adminOnly: true,
    gate: archiveBlockReason,
  },
  unarchive: {
    status: LIFECYCLE.BANNED,
    event: "unarchived",
    action: "bank_account.unarchived",
    label: "取消归档",
    adminOnly: true,
    requiresStatus: LIFECYCLE.ARCHIVED,
    wrongStateError: "该渠道不在已归档状态",
  },
};

// 余额上限报警阈值。留空 / null 视为 0 = 不启用；非法值返回 null 让调用方报 400。
function normalizeAlertThreshold(value) {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
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
  // 未传字段 = 不改（upsertCStatusOption 用 null 表示「保持原值」）。写成 "" 会让
  // 只改 reconcile_required 的请求顺手把关联公司清空，那条 C STATUS 就脱离对平了。
  const target = req.body.target_company_id != null ? String(req.body.target_company_id).trim() : null;
  const reconcileRequired = req.body.reconcile_required == null ? null : Number(req.body.reconcile_required) ? 1 : 0;
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const row = upsertCStatusOption(getDb(), cid, name, target, reconcileRequired);
    res.json({ row });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
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

// 封禁户「转出余额」：不解封，直接把钱转到本公司运营中的户口，或转给别家（C STATUS）。
router.post("/:id/drain", (req, res) => {
  try {
    const result = drainBannedAccount(getDb(), companyId(req), Number(req.params.id), req.body || {}, actorFromRequest(req));
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
    alert_threshold = 0,
  } = req.body;
  const bank_branch = String(bankBranchBody || req.body.bank || "").trim();
  const name = String(account_name || "").trim();
  if (!bank_branch && !name && !account_number && !payid) {
    return res.status(400).json({ error: "请至少填写 BankBranch / NAME / 账号 / PAYID 之一" });
  }
  const alertThreshold = normalizeAlertThreshold(alert_threshold);
  if (alertThreshold == null) {
    return res.status(400).json({ error: "余额上限报警必须是不小于 0 的数字" });
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
           balance, active, reset_daily_balance, account_kind, lifecycle_status, note, sort_order,
           alert_threshold, updated_at)
         VALUES (?, ?, '', ?, ?, ?, ?, ?, 0, 1, ?, ?, 'active', ?, ?, ?, datetime('now'))`
      )
      .run(
        cid, bank_branch, bank_branch, name, bsb.trim(), String(account_number).trim(),
        String(payid).trim(), reset_daily_balance ? 1 : 0, kind, String(note || "").trim(), maxOrder + 1,
        alertThreshold
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

  // alert_fired_at / alert_fired_date 是系统状态，绝不能进白名单——否则可以直接伪造
  // 「已报警」把某个账户永久静音。
  //
  // lifecycle_status 同理不在白名单里：它只能经下面的 ban / unban / archive / unarchive
  // 四个分支改动。放进白名单的话，一条 PUT {"lifecycle_status":"archived"} 就能绕过
  // 归档闸门（把还有余额的账户藏起来）、绕过 active = 0 的不变量（sync.js 的自动入账
  // 只看 active，于是「假封禁」的账户照样收钱）、也不会留下 bank_account_events。
  const allowed = [
    "bank_branch", "account_name", "bsb", "account_number", "payid", "balance",
    "active", "reset_daily_balance", "note", "sort_order", "account_kind",
    "alert_threshold",
  ];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      let v = req.body[key];
      if (key === "account_kind") v = normalizeKind(v);
      if (key === "reset_daily_balance") v = v ? 1 : 0;
      if (key === "alert_threshold") {
        v = normalizeAlertThreshold(v);
        if (v == null) return res.status(400).json({ error: "余额上限报警必须是不小于 0 的数字" });
      }
      sets.push(`${key} = ?`);
      vals.push(v);
    }
  }
  // 阈值变了就清空已报警标记，并在同一事务里重新判定：管理员刚说「到 X 就告诉我」，
  // 而余额已经到了，沉默到下一笔流水才报是错的。
  const thresholdChanged =
    req.body.alert_threshold !== undefined &&
    Math.round(Number(existing.alert_threshold || 0) * 100) !==
      Math.round(normalizeAlertThreshold(req.body.alert_threshold) * 100);
  // 复位本身交给 bankAlerts.clearFired（见下面的 runAtomic）：要清哪几列只有那一份，
  // 在这里再抄一遍 sets.push 早晚会漏掉新加的列——alert_fired_balance 就是这么来的。
  if (req.body.bank_branch !== undefined) {
    sets.push("bank = ?");
    vals.push(String(req.body.bank_branch).trim());
    sets.push("branch = ?");
    vals.push("");
  }

  // 生命周期变更。四个分支各自声明写什么状态、记什么事件、审计里叫什么，避免像
  // 以前那样把 status / active / event / action / summary 摊在五处三元表达式里。
  const lifecycleOp = LIFECYCLE_OPS[
    ["ban", "unban", "archive", "unarchive"].find((k) => req.body[k] === true) || ""
  ];
  const opCount = ["ban", "unban", "archive", "unarchive"].filter((k) => req.body[k] === true).length;
  if (opCount > 1) {
    return res.status(400).json({ error: "状态操作互斥，一次只能执行一个" });
  }
  if (lifecycleOp) {
    // 归档让账户从所有视图里消失，性质接近 status-options 那类全公司配置的写操作，
    // 所以要 admin。封禁 / 解封仍然允许 operator 做（那是日常运营动作）。
    if (lifecycleOp.adminOnly && req.session?.user?.role !== "admin") {
      return res.status(403).json({ error: "需要管理员权限" });
    }
    // 闸门必须在 runAtomic 之前：这个 handler 没有 try/catch，在事务里抛会变成未捕获
    // 的 500。better-sqlite3 是同步单线程，「先读后写」之间不会有别的请求插进来。
    if (lifecycleOp.gate) {
      const blocked = lifecycleOp.gate(db, existing);
      if (blocked) return res.status(409).json({ error: blocked });
    }
    if (lifecycleOp.requiresStatus && statusOf(existing) !== lifecycleOp.requiresStatus) {
      return res.status(400).json({ error: lifecycleOp.wrongStateError });
    }
    sets.push("lifecycle_status = ?");
    vals.push(lifecycleOp.status);
    // 不变量：banned | archived ⇒ active = 0。sync.js 的自动入账只看 active，靠这条
    // 保证封禁 / 归档的账户拿不到新充值。
    if (lifecycleOp.active != null) {
      sets.push("active = ?");
      vals.push(lifecycleOp.active);
    }
  }

  if (!sets.length) return res.status(400).json({ error: "No fields to update" });
  sets.push("updated_at = datetime('now')");
  vals.push(id, cid);
  const row = runAtomic(db, () => {
    db.prepare(`UPDATE bank_accounts SET ${sets.join(", ")} WHERE id = ? AND company_id = ?`).run(...vals);
    if (thresholdChanged) {
      clearFired(db, existing);
      evaluateBalanceAlert(db, id);
    }
    const saved = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(id);
    const event = lifecycleOp ? lifecycleOp.event : "updated";
    const action = lifecycleOp ? lifecycleOp.action : "bank_account.updated";
    const note = String(req.body.ban_note || req.body.archive_note || "").trim();
    logAccountEvent(db, {
      companyId: cid,
      bankAccountId: id,
      event,
      note,
      user: actor(req),
    });
    const changes = diffFields(existing, saved, BANK_ACCOUNT_FIELDS.filter((field) => field !== "updated_at"));
    if (changes.changed.length || event !== "updated") {
      appendAuditEvent(db, {
        companyId: cid,
        action,
        source: "user",
        actor: actorFromRequest(req),
        summary: `${lifecycleOp ? lifecycleOp.label : "更新"}银行账户 #${id}`,
        reason: note,
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
  if (!isValidStatusValue(ledgerStatus)) return res.status(400).json({ error: "STATUS 格式无效" });
  const finalBankAccountId = ledgerStatus === "redeposit" ? 0 : Number(bank_account_id);
  const finalBankAcc = ledgerStatus === "redeposit" ? "" : String(bank_acc).trim();

  if (finalBankAccountId) {
    const ba = db
      .prepare(`SELECT id FROM bank_accounts WHERE id = ? AND company_id = ? AND ${SQL_OPERATING}`)
      .get(finalBankAccountId, cid);
    if (!ba) return res.status(400).json({ error: "银行账户不属于当前公司，或已封禁 / 已归档" });
  }

  // entry_time 必须规范化成实例时区的墙上时间。所有日界都是在这一列上做字符串前缀
  // 比较，放任客户端写进带 Z 或带偏移的串会同时打穿日报、余额、流水筛选和待审批
  // 计数，而且没有任何报错。调钱路径（bankApply.submitTransfer）本来就这么做，这里
  // 是补缺口不是立新规。给了但无效一律 400 拒绝，不静默强转——照 bankApply 的
  // pendingLedgerEntryTime 已立下的先例。
  const normalizedEntryTime = normalizeSqlDateTime(entry_time);
  if (String(entry_time || "").trim() && !normalizedEntryTime) {
    return res.status(400).json({ error: "入账日期或时间无效" });
  }
  try {
    assertNotSelfCStatus(db, cid, c_status);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  const row = runAtomic(db, () => {
    if (c_status) upsertCStatusOptions(db, cid, String(c_status).trim(), null);
    const result = db.prepare(`
      INSERT INTO bank_ledger
        (bank_account_id, company_id, entry_time, tx_id, status, amount_in, amount_out, help_amount, trf_amount, bank_acc, username, name, c_status, other_info, remark, auto_generated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      finalBankAccountId, cid,
      normalizedEntryTime || nowSql(),
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
  // 只在 C STATUS 被改动时校验：库里已有的自指旧行照样能改 OTHER / REMARK。
  if (req.body.c_status !== undefined
    && String(req.body.c_status || "").trim() !== String(existing.c_status || "").trim()) {
    try {
      assertNotSelfCStatus(db, cid, req.body.c_status);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
  }
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
  if (req.body.status !== undefined && !isValidStatusValue(nextStatus)) {
    return res.status(400).json({ error: "STATUS 格式无效" });
  }
  if (nextStatus === "redeposit") {
    req.body.status = "redeposit";
    req.body.bank_account_id = 0;
    req.body.bank_acc = "";
  } else if (req.body.bank_account_id) {
    const ba = db
      .prepare(`SELECT id FROM bank_accounts WHERE id = ? AND company_id = ? AND ${SQL_OPERATING}`)
      .get(Number(req.body.bank_account_id), cid);
    if (!ba) return res.status(400).json({ error: "银行账户不属于当前公司，或已封禁 / 已归档" });
  } else if (req.body.bank_account_id === undefined && existing.bank_account_id) {
    // 前端在「BANK ACC 没动」时不发 bank_account_id（原样保留绑定，封禁户的历史行也能改 OTHER /
    // REMARK）。但归档户的金额不能动：那会让余额在所有视图之外复活，归档闸门挡的正是这个。
    const current = db
      .prepare("SELECT * FROM bank_accounts WHERE id = ? AND company_id = ?")
      .get(existing.bank_account_id, cid);
    const amountChanged = amountKeys.some(
      // OUT 列历史上正负号都存过，按绝对值比，免得只改 OTHER 也被判成改了金额
      (k) => req.body[k] !== undefined
        && Math.round(Math.abs(Number(req.body[k] || 0)) * 100) !== Math.round(Math.abs(Number(existing[k] || 0)) * 100)
    );
    if (current && isArchived(current) && amountChanged) {
      return res.status(409).json({ error: "该渠道已归档，不能修改这行的金额；请先取消归档" });
    }
  }

  // 同 POST /ledger：entry_time 必须是实例时区的墙上时间格式，给了但无效一律 400
  // 拒绝而不是静默强转。显式传空串也算无效——这一列 NOT NULL，清空它没有意义。
  let normalizedEntryTime = "";
  if (req.body.entry_time !== undefined) {
    normalizedEntryTime = normalizeSqlDateTime(req.body.entry_time);
    if (!normalizedEntryTime) return res.status(400).json({ error: "入账日期或时间无效" });
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
      if (key === "entry_time") {
        vals.push(normalizedEntryTime);
      } else if (key === "status") {
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

  // 恢复流水会刷新目标账户余额。对已归档的账户做这件事，会让它在所有视图之外悄悄带上
  // 余额——归档闸门（bankLifecycle.archiveBlockReason）挡住的正是这条路，这里是另一半。
  if (deleted.bank_account_id) {
    const target = db
      .prepare("SELECT * FROM bank_accounts WHERE id = ? AND company_id = ?")
      .get(deleted.bank_account_id, cid);
    if (target && isArchived(target)) {
      return res.status(409).json({ error: "该渠道已归档，请先取消归档再恢复流水" });
    }
  }

  // 误审 → 删除 → 重审之后，旧行还躺在回收站里。不拦的话恢复它就是同一平台单记两次。
  // 闸门在 runAtomic 之前，理由同上面的归档闸门（better-sqlite3 同步执行，读写之间插不进别的请求）。
  const conflict = restoreConflictForDeleted(db, deleted);
  if (conflict) {
    return res.status(409).json({
      error: `平台单 ${deleted.tx_id} 已重新入账（流水 #${conflict.id}），恢复会重复入账`,
      conflict_ledger_id: conflict.id,
    });
  }

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
    const reopenOpts = { excludeLedgerId: restoredId, excludeGroupId: deleted.transfer_group_id };
    if (txType && !hasDeletedSibling && reopenPendingForLedger(db, deleted, reopenOpts)) {
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

// 物理删除账户。前端不提供入口——UI 上的退役路径是 封禁 → 归档，历史流水全部留着。
// 这个路由只是 admin 的逃生口（删掉建错了、一笔流水都没走过的账户）。
//
// 为什么必须挡住「有流水的账户」：bank_ledger 等几张表**没有外键约束**，删掉账户之后
// 那些流水行就成了孤儿——computeBankDailyReport 的 bankMap.get() 会漏掉它们的明细，
// 但 totals.total_in / total_out 仍然把它们加进去，于是明细与总额永久对不上；而
// balanceFromLedger(那个已消失的 id) 还能把钱算出来，只是再没有任何视图会显示。
router.delete("/:id", requireAdmin, (req, res) => {
  const cid = companyId(req);
  const reason = requestReason(req, res);
  if (reason == null) return;
  const id = Number(req.params.id);
  const db = getDb();
  const existing = db.prepare("SELECT * FROM bank_accounts WHERE id = ? AND company_id = ?").get(id, cid);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const used =
    Number(
      db.prepare("SELECT COUNT(*) AS n FROM bank_ledger WHERE company_id = ? AND bank_account_id = ?")
        .get(cid, id)?.n || 0
    ) +
    Number(
      db.prepare("SELECT COUNT(*) AS n FROM bank_ledger_deleted WHERE company_id = ? AND bank_account_id = ?")
        .get(cid, id)?.n || 0
    ) +
    // bank_balance_log 没有 company_id 这一列（schema.sql:129-136），只能按账户 id 查。
    Number(
      db.prepare("SELECT COUNT(*) AS n FROM bank_balance_log WHERE bank_account_id = ?").get(id)?.n || 0
    );
  if (used > 0) {
    return res.status(409).json({
      error: `该渠道已有 ${used} 条流水记录，不能删除；请改用封禁 → 归档`,
    });
  }

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
