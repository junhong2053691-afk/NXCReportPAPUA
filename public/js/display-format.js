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

// 渠道操作历史（bank_account_events.event / note）是代码值，原样显示就是 banned / nominee
// （员工演练）。这里转成中文原文，切到英文由 i18n 字典完成；认不出的原样返回。
const ACCOUNT_EVENT_LABELS = {
  created: "新建",
  updated: "修改",
  banned: "封禁",
  unbanned: "解封",
  archived: "归档",
  unarchived: "取消归档",
};
const ACCOUNT_KIND_LABELS = { nominee: "人头", ghost: "幽灵", payment_gateway: "PaymentGateway" };

function accountEventLabel(code) {
  const key = String(code || "").trim();
  return ACCOUNT_EVENT_LABELS[key] || key;
}
function accountKindLabel(code) {
  const key = String(code || "").trim();
  return ACCOUNT_KIND_LABELS[key] || key;
}

if (typeof window !== "undefined") {
  window.sqlUtcToSydney = sqlUtcToSydney;
  window.moneyText = moneyText;
  window.accountEventLabel = accountEventLabel;
  window.accountKindLabel = accountKindLabel;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { sqlUtcToSydney, moneyText, accountEventLabel, accountKindLabel };
}
