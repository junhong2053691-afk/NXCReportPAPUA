// 对账补单（repairDayTypes）补进来的 DEPOSIT / WITHDRAW 必须进待审批队列。
// 2026-11-13 ezspin68 17269528700：23:55 下单、过午夜才完成，快车道只拉「今天」看不到它，
// 只能靠昨日对账补进来——而补单当时只写 transactions，于是实时交易有、接单区永远没有。
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const { repairDayTypes } = require("../lib/syncIntegrity");

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE transactions (
      company_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT, username TEXT, name TEXT,
      amount REAL, created_at TEXT, customer_id TEXT,
      PRIMARY KEY (company_id, id)
    );
    CREATE TABLE bank_tx_pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL DEFAULT '', tx_id TEXT NOT NULL DEFAULT '',
      tx_type TEXT NOT NULL DEFAULT '', amount REAL NOT NULL DEFAULT 0,
      username TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
      tx_time TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'pending',
      UNIQUE(company_id, tx_id)
    );
    CREATE TABLE bank_balance_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bank_account_id INTEGER NOT NULL,
      tx_id TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, UNIQUE(tx_id)
    );
  `);
  return d;
}

function helpers(rowsByType) {
  return {
    fetchTransactionsInRange: async (_s, _e, _cfg, opts) => rowsByType[opts.type] || [],
    mapTransaction: (t) => ({ ...t }),
    upsertTransactions: (d, rows) => {
      const ins = d.prepare(
        `INSERT INTO transactions (company_id, id, type, username, name, amount, created_at, customer_id)
         VALUES (@company_id, @id, @type, @username, @name, @amount, @created_at, @customer_id)
         ON CONFLICT(company_id, id) DO UPDATE SET amount = excluded.amount`
      );
      for (const r of rows) ins.run({ username: "", name: "", customer_id: "", ...r });
      return rows.length;
    },
  };
}

const tx = (id, type, extra = {}) => ({
  id, type, amount: 10, username: "u1", name: "Corey", created_at: "2026-11-12T12:55:38+00:00", ...extra,
});

test("补单新插入的 DEPOSIT / WITHDRAW 进待审批队列", async () => {
  const d = db();
  await repairDayTypes(
    d,
    ["DEPOSIT", "WITHDRAW"],
    helpers({ DEPOSIT: [tx("D1", "DEPOSIT")], WITHDRAW: [tx("W1", "WITHDRAW", { amount: 50 })] }),
    { companyId: "ez", date: "2026-11-12" }
  );
  const rows = d.prepare("SELECT company_id, tx_id, tx_type, amount, state FROM bank_tx_pending ORDER BY tx_id").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { company_id: "ez", tx_id: "D1", tx_type: "DEPOSIT", amount: 10, state: "pending" },
    { company_id: "ez", tx_id: "W1", tx_type: "WITHDRAW", amount: 50, state: "pending" },
  ]);
});

test("库里已有的单不重新入队（被删掉的待审批行不会被翻出来）", async () => {
  const d = db();
  d.prepare("INSERT INTO transactions (company_id, id, type, amount) VALUES ('ez', 'OLD', 'DEPOSIT', 10)").run();
  await repairDayTypes(
    d,
    ["DEPOSIT"],
    helpers({ DEPOSIT: [tx("OLD", "DEPOSIT"), tx("NEW", "DEPOSIT")] }),
    { companyId: "ez", date: "2026-11-12" }
  );
  const ids = d.prepare("SELECT tx_id FROM bank_tx_pending").all().map((r) => r.tx_id);
  assert.deepEqual(ids, ["NEW"]);
});

test("非资金类型（BONUS 等）不入队；已入账的 tx_id 不入队", async () => {
  const d = db();
  d.prepare("INSERT INTO bank_balance_log (bank_account_id, tx_id, amount) VALUES (1, 'PAID', 10)").run();
  await repairDayTypes(
    d,
    ["BONUS", "DEPOSIT"],
    helpers({ BONUS: [tx("B1", "BONUS")], DEPOSIT: [tx("PAID", "DEPOSIT")] }),
    { companyId: "ez", date: "2026-11-12" }
  );
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM bank_tx_pending").get().n, 0);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM transactions").get().n, 2, "交易表照常补齐");
});
