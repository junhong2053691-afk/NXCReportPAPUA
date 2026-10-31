// 全局（非 per-company）设置的读写与校验。
//
// 存储是一张通用 KV 表 `app_settings`（value 存 JSON），类型安全由这个模块负责而不是
// 靠 DB 列类型——这样以后新增别的全局设置不用再改表结构，而校验逻辑只有一份。
//
// 调用方拿到的永远是**规范化好的完整对象**（字段齐全、间隔已钳制在合法范围），不需要
// 自己写 `|| 默认值`。

const path = require("path");

const TELEGRAM_KEY = "telegram";
const BACKUP_KEY = "backup";
const SHEETS_KEY = "sheets";
const LOCALE_KEY = "locale";

// 间隔的合法范围。超出范围一律钳制而不是报错——照 scheduler.js:40-45 的既有风格，
// 运维参数填错不该让保存失败，静默修正到能工作的值更有用。
const RANGES = {
  pollTimeoutSeconds: { min: 5, max: 50, def: 30 },
  outboxFlushSeconds: { min: 2, max: 300, def: 5 },
  reconcileSeconds: { min: 10, max: 600, def: 30 },
};

const BACKUP_RANGES = {
  // 悉尼时间的整点。默认 4 点：平台那边最闲，VACUUM 的 IO 尖峰影响最小。
  hour: { min: 0, max: 23, def: 4 },
  keepDays: { min: 1, max: 365, def: 30 },
};

const SHEETS_RANGES = {
  // Sheets 写配额是每用户每分钟 60 次。30 秒一轮、每轮少数几个请求，余量充足。
  pushIntervalSeconds: { min: 15, max: 600, def: 30 },
  // 行数对账（防静默缺口）比推送贵得多，单独一个更长的间隔。
  countCheckSeconds: { min: 60, max: 3600, def: 600 },
};

function clampFrom(ranges, name, value) {
  const { min, max, def } = ranges[name];
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampInterval(name, value) {
  return clampFrom(RANGES, name, value);
}

function parseChatIds(raw) {
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  return String(raw || "")
    .split(/[,;\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function isValidChatId(value) {
  return /^-?\d+$/.test(String(value || "").trim());
}

function defaults() {
  return {
    enabled: true,
    controlBotToken: "",
    controlChatIds: "",
    mirrorAlertsToControl: true,
    pollTimeoutSeconds: RANGES.pollTimeoutSeconds.def,
    outboxFlushSeconds: RANGES.outboxFlushSeconds.def,
    reconcileSeconds: RANGES.reconcileSeconds.def,
  };
}

function normalize(raw) {
  const d = defaults();
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: src.enabled === undefined ? d.enabled : Boolean(src.enabled),
    controlBotToken: String(src.controlBotToken || "").trim(),
    controlChatIds: parseChatIds(src.controlChatIds).join(","),
    mirrorAlertsToControl:
      src.mirrorAlertsToControl === undefined ? d.mirrorAlertsToControl : Boolean(src.mirrorAlertsToControl),
    pollTimeoutSeconds: clampInterval("pollTimeoutSeconds", src.pollTimeoutSeconds),
    outboxFlushSeconds: clampInterval("outboxFlushSeconds", src.outboxFlushSeconds),
    reconcileSeconds: clampInterval("reconcileSeconds", src.reconcileSeconds),
  };
}

function readRaw(db, key) {
  let row;
  try {
    row = db.prepare("SELECT value, updated_at, updated_by FROM app_settings WHERE key = ?").get(key);
  } catch (e) {
    // 表还不存在（迁移失败 / 极老的库）时不要让调用方炸掉，退回默认值。
    console.warn("[settings] read", key + ":", e.message);
    return null;
  }
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value), updated_at: row.updated_at, updated_by: row.updated_by };
  } catch (e) {
    console.warn("[settings] corrupt JSON for", key + ":", e.message);
    return null;
  }
}

