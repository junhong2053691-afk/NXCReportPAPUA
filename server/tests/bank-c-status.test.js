// C STATUS 表的方向口径。
//
// 这张表记的是「我方相对这家对方公司的净收支」，不是资金流向——这是它和银行余额
// （bankReport 的 NET_EXPR）唯一的、也是最容易被"顺手改回去"的分歧点：
//
//   走我方账户的钱（IN / OUT 列）    → 按实际方向记
//   走对方账户的钱（HELP TRF 列）    → 方向相反
//
// 对方替我付出（help_amount）＝我欠对方 → 记 IN；对方替我收款（trf_amount）＝对方
// 欠我 → 记 OUT。所以在 cStatusTotalsForCompany 和 companyMap 两处，help/trf 与
// NET_EXPR 是**对调**的。下面「HELP TRF 记 IN」和「余额仍按资金流向」两组断言就是
// 守着这个对调的，别为了让两处"看起来一致"把它改平。
const test = require("node:test");
const assert = require("node:assert");

const { computeBankDailyReport, balanceFromLedger } = require("../lib/bankReport");
const { bankDatabase, addCompany, addAccount, addLedger, addCStatusOption } = require("./bank-fixture");

const DAY = "2026-10-01";

function reportOf(db, companyId = "alpha") {
  return computeBankDailyReport(db, companyId, { date: DAY });
}
function cRow(report, name) {
  return report.companyRows.find((r) => r.name === name);
}
function amountOf(report, key) {
  return report.reportRows.find((r) => r.key === key)?.amount ?? 0;
}
const round2 = (n) => Math.round(n * 100) / 100;

test("HELP TRF 记 IN：对方替我付客户，是我欠对方，不是我付出", () => {
  const db = bankDatabase();
  addCompany(db);
  const acc = addAccount(db);
  // 我方 Ubank 替 RX66 付 114.60 —— 走我方账户，照实际方向记 OUT。
  addLedger(db, acc, 0, DAY, { status: "cash out", amount_out: 114.6, c_status: "RX66" });
  // RX66 替我付客户 150.14 —— 不走我方账户，方向相反，记 IN。
  addLedger(db, 0, 0, DAY, { status: "withdraw", help_amount: 150.14, c_status: "RX66", company_id: "alpha" });

  const row = cRow(reportOf(db), "RX66");
  assert.strictEqual(round2(row.in), 150.14);
  assert.strictEqual(round2(row.out), -114.6);
  // 净 +35.54 = 我还净欠 RX66 这么多。方向写反会得到 -264.74。
  assert.strictEqual(round2(row.total), 35.54);
});

test("trf_amount 记 OUT：对方替我收款，是对方欠我", () => {
  const db = bankDatabase();
  addCompany(db);
  addLedger(db, 0, 0, DAY, { status: "cash in", trf_amount: 200, c_status: "RX66", company_id: "alpha" });

  const row = cRow(reportOf(db), "RX66");
  assert.strictEqual(round2(row.out), -200);
  assert.strictEqual(round2(row.in), 0);
});

test("BANK ACC 填不填不改变 C STATUS 的方向，只影响余额", () => {
  const db = bankDatabase();
  addCompany(db);
  const acc = addAccount(db);
  addLedger(db, acc, 0, DAY, { status: "withdraw", help_amount: 150.14, c_status: "RX66" });

  assert.strictEqual(round2(cRow(reportOf(db), "RX66").in), 150.14);
  // 余额是纯资金流向：help 照扣，与上面的方向无关。两套口径各自独立。
  assert.strictEqual(round2(balanceFromLedger(db, acc)), -150.14);
});

test("余额仍按资金流向：help 扣、trf 加，不跟着 C STATUS 翻转", () => {
  const db = bankDatabase();
  addCompany(db);
  const acc = addAccount(db);
  addLedger(db, acc, 0, DAY, { status: "bank trf", help_amount: 300, c_status: "LH" });
  addLedger(db, acc, 0, DAY, { status: "bank transfer", trf_amount: 500, c_status: "LH" });

  assert.strictEqual(round2(balanceFromLedger(db, acc)), 200);
  const row = cRow(reportOf(db), "LH");
  assert.strictEqual(round2(row.in), 300);
  assert.strictEqual(round2(row.out), -500);
});

test("REPORT 的 WITHDRAW 含 HELP TRF —— 和 Excel 的合计口径一致", () => {
  const db = bankDatabase();
  addCompany(db);
  const acc = addAccount(db);
  addLedger(db, acc, 0, DAY, { status: "withdraw", amount_out: 25 });
  addLedger(db, 0, 0, DAY, { status: "withdraw", help_amount: 366, c_status: "LH", company_id: "alpha" });

  const r = reportOf(db);
  assert.strictEqual(round2(amountOf(r, "withdraw")), -391);
  // 笔数同样要算上 HELP TRF，否则 W/D COUNT 和金额对不上。
  assert.strictEqual(r.metrics.wd_count, 2);
});

test("REPORT 的 CASH OUT 含 HELP TRF", () => {
  const db = bankDatabase();
  addCompany(db);
  addLedger(db, 0, 0, DAY, { status: "cash out", help_amount: 80, c_status: "RX66", company_id: "alpha" });

  assert.strictEqual(round2(amountOf(reportOf(db), "cash out")), -80);
});

