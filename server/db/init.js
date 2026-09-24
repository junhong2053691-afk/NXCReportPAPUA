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
      ]) {
        if (!baCols.includes(col)) database.exec(`ALTER TABLE bank_accounts ADD COLUMN ${col} ${def}`);
      }
      database.exec(`
        UPDATE bank_accounts
        SET bank_branch = TRIM(CASE WHEN branch != '' AND branch IS NOT NULL THEN bank || ' ' || branch ELSE bank END)
        WHERE (bank_branch = '' OR bank_branch IS NULL) AND bank != ''
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
  try {
    const { ensureAuditSchema, backfillAuditHistory } = require("../lib/auditLog");
    ensureAuditSchema(database);
    const inserted = backfillAuditHistory(database);
    if (inserted > 0) console.log(`[db] audit history backfilled: ${inserted} event(s)`);
  } catch (e) {
    console.warn("[db] audit history:", e.message);
  }
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
