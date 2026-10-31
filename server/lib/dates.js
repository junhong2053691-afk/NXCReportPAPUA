// 全项目时区的唯一来源。
//
// 时区是**实例级**配置（一个部署 = 一个国家 = 一个时区），由 lib/locale.js 在启动时
// 注入一次（db/init.js 的 getDb() 内部，schema 建好之后、migrate 之前）。
//
// 这个模块刻意保持 dumb——不读 DB、不 require appSettings。反过来会造出
// appSettings → db/init → dates 的循环依赖，而现在这条路径是无环的。
//
// ⚠️ **不要导出 TZ 常量。** `const { TZ } = require("./dates")` 会在 require 时
// 快照当时的值，注入之后永远看不见新值——routes/audit.js 以前就是这么写的，结果
// localMidnightUtc 在非 Sydney 实例上会一直算悉尼的午夜。要时区名就调 getTimezone()。

const DEFAULT_TZ = "Australia/Sydney";

let TZ = DEFAULT_TZ;

/** 这个时区名 Intl 认不认。认不出的名字一律当非法，不要让它进 TZ。 */
function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: String(tz) });
    return true;
  } catch (_) {
    return false;
  }
}

function getTimezone() {
  return TZ;
}

/**
 * 注入实例时区。非法值一律忽略并保持当前值——时区读不出来时整个系统的日界都会错，
 * 退回一个能工作的时区比抛异常有用（照 appSettings 的 clampFrom 风格）。
 * 返回生效后的时区名。
 */
function setTimezone(tz) {
  const name = String(tz || "").trim();
  if (!name || !isValidTimezone(name)) return TZ;
  TZ = name;
  return TZ;
}

function todayKey() {
  // en-CA 不是语言选择：它是拿到 YYYY-MM-DD 这个 ISO 日期键的办法，给 API 参数和
  // <input type="date"> 用。不要换成别的 locale，所有日期筛选都会坏。
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

function dateKeyFromIso(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (isNaN(ms)) return "";
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
}

function shiftDateKey(dateKey, deltaDays) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + deltaDays);
  const yy = t.getUTCFullYear();
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * 实例时区的墙上时间 'YYYY-MM-DD HH:MM:SS'（无偏移标记）。
 *
 * 这是 bank_ledger.entry_time 和 bank_tx_pending.tx_time 的存储格式，所有日界都是在
 * 这个格式上做字符串前缀比较。注意同库的 created_at / occurred_at / alert_fired_at
 * 那些列是 SQLite datetime('now') 写的 **UTC**，两类列不可互相比较。
 */
function formatWallClock(iso) {
  const ms = Date.parse(iso || new Date().toISOString());
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 「本地日历日的零点」对应的 UTC 时间戳，格式 'YYYY-MM-DD HH:MM:SS'（UTC）。
 *
 * 全项目唯一正确的时区↔UTC 换算器。用来把本地日期键翻译成能和 **UTC 列**比较的区间：
 *
 *     occurred_at >= localMidnightUtc(from)
 *     occurred_at <  localMidnightUtc(shiftDateKey(to, 1))
 *
 * 三次迭代收敛，所以 DST 切换日也对（第一次猜偏一个小时，第二次就修回来）。
 * entry_time 那类列**不需要**这一步——它们本身就存本地墙上时间。
 *
 * 非法日期键返回 null。
 */
function localMidnightUtc(dateKey) {
  if (!DATE_KEY_RE.test(String(dateKey || ""))) return null;
  const [year, month, day] = dateKey.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  for (let i = 0; i < 3; i += 1) {
    const parts = formatter.formatToParts(new Date(guess));
    const value = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
    const represented = Date.UTC(
      value("year"),
      value("month") - 1,
      value("day"),
      value("hour") % 24,
      value("minute"),
      value("second")
    );
    guess += target - represented;
  }
  return new Date(guess).toISOString().slice(0, 19).replace("T", " ");
}

function monthBounds(dateKey, today) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(dateKey || ""));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const month = m[1] + "-" + m[2];
  const from = month + "-01";
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const toMonthEnd = month + "-" + String(lastDay).padStart(2, "0");
  const cap = today || todayKey();
  const to = toMonthEnd > cap ? cap : toMonthEnd;
  const label = y + "年" + mo + "月";
  return { month, from, to, label, isComplete: toMonthEnd <= cap };
}

module.exports = {
  DEFAULT_TZ,
  getTimezone,
  setTimezone,
  isValidTimezone,
  todayKey,
  dateKeyFromIso,
  shiftDateKey,
  formatWallClock,
  // 旧名保留做 alias：8 个 require 点（bankApply / bankAlerts / bankCleanupReport /
  // backup / sync / companies / db-init / check-api-access）还在用这个名字。
  formatSydneyDateTime: formatWallClock,
  localMidnightUtc,
  monthBounds,
};
