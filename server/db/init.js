const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const { dbPath } = require("../lib/paths");
const DB_PATH = dbPath();
const SCHEMA_PATH = path.join(__dirname, "schema.sql");

let db;

function openDatabase() {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major >= 22) {
    try {
      const { DatabaseSync } = require("node:sqlite");
      return new DatabaseSync(DB_PATH);
    } catch (_) {}
  }
  const Database = require("better-sqlite3");
  return new Database(DB_PATH);
}

function ensureColumn(database, table, column, type) {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function ensurePromoColumns(database) {
  ensureColumn(database, "transactions", "promo_id", "TEXT");
  ensureColumn(database, "transactions", "promo_name", "TEXT");
}

function backfillDateColumns(database) {
  const { dateKeyFromIso } = require("../lib/dates");
  const txRows = database
    .prepare("SELECT id, created_at FROM transactions WHERE created_date IS NULL OR created_date = ''")
    .all();
  if (txRows.length) {
    const stmt = database.prepare("UPDATE transactions SET created_date = ? WHERE id = ?");
    for (const row of txRows) {
      const key = dateKeyFromIso(row.created_at);
      if (key) stmt.run(key, row.id);
    }
  }
  const custRows = database
    .prepare(
      "SELECT id, register_date, last_login FROM customers WHERE register_date_key IS NULL OR register_date_key = '' OR last_login_date IS NULL OR last_login_date = ''"
    )
    .all();
  if (custRows.length) {
    const stmt = database.prepare(
      "UPDATE customers SET register_date_key = ?, last_login_date = ? WHERE id = ?"
    );
    for (const row of custRows) {
      stmt.run(dateKeyFromIso(row.register_date), dateKeyFromIso(row.last_login), row.id);
    }
  }
}

function repairAutoLedgerTimes(database) {
  const { formatSydneyDateTime } = require("../lib/dates");
  const rows = database
    .prepare(
      `SELECT l.id, l.entry_time, t.created_at
       FROM bank_ledger l
       JOIN transactions t ON t.company_id = l.company_id AND t.id = l.tx_id
       WHERE l.auto_generated = 1
         AND l.tx_id != ''
         AND t.created_at IS NOT NULL
         AND t.created_at != ''`
    )
    .all();
  if (!rows.length) return;

  const stmt = database.prepare("UPDATE bank_ledger SET entry_time = ?, updated_at = datetime('now') WHERE id = ?");
  let fixed = 0;
  for (const row of rows) {
    const entryTime = formatSydneyDateTime(row.created_at);
    if (entryTime && entryTime !== row.entry_time) {
      stmt.run(entryTime, row.id);
      fixed += 1;
    }
  }
  if (fixed) console.log(`[db] repaired ${fixed} auto ledger timestamp(s)`);
}

function ensureIndex(database, name, sql) {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
  if (!exists) database.exec(sql);
}

function migrateTransactionTypes(database) {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get();
  if (!row || !row.sql || !row.sql.includes("CHECK (type IN ('DEPOSIT', 'WITHDRAW'))")) return;

  database.exec(`
    CREATE TABLE transactions_new (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      customer_id TEXT,
      username TEXT,
      name TEXT,
      mobile TEXT,
      amount REAL,
      bank_name TEXT,
      bank_account_name TEXT,
      bank_account_number TEXT,
      bank_bsb TEXT,
      payid TEXT,
      method TEXT,
      status TEXT,
      attachment_url TEXT,
      created_at TEXT,
      created_date TEXT,
      processed_at TEXT,
      completed_at TEXT,
      operator TEXT,
      remark TEXT,
      synced_at TEXT
    );
    INSERT INTO transactions_new SELECT * FROM transactions;
    DROP TABLE transactions;
    ALTER TABLE transactions_new RENAME TO transactions;
  `);
  ensureIndex(database, "idx_tx_type", "CREATE INDEX idx_tx_type ON transactions(type)");
  ensureIndex(database, "idx_tx_status", "CREATE INDEX idx_tx_status ON transactions(status)");
  ensureIndex(database, "idx_tx_created", "CREATE INDEX idx_tx_created ON transactions(created_at)");
  ensureIndex(database, "idx_tx_created_date", "CREATE INDEX idx_tx_created_date ON transactions(created_date)");
  console.log("[db] expanded transaction types (BONUS/MANUAL/COMMISSION)");
}

function migrateUserRoles(database) {
  const table = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get();
  const sql = String(table?.sql || "");
  if (sql.includes("'trader'") && !sql.includes("'operator'")) {
    database.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('admin', 'operator')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users_new (id, username, password_hash, name, role, status, created_at, updated_at)
      SELECT id, username, password_hash, name,
        CASE WHEN role = 'admin' THEN 'admin' ELSE 'operator' END,
        status, created_at, updated_at
      FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
    console.log("[db] migrated user roles: trader -> operator");
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS user_companies (
      user_id INTEGER NOT NULL,
      company_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, company_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_companies_company ON user_companies(company_id);
  `);
}

const { migrateMultiCompany } = require("./migrateMultiCompany");

function migrate(database) {
  migrateUserRoles(database);
  migrateTransactionTypes(database);
  ensureColumn(database, "transactions", "created_date", "TEXT");
  ensureColumn(database, "customers", "register_date_key", "TEXT");
  ensureColumn(database, "customers", "last_login_date", "TEXT");
  ensurePromoColumns(database);
  try {
    backfillDateColumns(database);
  } catch (e) {
    console.warn("[db] backfill skipped:", e.message);
  }
  ensureIndex(database, "idx_tx_created_date", "CREATE INDEX idx_tx_created_date ON transactions(created_date)");
  ensureIndex(
    database,
    "idx_customers_last_login_date",
    "CREATE INDEX idx_customers_last_login_date ON customers(last_login_date)"
  );
  ensureIndex(
    database,
    "idx_customers_register_date_key",
    "CREATE INDEX idx_customers_register_date_key ON customers(register_date_key)"
  );
  ensureIndex(database, "idx_tx_promo_name", "CREATE INDEX idx_tx_promo_name ON transactions(promo_name)");
  ensureIndex(database, "idx_tx_bonus_date", "CREATE INDEX idx_tx_bonus_date ON transactions(type, created_date)");
  try {
    migrateMultiCompany(database);
  } catch (e) {
    console.warn("[db] multi-company migration:", e.message);
  }
  // 每公司一个独立 Telegram Bot：token 与收件 chat 跟着公司走，在公司设置页由 admin 编辑。
  // 总控 Bot 的 token / 白名单在 config.json 的 telegram 块，不落库。
  try {
    ensureColumn(database, "companies", "telegram_bot_token", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(database, "companies", "telegram_chat_ids", "TEXT NOT NULL DEFAULT ''");
  } catch (e) {
    console.warn("[db] companies telegram columns:", e.message);
  }
  ensureIndex(database, "idx_customers_company_id", "CREATE INDEX idx_customers_company_id ON customers(company_id)");
  ensureIndex(
    database,
    "idx_customers_company_login",
    "CREATE INDEX idx_customers_company_login ON customers(company_id, last_login_date)"
  );
  ensureIndex(
    database,
    "idx_customers_company_dep",
    "CREATE INDEX idx_customers_company_dep ON customers(company_id, dep_total DESC)"
  );
  ensureIndex(
    database,
    "idx_tx_company_type_date",
    "CREATE INDEX idx_tx_company_type_date ON transactions(company_id, type, created_date)"
  );
  ensureIndex(
    database,
    "idx_tx_company_cust_type",
    "CREATE INDEX idx_tx_company_cust_type ON transactions(company_id, customer_id, type)"
  );
  // bank_ledger table
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS bank_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_account_id INTEGER NOT NULL DEFAULT 0,
      company_id TEXT NOT NULL DEFAULT '',
      entry_time TEXT NOT NULL DEFAULT (datetime('now')),
      tx_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'deposit',
      amount_in REAL NOT NULL DEFAULT 0,
      amount_out REAL NOT NULL DEFAULT 0,
      help_amount REAL NOT NULL DEFAULT 0,
      trf_amount REAL NOT NULL DEFAULT 0,
      bank_acc TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      c_status TEXT NOT NULL DEFAULT '',
      other_info TEXT NOT NULL DEFAULT '',
      remark TEXT NOT NULL DEFAULT '',
      auto_generated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    database.exec("CREATE INDEX IF NOT EXISTS idx_ledger_bank_id ON bank_ledger(bank_account_id)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_ledger_company ON bank_ledger(company_id)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_ledger_tx_id ON bank_ledger(tx_id)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_ledger_time ON bank_ledger(entry_time)");
    database.exec(`CREATE TABLE IF NOT EXISTS bank_ledger_deleted (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_id INTEGER NOT NULL DEFAULT 0,
      bank_account_id INTEGER NOT NULL DEFAULT 0,
      company_id TEXT NOT NULL DEFAULT '',
      entry_time TEXT NOT NULL DEFAULT '',
      tx_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'deposit',
      amount_in REAL NOT NULL DEFAULT 0,
      amount_out REAL NOT NULL DEFAULT 0,
      help_amount REAL NOT NULL DEFAULT 0,
      trf_amount REAL NOT NULL DEFAULT 0,
      bank_acc TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      c_status TEXT NOT NULL DEFAULT '',
      other_info TEXT NOT NULL DEFAULT '',
      remark TEXT NOT NULL DEFAULT '',
      auto_generated INTEGER NOT NULL DEFAULT 0,
      transfer_group_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_by TEXT NOT NULL DEFAULT ''
    )`);
    database.exec("CREATE INDEX IF NOT EXISTS idx_ledger_deleted_company ON bank_ledger_deleted(company_id, deleted_at)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_ledger_deleted_original ON bank_ledger_deleted(original_id)");
    database.exec(`
      UPDATE bank_ledger
      SET status = CASE
        WHEN amount_in > 0 THEN 'deposit'
        WHEN amount_out > 0 THEN 'withdraw'
        WHEN trf_amount > 0 THEN 'bank transfer'
        WHEN help_amount > 0 THEN 'bank trf'
        ELSE 'deposit'
      END
      WHERE TRIM(COALESCE(status, '')) = ''
    `);
  } catch (e) {
    console.warn("[db] bank_ledger migration:", e.message);
  }
  // bank_balance_log (created via schema.sql, ensure for older DBs)
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS bank_balance_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_account_id INTEGER NOT NULL,
      tx_id TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tx_id)
    )`);
  } catch (e) {
    console.warn("[db] bank_balance_log migration:", e.message);
  }
  // bank_accounts table (created via schema.sql, this just ensures columns for older DBs)
  try {
    const baCols = database.prepare("PRAGMA table_info(bank_accounts)").all().map((c) => c.name);
    if (baCols.length) {
      for (const [col, def] of [
        ["note", "TEXT NOT NULL DEFAULT ''"],
        ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
        ["bank_branch", "TEXT NOT NULL DEFAULT ''"],
        ["account_kind", "TEXT NOT NULL DEFAULT 'nominee'"],
        ["lifecycle_status", "TEXT NOT NULL DEFAULT 'active'"],
        ["reset_daily_balance", "INTEGER NOT NULL DEFAULT 0"],
        ["alert_threshold", "REAL NOT NULL DEFAULT 0"],
        ["alert_fired_at", "TEXT NOT NULL DEFAULT ''"],
        ["alert_fired_date", "TEXT NOT NULL DEFAULT ''"],
        // 上次报警时的余额，「超标期间创新高才再报」的比较基准。旧库补出来是 0，
        // 于是升级后正在超标且已报过的账户会立刻再报一条——那是对的（新规则下它本来
        // 就该报），而且只有一条。
        ["alert_fired_balance", "REAL NOT NULL DEFAULT 0"],
      ]) {
        if (!baCols.includes(col)) database.exec(`ALTER TABLE bank_accounts ADD COLUMN ${col} ${def}`);
      }
      database.exec(`
        UPDATE bank_accounts
        SET bank_branch = TRIM(CASE WHEN branch != '' AND branch IS NOT NULL THEN bank || ' ' || branch ELSE bank END)
        WHERE (bank_branch = '' OR bank_branch IS NULL) AND bank != ''
      `);
      // 生命周期状态归一化。lifecycle_status 已不在 PUT 白名单里（只能经 ban/unban/
      // archive/unarchive 改），这条是迁移侧的对位保险：手工改库或旧数据留下的枚举外
      // 值会被 lib/bankLifecycle 当成 archived（失败关闭），这里把它落到 banned，让它
      // 出现在「封禁中」待清理队列里而不是无声消失。
      // 归到 banned 而不是 active：宁可让人点一次解封，也不要让一个来历不明的账户
      // 直接开始收钱。幂等，现实中匹配 0 行。
      database.exec(`
        UPDATE bank_accounts SET lifecycle_status = 'banned', active = 0
        WHERE lifecycle_status NOT IN ('active', 'banned', 'archived')
      `);
    }
  } catch (e) {
    console.warn("[db] bank_accounts migration:", e.message);
  }
  try {
    ensureColumn(database, "bank_ledger", "transfer_group_id", "TEXT NOT NULL DEFAULT ''");
  } catch (e) {
    console.warn("[db] bank_ledger transfer_group_id:", e.message);
  }
  try {
    // Migrate helper rows created by the old withdraw-split flow. The marker
    // keeps ordinary CASH IN rows and manual transfer mirrors unchanged.
    database.exec(`
      UPDATE bank_ledger
      SET status = 'withdraw'
      WHERE auto_generated = 1
        AND status = 'cash in'
        AND tx_id <> ''
        AND transfer_group_id <> ''
        AND other_info LIKE 'WITHDRAW % split %'
    `);
  } catch (e) {
    console.warn("[db] bank_ledger withdraw split status migration:", e.message);
  }
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS bank_account_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL DEFAULT '',
      bank_account_id INTEGER NOT NULL,
      event TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    database.exec(
      "CREATE INDEX IF NOT EXISTS idx_bank_events_acc ON bank_account_events(bank_account_id, created_at)"
    );
  } catch (e) {
    console.warn("[db] bank_account_events:", e.message);
  }
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS bank_c_status_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      target_company_id TEXT NOT NULL DEFAULT '',
      reconcile_required INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE(company_id, name)
    )`);
    ensureColumn(database, "bank_c_status_options", "reconcile_required", "INTEGER NOT NULL DEFAULT 0");
  } catch (e) {
    console.warn("[db] bank_c_status_options:", e.message);
  }
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS bank_status_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL DEFAULT '',
      value TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#64748b',
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(company_id, value)
    )`);
  } catch (e) {
    console.warn("[db] bank_status_options:", e.message);
  }
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS bank_tx_pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL DEFAULT '',
      tx_id TEXT NOT NULL DEFAULT '',
      tx_type TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL DEFAULT 0,
      username TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      tx_time TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'pending',
      bank_account_id INTEGER NOT NULL DEFAULT 0,
      approve_mode TEXT NOT NULL DEFAULT '',
      c_status TEXT NOT NULL DEFAULT '',
      approved_entry_time TEXT NOT NULL DEFAULT '',
      approved_at TEXT,
      approved_by TEXT NOT NULL DEFAULT '',
      decided_at TEXT,
      decided_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_id, tx_id)
    )`);
    database.exec(
      "CREATE INDEX IF NOT EXISTS idx_bank_pending_state ON bank_tx_pending(company_id, state)"
    );
    ensureColumn(database, "bank_tx_pending", "approved_entry_time", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(database, "bank_tx_pending", "approved_at", "TEXT");
    ensureColumn(database, "bank_tx_pending", "approved_by", "TEXT NOT NULL DEFAULT ''");
    const migratedHelpRows = database.prepare(`
      UPDATE bank_ledger
      SET trf_amount = amount_in,
          amount_in = 0,
          updated_at = datetime('now')
      WHERE auto_generated = 1
        AND status = 'cash in'
        AND amount_in > 0
        AND trf_amount = 0
        AND EXISTS (
          SELECT 1
          FROM bank_tx_pending p
          WHERE p.company_id = bank_ledger.company_id
            AND p.tx_id = bank_ledger.tx_id
            AND p.approve_mode = 'help'
        )
    `).run();
    if (Number(migratedHelpRows?.changes || 0) > 0) {
      console.log(`[db] moved ${migratedHelpRows.changes} helped withdraw rows to HELP TRF`);
    }
    repairAutoLedgerTimes(database);
  } catch (e) {
    console.warn("[db] bank_tx_pending:", e.message);
  }
  // Telegram 出站队列 + bot 轮询游标（老库兜底，新库由 schema.sql 建）
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS telegram_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL DEFAULT '',
      bot_key TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'alert',
      bank_account_id INTEGER NOT NULL DEFAULT 0,
      text TEXT NOT NULL DEFAULT '',
      parse_mode TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT
    )`);
    // 'HTML' = text 已转义且含 <pre>；'' = 纯文本。老库里已有的 pending 行默认 ''，
    // 于是照纯文本发出去，不会因为未转义的 `&` 被 Telegram 400 掉。
    ensureColumn(database, "telegram_outbox", "parse_mode", "TEXT NOT NULL DEFAULT ''");
    database.exec(
      "CREATE INDEX IF NOT EXISTS idx_tg_outbox_state ON telegram_outbox(state, id)"
    );
  } catch (e) {
    console.warn("[db] telegram_outbox:", e.message);
  }
  // 已发出的报警消息，复位时凭 message_id 撤回（老库兜底，新库由 schema.sql 建）
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS telegram_sent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outbox_id INTEGER NOT NULL DEFAULT 0,
      company_id TEXT NOT NULL DEFAULT '',
      bank_account_id INTEGER NOT NULL DEFAULT 0,
      bot_key TEXT NOT NULL DEFAULT '',
      chat_id TEXT NOT NULL DEFAULT '',
      message_id INTEGER NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      retracted_at TEXT NOT NULL DEFAULT '',
      retract_method TEXT NOT NULL DEFAULT '',
      retract_error TEXT NOT NULL DEFAULT ''
    )`);
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_tg_sent_outstanding
       ON telegram_sent_messages(bank_account_id, retracted_at, outbox_id)`
    );
  } catch (e) {
    console.warn("[db] telegram_sent_messages:", e.message);
  }
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS telegram_bot_state (
      bot_key TEXT PRIMARY KEY,
      update_offset INTEGER NOT NULL DEFAULT 0,
      token_fingerprint TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  } catch (e) {
    console.warn("[db] telegram_bot_state:", e.message);
  }
  // 全局设置 KV（老库兜底，新库由 schema.sql 建）
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT NOT NULL DEFAULT ''
    )`);
  } catch (e) {
    console.warn("[db] app_settings:", e.message);
  }
  // Google Sheets 同步（老库兜底，新库由 schema.sql 建）。
  // 全局凭证与节奏走 app_settings 的 'sheets' 键，这里只有 per-company 的部分。
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS sheets_settings (
      company_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      spreadsheet_id TEXT NOT NULL DEFAULT '',
      sa_client_email TEXT NOT NULL DEFAULT '',
      sa_private_key TEXT NOT NULL DEFAULT '',
      tx_enabled INTEGER NOT NULL DEFAULT 1,
      tx_start_month TEXT NOT NULL DEFAULT '',
      tx_columns_profile TEXT NOT NULL DEFAULT 'minimal',
      ledger_enabled INTEGER NOT NULL DEFAULT 1,
      daily_enabled INTEGER NOT NULL DEFAULT 1,
      monthly_enabled INTEGER NOT NULL DEFAULT 1,
      input_enabled INTEGER NOT NULL DEFAULT 1,
      input_buffer_rows INTEGER NOT NULL DEFAULT 200,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    database.exec(`CREATE TABLE IF NOT EXISTS sheets_sync_state (
      company_id TEXT PRIMARY KEY,
      last_event_id INTEGER NOT NULL DEFAULT 0,
      dirty_tabs_json TEXT NOT NULL DEFAULT '[]',
      last_daily_hash TEXT NOT NULL DEFAULT '',
      last_ledger_hash TEXT NOT NULL DEFAULT '',
      last_monthly_hash TEXT NOT NULL DEFAULT '',
      last_options_hash TEXT NOT NULL DEFAULT '',
      ledger_row_count INTEGER NOT NULL DEFAULT 0,
      daily_row_count INTEGER NOT NULL DEFAULT 0,
      input_next_row INTEGER NOT NULL DEFAULT 0,
      last_count_check_at TEXT NOT NULL DEFAULT '',
      last_push_at TEXT,
      last_push_ok INTEGER,
      last_push_msg TEXT NOT NULL DEFAULT '',
      pushed_rows_total INTEGER NOT NULL DEFAULT 0,
      last_import_at TEXT,
      imported_rows_total INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    database.exec(`CREATE TABLE IF NOT EXISTS sheets_row_map (
      company_id TEXT NOT NULL,
      tab_title TEXT NOT NULL,
      row_key TEXT NOT NULL,
      row_number INTEGER NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (company_id, tab_title, row_key)
    )`);
    database.exec(`CREATE TABLE IF NOT EXISTS sheets_manual_entries (
      company_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      row_number INTEGER NOT NULL DEFAULT 0,
      ledger_id INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'ok',
      message TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (company_id, entry_id)
    )`);
    ensureIndex(
      database,
      "idx_sheets_rowmap_pos",
      "CREATE INDEX idx_sheets_rowmap_pos ON sheets_row_map(company_id, tab_title, row_number)"
    );
    ensureIndex(
      database,
      "idx_sheets_manual_state",
      "CREATE INDEX idx_sheets_manual_state ON sheets_manual_entries(company_id, state, imported_at DESC)"
    );
  } catch (e) {
    console.warn("[db] sheets sync:", e.message);
  }
  // 数据库快照备份日志（老库兜底，新库由 schema.sql 建）
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS db_backup_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT 'daily',
      file_path TEXT NOT NULL DEFAULT '',
      bytes INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      ok INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      pruned INTEGER NOT NULL DEFAULT 0
    )`);
    ensureIndex(
      database,
      "idx_db_backup_log_time",
      "CREATE INDEX idx_db_backup_log_time ON db_backup_log(started_at DESC)"
    );
  } catch (e) {
    console.warn("[db] db_backup_log:", e.message);
  }
  try {
    const { ensureAuditSchema, backfillAuditHistory } = require("../lib/auditLog");
    ensureAuditSchema(database);
    const inserted = backfillAuditHistory(database);
    if (inserted > 0) console.log(`[db] audit history backfilled: ${inserted} event(s)`);
  } catch (e) {
    console.warn("[db] audit history:", e.message);
  }
}

/**
 * 把实例 locale（时区 + 币种）注入进程。
 *
 * ⚠️ 必须在 getDb() 内部、conn.exec(schema) 之后、**migrate(conn) 之前**调。因为
 * migrate 会跑 backfillDateColumns()（用 dateKeyFromIso）和 repairAutoLedgerTimes()
 * （用 formatWallClock），放到 migrate 之后这两个就会在默认 Sydney 下执行。
 * app_settings 表在 conn.exec(schema) 之后就存在了。
 *
 * index.js 里 scheduler / telegramBots / backup / cleanup 全在 getDb() 之后启动，
 * 所以这一处注入覆盖整个进程。
 */
function bootstrapLocale(database) {
  const { getLocaleSettings, saveLocaleSettings, LOCALE_KEY } = require("../lib/appSettings");
  const { setLocale } = require("../lib/locale");
  try {
    // 首次启动从 config.json 的 timezone 播种。那是 DB 还不存在时唯一能设时区的
    // 地方，也让 DEPLOY.md 里「config.json → timezone」那句话从此成立——它在这次
    // 改动之前是个全项目零读取的死配置。
    const existing = database.prepare("SELECT 1 FROM app_settings WHERE key = ?").get(LOCALE_KEY);
    if (!existing) {
      let tz = "";
      try {
        tz = String(require("../lib/readConfig").readConfig().timezone || "").trim();
      } catch (_) {}
      if (tz) saveLocaleSettings(database, { timezone: tz }, "bootstrap");
    }
  } catch (e) {
    // 播种失败不该让进程起不来：下面的 getLocaleSettings 会退回默认值。
    console.warn("[db] locale seed:", e.message);
  }
  const applied = setLocale(getLocaleSettings(database));
  console.log(`[db] locale: ${applied.timezone} / ${applied.currency}`);
  return applied;
}

function applyDbPragmas(conn) {
  const pragmas = [
    "PRAGMA journal_mode = WAL",
    "PRAGMA busy_timeout = 10000",
    "PRAGMA synchronous = NORMAL",
    "PRAGMA temp_store = MEMORY",
    "PRAGMA cache_size = -64000",
  ];
  for (const p of pragmas) {
    try {
      conn.exec(p);
    } catch (_) {}
  }
}

function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const conn = openDatabase();
    applyDbPragmas(conn);
    conn.exec(fs.readFileSync(SCHEMA_PATH, "utf8").replace(/^\uFEFF/, ""));
    bootstrapLocale(conn);
    migrate(conn);
    ensurePromoColumns(conn);
    db = conn;
  }
  return db;
}

function seedAdmin(cfg) {
  const database = getDb();
  if (database.prepare("SELECT COUNT(*) AS n FROM users").get().n > 0) return;
  const { username, password, name } = cfg.admin;
  const hash = bcrypt.hashSync(password, 10);
  database
    .prepare(
      "INSERT INTO users (username, password_hash, name, role, status) VALUES (?, ?, ?, 'admin', 'active')"
    )
    .run(username, hash, name || "\u7ba1\u7406\u5458");
  console.log("[db] admin account created:", username);
}

module.exports = { getDb, seedAdmin, DB_PATH, ensurePromoColumns };
