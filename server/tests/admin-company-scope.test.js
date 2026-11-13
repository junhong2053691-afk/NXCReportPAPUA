// admin 也能限定公司（2026-11-13）：users.company_scope = 'all'（全部公司 admin）/ 'limited'（受限 admin，
// 只看 user_companies 里那几家）。规矩（用户定的）：
//   · 只有全部公司 admin 能给别的 admin 设范围；受限 admin 不能改任何 admin、不能给自己放宽
//   · 受限 admin 可以：改自己公司的公司 / API 设置、管自己公司的 operator、总控 Telegram 设置
//   · 受限 admin 不可以：新建 / 删除公司、数据库备份
// 起真的 resolveCompany + companies + admin 路由（临时库 + 假 session），从 HTTP 层验证。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..", "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-company-scope-"));
// 必须在 require 路由之前设：db/init 在模块加载时就定下库路径。
process.env.TRADER_DB = path.join(tmpDir, "trader.db");
process.env.TRADER_CONFIG = path.join(projectRoot, "config.example.json");
process.env.TRADER_STATE_DIR = tmpDir;
process.env.TRADER_BACKUP_DIR = path.join(tmpDir, "backups");

const express = require("express");
const { getDb } = require("../db/init");
const { resolveCompany } = require("../middleware");
const userAccess = require("../lib/userAccess");
const companiesRouter = require("../routes/companies");
const adminRouter = require("../routes/admin");

const HASH = "$2a$10$abcdefghijklmnopqrstuuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012"; // 只占位，不登录
const ids = {};

function seed() {
  const db = getDb();
  db.prepare("DELETE FROM companies").run();
  const company = db.prepare("INSERT INTO companies (id, name, enabled, sort_order) VALUES (?, ?, 0, ?)");
  company.run("alpha", "Alpha", 1);
  company.run("beta", "Beta", 2);
  company.run("gamma", "Gamma", 3);
  db.prepare("DELETE FROM user_companies").run();
  db.prepare("DELETE FROM users").run();
  const user = db.prepare("INSERT INTO users (username, password_hash, name, role, status, company_scope) VALUES (?, ?, ?, ?, 'active', ?)");
  const grant = db.prepare("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)");
  const add = (username, role, scope, companies = []) => {
    const id = Number(user.run(username, HASH, username, role, scope).lastInsertRowid);
    companies.forEach((c) => grant.run(id, c));
    ids[username] = id;
  };
  add("boss", "admin", "all");
  add("boss2", "admin", "all");
  add("lim", "admin", "limited", ["alpha", "beta"]);
  add("lim2", "admin", "limited", ["gamma"]);
  add("op_ab", "operator", "all", ["alpha", "beta"]);
  add("op_b", "operator", "all", ["beta"]);
  add("op_bg", "operator", "all", ["beta", "gamma"]);
  add("op_g", "operator", "all", ["gamma"]);
}

/** 假 session：x-user 头是用户名，按库组 session.user；session 默认公司固定 alpha。 */
function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const name = req.get("x-user");
    const row = name ? getDb().prepare("SELECT id, username, name, role FROM users WHERE username = ?").get(name) : null;
    req.session = row ? { user: { ...row }, companyId: req.get("x-session-company") || "alpha" } : {};
    next();
  });
  app.use("/api/admin", adminRouter);
  app.use(resolveCompany);
  app.get("/probe", (req, res) => res.json({ companyId: req.companyId || null }));
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

function call(method, url, user, { body, company, sessionCompany } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (user) headers["x-user"] = user;
  if (company) headers["x-company-id"] = company;
  if (sessionCompany) headers["x-session-company"] = sessionCompany;
  return fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}
const u = (name) => ({ id: ids[name], role: name.startsWith("op_") ? "operator" : "admin", username: name });

// ---------------------------------------------------------------- userAccess

