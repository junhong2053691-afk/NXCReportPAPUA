// lib/dates.js 的时区感知测试。
//
// ⚠️ 这个文件**必须独立**：它会改进程级时区。`node --test` 每个文件一个进程，所以
// 这里的变更不会漏到别的测试文件去。**绝不要**从 bank-fixture.js 调 setTimezone，
// 那会让所有共用固件的测试互相污染。

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_TZ,
  getTimezone,
  setTimezone,
  isValidTimezone,
  todayKey,
  dateKeyFromIso,
  shiftDateKey,
  formatWallClock,
  formatSydneyDateTime,
  localMidnightUtc,
  monthBounds,
} = require("../lib/dates");

test.afterEach(() => {
  setTimezone(DEFAULT_TZ);
});

// ---------------------------------------------------------------- setter 的基本契约

test("默认时区是 Australia/Sydney", () => {
  assert.equal(getTimezone(), "Australia/Sydney");
  assert.equal(DEFAULT_TZ, "Australia/Sydney");
});

test("setTimezone 生效，并返回生效后的值", () => {
  assert.equal(setTimezone("Asia/Kuala_Lumpur"), "Asia/Kuala_Lumpur");
  assert.equal(getTimezone(), "Asia/Kuala_Lumpur");
});

test("非法时区被忽略，保持当前值可用", () => {
  setTimezone("Asia/Kuala_Lumpur");
  for (const bad of ["", "   ", null, undefined, "Mars/Olympus_Mons", "Australia/Sydeny"]) {
    assert.equal(setTimezone(bad), "Asia/Kuala_Lumpur", `${JSON.stringify(bad)} 不该改掉时区`);
  }
  assert.equal(getTimezone(), "Asia/Kuala_Lumpur");
});

test("formatSydneyDateTime 仍是 formatWallClock 的 alias", () => {
  // 8 个 require 点还在用旧名字，别把 alias 删了。
  assert.equal(formatSydneyDateTime, formatWallClock);
});

// ---------------------------------------------------------------- 日期键与墙上时间

const ISO = "2026-09-15T20:00:00+00:00"; // 刻意选一个会跨日的瞬间

test("dateKeyFromIso 跟着时区走", () => {
  const cases = {
    "Australia/Sydney": "2026-09-16", // +10 → 次日 06:00
    "Asia/Kuala_Lumpur": "2026-09-16", // +08 → 次日 04:00
    "Pacific/Port_Moresby": "2026-09-16", // +10 → 次日 06:00
    "America/Argentina/Buenos_Aires": "2026-09-15", // −03 → 当日 17:00
  };
  for (const [tz, expected] of Object.entries(cases)) {
    setTimezone(tz);
    assert.equal(dateKeyFromIso(ISO), expected, `${tz} 的日期键`);
  }
});

test("formatWallClock 跟着时区走", () => {
  const cases = {
    "Australia/Sydney": "2026-09-16 06:00:00",
    "Asia/Kuala_Lumpur": "2026-09-16 04:00:00",
    "Pacific/Port_Moresby": "2026-09-16 06:00:00",
    "America/Argentina/Buenos_Aires": "2026-09-15 17:00:00",
  };
  for (const [tz, expected] of Object.entries(cases)) {
    setTimezone(tz);
    assert.equal(formatWallClock(ISO), expected, `${tz} 的墙上时间`);
  }
});

test("formatWallClock 不带偏移标记，且格式恒定可做字符串比较", () => {
  // 这是 bank_ledger.entry_time 的存储格式，所有日界都是在它上面做前缀比较。
  for (const tz of ["Australia/Sydney", "Asia/Kuala_Lumpur", "America/Argentina/Buenos_Aires"]) {
    setTimezone(tz);
    assert.match(formatWallClock(ISO), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, `${tz} 的格式`);
  }
});

test("dateKeyFromIso 对空值和垃圾返回空串", () => {
  for (const bad of ["", null, undefined, "not a date"]) {
    assert.equal(dateKeyFromIso(bad), "");
  }
});

