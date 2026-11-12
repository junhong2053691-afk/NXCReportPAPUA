// 往来账（MONTHLY REPORT › COMPANY EXPENSES）口径。每条定义见仓库根目录 CONTEXT.md「往来账」一节。
const test = require("node:test");
const assert = require("node:assert/strict");
const { bankDatabase, addAccount, addLedger, addCStatusOption } = require("./bank-fixture");
const { computeCompanyExpenses, computeCompanyExpensesYear } = require("../lib/companyExpenses");
const { computeBankDailyReport } = require("../lib/bankReport");

function setup(options = ["EZ68", "PK7", "RX66", "LH"]) {
  const db = bankDatabase();
  const acc = addAccount(db);
  options.forEach((name, i) => addCStatusOption(db, "alpha", name, "", { sort_order: i + 1 }));
  return { db, acc };
}

const NOV = { month: "2026-11", today: "2026-11-04" };

/** 某一天某个往来方的 NET。 */
function cell(report, date, name) {
  const col = report.columns.indexOf(name);
  assert.ok(col >= 0, `没有 ${name} 列：${report.columns.join(",")}`);
  return report.days.find((d) => d.date === date).nets[col];
}

test("NET = IN − OUT：我方收到对方的钱为正（我方欠对方），付给对方为负", () => {
  const { db, acc } = setup();
  addLedger(db, acc, 300, "2026-11-03", { status: "cash in", c_status: "EZ68" });
  addLedger(db, acc, 0, "2026-11-03", { status: "cash out", amount_out: -120, c_status: "EZ68" });
  addLedger(db, acc, 0, "2026-11-03", { status: "cash out", amount_out: 50, c_status: "PK7" });

  const report = computeCompanyExpenses(db, "alpha", NOV);
  assert.equal(cell(report, "2026-11-03", "EZ68"), 180);
  assert.equal(cell(report, "2026-11-03", "PK7"), -50);
  assert.equal(cell(report, "2026-11-03", "RX66"), 0);
});

test("HELP TRF 与余额方向对调：对方替我付（help）记 IN，对方替我收（trf）记 OUT；不看 status", () => {
  const { db, acc } = setup();
  addLedger(db, 0, 0, "2026-11-03", { status: "withdraw", help_amount: 40, c_status: "RX66", company_id: "alpha" });
  addLedger(db, 0, 0, "2026-11-03", { status: "bank transfer", trf_amount: 25, c_status: "LH", company_id: "alpha" });
  addLedger(db, acc, 0, "2026-11-03", { status: "expenses", amount_out: 7, c_status: "LH" });
  addLedger(db, acc, 999, "2026-11-03", { status: "deposit" }); // 没有 c_status 的流水不进来

  const report = computeCompanyExpenses(db, "alpha", NOV);
  assert.equal(cell(report, "2026-11-03", "RX66"), 40);
  assert.equal(cell(report, "2026-11-03", "LH"), -32);
  assert.deepEqual(report.total, [0, 0, 40, -32]);
});

test("任意一天的每一格 = 「支付渠道」日报 C STATUS 表（companyRows）同一格", () => {
  const { db, acc } = setup();
  addLedger(db, acc, 300.1, "2026-11-03", { status: "cash in", c_status: "EZ68" });
  addLedger(db, acc, 0, "2026-11-03", { status: "cash out", amount_out: -120.2, c_status: "EZ68" });
  addLedger(db, 0, 0, "2026-11-03", { status: "withdraw", help_amount: 40, c_status: "RX66", company_id: "alpha" });
  addLedger(db, 0, 0, "2026-11-03", { status: "cash in", trf_amount: 25, c_status: "LH", company_id: "alpha" });
  addLedger(db, acc, 0, "2026-11-03", { status: "wrong", amount_out: 3, c_status: "ZZ9" }); // 不在选项里的名字

  const report = computeCompanyExpenses(db, "alpha", NOV);
  const daily = computeBankDailyReport(db, "alpha", { date: "2026-11-03" });
  assert.deepEqual(report.columns, daily.companyRows.map((r) => r.name));
  daily.companyRows.forEach((r) => {
    assert.equal(cell(report, "2026-11-03", r.name), Math.round(r.total * 100) / 100, r.name);
  });
});

