const fs = require("fs");
const { readConfig } = require("./readConfig");
const { syncStatePath } = require("./paths");
const { runAtomic } = require("./auditLog");

const PRESETS = [
  { id: "aussiex6", name: "AussieX6", sort_order: 1 },
  { id: "rolex66", name: "Rolex66", sort_order: 2 },
  { id: "ezspin68", name: "EzSpin68", sort_order: 3 },
  { id: "pokies7bet", name: "Pokies7Bet", sort_order: 4 },
];

function maskToken(token) {
  const t = String(token || "");
  if (t.length <= 8) return t ? "****" : "";
  return t.slice(0, 4) + "…" + t.slice(-4);
}

function rowToPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    api_url: row.api_url || "",
    access_id: row.access_id || "",
    access_token_set: Boolean(row.access_token),
    access_token_masked: maskToken(row.access_token),
    enabled: Boolean(row.enabled),
    sort_order: row.sort_order || 0,
    last_sync_at: row.last_sync_at || null,
    last_sync_ok: row.last_sync_ok == null ? null : Boolean(row.last_sync_ok),
    last_sync_msg: row.last_sync_msg || "",
    has_credentials: Boolean(row.api_url && row.access_id && row.access_token),
    // Telegram bot token 与 access_token 同等敏感，只回脱敏值，永不返回明文。
    // chat id 不是机密（拿到也没法冒充 bot），明文返回方便前端回填。
    telegram_bot_token_set: Boolean(row.telegram_bot_token),
    telegram_bot_token_masked: maskToken(row.telegram_bot_token),
    telegram_chat_ids: row.telegram_chat_ids || "",
  };
}

function listCompanies(db) {
  return db
    .prepare("SELECT * FROM companies ORDER BY sort_order ASC, name ASC")
    .all()
    .map(rowToPublic);
}

function listEnabledCompanies(db) {
  return db
    .prepare(
      "SELECT * FROM companies WHERE enabled = 1 AND api_url != '' AND access_id != '' AND access_token != '' ORDER BY sort_order ASC"
    )
    .all();
}

function getCompany(db, id) {
  return db.prepare("SELECT * FROM companies WHERE id = ?").get(id) || null;
}

function getCompanyCredentials(db, id) {
  const row = getCompany(db, id);
  if (!row || !row.api_url || !row.access_id || !row.access_token) return null;
  return {
    id: row.id,
    name: row.name,
    apiUrl: row.api_url,
    accessId: String(row.access_id),
    accessToken: String(row.access_token),
  };
}

function updateSyncStatus(db, id, ok, message) {
  db.prepare(
    "UPDATE companies SET last_sync_at = datetime('now'), last_sync_ok = ?, last_sync_msg = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(ok ? 1 : 0, String(message || "").slice(0, 500), id);
}

function nextSortOrder(db) {
  const row = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM companies").get();
  return row?.n || 1;
}

function upsertCompany(db, data) {
  const id = String(data.id || "").trim().toLowerCase();
  if (!id) throw new Error("company id required");
  const existing = getCompany(db, id);
  const token = data.access_token != null && data.access_token !== "" ? data.access_token : existing?.access_token || "";
  let enabled;
  if (data.enabled === false || data.enabled === 0) enabled = 0;
  else if (data.enabled === true || data.enabled === 1) enabled = 1;
  else enabled = existing ? existing.enabled : 0;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) : existing ? existing.sort_order : nextSortOrder(db);
  // Telegram bot token 与 access_token 同样走「留空 = 保持不变」，这样前端可以只显示
  // 脱敏值、不回填明文，而用户不改这一栏时也不会把 token 清空。
  const tgToken =
    data.telegram_bot_token != null && data.telegram_bot_token !== ""
      ? data.telegram_bot_token
      : existing?.telegram_bot_token || "";
  // chat id 则是普通字段：传空字符串就是真的要清空收件人。
  const tgChats =
    data.telegram_chat_ids != null ? data.telegram_chat_ids : existing?.telegram_chat_ids || "";
  db.prepare(
    `INSERT INTO companies
       (id, name, api_url, access_id, access_token, enabled, sort_order,
        telegram_bot_token, telegram_chat_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       api_url = excluded.api_url,
       access_id = excluded.access_id,
       access_token = CASE WHEN excluded.access_token != '' THEN excluded.access_token ELSE companies.access_token END,
       enabled = excluded.enabled,
       sort_order = excluded.sort_order,
       telegram_bot_token = CASE WHEN excluded.telegram_bot_token != '' THEN excluded.telegram_bot_token ELSE companies.telegram_bot_token END,
       telegram_chat_ids = excluded.telegram_chat_ids,
       updated_at = datetime('now')`
  ).run(
    id,
    String(data.name || id).trim(),
    String(data.api_url || "").trim(),
    String(data.access_id || "").trim(),
    String(token || "").trim(),
    enabled,
    sortOrder,
    String(tgToken || "").trim(),
    String(tgChats || "").trim()
  );
  return getCompany(db, id);
}

