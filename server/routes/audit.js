const express = require("express");
const { getDb } = require("../db/init");
const { requireAdmin, requireCompany } = require("../middleware");
const { TZ, shiftDateKey } = require("../lib/dates");
const { eventRow } = require("../lib/auditLog");

const router = express.Router();
router.use(requireAdmin);
router.use(requireCompany);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function localMidnightUtc(dateKey) {
  if (!DATE_RE.test(String(dateKey || ""))) return null;
  const [year, month, day] = dateKey.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  for (let i = 0; i < 3; i += 1) {
    const parts = formatter.formatToParts(new Date(guess));
    const value = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
    const represented = Date.UTC(
      value("year"),
      value("month") - 1,
      value("day"),
      value("hour") % 24,
      value("minute"),
      value("second")
    );
    guess += target - represented;
  }
  return new Date(guess).toISOString().slice(0, 19).replace("T", " ");
}

function parseRefsCompact(value) {
  if (!value) return [];
  return String(value).split("|").map((part) => {
    const index = part.indexOf(":");
    return index < 0
      ? { type: "", id: part }
      : { type: part.slice(0, index), id: part.slice(index + 1) };
  }).filter((ref) => ref.type && ref.id);
}

function refsForEvent(db, companyId, eventId) {
  return db.prepare(
    "SELECT ref_type AS type, ref_id AS id FROM audit_event_refs WHERE company_id=? AND event_id=? ORDER BY ref_type, ref_id"
  ).all(companyId, eventId);
}

function mapListRow(row) {
  return {
    ...row,
    refs: parseRefsCompact(row.refs_compact),
    refs_compact: undefined,
  };
}

router.get("/options", (req, res) => {
  const db = getDb();
  const cid = req.companyId;
  const actors = db.prepare(`
    SELECT actor_username AS username,
           MAX(actor_name) AS name,
           MAX(actor_role) AS role,
           COUNT(*) AS event_count
    FROM audit_events
    WHERE company_id=? AND TRIM(actor_username)<>''
    GROUP BY actor_username COLLATE NOCASE
    ORDER BY actor_username COLLATE NOCASE
  `).all(cid);
  const actions = db.prepare(`
    SELECT action, COUNT(*) AS event_count
    FROM audit_events WHERE company_id=?
    GROUP BY action ORDER BY action
  `).all(cid);
  res.json({ companyId: cid, actors, actions, sources: ["user", "system", "platform", "backfill"] });
});

router.get("/events", (req, res) => {
  const db = getDb();
  const cid = req.companyId;
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(20, Number(req.query.limit || 50)));
  const offset = (page - 1) * limit;
  const conditions = ["e.company_id = ?"];
  const params = [cid];

  const from = String(req.query.from || "").trim();
  const to = String(req.query.to || "").trim();
  if (from) {
    const utc = localMidnightUtc(from);
    if (!utc) return res.status(400).json({ error: "开始日期无效" });
    conditions.push("e.occurred_at >= ?");
    params.push(utc);
  }
  if (to) {
    if (!DATE_RE.test(to)) return res.status(400).json({ error: "结束日期无效" });
    const utc = localMidnightUtc(shiftDateKey(to, 1));
    conditions.push("e.occurred_at < ?");
    params.push(utc);
  }

  const action = String(req.query.action || "").trim();
  if (action) {
    conditions.push("e.action = ?");
    params.push(action);
  }
  const source = String(req.query.source || "").trim();
  if (source) {
    conditions.push("e.source = ?");
    params.push(source);
  }
  const actor = String(req.query.actor || "").trim();
  if (actor) {
    conditions.push("e.actor_username = ? COLLATE NOCASE");
    params.push(actor);
  }
  const q = String(req.query.q || "").trim();
  if (q) {
    const like = `%${q}%`;
    conditions.push(`(
      e.summary LIKE ? OR e.reason LIKE ? OR e.actor_username LIKE ? OR e.actor_name LIKE ? OR
      EXISTS (
        SELECT 1 FROM audit_event_refs qr
        WHERE qr.company_id=e.company_id AND qr.event_id=e.id AND qr.ref_id LIKE ?
      )
    )`);
    params.push(like, like, like, like, like);
  }

  const where = conditions.join(" AND ");
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_events e WHERE ${where}`).get(...params).n;
  const rows = db.prepare(`
    SELECT e.id, e.company_id, e.action, e.source, e.actor_type, e.actor_user_id,
           e.actor_username, e.actor_name, e.actor_role, e.summary, e.reason, e.occurred_at,
           (SELECT GROUP_CONCAT(r.ref_type || ':' || r.ref_id, '|')
              FROM audit_event_refs r WHERE r.event_id=e.id) AS refs_compact
    FROM audit_events e
    WHERE ${where}
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset).map(mapListRow);
  res.json({
    companyId: cid,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    limit,
    rows,
  });
});

