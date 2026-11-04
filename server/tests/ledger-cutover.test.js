const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bankDatabase,
  addCompany,
  addAccount,
  addLedger,
  addDeletedLedger,
  addSentMessage,
  accountRow,
  outbox,
} = require("./bank-fixture");
const { planLedgerReset, applyLedgerReset } = require("../lib/ledgerCutover");
const { enqueuePendingTx } = require("../lib/bankApply");
const { refreshAllBankBalances } = require("../lib/bankReport");
const { systemActor } = require("../lib/auditLog");

function cutoverDb() {
  const db = bankDatabase();
  db.exec(`
    CREATE TABLE bank_tx_pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL DEFAULT '',
      tx_id TEXT NOT NULL DEFAULT '',
      tx_type TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL DEFAULT 0,
      username TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      tx_time TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'pending',
      bank_account_id INTEGER NOT NULL DEFAULT 0,
      approve_mode TEXT NOT NULL DEFAULT '',
      c_status TEXT NOT NULL DEFAULT '',
      approved_entry_time TEXT NOT NULL DEFAULT '',
      approved_at TEXT,
      approved_by TEXT NOT NULL DEFAULT '',
      decided_at TEXT,
      decided_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_id, tx_id)
    );
    CREATE TABLE bank_balance_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_account_id INTEGER NOT NULL,
      tx_id TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tx_id)
    );
  `);
  return db;
}

function addPending(db, txId, state, extra = {}) {
  db.prepare(
    "INSERT INTO bank_tx_pending (company_id, tx_id, tx_type, amount, tx_time, state, approved_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(extra.company_id || "alpha", txId, extra.tx_type || "DEPOSIT", extra.amount || 100, "2026-11-03 10:00:00", state, extra.approved_by || "");
}

function seed() {
  const db = cutoverDb();
  addCompany(db, { id: "alpha" });
  addCompany(db, { id: "beta", name: "Beta" });
  const a1 = addAccount(db, { company_id: "alpha", alert_threshold: 200 });
  const b1 = addAccount(db, { company_id: "beta", bank_branch: "NAB Perth" });
  addLedger(db, a1, 500, "2026-11-03", { tx_id: "T-approved" });
  addLedger(db, b1, 80, "2026-11-02");
  addDeletedLedger(db, a1, 40, "2026-11-01");
  refreshAllBankBalances(db);
  // a1 已报过警，且聊天里挂着一条没撤回的消息
  db.prepare(
    "UPDATE bank_accounts SET alert_fired_at = '2026-11-03 10:00:00', alert_fired_date = '2026-11-03', alert_fired_balance = 500 WHERE id = ?"
  ).run(a1);
  addSentMessage(db, { bank_account_id: a1, message_id: 42 });

  addPending(db, "T-approved", "approved", { approved_by: "op1" });
  db.prepare("INSERT INTO bank_balance_log (bank_account_id, tx_id, amount) VALUES (?, ?, ?)").run(a1, "T-approved", 500);
  addPending(db, "T-pending-1", "pending");
  addPending(db, "T-pending-2", "pending", { company_id: "beta" });
  addPending(db, "T-skipped", "skipped");
  return { db, a1, b1 };
}

function snapshot(db) {
  const tables = ["bank_ledger", "bank_ledger_deleted", "bank_tx_pending", "bank_balance_log", "bank_accounts", "telegram_outbox"];
  return Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()]));
}

test("plan 按公司报数，且不写任何东西", () => {
  const { db } = seed();
  const before = snapshot(db);
  const plan = planLedgerReset(db);
  assert.deepEqual(snapshot(db), before);
  const alpha = plan.find((r) => r.companyId === "alpha");
  const beta = plan.find((r) => r.companyId === "beta");
  assert.equal(alpha.ledger, 1);
  assert.equal(alpha.ledgerDeleted, 1);
  assert.equal(alpha.pendingVoided, 2); // pending + skipped，approved 不算
  assert.equal(alpha.nonZeroBalances, 1);
  assert.equal(alpha.alertsFired, 1);
  assert.equal(beta.ledger, 1);
  assert.equal(beta.pendingVoided, 1);
});

test("执行后流水与回收站清空、余额归零", () => {
  const { db, a1, b1 } = seed();
  applyLedgerReset(db, systemActor("test"), "test");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bank_ledger").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bank_ledger_deleted").get().n, 0);
  assert.equal(accountRow(db, a1).balance, 0);
  assert.equal(accountRow(db, b1).balance, 0);
});

test("待审批标成 expired 而不是删除；approved 不动；bank_balance_log 保留", () => {
  const { db } = seed();
  applyLedgerReset(db, systemActor("test"), "test");
  const states = Object.fromEntries(
    db.prepare("SELECT tx_id, state, decided_by FROM bank_tx_pending").all().map((r) => [r.tx_id, r])
  );
  assert.equal(states["T-pending-1"].state, "expired");
  assert.equal(states["T-pending-1"].decided_by, "cutover");
  assert.equal(states["T-pending-2"].state, "expired");
  assert.equal(states["T-skipped"].state, "expired");
  assert.equal(states["T-approved"].state, "approved");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bank_balance_log").get().n, 1);
});

test("同步再次拉到同一批单不会重新入队，新单照常入队", () => {
  const { db } = seed();
  applyLedgerReset(db, systemActor("test"), "test");
  const n = enqueuePendingTx(db, "alpha", [
    { id: "T-pending-1", type: "DEPOSIT", amount: 100, created_at: "2026-11-03 10:00:00" },
    { id: "T-skipped", type: "DEPOSIT", amount: 100, created_at: "2026-11-03 10:00:00" },
    { id: "T-approved", type: "DEPOSIT", amount: 500, created_at: "2026-11-03 10:00:00" },
    { id: "T-new", type: "WITHDRAW", amount: 30, created_at: "2026-11-04 09:00:00" },
  ]);
  assert.equal(n, 1);
  const pending = db.prepare("SELECT tx_id FROM bank_tx_pending WHERE state = 'pending'").all().map((r) => r.tx_id);
  assert.deepEqual(pending, ["T-new"]);
});

test("报警状态复位，并为挂着的消息排撤回任务", () => {
  const { db, a1 } = seed();
  const result = applyLedgerReset(db, systemActor("test"), "test");
  assert.equal(result.alertsCleared, 1);
  const row = accountRow(db, a1);
  assert.equal(row.alert_fired_at, "");
  assert.equal(row.alert_fired_date, "");
  assert.equal(row.alert_fired_balance, 0);
  const retracts = outbox(db).filter((r) => r.kind === "retract");
  assert.equal(retracts.length, 1);
  assert.equal(retracts[0].bank_account_id, a1);
});

test("每家公司写一条审计事件", () => {
  const { db } = seed();
  applyLedgerReset(db, systemActor("test"), "上线切换");
  const events = db
    .prepare("SELECT company_id, action, reason FROM audit_events WHERE action = 'ledger.cutover_reset' ORDER BY company_id")
    .all();
  assert.deepEqual(events.map((e) => e.company_id), ["alpha", "beta"]);
  assert.equal(events[0].reason, "上线切换");
});

test("重复执行是 no-op", () => {
  const { db } = seed();
  applyLedgerReset(db, systemActor("test"), "test");
  const plan = planLedgerReset(db);
  for (const r of plan) {
    assert.equal(r.ledger + r.ledgerDeleted + r.pendingVoided + r.nonZeroBalances + r.alertsFired, 0);
  }
});
