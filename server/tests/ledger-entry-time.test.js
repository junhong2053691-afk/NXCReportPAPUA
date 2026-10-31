// bank_ledger.entry_time 的格式不变量。
//
// 这一列存**实例时区的墙上时间** 'YYYY-MM-DD HH:MM:SS'（无偏移标记），所有日界都是在
// 它上面做字符串前缀比较（accountDayNet / computeBankDailyReport / 流水日期筛选 /
// pendingCounts）。格式一歪，这四处会同时算错且没有任何报错。
//
// ⚠️ 本文件会改进程级时区，所以必须独立（node --test 每个文件一个进程）。

const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULT_TZ, setTimezone, formatWallClock } = require("../lib/dates");
const { normalizeSqlDateTime, nowSql } = require("../lib/bankApply");

test.afterEach(() => {
  setTimezone(DEFAULT_TZ);
});

// ---------------------------------------------------------------- 带时区的瞬间 → 换算

test("带 Z 的 ISO 串按实例时区换算成墙上时间", () => {
  setTimezone("Australia/Sydney");
  assert.equal(normalizeSqlDateTime("2026-01-01T00:00:00Z"), "2026-01-01 11:00:00", "1 月是 AEDT +11");
  assert.equal(normalizeSqlDateTime("2026-06-15T00:00:00Z"), "2026-06-15 10:00:00", "6 月是 AEST +10");

  setTimezone("Asia/Kuala_Lumpur");
  assert.equal(normalizeSqlDateTime("2026-01-01T00:00:00Z"), "2026-01-01 08:00:00", "+08 全年恒定");
  assert.equal(normalizeSqlDateTime("2026-06-15T00:00:00Z"), "2026-06-15 08:00:00");
});

test("带显式偏移的 ISO 串按实例时区换算", () => {
  setTimezone("Australia/Sydney");
  assert.equal(normalizeSqlDateTime("2026-09-15T20:00:00+00:00"), "2026-09-16 06:00:00");
  assert.equal(normalizeSqlDateTime("2026-09-15T20:00:00+08:00"), "2026-09-15 22:00:00");

  setTimezone("Asia/Kuala_Lumpur");
  assert.equal(normalizeSqlDateTime("2026-09-15T20:00:00+00:00"), "2026-09-16 04:00:00");
  assert.equal(normalizeSqlDateTime("2026-09-15T20:00:00+08:00"), "2026-09-15 20:00:00", "同偏移不动");
});

// ---------------------------------------------------------------- 裸时间串 → 原样当墙上时间

test("裸时间串原样当墙上时间，与时区无关", () => {
  // 前端 entryDateTime() 产出的就是这个形状，它已经是「操作员看到的那个时间」，
  // 不该再被换算一次。
  for (const tz of ["Australia/Sydney", "Asia/Kuala_Lumpur", "America/Argentina/Buenos_Aires"]) {
    setTimezone(tz);
    assert.equal(normalizeSqlDateTime("2026-09-15 23:50"), "2026-09-15 23:50:00", tz);
    assert.equal(normalizeSqlDateTime("2026-09-15 23:50:30"), "2026-09-15 23:50:30", tz);
    assert.equal(normalizeSqlDateTime("2026-09-15 00:00:00"), "2026-09-15 00:00:00", tz);
  }
});

test("T 分隔但不带偏移的串也是裸时间串，不走 Date.parse", () => {
  // 回归测试。判定以前写成 /[TzZ]|.../，把 ISO 的**分隔符 T** 和时区标记 Z 混进了
  // 同一个字符类，于是这种串被送进 Date.parse——而 ES 规范规定不带偏移的日期时间串
  // 按**进程本地时区**解析，不是按配置时区。结果同一个输入在不同实例上被静默平移
  // 「进程 TZ 与配置 TZ 之差」那么多小时。这条断言要求所有时区下结果一致。
  const expected = "2026-09-15 23:50:00";
  for (const tz of ["Australia/Sydney", "Asia/Kuala_Lumpur", "America/Argentina/Buenos_Aires", "UTC"]) {
    setTimezone(tz);
    assert.equal(normalizeSqlDateTime("2026-09-15T23:50"), expected, tz);
    assert.equal(normalizeSqlDateTime("2026-09-15T23:50:30"), "2026-09-15 23:50:30", tz);
  }
});

