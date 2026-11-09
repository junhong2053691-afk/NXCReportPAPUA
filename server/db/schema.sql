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
  -- ⚠️ 这一列存的是**实例时区的墙上时间** 'YYYY-MM-DD HH:MM:SS'（无偏移标记），由
  -- lib/dates.js 的 formatWallClock 写入，所有日界都是在它上面做字符串前缀比较。
  -- 默认值刻意是空串而**不是** datetime('now')：后者返回 UTC，和本列的口径差 8~11
  -- 小时，任何不显式给 entry_time 的 INSERT 都会把那一行落到错误的日历日里，而
  -- accountDayNet / computeBankDailyReport / 流水日期筛选 / pendingCounts 会同时算
  -- 错且没有任何报错。同表的 created_at / updated_at 是 UTC，和本列不可互相比较。
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
  -- 'active'（运营中）| 'banned'（封禁中 / 待清理）| 'archived'（已归档，终态）。
  -- 判定一律走 lib/bankLifecycle.js，别在别处写字面量比较：那里对枚举外的值失败关闭，
  -- 散写的 `!= 'banned'` 会把未知状态当成能收钱的账户。
  lifecycle_status TEXT NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  alert_threshold REAL NOT NULL DEFAULT 0,
  -- 报警状态三列。不变量：alert_fired_at = '' ⇒ 另外两列也为空（lib/bankAlerts 的
  -- clearFired 一次清三列）。三列都**不在 PUT 白名单、也不在审计字段里**，否则可以
  -- 伪造已报警状态、或伪造一个极高的 fired_balance 把账户永久静音。
  alert_fired_at TEXT NOT NULL DEFAULT '',
  alert_fired_date TEXT NOT NULL DEFAULT '',
  -- 实时收款银行（lib/bankLiveReceiving.js）：每公司最多 3 个，只经专用端点整组替换；
  -- 封禁 / 归档时清零。只影响审批下拉，不自动入账。2026-11-09 起取代 active（原「使用中」）。
  live_receiving INTEGER NOT NULL DEFAULT 0,
  -- 上次报警时的余额。超标期间只有比它更高才再报一次——同一桶钱来回动不是新信息。
  alert_fired_balance REAL NOT NULL DEFAULT 0,
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

-- Telegram 出站队列。报警判定发生在余额写入的事务内部，但 HTTP 绝不能在事务里发，
-- 否则网络一卡审批事务就跟着卡住。所以事务内只 INSERT 一行待发消息（与余额写入
-- 同一事务，回滚时一起回滚），事务外由独立循环取出发送。重启不丢，失败可重试。
CREATE TABLE IF NOT EXISTS telegram_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL DEFAULT '',
  bot_key TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'alert',
  bank_account_id INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '',
  -- 'HTML' = text 里含等宽 <pre> 块且已转义；'' = 纯文本。跟着行走而不是发送时统一决定：
  -- 升级前积压在 pending 的老行是未转义纯文本，按 HTML 发会让含 `&` 的银行名 400。
  parse_mode TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tg_outbox_state ON telegram_outbox(state, id);

-- 已真实发出的报警消息。存在的唯一理由是「余额跌回阈值下时要把这一轮报警从聊天里撤掉」。
--
-- 为什么是独立表而不是 telegram_outbox 上的一列：一行 outbox 会发到多个 (bot, chat)
-- （报警还抄送总控），每条还可能被 chunkMessage 切成多条；更要命的是 deliver 刻意不逐
-- chat 记录投递进度（见 services/telegramBots.js 里那段权衡注释），重试会给已成功的 chat
-- 再发一遍。真实消息数比收件人数多，撤回只能按这里记下的 message_id 逐条做，不能按
-- 收件人推算。
CREATE TABLE IF NOT EXISTS telegram_sent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 撤回的水位线：一条 retract 任务只撤 outbox_id 小于它自己 id 的消息。自增 id 天然
  -- 就是「这一轮」的分界，所以不需要任何显式轮次字段。没有它的话，撤回任务失败重试
  -- 期间余额又超标发了新警，下一轮重试会把那条新警一起删掉。
  outbox_id INTEGER NOT NULL DEFAULT 0,
  company_id TEXT NOT NULL DEFAULT '',
  bank_account_id INTEGER NOT NULL DEFAULT 0,
  -- 一条消息只有发它的那个 bot 删得掉 / 改得动，所以 bot_key 必须跟着 message_id 存。
  bot_key TEXT NOT NULL DEFAULT '',
  chat_id TEXT NOT NULL DEFAULT '',
  message_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- '' = 还挂在聊天里。沿用 alert_fired_at 的惯例（NOT NULL DEFAULT ''），不用 NULL。
  retracted_at TEXT NOT NULL DEFAULT '',
  -- delete（48 小时内删掉）| edit（超 48 小时，就地改成 ✅ 已处理）
  -- | gone（已被人手删，目的已达成）| unavailable（删不掉也改不动，收尾不再重试）
  retract_method TEXT NOT NULL DEFAULT '',
  retract_error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_tg_sent_outstanding
  ON telegram_sent_messages(bank_account_id, retracted_at, outbox_id);

