// 月报（MONTHLY REPORT › REPORT）口径。每条定义见仓库根目录 CONTEXT.md「月报」一节。
const test = require("node:test");
const assert = require("node:assert/strict");
const { bankDatabase, addAccount, addLedger, addAccountEvent } = require("./bank-fixture");
const { computeMonthlyReport, computeYearlyReport } = require("../lib/monthlyReport");
const { computeBankDailyReport } = require("../lib/bankReport");

function setup() {
  const db = bankDatabase();
  const acc = addAccount(db);
  return { db, acc };
}

function day(report, date) {
  return report.days.find((d) => d.date === date);
}

test("DEP = deposit + new + amopay（含 trf_amount），unclaim 单列不进 DEP", () => {
  const { db, acc } = setup();
  addLedger(db, acc, 100, "2026-11-03", { status: "deposit" });
  addLedger(db, acc, 50, "2026-11-03", { status: "new" });
  addLedger(db, acc, 30, "2026-11-03", { status: "amopay" });
  addLedger(db, 0, 0, "2026-11-03", { status: "deposit", trf_amount: 20, company_id: "alpha" });
  addLedger(db, acc, 999, "2026-11-03", { status: "unclaim" });
  addLedger(db, acc, 77, "2026-11-03", { status: "cash in" });

  const d = day(computeMonthlyReport(db, "alpha", { month: "2026-11", today: "2026-11-04" }), "2026-11-03");
  assert.equal(d.dep, 200);
  assert.equal(d.unclaim, 999);
  assert.equal(d.depCount, 4);
});

test("WD / WRONG / EXPENSES 为正数，含 HELP TRF 的 help_amount", () => {
  const { db, acc } = setup();
  addLedger(db, acc, 0, "2026-11-03", { status: "withdraw", amount_out: -300 });
  addLedger(db, 0, 0, "2026-11-03", { status: "withdraw", help_amount: 40, company_id: "alpha" });
  addLedger(db, acc, 0, "2026-11-03", { status: "wrong", amount_out: 25 });
  addLedger(db, acc, 0, "2026-11-03", { status: "expenses", amount_out: -15 });
  addLedger(db, acc, 0, "2026-11-03", { status: "cash out", amount_out: 500 });

  const d = day(computeMonthlyReport(db, "alpha", { month: "2026-11", today: "2026-11-04" }), "2026-11-03");
  assert.equal(d.wd, 340);
  assert.equal(d.wrong, 25);
  assert.equal(d.expenses, 15);
  assert.equal(d.wdCount, 2);
});

test("WIN/LOSE = DEP − WD，不扣 WRONG / EXPENSES；WIN RATE = WIN/LOSE ÷ DEP", () => {
  const { db, acc } = setup();
  addLedger(db, acc, 1000, "2026-11-03", { status: "deposit" });
  addLedger(db, acc, 0, "2026-11-03", { status: "withdraw", amount_out: 1250 });
  addLedger(db, acc, 0, "2026-11-03", { status: "expenses", amount_out: 100 });

  const d = day(computeMonthlyReport(db, "alpha", { month: "2026-11", today: "2026-11-04" }), "2026-11-03");
  assert.equal(d.winLose, -250);
  assert.equal(d.winRate, -0.25);
});

test("DEP = 0 的日子 WIN RATE 为 null（前端显示「—」），WIN/LOSE 照算", () => {
  const { db, acc } = setup();
  addLedger(db, acc, 0, "2026-11-03", { status: "withdraw", amount_out: 80 });

  const report = computeMonthlyReport(db, "alpha", { month: "2026-11", today: "2026-11-04" });
  assert.equal(day(report, "2026-11-03").winLose, -80);
  assert.equal(day(report, "2026-11-03").winRate, null);
  assert.equal(day(report, "2026-11-01").winRate, null);
});

test("单数：金额为 0 的行不计；总单 = DEP单 + WD单", () => {
  const { db, acc } = setup();
  addLedger(db, acc, 10, "2026-11-03", { status: "deposit" });
  addLedger(db, acc, 0, "2026-11-03", { status: "deposit" });
  addLedger(db, acc, 0, "2026-11-03", { status: "withdraw", amount_out: 5 });
  addLedger(db, acc, 0, "2026-11-03", { status: "withdraw" });

  const d = day(computeMonthlyReport(db, "alpha", { month: "2026-11", today: "2026-11-04" }), "2026-11-03");
  assert.equal(d.depCount, 1);
  assert.equal(d.wdCount, 1);
  assert.equal(d.totalCount, 2);
});

