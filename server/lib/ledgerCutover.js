// 上线切换时的「人工流水归零」。只被 scripts/reset-ledger-for-cutover.js 调用。
//
// 清什么、留什么（2026-11 VPS 切换时定的口径）：
//   清：bank_ledger、bank_ledger_deleted（回收站，不清的话旧行能被「恢复」回来）
//   作废：bank_tx_pending 里 pending / skipped 的单 → 标成 expired，**不删**
//   留：bank_balance_log、bank_accounts、客户、交易、账号、公司、审计
//
// 为什么待审批是「标 expired」而不是 DELETE：enqueuePendingTx（bankApply.js）靠
// INSERT OR IGNORE + UNIQUE(company_id, tx_id) 去重。行删掉了，fast lane 下一轮拉到今天的
// 同一批单就会把它们原样塞回队列。留着行、改状态，队列显示为空且永不重新入队。
//
// 余额：清完流水后走 refreshAllBankBalances（内部 alert:false），全部落回 0。
// 报警：已置位的账户走 clearFired —— 复位只有那一个口子，它会顺带排撤回任务，把聊天里
// 那些已经不成立的 ⚠️ 撤掉。不在这里发任何 HTTP。
//
// 整个过程一个事务：用 auditLog 的 runAtomic（带嵌套保护），里面调用的函数都不再开事务。

const { runAtomic, appendAuditEvent } = require("./auditLog");
const { refreshAllBankBalances } = require("./bankReport");
const { clearFired } = require("./bankAlerts");

const VOID_STATES = ["pending", "skipped"];

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function countBy(db, sql) {
  const out = new Map();
  for (const row of db.prepare(sql).all()) out.set(String(row.company_id || ""), Number(row.n || 0));
  return out;
}

/** 只读：按公司列出将受影响的行数。dry-run 与执行后的审计 summary 共用这一份。 */
function planLedgerReset(db) {
  const ledger = countBy(db, "SELECT company_id, COUNT(*) AS n FROM bank_ledger GROUP BY company_id");
  const trash = tableExists(db, "bank_ledger_deleted")
    ? countBy(db, "SELECT company_id, COUNT(*) AS n FROM bank_ledger_deleted GROUP BY company_id")
    : new Map();
  // WHERE 必须与 applyLedgerReset 里的 UPDATE 同口径（VOID_STATES）。
  const pending = tableExists(db, "bank_tx_pending")
    ? countBy(
        db,
        `SELECT company_id, COUNT(*) AS n FROM bank_tx_pending
         WHERE state IN (${VOID_STATES.map((s) => `'${s}'`).join(",")}) GROUP BY company_id`
      )
    : new Map();
  const balances = new Map();
  const fired = new Map();
  for (const row of db.prepare("SELECT company_id, balance, alert_fired_at FROM bank_accounts").all()) {
    const key = String(row.company_id || "");
    const cur = balances.get(key) || { accounts: 0, nonZero: 0, total: 0 };
    cur.accounts += 1;
    if (Math.round(Number(row.balance || 0) * 100) !== 0) cur.nonZero += 1;
    cur.total += Number(row.balance || 0);
    balances.set(key, cur);
    if (row.alert_fired_at) fired.set(key, (fired.get(key) || 0) + 1);
  }

  const companies = new Set([...ledger.keys(), ...trash.keys(), ...pending.keys(), ...balances.keys()]);
  const rows = [...companies].sort().map((companyId) => ({
    companyId,
    ledger: ledger.get(companyId) || 0,
    ledgerDeleted: trash.get(companyId) || 0,
    pendingVoided: pending.get(companyId) || 0,
    accounts: balances.get(companyId)?.accounts || 0,
    nonZeroBalances: balances.get(companyId)?.nonZero || 0,
    balanceTotal: Math.round((balances.get(companyId)?.total || 0) * 100) / 100,
    alertsFired: fired.get(companyId) || 0,
  }));
  return rows;
}

/**
 * 真正执行。返回执行前的计划（即实际影响的行数）。
 * actor 用 auditLog 的 actor 形状（legacyActor / systemActor 的返回值）。
 */
function applyLedgerReset(db, actor, reason) {
  return runAtomic(db, () => {
    const plan = planLedgerReset(db);

    db.prepare("DELETE FROM bank_ledger").run();
    if (tableExists(db, "bank_ledger_deleted")) db.prepare("DELETE FROM bank_ledger_deleted").run();
    if (tableExists(db, "bank_tx_pending")) {
      db.prepare(
        `UPDATE bank_tx_pending
         SET state = 'expired', decided_at = datetime('now'), decided_by = 'cutover'
         WHERE state IN (${VOID_STATES.map((s) => `'${s}'`).join(",")})`
      ).run();
    }

    const balances = refreshAllBankBalances(db);

    const firedRows = db.prepare("SELECT * FROM bank_accounts WHERE alert_fired_at != ''").all();
    for (const account of firedRows) clearFired(db, account);

    const knownCompanies = new Set(db.prepare("SELECT id FROM companies").all().map((r) => String(r.id)));
    for (const row of plan) {
      if (!knownCompanies.has(row.companyId)) continue;
      appendAuditEvent(db, {
        companyId: row.companyId,
        action: "ledger.cutover_reset",
        source: "user",
        actor,
        summary:
          `上线切换：人工流水归零（删流水 ${row.ledger} 行、回收站 ${row.ledgerDeleted} 行，` +
          `作废待审批 ${row.pendingVoided} 笔，${row.accounts} 个渠道余额归零）`,
        reason: String(reason || ""),
        before: row,
        metadata: { script: "scripts/reset-ledger-for-cutover.js" },
      });
    }

    return { plan, balances, alertsCleared: firedRows.length };
  });
}

module.exports = { planLedgerReset, applyLedgerReset };