// ---------------------------------------------------------------- 拒绝非法输入

test("非法输入返回空串，由调用方转成 400", () => {
  setTimezone("Australia/Sydney");
  for (const bad of ["", "   ", null, undefined, "garbage", "2026-09-15", "15/09/2026 10:00", "2026-13-01 10:00"]) {
    assert.equal(normalizeSqlDateTime(bad), "", `${JSON.stringify(bad)} 应被拒`);
  }
});

test("不存在的日期被拒，不会被 Date 悄悄滚到下个月", () => {
  setTimezone("Australia/Sydney");
  assert.equal(normalizeSqlDateTime("2026-02-30 10:00"), "", "2 月没有 30 日");
  assert.equal(normalizeSqlDateTime("2026-04-31 10:00"), "", "4 月没有 31 日");
  assert.equal(normalizeSqlDateTime("2025-02-29 10:00"), "", "2025 不是闰年");
  assert.equal(normalizeSqlDateTime("2024-02-29 10:00"), "2024-02-29 10:00:00", "2024 是闰年");
});

test("超范围的时分秒被钳到合法值而不是拒绝", () => {
  setTimezone("Australia/Sydney");
  assert.equal(normalizeSqlDateTime("2026-09-15 99:99"), "2026-09-15 23:59:00");
  assert.equal(normalizeSqlDateTime("2026-09-15 10:30:99"), "2026-09-15 10:30:59");
});

// ---------------------------------------------------------------- 输出格式不变量

test("输出永远是可做字符串比较的固定宽度格式", () => {
  // 日界靠 entry_time >= '<date> 00:00:00' 这类前缀比较，所以位数必须固定。
  const inputs = [
    "2026-01-01T00:00:00Z",
    "2026-09-15 23:50",
    "2026-09-15T23:50",
    "2026-09-15T20:00:00+08:00",
    "2026-09-05 09:05:05",
  ];
  for (const tz of ["Australia/Sydney", "Asia/Kuala_Lumpur"]) {
    setTimezone(tz);
    for (const input of inputs) {
      const out = normalizeSqlDateTime(input);
      assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, `${tz} ${input} -> ${out}`);
      assert.equal(out.length, 19, `${tz} ${input} 长度必须是 19`);
    }
  }
});

test("规范化是幂等的：再跑一次结果不变", () => {
  // 必须成立，否则每次编辑一行流水都会把时间平移一次。
  for (const tz of ["Australia/Sydney", "Asia/Kuala_Lumpur", "America/Argentina/Buenos_Aires"]) {
    setTimezone(tz);
    for (const input of ["2026-01-01T00:00:00Z", "2026-09-15 23:50", "2026-09-15T23:50"]) {
      const once = normalizeSqlDateTime(input);
      assert.equal(normalizeSqlDateTime(once), once, `${tz} ${input} 不幂等`);
    }
  }
});

test("nowSql 跟着实例时区走，且格式与 normalizeSqlDateTime 一致", () => {
  for (const tz of ["Australia/Sydney", "Asia/Kuala_Lumpur"]) {
    setTimezone(tz);
    const now = nowSql();
    assert.match(now, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, tz);
    assert.equal(now, formatWallClock(), `${tz} nowSql 应等于 formatWallClock`);
    assert.equal(normalizeSqlDateTime(now), now, `${tz} nowSql 的输出应已是规范形式`);
  }
});

test("两个时区的 nowSql 差值等于它们的偏移差", () => {
  setTimezone("Australia/Sydney");
  const syd = nowSql();
  setTimezone("Asia/Kuala_Lumpur");
  const kl = nowSql();
  // 两次调用之间可能跨秒，所以比到小时就够——要的是「确实跟着时区变了」。
  const diffHours = (Date.parse(syd.replace(" ", "T") + "Z") - Date.parse(kl.replace(" ", "T") + "Z")) / 3600000;
  assert.ok(Math.abs(diffHours - 2) < 0.1 || Math.abs(diffHours - 3) < 0.1,
    `悉尼与吉隆坡差 2（AEST）或 3（AEDT）小时，实测 ${diffHours}`);
});
