// TOP REFERRAL 接口：仅 admin、公司只认 req.companyId（session），不吃 query 里的公司参数。
// 起一个真的 data 路由（临时库 + 假 session），从 HTTP 层验证。口径本身由 top-referral.test.js 守着。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..", "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "top-referral-route-"));
// 必须在 require 路由之前设：db/init 在模块加载时就定下库路径。
process.env.TRADER_DB = path.join(tmpDir, "trader.db");
process.env.TRADER_CONFIG = path.join(projectRoot, "config.example.json");
process.env.TRADER_STATE_DIR = tmpDir;

const express = require("express");
const { getDb } = require("../db/init");
const dataRouter = require("../routes/data");

function seed() {
  const db = getDb();
  const company = db.prepare("INSERT OR REPLACE INTO companies (id, name, enabled, sort_order) VALUES (?, ?, 1, ?)");
  company.run("alpha", "Alpha", 1);
  company.run("beta", "Beta", 2);
  const customer = db.prepare(
    "INSERT INTO customers (company_id, id, username, name, referrer, register_date_key) VALUES (?, ?, ?, ?, ?, ?)"
  );
  customer.run("alpha", "a1", "alice", "Alice", "PK7", "2026-11-02");
  customer.run("beta", "b1", "bob", "Bob", "BETA ONLY", "2026-11-03");
  db.prepare(
    `INSERT INTO transactions (company_id, id, type, customer_id, username, name, amount, status, created_at, created_date)
     VALUES ('alpha', 'tx1', 'DEPOSIT', 'a1', 'alice', 'Alice', 40, 'COMPLETED', '2026-11-02 10:00', '2026-11-02')`
  ).run();
}

/** 假 session：x-role 头决定角色，公司固定是 session 里的 alpha。 */
function startServer() {
  const app = express();
  app.use((req, res, next) => {
    const role = req.get("x-role");
    req.session = role ? { user: { id: 1, username: role, role }, companyId: "alpha" } : {};
    next();
  });
  app.use("/api/data", dataRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

let server;
let base;

test.before(async () => {
  seed();
  server = await startServer();
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server?.close();
  getDb().close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const get = (url, role) => fetch(base + url, { headers: role ? { "x-role": role } : {} });

test("admin 拿到 session 公司的排行；query 里塞别家公司也没用", async () => {
  const res = await get("/api/data/top-referral?month=2026-11&company=beta&companyId=beta", "admin");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.companyId, "alpha");
  assert.deepEqual(body.rows.map((r) => [r.referrer, r.newMember, r.dep]), [["PK7", 1, 40]]);
  assert.deepEqual(body.referrers, ["PK7"]);
});

test("抽屉接口同样只读 session 公司", async () => {
  const res = await get("/api/data/top-referral/referrer?month=2026-11&referrer=PK7&companyId=beta", "admin");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.companyId, "alpha");
  assert.deepEqual(body.downlines.map((d) => d.username), ["alice"]);
  const other = await (await get("/api/data/top-referral/referrer?month=2026-11&referrer=BETA%20ONLY", "admin")).json();
  assert.deepEqual(other.downlines, []);
});

test("非 admin 一律拒绝：operator 403，其他角色 403，未登录 401", async () => {
  for (const url of ["/api/data/top-referral?month=2026-11", "/api/data/top-referral/referrer?referrer=PK7"]) {
    assert.equal((await get(url, "operator")).status, 403, url);
    assert.equal((await get(url, "viewer")).status, 403, url);
    assert.equal((await get(url)).status, 401, url);
  }
});
