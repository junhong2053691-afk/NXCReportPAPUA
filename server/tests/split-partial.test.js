// 拆分调钱 · 分批付（CONTEXT.md「拆分调钱」，2026-11-13 用户定）。
// 一张 withdraw 平台单可以由多个本公司户口（自付行）+ 协助方凑，也可以分几批付；
// 付了一部分的单留在接单区，付满才关单，也可以「按已付结单」。已付每次从账上现算。
const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureAuditSchema } = require("../lib/auditLog");
const { balanceFromLedger } = require("../lib/bankReport");
const {
  approvePendingTx,
  skipPendingTx,
  listPendingTx,
  closePendingShort,
  reopenPendingForLedger,
  restoreConflictForDeleted,
  settleSplitPendingAfterRestore,
  paidAmountForTx,
  nowSql,
} = require("../lib/bankApply");
const { bankDatabase, addCompany, addAccount, addCStatusOption } = require("./bank-fixture");

const DAY = "2026-10-01";
const actor = { type: "user", userId: 1, username: "ops", name: "Ops", role: "operator" };

function setup() {
  const db = bankDatabase();
  ensureAuditSchema(db);
  db.exec(`
    CREATE TABLE bank_tx_pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT, tx_id TEXT, tx_type TEXT,
      amount REAL, username TEXT, name TEXT, tx_time TEXT, state TEXT,
      bank_account_id INTEGER DEFAULT 0, approve_mode TEXT DEFAULT '', c_status TEXT DEFAULT '',
      approved_entry_time TEXT DEFAULT '', approved_at TEXT, approved_by TEXT DEFAULT '',
      decided_at TEXT, decided_by TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(company_id, tx_id)
    );
    CREATE TABLE bank_balance_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bank_account_id INTEGER, tx_id TEXT UNIQUE,
      amount REAL DEFAULT 0, applied_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE transactions (id TEXT, company_id TEXT, type TEXT, amount REAL, username TEXT, name TEXT, created_at TEXT);
  `);
  addCompany(db, { id: "alpha", name: "AussieX6" });
  addCompany(db, { id: "beta", name: "Rolex66" });
  addCStatusOption(db, "alpha", "RX66", "beta", { reconcile_required: 1 });
  return db;
}

function withdrawPending(db, txId, amount) {
  db.prepare(
    `INSERT INTO bank_tx_pending (company_id, tx_id, tx_type, amount, username, name, tx_time, state)
     VALUES ('alpha', ?, 'WITHDRAW', ?, 'cust', 'Customer', ?, 'pending')`
  ).run(txId, amount, `${DAY} 10:00:00`);
}

const accounts = (db, n) => Array.from({ length: n }, (_, i) => addAccount(db, { bank_branch: `Bank ${i + 1}` }));
const pendingRow = (db, txId) => db.prepare("SELECT * FROM bank_tx_pending WHERE tx_id = ?").get(txId);
const ledgersOf = (db, txId) => db.prepare("SELECT * FROM bank_ledger WHERE tx_id = ? ORDER BY id").all(txId);
const split = (db, txId, body) => approvePendingTx(db, "alpha", txId, { mode: "help_split", ...body }, actor);
const balanceLog = (db, txId) => db.prepare("SELECT * FROM bank_balance_log WHERE tx_id = ?").get(txId);
const status = (fn) => {
  try { fn(); } catch (e) { return e.status; }
  return 0;
};

