// 「支付渠道」日报 REPORT 的 STATUS 汇总口径（运营 Excel，2026-11-06 与用户逐项确认）：
//
//   GIVE BACK  单独一行，负数（和 WITHDRAW / WRONG / EXPENSES 一样）
//   DEPOSIT    = deposit + new + unclaim（2026-11-14 起含 unclaim）；UNCLAIM 照旧单列当明细
//   EXCHANGE   正数（Excel 记的就是换钱总额），刻意和其他出账类不同号
//   REDEP      只记笔数，金额不展示
//
// 演练里 4 个员工都把后两条报成了 bug——那是 Excel 的写法，别去「修平」。
const test = require("node:test");
const assert = require("node:assert");

const { computeBankDailyReport } = require("../lib/bankReport");
const { bankDatabase, addAccount, addLedger, addAccountEvent } = require("./bank-fixture");

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

test("DEPOSIT = deposit + new + unclaim；UNCLAIM 照旧单列（明细，已含在 DEPOSIT 里）", () => {
  // 2026-11-14 用户定：unclaim 认领时会被删掉再审批成 deposit，同一笔钱只有一行，算进来不会重复。
  const db = bankDatabase();
  const acc = addAccount(db);
  addLedger(db, acc, 20, DAY, { status: "deposit" });
  addLedger(db, acc, 5, DAY, { status: "new" });
  addLedger(db, acc, 1030, DAY, { status: "unclaim" });

  const r = reportOf(db);
  assert.strictEqual(rowOf(r, "deposit").amount, 1055);
  assert.strictEqual(rowOf(r, "deposit").count, 3);
  assert.strictEqual(pairOf(r, "DEPOSIT").value, 1055);
  assert.strictEqual(pairOf(r, "UNCLAIM").value, 1030);
  assert.strictEqual(r.metrics.unclaim_amount, 1030);
  // WIN/LOSS = DEPOSIT + WITHDRAW，跟着含 unclaim
  assert.strictEqual(r.totals.win_loss, 1055);
});

test("DEP COUNT 含 unclaim；TRANSACTION 照旧也数 unclaim", () => {
  const db = bankDatabase();
  const acc = addAccount(db);
  addLedger(db, acc, 100, DAY, { status: "deposit", username: "u1" });
  addLedger(db, acc, 50, DAY, { status: "amopay", username: "u2" });
  addLedger(db, acc, 300, DAY, { status: "unclaim" });
  addLedger(db, acc, 0, DAY, { status: "unclaim" }); // 金额 0 不计 DEP COUNT

  const r = reportOf(db);
  assert.strictEqual(pairOf(r, "DEP COUNT").value, 3);
  assert.strictEqual(r.metrics.dep_count, 3);
  assert.strictEqual(pairOf(r, "TRANSACTION").value, 2);
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

test("TRANSACTION = 充值（deposit / amopay）与提现以外的所有流水笔数，带不带 USERNAME 都算", () => {
  // 2026-11-10 按运营 Excel 确认：Excel 当天 TRANSACTION 22、DEP COUNT 38，TRANSACTION 不含充值提现。
  const db = bankDatabase();
  const acc = addAccount(db);
  addLedger(db, acc, 100, DAY, { status: "deposit", username: "u1" });
  addLedger(db, acc, 50, DAY, { status: "amopay", username: "u2" });
  addLedger(db, acc, 0, DAY, { status: "withdraw", amount_out: 30, username: "u1" });
  addLedger(db, acc, 0, DAY, { status: "cash out", amount_out: 200 }); // 没 USERNAME 也算
  addLedger(db, acc, 0, DAY, { status: "wrong", amount_out: 20, username: "u3" });
  addLedger(db, acc, 0, DAY, { status: "exchange", amount_out: 537 });
  addLedger(db, acc, 5, DAY, { status: "new", username: "u4" });

  const r = reportOf(db);
  assert.deepStrictEqual(pairOf(r, "TRANSACTION"), { value: 4, metric: true });
  assert.strictEqual(rowOf(r, "transaction").amount, 4);
  assert.strictEqual(r.metrics.transaction_count, 4);
  assert.strictEqual(pairOf(r, "DEP COUNT").value, 2);
  assert.strictEqual(pairOf(r, "W/D COUNT").value, 1);
  // UNIQUE CUST 仍按 USERNAME 去重，不受 TRANSACTION 口径影响
  assert.strictEqual(pairOf(r, "UNIQUE CUST").value, 4);
});

test("EXPENSES 含封禁户当天卡住的余额：金额并入、笔数不变、WIN/LOSE 不变", () => {
  const db = bankDatabase();
  const acc = addAccount(db, { lifecycle_status: "banned", active: 0 });
  addAccountEvent(db, acc, "banned", "2026-09-30 23:00:00"); // 悉尼 2026-10-01 上午
  addLedger(db, acc, 500, "2026-09-20", { status: "deposit" });
  addLedger(db, acc, 0, DAY, { status: "expenses", amount_out: 20 });

  const report = reportOf(db);
  assert.strictEqual(rowOf(report, "expenses").amount, -500);
  assert.strictEqual(rowOf(report, "expenses").count, 1);
  assert.strictEqual(pairOf(report, "EXPENSES").value, -500);
  assert.strictEqual(report.totals.blocked_expense, 480);
  assert.strictEqual(report.totals.win_loss, 0);
});
