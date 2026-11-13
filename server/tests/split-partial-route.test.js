// 拆分调钱 · 分批付的 HTTP 接线（CONTEXT.md「拆分调钱」）：审批分批、待审批列表的已付 / 还差、
// 跳过被拒、删一批重新打开、恢复一批关单、按已付结单（原因必填）。落账细节在 split-partial.test.js。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..", "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "split-partial-route-"));
// 必须在 require 路由之前设：db/init 在模块加载时就定下库路径。
process.env.TRADER_DB = path.join(tmpDir, "trader.db");
process.env.TRADER_CONFIG = path.join(projectRoot, "config.example.json");
process.env.TRADER_STATE_DIR = tmpDir;

const express = require("express");
const { getDb } = require("../db/init");
const banksRouter = require("../routes/banks");

let bankA = 0;
let bankB = 0;

function seed() {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO companies (id, name, enabled, sort_order) VALUES ('alpha', 'Alpha', 1, 1)").run();
  const add = (name) => Number(db.prepare(
    "INSERT INTO bank_accounts (company_id, bank_branch, account_name, lifecycle_status) VALUES ('alpha', ?, 'HOLDER', 'active')"
  ).run(name).lastInsertRowid);
  bankA = add("CBA");
  bankB = add("NAB");
  const pending = db.prepare(
    `INSERT INTO bank_tx_pending (company_id, tx_id, tx_type, amount, username, name, tx_time, state)
     VALUES ('alpha', ?, 'WITHDRAW', ?, 'cust', 'Customer', '2026-11-13 10:00:00', 'pending')`
  );
  pending.run("W-ROUTE-1", 1000);
  pending.run("W-ROUTE-2", 600);
}

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { user: { id: 1, username: "ops", name: "Ops", role: "operator" }, companyId: "alpha" };
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

const call = (method, url, body) => fetch(base + url, {
  method,
  headers: { "content-type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
});
const pendingRow = async (txId) => ((await (await call("GET", "/api/banks/pending-tx")).json()).rows || []).find((r) => r.tx_id === txId);
const state = (txId) => getDb().prepare("SELECT state, approve_mode FROM bank_tx_pending WHERE tx_id = ?").get(txId);
const approve = (txId, body) => call("POST", `/api/banks/pending-tx/${txId}/approve`, { mode: "help_split", ...body });

test("分批付 → 删一批重新打开 → 恢复那批关单", async () => {
  const first = await approve("W-ROUTE-1", { self_rows: [{ bank_account_id: bankA, amount: 100 }, { bank_account_id: bankB, amount: 100 }] });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.closed, false);
  assert.equal(firstBody.remaining_amount, 800);

  const listed = await pendingRow("W-ROUTE-1");
  assert.equal(listed.paid_amount, 200);
  assert.equal(listed.remaining_amount, 800);

  const skip = await call("POST", "/api/banks/pending-tx/W-ROUTE-1/skip", { reason: "不付了" });
  assert.equal(skip.status, 400, "账上有钱的单不能跳过");

  const second = await approve("W-ROUTE-1", { self_rows: [{ bank_account_id: bankA, amount: 800 }] });
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.closed, true);
  assert.equal(state("W-ROUTE-1").state, "approved");

  const del = await call("DELETE", `/api/banks/ledger/${secondBody.ledgers[0].id}`, { reason: "记错户口" });
  assert.equal(del.status, 200);
  const delBody = await del.json();
  assert.equal(delBody.reopened, true);
  assert.equal((await pendingRow("W-ROUTE-1")).remaining_amount, 800);

  const restore = await call("POST", `/api/banks/ledger/deleted/${delBody.deletedId}/restore`, { reason: "没记错" });
  assert.equal(restore.status, 200);
  assert.equal((await restore.json()).restored_platform_order, true);
  assert.equal(state("W-ROUTE-1").state, "approved");
  assert.equal(await pendingRow("W-ROUTE-1"), undefined);
});

test("按已付结单：原因必填，结单后离开待审批", async () => {
  const paid = await approve("W-ROUTE-2", { self_rows: [{ bank_account_id: bankB, amount: 100 }] });
  assert.equal(paid.status, 200);

  const noReason = await call("POST", "/api/banks/pending-tx/W-ROUTE-2/close-short", {});
  assert.equal(noReason.status, 400);
  assert.equal(state("W-ROUTE-2").state, "pending");

  const closed = await call("POST", "/api/banks/pending-tx/W-ROUTE-2/close-short", { reason: "平台撤了剩下的" });
  assert.equal(closed.status, 200);
  assert.deepEqual({ ...state("W-ROUTE-2") }, { state: "approved", approve_mode: "split_closed" });
  assert.equal(await pendingRow("W-ROUTE-2"), undefined);
});