test("todayKey 永远是 ISO 日期键形状", () => {
  for (const tz of ["Australia/Sydney", "Asia/Kuala_Lumpur", "America/Argentina/Buenos_Aires"]) {
    setTimezone(tz);
    assert.match(todayKey(), /^\d{4}-\d{2}-\d{2}$/, `${tz}`);
  }
});

// ---------------------------------------------------------------- shiftDateKey 与时区无关

test("shiftDateKey 是纯日历算术，不受时区影响", () => {
  for (const tz of ["Australia/Sydney", "Asia/Kuala_Lumpur", "America/Argentina/Buenos_Aires"]) {
    setTimezone(tz);
    assert.equal(shiftDateKey("2026-09-15", 1), "2026-09-16");
    assert.equal(shiftDateKey("2026-09-15", -1), "2026-09-14");
    assert.equal(shiftDateKey("2026-01-01", -1), "2025-12-31", "跨年");
    assert.equal(shiftDateKey("2024-02-28", 1), "2024-02-29", "闰年");
  }
});

test("shiftDateKey 跨 DST 边界不跳天、不停在同一天", () => {
  // 它走 Date.UTC + setUTCDate，刻意不经过时区——所以 DST 切换日也是老老实实加一天。
  setTimezone("Australia/Sydney");
  assert.equal(shiftDateKey("2026-10-03", 1), "2026-10-04", "入夏令时那天");
  assert.equal(shiftDateKey("2026-10-04", 1), "2026-10-05");
  assert.equal(shiftDateKey("2026-04-04", 1), "2026-04-05", "出夏令时那天");
  assert.equal(shiftDateKey("2026-04-05", 1), "2026-04-06");
});

// ---------------------------------------------------------------- localMidnightUtc
//
// 全项目唯一正确的时区↔UTC 换算器，/api/audit 和 backup.js 的重启兜底都靠它。
// 以前它藏在 routes/audit.js 里且零测试覆盖。

test("localMidnightUtc：无 DST 的时区是恒定偏移", () => {
  const cases = {
    "Asia/Kuala_Lumpur": {
      // +08 全年恒定
      "2026-06-15": "2026-06-14 16:00:00",
      "2026-10-05": "2026-10-04 16:00:00",
      "2026-04-05": "2026-04-04 16:00:00",
    },
    "Pacific/Port_Moresby": {
      // +10 全年恒定
      "2026-06-15": "2026-06-14 14:00:00",
      "2026-10-05": "2026-10-04 14:00:00",
    },
    "America/Argentina/Buenos_Aires": {
      // −03 全年恒定：本地午夜在 UTC 的**同一天** 03:00
      "2026-06-15": "2026-06-15 03:00:00",
      "2026-10-05": "2026-10-05 03:00:00",
    },
  };
  for (const [tz, days] of Object.entries(cases)) {
    setTimezone(tz);
    for (const [key, expected] of Object.entries(days)) {
      assert.equal(localMidnightUtc(key), expected, `${tz} ${key}`);
    }
  }
});

test("localMidnightUtc：悉尼跨 DST 边界算对", () => {
  // 这是三次迭代收敛买来的东西。跳钟发生在凌晨 2 点 / 3 点，所以**切换当天的午夜**
  // 用的还是旧偏移，次日才换。一次猜解会在这两天各偏一小时。
  setTimezone("Australia/Sydney");
  assert.equal(localMidnightUtc("2026-06-15"), "2026-06-14 14:00:00", "冬季 AEST +10");
  assert.equal(localMidnightUtc("2026-10-04"), "2026-10-03 14:00:00", "入夏令时当天午夜仍是 +10");
  assert.equal(localMidnightUtc("2026-10-05"), "2026-10-04 13:00:00", "次日起 AEDT +11");
  assert.equal(localMidnightUtc("2026-04-05"), "2026-04-04 13:00:00", "出夏令时当天午夜仍是 +11");
  assert.equal(localMidnightUtc("2026-04-06"), "2026-04-05 14:00:00", "次日起回 AEST +10");
});

