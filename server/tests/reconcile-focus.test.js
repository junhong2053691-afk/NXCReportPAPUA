// 未对平红条的「查看流水」拿什么去搜。
//
// 告警的 name 是**两边**的 C STATUS 名拼起来的（本方叫对方 EZ68、对方叫我方 PK7 →
// 「EZ68 / PK7」），而本方流水的 c_status 只会是本方那个名字。2026-11-06 员工演练：按钮把
// 「EZ68 / PK7」整串填进搜索框，结果一行都搜不到。所以告警要单独给出本方的名字
// local_names，前端只拿它去搜。
const test = require("node:test");
const assert = require("node:assert");

const { computeBankDailyReport } = require("../lib/bankReport");
const { bankDatabase, addCompany, addAccount, addLedger, addCStatusOption } = require("./bank-fixture");

const DAY = "2026-10-01";

function setup() {
  const db = bankDatabase();
  addCompany(db, { id: "alpha", name: "Pokies7Bet" });
  addCompany(db, { id: "beta", name: "EzSpin68" });
  addCStatusOption(db, "alpha", "EZ68", "beta", { reconcile_required: 1 });
  addCStatusOption(db, "beta", "PK7", "alpha", { reconcile_required: 1 });
  return db;
}

test("告警的 local_names 只含本方 C STATUS 名，且能搜到造成差额的那几行", () => {
  const db = setup();
  const acc = addAccount(db);
  addLedger(db, acc, 0, DAY, { status: "cash out", amount_out: 20, c_status: "EZ68" });

  const report = computeBankDailyReport(db, "alpha", { date: DAY });
  const alert = report.reconcileAlerts[0];
  assert.ok(alert, "应有未对平告警");
  assert.strictEqual(alert.name, "EZ68 / PK7");
  assert.deepStrictEqual(alert.local_names, ["EZ68"]);

  const rows = db.prepare("SELECT c_status FROM bank_ledger WHERE company_id = 'alpha'").all();
  assert.ok(rows.every((r) => alert.local_names.includes(r.c_status)));
});

test("对方那边看同一对：local_names 是它自己的名字 PK7", () => {
  const db = setup();
  const acc = addAccount(db, { company_id: "beta" });
  addLedger(db, acc, 50, DAY, { status: "cash in", c_status: "PK7" });

  const alert = computeBankDailyReport(db, "beta", { date: DAY }).reconcileAlerts[0];
  assert.deepStrictEqual(alert.local_names, ["PK7"]);
});

test("本方没有映射这家（只有对方映射了我）：local_names 为空，前端不出按钮", () => {
  const db = bankDatabase();
  addCompany(db, { id: "alpha", name: "Pokies7Bet" });
  addCompany(db, { id: "beta", name: "EzSpin68" });
  addCStatusOption(db, "beta", "PK7", "alpha", { reconcile_required: 1 });
  const acc = addAccount(db, { company_id: "beta" });
  addLedger(db, acc, 50, DAY, { status: "cash in", c_status: "PK7" });

  const alert = computeBankDailyReport(db, "alpha", { date: DAY }).reconcileAlerts[0];
  assert.ok(alert);
  assert.deepStrictEqual(alert.local_names, []);
});
