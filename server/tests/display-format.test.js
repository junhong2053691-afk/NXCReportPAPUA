// 支付渠道页的时间与金额显示（public/js/display-format.js）。
//
// 2026-11-06 员工演练：「最近删除」「操作历史」「已跳过」的时间是 UTC（库里 datetime('now')），
// 其余都是悉尼时间，对不上号；转完余额的户口显示「-0.00」；OUT 列没有千分位。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { sqlUtcToSydney, moneyText } = require("../../public/js/display-format");

test("UTC 墙上时间转悉尼：AEDT +11，跨日也对", () => {
  assert.equal(sqlUtcToSydney("2026-11-06 03:30:00"), "2026-11-06 14:30");
  assert.equal(sqlUtcToSydney("2026-11-05 13:30:00"), "2026-11-06 00:30");
});

test("AEST（冬令时）+10", () => {
  assert.equal(sqlUtcToSydney("2026-07-01 02:00:00"), "2026-07-01 12:00");
});

test("只要日期", () => {
  assert.equal(sqlUtcToSydney("2026-11-05 13:30:00", { dateOnly: true }), "2026-11-06");
});

test("空值给空串，认不出的原样截前 16 位", () => {
  assert.equal(sqlUtcToSydney(""), "");
  assert.equal(sqlUtcToSydney(null), "");
  assert.equal(sqlUtcToSydney("garbage"), "garbage");
});

test("金额：千分位、两位小数、不出现 -0.00", () => {
  assert.equal(moneyText(1234.5), "1,234.50");
  assert.equal(moneyText(-9541.4), "-9,541.40");
  assert.equal(moneyText(-0.000001), "0.00");
  assert.equal(moneyText(-0.004), "0.00");
  assert.equal(moneyText(0), "0.00");
  assert.equal(moneyText(null), "0.00");
});

test("页面接入：四处 UTC 时间走 sqlUtcToSydney，fmt 走 moneyText，OUT 列带千分位", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../public/js/bank-accounts.js"), "utf8");
  for (const field of ["deleted_at", "decided_at"]) {
    assert.match(src, new RegExp(`sqlUtcToSydney\\(r\\.${field}\\)`), field);
  }
  assert.match(src, /sqlUtcToSydney\(e\.created_at\)/, "渠道操作历史");
  assert.match(src, /sqlUtcToSydney\(bannedEvent\.created_at, \{ dateOnly: true \}\)/, "封禁于");
  assert.doesNotMatch(src, /String\(r\.deleted_at \|\| ""\)\.slice/);
  assert.match(src, /function fmt\(n\) \{\s*return window\.moneyText\(n\);/);
  assert.doesNotMatch(src, /\(-Math\.abs\(v\)\)\.toFixed\(2\)/, "OUT 列要有千分位");
  const page = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
  const at = page.indexOf("/js/display-format.js");
  assert.ok(at > 0 && at < page.indexOf("/js/bank-accounts.js?"));
});
