// 封禁户余额计入 EXPENSES（server/lib/blockedExpense.js）。口径见 CONTEXT.md「封禁户余额」：
//   封禁EXPENSES(D) = stuck(D) − stuck(D−1)，stuck = 当天结束时封禁 / 归档的非 PG 户累计余额。
// 只改报表口径，不写流水；日报 EXPENSES 与月报 EXPENSES 同一份实现、逐分相等。
const test = require("node:test");
const assert = require("node:assert/strict");

const { setTimezone } = require("../lib/dates");
const { ensureAuditSchema } = require("../lib/auditLog");
const { drainBannedAccount } = require("../lib/bankApply");
const { blockedExpenseByDay, stuckBalanceCents, localDayOfUtc } = require("../lib/blockedExpense");
const { computeBankDailyReport, balanceFromLedger } = require("../lib/bankReport");
const { computeMonthlyReport, computeYearlyReport } = require("../lib/monthlyReport");
const { bankDatabase, addCompany, addAccount, addLedger, addAccountEvent } = require("./bank-fixture");

setTimezone("Australia/Sydney");

const actor = { type: "user", userId: 1, username: "ops", name: "Ops", role: "operator" };

// 悉尼 11 月是 AEDT（UTC+11）：本地 D 日中午 = UTC D 日 01:00。
const evAt = (day) => `${day} 01:00:00`;

function setup() {
  const db = bankDatabase();
  const acc = addAccount(db, { account_name: "SAHMARA" });
  const live = addAccount(db, { account_name: "KYLIE" });
  return { db, acc, live };
}

function ban(db, id, day) {
  db.prepare("UPDATE bank_accounts SET lifecycle_status = 'banned', active = 0 WHERE id = ?").run(id);
  addAccountEvent(db, id, "banned", evAt(day));
}
function unban(db, id, day) {
  db.prepare("UPDATE bank_accounts SET lifecycle_status = 'active' WHERE id = ?").run(id);
  addAccountEvent(db, id, "unbanned", evAt(day));
}

const byDay = (db, from, to) => Object.fromEntries(blockedExpenseByDay(db, "alpha", from, to));
const reportExpenses = (db, date) => computeBankDailyReport(db, "alpha", { date }).reportRows.find((r) => r.key === "expenses");

test("封禁当天：EXPENSES += 该户当时余额；笔数不变；WIN/LOSE 不变", () => {
  const { db, acc } = setup();
  addLedger(db, acc, 1000, "2026-11-01");
  addLedger(db, acc, 0, "2026-11-03", { status: "expenses", amount_out: 15 });
  ban(db, acc, "2026-11-03");

  assert.deepEqual(byDay(db, "2026-11-01", "2026-11-05"), { "2026-11-03": 98500 });
  const daily = computeBankDailyReport(db, "alpha", { date: "2026-11-03" });
  const row = daily.reportRows.find((r) => r.key === "expenses");
  assert.equal(row.amount, -1000, "流水 15 + 封禁 985");
  assert.equal(row.count, 1, "笔数只数 expenses 流水");
  assert.equal(row.blocked, 985);
  assert.equal(daily.totals.blocked_expense, 985);
  assert.equal(daily.reportPairs.find((p) => p.leftLabel === "EXPENSES").leftBlocked, 985);
  assert.equal(daily.totals.win_loss, 0);
  assert.equal(reportExpenses(db, "2026-11-02").amount, 0, "封禁前一天不受影响");
});

test("转出余额那天扣回转出的数（走真实的 drainBannedAccount）", () => {
  const { db, acc, live } = setup();
  ensureAuditSchema(db);
  addCompany(db, { id: "alpha", name: "EzSpin68" });
  addLedger(db, acc, 1000, "2026-10-01");
  ban(db, acc, "2026-10-02");
  drainBannedAccount(db, "alpha", acc, { amount: 400, to_bank_account_id: live }, actor);
  const drainDay = db.prepare("SELECT substr(entry_time,1,10) d FROM bank_ledger WHERE status = 'bank trf'").get().d;

  const map = byDay(db, "2026-10-01", drainDay);
  assert.equal(map["2026-10-02"], 100000);
  assert.equal(map[drainDay], -40000);
  assert.equal(reportExpenses(db, drainDay).amount, 400, "当天 EXPENSES 变成正数（收回）");
});