function seedCompaniesFromConfig(db) {
  const cfg = readConfig();
  const platform = cfg.platform || {};
  const demoTenant = Boolean(cfg.demoTenant);
  if (demoTenant) {
    if (!getCompany(db, "demo")) {
      upsertCompany(db, {
        id: "demo",
        name: "试用 Demo",
        api_url: "",
        access_id: "",
        access_token: "",
        enabled: 1,
        sort_order: 0,
      });
    }
    return;
  }
  const apiUrl = platform.apiUrl || platform.apiUrl || "";
  const accessId = platform.accessId || platform.accessId || "";
  const accessToken = platform.accessToken || platform.accessToken || platform.apiKey || "";
  for (const preset of PRESETS) {
    const exists = getCompany(db, preset.id);
    if (exists) {
      db.prepare("UPDATE companies SET name = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?").run(
        preset.name,
        preset.sort_order,
        preset.id
      );
      continue;
    }
    const isDefault = preset.id === "aussiex6";
    upsertCompany(db, {
      id: preset.id,
      name: preset.name,
      api_url: isDefault ? apiUrl : "",
      access_id: isDefault ? accessId : "",
      access_token: isDefault ? accessToken : "",
      enabled: isDefault ? 1 : 0,
      sort_order: preset.sort_order,
    });
  }
}

function deleteCompany(db, id) {
  const row = getCompany(db, id);
  if (!row) return null;
  const total = db.prepare("SELECT COUNT(*) AS n FROM companies").get().n;
  if (total <= 1) throw new Error("至少保留一家公司，无法删除");
  // 不能用 db.transaction()：那是 better-sqlite3 专有 API，
  // 生产在 Node >= 22 上走 node:sqlite，该属性为 undefined → TypeError。
  runAtomic(db, () => {
    db.prepare("DELETE FROM transactions WHERE company_id = ?").run(id);
    db.prepare("DELETE FROM customers WHERE company_id = ?").run(id);
    db.prepare("DELETE FROM daily_stats WHERE company_id = ?").run(id);
    db.prepare("DELETE FROM companies WHERE id = ?").run(id);
  });
  const syncFile = syncStatePath(id);
  try {
    fs.unlinkSync(syncFile);
  } catch (_) {}
  return row;
}

function defaultCompanyId(db) {
  const row = db
    .prepare(
      "SELECT id FROM companies WHERE enabled = 1 ORDER BY sort_order ASC LIMIT 1"
    )
    .get();
  return row?.id || (readConfig().demoTenant ? "demo" : "aussiex6");
}

module.exports = {
  PRESETS,
  listCompanies,
  listEnabledCompanies,
  getCompany,
  getCompanyCredentials,
  updateSyncStatus,
  upsertCompany,
  deleteCompany,
  nextSortOrder,
  seedCompaniesFromConfig,
  defaultCompanyId,
  rowToPublic,
  maskToken,
};
