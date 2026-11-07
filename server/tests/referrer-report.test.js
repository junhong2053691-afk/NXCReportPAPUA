// 推荐人榜（/api/data/referrer-leaderboard）与推荐人报告（/api/data/referrer-report）的口径。
// 2026-11 为了性能把「customers LEFT JOIN CTE」改成按客户在 JS 里拼（见 referrerReport.js 顶部），
// 这里守住改写前后必须一致的每一条规则。
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { computeReferrerLeaderboard, computeReferrerReport, ORGANIC_KEY } = require("../lib/referrerReport");

function referrerDatabase() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE customers (
      company_id TEXT NOT NULL, id TEXT NOT NULL,
      username TEXT DEFAULT '', name TEXT DEFAULT '', mobile TEXT DEFAULT '', referrer TEXT DEFAULT '',
      register_date TEXT DEFAULT '', register_date_key TEXT DEFAULT '', last_login_date TEXT DEFAULT '',
      dep_count INTEGER DEFAULT 0, dep_total REAL DEFAULT 0, wd_total REAL DEFAULT 0,
      last_deposit TEXT DEFAULT '', last_login TEXT DEFAULT '',
      PRIMARY KEY (company_id, id)
    );
    CREATE TABLE transactions (
      company_id TEXT NOT NULL, id TEXT NOT NULL,
      type TEXT DEFAULT '', customer_id TEXT DEFAULT '',
      username TEXT DEFAULT '', name TEXT DEFAULT '', mobile TEXT DEFAULT '',
      amount REAL DEFAULT 0, status TEXT DEFAULT 'COMPLETED',
      created_at TEXT DEFAULT '', created_date TEXT DEFAULT '',
      PRIMARY KEY (company_id, id)
    );
  `);
  return db;
}

let seq = 0;
function addCustomer(db, referrer, registerDate, opts = {}) {
  const id = opts.id || `c${++seq}`;
  db.prepare(
    `INSERT INTO customers (company_id, id, username, name, mobile, referrer, register_date, register_date_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(opts.company || "alpha", id, `user${seq}`, `Name ${seq}`, opts.mobile || "", referrer, registerDate + " 10:00:00", registerDate);
  return id;
}
function addTx(db, customerId, type, amount, date, opts = {}) {
  db.prepare(
    `INSERT INTO transactions (company_id, id, type, customer_id, mobile, amount, created_at, created_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(opts.company || "alpha", `t${++seq}`, type, customerId, opts.mobile || "", amount, date + " 12:00:00", date);
}
const lbRow = (report, key) => report.rows.find((r) => r.referrer_key === key);

test("区间榜：新注册、首充（看全部历史的第一笔）、充值人数与金额都只算区间内；推荐人首尾空格归一，空推荐人归自然流量", () => {
  const db = referrerDatabase();
  const a = addCustomer(db, "PK7", "2026-11-02");
  const b = addCustomer(db, " PK7 ", "2026-10-01"); // 老客户，10 月就首充过
  const c = addCustomer(db, "", "2026-11-03");
  addTx(db, a, "DEPOSIT", 50, "2026-11-02");
  addTx(db, a, "DEPOSIT", 20, "2026-11-04");
  addTx(db, b, "DEPOSIT", 10, "2026-10-02");
  addTx(db, b, "DEPOSIT", 30, "2026-11-03");
  addTx(db, b, "WITHDRAW", 15, "2026-11-05");
  addTx(db, c, "DEPOSIT", 5, "2026-11-03");

  const report = computeReferrerLeaderboard(db, "2026-11-01", "2026-11-07", { companyId: "alpha" });
  const pk7 = lbRow(report, "PK7");
  assert.equal(pk7.total_customers, 2);
  assert.equal(pk7.new_regs, 1, "b 是 10 月注册的");
  assert.equal(pk7.first_dep_count, 1, "b 的首充在 10 月，不算本区间首充");
  assert.equal(pk7.dep_users, 2);
  assert.equal(pk7.dep_total, 100);
  assert.equal(pk7.wd_total, 15);
  const organic = lbRow(report, ORGANIC_KEY);
  assert.equal(organic.new_regs, 1);
  assert.equal(organic.first_dep_count, 1);
  assert.equal(organic.dep_total, 5);
});

test("区间榜：区间内毫无动静的推荐人不上榜，但 total_customers 照算该推荐人的全部下线", () => {
  const db = referrerDatabase();
  addCustomer(db, "QUIET", "2026-01-05");
  const x = addCustomer(db, "BUSY", "2026-01-05");
  addCustomer(db, "BUSY", "2026-02-05");
  addTx(db, x, "DEPOSIT", 40, "2026-11-03");

  const report = computeReferrerLeaderboard(db, "2026-11-01", "2026-11-07", { companyId: "alpha" });
  assert.equal(lbRow(report, "QUIET"), undefined);
  assert.equal(lbRow(report, "BUSY").total_customers, 2);
  assert.equal(report.total, 1);
});

test("首充按手机号回退归属：交易没有 customer_id 时用手机号认人", () => {
  const db = referrerDatabase();
  addCustomer(db, "PK7", "2026-10-01", { mobile: "0400111222" });
  addTx(db, "", "DEPOSIT", 25, "2026-11-04", { mobile: "0400111222" });

  const report = computeReferrerLeaderboard(db, "2026-11-01", "2026-11-07", { companyId: "alpha" });
  assert.equal(lbRow(report, "PK7").first_dep_count, 1);
});

test("公司隔离：别家同名推荐人、同 id 客户的交易都不算进来", () => {
  const db = referrerDatabase();
  const id = addCustomer(db, "PK7", "2026-11-02", { id: "same" });
  addCustomer(db, "PK7", "2026-11-02", { id: "same", company: "beta" });
  addTx(db, id, "DEPOSIT", 10, "2026-11-02");
  addTx(db, "same", "DEPOSIT", 999, "2026-11-02", { company: "beta" });

  const report = computeReferrerLeaderboard(db, "2026-11-01", "2026-11-07", { companyId: "alpha" });
  assert.equal(lbRow(report, "PK7").total_customers, 1);
  assert.equal(lbRow(report, "PK7").dep_total, 10);
});

test("累计榜（sort=total_sum）：人人都算新注册；充值人数只数充值额 > 0 的人", () => {
  const db = referrerDatabase();
  const a = addCustomer(db, "PK7", "2025-03-01");
  const b = addCustomer(db, "PK7", "2026-03-01");
  addCustomer(db, "PK7", "2026-04-01");
  addTx(db, a, "DEPOSIT", 70, "2025-03-02");
  addTx(db, b, "WITHDRAW", 20, "2026-03-05"); // 只有提现

  const report = computeReferrerLeaderboard(db, null, null, { sort: "total_sum", companyId: "alpha" });
  const pk7 = lbRow(report, "PK7");
  assert.equal(pk7.total_customers, 3);
  assert.equal(pk7.new_regs, 3);
  assert.equal(pk7.first_dep_count, 1);
  assert.equal(pk7.dep_users, 1);
  assert.equal(pk7.dep_total, 70);
  assert.equal(pk7.wd_total, 20);
});

test("推荐人报告：名单带首充日期；new_today / first_dep_today 两个分段按区间筛人", () => {
  const db = referrerDatabase();
  const a = addCustomer(db, "PK7", "2026-11-02");
  const b = addCustomer(db, "PK7", "2026-09-01");
  const c = addCustomer(db, "PK7", "2026-08-01");
  addTx(db, b, "DEPOSIT", 10, "2026-11-03"); // 老客户本区间首充
  addTx(db, c, "DEPOSIT", 10, "2026-08-02"); // 早就首充过

  const all = computeReferrerReport(db, "PK7", "2026-11-01", "2026-11-07", { companyId: "alpha" });
  assert.equal(all.summary.total_customers, 3);
  assert.deepEqual(all.customers.map((x) => x.id), [a, b, c], "按注册时间倒序");
  assert.deepEqual(all.customers.map((x) => x.first_dep_date), [null, "2026-11-03", "2026-08-02"]);

  const fresh = computeReferrerReport(db, "PK7", "2026-11-01", "2026-11-07", { segment: "new_today", companyId: "alpha" });
  assert.deepEqual(fresh.customers.map((x) => x.id), [a]);

  const firstDep = computeReferrerReport(db, "PK7", "2026-11-01", "2026-11-07", { segment: "first_dep_today", companyId: "alpha" });
  assert.deepEqual(firstDep.customers.map((x) => x.id), [b]);
});