test("跨公司对平：双方同口径翻转后差额仍然是 0", () => {
  const db = bankDatabase();
  addCompany(db, { id: "alpha", name: "AussieX6" });
  addCompany(db, { id: "beta", name: "Rolex66" });
  const a = addAccount(db, { company_id: "alpha" });
  const b = addAccount(db, { company_id: "beta" });
  addCStatusOption(db, "alpha", "RX66", "beta");
  addCStatusOption(db, "beta", "AX6", "alpha");

  // 同两笔往来，两家各自从自己的视角记账。
  addLedger(db, a, 0, DAY, { status: "cash out", amount_out: 114.6, c_status: "RX66" });
  addLedger(db, 0, 0, DAY, { status: "withdraw", help_amount: 150.14, c_status: "RX66", company_id: "alpha" });
  addLedger(db, b, 0, DAY, { status: "withdraw", amount_out: 150.14, c_status: "AX6" });
  addLedger(db, b, 114.6, DAY, { status: "cash in", c_status: "AX6" });

  assert.strictEqual(round2(cRow(reportOf(db, "alpha"), "RX66").total), 35.54);
  assert.strictEqual(round2(cRow(reportOf(db, "beta"), "AX6").total), -35.54);
  // 相加为 0 才不报未对平。翻转只要两边同步，这个判据就不受影响。
  assert.deepStrictEqual(reportOf(db, "alpha").reconcileAlerts, []);
  assert.deepStrictEqual(reportOf(db, "beta").reconcileAlerts, []);
});

test("只有一边翻转就会报未对平 —— 守住两处口径必须同步", () => {
  const db = bankDatabase();
  addCompany(db, { id: "alpha", name: "AussieX6" });
  addCompany(db, { id: "beta", name: "Rolex66" });
  const b = addAccount(db, { company_id: "beta" });
  addCStatusOption(db, "alpha", "RX66", "beta");
  addCStatusOption(db, "beta", "AX6", "alpha");

  // alpha 只记了 RX66 替它付的 150.14，beta 那边没记 —— 差额必须被抓出来。
  addLedger(db, 0, 0, DAY, { status: "withdraw", help_amount: 150.14, c_status: "RX66", company_id: "alpha" });
  addLedger(db, b, 0, DAY, { status: "deposit", amount_in: 0, c_status: "AX6" });

  const alerts = reportOf(db, "alpha").reconcileAlerts;
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(round2(alerts[0].difference), 150.14);
});

// reconcile_required 一度是死字段：bankReport 把它 SELECT 出来却从不判断，于是每一对
// 配了 target_company_id 的公司都在互相巡检，关不掉。下面三条守着它真的接着。
test("两侧都没勾「需要对平」时不巡检这一对", () => {
  const db = bankDatabase();
  addCompany(db, { id: "alpha", name: "AussieX6" });
  addCompany(db, { id: "beta", name: "Rolex66" });
  addCStatusOption(db, "alpha", "RX66", "beta", { reconcile_required: 0 });
  addCStatusOption(db, "beta", "AX6", "alpha", { reconcile_required: 0 });

  addLedger(db, 0, 0, DAY, { status: "withdraw", help_amount: 150.14, c_status: "RX66", company_id: "alpha" });

  assert.deepStrictEqual(reportOf(db, "alpha").reconcileAlerts, []);
  assert.deepStrictEqual(reportOf(db, "beta").reconcileAlerts, []);
});

// 「需要对平」是配对的属性，不是单边的。差额只有对面能补，所以勾选方报警时对面
// 必须也看得见——否则对方的操作手永远不知道该补账。
test("任一侧勾了「需要对平」，两边都报同一个差额", () => {
  const db = bankDatabase();
  addCompany(db, { id: "alpha", name: "AussieX6" });
  addCompany(db, { id: "beta", name: "Rolex66" });
  addCStatusOption(db, "alpha", "RX66", "beta", { reconcile_required: 1 });
  addCStatusOption(db, "beta", "AX6", "alpha", { reconcile_required: 0 });

  addLedger(db, 0, 0, DAY, { status: "withdraw", help_amount: 150.14, c_status: "RX66", company_id: "alpha" });

  const fromAlpha = reportOf(db, "alpha").reconcileAlerts;
  const fromBeta = reportOf(db, "beta").reconcileAlerts;
  assert.strictEqual(fromAlpha.length, 1);
  assert.strictEqual(fromBeta.length, 1);
  assert.strictEqual(round2(fromAlpha[0].difference), 150.14);
  assert.strictEqual(round2(fromBeta[0].difference), 150.14);
});

// 关掉一对不能波及另一对。
test("关掉的那一对不报，勾上的那一对照报", () => {
  const db = bankDatabase();
  addCompany(db, { id: "alpha", name: "AussieX6" });
  addCompany(db, { id: "beta", name: "Rolex66" });
  addCompany(db, { id: "gamma", name: "Pokies7Bet" });
  addCStatusOption(db, "alpha", "RX66", "beta", { reconcile_required: 0 });
  addCStatusOption(db, "beta", "AX6", "alpha", { reconcile_required: 0 });
  addCStatusOption(db, "alpha", "PK7", "gamma", { reconcile_required: 1 });
  addCStatusOption(db, "gamma", "AX6g", "alpha", { reconcile_required: 0 });

  addLedger(db, 0, 0, DAY, { status: "withdraw", help_amount: 150.14, c_status: "RX66", company_id: "alpha" });
  addLedger(db, 0, 0, DAY, { status: "withdraw", help_amount: 320.05, c_status: "PK7", company_id: "alpha" });

  const alerts = reportOf(db, "alpha").reconcileAlerts;
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].target_company_id, "gamma");
  assert.strictEqual(round2(alerts[0].difference), 320.05);
});
