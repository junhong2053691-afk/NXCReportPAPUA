// 网页余额报警的数据源（bankAlerts.overLimitAccounts，经 GET /api/banks/pending-counts 的 over_limit）。
// 判定口径必须与 Telegram 报警（evaluateBalanceAlert）一致，且纯读。
const test = require("node:test");
const assert = require("node:assert/strict");

const { bankDatabase: database, addAccount, addLedger: addLedgerRow, accountRow, outbox } = require("./bank-fixture");
const { overLimitAccounts } = require("../lib/bankAlerts");
const { refreshBankBalance } = require("../lib/bankReport");
const { todayKey, shiftDateKey } = require("../lib/dates");

const TODAY = todayKey();
const YESTERDAY = shiftDateKey(TODAY, -1);

function addLedger(db, bankAccountId, amountIn, dateKey = TODAY, extra = {}) {
  return addLedgerRow(db, bankAccountId, amountIn, dateKey, extra);
}

test("只列运营中、设了阈值且余额 ≥ 阈值的账户；只看本公司", () => {
  const db = database();
  const over = addAccount(db, { alert_threshold: 1000 });
  const exact = addAccount(db, { alert_threshold: 500 });
  const under = addAccount(db, { alert_threshold: 1000 });
  const noLimit = addAccount(db, { alert_threshold: 0 });
  const banned = addAccount(db, { alert_threshold: 100, lifecycle_status: "banned" });
  const archived = addAccount(db, { alert_threshold: 100, lifecycle_status: "archived", active: 0 });
  const other = addAccount(db, { alert_threshold: 100, company_id: "beta" });
  addLedger(db, over, 1500);
  addLedger(db, exact, 500);
  addLedger(db, under, 999.99);
  addLedger(db, noLimit, 9000);
  addLedger(db, banned, 9000);
  addLedger(db, archived, 0);
  addLedger(db, other, 9000);

  const rows = overLimitAccounts(db, "alpha", TODAY);
  assert.deepEqual(rows.map((r) => r.id), [over, exact]);
  assert.equal(rows[0].balance, 1500);
  assert.equal(rows[0].threshold, 1000);
  assert.ok(rows[0].label.includes("CBA Sydney"));
  assert.deepEqual(overLimitAccounts(db, "beta", TODAY).map((r) => r.id), [other]);
  assert.deepEqual(overLimitAccounts(db, "", TODAY), []);
  db.close();
});

test("alertedBalance 跟着 alert_fired_balance 走：回落再回升不变，涨过上次报警值才变", () => {
  const db = database();
  const id = addAccount(db, { alert_threshold: 1000 });
  const alerted = () => overLimitAccounts(db, "alpha", TODAY)[0]?.alertedBalance;

  addLedger(db, id, 2000);
  refreshBankBalance(db, id);
  assert.equal(alerted(), 2000);

  addLedger(db, id, 0, TODAY, { amount_out: 500 });
  refreshBankBalance(db, id);
  addLedger(db, id, 300);
  refreshBankBalance(db, id);
  assert.equal(overLimitAccounts(db, "alpha", TODAY)[0].balance, 1800);
  assert.equal(alerted(), 2000, "同一桶钱来回动，基准不变 → 网页报警不重响");

  addLedger(db, id, 500);
  refreshBankBalance(db, id);
  assert.equal(alerted(), 2300, "涨过上次报警值，基准抬高 → 网页报警重响");
  db.close();
});

test("还没报过 / 每日归零账户昨天的残值：alertedBalance 退回当前余额", () => {
  const db = database();
  const fresh = addAccount(db, { alert_threshold: 1000 });
  addLedger(db, fresh, 1200);
  // 不调 refreshBankBalance：报警判定还没跑到它。
  assert.equal(overLimitAccounts(db, "alpha", TODAY)[0].alertedBalance, 1200);

  const daily = addAccount(db, { alert_threshold: 1000, reset_daily_balance: 1 });
  db.prepare(
    `UPDATE bank_accounts SET alert_fired_at = datetime('now'), alert_fired_date = ?, alert_fired_balance = 9000 WHERE id = ?`
  ).run(YESTERDAY, daily);
  addLedger(db, daily, 1500, TODAY);
  const row = overLimitAccounts(db, "alpha", TODAY).find((r) => r.id === daily);
  assert.equal(row.alertedBalance, 1500, "昨天的高点不能当今天的基准");
  db.close();
});

test("纯读：不改报警状态、不写 outbox", () => {
  const db = database();
  const id = addAccount(db, { alert_threshold: 1000 });
  addLedger(db, id, 5000);
  const before = accountRow(db, id);
  overLimitAccounts(db, "alpha", TODAY);
  const after = accountRow(db, id);
  assert.equal(after.alert_fired_at, before.alert_fired_at);
  assert.equal(after.alert_fired_balance, before.alert_fired_balance);
  assert.equal(outbox(db).length, 0);
  db.close();
});
