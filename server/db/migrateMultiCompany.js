const { readConfig } = require("../lib/readConfig");
const { seedCompaniesFromConfig } = require("../lib/companies");

const DEFAULT_COMPANY = "aussiex6";

function tableSql(database, name) {
  return database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql || "";
}

function hasCompanyColumn(database, table) {
  return database
    .prepare("PRAGMA table_info(" + table + ")")
    .all()
    .some((c) => c.name === "company_id");
}

function migrateCustomers(database) {
  if (tableSql(database, "customers").includes("PRIMARY KEY (company_id, id)")) return;
  database.exec(`
    CREATE TABLE customers_mc (
      company_id TEXT NOT NULL,
      id TEXT NOT NULL,
      username TEXT,
      name TEXT,
      mobile TEXT,
      bank_account TEXT,
      bank_name TEXT,
      referrer TEXT,
      top_referrer TEXT,
      dep_count INTEGER DEFAULT 0,
      dep_total REAL DEFAULT 0,
      wd_count INTEGER DEFAULT 0,
      wd_total REAL DEFAULT 0,
      win_loss REAL DEFAULT 0,
      last_deposit TEXT,
      last_login TEXT,
      register_date TEXT,
      register_date_key TEXT,
      last_login_date TEXT,
      synced_at TEXT,
      PRIMARY KEY (company_id, id)
    );
    INSERT INTO customers_mc (
      company_id, id, username, name, mobile, bank_account, bank_name, referrer, top_referrer,
      dep_count, dep_total, wd_count, wd_total, win_loss, last_deposit, last_login,
      register_date, register_date_key, last_login_date, synced_at
    )
    SELECT '${DEFAULT_COMPANY}', id, username, name, mobile, bank_account, bank_name, referrer, top_referrer,
      dep_count, dep_total, wd_count, wd_total, win_loss, last_deposit, last_login,
      register_date, register_date_key, last_login_date, synced_at
    FROM customers;
    DROP TABLE customers;
    ALTER TABLE customers_mc RENAME TO customers;
  `);
  console.log("[db] customers migrated to (company_id, id)");
}

function migrateTransactions(database) {
  if (tableSql(database, "transactions").includes("PRIMARY KEY (company_id, id)")) return;
  const cols = database.prepare("PRAGMA table_info(transactions)").all().map((c) => c.name);
  const hasPromo = cols.includes("promo_name");
  database.exec(`
    CREATE TABLE transactions_mc (
      company_id TEXT NOT NULL,
      id TEXT NOT NULL,
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
      promo_id TEXT,
      promo_name TEXT,
      synced_at TEXT,
      PRIMARY KEY (company_id, id)
    );
    INSERT INTO transactions_mc (
      company_id, id, type, customer_id, username, name, mobile, amount,
      bank_name, bank_account_name, bank_account_number, bank_bsb, payid,
      method, status, attachment_url, created_at, created_date, processed_at, completed_at,
      operator, remark, promo_id, promo_name, synced_at
    )
    SELECT '${DEFAULT_COMPANY}', id, type, customer_id, username, name, mobile, amount,
      bank_name, bank_account_name, bank_account_number, bank_bsb, payid,
      method, status, attachment_url, created_at, created_date, processed_at, completed_at,
      operator, remark,
      ${hasPromo ? "promo_id, promo_name" : "NULL, NULL"},
      synced_at
    FROM transactions;
    DROP TABLE transactions;
    ALTER TABLE transactions_mc RENAME TO transactions;
  `);
  console.log("[db] transactions migrated to (company_id, id)");
}

function migrateDailyStats(database) {
  if (tableSql(database, "daily_stats").includes("PRIMARY KEY (company_id, date)")) return;
  database.exec(`
    CREATE TABLE daily_stats_mc (
      company_id TEXT NOT NULL,
      date TEXT NOT NULL,
      dep_count INTEGER DEFAULT 0,
      dep_total REAL DEFAULT 0,
      wd_count INTEGER DEFAULT 0,
      wd_total REAL DEFAULT 0,
      online_count INTEGER DEFAULT 0,
      dep_users_count INTEGER DEFAULT 0,
      new_customers INTEGER DEFAULT 0,
      total_customers INTEGER DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (company_id, date)
    );
    INSERT INTO daily_stats_mc (
      company_id, date, dep_count, dep_total, wd_count, wd_total,
      online_count, dep_users_count, new_customers, total_customers, updated_at
    )
    SELECT '${DEFAULT_COMPANY}', date, dep_count, dep_total, wd_count, wd_total,
      online_count, dep_users_count, new_customers, total_customers, updated_at
    FROM daily_stats;
    DROP TABLE daily_stats;
    ALTER TABLE daily_stats_mc RENAME TO daily_stats;
  `);
  console.log("[db] daily_stats migrated to (company_id, date)");
}

function ensureCompanyIndexes(database) {
  const indexes = [
    ["idx_customers_company", "CREATE INDEX idx_customers_company ON customers(company_id)"],
    ["idx_customers_company_mobile", "CREATE INDEX idx_customers_company_mobile ON customers(company_id, mobile)"],
    ["idx_tx_company", "CREATE INDEX idx_tx_company ON transactions(company_id)"],
    ["idx_tx_company_date", "CREATE INDEX idx_tx_company_date ON transactions(company_id, created_date)"],
    ["idx_tx_company_type_date", "CREATE INDEX idx_tx_company_type_date ON transactions(company_id, type, created_date)"],
    ["idx_tx_company_cust_at", "CREATE INDEX idx_tx_company_cust_at ON transactions(company_id, customer_id, created_at)"],
    ["idx_customers_company_login", "CREATE INDEX idx_customers_company_login ON customers(company_id, last_login_date)"],
    ["idx_daily_company_date", "CREATE INDEX idx_daily_company_date ON daily_stats(company_id, date)"],
  ];
  for (const [name, sql] of indexes) {
    const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name);
    if (!exists) database.exec(sql);
  }
}

function migrateMultiCompany(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_url TEXT NOT NULL DEFAULT '',
      access_id TEXT NOT NULL DEFAULT '',
      access_token TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      last_sync_at TEXT,
      last_sync_ok INTEGER,
      last_sync_msg TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);

  const customersExist = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='customers'")
    .get();
  if (customersExist && !hasCompanyColumn(database, "customers")) {
    migrateCustomers(database);
  }
  const txExist = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transactions'").get();
  if (txExist && !hasCompanyColumn(database, "transactions")) {
    migrateTransactions(database);
  }
  const statsExist = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='daily_stats'").get();
  if (statsExist && !hasCompanyColumn(database, "daily_stats")) {
    migrateDailyStats(database);
  }
  ensureCompanyIndexes(database);
  seedCompaniesFromConfig(database);
}

module.exports = { migrateMultiCompany, DEFAULT_COMPANY };