test("userAccess：全部公司 admin 看全部；受限 admin 只有勾的；operator 不变", () => {
  const db = getDb();
  assert.equal(userAccess.isFullAdmin(db, u("boss")), true);
  assert.equal(userAccess.isFullAdmin(db, u("lim")), false);
  assert.equal(userAccess.isFullAdmin(db, u("op_ab")), false, "operator 的 company_scope 列被忽略");
  assert.equal(userAccess.isCompanyRestricted(db, u("boss")), false);
  assert.equal(userAccess.isCompanyRestricted(db, u("lim")), true);
  assert.equal(userAccess.isCompanyRestricted(db, u("op_ab")), true);

  assert.deepEqual(userAccess.authorizedCompanyIds(db, u("boss")).sort(), ["alpha", "beta", "gamma"]);
  assert.deepEqual(userAccess.authorizedCompanyIds(db, u("lim")).sort(), ["alpha", "beta"]);
  assert.deepEqual(userAccess.listCompaniesForUser(db, u("lim")).map((c) => c.id), ["alpha", "beta"]);
  assert.equal(userAccess.hasCompanyAccess(db, u("lim"), "gamma"), false);
  assert.equal(userAccess.hasCompanyAccess(db, u("lim"), "beta"), true);
  assert.equal(userAccess.hasCompanyAccess(db, u("boss"), "gamma"), true);
  assert.equal(userAccess.firstAuthorizedCompanyId(db, u("lim2")), "gamma");
  assert.deepEqual(userAccess.authorizedCompanyIds(db, u("op_bg")).sort(), ["beta", "gamma"]);
});

test("userAccess：库里找不到这个 admin → 当受限处理（失败要关门，不是开门）", () => {
  const ghost = { id: 99999, role: "admin", username: "ghost" };
  assert.equal(userAccess.isFullAdmin(getDb(), ghost), false);
  assert.deepEqual(userAccess.authorizedCompanyIds(getDb(), ghost), []);
});

// ---------------------------------------------------------------- resolveCompany

test("resolveCompany：受限 admin 带范围外公司的头 → 403；范围内 → 通过", async () => {
  const bad = await call("GET", "/probe", "lim", { company: "gamma" });
  assert.equal(bad.status, 403);
  assert.equal((await bad.json()).code, "COMPANY_NOT_ALLOWED");
  assert.deepEqual(await (await call("GET", "/probe", "lim", { company: "beta" })).json(), { companyId: "beta" });
  assert.deepEqual(await (await call("GET", "/probe", "boss", { company: "gamma" })).json(), { companyId: "gamma" });
});

test("resolveCompany：受限 admin 的 session 公司不在范围 → 回退首个授权公司", async () => {
  const body = await (await call("GET", "/probe", "lim2", { sessionCompany: "alpha" })).json();
  assert.equal(body.companyId, "gamma");
});

test("resolveCompany：撤掉授权下一次请求就生效", async () => {
  const db = getDb();
  db.prepare("INSERT INTO user_companies (user_id, company_id) VALUES (?, 'alpha')").run(ids.lim2);
  assert.equal((await call("GET", "/probe", "lim2", { company: "alpha" })).status, 200);
  db.prepare("DELETE FROM user_companies WHERE user_id = ? AND company_id = 'alpha'").run(ids.lim2);
  assert.equal((await call("GET", "/probe", "lim2", { company: "alpha" })).status, 403);
});

// ---------------------------------------------------------------- 公司路由

test("公司：受限 admin 的列表只有范围内，切到范围外 → 403", async () => {
  const list = await (await call("GET", "/api/companies", "lim")).json();
  assert.deepEqual(list.companies.map((c) => c.id), ["alpha", "beta"]);
  assert.equal((await call("POST", "/api/companies/active", "lim", { body: { id: "gamma" } })).status, 403);
  assert.equal((await call("POST", "/api/companies/active", "lim", { body: { id: "beta" } })).status, 200);
});

