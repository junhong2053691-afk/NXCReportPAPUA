const AUDIT_SOURCES = new Set(["user", "system", "platform", "backfill"]);
const ACTOR_TYPES = new Set(["user", "system", "platform", "unknown"]);
const AUDIT_SCHEMA_READY = new WeakSet();

const SENSITIVE_KEYS = new Set([
  "password",
  "password_hash",
  "access_token",
  "token",
  "authorization",
  "cookie",
  "session",
  "session_id",
  "sessionid",
]);

const LEDGER_FIELDS = [
  "id", "bank_account_id", "company_id", "entry_time", "tx_id", "status",
  "amount_in", "amount_out", "help_amount", "trf_amount", "bank_acc",
  "username", "name", "c_status", "other_info", "remark", "auto_generated",
  "transfer_group_id", "created_at", "updated_at",
];

const BANK_ACCOUNT_FIELDS = [
  "id", "company_id", "bank_branch", "bank", "branch", "account_name", "bsb",
  "account_number", "payid", "active", "reset_daily_balance", "account_kind",
  "lifecycle_status", "sort_order", "note", "created_at", "updated_at",
];

const PENDING_FIELDS = [
  "id", "company_id", "tx_id", "tx_type", "amount", "username", "name",
  "tx_time", "state", "bank_account_id", "approve_mode", "c_status",
  "approved_entry_time", "approved_at", "approved_by", "decided_at", "decided_by",
  "created_at",
];

const TRANSACTION_AUDIT_FIELDS = [
  "company_id", "id", "type", "amount", "method", "status", "operator", "remark",
  "bank_name", "bank_account_name", "bank_account_number", "bank_bsb", "payid",
  "attachment_url", "created_at", "processed_at", "completed_at", "promo_id", "promo_name",
];

function tableExists(db, name) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
  );
}

function runAtomic(db, fn) {
  if (db.inTransaction) return fn();
  if (typeof db.transaction === "function") return db.transaction(fn)();
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (_) {}
    throw error;
  }
}

function ensureAuditSchema(db) {
  if (AUDIT_SCHEMA_READY.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'user',
      actor_type TEXT NOT NULL DEFAULT 'unknown',
      actor_user_id INTEGER,
      actor_username TEXT NOT NULL DEFAULT '',
      actor_name TEXT NOT NULL DEFAULT '',
      actor_role TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      before_json TEXT,
      after_json TEXT,
      metadata_json TEXT,
      dedupe_key TEXT,
      occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_id, dedupe_key)
    );

    CREATE TABLE IF NOT EXISTS audit_event_refs (
      event_id INTEGER NOT NULL,
      company_id TEXT NOT NULL DEFAULT '',
      ref_type TEXT NOT NULL DEFAULT '',
      ref_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (event_id, ref_type, ref_id)
    );

    CREATE INDEX IF NOT EXISTS idx_audit_company_time
      ON audit_events(company_id, occurred_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_company_actor
      ON audit_events(company_id, actor_username, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_company_action
      ON audit_events(company_id, action, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_refs_lookup
      ON audit_event_refs(company_id, ref_type, ref_id, event_id);
    CREATE INDEX IF NOT EXISTS idx_audit_refs_event
      ON audit_event_refs(event_id);

    CREATE TRIGGER IF NOT EXISTS audit_events_no_update
      BEFORE UPDATE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit_events are append-only');
      END;
    CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
      BEFORE DELETE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit_events are append-only');
      END;
    CREATE TRIGGER IF NOT EXISTS audit_event_refs_no_update
      BEFORE UPDATE ON audit_event_refs
      BEGIN
        SELECT RAISE(ABORT, 'audit_event_refs are append-only');
      END;
    CREATE TRIGGER IF NOT EXISTS audit_event_refs_no_delete
      BEFORE DELETE ON audit_event_refs
      BEGIN
        SELECT RAISE(ABORT, 'audit_event_refs are append-only');
      END;
  `);
  AUDIT_SCHEMA_READY.add(db);
}

function sanitizeValue(value, seen = new WeakSet()) {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen));
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(String(key).toLowerCase())) continue;
    out[key] = sanitizeValue(item, seen);
  }
  seen.delete(value);
  return out;
}

function jsonValue(value) {
  if (value == null) return null;
  return JSON.stringify(sanitizeValue(value));
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function pickFields(row, fields) {
  if (!row) return null;
  const out = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(row, field)) out[field] = row[field];
  }
  return out;
}

function valuesEqual(a, b) {
  if (a == null && b == null) return true;
  if (typeof a === "number" || typeof b === "number") {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  }
  return String(a ?? "") === String(b ?? "");
}

function diffFields(before, after, fields) {
  const previous = {};
  const next = {};
  const changed = [];
  for (const field of fields) {
    const oldValue = before?.[field];
    const newValue = after?.[field];
    if (valuesEqual(oldValue, newValue)) continue;
    previous[field] = oldValue ?? null;
    next[field] = newValue ?? null;
    changed.push(field);
  }
  return { before: previous, after: next, changed };
}

function actorFromRequest(req) {
  const user = req?.session?.user;
  if (!user) return { type: "unknown", userId: null, username: "", name: "", role: "" };
  return {
    type: "user",
    userId: Number(user.id) || null,
    username: String(user.username || ""),
    name: String(user.name || ""),
    role: String(user.role || ""),
  };
}

function systemActor(name = "System") {
  return { type: "system", userId: null, username: "SYSTEM", name, role: "system" };
}

function platformActor(name = "Platform API") {
  return { type: "platform", userId: null, username: "PLATFORM", name, role: "platform" };
}

function legacyActor(db, username) {
  const value = String(username || "").trim();
  if (!value) return { type: "unknown", userId: null, username: "", name: "", role: "" };
  const user = tableExists(db, "users")
    ? db.prepare("SELECT id, username, name, role FROM users WHERE username = ? COLLATE NOCASE").get(value)
    : null;
  if (!user) return { type: "unknown", userId: null, username: value, name: "", role: "" };
  return {
    type: "user",
    userId: Number(user.id) || null,
    username: String(user.username || value),
    name: String(user.name || ""),
    role: String(user.role || ""),
  };
}

function normalizeActor(actor) {
  const value = actor || {};
  const type = ACTOR_TYPES.has(value.type) ? value.type : "unknown";
  return {
    type,
    userId: Number(value.userId) || null,
    username: String(value.username || ""),
    name: String(value.name || ""),
    role: String(value.role || ""),
  };
}

function normalizeRefs(refs) {
  const seen = new Set();
  const rows = [];
  for (const ref of refs || []) {
    const type = String(ref?.type || ref?.ref_type || "").trim();
    const id = String(ref?.id ?? ref?.ref_id ?? "").trim();
    if (!type || !id) continue;
    const key = `${type}\u0000${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ type, id });
  }
  return rows;
}

