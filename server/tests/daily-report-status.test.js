// 「支付渠道」日报 REPORT 的 STATUS 汇总口径（运营 Excel，2026-11-06 与用户逐项确认）：
//
//   GIVE BACK  单独一行，负数（和 WITHDRAW / WRONG / EXPENSES 一样）
//   DEPOSIT    = deposit + new，**不含 unclaim**；UNCLAIM 照旧单列
//   EXCHANGE   正数（Excel 记的就是换钱总额），刻意和其他出账类不同号
//   REDEP      只记笔数，金额不展示
//
// 演练里 4 个员工都把后两条报成了 bug——那是 Excel 的写法，别去「修平」。
const test = require("node:test");
const assert = require("node:assert");

const { computeBankDailyReport } = require("../lib/bankReport");
const { bankDatabase, addAccount, addLedger } = require("./bank-fixture");

const DAY = "2026-10-01";

const reportOf = (db) => computeBankDailyReport(db, "alpha", { date: DAY });
const rowOf = (report, key) => report.reportRows.find((r) => r.key === key);
const pairOf = (report, label) => {
  for (const p of report.reportPairs) {
    if (p.leftLabel === label) return { value: p.leftValue, metric: false };
    if (p.rightLabel === label) return { value: p.rightValue, metric: p.rightIsMetric !== false };
  }
  return undefined;
};

test("GIVE BACK 单独一行，显示为负数，页面成对表里也有", () => {
  const db = bankDatabase();
  const acc = addAccount(db);
  addLedger(db, acc, 0, DAY, { status: "give back", amount_out: 200 });
  addLedger(db, acc, 0, DAY, { status: "Give Back ", amount_out: -40 });

  const r = reportOf(db);
  assert.strictEqual(rowOf(r, "give back")?.amount, -240);
  assert.strictEqual(rowOf(r, "give back")?.count, 2);
  assert.deepStrictEqual(pairOf(r, "GIVE BACK"), { value: -240, metric: false });
});

test("没有 GIVE BACK 流水时那一行照样在，值为 0（列位固定）", () => {
  const db = bankDatabase();
  addAccount(db);
  const r = reportOf(db);
  assert.strictEqual(rowOf(r, "give back")?.amount, 0);
  assert.deepStrictEqual(pairOf(r, "GIVE BACK"), { value: 0, metric: false });
});

test("DEPOSIT = deposit + new，不含 unclaim；UNCLAIM 单列", () => {
  const db = bankDatabase();
  const acc = addAccount(db);
  addLedger(db, acc, 20, DAY, { status: "deposit" });
  addLedger(db, acc, 5, DAY, { status: "new" });
  addLedger(db, acc, 1030, DAY, { status: "unclaim" });

  const r = reportOf(db);
  assert.strictEqual(rowOf(r, "deposit").amount, 25);
  assert.strictEqual(rowOf(r, "deposit").count, 2);
  assert.strictEqual(pairOf(r, "DEPOSIT").value, 25);
  assert.strictEqual(pairOf(r, "UNCLAIM").value, 1030);
  assert.strictEqual(r.metrics.unclaim_amount, 1030);
  // WIN/LOSS = DEPOSIT + WITHDRAW，跟着不含 unclaim
  assert.strictEqual(r.totals.win_loss, 25);
});

test("EXCHANGE 保持正数（Excel 口径），REDEP 只记笔数", () => {
  const db = bankDatabase();
  const acc = addAccount(db);
  addLedger(db, acc, 0, DAY, { status: "exchange", amount_out: 1800 });
  addLedger(db, acc, 0, DAY, { status: "exchange", amount_out: -1200 });
  addLedger(db, 0, 0, DAY, { status: "redeposit", company_id: "alpha" });
  addLedger(db, acc, 100, DAY, { status: "redeposit" });

  const r = reportOf(db);
  assert.strictEqual(pairOf(r, "EXCHANGE").value, 3000);
  assert.deepStrictEqual(pairOf(r, "REDEP"), { value: 2, metric: true });
  // 手工录的 REDEPOSIT +100 不进 DEPOSIT
  assert.strictEqual(rowOf(r, "deposit").amount, 0);
});
