// 封禁户「转出余额」（bankApply.drainBannedAccount）。
//
// 2026-11-06 员工演练：封禁户里剩的钱没有任何入口能转走——所有记账入口都只认运营中的户口，
// 员工只能「解封 → 记两笔 → 再封禁」，解封期间户口又出现在审批下拉里，还把 C STATUS 填成了
// 本公司。与用户确认的记法（Excel）：
//   转到本公司另一个户口：封禁户 BANK TRF 出 + 收款户 BANK TRANSFER 入，金额相同，C STATUS 留空
//   转给别家公司：      封禁户 BANK TRF 出，C STATUS 填对方（对方自己记入账）
// 钱能拿回、户口还要用的，照旧走「解封」；这里不解封，户口一直是封禁状态。
const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureAuditSchema } = require("../lib/auditLog");
const { drainBannedAccount } = require("../lib/bankApply");
const { balanceFromLedger, computeBankDailyReport } = require("../lib/bankReport");
const { bankDatabase, addCompany, addAccount, addLedger, addCStatusOption } = require("./bank-fixture");

const actor = { type: "user", userId: 1, username: "ops", name: "Ops", role: "operator" };
const round2 = (n) => Math.round(n * 100) / 100;

function setup() {
  const db = bankDatabase();
  ensureAuditSchema(db);
  addCompany(db, { id: "alpha", name: "EzSpin68" });
  addCompany(db, { id: "beta", name: "Rolex66" });
  addCStatusOption(db, "alpha", "RX66", "beta");
  const banned = addAccount(db, { account_name: "SAHMARA", lifecycle_status: "banned", active: 0 });
  const live = addAccount(db, { account_name: "KYLIE" });
  addLedger(db, banned, 945.83, "2026-11-01", { status: "deposit" });
  return { db, banned, live };
}
const ledgerOf = (db) => db.prepare("SELECT * FROM bank_ledger WHERE entry_time > '2026-11-02' ORDER BY id").all();
const statusOf = (db, id) => db.prepare("SELECT lifecycle_status FROM bank_accounts WHERE id = ?").get(id).lifecycle_status;

test("转到本公司户口：封禁户 BANK TRF 出、收款户 BANK TRANSFER 入，C STATUS 留空，余额搬过去", () => {
  const { db, banned, live } = setup();
  drainBannedAccount(db, "alpha", banned, { amount: 945.83, to_bank_account_id: live, remark: "银行解冻" }, actor);

  const [out, inn] = ledgerOf(db);
  assert.equal(out.bank_account_id, banned);
  assert.equal(out.status, "bank trf");
  assert.equal(out.c_status, "");
  assert.equal(inn.bank_account_id, live);
  assert.equal(inn.status, "bank transfer");
  assert.equal(inn.c_status, "");
  assert.ok(out.transfer_group_id && out.transfer_group_id === inn.transfer_group_id, "两笔同一个调钱组");
  assert.equal(round2(balanceFromLedger(db, banned)), 0);
  assert.equal(round2(balanceFromLedger(db, live)), 945.83);
  assert.equal(statusOf(db, banned), "banned", "不解封");
});

test("转给别家：只记封禁户一笔 BANK TRF 出，C STATUS 填对方，和调钱弹窗录 BANK TRF 同口径", () => {
  const { db, banned } = setup();
  drainBannedAccount(db, "alpha", banned, { amount: 500, c_status: "RX66" }, actor);

  const rows = ledgerOf(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bank_account_id, banned);
  assert.equal(rows[0].status, "bank trf");
  assert.equal(rows[0].c_status, "RX66");
  assert.equal(round2(balanceFromLedger(db, banned)), 445.83);
  const day = rows[0].entry_time.slice(0, 10);
  const rx = computeBankDailyReport(db, "alpha", { date: day }).companyRows.find((r) => r.name === "RX66");
  assert.ok(rx && round2(Math.abs(rx.total)) === 500, "进 C STATUS 表");
});

test("收款户与对方公司二选一", () => {
  const { db, banned, live } = setup();
  assert.throws(() => drainBannedAccount(db, "alpha", banned, { amount: 1 }, actor), (e) => e.status === 400);
  assert.throws(() => drainBannedAccount(db, "alpha", banned, { amount: 1, to_bank_account_id: live, c_status: "RX66" }, actor), (e) => e.status === 400);
});

test("只有封禁中的户口能转出；收款户必须是本公司运营中的户口", () => {
  const { db, banned, live } = setup();
  assert.throws(() => drainBannedAccount(db, "alpha", live, { amount: 1, to_bank_account_id: banned }, actor), /封禁/);
  const other = addAccount(db, { company_id: "beta" });
  assert.throws(() => drainBannedAccount(db, "alpha", banned, { amount: 1, to_bank_account_id: other }, actor), (e) => e.status === 400);
  assert.throws(() => drainBannedAccount(db, "beta", banned, { amount: 1, c_status: "RX66" }, actor), (e) => e.status === 400, "别家公司不能动我的户口");
  const banned2 = addAccount(db, { lifecycle_status: "banned", active: 0 });
  assert.throws(() => drainBannedAccount(db, "alpha", banned, { amount: 1, to_bank_account_id: banned2 }, actor), (e) => e.status === 400);
});

test("金额必须大于 0，且不能超过封禁户余额", () => {
  const { db, banned, live } = setup();
  assert.throws(() => drainBannedAccount(db, "alpha", banned, { amount: 0, to_bank_account_id: live }, actor), (e) => e.status === 400);
  assert.throws(() => drainBannedAccount(db, "alpha", banned, { amount: 945.84, to_bank_account_id: live }, actor), /余额/);
  assert.equal(ledgerOf(db).length, 0);
});

test("不能转给本公司（C STATUS 关联的是自己）", () => {
  const { db, banned } = setup();
  addCStatusOption(db, "alpha", "EZ68", "alpha");
  assert.throws(() => drainBannedAccount(db, "alpha", banned, { amount: 1, c_status: "EZ68" }, actor), /本公司/);
});

test("路由只认 req.companyId（不回退 session），前端封禁行有入口", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const routes = fs.readFileSync(path.join(__dirname, "../routes/banks.js"), "utf8");
  assert.match(routes, /router\.post\("\/:id\/drain"[\s\S]{0,200}drainBannedAccount\(getDb\(\), companyId\(req\)/);
  const page = fs.readFileSync(path.join(__dirname, "../../public/js/bank-accounts.js"), "utf8");
  assert.match(page, /bkd-drain-btn/);
  assert.match(page, /\/api\/banks\/\$\{drainBankId\}\/drain/);
});

test("写审计", () => {
  const { db, banned, live } = setup();
  drainBannedAccount(db, "alpha", banned, { amount: 100, to_bank_account_id: live }, actor);
  const n = db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'transfer.created'").get().n;
  assert.equal(n, 1);
});
