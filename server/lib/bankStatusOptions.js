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

// 状态可由公司自定义，所以校验格式而不是固定名单。这个值会变成前端的 CSS 类名：
// 曾经不限字符时，operator 写一个含引号的 status 就能在 admin 的浏览器里执行脚本。
const STATUS_VALUE_RE = /^[a-z0-9][a-z0-9 ._-]{0,39}$/;

function isValidStatusValue(value) {
  return STATUS_VALUE_RE.test(String(value || ""));
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
  if (!isValidStatusValue(value)) throw Object.assign(new Error("状态值格式无效"), { status: 400 });
  const label = String(body.label || defaultLabel(value)).trim();
  // 必须校验成严格的 6 位 hex。这个值会被前端拼进 style="..." 属性
  // （public/js/bank-accounts.js 的 statusStyleAttr → gridCellHtml/roCellHtml，
  // 两处都没有转义），所以一个含引号的 color 就能闭合属性并注入事件处理器，
  // 让任何 operator 在 admin 的浏览器里执行 JS，进而改走公司 API 凭证。
  const rawColor = String(body.color || "").trim();
  const color = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor : "#64748b";
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
  isValidStatusValue,
  listStatusOptions,
  upsertStatusOption,
  deleteStatusOption,
};
