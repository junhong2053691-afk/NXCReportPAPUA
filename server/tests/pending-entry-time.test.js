// 审批平台单的入账时间（pendingLedgerEntryTime）。
//
// 口径（2026-11-06 与用户确认）：默认仍记**平台单日期与时间**（Excel 按平台单那天算），
// 但入账时间**不能晚于现在**。员工演练：只把日期改成今天、时间没动，保留了平台时间 16:55，
// 而当时才 14:30 → 一笔「未来流水」，今天的报表、余额上界都被它带歪。前端改日期时会把时间
// 跳到当前时间；这里是服务端最后一道闸，收到未来时间直接 400，不静默改写。
const test = require("node:test");
const assert = require("node:assert");

const { ensureAuditSchema } = require("../lib/auditLog");
const { approvePendingTx, pendingLedgerEntryTime } = require("../lib/bankApply");
const { bankDatabase, addCompany, addAccount } = require("./bank-fixture");

// 2026-11-06 14:30:00 悉尼（AEDT, UTC+11）
const NOW = Date.parse("2026-11-06T03:30:00Z");
const pending = { tx_time: "2026-10-02 16:55:00" };

test("不传入账时间：沿用平台单的日期与时间", () => {
  assert.strictEqual(pendingLedgerEntryTime(pending, "", NOW), "2026-10-02 16:55:00");
});

test("改到往日任意时间：照用", () => {
  assert.strictEqual(pendingLedgerEntryTime(pending, "2026-10-05 23:59", NOW), "2026-10-05 23:59:00");
});

test("改成今天、时间早于现在：照用", () => {
  assert.strictEqual(pendingLedgerEntryTime(pending, "2026-11-06 14:30", NOW), "2026-11-06 14:30:00");
});

test("改成今天但保留平台时间 16:55（晚于现在 14:30）：拒绝，不落未来流水", () => {
  assert.throws(
    () => pendingLedgerEntryTime(pending, "2026-11-06 16:55", NOW),
    (err) => err.status === 400 && /晚于现在/.test(err.message)
  );
});

test("未来日期：拒绝", () => {
  assert.throws(() => pendingLedgerEntryTime(pending, "2026-11-07 09:00", NOW), (err) => err.status === 400);
});

test("浏览器时钟快几分钟（5 分钟以内）不误拒", () => {
  assert.strictEqual(pendingLedgerEntryTime(pending, "2026-11-06 14:34", NOW), "2026-11-06 14:34:00");
});

test("无效时间仍按原规则 400", () => {
  assert.throws(() => pendingLedgerEntryTime(pending, "2026-13-40 10:00", NOW), /入账日期或时间无效/);
});

test("审批传未来时间：整笔不入账，单子仍在待处理", () => {
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
  const acc = addAccount(db);
  db.prepare(
    `INSERT INTO bank_tx_pending (company_id, tx_id, tx_type, amount, username, name, tx_time, state)
     VALUES ('alpha', 'tx-future', 'DEPOSIT', 100, 'cust', 'Customer', '2026-10-02 16:55:00', 'pending')`
  ).run();
  const actor = { type: "user", userId: 1, username: "ops", name: "Ops", role: "operator" };

  assert.throws(
    () => approvePendingTx(db, "alpha", "tx-future", { mode: "bank", bank_account_id: acc, entry_time: "2099-01-01 10:00" }, actor),
    (err) => err.status === 400
  );
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM bank_ledger").get().n, 0);
  assert.strictEqual(db.prepare("SELECT state FROM bank_tx_pending WHERE tx_id = 'tx-future'").get().state, "pending");
});