test("解封当天扣回全部；归档 / 取消归档不变；同一天封又解 = 0", () => {
  const { db, acc, live } = setup();
  addLedger(db, acc, 300, "2026-11-01");
  addLedger(db, live, 50, "2026-11-01");
  ban(db, acc, "2026-11-02");
  addAccountEvent(db, acc, "archived", evAt("2026-11-03"));
  addAccountEvent(db, acc, "unarchived", evAt("2026-11-04"));
  unban(db, acc, "2026-11-05");
  ban(db, live, "2026-11-06");
  unban(db, live, "2026-11-06");

  assert.deepEqual(byDay(db, "2026-11-01", "2026-11-07"), { "2026-11-02": 30000, "2026-11-05": -30000 });
});

test("PG 封禁不算 EXPENSES", () => {
  const db = bankDatabase();
  const pg = addAccount(db, { account_kind: "payment_gateway" });
  addLedger(db, pg, 500, "2026-11-01");
  ban(db, pg, "2026-11-02");
  assert.deepEqual(byDay(db, "2026-11-01", "2026-11-03"), {});
});

test("没有任何生命周期事件的封禁户：视作一直封禁，每天流水净额落在当天", () => {
  const db = bankDatabase();
  const acc = addAccount(db, { lifecycle_status: "banned", active: 0 });
  addLedger(db, acc, 200, "2026-11-01");
  addLedger(db, acc, 0, "2026-11-04", { status: "bank trf", amount_out: 50 });
  assert.deepEqual(byDay(db, "2026-10-25", "2026-11-05"), { "2026-11-01": 20000, "2026-11-04": -5000 });
  assert.deepEqual(byDay(db, "2026-11-02", "2026-11-03"), {}, "区间内没流水就没有变化");
});

test("终态兜底：事件说封禁、但现在是运营中，在最后一个事件日补一次解封", () => {
  const db = bankDatabase();
  const acc = addAccount(db);
  addLedger(db, acc, 100, "2026-11-01");
  addAccountEvent(db, acc, "banned", evAt("2026-11-02"));
  assert.deepEqual(byDay(db, "2026-11-01", "2026-11-05"), {});
  assert.equal(stuckBalanceCents(db, "alpha", "2026-11-05"), 0);
});

test("公司隔离：别家的封禁户、别家指向本公司 id 的事件都不算", () => {
  const { db, acc } = setup();
  const other = addAccount(db, { company_id: "beta" });
  addLedger(db, acc, 100, "2026-11-01");
  addLedger(db, other, 900, "2026-11-01");
  ban(db, other, "2026-11-02");
  addAccountEvent(db, acc, "banned", evAt("2026-11-02"), { company_id: "beta" });
  assert.deepEqual(byDay(db, "2026-11-01", "2026-11-03"), {});
  assert.equal(Object.values(Object.fromEntries(blockedExpenseByDay(db, "beta", "2026-11-01", "2026-11-03")))[0], 90000);
});

test("UTC → 悉尼日界：AEDT 下 UTC 12:59:59 还是当天，13:00 已是第二天", () => {
  assert.equal(localDayOfUtc("2026-11-02 12:59:59"), "2026-11-02");
  assert.equal(localDayOfUtc("2026-11-02 13:00:00"), "2026-11-03");

  const { db, acc } = setup();
  addLedger(db, acc, 100, "2026-11-01");
  db.prepare("UPDATE bank_accounts SET lifecycle_status = 'banned' WHERE id = ?").run(acc);
  addAccountEvent(db, acc, "banned", "2026-11-02 13:00:00");
  assert.deepEqual(byDay(db, "2026-11-01", "2026-11-05"), { "2026-11-03": 10000 });
});

test("忽略每日归零：用累计余额", () => {
  const db = bankDatabase();
  const acc = addAccount(db, { reset_daily_balance: 1 });
  addLedger(db, acc, 700, "2026-11-01");
  ban(db, acc, "2026-11-03");
  assert.deepEqual(byDay(db, "2026-11-01", "2026-11-04"), { "2026-11-03": 70000 });
});