test("一个 C STATUS 选项都没有时，列回退到与日报相同的默认名单", () => {
  const { db, acc } = setup([]);
  addLedger(db, acc, 10, "2026-11-03", { status: "cash in", c_status: "ZZ9" });

  const report = computeCompanyExpenses(db, "alpha", NOV);
  const daily = computeBankDailyReport(db, "alpha", { date: "2026-11-03" });
  assert.deepEqual(report.columns, daily.companyRows.map((r) => r.name));
  assert.deepEqual(report.columns, ["EZ68", "PK7", "RX66", "AuX6", "LH", "ZZ9"]);
});

test("列完全照本公司的 C STATUS 选项：整月为 0、指向本公司自己的选项都照样显示；别家的选项不进来", () => {
  const db = bankDatabase();
  addAccount(db);
  addCStatusOption(db, "alpha", "EZ68", "beta", { sort_order: 1 });
  addCStatusOption(db, "alpha", "AuX6", "alpha", { sort_order: 2 });
  addCStatusOption(db, "alpha", "LH", "", { sort_order: 3 });
  addCStatusOption(db, "beta", "XX", "", { sort_order: 1 });

  const report = computeCompanyExpenses(db, "alpha", NOV);
  assert.deepEqual(report.columns, ["EZ68", "AuX6", "LH"]);
  assert.deepEqual(report.columns, computeBankDailyReport(db, "alpha", { date: "2026-11-03" }).companyRows.map((r) => r.name));
});

test("每月每天一行（没数据为 0），未来日期标 future；月末 23:59:59 算本月，下月 1 日不算", () => {
  const { db, acc } = setup();
  db.prepare(
    "INSERT INTO bank_ledger (bank_account_id, company_id, entry_time, status, amount_in, c_status) VALUES (?, 'alpha', ?, 'cash in', ?, 'EZ68')"
  ).run(acc, "2026-10-31 23:59:59", 7);
  db.prepare(
    "INSERT INTO bank_ledger (bank_account_id, company_id, entry_time, status, amount_in, c_status) VALUES (?, 'alpha', ?, 'cash in', ?, 'EZ68')"
  ).run(acc, "2026-11-01 00:00:00", 9);

  const nov = computeCompanyExpenses(db, "alpha", NOV);
  assert.equal(nov.days.length, 30);
  assert.equal(nov.days[0].date, "2026-11-01");
  assert.equal(nov.days[29].date, "2026-11-30");
  assert.equal(nov.days[3].future, false);
  assert.equal(nov.days[4].future, true);
  assert.deepEqual(nov.days[4].nets, [0, 0, 0, 0]);
  assert.deepEqual(nov.total, [9, 0, 0, 0]);

  const oct = computeCompanyExpenses(db, "alpha", { month: "2026-10", today: "2026-11-04" });
  assert.equal(cell(oct, "2026-10-31", "EZ68"), 7);
  assert.deepEqual(oct.total, [7, 0, 0, 0]);
});

test("公司隔离、c_status 前后空白归同一列、合计按分累加无浮点残差", () => {
  const { db, acc } = setup();
  const other = addAccount(db, { company_id: "beta" });
  addLedger(db, acc, 0.1, "2026-11-01", { status: "cash in", c_status: "EZ68" });
  addLedger(db, acc, 0.2, "2026-11-02", { status: "cash in", c_status: " EZ68 " });
  addLedger(db, acc, 0, "2026-11-02", { status: "cash in", c_status: "   " });
  addLedger(db, other, 500, "2026-11-02", { status: "cash in", c_status: "EZ68" });

  const report = computeCompanyExpenses(db, "alpha", NOV);
  assert.deepEqual(report.columns, ["EZ68", "PK7", "RX66", "LH"]);
  assert.equal(cell(report, "2026-11-02", "EZ68"), 0.2);
  assert.deepEqual(report.total, [0.3, 0, 0, 0]);
});

/** 日报 REPORT 里某天的 EXCHANGE 金额。 */
function dailyExchange(db, date) {
  return computeBankDailyReport(db, "alpha", { date }).reportRows.find((r) => r.key === "exchange").amount;
}

