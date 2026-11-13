// 更正「审批时入账日期误选」的流水（lib/pendingEntryDateFix.js，脚本 scripts/fix-pending-entry-date.js）。
// 起因：2026-11-13 rolex66 17271440755，11-13 的单被审批成 10-13，日报里少一笔像漏单。
const test = require("node:test");
const assert = require("node:assert");

const { ensureAuditSchema, systemActor } = require("../lib/auditLog");
const { findMisdatedApprovals, fixMisdatedApprovals } = require("../lib/pendingEntryDateFix");
const { bankDatabase, addCompany, addAccount, accountRow } = require("./bank-fixture");

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
  `);
  addCompany(db, { id: "rolex66", name: "Rolex66" });
  const acc = addAccount(db, { company_id: "rolex66" });
  const add = (txId, txTime, entry, amount) => {
    db.prepare(
      `INSERT INTO bank_tx_pending (company_id, tx_id, tx_type, amount, username, name, tx_time, state, bank_account_id, approved_entry_time, approved_by)
       VALUES ('rolex66', ?, 'DEPOSIT', ?, 'u', 'n', ?, 'approved', ?, ?, 'admin')`
    ).run(txId, amount, txTime, acc, entry);
    db.prepare(
      `INSERT INTO bank_ledger (bank_account_id, company_id, entry_time, tx_id, status, amount_in, auto_generated)
       VALUES (?, 'rolex66', ?, ?, 'deposit', ?, 1)`
    ).run(acc, entry, txId, amount);
  };
  add("17271440755", "2026-11-13 16:57:21", "2026-10-13 16:57:00", 45); // 月份误选
  add("OK-SAME", "2026-11-13 10:00:00", "2026-11-13 10:00:00", 20); // 正常
  add("OK-PREV", "2026-11-13 00:05:00", "2026-11-12 23:58:00", 30); // 前一天，合法
  add("OLD", "2026-11-05 10:00:00", "2026-10-05 10:00:00", 99); // 清场之前，不碰
  db.prepare("UPDATE bank_accounts SET balance = 194 WHERE id = ?").run(acc);
  return { db, acc };
}

test("只找出早于平台日期前一天的审批，清场前的不算", () => {
  const { db } = setup();
  const items = findMisdatedApprovals(db);
  assert.deepStrictEqual(items.map((it) => it.pending.tx_id), ["17271440755"]);
  assert.strictEqual(items[0].ledger.length, 1);
  assert.strictEqual(items[0].platformDate, "2026-11-13");
});

test("dry-run（只查）不改库", () => {
  const { db } = setup();
  findMisdatedApprovals(db);
  assert.strictEqual(db.prepare("SELECT entry_time FROM bank_ledger WHERE tx_id='17271440755'").get().entry_time, "2026-10-13 16:57:00");
});

test("更正：只换日期、时分秒不动，写审计，余额照算", () => {
  const { db, acc } = setup();
  const result = fixMisdatedApprovals(db, findMisdatedApprovals(db), systemActor("test"));
  assert.deepStrictEqual(result, { pendingFixed: 1, ledgerFixed: 1, banks: [acc] });
  assert.strictEqual(db.prepare("SELECT entry_time FROM bank_ledger WHERE tx_id='17271440755'").get().entry_time, "2026-11-13 16:57:00");
  assert.strictEqual(db.prepare("SELECT approved_entry_time FROM bank_tx_pending WHERE tx_id='17271440755'").get().approved_entry_time, "2026-11-13 16:57:00");
  // 别的单原样
  assert.strictEqual(db.prepare("SELECT entry_time FROM bank_ledger WHERE tx_id='OK-PREV'").get().entry_time, "2026-11-12 23:58:00");
  assert.strictEqual(db.prepare("SELECT entry_time FROM bank_ledger WHERE tx_id='OLD'").get().entry_time, "2026-10-05 10:00:00");
  const audit = db.prepare("SELECT action, summary, before_json, after_json FROM audit_events WHERE action='ledger.updated'").all();
  assert.strictEqual(audit.length, 1);
  assert.match(audit[0].summary, /17271440755.*2026-10-13 → 2026-11-13/);
  assert.deepStrictEqual(JSON.parse(audit[0].after_json), { entry_time: "2026-11-13 16:57:00" });
  // 只改日期不改金额，累计余额不变
  assert.strictEqual(accountRow(db, acc).balance, 194);
  // 再跑一次什么都找不到
  assert.strictEqual(findMisdatedApprovals(db).length, 0);
});

test("--tx 只处理指定单", () => {
  const { db } = setup();
  assert.strictEqual(findMisdatedApprovals(db, { txId: "OK-SAME" }).length, 0);
  assert.strictEqual(findMisdatedApprovals(db, { txId: "17271440755" }).length, 1);
});
