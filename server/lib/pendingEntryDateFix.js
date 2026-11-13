"use strict";

// 审批平台单时入账日期被误选（早于平台单日期前一天）的流水：找出来、按平台日期更正。
//
// 起因：2026-11-13 rolex66 17271440755，11-13 的单审批时日期被改成 10-13，11-13 的流水与日报里
// 少了这笔，看起来像漏单。服务端从此在 pendingLedgerEntryTime 硬拦（只准平台日期前一天起），
// 这里只负责收拾护栏上线前已经落库的那些。
//
// 更正规则：**只换日期部分为平台单日期、保留时分秒**（员工选的时间是对的，错的是日期）。
// 同时改 bank_tx_pending.approved_entry_time 与同公司同 tx_id 的 bank_ledger.entry_time
// （只改日期同样越界的那几行：拆分分批付的后续批次记在付钱那天，是合法的，不碰）。
// 每条流水一条 ledger.updated 审计；涉及的户口重算余额（{ alert: false }，修数据不发报警）。

const { shiftDateKey } = require("./dates");
const { appendAuditEvent, ledgerRefs, runAtomic } = require("./auditLog");
const { refreshBankBalance } = require("./bankReport");

// 生产库 2026-11-12 跑过测试清场，更早的待审批 / 账本是故意清掉的（见 reset-for-testing）。
const DEFAULT_SINCE = "2026-11-12";
const DEFAULT_REASON = "审批时入账日期误选（早于平台单日期），按平台单日期更正";

function minEntryDate(txTime) {
  return shiftDateKey(String(txTime || "").slice(0, 10), -1);
}

function moveToDate(dateTime, dateKey) {
  return dateKey + String(dateTime || "").slice(10);
}

function findMisdatedApprovals(db, opts = {}) {
  const since = opts.since || DEFAULT_SINCE;
  const where = ["state = 'approved'", "COALESCE(approved_entry_time, '') <> ''", "substr(tx_time, 1, 10) >= ?"];
  const params = [since];
  if (opts.companyId) { where.push("company_id = ?"); params.push(opts.companyId); }
  if (opts.txId) { where.push("tx_id = ?"); params.push(String(opts.txId)); }
  const pendings = db
    .prepare(`SELECT * FROM bank_tx_pending WHERE ${where.join(" AND ")} ORDER BY company_id, tx_time, id`)
    .all(...params);
  const ledgerStmt = db.prepare("SELECT * FROM bank_ledger WHERE company_id = ? AND tx_id = ? ORDER BY id");
  const out = [];
  for (const pending of pendings) {
    const min = minEntryDate(pending.tx_time);
    if (!min || String(pending.approved_entry_time).slice(0, 10) >= min) continue;
    const ledger = ledgerStmt
      .all(pending.company_id, pending.tx_id)
      .filter((row) => String(row.entry_time || "").slice(0, 10) < min);
    out.push({ pending, ledger, platformDate: String(pending.tx_time).slice(0, 10) });
  }
  return out;
}

function fixMisdatedApprovals(db, items, actor, reason = DEFAULT_REASON) {
  return runAtomic(db, () => {
    const banks = new Set();
    let ledgerFixed = 0;
    const updLedger = db.prepare(
      "UPDATE bank_ledger SET entry_time = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?"
    );
    const updPending = db.prepare("UPDATE bank_tx_pending SET approved_entry_time = ? WHERE id = ? AND company_id = ?");
    for (const { pending, ledger, platformDate } of items) {
      const pendingAfter = moveToDate(pending.approved_entry_time, platformDate);
      updPending.run(pendingAfter, pending.id, pending.company_id);
      for (const row of ledger) {
        const after = moveToDate(row.entry_time, platformDate);
        updLedger.run(after, row.id, row.company_id);
        const saved = db.prepare("SELECT * FROM bank_ledger WHERE id = ?").get(row.id);
        appendAuditEvent(db, {
          companyId: row.company_id,
          action: "ledger.updated",
          source: "system",
          actor,
          summary: `更正平台单 ${pending.tx_id} 的入账日期 ${row.entry_time.slice(0, 10)} → ${platformDate}`,
          reason,
          before: { entry_time: row.entry_time },
          after: { entry_time: after },
          metadata: {
            changed_fields: ["entry_time"],
            pending_id: pending.id,
            pending_approved_entry_time: { before: pending.approved_entry_time, after: pendingAfter },
            platform_tx_time: pending.tx_time,
          },
          refs: ledgerRefs(saved),
        });
        ledgerFixed += 1;
        if (Number(row.bank_account_id) > 0) banks.add(Number(row.bank_account_id));
      }
    }
    for (const id of banks) refreshBankBalance(db, id, { alert: false });
    return { pendingFixed: items.length, ledgerFixed, banks: [...banks] };
  });
}

module.exports = {
  DEFAULT_SINCE,
  DEFAULT_REASON,
  findMisdatedApprovals,
  fixMisdatedApprovals,
};
