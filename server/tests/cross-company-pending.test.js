// 跨公司来单提醒的数据源（lib/crossCompanyPending.js + GET /api/banks/pending-tx/all-companies）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { bankDatabase, addCompany } = require("./bank-fixture");
const { crossCompanyPending, MAX_ROWS_PER_COMPANY } = require("../lib/crossCompanyPending");

const OPERATOR = { id: 7, role: "operator" };
const ADMIN = { id: 1, role: "admin" };

function setup() {
  const db = bankDatabase();
  db.exec(`
    CREATE TABLE user_companies (user_id INTEGER NOT NULL, company_id TEXT NOT NULL, PRIMARY KEY (user_id, company_id));
    CREATE TABLE bank_tx_pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL DEFAULT '',
      tx_id TEXT NOT NULL DEFAULT '',
      tx_type TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL DEFAULT 0,
      username TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      tx_time TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'pending'
    );
  `);
  addCompany(db, { id: "aussiex6", name: "AussieX6", sort_order: 1 });
  addCompany(db, { id: "rolex66", name: "Rolex66", sort_order: 2 });
  addCompany(db, { id: "ezspin68", name: "EzSpin68", sort_order: 3 });
  return db;
}

function grant(db, userId, ...companyIds) {
  for (const cid of companyIds) db.prepare("INSERT INTO user_companies VALUES (?, ?)").run(userId, cid);
}

function pending(db, companyId, extra = {}) {
  const info = db
    .prepare("INSERT INTO bank_tx_pending (company_id, tx_id, tx_type, amount, username, name, state) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(companyId, extra.tx_id || `T${Math.random()}`, extra.tx_type || "DEPOSIT", extra.amount ?? 500, extra.username || "user123", extra.name || "Real Name", extra.state || "pending");
  return Number(info.lastInsertRowid);
}

test("operator 只拿到自己授权的公司，含当前公司（前端要用它记已看过）", () => {
  const db = setup();
  grant(db, OPERATOR.id, "aussiex6", "rolex66");
  const a = pending(db, "aussiex6");
  const r = pending(db, "rolex66", { tx_type: "WITHDRAW", amount: 120.5, username: "bob" });
  pending(db, "ezspin68"); // 未授权
  const out = crossCompanyPending(db, OPERATOR, "aussiex6");
  assert.equal(out.enabled, true);
  assert.equal(out.current, "aussiex6");
  assert.deepEqual(out.companies, [{ id: "aussiex6", name: "AussieX6" }, { id: "rolex66", name: "Rolex66" }]);
  assert.deepEqual(out.rows.map((x) => x.id), [r, a], "按 id 倒序，新单在前");
  assert.deepEqual(out.rows[0], { id: r, company_id: "rolex66", tx_type: "WITHDRAW", amount: 120.5, username: "bob" });
});

test("不带客户真名，只给通知要用的字段", () => {
  const db = setup();
  grant(db, OPERATOR.id, "aussiex6", "rolex66");
  pending(db, "rolex66");
  const [row] = crossCompanyPending(db, OPERATOR, "aussiex6").rows;
  assert.deepEqual(Object.keys(row).sort(), ["amount", "company_id", "id", "tx_type", "username"]);
});

test("只列 state = 'pending'：审批 / 跳过掉的不再出现（前端据此收起那一条）", () => {
  const db = setup();
  grant(db, OPERATOR.id, "aussiex6", "rolex66");
  const live = pending(db, "rolex66");
  pending(db, "rolex66", { state: "approved" });
  pending(db, "rolex66", { state: "skipped" });
  assert.deepEqual(crossCompanyPending(db, OPERATOR, "aussiex6").rows.map((x) => x.id), [live]);
});

test("上限按公司算：一家积压超过上限，别家较早的单仍在结果里（否则前端会清掉那家的共用报警）", () => {
  const db = setup();
  grant(db, OPERATOR.id, "aussiex6", "rolex66");
  const old = pending(db, "rolex66");
  const insert = db.transaction(() => {
    for (let i = 0; i < MAX_ROWS_PER_COMPANY + 5; i++) pending(db, "aussiex6");
  });
  insert();
  const rows = crossCompanyPending(db, OPERATOR, "rolex66").rows;
  assert.ok(rows.some((x) => x.id === old), "Rolex66 的单没被 AussieX6 的积压挤掉");
  assert.equal(rows.filter((x) => x.company_id === "aussiex6").length, MAX_ROWS_PER_COMPANY);
  assert.equal(rows[0].company_id, "aussiex6", "仍按 id 倒序");
});

test("撤权按库复核：下一次请求就看不到那家", () => {
  const db = setup();
  grant(db, OPERATOR.id, "aussiex6", "rolex66", "ezspin68");
  pending(db, "ezspin68");
  assert.equal(crossCompanyPending(db, OPERATOR, "aussiex6").rows.length, 1);
  db.prepare("DELETE FROM user_companies WHERE company_id = 'ezspin68'").run();
  const out = crossCompanyPending(db, OPERATOR, "aussiex6");
  assert.equal(out.rows.length, 0);
  assert.ok(!out.companies.some((c) => c.id === "ezspin68"));
});

test("admin 不弹：返回 enabled=false 且一行不给", () => {
  const db = setup();
  pending(db, "rolex66");
  assert.deepEqual(crossCompanyPending(db, ADMIN, "aussiex6"), { enabled: false, current: "aussiex6", companies: [], rows: [] });
});

test("只授权一家的 operator、未登录：没有「别家」，enabled=false", () => {
  const db = setup();
  grant(db, OPERATOR.id, "aussiex6");
  pending(db, "aussiex6");
  assert.equal(crossCompanyPending(db, OPERATOR, "aussiex6").enabled, false);
  assert.equal(crossCompanyPending(db, null, "").enabled, false);
});

test("路由接线：GET /pending-tx/all-companies 用 session 用户 + req.companyId", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../routes/banks.js"), "utf8");
  assert.match(
    routes,
    /router\.get\("\/pending-tx\/all-companies", \(req, res\) => \{\s*res\.json\(crossCompanyPending\(getDb\(\), req\.session\?\.user, companyId\(req\)\)\);/
  );
});