test("localMidnightUtc 的往返不变量：本地午夜换回日期键还是同一天", () => {
  // 这条性质断言比上面那些硬编码值更能抓住「换算方向反了」这类错误。
  for (const tz of [
    "Australia/Sydney",
    "Asia/Kuala_Lumpur",
    "Pacific/Port_Moresby",
    "America/Argentina/Buenos_Aires",
  ]) {
    setTimezone(tz);
    for (const key of ["2026-01-15", "2026-04-05", "2026-06-15", "2026-10-04", "2026-10-05", "2026-12-31"]) {
      const utc = localMidnightUtc(key);
      // localMidnightUtc 回的是 UTC 墙上时间（无 Z），补上 Z 才能当 UTC 瞬间解析。
      assert.equal(dateKeyFromIso(utc.replace(" ", "T") + "Z"), key, `${tz} ${key} 往返`);
    }
  }
});

test("localMidnightUtc 的区间上界用 shiftDateKey(+1) 得到，不会漏掉当天末尾", () => {
  // 这是 routes/audit.js 实际的用法：occurred_at >= from 且 < to+1。
  setTimezone("Australia/Sydney");
  const start = localMidnightUtc("2026-06-15");
  const end = localMidnightUtc(shiftDateKey("2026-06-15", 1));
  assert.ok(start < end, "区间非空");
  // 悉尼冬季一天就是 24 小时
  const hours = (Date.parse(end.replace(" ", "T") + "Z") - Date.parse(start.replace(" ", "T") + "Z")) / 3600000;
  assert.equal(hours, 24);

  // 入夏令时那天只有 23 小时——区间照样严格相邻，不重不漏。
  const dstStart = localMidnightUtc("2026-10-04");
  const dstEnd = localMidnightUtc("2026-10-05");
  const dstHours =
    (Date.parse(dstEnd.replace(" ", "T") + "Z") - Date.parse(dstStart.replace(" ", "T") + "Z")) / 3600000;
  assert.equal(dstHours, 23, "入夏令时那天 23 小时");
});

test("localMidnightUtc 对非法日期键返回 null", () => {
  setTimezone("Australia/Sydney");
  for (const bad of ["", null, undefined, "2026-6-15", "20260615", "not-a-date", "2026-06-15 10:00"]) {
    assert.equal(localMidnightUtc(bad), null, `${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------- monthBounds

test("monthBounds 跟着时区的 today 走", () => {
  setTimezone("Asia/Kuala_Lumpur");
  const b = monthBounds("2026-06-15", "2026-06-20");
  assert.equal(b.month, "2026-06");
  assert.equal(b.from, "2026-06-01");
  assert.equal(b.to, "2026-06-20", "当月不完整时上界截到今天");
  assert.equal(b.isComplete, false);

  const done = monthBounds("2026-05-15", "2026-06-20");
  assert.equal(done.to, "2026-05-31");
  assert.equal(done.isComplete, true);
});

test("monthBounds 对非法输入返回 null", () => {
  for (const bad of ["", null, "2026-06", "garbage"]) {
    assert.equal(monthBounds(bad, "2026-06-20"), null);
  }
});

// ---------------------------------------------------------------- isValidTimezone

test("isValidTimezone 认 IANA 名字、拒垃圾", () => {
  for (const tz of [
    "Australia/Sydney",
    "Asia/Kuala_Lumpur",
    "Pacific/Port_Moresby",
    "America/Argentina/Buenos_Aires",
    "UTC",
  ]) {
    assert.ok(isValidTimezone(tz), `${tz} 应合法`);
  }
  for (const bad of ["", "Not/AZone", "Australia/Sydeny", "GMT+10:00xyz"]) {
    assert.equal(isValidTimezone(bad), false, `${JSON.stringify(bad)} 应非法`);
  }
});
