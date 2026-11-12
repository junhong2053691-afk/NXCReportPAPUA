// 调钱弹窗的 REDEP（CONTEXT.md「REDEP」，2026-11-12 用户定）。
//
// REDEP 在任何入口都不绑银行、不动余额：审批选 REDEP、手录、编辑一直如此，只有调钱弹窗的调入
// REDEP 曾经照常往选中的户口加钱——事后在交易记录里随便改一下这行，PUT 把银行清掉，余额就悄悄
// 变回去。现在调钱弹窗调入 / 调出都能选 REDEP，且一律忽略 BANK。
const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureAuditSchema } = require("../lib/auditLog");
const { submitTransfer } = require("../lib/bankApply");
const { balanceFromLedger, computeBankDailyReport } = require("../lib/bankReport");
const { bankDatabase, addCompany, addAccount, addLedger } = require("./bank-fixture");

const actor = { type: "user", userId: 1, username: "ops", name: "Ops", role: "operator" };
const round2 = (n) => Math.round(n * 100) / 100;
const DAY = "2026-11-12";

function setup() {
  const db = bankDatabase();
  ensureAuditSchema(db);
  addCompany(db, { id: "alpha", name: "EzSpin68" });
  const acc = addAccount(db, { account_name: "MAYBANK" });
  addLedger(db, acc, 1000, "2026-11-01", { status: "deposit" });
  return { db, acc };
}
const redep = (acc, direction) => ({
  direction, status: "redeposit", amount: 50, bank_account_id: acc, entry_time: `${DAY} 10:00:00`,
});

test("调出 REDEP：不绑银行、余额不变，金额记在 OUT", () => {
  const { db, acc } = setup();
  const { ledger } = submitTransfer(db, "alpha", redep(acc, "out"), actor);
  assert.equal(ledger.status, "redeposit");
  assert.equal(ledger.bank_account_id, 0);
  assert.equal(ledger.bank_acc, "");
  assert.equal(Number(ledger.amount_out), 50);
  assert.equal(Number(ledger.amount_in), 0);
  assert.equal(round2(balanceFromLedger(db, acc)), 1000);
});

test("调入 REDEP：同样不绑银行、余额不变，金额记在 IN", () => {
  const { db, acc } = setup();
  const { ledger } = submitTransfer(db, "alpha", redep(acc, "in"), actor);
  assert.equal(ledger.status, "redeposit");
  assert.equal(ledger.bank_account_id, 0);
  assert.equal(Number(ledger.amount_in), 50);
  assert.equal(round2(balanceFromLedger(db, acc)), 1000);
});

test("调出 REDEP 选了封禁户也不拒：BANK 本来就被忽略", () => {
  const { db } = setup();
  const banned = addAccount(db, { lifecycle_status: "banned", active: 0 });
  const { ledger } = submitTransfer(db, "alpha", redep(banned, "out"), actor);
  assert.equal(ledger.bank_account_id, 0);
});

test("调出方向仍然拒绝入账类状态", () => {
  const { db, acc } = setup();
  assert.throws(
    () => submitTransfer(db, "alpha", { ...redep(acc, "out"), status: "deposit" }, actor),
    (e) => e.status === 400,
  );
});

test("日报：调出 REDEP 只让 REDEP 笔数 +1，DEPOSIT / WITHDRAW / CASH OUT 不变", () => {
  const { db, acc } = setup();
  submitTransfer(db, "alpha", redep(acc, "out"), actor);
  const r = computeBankDailyReport(db, "alpha", { date: DAY });
  const row = (key) => r.reportRows.find((x) => x.key === key);
  assert.equal(row("redeposit").count, 1);
  assert.equal(row("deposit").amount, 0);
  assert.equal(row("withdraw").amount, 0);
  assert.equal(row("cash out").amount, 0);
});