test("EXCHANGE 列：status = exchange 的流水按日报 REPORT 口径记正数，不看 C STATUS，不进 columns", () => {
  const { db, acc } = setup();
  addLedger(db, acc, 0, "2026-11-03", { status: "exchange", amount_out: 1000 });
  addLedger(db, acc, 0, "2026-11-03", { status: " Exchange ", amount_out: -800.1 });
  addLedger(db, acc, 0, "2026-11-03", { status: "exchange", amount_out: 50, c_status: "EZ68" });
  addLedger(db, acc, 0, "2026-11-03", { status: "cash out", amount_out: 7, c_status: "EZ68" });

  const report = computeCompanyExpenses(db, "alpha", NOV);
  assert.deepEqual(report.columns, ["EZ68", "PK7", "RX66", "LH"]);
  const day = report.days.find((d) => d.date === "2026-11-03");
  assert.equal(day.exchange, 1850.1);
  assert.equal(day.exchange, dailyExchange(db, "2026-11-03"));
  // 填了 C STATUS 的 exchange 照常进往来方列（往来账口径不变）
  assert.equal(cell(report, "2026-11-03", "EZ68"), -57);
  assert.equal(report.days.find((d) => d.date === "2026-11-04").exchange, 0);
  assert.equal(report.exchange_total, 1850.1);
});

test("EXCHANGE 列：公司隔离，年视图月行 = 当月合计", () => {
  const { db, acc } = setup();
  const other = addAccount(db, { company_id: "beta" });
  addLedger(db, acc, 0, "2026-02-10", { status: "exchange", amount_out: 0.1 });
  addLedger(db, acc, 0, "2026-02-11", { status: "exchange", amount_out: 0.2 });
  addLedger(db, acc, 0, "2026-11-03", { status: "exchange", amount_out: 5 });
  addLedger(db, other, 0, "2026-11-03", { status: "exchange", amount_out: 999 });
  addLedger(db, acc, 0, "2025-12-31", { status: "exchange", amount_out: 999 });

  const year = computeCompanyExpensesYear(db, "alpha", { year: "2026", today: "2026-11-04" });
  assert.equal(year.months[1].exchange, 0.3);
  assert.equal(year.months[10].exchange, 5);
  assert.equal(year.months[0].exchange, 0);
  assert.equal(year.exchange_total, 5.3);
  assert.equal(computeCompanyExpenses(db, "alpha", NOV).exchange_total, 5);
});

test("非法月份参数回落到当月", () => {
  const { db } = setup();
  assert.equal(computeCompanyExpenses(db, "alpha", { month: "2026-13", today: "2026-11-04" }).month, "2026-11");
  assert.equal(computeCompanyExpenses(db, "alpha", { month: "x", today: "2026-11-04" }).month, "2026-11");
});

test("年视图：12 行每月一行，月行 = 当月合计，末行年合计，列规则同月视图", () => {
  const db = bankDatabase();
  const acc = addAccount(db);
  addCStatusOption(db, "alpha", "EZ68", "beta", { sort_order: 1 });
  addCStatusOption(db, "alpha", "AuX6", "alpha", { sort_order: 2 });
  addLedger(db, acc, 100, "2026-02-10", { status: "cash in", c_status: "EZ68" });
  addLedger(db, acc, 0, "2026-02-11", { status: "cash out", amount_out: 30, c_status: "EZ68" });
  addLedger(db, acc, 5, "2026-11-03", { status: "cash in", c_status: "ZZ9" });
  addLedger(db, acc, 999, "2025-12-31", { status: "cash in", c_status: "EZ68" });

  const year = computeCompanyExpensesYear(db, "alpha", { year: "2026", today: "2026-11-04" });
  assert.equal(year.year, "2026");
  assert.deepEqual(year.columns, ["EZ68", "AuX6", "ZZ9"]);
  assert.equal(year.months.length, 12);
  assert.equal(year.months[1].month, "2026-02");
  assert.deepEqual(year.months[1].nets, [70, 0, 0]);
  assert.equal(year.months[10].future, false);
  assert.equal(year.months[11].future, true);
  assert.deepEqual(year.total, [70, 0, 5]);

  const feb = computeCompanyExpenses(db, "alpha", { month: "2026-02", today: "2026-11-04" });
  assert.deepEqual(feb.total, [70, 0]);
  assert.equal(computeCompanyExpensesYear(db, "alpha", { year: "abc", today: "2026-11-04" }).year, "2026");
});
