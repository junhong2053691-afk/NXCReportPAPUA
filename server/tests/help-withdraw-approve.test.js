// 平台提现单审批的「调钱 / 拆分调钱」必须按 bank-c-status.test.js 定下的 Excel 口径落列：
// 别家替我付客户提现 = status withdraw + help_amount → C STATUS 记 IN（我欠对方），
// REPORT 的 WITHDRAW 含这笔。协助方自己记 CASH OUT（OUT），两边相加为 0。
//
// 2026-11-06 员工演练：「调钱」落成 cash in + trf_amount（C STATUS 记 OUT，和协助方同号，
// 永远对不平）；「拆分调钱」协助部分落成 withdraw + amount_in（方向对，但「入账 IN」虚增、
// REPORT 把它算进 CASH IN、WITHDRAW 少算）。用户给的 4 家 Excel C STATUS 表确认：
// 同一笔代付两边总是一 IN 一 OUT，客户所在公司那边是 IN。
const test = require("node:test");
const assert = require("node:assert");

const { ensureAuditSchema } = require("../lib/auditLog");
const { computeBankDailyReport } = require("../lib/bankReport");
const { approvePendingTx } = require("../lib/bankApply");
const { bankDatabase, addCompany, addAccount, addLedger, addCStatusOption } = require("./bank-fixture");

const DAY = "2026-10-01";
const actor = { type: "user", userId: 1, username: "ops", name: "Ops", role: "operator" };
const round2 = (n) => Math.round(n * 100) / 100;

function setup() {
  const db = bankDatabase();
  ensureAuditSchema(db);
  db.exec(`
    CREATE TABLE bank_tx_pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT, tx_id TEXT, tx_type TEXT,
      amount REAL, username TEXT, name TEXT, tx_time TEXT, state TEXT,
      bank_account_id INTEGER DEFAULT 0, approve_mode TEXT DEFAULT '', c_status TEXT DEFAULT '',
      approved_entry_time TEXT DEFAULT '', approved_at TEXT, approved_by TEXT DEFAULT '',
      decided_at TEXT, decided_by TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(company_id, tx_id)
    );
    CREATE TABLE bank_balance_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bank_account_id INTEGER, tx_id TEXT UNIQUE,
      amount REAL DEFAULT 0, applied_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE transactions (id TEXT, company_id TEXT, type TEXT, amount REAL, username TEXT, name TEXT, created_at TEXT);
  `);
  addCompany(db, { id: "alpha", name: "AussieX6" });
  addCompany(db, { id: "beta", name: "Rolex66" });
  addCStatusOption(db, "alpha", "RX66", "beta", { reconcile_required: 1 });
  addCStatusOption(db, "beta", "AuX6", "alpha", { reconcile_required: 1 });
  return db;
}

function withdrawPending(db, txId, amount) {
  db.prepare(
    `INSERT INTO bank_tx_pending (company_id, tx_id, tx_type, amount, username, name, tx_time, state)
     VALUES ('alpha', ?, 'WITHDRAW', ?, 'cust', 'Customer', ?, 'pending')`
  ).run(txId, amount, `${DAY} 10:00:00`);
}

const report = (db, cid) => computeBankDailyReport(db, cid, { date: DAY });
const cRow = (r, name) => r.companyRows.find((x) => x.name === name);
const amountOf = (r, key) => r.reportRows.find((x) => x.key === key)?.amount ?? 0;

test("调钱：RX66 替我付客户提现 → withdraw + help_amount，C STATUS 记 IN，REPORT 算进 WITHDRAW", () => {
  const db = setup();
  withdrawPending(db, "w1", 154.75);
  const { ledger } = approvePendingTx(db, "alpha", "w1", { mode: "help", c_status: "RX66" }, actor);

  assert.strictEqual(ledger.status, "withdraw");
  assert.strictEqual(round2(ledger.help_amount), 154.75);
  assert.strictEqual(ledger.amount_in, 0);
  assert.strictEqual(ledger.trf_amount, 0);

  const r = report(db, "alpha");
  assert.strictEqual(round2(cRow(r, "RX66").in), 154.75);
  assert.strictEqual(round2(cRow(r, "RX66").out), 0);
  assert.strictEqual(round2(amountOf(r, "withdraw")), -154.75);
  assert.strictEqual(round2(amountOf(r, "cash in")), 0);
  assert.strictEqual(r.totals.total_in, 0, "别人替我付的钱不是我方入账");
});

test("调钱与协助方的 CASH OUT 对平（Excel：一边 IN 一边 OUT）", () => {
  const db = setup();
  const b = addAccount(db, { company_id: "beta" });
  // RX66 用自己的户口付了 alpha 客户的提现
  addLedger(db, b, 0, DAY, { status: "cash out", amount_out: 154.75, c_status: "AuX6", company_id: "beta" });
  withdrawPending(db, "w2", 154.75);
  approvePendingTx(db, "alpha", "w2", { mode: "help", c_status: "RX66" }, actor);

  assert.deepStrictEqual(report(db, "alpha").reconcileAlerts, []);
  assert.deepStrictEqual(report(db, "beta").reconcileAlerts, []);
});

test("拆分调钱：协助部分同样是 withdraw + help_amount，不进 IN 列，WITHDRAW 是全额", () => {
  const db = setup();
  const a = addAccount(db, { company_id: "alpha" });
  withdrawPending(db, "w3", 500);
  const { ledgers } = approvePendingTx(db, "alpha", "w3", {
    mode: "help_split", self_amount: 300, self_bank_account_id: a, splits: [{ c_status: "RX66", amount: 200 }],
  }, actor);

  const helper = ledgers.find((l) => l.c_status === "RX66");
  assert.strictEqual(helper.status, "withdraw");
  assert.strictEqual(round2(helper.help_amount), 200);
  assert.strictEqual(helper.amount_in, 0);

  const r = report(db, "alpha");
  assert.strictEqual(round2(cRow(r, "RX66").in), 200);
  assert.strictEqual(round2(amountOf(r, "withdraw")), -500);
  assert.strictEqual(round2(amountOf(r, "cash in")), 0, "拆分协助部分以前被算进 CASH IN");
  assert.strictEqual(r.totals.total_in, 0, "以前「入账 IN」被协助部分虚增");
});