test("公司：受限 admin 不能新建 / 删除公司；全部公司 admin 可以", async () => {
  assert.equal((await call("POST", "/api/companies", "lim", { body: { id: "delta", name: "Delta" } })).status, 403);
  assert.equal((await call("DELETE", "/api/companies/beta", "lim", { body: { confirm: "beta" } })).status, 403);
  assert.equal((await call("POST", "/api/companies", "boss", { body: { id: "delta", name: "Delta" } })).status, 201);
  assert.equal((await call("DELETE", "/api/companies/delta", "boss", { body: { confirm: "delta" } })).status, 200);
});

test("公司：受限 admin 只能改 / 测自己范围内的公司设置", async () => {
  assert.equal((await call("PUT", "/api/companies/gamma", "lim", { body: { name: "Hacked" } })).status, 403);
  assert.equal((await call("POST", "/api/companies/gamma/test", "lim", { body: {} })).status, 403);
  assert.equal(getDb().prepare("SELECT name FROM companies WHERE id = 'gamma'").get().name, "Gamma");
  const ok = await call("PUT", "/api/companies/beta", "lim", { body: { name: "Beta 2" } });
  assert.equal(ok.status, 200);
  assert.equal(getDb().prepare("SELECT name FROM companies WHERE id = 'beta'").get().name, "Beta 2");
});

// ---------------------------------------------------------------- 备份 / Telegram

test("备份只给全部公司 admin；总控 Telegram 设置受限 admin 也能用", async () => {
  assert.equal((await call("GET", "/api/admin/backup", "lim")).status, 403);
  assert.equal((await call("PUT", "/api/admin/backup", "lim", { body: { enabled: false } })).status, 403);
  assert.equal((await call("POST", "/api/admin/backup/run", "lim")).status, 403);
  assert.equal((await call("GET", "/api/admin/telegram", "lim")).status, 200);
});

// ---------------------------------------------------------------- 账号：受限 admin 管 operator

test("账号列表：受限 admin 只看到自己 + 授权全落在范围内的 operator", async () => {
  const body = await (await call("GET", "/api/admin/users", "lim")).json();
  assert.deepEqual(body.users.map((x) => x.username).sort(), ["lim", "op_ab", "op_b"]);
  const all = await (await call("GET", "/api/admin/users", "boss")).json();
  assert.equal(all.users.length, 8);
  const limRow = all.users.find((x) => x.username === "lim");
  assert.equal(limRow.company_scope, "limited");
  assert.deepEqual(limRow.company_ids, ["alpha", "beta"]);
  assert.equal(all.users.find((x) => x.username === "boss").company_scope, "all");
});

test("账号：受限 admin 建 operator 只能勾自己范围内的公司；建 admin → 403", async () => {
  const outside = await call("POST", "/api/admin/users", "lim", { body: { username: "op_new1", password: "longpassword1", role: "operator", company_ids: ["beta", "gamma"] } });
  assert.equal(outside.status, 403);
  const inside = await call("POST", "/api/admin/users", "lim", { body: { username: "op_new2", password: "longpassword1", role: "operator", company_ids: ["beta"] } });
  assert.equal(inside.status, 200);
  const admin = await call("POST", "/api/admin/users", "lim", { body: { username: "adm_new", password: "longpassword1", role: "admin" } });
  assert.equal(admin.status, 403);
});

test("账号：受限 admin 不能改 / 停用 / 删除范围外（含部分在外）的 operator，也不能把授权改到范围外", async () => {
  assert.equal((await call("PUT", `/api/admin/users/${ids.op_bg}`, "lim", { body: { status: "disabled" } })).status, 403);
  assert.equal((await call("PUT", `/api/admin/users/${ids.op_g}`, "lim", { body: { password: "longpassword2" } })).status, 403);
  assert.equal((await call("DELETE", `/api/admin/users/${ids.op_bg}`, "lim")).status, 403);
  assert.equal((await call("PUT", `/api/admin/users/${ids.op_b}`, "lim", { body: { company_ids: ["beta", "gamma"] } })).status, 403);
  const ok = await call("PUT", `/api/admin/users/${ids.op_b}`, "lim", { body: { company_ids: ["alpha", "beta"] } });
  assert.equal(ok.status, 200);
  assert.equal(getDb().prepare("SELECT status FROM users WHERE id = ?").get(ids.op_bg).status, "active");
});

