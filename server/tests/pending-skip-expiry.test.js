// 跳过的平台单什么时候过期。2026-11-06 员工演练：4 家公司都是「跳过一笔 10 月的旧单 → 几秒后
// 变 expired、已跳过页是空的、无法 Restore」，而 toast 写着「可在 Skipped tab 恢复」。
// 根因：过期按平台单日期 tx_time 判定，所以任何往日的单一跳过就满足「早于今天」。
// 正确口径：按**跳过的那一天**（实例时区）算，当天跳过的当天都能恢复，过了午夜才过期。
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const { ensureAuditSchema } = require("../lib/auditLog");
const { todayKey, shiftDateKey, localMidnightUtc } = require("../lib/dates");
const {
  skipPendingTx,
  restoreSkippedPendingTx,
  listSkippedPendingTx,
  pendingCounts,
} = require("../lib/bankApply");

const actor = { type: "user", userId: 1, username: "ops", name: "Ops", role: "operator" };

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
  `);
  return db;
}

function addPending(db, txId, txDate, state = "pending", decidedAt = null) {
  db.prepare(
    `INSERT INTO bank_tx_pending (company_id, tx_id, tx_type, amount, tx_time, state, decided_at)
     VALUES ('alpha', ?, 'DEPOSIT', 25, ?, ?, ?)`
  ).run(txId, `${txDate} 10:00:00`, state, decidedAt);
}
const stateOf = (db, txId) => db.prepare("SELECT state FROM bank_tx_pending WHERE tx_id = ?").get(txId).state;

test("今天跳过一笔一个月前的旧单：仍在「已跳过」里、计数里，可以 Restore", () => {
  const db = database();
  const today = todayKey();
  addPending(db, "old-1", shiftDateKey(today, -35));
  skipPendingTx(db, "alpha", "old-1", actor, "未到账");

  const listed = listSkippedPendingTx(db, "alpha", 100, today);
  assert.deepEqual(listed.map((r) => r.tx_id), ["old-1"]);
  assert.equal(stateOf(db, "old-1"), "skipped");
  assert.equal(pendingCounts(db, "alpha").skipped_tx, 1);

  restoreSkippedPendingTx(db, "alpha", "old-1", actor, "客户确认已转");
  assert.equal(stateOf(db, "old-1"), "pending");
});

test("昨天跳过的单：今天过期（保留「已跳过不无限堆积」的原意）", () => {
  const db = database();
  const today = todayKey();
  // 昨天 23:00 本地时间跳过 = 今天本地零点前一小时（UTC）
  const yesterdayLate = new Date(Date.parse(localMidnightUtc(today).replace(" ", "T") + "Z") - 3600e3)
    .toISOString().slice(0, 19).replace("T", " ");
  addPending(db, "old-2", shiftDateKey(today, -2), "skipped", yesterdayLate);
  addPending(db, "today-2", today, "skipped", yesterdayLate);

  assert.equal(listSkippedPendingTx(db, "alpha", 100, today).length, 0);
  assert.equal(stateOf(db, "old-2"), "expired");
  assert.equal(stateOf(db, "today-2"), "expired", "按跳过日判定，不是按平台单日期");
});

test("今天本地零点之后跳过的单不过期，哪怕平台单日期很旧", () => {
  const db = database();
  const today = todayKey();
  const justAfterMidnight = new Date(Date.parse(localMidnightUtc(today).replace(" ", "T") + "Z") + 60e3)
    .toISOString().slice(0, 19).replace("T", " ");
  addPending(db, "old-3", shiftDateKey(today, -60), "skipped", justAfterMidnight);
  assert.equal(pendingCounts(db, "alpha").skipped_tx, 1);
  assert.equal(stateOf(db, "old-3"), "skipped");
});

test("没有 decided_at 的历史 skipped 行：退回按平台单日期判定（旧行为）", () => {
  const db = database();
  const today = todayKey();
  addPending(db, "legacy-old", shiftDateKey(today, -3), "skipped", null);
  addPending(db, "legacy-today", today, "skipped", null);
  const listed = listSkippedPendingTx(db, "alpha", 100, today).map((r) => r.tx_id);
  assert.deepEqual(listed, ["legacy-today"]);
  assert.equal(stateOf(db, "legacy-old"), "expired");
});
