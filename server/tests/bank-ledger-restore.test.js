// 「误审 → 删除 → 重审 → 最近删除里恢复旧行」的双计，以及删掉重复行后把单子打回待处理。
// 2026-11-06 员工演练里 4 家公司都复现了：同一 tx_id 在账上出现两行，再删一行又能审第三次。
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const { ensureAuditSchema } = require("../lib/auditLog");
const { reopenPendingForLedger, restoreConflictForDeleted } = require("../lib/bankApply");

function database() {
  const db = new Database(":memory:");
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
    CREATE TABLE bank_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bank_account_id INTEGER DEFAULT 0,
      company_id TEXT, entry_time TEXT, tx_id TEXT, status TEXT, amount_in REAL DEFAULT 0,
      amount_out REAL DEFAULT 0, help_amount REAL DEFAULT 0, trf_amount REAL DEFAULT 0,
      bank_acc TEXT DEFAULT '', username TEXT DEFAULT '', name TEXT DEFAULT '', c_status TEXT DEFAULT '',
      other_info TEXT DEFAULT '', remark TEXT DEFAULT '', auto_generated INTEGER DEFAULT 0,
      transfer_group_id TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE bank_balance_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bank_account_id INTEGER, tx_id TEXT UNIQUE,
      amount REAL DEFAULT 0, applied_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE transactions (id TEXT, company_id TEXT, type TEXT, amount REAL, username TEXT, name TEXT, created_at TEXT);
  `);
  return db;
}

function approvedDeposit(db, txId, bankId) {
  db.prepare(
    `INSERT INTO bank_tx_pending (company_id, tx_id, tx_type, amount, tx_time, state, bank_account_id, approve_mode)
     VALUES ('alpha', ?, 'DEPOSIT', 50, '2026-10-06 10:00:00', 'approved', ?, 'bank')`
  ).run(txId, bankId);
  db.prepare("INSERT INTO bank_balance_log (bank_account_id, tx_id, amount) VALUES (?, ?, 50)").run(bankId, txId);
}

function ledgerRow(db, txId, bankId, extra = {}) {
  const r = db.prepare(
    `INSERT INTO bank_ledger (bank_account_id, company_id, entry_time, tx_id, status, amount_in, auto_generated, transfer_group_id)
     VALUES (?, 'alpha', '2026-10-06 10:00:00', ?, 'deposit', 50, 1, ?)`
  ).run(bankId, txId, extra.transfer_group_id || "");
  return db.prepare("SELECT * FROM bank_ledger WHERE id = ?").get(r.lastInsertRowid);
}

const pendingState = (db, txId) => db.prepare("SELECT state FROM bank_tx_pending WHERE tx_id = ?").get(txId).state;
const balanceLogRows = (db, txId) => db.prepare("SELECT COUNT(*) n FROM bank_balance_log WHERE tx_id = ?").get(txId).n;

test("恢复已删流水时，若同一平台单已经重新入账，必须报冲突（否则双计）", () => {
  const db = database();
  // 误审到 A 户 → 删除（行进了回收站）→ 重审到 B 户
  approvedDeposit(db, "tx-1", 2);
  const rebooked = ledgerRow(db, "tx-1", 2);
  const deleted = { company_id: "alpha", tx_id: "tx-1", bank_account_id: 1, status: "deposit", auto_generated: 1, transfer_group_id: "" };

  const conflict = restoreConflictForDeleted(db, deleted);
  assert.ok(conflict, "已重新入账的平台单不能再恢复旧行");
  assert.equal(conflict.id, rebooked.id);
});

test("恢复已删流水：没有重新入账时照常允许（撤销误删）", () => {
  const db = database();
  approvedDeposit(db, "tx-2", 1);
  const deleted = { company_id: "alpha", tx_id: "tx-2", bank_account_id: 1, status: "deposit", auto_generated: 1, transfer_group_id: "" };
  assert.equal(restoreConflictForDeleted(db, deleted), null);
});

test("恢复拆分组里的一行：同组兄弟行不算冲突", () => {
  const db = database();
  approvedDeposit(db, "tx-3", 1);
  ledgerRow(db, "tx-3", 1, { transfer_group_id: "trf_a" });
  const deleted = { company_id: "alpha", tx_id: "tx-3", bank_account_id: 0, status: "withdraw", auto_generated: 1, transfer_group_id: "trf_a" };
  assert.equal(restoreConflictForDeleted(db, deleted), null);
  // 但别的组（重审出来的）照样算冲突
  ledgerRow(db, "tx-3", 2, { transfer_group_id: "trf_b" });
  assert.ok(restoreConflictForDeleted(db, deleted));
});

test("没有 tx_id 的手工流水不受影响", () => {
  const db = database();
  ledgerRow(db, "", 1);
  assert.equal(restoreConflictForDeleted(db, { company_id: "alpha", tx_id: "", transfer_group_id: "" }), null);
});

test("删掉重复行时，同一平台单还有别的流水在账上 → 不能打回待处理，也不能删防重锁", () => {
  const db = database();
  approvedDeposit(db, "tx-4", 2);
  const keep = ledgerRow(db, "tx-4", 2);
  const dup = ledgerRow(db, "tx-4", 1);
  // 删除路由先删行、再调 reopenPendingForLedger
  db.prepare("DELETE FROM bank_ledger WHERE id = ?").run(dup.id);

  assert.equal(reopenPendingForLedger(db, dup), false);
  assert.equal(pendingState(db, "tx-4"), "approved");
  assert.equal(balanceLogRows(db, "tx-4"), 1, "bank_balance_log 是同步侧的防重锁，还有流水在账上就不能删");
  assert.ok(db.prepare("SELECT 1 FROM bank_ledger WHERE id = ?").get(keep.id));
});

test("删掉唯一一行时照常打回待处理（原有的误审纠错路径）", () => {
  const db = database();
  approvedDeposit(db, "tx-5", 1);
  const only = ledgerRow(db, "tx-5", 1);
  db.prepare("DELETE FROM bank_ledger WHERE id = ?").run(only.id);

  assert.equal(reopenPendingForLedger(db, only), true);
  assert.equal(pendingState(db, "tx-5"), "pending");
  assert.equal(balanceLogRows(db, "tx-5"), 0);
});

test("恢复路径：刚插回的那一行（及同组兄弟）不挡自己的 reopen", () => {
  const db = database();
  approvedDeposit(db, "tx-6", 1);
  db.prepare("UPDATE bank_tx_pending SET state = 'pending' WHERE tx_id = 'tx-6'").run();
  const restored = ledgerRow(db, "tx-6", 1, { transfer_group_id: "trf_c" });
  ledgerRow(db, "tx-6", 0, { transfer_group_id: "trf_c" });
  const deleted = { ...restored, id: 999 };

  assert.equal(reopenPendingForLedger(db, deleted, { excludeLedgerId: restored.id, excludeGroupId: "trf_c" }), true);
});