test("UNIQUE CUST 只数当天充值的不同 username，只提现的人不算；合计行每日相加", () => {
  const { db, acc } = setup();
  addLedger(db, acc, 10, "2026-11-03", { status: "deposit", username: "amy" });
  addLedger(db, acc, 20, "2026-11-03", { status: "new", username: " amy " });
  addLedger(db, acc, 30, "2026-11-03", { status: "deposit", username: "bob" });
  addLedger(db, acc, 0, "2026-11-03", { status: "withdraw", amount_out: 5, username: "carl" });
  addLedger(db, acc, 40, "2026-11-04", { status: "deposit", username: "amy" });

  const report = computeMonthlyReport(db, "alpha", { month: "2026-11", today: "2026-11-04" });
  assert.equal(day(report, "2026-11-03").uniqueCust, 2);
  assert.equal(day(report, "2026-11-04").uniqueCust, 1);
  assert.equal(report.total.uniqueCust, 3);
});

test("每月每天都有一行，未来日期标 future", () => {
  const { db } = setup();
  const nov = computeMonthlyReport(db, "alpha", { month: "2026-11", today: "2026-11-04" });
  assert.equal(nov.days.length, 30);
  assert.equal(nov.days[0].date, "2026-11-01");
  assert.equal(nov.days[29].date, "2026-11-30");
  assert.equal(day(nov, "2026-11-04").future, false);
  assert.equal(day(nov, "2026-11-05").future, true);
  assert.equal(day(nov, "2026-11-05").dep, 0);

  assert.equal(computeMonthlyReport(db, "alpha", { month: "2028-02", today: "2026-11-04" }).days.length, 29);
});

test("月界：月末 23:59:59 算本月，下月 1 日不算", () => {
  const { db, acc } = setup();
  db.prepare(
    "INSERT INTO bank_ledger (bank_account_id, company_id, entry_time, status, amount_in) VALUES (?, 'alpha', ?, 'deposit', ?)"
  ).run(acc, "2026-10-31 23:59:59", 7);
  db.prepare(
    "INSERT INTO bank_ledger (bank_account_id, company_id, entry_time, status, amount_in) VALUES (?, 'alpha', ?, 'deposit', ?)"
  ).run(acc, "2026-11-01 00:00:00", 9);

  const oct = computeMonthlyReport(db, "alpha", { month: "2026-10", today: "2026-11-04" });
  assert.equal(oct.total.dep, 7);
  assert.equal(day(oct, "2026-10-31").dep, 7);
});

test("公司隔离：别家流水不进本公司月报", () => {
  const { db, acc } = setup();
  const other = addAccount(db, { company_id: "beta" });
  addLedger(db, acc, 10, "2026-11-03", { status: "deposit" });
  addLedger(db, other, 500, "2026-11-03", { status: "deposit" });

  assert.equal(computeMonthlyReport(db, "alpha", { month: "2026-11", today: "2026-11-04" }).total.dep, 10);
});

test("status 大小写与空白不影响归类", () => {
  const { db, acc } = setup();
  addLedger(db, acc, 10, "2026-11-03", { status: "  Deposit " });
  addLedger(db, acc, 0, "2026-11-03", { status: "WITHDRAW", amount_out: 4 });

  const d = day(computeMonthlyReport(db, "alpha", { month: "2026-11", today: "2026-11-04" }), "2026-11-03");
  assert.equal(d.dep, 10);
  assert.equal(d.wd, 4);
});

test("合计行：各列每日相加，WIN RATE 用合计相除而不是每日平均", () => {
  const { db, acc } = setup();
  addLedger(db, acc, 100, "2026-11-01", { status: "deposit" });
  addLedger(db, acc, 0, "2026-11-01", { status: "withdraw", amount_out: 50 }); // 当日 50%
  addLedger(db, acc, 900, "2026-11-02", { status: "deposit" });
  addLedger(db, acc, 0, "2026-11-02", { status: "withdraw", amount_out: 900 }); // 当日 0%
  addLedger(db, acc, 0.1, "2026-11-03", { status: "deposit" });
  addLedger(db, acc, 0.2, "2026-11-03", { status: "deposit" });

  const { total } = computeMonthlyReport(db, "alpha", { month: "2026-11", today: "2026-11-04" });
  assert.equal(total.dep, 1000.3);
  assert.equal(total.wd, 950);
  assert.equal(total.winLose, 50.3);
  assert.ok(Math.abs(total.winRate - 50.3 / 1000.3) < 1e-12, `winRate ${total.winRate}`);
  assert.equal(total.depCount, 4);
  assert.equal(total.totalCount, 6);
});

