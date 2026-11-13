// 审批生成的流水（auto_generated = 1）入账时间是员工在接单区选的，重启服务不能改它。
// 2026-11-13 线上：EzSpin68 平台单 17269528700（平台 11-12 23:55）admin 审批时选了 11-13 00:00，
// 一次部署重启后启动迁移 repairAutoLedgerTimes 把它按 transactions.created_at 改回 11-12 23:55:38，
// 当日 DEPOSIT 因此比 Excel 少 10，审计里没有任何痕迹。四家共 530 笔审批流水被这样改过时间。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..", "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-ledger-time-restart-"));
process.env.TRADER_DB = path.join(tmpDir, "trader.db");
process.env.TRADER_CONFIG = path.join(projectRoot, "config.example.json");
process.env.TRADER_STATE_DIR = tmpDir;

const initPath = require.resolve("../db/init");

function freshGetDb() {
  delete require.cache[initPath];
  return require("../db/init").getDb();
}

test("重启（重新跑启动迁移）不改审批流水的入账时间", () => {
  const db = freshGetDb();
  db.prepare("INSERT OR REPLACE INTO companies (id, name, enabled, sort_order) VALUES ('alpha', 'Alpha', 1, 1)").run();
  // 平台下单：悉尼 2026-11-12 23:55:38
  db.prepare(
    "INSERT INTO transactions (id, company_id, type, amount, status, created_at, created_date) VALUES ('T1', 'alpha', 'DEPOSIT', 10, 'COMPLETED', '2026-11-12T12:55:38+00:00', '2026-11-12')"
  ).run();
  // 员工审批时把入账日期改成了 11-13
  const id = Number(db.prepare(
    "INSERT INTO bank_ledger (bank_account_id, company_id, entry_time, tx_id, status, amount_in, auto_generated) VALUES (1, 'alpha', '2026-11-13 00:00:00', 'T1', 'deposit', 10, 1)"
  ).run().lastInsertRowid);
  db.close();

  const again = freshGetDb();
  const row = again.prepare("SELECT entry_time FROM bank_ledger WHERE id = ?").get(id);
  again.close();
  assert.equal(row.entry_time, "2026-11-13 00:00:00");
});