// ---------------------------------------------------------------- 账号：admin 的公司范围

test("admin 范围：全部公司 admin 建受限 admin；limited 不勾公司 → 400", async () => {
  const empty = await call("POST", "/api/admin/users", "boss", { body: { username: "adm_x", password: "longpassword1", role: "admin", company_scope: "limited", company_ids: [] } });
  assert.equal(empty.status, 400);
  const res = await call("POST", "/api/admin/users", "boss", { body: { username: "adm_y", password: "longpassword1", role: "admin", company_scope: "limited", company_ids: ["gamma"] } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.company_scope, "limited");
  assert.deepEqual(body.user.company_ids, ["gamma"]);
  const plain = await (await call("POST", "/api/admin/users", "boss", { body: { username: "adm_z", password: "longpassword1", role: "admin" } })).json();
  assert.equal(plain.user.company_scope, "all", "不带 company_scope 的 admin 默认全部公司");
});

test("admin 范围：全部公司 admin 能改别的 admin；受限 admin 不能改任何 admin（自己的名字密码除外）", async () => {
  const toLimited = await call("PUT", `/api/admin/users/${ids.boss2}`, "boss", { body: { company_scope: "limited", company_ids: ["alpha"] } });
  assert.equal(toLimited.status, 200);
  assert.equal(userAccess.isFullAdmin(getDb(), u("boss2")), false);
  const back = await call("PUT", `/api/admin/users/${ids.boss2}`, "boss", { body: { company_scope: "all" } });
  assert.equal(back.status, 200);
  assert.equal(userAccess.isFullAdmin(getDb(), u("boss2")), true);

  assert.equal((await call("PUT", `/api/admin/users/${ids.lim2}`, "lim", { body: { company_scope: "all" } })).status, 403);
  assert.equal((await call("PUT", `/api/admin/users/${ids.lim}`, "lim", { body: { company_scope: "all" } })).status, 403, "不能给自己放宽");
  assert.equal((await call("PUT", `/api/admin/users/${ids.lim}`, "lim", { body: { company_ids: ["alpha", "beta", "gamma"] } })).status, 403);
  assert.equal((await call("PUT", `/api/admin/users/${ids.lim}`, "lim", { body: { name: "Lim Renamed" } })).status, 200);
});

test("admin 范围：不能改自己的范围；最后一个全部公司 admin 不能被改成受限", async () => {
  assert.equal((await call("PUT", `/api/admin/users/${ids.boss}`, "boss", { body: { company_scope: "limited", company_ids: ["alpha"] } })).status, 403);
  // boss2 改成受限后，全部公司 admin 只剩 boss（以及上面测试新建的 adm_z）→ 先把 adm_z 也收紧
  const db = getDb();
  const admZ = db.prepare("SELECT id FROM users WHERE username = 'adm_z'").get().id;
  assert.equal((await call("PUT", `/api/admin/users/${admZ}`, "boss", { body: { company_scope: "limited", company_ids: ["alpha"] } })).status, 200);
  assert.equal((await call("PUT", `/api/admin/users/${ids.boss2}`, "boss", { body: { company_scope: "limited", company_ids: ["alpha"] } })).status, 200);
  // 现在只剩 boss 一个全部公司 admin；boss2 不能反过来把 boss 收紧（boss2 已是受限），boss 自己也不能改自己
  assert.equal((await call("PUT", `/api/admin/users/${ids.boss}`, "boss2", { body: { company_scope: "limited", company_ids: ["alpha"] } })).status, 403);
  assert.equal(userAccess.isFullAdmin(db, u("boss")), true);
});