test("日报与月报逐日相等；年视图月行 = 当月合计；月报 WIN/LOSE 不变", () => {
  const { db, acc, live } = setup();
  const third = addAccount(db, { account_name: "THIRD" });
  addLedger(db, acc, 1000.1, "2026-11-01");
  addLedger(db, live, 250.25, "2026-11-02");
  addLedger(db, third, 80, "2026-11-01");
  addLedger(db, acc, 0, "2026-11-04", { status: "expenses", amount_out: 10 });
  ban(db, acc, "2026-11-03");
  ban(db, third, "2026-11-04");
  addLedger(db, acc, 0, "2026-11-06", { status: "bank trf", amount_out: 300.05 });
  addLedger(db, live, 300.05, "2026-11-06", { status: "bank transfer" });
  unban(db, third, "2026-11-08");

  const month = computeMonthlyReport(db, "alpha", { month: "2026-11", today: "2026-11-30" });
  for (const d of month.days) {
    const daily = computeBankDailyReport(db, "alpha", { date: d.date });
    assert.equal(d.blockedExpense, daily.totals.blocked_expense, d.date);
    const dailyCents = Math.round(-daily.reportRows.find((r) => r.key === "expenses").amount * 100) + 0; // +0 抹掉 -0
    assert.equal(Math.round(d.expenses * 100), dailyCents, d.date);
  }
  assert.equal(month.days.find((d) => d.date === "2026-11-03").blockedExpense, 1000.1);
  // 11-04：third 封禁 +80；同一天封禁户 acc 自己记了一笔 expenses 10，它的卡住余额随之 −10。
  // 那 10 已经在流水 EXPENSES 里，不重复计：合计 10 + (80 − 10) = 80。
  assert.equal(month.days.find((d) => d.date === "2026-11-04").blockedExpense, 70);
  assert.equal(month.days.find((d) => d.date === "2026-11-04").expenses, 80);
  assert.equal(month.days.find((d) => d.date === "2026-11-06").blockedExpense, -300.05);
  assert.equal(month.days.find((d) => d.date === "2026-11-08").blockedExpense, -80);
  assert.equal(month.total.blockedExpense, 690.05);
  assert.equal(month.total.winLose, month.total.dep - month.total.wd);

  const year = computeYearlyReport(db, "alpha", { year: "2026", today: "2026-11-30" });
  assert.equal(year.months[10].expenses, month.total.expenses);
  assert.equal(year.months[10].blockedExpense, month.total.blockedExpense);
});

test("恒等式：累计封禁 EXPENSES = 现在卡在封禁 / 归档非 PG 户里的钱", () => {
  const { db, acc, live } = setup();
  addLedger(db, acc, 640, "2026-09-10");
  addLedger(db, live, 90, "2026-09-11");
  ban(db, acc, "2026-09-20");
  addLedger(db, acc, 0, "2026-10-01", { status: "bank trf", amount_out: 140 });
  ban(db, live, "2026-10-05");
  const total = [...blockedExpenseByDay(db, "alpha", "2026-09-01", "2026-11-30").values()].reduce((s, v) => s + v, 0);
  const stuck = Math.round((balanceFromLedger(db, acc) + balanceFromLedger(db, live)) * 100);
  assert.equal(total, stuck);
  assert.equal(stuckBalanceCents(db, "alpha", "2026-11-30"), stuck);
});

test("整年区间也只有 4 条 SQL", () => {
  const { db, acc, live } = setup();
  for (let m = 1; m <= 12; m++) addLedger(db, acc, 10, `2026-${String(m).padStart(2, "0")}-15`);
  ban(db, acc, "2026-06-01");
  ban(db, live, "2026-07-01");
  let n = 0;
  const orig = db.prepare.bind(db);
  db.prepare = (sql) => {
    n++;
    return orig(sql);
  };
  blockedExpenseByDay(db, "alpha", "2026-01-01", "2026-12-31");
  assert.ok(n <= 4, `prepare ${n} 次`);
});