function writeRaw(db, key, value, actor) {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = datetime('now'),
       updated_by = excluded.updated_by`
  ).run(key, JSON.stringify(value), String(actor || "").slice(0, 100));
}

/**
 * 读取 Telegram 全局设置。永不返回 null，永不抛。
 *
 * 空库读出来就是「未配置」：controlBotToken 为空 → 总控 Bot 不启动，但**公司 Bot 不受
 * 影响**，照常推送和响应命令。
 */
function getTelegramSettings(db) {
  const row = readRaw(db, TELEGRAM_KEY);
  const settings = normalize(row?.value);
  settings.updatedAt = row?.updated_at || "";
  settings.updatedBy = row?.updated_by || "";
  settings.configured = Boolean(settings.controlBotToken);
  return settings;
}

/**
 * 保存 Telegram 设置（局部更新）。
 *
 * - `controlBotToken` 留空 / 未传 = **保持不变**，与 access_token 的既有交互一致，
 *   这样前端可以只显示脱敏值、永不回填明文。
 * - `controlChatIds` 是普通字段：传空字符串就是真的清空收件人。
 * - 校验失败抛带 `status = 400` 的 Error，路由层直接转成 400。
 */
function saveTelegramSettings(db, patch, actor) {
  const current = normalize(readRaw(db, TELEGRAM_KEY)?.value);
  const input = patch && typeof patch === "object" ? patch : {};
  const next = { ...current };

  if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);
  if (input.mirrorAlertsToControl !== undefined) {
    next.mirrorAlertsToControl = Boolean(input.mirrorAlertsToControl);
  }
  for (const name of Object.keys(RANGES)) {
    if (input[name] !== undefined) next[name] = clampInterval(name, input[name]);
  }

  if (input.controlBotToken !== undefined) {
    const token = String(input.controlBotToken || "").trim();
    if (token) {
      // 惰性 require 断开 appSettings -> telegram -> ... 的潜在循环
      const { isValidToken } = require("../services/telegram");
      if (!isValidToken(token)) {
        const err = new Error("Bot token 格式不正确，应形如 123456789:AAxxxxxxxx…");
        err.status = 400;
        throw err;
      }
      next.controlBotToken = token;
    }
    // token 传空 = 保持不变，不覆盖
  }

  if (input.controlChatIds !== undefined) {
    const ids = parseChatIds(input.controlChatIds);
    const bad = ids.filter((v) => !isValidChatId(v));
    if (bad.length) {
      const err = new Error("chat id 必须是整数（群为负数）：" + bad.join(", "));
      err.status = 400;
      throw err;
    }
    next.controlChatIds = ids.join(",");
  }

  writeRaw(db, TELEGRAM_KEY, normalize(next), actor);
  return getTelegramSettings(db);
}

/** 清空总控 Bot token（保存接口的「留空 = 不变」语义之外的显式删除路径）。 */
function clearControlBotToken(db, actor) {
  const current = normalize(readRaw(db, TELEGRAM_KEY)?.value);
  current.controlBotToken = "";
  writeRaw(db, TELEGRAM_KEY, current, actor);
  return getTelegramSettings(db);
}

// ---------------------------------------------------------------- 数据库快照备份
//
// Google Sheets 不是备份介质（有单元格上限、类型会丢、没有还原路径）。真容灾靠
// SQLite 的 VACUUM INTO 快照，这里只存调度参数。

function isInsidePublicDir(dir) {
  const root = path.join(__dirname, "..", "..");
  const publicDir = path.join(root, "public");
  const resolved = path.resolve(root, String(dir || ""));
  const relative = path.relative(publicDir, resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function backupDefaults() {
  return {
    enabled: false, // 默认关：要用户看过磁盘占用提示后显式打开
    dir: "", // 空 = paths.backupDir()
    hour: BACKUP_RANGES.hour.def,
    keepDays: BACKUP_RANGES.keepDays.def,
  };
}

function normalizeBackup(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: src.enabled === undefined ? backupDefaults().enabled : Boolean(src.enabled),
    dir: String(src.dir || "").trim(),
    hour: clampFrom(BACKUP_RANGES, "hour", src.hour),
    keepDays: clampFrom(BACKUP_RANGES, "keepDays", src.keepDays),
  };
}

/** 读备份设置。永不返回 null，永不抛。 */
function getBackupSettings(db) {
  const row = readRaw(db, BACKUP_KEY);
  const settings = normalizeBackup(row?.value);
  settings.updatedAt = row?.updated_at || "";
  settings.updatedBy = row?.updated_by || "";
  return settings;
}

/**
 * 保存备份设置（局部更新）。
 * `dir` 是普通字段：传空字符串就是真的恢复成默认目录。
 */
function saveBackupSettings(db, patch, actor) {
  const next = normalizeBackup(readRaw(db, BACKUP_KEY)?.value);
  const input = patch && typeof patch === "object" ? patch : {};

  if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);
  if (input.hour !== undefined) next.hour = clampFrom(BACKUP_RANGES, "hour", input.hour);
  if (input.keepDays !== undefined) next.keepDays = clampFrom(BACKUP_RANGES, "keepDays", input.keepDays);
  if (input.dir !== undefined) {
    const dir = String(input.dir || "").trim();
    // 空字节会让 fs 调用抛一个和"目录填错了"毫无关联的 ERR_INVALID_ARG_VALUE。
    if (dir.includes("\0")) {
      const err = new Error("备份目录路径非法");
      err.status = 400;
      throw err;
    }
    if (isInsidePublicDir(dir)) {
      const err = new Error("备份目录不能放在 public 下：快照含全部客户数据，那里可以匿名下载");
      err.status = 400;
      throw err;
    }
    next.dir = dir;
  }

  writeRaw(db, BACKUP_KEY, normalizeBackup(next), actor);
  return getBackupSettings(db);
}

// ---------------------------------------------------------------- Google Sheets 同步
//
// 只放全局部分（service account 凭证 + 节奏 + 总开关）。每公司的 spreadsheet_id 与
// 内容开关在 sheets_settings 表里——那是 per-company 的，KV 装不下。

const SPREADSHEET_ID_RE = /^[A-Za-z0-9_-]{20,120}$/;
const SA_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sheetsDefaults() {
  return {
    enabled: false,
    saClientEmail: "",
    saPrivateKey: "",
    globalSpreadsheetId: "",
    // 从表格回灌手录流水的总开关。出问题时一键停掉，不影响单向推送。
    manualImportEnabled: true,
    pushIntervalSeconds: SHEETS_RANGES.pushIntervalSeconds.def,
    countCheckSeconds: SHEETS_RANGES.countCheckSeconds.def,
  };
}

function normalizeSheets(raw) {
  const d = sheetsDefaults();
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: src.enabled === undefined ? d.enabled : Boolean(src.enabled),
    saClientEmail: String(src.saClientEmail || "").trim(),
    saPrivateKey: String(src.saPrivateKey || ""),
    globalSpreadsheetId: String(src.globalSpreadsheetId || "").trim(),
    manualImportEnabled:
      src.manualImportEnabled === undefined ? d.manualImportEnabled : Boolean(src.manualImportEnabled),
    pushIntervalSeconds: clampFrom(SHEETS_RANGES, "pushIntervalSeconds", src.pushIntervalSeconds),
    countCheckSeconds: clampFrom(SHEETS_RANGES, "countCheckSeconds", src.countCheckSeconds),
  };
}

/** 读 Sheets 全局设置。永不返回 null，永不抛。`configured` = 凭证齐全，可以去连 Google。 */
function getSheetsSettings(db) {
  const row = readRaw(db, SHEETS_KEY);
  const settings = normalizeSheets(row?.value);
  settings.updatedAt = row?.updated_at || "";
  settings.updatedBy = row?.updated_by || "";
  settings.configured = Boolean(settings.saClientEmail && settings.saPrivateKey);
  return settings;
}

/**
 * 保存 Sheets 全局设置（局部更新）。
 *
 * - `saPrivateKey` 留空 / 未传 = **保持不变**，与 access_token、control_bot_token 的既有
 *   交互一致，这样前端可以只显示指纹、永不回填明文。
 * - 私钥会当场用 crypto.createPrivateKey 试着加载一次：把"凭证填错"挡在配置阶段，
 *   而不是等 30 秒后在后台循环里反复 invalid_grant。
 * - 校验失败抛带 `status = 400` 的 Error。
 */
function saveSheetsSettings(db, patch, actor) {
  const next = normalizeSheets(readRaw(db, SHEETS_KEY)?.value);
  const input = patch && typeof patch === "object" ? patch : {};

  if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);
  if (input.manualImportEnabled !== undefined) {
    next.manualImportEnabled = Boolean(input.manualImportEnabled);
  }
  for (const name of Object.keys(SHEETS_RANGES)) {
    if (input[name] !== undefined) next[name] = clampFrom(SHEETS_RANGES, name, input[name]);
  }

  if (input.saClientEmail !== undefined) {
    const email = String(input.saClientEmail || "").trim();
    if (email && !SA_EMAIL_RE.test(email)) {
      const err = new Error(
        "Service Account 邮箱格式不正确，应形如 xxx@yyy.iam.gserviceaccount.com"
      );
      err.status = 400;
      throw err;
    }
    next.saClientEmail = email;
  }

  if (input.saPrivateKey !== undefined) {
    const pem = String(input.saPrivateKey || "");
    if (pem.trim()) {
      // 惰性 require，与本文件里 telegram 校验的既有写法一致
      const { assertUsablePrivateKey } = require("./googleAuth");
      next.saPrivateKey = assertUsablePrivateKey(pem); // 不合法会抛 status=400
    }
    // 传空 = 保持不变，不覆盖
  }

  if (input.globalSpreadsheetId !== undefined) {
    const id = String(input.globalSpreadsheetId || "").trim();
    if (id && !SPREADSHEET_ID_RE.test(id)) {
      const err = new Error(
        "Spreadsheet ID 不正确。它是表格网址 /spreadsheets/d/ 与 /edit 之间的那一段，不是整条网址"
      );
      err.status = 400;
      throw err;
    }
    next.globalSpreadsheetId = id;
  }

  if (next.enabled && !(next.saClientEmail && next.saPrivateKey)) {
    const err = new Error("启用前请先填写 Service Account 邮箱和私钥");
    err.status = 400;
    throw err;
  }

  writeRaw(db, SHEETS_KEY, normalizeSheets(next), actor);
  return getSheetsSettings(db);
}

/** 清空 service account 私钥（「留空 = 不变」语义之外的显式删除路径）。 */
function clearSheetsPrivateKey(db, actor) {
  const current = normalizeSheets(readRaw(db, SHEETS_KEY)?.value);
  current.saPrivateKey = "";
  current.enabled = false; // 没凭证就不该还标成启用
  writeRaw(db, SHEETS_KEY, current, actor);
  return getSheetsSettings(db);
}

// ---------------------------------------------------------------- 实例 locale
//
// 时区 + 币种。一个部署实例 = 一个国家，所以这是全局设置而不是 per-company。
// 符号和小数位不存库，由 lib/locale.js 的 CURRENCIES 表从币种代码派生。

function localeDefaults() {
  const { DEFAULT_TZ, DEFAULT_CURRENCY } = require("./locale");
  return { timezone: DEFAULT_TZ, currency: DEFAULT_CURRENCY };
}

/**
 * 读出来的值一律钳制，永不抛——库里的 JSON 坏了或存了个已经下线的币种代码时，退回
 * 一个能工作的 locale 比让整个进程起不来有用。用户填错由 saveLocaleSettings 去拦。
 */
function normalizeLocale(raw) {
  const { isValidTimezone, normalizeCurrencyCode } = require("./locale");
  const d = localeDefaults();
  const src = raw && typeof raw === "object" ? raw : {};
  const tz = String(src.timezone || "").trim();
  return {
    timezone: tz && isValidTimezone(tz) ? tz : d.timezone,
    currency: normalizeCurrencyCode(src.currency),
  };
}

/** 读实例 locale。永不返回 null，永不抛。 */
function getLocaleSettings(db) {
  const row = readRaw(db, LOCALE_KEY);
  const settings = normalizeLocale(row?.value);
  settings.updatedAt = row?.updated_at || "";
  settings.updatedBy = row?.updated_by || "";
  return settings;
}

/**
 * 保存实例 locale（局部更新）。非法输入抛 `status = 400`——这里和 normalizeLocale
 * 的宽容刻意相反：用户显式填了 "IDR"，静默改成 AUD 比报错糟得多，他会以为生效了。
 *
 * ⚠️ 这个函数**不做**「时区写一次就锁」那道闸门。那道闸门在 routes/admin.js 的 PUT
 * 里（它要查 bank_ledger 是否非空），刻意留在路由层，这样改时区的 CLI 逃生脚本可以
 * 直接调本函数绕过去。
 */
function saveLocaleSettings(db, patch, actor) {
  const { isValidTimezone, isSupportedCurrency, currencyCodes, normalizeCurrencyCode } = require("./locale");
  const next = normalizeLocale(readRaw(db, LOCALE_KEY)?.value);
  const input = patch && typeof patch === "object" ? patch : {};

  if (input.timezone !== undefined) {
    const tz = String(input.timezone || "").trim();
    if (!tz || !isValidTimezone(tz)) {
      const err = new Error(
        "时区名不正确。要用 IANA 时区名，例如 Australia/Sydney、Asia/Kuala_Lumpur、Pacific/Port_Moresby"
      );
      err.status = 400;
      throw err;
    }
    next.timezone = tz;
  }

  if (input.currency !== undefined) {
    const code = String(input.currency || "").trim().toUpperCase();
    if (!code || !isSupportedCurrency(code)) {
      const err = new Error("不支持的币种。目前支持：" + currencyCodes().join(" / "));
      err.status = 400;
      throw err;
    }
    next.currency = normalizeCurrencyCode(code);
  }

  writeRaw(db, LOCALE_KEY, normalizeLocale(next), actor);
  return getLocaleSettings(db);
}

module.exports = {
  TELEGRAM_KEY,
  BACKUP_KEY,
  SHEETS_KEY,
  LOCALE_KEY,
  getLocaleSettings,
  saveLocaleSettings,
  localeDefaults,
  normalizeLocale,
  RANGES,
  BACKUP_RANGES,
  SHEETS_RANGES,
  getTelegramSettings,
  saveTelegramSettings,
  clearControlBotToken,
  getBackupSettings,
  saveBackupSettings,
  backupDefaults,
  isInsidePublicDir,
  getSheetsSettings,
  saveSheetsSettings,
  clearSheetsPrivateKey,
  sheetsDefaults,
  parseChatIds,
  isValidChatId,
  defaults,
};