function appendAuditEvent(db, input) {
  ensureAuditSchema(db);
  const companyId = String(input?.companyId || "").trim();
  const action = String(input?.action || "").trim();
  if (!companyId || !action) throw new Error("audit companyId and action are required");
  const source = AUDIT_SOURCES.has(input.source) ? input.source : "user";
  const actor = normalizeActor(input.actor);
  const dedupeKey = input.dedupeKey ? String(input.dedupeKey) : null;
  const occurredAt = String(input.occurredAt || "").trim() || null;
  const result = db.prepare(`
    INSERT OR IGNORE INTO audit_events
      (company_id, action, source, actor_type, actor_user_id, actor_username,
       actor_name, actor_role, summary, reason, before_json, after_json,
       metadata_json, dedupe_key, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  `).run(
    companyId,
    action,
    source,
    actor.type,
    actor.userId,
    actor.username,
    actor.name,
    actor.role,
    String(input.summary || ""),
    String(input.reason || ""),
    jsonValue(input.before),
    jsonValue(input.after),
    jsonValue(input.metadata),
    dedupeKey,
    occurredAt
  );
  let eventId = Number(result.lastInsertRowid || 0);
  if (!eventId && dedupeKey) {
    eventId = Number(
      db.prepare("SELECT id FROM audit_events WHERE company_id = ? AND dedupe_key = ?")
        .get(companyId, dedupeKey)?.id || 0
    );
  }
  if (!eventId) throw new Error("audit event was not created");
  const insertRef = db.prepare(
    "INSERT OR IGNORE INTO audit_event_refs (event_id, company_id, ref_type, ref_id) VALUES (?, ?, ?, ?)"
  );
  for (const ref of normalizeRefs(input.refs)) insertRef.run(eventId, companyId, ref.type, ref.id);
  return eventId;
}

function requireReason(body) {
  const reason = String(body?.reason || "").trim();
  if (!reason) {
    const error = new Error("请填写操作原因");
    error.status = 400;
    throw error;
  }
  if (reason.length > 500) {
    const error = new Error("操作原因不能超过 500 个字符");
    error.status = 400;
    throw error;
  }
  return reason;
}

function ledgerRefs(row) {
  if (!row) return [];
  return normalizeRefs([
    { type: "ledger", id: row.id || row.original_id },
    { type: "transaction", id: row.tx_id },
    { type: "bank_account", id: Number(row.bank_account_id || 0) > 0 ? row.bank_account_id : "" },
    { type: "transfer_group", id: row.transfer_group_id },
  ]);
}

function pendingRefs(row, ledgerRows = []) {
  return normalizeRefs([
    { type: "pending", id: row?.id },
    { type: "transaction", id: row?.tx_id },
    { type: "bank_account", id: Number(row?.bank_account_id || 0) > 0 ? row.bank_account_id : "" },
    ...(ledgerRows || []).flatMap((ledger) => ledgerRefs(ledger)),
  ]);
}

