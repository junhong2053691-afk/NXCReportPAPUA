CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('admin', 'operator')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_companies (
  user_id INTEGER NOT NULL,
  company_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_user_companies_company ON user_companies(company_id);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
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
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
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
  promo_id TEXT,
  promo_name TEXT,
  synced_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_customers_mobile ON customers(mobile);

CREATE TABLE IF NOT EXISTS bank_ledger (
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
  transfer_group_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_bank_id ON bank_ledger(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_company ON bank_ledger(company_id);
CREATE INDEX IF NOT EXISTS idx_ledger_tx_id ON bank_ledger(tx_id);
CREATE INDEX IF NOT EXISTS idx_ledger_time ON bank_ledger(entry_time);

CREATE TABLE IF NOT EXISTS bank_ledger_deleted (
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
);
CREATE INDEX IF NOT EXISTS idx_ledger_deleted_company ON bank_ledger_deleted(company_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_ledger_deleted_original ON bank_ledger_deleted(original_id);

CREATE TABLE IF NOT EXISTS bank_balance_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id INTEGER NOT NULL,
  tx_id TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tx_id)
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL DEFAULT '',
  bank TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  bank_branch TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  bsb TEXT NOT NULL DEFAULT '',
  account_number TEXT NOT NULL DEFAULT '',
  payid TEXT NOT NULL DEFAULT '',
  balance REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0,
  reset_daily_balance INTEGER NOT NULL DEFAULT 0,
  account_kind TEXT NOT NULL DEFAULT 'nominee',
  lifecycle_status TEXT NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bank_account_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL DEFAULT '',
  bank_account_id INTEGER NOT NULL,
  event TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bank_c_status_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  target_company_id TEXT NOT NULL DEFAULT '',
  reconcile_required INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(company_id, name)
);

CREATE TABLE IF NOT EXISTS bank_status_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#64748b',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(company_id, value)
);

CREATE TABLE IF NOT EXISTS bank_tx_pending (
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
);

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
CREATE INDEX IF NOT EXISTS idx_audit_company_time ON audit_events(company_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_company_actor ON audit_events(company_id, actor_username, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_company_action ON audit_events(company_id, action, occurred_at DESC);

CREATE TABLE IF NOT EXISTS audit_event_refs (
  event_id INTEGER NOT NULL,
  company_id TEXT NOT NULL DEFAULT '',
  ref_type TEXT NOT NULL DEFAULT '',
  ref_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (event_id, ref_type, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_audit_refs_lookup ON audit_event_refs(company_id, ref_type, ref_id, event_id);
CREATE INDEX IF NOT EXISTS idx_audit_refs_event ON audit_event_refs(event_id);
CREATE TRIGGER IF NOT EXISTS audit_events_no_update
  BEFORE UPDATE ON audit_events
  BEGIN SELECT RAISE(ABORT, 'audit_events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
  BEFORE DELETE ON audit_events
  BEGIN SELECT RAISE(ABORT, 'audit_events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_event_refs_no_update
  BEFORE UPDATE ON audit_event_refs
  BEGIN SELECT RAISE(ABORT, 'audit_event_refs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_event_refs_no_delete
  BEFORE DELETE ON audit_event_refs
  BEGIN SELECT RAISE(ABORT, 'audit_event_refs are append-only'); END;

CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT PRIMARY KEY,
  dep_count INTEGER DEFAULT 0,
  dep_total REAL DEFAULT 0,
  wd_count INTEGER DEFAULT 0,
  wd_total REAL DEFAULT 0,
  online_count INTEGER DEFAULT 0,
  dep_users_count INTEGER DEFAULT 0,
  new_customers INTEGER DEFAULT 0,
  total_customers INTEGER DEFAULT 0,
  updated_at TEXT
);
