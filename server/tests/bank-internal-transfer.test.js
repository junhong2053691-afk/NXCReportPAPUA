// 两户互转（CONTEXT.md「两户互转」，2026-11-12 需求访谈）。
//
// `bank trf` / `bank transfer` 只表示本公司自己两个户口之间挪钱，永远不记 C STATUS。
// 调钱弹窗填负数、STATUS 选 bank trf、再选「到」：一次保存写两条——「从」户 bank trf 出、
// 「到」户 bank transfer 入，金额相同，同一个 transfer_group_id。员工不用两边各录一次。
const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureAuditSchema } = require("../lib/auditLog");
const { submitTransfer, drainBannedAccount, ledgerRowsToDelete, deletedRowsToRestore } = require("../lib/bankApply");
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
  const from = addAccount(db, { account_name: "MAYBANK" });
  const to = addAccount(db, { account_name: "CIMB" });
  addLedger(db, from, 1000, "2026-11-01", { status: "deposit" });
  return { db, from, to };
}
const newRows = (db) => db.prepare("SELECT * FROM bank_ledger WHERE entry_time > '2026-11-02' ORDER BY id").all();
const internal = (from, to, extra = {}) => ({
  direction: "out", status: "bank trf", amount: 500, bank_account_id: from, to_bank_account_id: to,
  entry_time: "2026-11-12 10:00:00", ...extra,
});

test("一次保存写两条：「从」户 bank trf 出、「到」户 bank transfer 入，C STATUS 空，同一组，余额搬过去", () => {
  const { db, from, to } = setup();
  submitTransfer(db, "alpha", internal(from, to, { remark: "挪钱" }), actor);

  const [out, inn] = newRows(db);
  assert.equal(out.bank_account_id, from);
  assert.equal(out.status, "bank trf");
  assert.equal(out.c_status, "");
  assert.equal(inn.bank_account_id, to);
  assert.equal(inn.status, "bank transfer");
  assert.equal(inn.c_status, "");
  assert.equal(inn.entry_time, out.entry_time);
  assert.equal(inn.remark, "挪钱");
  assert.ok(out.transfer_group_id && out.transfer_group_id === inn.transfer_group_id, "两条同一个调钱组");
  assert.equal(round2(balanceFromLedger(db, from)), 500);
  assert.equal(round2(balanceFromLedger(db, to)), 500);
  const report = computeBankDailyReport(db, "alpha", { date: "2026-11-12" });
  assert.ok(report.companyRows.every((r) => r.in === 0 && r.out === 0), "不进 C STATUS 表");
});

test("bank trf 必须「从」「到」都是本公司运营中的不同户口、不带 C STATUS；拒绝时一条都不写", () => {
  const { db, from, to } = setup();
  const otherCompany = addAccount(db, { company_id: "beta" });
  const banned = addAccount(db, { lifecycle_status: "banned", active: 0 });
  const bad = {
    "没有「到」": internal(from, 0),
    "带了 C STATUS": internal(from, to, { c_status: "RX66" }),
    "带了新的 C STATUS": internal(from, to, { c_status: "NEWCO" }),
    "没有「从」": internal(0, to),
    "从 = 到": internal(from, from),
    "「到」是别家公司的户口": internal(from, otherCompany),
    "「到」已封禁": internal(from, banned),
  };
  for (const [why, body] of Object.entries(bad)) {
    assert.throws(() => submitTransfer(db, "alpha", body, actor), (e) => e.status === 400, why);
  }
  assert.equal(newRows(db).length, 0);
  const options = db.prepare("SELECT name FROM bank_c_status_options WHERE company_id = 'alpha'").all().map((o) => o.name);
  assert.deepEqual(options, ["RX66"], "拒绝的互转不能顺手存出新的 C STATUS 选项");
});

test("调钱入账不再提供 bank transfer：它只作为互转的另一半自动产生", () => {
  const { db, to } = setup();
  assert.throws(
    () => submitTransfer(db, "alpha", { direction: "in", status: "bank transfer", amount: 50, bank_account_id: to, c_status: "RX66" }, actor),
    (e) => e.status === 400
  );
  assert.equal(newRows(db).length, 0);
});

// 交易记录页的 OPERATOR 列靠审计引用找人：两条都要登记，「到」那条才不会显示「—」。
test("两户互转的两条都查得到录入人（调钱和转出封禁户余额都是）", () => {
  const { ledgerOperators } = require("../lib/ledgerOperators");
  const { db, from, to } = setup();
  const t = submitTransfer(db, "alpha", internal(from, to), actor);
  const banned = addAccount(db, { lifecycle_status: "banned", active: 0 });
  addLedger(db, banned, 80, "2026-11-01", { status: "deposit" });
  const d = drainBannedAccount(db, "alpha", banned, { amount: 80, to_bank_account_id: to }, actor);
  const ops = ledgerOperators(db, "alpha", [t.ledger.id, t.inbound.id, d.ledger.id, d.inbound.id]);
  for (const id of [t.ledger.id, t.inbound.id, d.ledger.id, d.inbound.id]) {
    assert.equal(ops.get(id)?.created_by, "Ops", `流水 #${id}`);
  }
});

