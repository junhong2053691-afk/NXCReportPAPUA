// 交易记录页 OPERATOR 列（2026-11-10）：操作人来自审计表，bank_ledger 本身不存。
// 守住：录入人 = 引用这条流水的最早事件、最后修改人 = 最新一条 ledger.updated、
// 系统 / 平台生成的标成系统、按公司隔离、老流水查不到就留空。
// 另附交易页渠道列表「余额 / 上限」进度条的颜色档（bank-common.js 的 limitLevel）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const { appendAuditEvent, ensureAuditSchema } = require("../lib/auditLog");
const { ledgerOperators, attachLedgerOperators } = require("../lib/ledgerOperators");

const amy = { type: "user", userId: 1, username: "amy", name: "Amy", role: "operator" };
const bob = { type: "user", userId: 2, username: "bob", name: "", role: "operator" };

function db() {
  const d = new Database(":memory:");
  ensureAuditSchema(d);
  return d;
}

test("录入人取最早一条引用事件，最后修改人取最新一条 ledger.updated", () => {
  const d = db();
  appendAuditEvent(d, { companyId: "A", action: "pending.approved", actor: amy, refs: [{ type: "pending", id: 9 }, { type: "ledger", id: 5 }] });
  appendAuditEvent(d, { companyId: "A", action: "ledger.updated", actor: amy, refs: [{ type: "ledger", id: 5 }] });
  appendAuditEvent(d, { companyId: "A", action: "ledger.updated", actor: bob, refs: [{ type: "ledger", id: 5 }] });
  const op = ledgerOperators(d, "A", [5]).get(5);
  assert.deepEqual(op, { created_by: "Amy", created_by_system: 0, updated_by: "bob" }, "没填 name 的账号回退 username");
});

test("系统 / 平台生成的流水标成系统，不显示 SYSTEM 账号名", () => {
  const d = db();
  appendAuditEvent(d, { companyId: "A", action: "ledger.created", source: "system", actor: { type: "system", username: "SYSTEM", name: "System" }, refs: [{ type: "ledger", id: 7 }] });
  assert.deepEqual(ledgerOperators(d, "A", [7]).get(7), { created_by: "", created_by_system: 1, updated_by: "" });
});

test("按公司隔离：别家同 id 流水的审计不串过来", () => {
  const d = db();
  appendAuditEvent(d, { companyId: "B", action: "ledger.created", actor: bob, refs: [{ type: "ledger", id: 5 }] });
  appendAuditEvent(d, { companyId: "A", action: "ledger.created", actor: amy, refs: [{ type: "ledger", id: 5 }] });
  assert.equal(ledgerOperators(d, "A", [5]).get(5).created_by, "Amy");
  assert.equal(ledgerOperators(d, "B", [5]).get(5).created_by, "bob");
});

test("attachLedgerOperators 就地补字段；审计上线前的老流水两项都空", () => {
  const d = db();
  appendAuditEvent(d, { companyId: "A", action: "transfer.created", actor: amy, refs: [{ type: "ledger", id: 1 }] });
  const rows = [{ id: 1 }, { id: 2 }];
  attachLedgerOperators(d, "A", rows);
  assert.equal(rows[0].created_by, "Amy");
  assert.deepEqual([rows[1].created_by, rows[1].created_by_system, rows[1].updated_by], ["", 0, ""]);
});

test("一页超过一个批次也都查得到（分批 IN 查询）", () => {
  const d = db();
  for (let id = 1; id <= 450; id += 1) {
    appendAuditEvent(d, { companyId: "A", action: "ledger.created", actor: amy, refs: [{ type: "ledger", id }] });
  }
  const map = ledgerOperators(d, "A", Array.from({ length: 450 }, (_, i) => i + 1));
  assert.equal(map.size, 450);
  assert.equal(map.get(450).created_by, "Amy");
});

test("GET /ledger 返回操作人字段（路由接上了 attachLedgerOperators）", () => {
  const routes = fs.readFileSync(path.join(__dirname, "..", "routes", "banks.js"), "utf8");
  const list = routes.slice(routes.indexOf('router.get("/ledger", (req, res) => {'), routes.indexOf('router.get("/ledger/deleted"'));
  assert.match(list, /attachLedgerOperators\(db, cid, rows\);/);
});

test("limitLevel：<70% ok、70%–<90% warn、≥90% danger，没设阈值不画条", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "public", "js", "bank-common.js"), "utf8");
  const match = source.match(/function limitLevel\(balance, threshold\) \{[\s\S]*?\n  \}/);
  assert.ok(match, "limitLevel 不在预期位置");
  const limitLevel = new Function(match[0] + "; return limitLevel;")();
  assert.equal(limitLevel(100, 0), "");
  assert.equal(limitLevel(100, null), "");
  assert.equal(limitLevel(0, 300), "ok");
  assert.equal(limitLevel(-50, 300), "ok");
  assert.equal(limitLevel(209.99, 300), "ok");
  assert.equal(limitLevel(210, 300), "warn");
  assert.equal(limitLevel(269.99, 300), "warn");
  assert.equal(limitLevel(270, 300), "danger");
  assert.equal(limitLevel(500, 300), "danger");
});