// 删除路由的做法：整组从 bank_ledger 删掉，再拿被点的那一行调 reopenPendingForLedger。
function deleteGroup(db, groupId) {
  const rows = db.prepare("SELECT * FROM bank_ledger WHERE transfer_group_id = ? ORDER BY id").all(groupId);
  for (const row of rows) {
    db.prepare(
      `INSERT INTO bank_ledger_deleted (original_id, bank_account_id, company_id, entry_time, tx_id, status,
         amount_in, amount_out, help_amount, trf_amount, auto_generated, transfer_group_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.bank_account_id, row.company_id, row.entry_time, row.tx_id, row.status,
      row.amount_in, row.amount_out, row.help_amount, row.trf_amount, row.auto_generated, row.transfer_group_id);
    db.prepare("DELETE FROM bank_ledger WHERE id = ?").run(row.id);
  }
  return { rows, reopened: reopenPendingForLedger(db, rows[0]) };
}

function restoreRow(db, deleted) {
  db.prepare(
    `INSERT INTO bank_ledger (bank_account_id, company_id, entry_time, tx_id, status, amount_in, amount_out,
       help_amount, trf_amount, auto_generated, transfer_group_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(deleted.bank_account_id, deleted.company_id, deleted.entry_time, deleted.tx_id, deleted.status,
    deleted.amount_in, deleted.amount_out, deleted.help_amount, deleted.trf_amount, deleted.auto_generated,
    deleted.transfer_group_id);
  return settleSplitPendingAfterRestore(db, "alpha", deleted.tx_id, "ops");
}

test("全部自家付：10 个户口各 1000 付满 10000 → 10 条 withdraw 出账、各户各扣 1000、单子关掉", () => {
  const db = setup();
  const ids = accounts(db, 10);
  withdrawPending(db, "w1", 10000);
  const { ledgers } = split(db, "w1", { self_rows: ids.map((id) => ({ bank_account_id: id, amount: 1000 })) });

  assert.equal(ledgers.length, 10);
  for (const [i, l] of ledgers.entries()) {
    assert.equal(l.status, "withdraw");
    assert.equal(l.amount_out, 1000);
    assert.equal(l.help_amount, 0);
    assert.equal(l.bank_account_id, ids[i]);
    assert.ok(l.bank_acc.startsWith(`Bank ${i + 1}`));
    assert.equal(balanceFromLedger(db, ids[i]), -1000);
  }
  const p = pendingRow(db, "w1");
  assert.equal(p.state, "approved");
  assert.equal(p.approve_mode, "help_split");
  assert.equal(p.bank_account_id, ids[0], "平台单记录上的户口存第一个自付户口");
  assert.ok(balanceLog(db, "w1"), "防重锁照写");
});

test("一批最多 10 个不同户口；同一户口可以填多行，不算两个户口", () => {
  const db = setup();
  const ids = accounts(db, 11);
  withdrawPending(db, "w2", 1100);
  assert.equal(status(() => split(db, "w2", { self_rows: ids.map((id) => ({ bank_account_id: id, amount: 100 })) })), 400);

  const rows = ids.slice(0, 10).map((id) => ({ bank_account_id: id, amount: 100 }));
  rows.push({ bank_account_id: ids[0], amount: 100 });
  const { ledgers } = split(db, "w2", { self_rows: rows });
  assert.equal(ledgers.length, 11);
  assert.equal(balanceFromLedger(db, ids[0]), -200, "同一户口两行各一条流水，余额相加");
});

test("自付行要有户口和正数金额；户口必须是本公司运营中", () => {
  const db = setup();
  const [a] = accounts(db, 1);
  const banned = addAccount(db, { lifecycle_status: "banned" });
  const other = addAccount(db, { company_id: "beta" });
  withdrawPending(db, "w3", 500);
  assert.equal(status(() => split(db, "w3", { self_rows: [{ bank_account_id: 0, amount: 100 }] })), 400);
  assert.equal(status(() => split(db, "w3", { self_rows: [{ bank_account_id: a, amount: 0 }] })), 400);
  assert.equal(status(() => split(db, "w3", { self_rows: [{ bank_account_id: banned, amount: 100 }] })), 400);
  assert.equal(status(() => split(db, "w3", { self_rows: [{ bank_account_id: other, amount: 100 }] })), 400);
  assert.equal(status(() => split(db, "w3", { self_rows: [], splits: [] })), 400, "一行都没有");
  assert.equal(ledgersOf(db, "w3").length, 0);
});

test("分批付：先付 200 留在接单区显示已付 / 还差，再付 800 才关单；每批一个组号", () => {
  const db = setup();
  const [a, b, c] = accounts(db, 3);
  withdrawPending(db, "w4", 1000);

  const first = split(db, "w4", { self_rows: [{ bank_account_id: a, amount: 100 }, { bank_account_id: b, amount: 100 }] });
  assert.equal(pendingRow(db, "w4").state, "pending");
  assert.equal(balanceFromLedger(db, a), -100, "付一部分也马上扣余额");
  const listed = listPendingTx(db, "alpha").find((r) => r.tx_id === "w4");
  assert.equal(listed.paid_amount, 200);
  assert.equal(listed.remaining_amount, 800);

  const second = split(db, "w4", {
    self_rows: [{ bank_account_id: c, amount: 500 }],
    splits: [{ c_status: "RX66", amount: 300 }],
  });
  assert.notEqual(first.transfer_group_id, second.transfer_group_id);
  const p = pendingRow(db, "w4");
  assert.equal(p.state, "approved");
  assert.equal(p.bank_account_id, a, "关单时记账上第一个自付户口，不是最后一批的");
  assert.equal(p.c_status, "RX66");
  assert.equal(paidAmountForTx(db, "alpha", "w4"), 1000);
  assert.equal(listPendingTx(db, "alpha").length, 0);
});

test("只靠一行也能提交（分批之后不再要求至少 2 个分配项）", () => {
  const db = setup();
  const [a] = accounts(db, 1);
  withdrawPending(db, "w5", 500);
  split(db, "w5", { self_rows: [{ bank_account_id: a, amount: 500 }] });
  assert.equal(pendingRow(db, "w5").state, "approved");
});

test("不能多付：合计超过还差就拒绝，什么都不写", () => {
  const db = setup();
  const [a] = accounts(db, 1);
  withdrawPending(db, "w6", 1000);
  split(db, "w6", { self_rows: [{ bank_account_id: a, amount: 200 }] });
  assert.equal(status(() => split(db, "w6", { self_rows: [{ bank_account_id: a, amount: 900 }] })), 400);
  assert.equal(ledgersOf(db, "w6").length, 1);
  assert.equal(paidAmountForTx(db, "alpha", "w6"), 200);
});

test("付过一部分的单：普通审批、调钱、REDEP、跳过都拒绝（会付全额 / 账上有钱的单不能跳过）", () => {
  const db = setup();
  const [a] = accounts(db, 1);
  withdrawPending(db, "w7", 1000);
  split(db, "w7", { self_rows: [{ bank_account_id: a, amount: 200 }] });

  assert.equal(status(() => approvePendingTx(db, "alpha", "w7", { mode: "bank", bank_account_id: a }, actor)), 400);
  assert.equal(status(() => approvePendingTx(db, "alpha", "w7", { mode: "help", c_status: "RX66" }, actor)), 400);
  assert.equal(status(() => approvePendingTx(db, "alpha", "w7", { mode: "redeposit" }, actor)), 400);
  assert.equal(status(() => skipPendingTx(db, "alpha", "w7", actor, "不付了")), 400);
  assert.equal(pendingRow(db, "w7").state, "pending");
  assert.equal(paidAmountForTx(db, "alpha", "w7"), 200);
});

test("入账时间：第一批默认平台单时间，第 2 批起默认提交时间；手填照样生效", () => {
  const db = setup();
  const [a] = accounts(db, 1);
  withdrawPending(db, "w8", 1000);
  const first = split(db, "w8", { self_rows: [{ bank_account_id: a, amount: 100 }] });
  assert.equal(first.ledgers[0].entry_time, `${DAY} 10:00:00`);

  const before = nowSql();
  const second = split(db, "w8", { self_rows: [{ bank_account_id: a, amount: 100 }] });
  const after = nowSql();
  assert.ok(second.ledgers[0].entry_time >= before && second.ledgers[0].entry_time <= after, second.ledgers[0].entry_time);

  const third = split(db, "w8", { self_rows: [{ bank_account_id: a, amount: 100 }], entry_time: `${DAY} 12:00` });
  assert.equal(third.ledgers[0].entry_time, `${DAY} 12:00:00`);
});

test("按已付结单：要有原因、已付 > 0；结单后离开接单区、不补流水、写审计", () => {
  const db = setup();
  const [a] = accounts(db, 1);
  withdrawPending(db, "w9", 1000);
  assert.equal(status(() => closePendingShort(db, "alpha", "w9", actor, "客户取消")), 400, "一分没付就是跳过");

  split(db, "w9", { self_rows: [{ bank_account_id: a, amount: 800 }] });
  assert.equal(status(() => closePendingShort(db, "alpha", "w9", actor, "")), 400, "原因必填");

  closePendingShort(db, "alpha", "w9", actor, "平台撤了剩下 200");
  const p = pendingRow(db, "w9");
  assert.equal(p.state, "approved");
  assert.equal(p.approve_mode, "split_closed");
  assert.equal(p.bank_account_id, a);
  assert.equal(ledgersOf(db, "w9").length, 1, "不补任何流水");
  assert.equal(listPendingTx(db, "alpha").length, 0);
  const event = db.prepare("SELECT * FROM audit_events WHERE action = 'pending.closed_short'").get();
  assert.ok(event);
  assert.equal(event.reason, "平台撤了剩下 200");
});

test("删一批：付满关掉的单重新打开，还差 = 删掉的那批；防重锁留着", () => {
  const db = setup();
  const [a, b] = accounts(db, 2);
  withdrawPending(db, "w10", 1000);
  split(db, "w10", { self_rows: [{ bank_account_id: a, amount: 700 }] });
  const second = split(db, "w10", { self_rows: [{ bank_account_id: b, amount: 300 }] });
  assert.equal(pendingRow(db, "w10").state, "approved");

  const { reopened } = deleteGroup(db, second.transfer_group_id);
  assert.equal(reopened, true);
  const p = pendingRow(db, "w10");
  assert.equal(p.state, "pending");
  assert.equal(p.approve_mode, "");
  assert.equal(listPendingTx(db, "alpha")[0].remaining_amount, 300);
  assert.equal(balanceFromLedger(db, b), 0);
  assert.ok(balanceLog(db, "w10"), "账上还有这张单的钱，同步侧的防重锁不能删");
});

test("删一批：按已付结单的单也重新打开，还差按账上剩下的算", () => {
  const db = setup();
  const [a, b] = accounts(db, 2);
  withdrawPending(db, "w11", 1000);
  split(db, "w11", { self_rows: [{ bank_account_id: a, amount: 500 }] });
  const second = split(db, "w11", { self_rows: [{ bank_account_id: b, amount: 300 }] });
  closePendingShort(db, "alpha", "w11", actor, "少付");

  deleteGroup(db, second.transfer_group_id);
  assert.equal(pendingRow(db, "w11").state, "pending");
  assert.equal(listPendingTx(db, "alpha")[0].remaining_amount, 500);
});

test("删一批：还没付满的单仍留在待处理，还差加回去", () => {
  const db = setup();
  const [a, b] = accounts(db, 2);
  withdrawPending(db, "w12", 1000);
  split(db, "w12", { self_rows: [{ bank_account_id: a, amount: 100 }] });
  const second = split(db, "w12", { self_rows: [{ bank_account_id: b, amount: 200 }] });
  deleteGroup(db, second.transfer_group_id);
  assert.equal(pendingRow(db, "w12").state, "pending");
  assert.equal(listPendingTx(db, "alpha")[0].remaining_amount, 900);
});

test("删光所有批次：和普通审批单一样退回全额待处理、清掉防重锁", () => {
  const db = setup();
  const [a] = accounts(db, 1);
  withdrawPending(db, "w13", 1000);
  const only = split(db, "w13", { self_rows: [{ bank_account_id: a, amount: 1000 }] });
  deleteGroup(db, only.transfer_group_id);
  assert.equal(pendingRow(db, "w13").state, "pending");
  assert.equal(balanceLog(db, "w13"), undefined);
  assert.equal(listPendingTx(db, "alpha")[0].remaining_amount, 1000);
});

test("恢复一批：恢复后不超过平台单金额就放行；付满则关单，没付满留在待处理", () => {
  const db = setup();
  const [a, b] = accounts(db, 2);
  withdrawPending(db, "w14", 1000);
  split(db, "w14", { self_rows: [{ bank_account_id: a, amount: 700 }] });
  const second = split(db, "w14", { self_rows: [{ bank_account_id: b, amount: 300 }] });
  const { rows } = deleteGroup(db, second.transfer_group_id);
  const deleted = db.prepare("SELECT * FROM bank_ledger_deleted WHERE original_id = ?").get(rows[0].id);

  assert.equal(restoreConflictForDeleted(db, deleted), null);
  assert.equal(restoreRow(db, deleted), "approved");
  assert.equal(pendingRow(db, "w14").state, "approved");
  assert.equal(balanceFromLedger(db, b), -300);
});

test("恢复一批：恢复后会超过平台单金额就是重复入账，报冲突", () => {
  const db = setup();
  const [a, b] = accounts(db, 2);
  withdrawPending(db, "w15", 1000);
  split(db, "w15", { self_rows: [{ bank_account_id: a, amount: 700 }] });
  const second = split(db, "w15", { self_rows: [{ bank_account_id: b, amount: 300 }] });
  const { rows } = deleteGroup(db, second.transfer_group_id);
  // 删掉之后员工又补付了 300
  split(db, "w15", { self_rows: [{ bank_account_id: a, amount: 300 }] });
  const deleted = db.prepare("SELECT * FROM bank_ledger_deleted WHERE original_id = ?").get(rows[0].id);
  assert.ok(restoreConflictForDeleted(db, deleted));
});

test("恢复一批到没付满的单：留在待处理（哪怕它之前被跳过）", () => {
  const db = setup();
  const [a] = accounts(db, 1);
  withdrawPending(db, "w16", 1000);
  const only = split(db, "w16", { self_rows: [{ bank_account_id: a, amount: 400 }] });
  const { rows } = deleteGroup(db, only.transfer_group_id);
  skipPendingTx(db, "alpha", "w16", actor, "先放着");
  const deleted = db.prepare("SELECT * FROM bank_ledger_deleted WHERE original_id = ?").get(rows[0].id);

  assert.equal(restoreConflictForDeleted(db, deleted), null);
  assert.equal(restoreRow(db, deleted), "pending");
  assert.equal(pendingRow(db, "w16").state, "pending", "账上有钱的单不能停在已跳过");
  assert.ok(balanceLog(db, "w16"));
});
