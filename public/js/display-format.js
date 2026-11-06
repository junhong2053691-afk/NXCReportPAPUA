// 支付渠道页的时间与金额显示——纯函数。
//
// 2026-11-06 员工演练：「最近删除」「操作历史」「已跳过」的时间是 UTC，其余都是悉尼时间；
// 转完余额的户口显示「-0.00」；OUT 列没有千分位。
//
// 时间：库里 deleted_at / decided_at / bank_account_events.created_at 是 SQLite datetime('now')
// 写的 **UTC** 墙上时间（无时区标记）。entry_time / tx_time 本来就是悉尼墙上时间，别拿来转。
const DISPLAY_TZ = "Australia/Sydney";

function sqlUtcToSydney(value, opts) {
  if (value == null || value === "") return "";
  const raw = String(value).trim();
  const iso = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : raw.replace(" ", "T") + "Z";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return raw.slice(0, 16);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value || "00";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  if (opts && opts.dateOnly) return date;
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${date} ${hour}:${get("minute")}`;
}

// 两位小数 + 千分位；先按分取整，所以 -0.000001 这种浮点残值显示成 0.00 而不是 -0.00。
function moneyText(n) {
  const cents = Math.round((Number(n) || 0) * 100);
  const v = cents === 0 ? 0 : cents / 100;
  return v.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

if (typeof window !== "undefined") {
  window.sqlUtcToSydney = sqlUtcToSydney;
  window.moneyText = moneyText;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { sqlUtcToSydney, moneyText };
}