router.get("/timeline", (req, res) => {
  const db = getDb();
  const cid = req.companyId;
  let transactionId = String(req.query.transaction_id || "").trim();
  const ledgerId = Number(req.query.ledger_id || 0);
  let selectedLedger = null;

  if (!transactionId && !ledgerId) {
    return res.status(400).json({ error: "请提供 transaction_id 或 ledger_id" });
  }

  if (ledgerId) {
    selectedLedger = db.prepare("SELECT * FROM bank_ledger WHERE company_id=? AND id=?").get(cid, ledgerId)
      || db.prepare("SELECT *, original_id AS id FROM bank_ledger_deleted WHERE company_id=? AND original_id=? ORDER BY deleted_at DESC LIMIT 1")
        .get(cid, ledgerId);
    if (!selectedLedger) return res.status(404).json({ error: "流水不存在" });
    if (!transactionId) transactionId = String(selectedLedger.tx_id || "").trim();
  }

  const transaction = transactionId
    ? db.prepare("SELECT * FROM transactions WHERE company_id=? AND id=?").get(cid, transactionId)
    : null;
  const pending = transactionId
    ? db.prepare("SELECT * FROM bank_tx_pending WHERE company_id=? AND tx_id=?").get(cid, transactionId)
    : null;
  let ledgers = [];
  let deletedLedgers = [];
  if (transactionId) {
    ledgers = db.prepare("SELECT * FROM bank_ledger WHERE company_id=? AND tx_id=? ORDER BY entry_time, id").all(cid, transactionId);
    deletedLedgers = db.prepare("SELECT * FROM bank_ledger_deleted WHERE company_id=? AND tx_id=? ORDER BY deleted_at DESC, id DESC").all(cid, transactionId);
  } else if (selectedLedger) {
    ledgers = db.prepare("SELECT * FROM bank_ledger WHERE company_id=? AND id=?").all(cid, ledgerId);
    deletedLedgers = db.prepare("SELECT * FROM bank_ledger_deleted WHERE company_id=? AND original_id=? ORDER BY deleted_at DESC").all(cid, ledgerId);
  }

  const refConditions = [];
  const refParams = [cid];
  if (transactionId) {
    refConditions.push("(r.ref_type='transaction' AND r.ref_id=?)");
    refParams.push(transactionId);
  }
  if (ledgerId) {
    refConditions.push("(r.ref_type='ledger' AND r.ref_id=?)");
    refParams.push(String(ledgerId));
  }
  const events = refConditions.length
    ? db.prepare(`
        SELECT DISTINCT e.*
        FROM audit_events e
        JOIN audit_event_refs r ON r.event_id=e.id AND r.company_id=e.company_id
        WHERE e.company_id=? AND (${refConditions.join(" OR ")})
        ORDER BY e.occurred_at ASC, e.id ASC
      `).all(...refParams).map((row) => eventRow(row, refsForEvent(db, cid, row.id)))
    : [];

  if (!transaction && !pending && !ledgers.length && !deletedLedgers.length && !events.length) {
    return res.status(404).json({ error: "未找到相关交易或流水" });
  }
  const hasLiveAudit = events.some((event) => event.source !== "backfill");
  res.json({
    companyId: cid,
    transaction_id: transactionId || null,
    ledger_id: ledgerId || null,
    transaction,
    pending,
    ledgers,
    deleted_ledgers: deletedLedgers,
    events,
    history_complete: hasLiveAudit,
    history_note: hasLiveAudit ? "" : "这是上线前数据，暂无完整操作历史。",
  });
});

router.get("/events/:id", (req, res) => {
  const db = getDb();
  const cid = req.companyId;
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM audit_events WHERE company_id=? AND id=?").get(cid, id);
  if (!row) return res.status(404).json({ error: "操作记录不存在" });
  res.json({ event: eventRow(row, refsForEvent(db, cid, id)) });
});

module.exports = router;
