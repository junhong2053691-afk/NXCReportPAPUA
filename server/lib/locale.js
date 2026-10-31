// 实例级 locale（时区 + 币种）的唯一事实源。
//
// 一个部署实例 = 一个国家 = 一个时区 + 一个币种。需要互相对平的公司放同一实例，
// 不需要对平的另开实例——所以这里刻意**不是** per-company 配置。
//
// 这是个**进程级**模块，不是 db 参数访问器。理由：server/tests/bank-fixture.js 的
// 内存库没有 app_settings 表，任何 formatAmount(db, …) 这样的签名都会在每次调用时
// 掉进 appSettings.readRaw 的 catch，还要给 14 个 Telegram 调用点硬塞一个 db 参数。
// 所以启动时注入一次（db/init.js 的 getDb() 内），之后到处都是纯 getter。
//
// 时区本身存在 lib/dates.js 里（它不能 require 本模块，否则成环），这里只做转发。

const { getTimezone, setTimezone, isValidTimezone, DEFAULT_TZ } = require("./dates");

/**
 * 支持的币种。app_settings 里**只存 ISO 代码**，符号和小数位从这张表派生——这样
 * 代码和符号不可能不一致，加一个新币种就是这里加一行。
 *
 * ⚠️ symbol 的显示宽度必须 <= 2 格（locale.test.js 有断言守着）。Telegram 的 <pre>
 * 表格宽度预算很紧，一个 CJK 符号（2 格）或 emoji 会把每张表静默撑到横向滚动。
 *
 * ARS 和 AUD 符号相同是**刻意不处理**的：币种是实例级，一个实例内不存在歧义。不要
 * 造 A$ / AR$ 之类的区分符号，那会无谓撑宽每张表。要区分的地方显示 code。
 */
const CURRENCIES = {
  AUD: { symbol: "$", decimals: 2, label: "澳元 AUD" },
  MYR: { symbol: "RM", decimals: 2, label: "马来西亚林吉特 MYR" },
  PGK: { symbol: "K", decimals: 2, label: "巴布亚新几内亚基那 PGK" },
  ARS: { symbol: "$", decimals: 2, label: "阿根廷比索 ARS" },
};

const DEFAULT_CURRENCY = "AUD";

let currencyCode = DEFAULT_CURRENCY;

function currencyCodes() {
  return Object.keys(CURRENCIES);
}

function isSupportedCurrency(code) {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, String(code || "").trim().toUpperCase());
}

/** 未知币种一律钳到 AUD，不抛——照 appSettings 的 clampFrom 风格。 */
function normalizeCurrencyCode(code) {
  const upper = String(code || "").trim().toUpperCase();
  return CURRENCIES[upper] ? upper : DEFAULT_CURRENCY;
}

/** 当前币种。永不返回 null。 */
function getCurrency() {
  const def = CURRENCIES[currencyCode] || CURRENCIES[DEFAULT_CURRENCY];
  return { code: currencyCode, symbol: def.symbol, decimals: def.decimals, label: def.label };
}

/**
 * 注入实例 locale。只传一个字段就只改那一个。非法值一律钳制，不抛。
 * 返回生效后的值。
 */
function setLocale(input) {
  const src = input && typeof input === "object" ? input : {};
  if (src.timezone !== undefined) setTimezone(src.timezone);
  if (src.currency !== undefined) currencyCode = normalizeCurrencyCode(src.currency);
  return getLocale();
}

/** 给前端下发和 API 回包用的扁平形状。 */
function getLocale() {
  const currency = getCurrency();
  return {
    timezone: getTimezone(),
    currency: currency.code,
    symbol: currency.symbol,
    decimals: currency.decimals,
  };
}

module.exports = {
  CURRENCIES,
  DEFAULT_CURRENCY,
  DEFAULT_TZ,
  currencyCodes,
  isSupportedCurrency,
  isValidTimezone,
  normalizeCurrencyCode,
  getCurrency,
  getTimezone,
  getLocale,
  setLocale,
};
