const DEFAULT_STATUS_OPTIONS = [
  { n: 0, value: "redeposit", label: "0. REDEP", color: "#ca8a04" },
  { n: 1, value: "deposit", label: "1. DEPOSIT", color: "#10b981" },
  { n: 2, value: "withdraw", label: "2. WITHDRAW", color: "#e11d48" },
  { n: 3, value: "wrong", label: "3. WRONG", color: "#f59e0b" },
  { n: 4, value: "cash in", label: "4. CASH IN", color: "#2563eb" },
  { n: 5, value: "cash out", label: "5. CASH OUT", color: "#f43f5e" },
  { n: 6, value: "give back", label: "6. GIVE BACK", color: "#7c3aed" },
  { n: 7, value: "expenses", label: "7. EXPENSES", color: "#64748b" },
  { n: 8, value: "exchange", label: "8. EXCHANGE", color: "#0ea5e9" },
  { n: 9, value: "new", label: "9. NEW", color: "#22c55e" },
  { value: "bank trf", label: "BANK TRF", color: "#06b6d4" },
  { value: "bank transfer", label: "BANK TRANSFER", color: "#14b8a6" },
  { value: "unclaim", label: "UNCLAIM", color: "#94a3b8" },
  { value: "amopay", label: "AMOPAY", color: "#a855f7" },
  { value: "test in", label: "TEST IN", color: "#059669" },
  { value: "test out", label: "TEST OUT", color: "#f97316" },
];

function normalizeStatusValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function defaultLabel(value) {
  return normalizeStatusValue(value).toUpperCase();
}

function ensureStatusOptions(db, companyId) {
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM bank_status_options WHERE company_id = ?")
    .get(companyId).n;
  if (count) return;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO bank_status_options
      (company_id, value, label, color, sort_order, active)
    VALUES (?, ?, ?, ?, ?, 1)
  `);
  const seedDefaults = () => {
    DEFAULT_STATUS_OPTIONS.forEach((s, idx) => {
      insert.run(companyId, s.value, s.label, s.color, idx);
    });
  };
  if (typeof db.transaction === "function") {
    db.transaction(seedDefaults)();
    return;
  }
  db.exec("BEGIN");
  try {
    seedDefaults();
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch (_) {}
    throw e;
  }
}

function listStatusOptions(db, companyId) {
  ensureStatusOptions(db, companyId);
  return db.prepare(`
    SELECT value, label, color, sort_order, active
    FROM bank_status_options
    WHERE company_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(companyId);
}

function upsertStatusOption(db, companyId, body) {
  const value = normalizeStatusValue(body.value || body.label);
  if (!value) throw Object.assign(new Error("status value required"), { status: 400 });
  const label = String(body.label || defaultLabel(value)).trim();
  const color = String(body.color || "#64748b").trim();
  const active = body.active === undefined ? 1 : (body.active ? 1 : 0);
  const maxOrder = db
    .prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM bank_status_options WHERE company_id = ?")
    .get(companyId).m;
  db.prepare(`
    INSERT INTO bank_status_options (company_id, value, label, color, sort_order, active)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id, value) DO UPDATE SET
      label = excluded.label,
      color = excluded.color,
      active = excluded.active
  `).run(companyId, value, label, color, maxOrder + 1, active);
  return db.prepare(`
    SELECT value, label, color, sort_order, active
    FROM bank_status_options
    WHERE company_id = ? AND value = ?
  `).get(companyId, value);
}

function deleteStatusOption(db, companyId, value) {
  const normalized = normalizeStatusValue(value);
  db.prepare("DELETE FROM bank_status_options WHERE company_id = ? AND value = ?").run(companyId, normalized);
}

module.exports = {
  DEFAULT_STATUS_OPTIONS,
  normalizeStatusValue,
  listStatusOptions,
  upsertStatusOption,
  deleteStatusOption,
};
