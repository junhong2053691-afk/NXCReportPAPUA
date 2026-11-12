// 余额校正的 HTTP 守门（CONTEXT.md「余额校正（ADJUSTMENT）」）：
//   - POST /:id/adjust 只有 admin；
//   - adjustment 流水只能从这个入口写：POST/PUT /ledger 不许把 status 写成 adjustment，也不许改 adjustment 行；
//   - 删除 / 从最近删除恢复 adjustment 行只有 admin。
// 改之前 POST/PUT /ledger 只校验 status 格式，operator 能直接写一条 adjustment 把余额抄平。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..", "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bank-adjustment-route-"));
// 必须在 require 路由之前设：db/init 在模块加载时就定下库路径。
process.env.TRADER_DB = path.join(tmpDir, "trader.db");
process.env.TRADER_CONFIG = path.join(projectRoot, "config.example.json");
process.env.TRADER_STATE_DIR = tmpDir;

const express = require("express");
const { getDb } = require("../db/init");
const banksRouter = require("../routes/banks");

let bankId = 0;

function seed() {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO companies (id, name, enabled, sort_order) VALUES ('alpha', 'Alpha', 1, 1)").run();
  bankId = Number(db.prepare(
    "INSERT INTO bank_accounts (company_id, bank_branch, account_name, lifecycle_status) VALUES ('alpha', 'CBA', 'KYLIE', 'active')"
  ).run().lastInsertRowid);
  db.prepare(
    "INSERT INTO bank_ledger (bank_account_id, company_id, entry_time, status, amount_in) VALUES (?, 'alpha', '2026-11-01 10:00:00', 'deposit', 1000)"
  ).run(bankId);
}

/** 假 session：x-role 头决定角色，公司固定 alpha（照 top-referral-route.test.js）。 */
function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const role = req.get("x-role");
    req.session = role ? { user: { id: 1, username: role, name: role, role }, companyId: "alpha" } : {};
    req.companyId = "alpha";
    next();
  });
  app.use("/api/banks", banksRouter);
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

const call = (method, url, role, body) => fetch(base + url, {
  method,
  headers: { "content-type": "application/json", "x-role": role },
  body: body ? JSON.stringify(body) : undefined,
});
const balance = () => getDb().prepare("SELECT balance FROM bank_accounts WHERE id = ?").get(bankId).balance;
const adjRows = () => getDb().prepare("SELECT * FROM bank_ledger WHERE status = 'adjustment' ORDER BY id").all();

test("operator 调不了 /:id/adjust；admin 可以，余额变成实际余额", async () => {
  const denied = await call("POST", `/api/banks/${bankId}/adjust`, "operator", { actual_balance: 1200, remark: "x" });
  assert.equal(denied.status, 403);
  assert.equal(adjRows().length, 0);

  const ok = await call("POST", `/api/banks/${bankId}/adjust`, "admin", { actual_balance: 1200, remark: "银行多 200" });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.diff, 200);
  assert.equal(Math.round(balance() * 100), 120000);
});

test("POST /ledger 不许写 adjustment（任何角色）", async () => {
  for (const role of ["operator", "admin"]) {
    const res = await call("POST", "/api/banks/ledger", role, { bank_account_id: bankId, status: "adjustment", amount_in: 50 });
    assert.equal(res.status, 400, role);
  }
  assert.equal(adjRows().length, 1);
});

test("PUT /ledger 不许把别的行改成 adjustment，也不许改 adjustment 行（任何角色）", async () => {
  const dep = getDb().prepare("SELECT id FROM bank_ledger WHERE status = 'deposit'").get().id;
  const toAdj = await call("PUT", `/api/banks/ledger/${dep}`, "admin", { status: "adjustment" });
  assert.equal(toAdj.status, 400);

  const adj = adjRows()[0];
  for (const role of ["operator", "admin"]) {
    const res = await call("PUT", `/api/banks/ledger/${adj.id}`, role, { remark: "改一下" });
    assert.equal(res.status, 400, role);
  }
  assert.equal(adjRows()[0].remark, "银行多 200");
});

test("删除 / 恢复 adjustment 行只有 admin；删了余额回去、恢复了余额回来", async () => {
  const adj = adjRows()[0];
  const denied = await call("DELETE", `/api/banks/ledger/${adj.id}`, "operator", { reason: "错了" });
  assert.equal(denied.status, 403);
  assert.equal(adjRows().length, 1);

  const del = await call("DELETE", `/api/banks/ledger/${adj.id}`, "admin", { reason: "错了" });
  assert.equal(del.status, 200);
  const { deletedId } = await del.json();
  assert.equal(Math.round(balance() * 100), 100000);

  const restoreDenied = await call("POST", `/api/banks/ledger/deleted/${deletedId}/restore`, "operator", { reason: "没错" });
  assert.equal(restoreDenied.status, 403);
  const restored = await call("POST", `/api/banks/ledger/deleted/${deletedId}/restore`, "admin", { reason: "没错" });
  assert.equal(restored.status, 200);
  assert.equal(Math.round(balance() * 100), 120000);
});

test("户口封禁后，admin 也不能删 adjustment 行（会改封禁户 EXPENSES）", async () => {
  const adj = adjRows()[0];
  getDb().prepare("UPDATE bank_accounts SET lifecycle_status = 'banned' WHERE id = ?").run(bankId);
  const res = await call("DELETE", `/api/banks/ledger/${adj.id}`, "admin", { reason: "错了" });
  assert.equal(res.status, 409);
  assert.equal(adjRows().length, 1);
  getDb().prepare("UPDATE bank_accounts SET lifecycle_status = 'active' WHERE id = ?").run(bankId);
});