function eventRow(row, refs = []) {
  if (!row) return null;
  return {
    ...row,
    before: parseJson(row.before_json),
    after: parseJson(row.after_json),
    metadata: parseJson(row.metadata_json),
    refs,
  };
}

function backfillAuditHistory(db) {
  ensureAuditSchema(db);
  return runAtomic(db, () => {
    let inserted = 0;
    if (tableExists(db, "bank_ledger_deleted")) {
      const rows = db.prepare("SELECT * FROM bank_ledger_deleted ORDER BY id").all();
      for (const row of rows) {
        const before = db.prepare("SELECT id FROM audit_events WHERE company_id=? AND dedupe_key=?")
          .get(row.company_id, `backfill:bank_ledger_deleted:${row.id}`);
        appendAuditEvent(db, {
          companyId: row.company_id,
          action: "ledger.deleted",
          source: "backfill",
          actor: legacyActor(db, row.deleted_by),
          summary: `历史流水 #${row.original_id} 已删除`,
          before: pickFields({ ...row, id: row.original_id }, LEDGER_FIELDS),
          metadata: { backfilled: true, completeness: "partial", source_table: "bank_ledger_deleted" },
          refs: ledgerRefs(row),
          occurredAt: row.deleted_at,
          dedupeKey: `backfill:bank_ledger_deleted:${row.id}`,
        });
        if (!before) inserted += 1;
      }
    }

    if (tableExists(db, "bank_account_events")) {
      const rows = db.prepare("SELECT * FROM bank_account_events ORDER BY id").all();
      for (const row of rows) {
        const key = `backfill:bank_account_events:${row.id}`;
        const before = db.prepare("SELECT id FROM audit_events WHERE company_id=? AND dedupe_key=?").get(row.company_id, key);
        appendAuditEvent(db, {
          companyId: row.company_id,
          action: `bank_account.${String(row.event || "updated").toLowerCase()}`,
          source: "backfill",
          actor: legacyActor(db, row.actor),
          summary: `历史银行账户 #${row.bank_account_id} ${row.event || "updated"}`,
          reason: row.note || "",
          metadata: { backfilled: true, completeness: "partial", source_table: "bank_account_events" },
          refs: [{ type: "bank_account", id: row.bank_account_id }],
          occurredAt: row.created_at,
          dedupeKey: key,
        });
        if (!before) inserted += 1;
      }
    }

    if (tableExists(db, "bank_tx_pending")) {
      const rows = db.prepare(`
        SELECT * FROM bank_tx_pending
        WHERE approved_at IS NOT NULL OR decided_at IS NOT NULL
        ORDER BY id
      `).all();
      for (const row of rows) {
        if (row.approved_at) {
          const key = `backfill:bank_tx_pending:approved:${row.id}`;
          const before = db.prepare("SELECT id FROM audit_events WHERE company_id=? AND dedupe_key=?").get(row.company_id, key);
          appendAuditEvent(db, {
            companyId: row.company_id,
            action: "pending.approved",
            source: "backfill",
            actor: legacyActor(db, row.approved_by || row.decided_by),
            summary: `历史平台单 ${row.tx_id} 已审批`,
            before: { state: "pending" },
            after: pickFields(row, PENDING_FIELDS),
            metadata: { backfilled: true, completeness: "partial", source_table: "bank_tx_pending" },
            refs: pendingRefs(row),
            occurredAt: row.approved_at,
            dedupeKey: key,
          });
          if (!before) inserted += 1;
        } else if (row.decided_at && ["skipped", "deleted", "expired"].includes(row.state)) {
          const key = `backfill:bank_tx_pending:${row.state}:${row.id}`;
          const before = db.prepare("SELECT id FROM audit_events WHERE company_id=? AND dedupe_key=?").get(row.company_id, key);
          appendAuditEvent(db, {
            companyId: row.company_id,
            action: `pending.${row.state}`,
            source: "backfill",
            actor: row.state === "expired" ? systemActor("\u8df3\u8fc7\u5355\u8fc7\u671f\u4efb\u52a1") : legacyActor(db, row.decided_by),
            summary: `历史平台单 ${row.tx_id} ${row.state}`,
            before: { state: "pending" },
            after: pickFields(row, PENDING_FIELDS),
            metadata: { backfilled: true, completeness: "partial", source_table: "bank_tx_pending" },
            refs: pendingRefs(row),
            occurredAt: row.decided_at,
            dedupeKey: key,
          });
          if (!before) inserted += 1;
        }
      }
    }
    return inserted;
  });
}

module.exports = {
  LEDGER_FIELDS,
  BANK_ACCOUNT_FIELDS,
  PENDING_FIELDS,
  TRANSACTION_AUDIT_FIELDS,
  ensureAuditSchema,
  backfillAuditHistory,
  appendAuditEvent,
  actorFromRequest,
  systemActor,
  platformActor,
  legacyActor,
  pickFields,
  diffFields,
  requireReason,
  ledgerRefs,
  pendingRefs,
  eventRow,
  parseJson,
  sanitizeValue,
  runAtomic,
};
