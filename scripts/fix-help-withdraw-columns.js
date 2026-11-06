#!/usr/bin/env node
/**
 * 一次性改正：把审批生成的「别家替我付客户提现」流水改成正确落列 withdraw + help_amount。
 *
 * 背景（2026-11-06 员工演练 + 4 家 Excel 的 C STATUS 表）：同一笔代付两边总是一 IN 一 OUT，
 * 客户所在公司那边记 IN（我欠对方）。修复前审批写错了两种：
 *   · 调钱 mode=help      → cash in + trf_amount   （C STATUS 记成 OUT，与协助方同号，永远对不平）
 *   · 拆分 help_split 协助 → withdraw + amount_in  （方向对，但「入账 IN」虚增、REPORT 进了 CASH IN）
 * 代码已改（bankApply.js 的 helpWithdrawFields），本脚本改正存量行。
 *
 * 余额：这些行按设计不绑户口（bank_account_id = 0），改列不影响任何余额。绑了户口的行
 * **默认跳过**——改列会让该户余额反向变 2 倍金额，那是要人拍板的事。用 --unbind <id,...>
 * 点名的行会同时解绑（钱从没进过那个户口），并重算原户口余额。
 *
 * 用法：
 *   node scripts/fix-help-withdraw-columns.js                  # dry-run，只打印
 *   node scripts/fix-help-withdraw-columns.js --yes            # 执行
 *   node scripts/fix-help-withdraw-columns.js --yes --unbind 597
 * 先 vacuumSnapshot。每行写一条 ledger.updated 审计（source=system）。幂等：改过的行不再命中。
 */
const Database = require("better-sqlite3");
const { dbPath } = require("../server/lib/paths");
const { refreshBankBalance } = require("../server/lib/bankReport");
const { appendAuditEvent, ensureAuditSchema } = require("../server/lib/auditLog");

const YES = process.argv.includes("--yes");
const unbindArg = process.argv.indexOf("--unbind");
const UNBIND = new Set(
  unbindArg > 0 ? String(process.argv[unbindArg + 1] || "").split(",").map(Number).filter(Boolean) : []
);

const db = new Database(dbPath());
db.pragma("busy_timeout = 15000");
ensureAuditSchema(db);

const helpRows = db.prepare(`
  SELECT l.* FROM bank_ledger l
  JOIN bank_tx_pending p ON p.company_id = l.company_id AND p.tx_id = l.tx_id
  WHERE p.approve_mode = 'help' AND l.auto_generated = 1
    AND l.status = 'cash in' AND l.trf_amount > 0 AND l.amount_in = 0 AND l.help_amount = 0
  ORDER BY l.company_id, l.id`).all();
const splitRows = db.prepare(`
  SELECT l.* FROM bank_ledger l
  JOIN bank_tx_pending p ON p.company_id = l.company_id AND p.tx_id = l.tx_id
  WHERE p.approve_mode = 'help_split' AND l.auto_generated = 1 AND l.transfer_group_id <> ''
    AND l.status = 'withdraw' AND l.amount_in > 0 AND l.help_amount = 0 AND l.c_status <> ''
  ORDER BY l.company_id, l.id`).all();

const plan = [
  ...helpRows.map((r) => ({ row: r, kind: "help", amount: Number(r.trf_amount) })),
  ...splitRows.map((r) => ({ row: r, kind: "split", amount: Number(r.amount_in) })),
];
const todo = plan.filter((p) => !p.row.bank_account_id || UNBIND.has(p.row.id));
const skipped = plan.filter((p) => p.row.bank_account_id && !UNBIND.has(p.row.id));

for (const p of todo) {
  const r = p.row;
  console.log(`改 #${r.id} ${r.company_id} ${r.entry_time.slice(0, 10)} ${p.kind} ${r.c_status} ${p.amount.toFixed(2)}` +
    (r.bank_account_id ? `  ⚠ 解绑户口 #${r.bank_account_id}（该户余额 -${p.amount.toFixed(2)}）` : ""));
}
for (const p of skipped) {
  console.log(`跳过 #${p.row.id} ${p.row.company_id}：绑了户口 #${p.row.bank_account_id}，要改请加 --unbind ${p.row.id}`);
}
console.log(`合计：改 ${todo.length} 行，跳过 ${skipped.length} 行`);
if (!YES) {
  console.log("dry-run，加 --yes 执行");
  process.exit(0);
}

const update = db.prepare(`
  UPDATE bank_ledger SET status = 'withdraw', amount_in = 0, amount_out = 0, help_amount = ?, trf_amount = 0,
    bank_account_id = 0, bank_acc = '', updated_at = datetime('now')
  WHERE id = ? AND company_id = ?`);
const touchedBanks = new Set();
db.transaction(() => {
  for (const p of todo) {
    const r = p.row;
    update.run(p.amount, r.id, r.company_id);
    if (r.bank_account_id) touchedBanks.add(r.bank_account_id);
    const after = db.prepare("SELECT * FROM bank_ledger WHERE id = ?").get(r.id);
    appendAuditEvent(db, {
      companyId: r.company_id,
      action: "ledger.updated",
      source: "system",
      actor: { type: "system", username: "fix-help-withdraw-columns" },
      summary: `改正代付提现落列 #${r.id}（${p.kind === "help" ? "调钱" : "拆分协助"}）`,
      reason: "别家替我付客户提现应记 withdraw + help_amount（C STATUS 记 IN），见 help-withdraw-approve.test.js",
      before: { status: r.status, amount_in: r.amount_in, trf_amount: r.trf_amount, help_amount: r.help_amount, bank_account_id: r.bank_account_id, bank_acc: r.bank_acc },
      after: { status: after.status, amount_in: after.amount_in, trf_amount: after.trf_amount, help_amount: after.help_amount, bank_account_id: after.bank_account_id, bank_acc: after.bank_acc },
      refs: [{ type: "ledger", id: r.id }, { type: "transaction", id: r.tx_id }],
    });
  }
  // 修数据不触发 Telegram 报警
  for (const id of touchedBanks) refreshBankBalance(db, id, { alert: false });
})();
console.log(`已改 ${todo.length} 行；重算余额的户口：${[...touchedBanks].join(", ") || "无"}`);
db.close();