-- 每个 bot 的 getUpdates 游标。bot_key = 'control' 或 'company:<id>'。
-- token_fingerprint 用于检测 token 被换掉（update_id 是 per-bot 的，换 token 后旧
-- offset 无意义，必须归零重走冷启动）；存指纹而非明文。
CREATE TABLE IF NOT EXISTS telegram_bot_state (
  bot_key TEXT PRIMARY KEY,
  update_offset INTEGER NOT NULL DEFAULT 0,
  token_fingerprint TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 全局（非 per-company）设置。value 存 JSON 字符串，类型与校验由
-- server/lib/appSettings.js 统一负责——这样以后新增全局设置不用再建表。
-- updated_by/updated_at 就地记录变更来源：全局设置没有 company_id，塞不进
-- audit_events（appendAuditEvent 强制要求非空 companyId）。
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT NOT NULL DEFAULT ''
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

-- ============================================================ Google Sheets 同步
-- 全局部分（service account 凭证、节奏、总开关）在 app_settings 的 'sheets' 键里，
-- 不在这里 —— 那是 KV，新增全局设置不用改表结构。

-- 每公司的表格配置。
CREATE TABLE IF NOT EXISTS sheets_settings (
  company_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  spreadsheet_id TEXT NOT NULL DEFAULT '',
  -- 留空则用 app_settings.sheets 里的全局凭证
  sa_client_email TEXT NOT NULL DEFAULT '',
  sa_private_key TEXT NOT NULL DEFAULT '',
  tx_enabled INTEGER NOT NULL DEFAULT 1,
  -- '' = 全部历史；'2026-09' = 只推该月起。默认由后端填当月，避免首次就灌 16 万行。
  tx_start_month TEXT NOT NULL DEFAULT '',
  tx_columns_profile TEXT NOT NULL DEFAULT 'minimal',
  ledger_enabled INTEGER NOT NULL DEFAULT 1,
  daily_enabled INTEGER NOT NULL DEFAULT 1,
  monthly_enabled INTEGER NOT NULL DEFAULT 1,
  -- 停机备用录入台（LEDGER INPUT）
  input_enabled INTEGER NOT NULL DEFAULT 1,
  input_buffer_rows INTEGER NOT NULL DEFAULT 200,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 推送游标与各表指纹。
--
-- 游标放 DB 而不是 sync-state JSON 文件：快照备份只备份 .db，游标在库里 → 恢复快照时
-- 游标和 row_map 一起回到一致的历史点（重放是安全的，全部命中 hash 直接跳过）；
-- 游标在文件里 → 恢复后库旧游标新，会永久漏推那段区间，比重复推糟糕得多。
CREATE TABLE IF NOT EXISTS sheets_sync_state (
  company_id TEXT PRIMARY KEY,
  -- audit_events.id 水位线。用 id 不用 occurred_at：后者是秒级 datetime('now')，
  -- 同秒内多条事件会并列，> 会漏、>= 会重。
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
);

-- 表格行号索引：row_key（交易用 transactions.id）→ 它在某个 tab 里的行号 + 内容哈希。
-- 有了它，重放事件时 hash 命中就完全跳过，一个网络请求都不发。
CREATE TABLE IF NOT EXISTS sheets_row_map (
  company_id TEXT NOT NULL,
  tab_title TEXT NOT NULL,
  row_key TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (company_id, tab_title, row_key)
);
CREATE INDEX IF NOT EXISTS idx_sheets_rowmap_pos
  ON sheets_row_map(company_id, tab_title, row_number);

-- 从 LEDGER INPUT 回灌的手录行。entry_id 由系统预填在表格 A 列，是回灌的幂等键。
--
-- 这张表和 insertLedger 在同一个 runAtomic 事务里提交，所以「写库成功但回写表格状态列
-- 失败」后重扫时能认出来，只补回写、不重复入库。
CREATE TABLE IF NOT EXISTS sheets_manual_entries (
  company_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  row_number INTEGER NOT NULL DEFAULT 0,
  ledger_id INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'ok',
  message TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (company_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_sheets_manual_state
  ON sheets_manual_entries(company_id, state, imported_at DESC);

-- ============================================================ 数据库快照备份
CREATE TABLE IF NOT EXISTS db_backup_log (
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
);
CREATE INDEX IF NOT EXISTS idx_db_backup_log_time ON db_backup_log(started_at DESC);
