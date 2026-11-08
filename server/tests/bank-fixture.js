// 银行账户 / 流水 / Telegram 出站队列的内存测试库。
// 文件名刻意不以 .test.js 结尾，避免被 `node --test server/tests/*.test.js` 当成用例。
const Database = require("better-sqlite3");

function bankDatabase() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE bank_accounts (
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
      active INTEGER NOT NULL DEFAULT 1,
      reset_daily_balance INTEGER NOT NULL DEFAULT 0,
      account_kind TEXT NOT NULL DEFAULT 'nominee',
      lifecycle_status TEXT NOT NULL DEFAULT 'active',
      sort_order INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      alert_threshold REAL NOT NULL DEFAULT 0,
      alert_fired_at TEXT NOT NULL DEFAULT '',
      alert_fired_date TEXT NOT NULL DEFAULT '',
      alert_fired_balance REAL NOT NULL DEFAULT 0,
      live_receiving INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE bank_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_account_id INTEGER NOT NULL,
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE telegram_outbox (
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
    );
    CREATE TABLE telegram_sent_messages (
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
    );
    CREATE TABLE telegram_bot_state (
      bot_key TEXT PRIMARY KEY,
      update_offset INTEGER NOT NULL DEFAULT 0,
      token_fingerprint TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE companies (
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
      telegram_bot_token TEXT NOT NULL DEFAULT '',
      telegram_chat_ids TEXT NOT NULL DEFAULT '',
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE bank_ledger_deleted (
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
      deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_by TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE bank_c_status_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      target_company_id TEXT NOT NULL DEFAULT '',
      reconcile_required INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE bank_account_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL DEFAULT '',
      bank_account_id INTEGER NOT NULL,
      event TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function addCompany(db, overrides = {}) {
  const row = {
    id: "alpha",
    name: "AussieX6",
    enabled: 1,
    sort_order: 0,
    api_url: "",
    access_id: "",
    access_token: "",
    telegram_bot_token: "",
    telegram_chat_ids: "",
    ...overrides,
  };
  db.prepare(
    `INSERT INTO companies
      (id, name, api_url, access_id, access_token, enabled, sort_order, telegram_bot_token, telegram_chat_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.name,
    row.api_url,
    row.access_id,
    row.access_token,
    row.enabled,
    row.sort_order,
    row.telegram_bot_token,
    row.telegram_chat_ids
  );
  return row.id;
}

function addAccount(db, overrides = {}) {
  const row = {
    company_id: "alpha",
    bank_branch: "CBA Sydney",
    account_name: "Test Holder",
    account_number: "123456789",
    reset_daily_balance: 0,
    lifecycle_status: "active",
    active: 1,
    account_kind: "nominee",
    alert_threshold: 0,
    sort_order: 0,
    ...overrides,
  };
  const info = db
    .prepare(
      `INSERT INTO bank_accounts
        (company_id, bank, bank_branch, account_name, account_number, reset_daily_balance,
         lifecycle_status, active, account_kind, alert_threshold, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.company_id,
      row.bank_branch,
      row.bank_branch,
      row.account_name,
      row.account_number,
      row.reset_daily_balance,
      row.lifecycle_status,
      row.active,
      row.account_kind,
      row.alert_threshold,
      row.sort_order
    );
  return Number(info.lastInsertRowid);
}

function addLedger(db, bankAccountId, amountIn, dateKey, extra = {}) {
  const companyId =
    extra.company_id ||
    db.prepare("SELECT company_id FROM bank_accounts WHERE id = ?").get(bankAccountId)?.company_id ||
    "alpha";
  db.prepare(
    `INSERT INTO bank_ledger
      (bank_account_id, company_id, entry_time, amount_in, amount_out, help_amount, trf_amount, status,
       c_status, tx_id, username)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    bankAccountId,
    companyId,
    `${dateKey} 10:00:00`,
    amountIn,
    extra.amount_out || 0,
    extra.help_amount || 0,
    extra.trf_amount || 0,
    extra.status || "deposit",
    extra.c_status || "",
    extra.tx_id || "",
    extra.username || ""
  );
}

// 跨公司 C STATUS 映射。对平把双方的 total 相加判 0，所以两边都要登记。
function addCStatusOption(db, companyId, name, targetCompanyId, extra = {}) {
  db.prepare(
    `INSERT INTO bank_c_status_options (company_id, name, target_company_id, reconcile_required, sort_order)
     VALUES (?, ?, ?, ?, ?)`
  ).run(companyId, name, targetCompanyId, extra.reconcile_required ?? 1, extra.sort_order || 0);
}

// 已删流水。归档闸门要看它：这些行可以被 restore 塞回 bank_ledger，让一个已归档的
// 账户在所有视图之外重新带上余额。
function addDeletedLedger(db, bankAccountId, amountIn, dateKey, extra = {}) {
  const companyId =
    extra.company_id ||
    db.prepare("SELECT company_id FROM bank_accounts WHERE id = ?").get(bankAccountId)?.company_id ||
    "alpha";
  db.prepare(
    `INSERT INTO bank_ledger_deleted
      (original_id, bank_account_id, company_id, entry_time, amount_in, amount_out, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    extra.original_id || 0,
    bankAccountId,
    companyId,
    `${dateKey} 10:00:00`,
    amountIn,
    extra.amount_out || 0,
    extra.status || "deposit"
  );
}

function addAccountEvent(db, bankAccountId, event, createdAt, extra = {}) {
  const companyId =
    extra.company_id ||
    db.prepare("SELECT company_id FROM bank_accounts WHERE id = ?").get(bankAccountId)?.company_id ||
    "alpha";
  db.prepare(
    `INSERT INTO bank_account_events (company_id, bank_account_id, event, note, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(companyId, bankAccountId, event, extra.note || "", extra.actor || "tester", createdAt);
}

function outbox(db) {
  return db.prepare("SELECT * FROM telegram_outbox ORDER BY id").all();
}

function sentMessages(db) {
  return db.prepare("SELECT * FROM telegram_sent_messages ORDER BY id").all();
}

/** 预置一条「已经发到 Telegram、还挂在聊天里」的报警消息，供撤回用例用。 */
function addSentMessage(db, overrides = {}) {
  const row = {
    outbox_id: 0,
    company_id: "alpha",
    bank_account_id: 0,
    bot_key: "company:alpha",
    chat_id: "555",
    message_id: 1,
    ...overrides,
  };
  const info = db
    .prepare(
      `INSERT INTO telegram_sent_messages
        (outbox_id, company_id, bank_account_id, bot_key, chat_id, message_id)
       VALUES (@outbox_id, @company_id, @bank_account_id, @bot_key, @chat_id, @message_id)`
    )
    .run(row);
  return Number(info.lastInsertRowid);
}

function accountRow(db, id) {
  return db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(id);
}

module.exports = {
  bankDatabase,
  addAccount,
  addCompany,
  addLedger,
  addCStatusOption,
  addDeletedLedger,
  addAccountEvent,
  outbox,
  sentMessages,
  addSentMessage,
  accountRow,
};
