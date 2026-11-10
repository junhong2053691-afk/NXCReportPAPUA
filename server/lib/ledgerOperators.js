// 交易记录页 OPERATOR 列：每条流水是谁录入 / 审批的、最后被谁改过。
//
// bank_ledger 本身没有操作人列，来源是审计表：生成流水的三个入口（平台单审批 pending.approved、
// 调钱 transfer.created、手工录入 ledger.created）都把 ledger id 写进 audit_event_refs，
// 所以「引用这条流水的最早一条事件」就是录入人，「最新一条 ledger.updated」就是最后修改人。
// 审计功能上线前的老流水查不到事件，两项都留空，前端显示「—」。
//
// 只读、按 company_id 隔离（refs 与 events 两边都带），一次批量查一页，不逐行子查询。
const CHUNK = 400;

function actorName(row) {
  return String(row.actor_name || "").trim() || String(row.actor_username || "").trim();
}

function isMachine(row) {
  return row.actor_type === "system" || row.actor_type === "platform";
}

function ledgerOperators(db, companyId, ledgerIds) {
  const out = new Map();
  const ids = [...new Set((ledgerIds || []).map((id) => String(Number(id) || "")).filter((id) => id && id !== "0"))];
  if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    let rows;
    try {
      rows = db.prepare(`
        SELECT r.ref_id, e.id, e.action, e.actor_type, e.actor_name, e.actor_username
        FROM audit_event_refs r
        JOIN audit_events e ON e.id = r.event_id AND e.company_id = r.company_id
        WHERE r.company_id = ? AND r.ref_type = 'ledger' AND r.ref_id IN (${part.map(() => "?").join(",")})
        ORDER BY e.id ASC
      `).all(String(companyId || ""), ...part);
    } catch (_) {
      return out; // 审计表还没建（极老的库）：没有操作人可显示，不影响流水本身
    }
    for (const row of rows) {
      const key = Number(row.ref_id);
      let op = out.get(key);
      if (!op) {
        op = { created_by: isMachine(row) ? "" : actorName(row), created_by_system: isMachine(row) ? 1 : 0, updated_by: "" };
        out.set(key, op);
      }
      if (row.action === "ledger.updated" && !isMachine(row)) op.updated_by = actorName(row);
    }
  }
  return out;
}

// 就地给接口返回的流水行补上 created_by / created_by_system / updated_by。
function attachLedgerOperators(db, companyId, rows) {
  const map = ledgerOperators(db, companyId, (rows || []).map((r) => r.id));
  for (const row of rows || []) {
    const op = map.get(Number(row.id));
    row.created_by = op ? op.created_by : "";
    row.created_by_system = op ? op.created_by_system : 0;
    row.updated_by = op ? op.updated_by : "";
  }
  return rows;
}

module.exports = { ledgerOperators, attachLedgerOperators };
