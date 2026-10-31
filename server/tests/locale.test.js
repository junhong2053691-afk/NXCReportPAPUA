const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const locale = require("../lib/locale");
const { displayWidth } = require("../lib/telegramFormat");
const {
  getLocaleSettings,
  saveLocaleSettings,
  normalizeLocale,
  localeDefaults,
} = require("../lib/appSettings");

function database() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT NOT NULL DEFAULT ''
    );
  `);
  return db;
}

// 每个 test 跑完都把进程 locale 还原，别污染同文件里后面的 test。
function restore() {
  locale.setLocale({ timezone: locale.DEFAULT_TZ, currency: locale.DEFAULT_CURRENCY });
}

// ---------------------------------------------------------------- 币种表的护栏

test("每个币种都有符号和小数位", () => {
  for (const code of locale.currencyCodes()) {
    const def = locale.CURRENCIES[code];
    assert.equal(typeof def.symbol, "string", `${code} 要有 symbol`);
    assert.ok(def.symbol.length > 0, `${code} 的 symbol 不能为空`);
    assert.ok(Number.isInteger(def.decimals), `${code} 的 decimals 要是整数`);
    assert.ok(def.decimals >= 0 && def.decimals <= 4, `${code} 的 decimals 超出合理范围`);
    assert.ok(def.label && def.label.length > 0, `${code} 要有 label`);
  }
});

test("币种符号的显示宽度不超过 2 格", () => {
  // Telegram 的 <pre> 表格宽度预算很紧（TABLE_MAX_WIDTH = 34，封禁渠道表还要为行尾
  // 类型标让出 3 格）。一个 CJK 符号（2 格）或 emoji 加进来会把每张表静默撑到横向
  // 滚动，而那是 CLAUDE.md 里列为铁律的东西。这条断言守着「别手滑加个全角符号」。
  for (const code of locale.currencyCodes()) {
    const w = displayWidth(locale.CURRENCIES[code].symbol);
    assert.ok(w <= 2, `${code} 的符号 ${locale.CURRENCIES[code].symbol} 宽 ${w} 格，超过 2 格`);
  }
});

test("四个目标币种都在表里", () => {
  for (const code of ["AUD", "MYR", "PGK", "ARS"]) {
    assert.ok(locale.isSupportedCurrency(code), `${code} 应被支持`);
  }
});

// ---------------------------------------------------------------- 进程级 getter/setter

test("默认是 Australia/Sydney + AUD", () => {
  restore();
  const l = locale.getLocale();
  assert.equal(l.timezone, "Australia/Sydney");
  assert.equal(l.currency, "AUD");
  assert.equal(l.symbol, "$");
  assert.equal(l.decimals, 2);
});

test("setLocale 注入后 getter 立刻跟着变", () => {
  locale.setLocale({ timezone: "Asia/Kuala_Lumpur", currency: "MYR" });
  assert.equal(locale.getTimezone(), "Asia/Kuala_Lumpur");
  assert.equal(locale.getCurrency().code, "MYR");
  assert.equal(locale.getCurrency().symbol, "RM");
  restore();
});

test("setLocale 只传一个字段就只改那一个", () => {
  restore();
  locale.setLocale({ currency: "PGK" });
  assert.equal(locale.getTimezone(), "Australia/Sydney", "时区不该被动");
  assert.equal(locale.getCurrency().symbol, "K");
  restore();
});

test("未知币种钳到 AUD，非法时区保持原值，都不抛", () => {
  restore();
  locale.setLocale({ currency: "IDR", timezone: "Mars/Olympus_Mons" });
  assert.equal(locale.getCurrency().code, "AUD", "未知币种钳到默认");
  assert.equal(locale.getTimezone(), "Australia/Sydney", "非法时区被忽略，保持可用");
  restore();
});

test("币种代码大小写不敏感", () => {
  restore();
  locale.setLocale({ currency: "myr" });
  assert.equal(locale.getCurrency().code, "MYR");
  restore();
});

test("isValidTimezone 认得 IANA 名字、拒绝垃圾", () => {
  for (const tz of ["Australia/Sydney", "Asia/Kuala_Lumpur", "Pacific/Port_Moresby", "America/Argentina/Buenos_Aires", "UTC"]) {
    assert.ok(locale.isValidTimezone(tz), `${tz} 应合法`);
  }
  for (const bad of ["", "   ", "Not/AZone", "GMT+10:00xyz", "Australia/Sydeny"]) {
    assert.equal(locale.isValidTimezone(bad), false, `${JSON.stringify(bad)} 应非法`);
  }
});

// ---------------------------------------------------------------- app_settings 持久化

test("空库读出完整默认值，不抛", () => {
  const db = database();
  const s = getLocaleSettings(db);
  assert.equal(s.timezone, localeDefaults().timezone);
  assert.equal(s.currency, localeDefaults().currency);
  db.close();
});

test("表不存在时退回默认值而不是炸掉", () => {
  const db = new Database(":memory:");
  const s = getLocaleSettings(db);
  assert.equal(s.currency, "AUD");
  db.close();
});

test("保存往返：写入后读回一致", () => {
  const db = database();
  const saved = saveLocaleSettings(db, { timezone: "Asia/Kuala_Lumpur", currency: "MYR" }, "admin");
  assert.equal(saved.timezone, "Asia/Kuala_Lumpur");
  assert.equal(saved.currency, "MYR");
  assert.equal(saved.updatedBy, "admin");

  const read = getLocaleSettings(db);
  assert.equal(read.timezone, "Asia/Kuala_Lumpur");
  assert.equal(read.currency, "MYR");
  db.close();
});

test("局部更新：只传币种不动时区", () => {
  const db = database();
  saveLocaleSettings(db, { timezone: "Pacific/Port_Moresby", currency: "PGK" }, "a");
  saveLocaleSettings(db, { currency: "AUD" }, "b");
  const s = getLocaleSettings(db);
  assert.equal(s.timezone, "Pacific/Port_Moresby", "时区不该被动");
  assert.equal(s.currency, "AUD");
  db.close();
});

test("保存不支持的币种抛 400，而不是静默钳成 AUD", () => {
  // 这是和 normalizeLocale 刻意相反的一半：用户显式填了 IDR，静默改成 AUD 比报错
  // 糟得多——他会以为生效了，然后所有金额都显示错的符号。
  const db = database();
  assert.throws(
    () => saveLocaleSettings(db, { currency: "IDR" }, "admin"),
    (err) => err.status === 400 && /不支持的币种/.test(err.message)
  );
  assert.equal(getLocaleSettings(db).currency, "AUD", "失败的保存不该落库");
  db.close();
});

test("保存非法时区抛 400", () => {
  const db = database();
  for (const bad of ["Mars/Olympus_Mons", "", "   "]) {
    assert.throws(
      () => saveLocaleSettings(db, { timezone: bad }, "admin"),
      (err) => err.status === 400,
      `${JSON.stringify(bad)} 应被拒`
    );
  }
  db.close();
});

test("normalizeLocale 对损坏的库值一律钳制、永不抛", () => {
  // 读路径必须宽容：库里的 JSON 坏了或存了个已下线的币种代码时，退回能工作的
  // locale 比让整个进程起不来有用。
  for (const raw of [null, undefined, "", 42, [], { currency: "ZZZ" }, { timezone: "Not/AZone" }]) {
    const n = normalizeLocale(raw);
    assert.equal(n.timezone, "Australia/Sydney", `${JSON.stringify(raw)} 的时区应钳到默认`);
    assert.equal(n.currency, "AUD", `${JSON.stringify(raw)} 的币种应钳到默认`);
  }
});

test("库里存了坏 JSON 也读得出默认值", () => {
  const db = database();
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('locale', '{not json')").run();
  const s = getLocaleSettings(db);
  assert.equal(s.currency, "AUD");
  assert.equal(s.timezone, "Australia/Sydney");
  db.close();
});

test("只存 ISO 代码，符号不落库", () => {
  // 符号和小数位从 CURRENCIES 表派生，不存库——这样代码和符号不可能不一致。
  const db = database();
  saveLocaleSettings(db, { currency: "MYR" }, "admin");
  const stored = JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key='locale'").get().value);
  assert.deepEqual(Object.keys(stored).sort(), ["currency", "timezone"]);
  assert.equal(stored.currency, "MYR");
  db.close();
});
