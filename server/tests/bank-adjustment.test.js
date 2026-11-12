// 余额校正（bankApply.adjustBankBalance），规矩见 CONTEXT.md「余额校正（ADJUSTMENT）」。
//
// 2026-11-13 需求访谈：只有 admin 能做、很少用。填银行 App 上的实际余额，系统按页面显示的余额
// 算差额，写一条 status = adjustment 的流水——动余额，但不进任何报表（日报 / 月报 / C STATUS）。
// 只限运营中的户：校正封禁户会经「封禁户余额计入 EXPENSES」漏进报表。
const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureAuditSchema } = require("../lib/auditLog");
const { adjustBankBalance, ADJUSTMENT_STATUS } = require("../lib/bankApply");
const { balanceFromLedger, displayBalanceForAccount, computeBankDailyReport } = require("../lib/bankReport");
const { ledgerOperators } = require("../lib/ledgerOperators");
const { computeMonthlyReport } = require("../lib/monthlyReport");
const { todayKey } = require("../lib/dates");
const { bankDatabase, addCompany, addAccount, addLedger, accountRow } = require("./bank-fixture");

const admin = { type: "user", userId: 1, username: "boss", name: "Boss", role: "admin" };
const round2 = (n) => Math.round(n * 100) / 100;

function setup() {
  const db = bankDatabase();
  ensureAuditSchema(db);
  addCompany(db, { id: "alpha", name: "EzSpin68" });
  addCompany(db, { id: "beta", name: "Rolex66" });
  const live = addAccount(db, { account_name: "KYLIE" });
  addLedger(db, live, 1000, "2026-11-01", { status: "deposit" });
  return { db, live };
}
const adjRows = (db) => db.prepare("SELECT * FROM bank_ledger WHERE status = 'adjustment' ORDER BY id").all();

test("填实际余额，系统算差额：调高落 IN、调低落 OUT，余额等于实际余额", () => {
  const { db, live } = setup();
  const up = adjustBankBalance(db, "alpha", live, { actual_balance: 1200, remark: "银行 App 多 200" }, admin);
  assert.equal(ADJUSTMENT_STATUS, "adjustment");
  assert.equal(round2(up.diff), 200);
  assert.equal(Number(up.ledger.amount_in), 200);
  assert.equal(Number(up.ledger.amount_out), 0);
  assert.equal(up.ledger.status, "adjustment");
  assert.equal(up.ledger.remark, "银行 App 多 200");
  assert.equal(up.ledger.c_status, "");
  assert.equal(up.ledger.username, "");
  assert.ok(up.ledger.bank_acc, "带 BANK ACC");
  assert.equal(round2(balanceFromLedger(db, live)), 1200);
  assert.equal(round2(accountRow(db, live).balance), 1200, "bank_accounts.balance 跟着刷新");

  const down = adjustBankBalance(db, "alpha", live, { actual_balance: "1,050.00", remark: "少 150" }, admin);
  assert.equal(round2(down.diff), -150);
  assert.equal(Number(down.ledger.amount_out), 150);
  assert.equal(Number(down.ledger.amount_in), 0);
  assert.equal(round2(balanceFromLedger(db, live)), 1050);
});

test("差额为 0、REMARK 空、实际余额不是数，一律拒绝且不写流水", () => {
  const { db, live } = setup();
  const bad = (body) => assert.throws(() => adjustBankBalance(db, "alpha", live, body, admin), (e) => e.status === 400);
  bad({ actual_balance: 1000, remark: "无差额" });
  bad({ actual_balance: 1200, remark: "   " });
  bad({ actual_balance: 1200 });
  bad({ actual_balance: "abc", remark: "x" });
  bad({ actual_balance: "", remark: "x" });
  bad({ actual_balance: 1200, remark: "x".repeat(501) });
  assert.equal(adjRows(db).length, 0);
});

test("只能校正本公司运营中的户口", () => {
  const { db } = setup();
  const banned = addAccount(db, { account_name: "SAHMARA", lifecycle_status: "banned", active: 0 });
  const archived = addAccount(db, { account_name: "OLD", lifecycle_status: "archived", active: 0 });
  const other = addAccount(db, { company_id: "beta", account_name: "BETA" });
  for (const id of [banned, archived]) {
    assert.throws(() => adjustBankBalance(db, "alpha", id, { actual_balance: 5, remark: "x" }, admin), (e) => e.status === 400);
  }
  assert.throws(() => adjustBankBalance(db, "alpha", other, { actual_balance: 5, remark: "x" }, admin), (e) => e.status === 400, "别家公司的户口");
  assert.equal(adjRows(db).length, 0);
});

test("每日归零户按页面显示的当日余额算差额", () => {
  const { db } = setup();
  const daily = addAccount(db, { account_name: "DAILY", reset_daily_balance: 1 });
  addLedger(db, daily, 500, "2026-11-01", { status: "deposit" });
  addLedger(db, daily, 80, todayKey(), { status: "deposit" });
  const before = displayBalanceForAccount(db, accountRow(db, daily), todayKey());
  assert.equal(round2(before), 80);
  const r = adjustBankBalance(db, "alpha", daily, { actual_balance: 100, remark: "当日差 20" }, admin);
  assert.equal(round2(r.diff), 20);
  assert.equal(round2(displayBalanceForAccount(db, accountRow(db, daily), todayKey())), 100);
});

test("写审计 balance.adjusted，OPERATOR 列能取到校正人", () => {
  const { db, live } = setup();
  const r = adjustBankBalance(db, "alpha", live, { actual_balance: 900, remark: "少 100" }, admin);
  const ev = db.prepare("SELECT * FROM audit_events WHERE action = 'balance.adjusted'").get();
  assert.ok(ev, "有审计事件");
  assert.equal(ev.reason, "少 100");
  assert.equal(ledgerOperators(db, "alpha", [r.ledger.id]).get(Number(r.ledger.id)).created_by, "Boss");
});

test("不进报表：TRANSACTION、渠道 COUNT、REPORT 各行、WIN/LOSE、月报都不变，余额变", () => {
  const { db, live } = setup();
  const day = todayKey();
  addLedger(db, live, 300, day, { status: "deposit", username: "u1" });
  const before = computeBankDailyReport(db, "alpha", { date: day });
  const monthBefore = computeMonthlyReport(db, "alpha", { month: day.slice(0, 7), today: day });

  adjustBankBalance(db, "alpha", live, { actual_balance: 1500, remark: "多 200" }, admin);
  const after = computeBankDailyReport(db, "alpha", { date: day });
  const monthAfter = computeMonthlyReport(db, "alpha", { month: day.slice(0, 7), today: day });

  assert.equal(after.metrics.transaction_count, before.metrics.transaction_count, "TRANSACTION 不数 adjustment");
  const bankOf = (rep) => rep.bankRows.find((b) => Number(b.id) === Number(live));
  assert.equal(bankOf(after).tx_count, bankOf(before).tx_count, "渠道 COUNT 不数 adjustment");
  assert.deepEqual(after.reportRows, before.reportRows, "REPORT 各行不变");
  assert.deepEqual(after.reportPairs, before.reportPairs, "REPORT 成对行不变");
  assert.equal(after.totals.win_loss, before.totals.win_loss);
  assert.deepEqual(after.companyRows, before.companyRows, "C STATUS 表不变");
  assert.deepEqual(monthAfter, monthBefore, "月报不变");
  assert.equal(round2(bankOf(after).balance) - round2(bankOf(before).balance), 200, "渠道余额变");
  assert.equal(round2(after.totals.total_balance - before.totals.total_balance), 200, "TOTAL BALANCE 变");
});
