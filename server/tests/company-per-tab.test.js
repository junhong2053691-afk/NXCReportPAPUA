// 每个标签页各管各的公司：公司来自请求头 X-Company-Id（每次按库复核授权），
// session 里的 companyId 只是「新标签页的默认值」。
// 起真的 resolveCompany + companies 路由（临时库 + 假 session），从 HTTP 层验证。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..", "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "company-per-tab-"));
// 必须在 require 路由之前设：db/init 在模块加载时就定下库路径。
process.env.TRADER_DB = path.join(tmpDir, "trader.db");
process.env.TRADER_CONFIG = path.join(projectRoot, "config.example.json");
process.env.TRADER_STATE_DIR = tmpDir;

const express = require("express");
const { getDb } = require("../db/init");
const { resolveCompany } = require("../middleware");
const companiesRouter = require("../routes/companies");

const OPERATOR_ID = 7;

function seed() {
  const db = getDb();
  db.prepare("DELETE FROM companies").run();
  const company = db.prepare("INSERT OR REPLACE INTO companies (id, name, enabled, sort_order) VALUES (?, ?, 1, ?)");
  company.run("alpha", "Alpha", 1);
  company.run("beta", "Beta", 2);
  company.run("gamma", "Gamma", 3);
  // 假 session 里的 admin（id 1）必须真在库里：受限 admin 上线后（admin-company-scope.test.js），
  // 库里查不到的 admin 按受限处理（失败要关门）。
  db.prepare(
    "INSERT OR REPLACE INTO users (id, username, password_hash, name, role, status, company_scope) VALUES (1, 'admin', 'x', 'admin', 'admin', 'active', 'all')"
  ).run();
  // operator 只授权 alpha、beta。
  const grant = db.prepare("INSERT OR REPLACE INTO user_companies (user_id, company_id) VALUES (?, ?)");
  grant.run(OPERATOR_ID, "alpha");
  grant.run(OPERATOR_ID, "beta");
}

/** 假 session：x-role 决定角色，session 默认公司固定 alpha；每个请求的 session 对象可从 sessions 取回。 */
const sessions = [];
function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const role = req.get("x-role");
    req.session = role
      ? { user: { id: role === "operator" ? OPERATOR_ID : 1, username: role, role }, companyId: "alpha" }
      : {};
    sessions.push(req.session);
    next();
  });
  app.use(resolveCompany);
  app.get("/probe", (req, res) => res.json({ companyId: req.companyId || null, session: req.session.companyId || null }));
  app.use("/api/companies", companiesRouter);
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

function get(url, role, company) {
  const headers = {};
  if (role) headers["x-role"] = role;
  if (company != null) headers["x-company-id"] = company;
  return fetch(base + url, { headers });
}

test("头里的公司合法 → req.companyId 跟头走，session 默认值不被改", async () => {
  const res = await get("/probe", "operator", "beta");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { companyId: "beta", session: "alpha" });
  const admin = await (await get("/probe", "admin", "gamma")).json();
  assert.deepEqual(admin, { companyId: "gamma", session: "alpha" });
});

test("头里的公司大小写 / 空白不敏感", async () => {
  const body = await (await get("/probe", "operator", "  BETA ")).json();
  assert.equal(body.companyId, "beta");
});

test("operator 带未授权公司的头 → 403 COMPANY_NOT_ALLOWED，绝不回退到别家", async () => {
  const res = await get("/probe", "operator", "gamma");
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "COMPANY_NOT_ALLOWED");
});

test("admin 带不存在的公司 → 403 COMPANY_NOT_ALLOWED", async () => {
  const res = await get("/probe", "admin", "nope");
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "COMPANY_NOT_ALLOWED");
});

test("没有头 → 维持旧行为：用 session 公司", async () => {
  const body = await (await get("/probe", "operator")).json();
  assert.deepEqual(body, { companyId: "alpha", session: "alpha" });
});

test("响应带 Vary: X-Company-Id，免得被缓存串公司", async () => {
  const res = await get("/probe", "admin", "beta");
  assert.match(res.headers.get("vary") || "", /x-company-id/i);
});

test("GET /api/companies 的 active 是本标签页（头里）的公司，且不改 session 默认值", async () => {
  const before = sessions.length;
  const res = await get("/api/companies", "operator", "beta");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.active, "beta");
  assert.deepEqual(body.companies.map((c) => c.id), ["alpha", "beta"]);
  assert.equal(sessions[before].companyId, "alpha");
});

test("GET /api/companies 没有头 → active 是 session 默认值", async () => {
  const body = await (await get("/api/companies", "admin")).json();
  assert.equal(body.active, "alpha");
});