test("非法月份参数回落到当月", () => {
  const { db } = setup();
  assert.equal(computeMonthlyReport(db, "alpha", { month: "2026-13", today: "2026-11-04" }).month, "2026-11");
  assert.equal(computeMonthlyReport(db, "alpha", { month: "x", today: "2026-11-04" }).month, "2026-11");
});

test("年视图：12 行每月一行，月行 = 当月合计，末行年合计", () => {
  const { db, acc } = setup();
  addLedger(db, acc, 100, "2026-02-10", { status: "deposit", username: "amy" });
  addLedger(db, acc, 100, "2026-02-11", { status: "deposit", username: "amy" });
  addLedger(db, acc, 0, "2026-02-11", { status: "withdraw", amount_out: 60 });
  addLedger(db, acc, 300, "2026-11-03", { status: "deposit", username: "amy" });
  addLedger(db, acc, 5, "2025-12-31", { status: "deposit" });

  const year = computeYearlyReport(db, "alpha", { year: "2026", today: "2026-11-04" });
  assert.equal(year.months.length, 12);
  const feb = year.months[1];
  assert.equal(feb.month, "2026-02");
  assert.equal(feb.dep, 200);
  assert.equal(feb.winLose, 140);
  assert.equal(feb.uniqueCust, 2);
  assert.equal(year.months[11].future, true);
  assert.equal(year.months[10].future, false);
  assert.equal(year.total.dep, 500);
  assert.equal(year.total.uniqueCust, 3);
  assert.equal(year.total.winRate, 440 / 500);

  const feb2026 = computeMonthlyReport(db, "alpha", { month: "2026-02", today: "2026-11-04" }).total;
  assert.deepEqual({ ...feb, month: undefined, future: undefined }, { ...feb2026, month: undefined, future: undefined });
});

test("EXCHANGE = status exchange 的入 + 出（正数），与日报 REPORT 的 EXCHANGE 逐分相等；不影响其他列", () => {
  const { db, acc } = setup();
  addLedger(db, acc, 0, "2026-11-03", { status: "exchange", amount_out: 1000 });
  addLedger(db, acc, 0, "2026-11-03", { status: " Exchange ", amount_out: -800.1 });
  addLedger(db, acc, 0, "2026-11-03", { status: "exchange", amount_out: 50, c_status: "EZ68" });
  addLedger(db, acc, 100, "2026-11-03", { status: "deposit" });

  const report = computeMonthlyReport(db, "alpha", { month: "2026-11", today: "2026-11-04" });
  const d = day(report, "2026-11-03");
  assert.equal(d.exchange, 1850.1);
  const daily = computeBankDailyReport(db, "alpha", { date: "2026-11-03" }).reportRows.find((r) => r.key === "exchange");
  assert.equal(d.exchange, daily.amount);
  assert.equal(d.dep, 100);
  assert.equal(d.wd, 0);
  assert.equal(d.expenses, 0);
  assert.equal(d.winLose, 100);
  assert.equal(day(report, "2026-11-04").exchange, 0);
  assert.equal(report.total.exchange, 1850.1);
});

test("EXCHANGE：公司隔离，年视图月行 = 当月合计", () => {
  const { db, acc } = setup();
  const other = addAccount(db, { company_id: "beta" });
  addLedger(db, acc, 0, "2026-02-10", { status: "exchange", amount_out: 0.1 });
  addLedger(db, acc, 0, "2026-02-11", { status: "exchange", amount_out: 0.2 });
  addLedger(db, acc, 0, "2026-11-03", { status: "exchange", amount_out: 5 });
  addLedger(db, other, 0, "2026-11-03", { status: "exchange", amount_out: 999 });

  const year = computeYearlyReport(db, "alpha", { year: "2026", today: "2026-11-04" });
  assert.equal(year.months[1].exchange, 0.3);
  assert.equal(year.months[10].exchange, 5);
  assert.equal(year.total.exchange, 5.3);
});

test("EXPENSES 含封禁户余额（正数），WIN/LOSE 不扣", () => {
  const { db, acc } = setup();
  addLedger(db, acc, 1000, "2026-11-01", { status: "deposit" });
  db.prepare("UPDATE bank_accounts SET lifecycle_status = 'banned' WHERE id = ?").run(acc);
  addAccountEvent(db, acc, "banned", "2026-11-03 01:00:00");

  const report = computeMonthlyReport(db, "alpha", { month: "2026-11", today: "2026-11-04" });
  assert.equal(day(report, "2026-11-03").expenses, 1000);
  assert.equal(day(report, "2026-11-03").blockedExpense, 1000);
  assert.equal(day(report, "2026-11-03").winLose, 0);
  assert.equal(report.total.winLose, 1000);
});