// 删一条只删一条的话，两户余额对不上（审查发现：交易记录页的删除原来只认 auto_generated = 1 的组）。
test("删两户互转的任一条：两条一起删；转出封禁户余额到本公司户口同理", () => {
  const { db, from, to } = setup();
  const { ledger, inbound } = submitTransfer(db, "alpha", internal(from, to), actor);
  const ids = (rows) => rows.map((r) => r.id).sort((a, b) => a - b);
  assert.deepEqual(ids(ledgerRowsToDelete(db, "alpha", ledger)), [ledger.id, inbound.id]);
  assert.deepEqual(ids(ledgerRowsToDelete(db, "alpha", inbound)), [ledger.id, inbound.id]);

  const banned = addAccount(db, { lifecycle_status: "banned", active: 0 });
  addLedger(db, banned, 80, "2026-11-01", { status: "deposit" });
  const drained = drainBannedAccount(db, "alpha", banned, { amount: 80, to_bank_account_id: to }, actor);
  assert.deepEqual(ids(ledgerRowsToDelete(db, "alpha", drained.inbound)), [drained.ledger.id, drained.inbound.id]);
});

test("别的流水删除范围不变：普通行只删自己，带组的单条老 bank trf 也只删自己，别家公司同组号不受牵连", () => {
  const { db, from, to } = setup();
  const plain = db.prepare("SELECT * FROM bank_ledger WHERE bank_account_id = ?").get(from);
  assert.deepEqual(ledgerRowsToDelete(db, "alpha", plain).map((r) => r.id), [plain.id]);

  const old = submitTransfer(db, "alpha", { direction: "out", status: "cash out", amount: 5, bank_account_id: from, c_status: "RX66" }, actor).ledger;
  db.prepare("UPDATE bank_ledger SET status = 'bank trf', amount_out = 0, help_amount = 5 WHERE id = ?").run(old.id);
  const oldRow = db.prepare("SELECT * FROM bank_ledger WHERE id = ?").get(old.id);
  assert.deepEqual(ledgerRowsToDelete(db, "alpha", oldRow).map((r) => r.id), [old.id]);

  const { ledger } = submitTransfer(db, "alpha", internal(from, to), actor);
  const otherBank = addAccount(db, { company_id: "beta" });
  db.prepare(
    `INSERT INTO bank_ledger (bank_account_id, company_id, entry_time, status, trf_amount, transfer_group_id)
     VALUES (?, 'beta', '2026-11-12 10:00:00', 'bank transfer', 1, ?)`
  ).run(otherBank, ledger.transfer_group_id);
  assert.equal(ledgerRowsToDelete(db, "alpha", ledger).length, 2);
});

test("从最近删除恢复两户互转的任一条：另一条一起恢复", () => {
  const { db } = setup();
  const archive = db.prepare(
    `INSERT INTO bank_ledger_deleted (original_id, bank_account_id, company_id, entry_time, status, help_amount, trf_amount, transfer_group_id)
     VALUES (?, ?, ?, '2026-11-12 10:00:00', ?, ?, ?, ?)`
  );
  const outId = Number(archive.run(11, 1, "alpha", "bank trf", 500, 0, "trf_pair").lastInsertRowid);
  const inId = Number(archive.run(12, 2, "alpha", "bank transfer", 0, 500, "trf_pair").lastInsertRowid);
  archive.run(13, 3, "beta", "bank transfer", 0, 1, "trf_pair");
  const plainId = Number(archive.run(14, 1, "alpha", "deposit", 0, 0, "").lastInsertRowid);
  const row = (id) => db.prepare("SELECT * FROM bank_ledger_deleted WHERE id = ?").get(id);
  const ids = (rows) => rows.map((r) => r.id).sort((a, b) => a - b);

  assert.deepEqual(ids(deletedRowsToRestore(db, "alpha", row(inId))), [outId, inId]);
  assert.deepEqual(ids(deletedRowsToRestore(db, "alpha", row(outId))), [outId, inId]);
  assert.deepEqual(ids(deletedRowsToRestore(db, "alpha", row(plainId))), [plainId]);
});

test("没传 STATUS 时默认：负数 cash out、正数 cash in（不再默认 bank trf / bank transfer）", () => {
  const { db, from } = setup();
  const base = { amount: 20, bank_account_id: from, c_status: "RX66", entry_time: "2026-11-12 11:00:00" };
  submitTransfer(db, "alpha", { ...base, direction: "out" }, actor);
  submitTransfer(db, "alpha", { ...base, direction: "in" }, actor);
  assert.deepEqual(newRows(db).map((r) => r.status), ["cash out", "cash in"]);
});
