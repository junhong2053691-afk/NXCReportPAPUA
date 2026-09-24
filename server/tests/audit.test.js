const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const {
  appendAuditEvent,
  backfillAuditHistory,
  ensureAuditSchema,
  requireReason,
  runAtomic,
} = require("../lib/auditLog");
const { upsertTransactions } = require("../services/sync");
const {
  approvePendingTx,
  deleteSkippedPendingTx,
  restoreSkippedPendingTx,
  skipPendingTx,
} = require("../lib/bankApply");
const { requireAdmin } = require("../middleware");

function database() {
  const db = new Database(":memory:");
  ensureAuditSchema(db);
  return db;
}

test("audit events are company-scoped, deduplicated, and redact credentials", () => {
  const db = database();
  const id = appendAuditEvent(db, {
    companyId: "alpha",
    action: "ledger.created",
    source: "user",
    actor: { type: "user", userId: 7, username: "ops", name: "Operator", role: "operator" },
    summary: "created",
    before: { amount: 10, password: "secret", nested: { access_token: "secret", ok: true } },
    refs: [{ type: "ledger", id: 12 }, { type: "ledger", id: 12 }],
    dedupeKey: "one",
  });
  const duplicate = appendAuditEvent(db, {
    companyId: "alpha",
    action: "ledger.created",
    refs: [{ type: "transaction", id: "tx-1" }],
    dedupeKey: "one",
  });
  assert.equal(id, duplicate);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_event_refs").get().n, 2);
  const payload = JSON.parse(db.prepare("SELECT before_json FROM audit_events WHERE id=?").get(id).before_json);
  assert.equal(payload.password, undefined);
  assert.equal(payload.nested.access_token, undefined);
  assert.equal(payload.nested.ok, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE company_id='beta'").get().n, 0);
  db.close();
});

test("business changes roll back when audit insertion fails", () => {
  const db = database();
  db.exec("CREATE TABLE business_rows (id INTEGER PRIMARY KEY, value TEXT)");
  assert.throws(() => runAtomic(db, () => {
    db.prepare("INSERT INTO business_rows(value) VALUES (?)").run("must rollback");
    appendAuditEvent(db, { companyId: "alpha", action: "" });
  }));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM business_rows").get().n, 0);
  db.close();
});

test("audit events and references are database-level append-only", () => {
  const db = database();
  const id = appendAuditEvent(db, {
    companyId: "alpha",
    action: "ledger.created",
    refs: [{ type: "ledger", id: "101" }],
  });
  assert.throws(
    () => db.prepare("UPDATE audit_events SET summary='tampered' WHERE id=?").run(id),
    /append-only/,
  );
  assert.throws(
    () => db.prepare("DELETE FROM audit_events WHERE id=?").run(id),
    /append-only/,
  );
  assert.throws(
    () => db.prepare("DELETE FROM audit_event_refs WHERE event_id=?").run(id),
    /append-only/,
  );
  assert.equal(db.prepare("SELECT COUNT(1) n FROM audit_events WHERE id=?").get(id).n, 1);
  assert.equal(db.prepare("SELECT COUNT(1) n FROM audit_event_refs WHERE event_id=?").get(id).n, 1);
  db.close();
});

test("reason validation trims input and enforces required and max length", () => {
  assert.equal(requireReason({ reason: "  duplicate payment  " }), "duplicate payment");
  assert.throws(() => requireReason({ reason: "   " }), /请填写操作原因/);
  assert.throws(() => requireReason({ reason: "x".repeat(501) }), /500/);
});

test("operator cannot access administrator audit endpoints", () => {
  let statusCode = 0;
  let responseBody;
  let nextCalled = false;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  requireAdmin(
    { session: { user: { id: 8, username: "ops", role: "operator" } } },
    response,
    () => { nextCalled = true; },
  );

  assert.equal(statusCode, 403);
  assert.equal(nextCalled, false);
  assert.match(responseBody.error, /管理/);
});

test("known legacy payment history backfill is idempotent", () => {
  const db = database();
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, name TEXT, role TEXT);
    INSERT INTO users VALUES (1, 'ops1', 'Ops One', 'operator');
    CREATE TABLE bank_ledger_deleted (
      id INTEGER PRIMARY KEY, original_id INTEGER, bank_account_id INTEGER, company_id TEXT,
      entry_time TEXT, tx_id TEXT, status TEXT, amount_in REAL, amount_out REAL,
      help_amount REAL, trf_amount REAL, bank_acc TEXT, username TEXT, name TEXT,
      c_status TEXT, other_info TEXT, remark TEXT, auto_generated INTEGER,
      transfer_group_id TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, deleted_by TEXT
    );
    INSERT INTO bank_ledger_deleted VALUES
      (3, 44, 9, 'alpha', '2026-08-01 10:00:00', 'tx-old', 'deposit', 20, 0,
       0, 0, 'Bank', 'cust', 'Customer', '', '', '', 0, '', '2026-08-01 10:00:00',
       '2026-08-01 10:00:00', '2026-08-02 00:00:00', 'ops1');
    CREATE TABLE bank_account_events (
      id INTEGER PRIMARY KEY, company_id TEXT, bank_account_id INTEGER, event TEXT,
      note TEXT, actor TEXT, created_at TEXT
    );
    INSERT INTO bank_account_events VALUES (2, 'alpha', 9, 'banned', 'risk', 'ops1', '2026-08-02 01:00:00');
    CREATE TABLE bank_tx_pending (
      id INTEGER PRIMARY KEY, company_id TEXT, tx_id TEXT, tx_type TEXT, amount REAL,
      username TEXT, name TEXT, tx_time TEXT, state TEXT, bank_account_id INTEGER,
      approve_mode TEXT, c_status TEXT, approved_entry_time TEXT, approved_at TEXT,
      approved_by TEXT, decided_at TEXT, decided_by TEXT, created_at TEXT
    );
    INSERT INTO bank_tx_pending VALUES
      (5, 'alpha', 'tx-skip', 'WITHDRAW', 30, 'cust', 'Customer', '2026-08-02 02:00:00',
       'skipped', 0, '', '', '', NULL, '', '2026-08-02 03:00:00', 'ops1', '2026-08-02 02:00:00');
  `);
  assert.equal(backfillAuditHistory(db), 3);
  const count = db.prepare("SELECT COUNT(*) n FROM audit_events").get().n;
  assert.equal(count, 3);
  assert.equal(backfillAuditHistory(db), 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events").get().n, count);
  const actor = db.prepare("SELECT actor_user_id, actor_username FROM audit_events WHERE action='ledger.deleted'").get();
  assert.deepEqual(actor, { actor_user_id: 1, actor_username: "ops1" });
  db.close();
});

function transactionSchema(db) {
  db.exec(`
    CREATE TABLE transactions (
      company_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT, customer_id TEXT,
      username TEXT, name TEXT, mobile TEXT, amount REAL, bank_name TEXT,
      bank_account_name TEXT, bank_account_number TEXT, bank_bsb TEXT, payid TEXT,
      method TEXT, status TEXT, attachment_url TEXT, created_at TEXT, created_date TEXT,
      processed_at TEXT, completed_at TEXT, operator TEXT, remark TEXT, promo_id TEXT,
      promo_name TEXT, synced_at TEXT, PRIMARY KEY(company_id, id)
    )
  `);
}

function tx(overrides = {}) {
  return {
    company_id: "alpha", id: "tx-new", type: "DEPOSIT", customer_id: "c1",
    username: "customer", name: "Customer", mobile: "", amount: 100,
    bank_name: "", bank_account_name: "", bank_account_number: "", bank_bsb: "",
    payid: "", method: "online", status: "PENDING", attachment_url: "",
    created_at: "2026-08-12T00:00:00.000Z", created_date: "2026-08-12",
    processed_at: "", completed_at: "", operator: "", remark: "", promo_id: "",
    promo_name: "", synced_at: "2026-08-12T00:00:01.000Z", ...overrides,
  };
}

test("platform sync records first arrival and only meaningful changes", () => {
  const db = database();
  transactionSchema(db);
  upsertTransactions(db, [tx()]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events").get().n, 1);
  assert.equal(db.prepare("SELECT action FROM audit_events").get().action, "platform_transaction.synced");

  upsertTransactions(db, [tx({ synced_at: "2026-08-12T00:00:02.000Z" })]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events").get().n, 1);

  upsertTransactions(db, [tx({ status: "SUCCESS", synced_at: "2026-08-12T00:00:03.000Z" })]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events").get().n, 2);
  const changed = db.prepare("SELECT after_json FROM audit_events WHERE action='platform_transaction.changed'").get();
  assert.deepEqual(JSON.parse(changed.after_json), { status: "SUCCESS" });
  db.close();
});

function paymentWorkflowSchema(db) {
  db.exec(`
    CREATE TABLE bank_tx_pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT, tx_id TEXT, tx_type TEXT,
      amount REAL, username TEXT, name TEXT, tx_time TEXT, state TEXT,
      bank_account_id INTEGER DEFAULT 0, approve_mode TEXT DEFAULT '', c_status TEXT DEFAULT '',
      approved_entry_time TEXT DEFAULT '', approved_at TEXT, approved_by TEXT DEFAULT '',
      decided_at TEXT, decided_by TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(company_id, tx_id)
    );
    CREATE TABLE bank_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bank_account_id INTEGER DEFAULT 0,
      company_id TEXT, entry_time TEXT, tx_id TEXT, status TEXT, amount_in REAL DEFAULT 0,
      amount_out REAL DEFAULT 0, help_amount REAL DEFAULT 0, trf_amount REAL DEFAULT 0,
      bank_acc TEXT DEFAULT '', username TEXT DEFAULT '', name TEXT DEFAULT '', c_status TEXT DEFAULT '',
      other_info TEXT DEFAULT '', remark TEXT DEFAULT '', auto_generated INTEGER DEFAULT 0,
      transfer_group_id TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE bank_balance_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bank_account_id INTEGER, tx_id TEXT UNIQUE,
      amount REAL DEFAULT 0, applied_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

test("pending skip, restore, delete and approval preserve actor and reason history", () => {
  const db = database();
  paymentWorkflowSchema(db);
  const insert = db.prepare(`
    INSERT INTO bank_tx_pending
      (company_id, tx_id, tx_type, amount, username, name, tx_time, state)
    VALUES ('alpha', ?, 'WITHDRAW', 50, 'cust', 'Customer', '2026-08-12 10:00:00', 'pending')
  `);
  const actor = { type: "user", userId: 9, username: "ops9", name: "Ops Nine", role: "operator" };

  insert.run("tx-state");
  skipPendingTx(db, "alpha", "tx-state", actor, "waiting for confirmation");
  restoreSkippedPendingTx(db, "alpha", "tx-state", actor, "customer confirmed");
  skipPendingTx(db, "alpha", "tx-state", actor, "duplicate order");
  deleteSkippedPendingTx(db, "alpha", "tx-state", actor, "confirmed duplicate");
  const stateEvents = db.prepare("SELECT action, reason, actor_username FROM audit_events WHERE company_id='alpha' ORDER BY id").all();
  assert.deepEqual(stateEvents.map((row) => row.action), [
    "pending.skipped", "pending.restored", "pending.skipped", "pending.deleted",
  ]);
  assert.equal(stateEvents[3].reason, "confirmed duplicate");
  assert.equal(stateEvents[3].actor_username, "ops9");

  insert.run("tx-approve");
  const result = approvePendingTx(db, "alpha", "tx-approve", { mode: "redeposit", remark: "no cash" }, actor);
  assert.ok(result.ledger.id);
  const approval = db.prepare("SELECT * FROM audit_events WHERE action='pending.approved'").get();
  assert.equal(approval.actor_user_id, 9);
  const refTypes = db.prepare("SELECT ref_type FROM audit_event_refs WHERE event_id=? ORDER BY ref_type").all(approval.id).map((row) => row.ref_type);
  assert.deepEqual(refTypes, ["ledger", "pending", "transaction"]);
  db.close();
});
