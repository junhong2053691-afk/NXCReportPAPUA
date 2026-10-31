const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const {
  getTelegramSettings,
  saveTelegramSettings,
  clearControlBotToken,
  RANGES,
} = require("../lib/appSettings");

const TOKEN = "123456789:AAEEaaBBccDDeeFFggHHiiJJkkLLmmNNoo";
const TOKEN2 = "987654321:ZZEEaaBBccDDeeFFggHHiiJJkkLLmmNNoo";

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

test("空库读出完整的默认设置，不抛异常", () => {
  const db = database();
  const s = getTelegramSettings(db);
  assert.equal(s.configured, false, "未配置");
  assert.equal(s.controlBotToken, "");
  assert.equal(s.controlChatIds, "");
  assert.equal(typeof s.enabled, "boolean");
  assert.equal(typeof s.mirrorAlertsToControl, "boolean");
  for (const name of Object.keys(RANGES)) {
    assert.ok(
      s[name] >= RANGES[name].min && s[name] <= RANGES[name].max,
      `${name} 默认值 ${s[name]} 应在 [${RANGES[name].min}, ${RANGES[name].max}] 内`
    );
  }
  db.close();
});

test("表不存在时退回默认值而不是炸掉", () => {
  const db = new Database(":memory:");
  const s = getTelegramSettings(db);
  assert.equal(s.configured, false);
  assert.equal(s.enabled, true);
  db.close();
});

test("保存往返：写入后读回一致", () => {
  const db = database();
  saveTelegramSettings(
    db,
    {
      enabled: false,
      controlBotToken: TOKEN,
      controlChatIds: "-1001234567890, 555",
      mirrorAlertsToControl: false,
      pollTimeoutSeconds: 20,
      outboxFlushSeconds: 10,
      reconcileSeconds: 60,
    },
    "admin"
  );
  const s = getTelegramSettings(db);
  assert.equal(s.enabled, false);
  assert.equal(s.controlBotToken, TOKEN);
  assert.equal(s.controlChatIds, "-1001234567890,555", "chat id 规范化成逗号分隔");
  assert.equal(s.mirrorAlertsToControl, false);
  assert.equal(s.pollTimeoutSeconds, 20);
  assert.equal(s.outboxFlushSeconds, 10);
  assert.equal(s.reconcileSeconds, 60);
  assert.equal(s.configured, true);
  assert.equal(s.updatedBy, "admin");
  assert.ok(s.updatedAt, "应记录修改时间");
  db.close();
});

test("局部更新不影响其他字段", () => {
  const db = database();
  saveTelegramSettings(db, { controlBotToken: TOKEN, controlChatIds: "555", enabled: true }, "a");
  saveTelegramSettings(db, { enabled: false }, "b");
  const s = getTelegramSettings(db);
  assert.equal(s.enabled, false, "改了的字段生效");
  assert.equal(s.controlBotToken, TOKEN, "没传的 token 保持不变");
  assert.equal(s.controlChatIds, "555", "没传的 chat 保持不变");
  assert.equal(s.updatedBy, "b");
  db.close();
});

test("token 留空 = 保持不变，传新值才覆盖", () => {
  const db = database();
  saveTelegramSettings(db, { controlBotToken: TOKEN }, "a");

  saveTelegramSettings(db, { controlBotToken: "" }, "a");
  assert.equal(getTelegramSettings(db).controlBotToken, TOKEN, "空串不应清空已保存的 token");

  saveTelegramSettings(db, { controlChatIds: "1" }, "a");
  assert.equal(getTelegramSettings(db).controlBotToken, TOKEN, "完全不传也不应清空");

  saveTelegramSettings(db, { controlBotToken: TOKEN2 }, "a");
  assert.equal(getTelegramSettings(db).controlBotToken, TOKEN2, "传新值应覆盖");
  db.close();
});

test("显式清空 token 走 clearControlBotToken", () => {
  const db = database();
  saveTelegramSettings(db, { controlBotToken: TOKEN, controlChatIds: "555" }, "a");
  const s = clearControlBotToken(db, "a");
  assert.equal(s.controlBotToken, "");
  assert.equal(s.configured, false);
  assert.equal(s.controlChatIds, "555", "只清 token，不动其他设置");
  db.close();
});

test("chat id 可以被清空（与 token 语义不同）", () => {
  const db = database();
  saveTelegramSettings(db, { controlBotToken: TOKEN, controlChatIds: "555" }, "a");
  saveTelegramSettings(db, { controlChatIds: "" }, "a");
  assert.equal(getTelegramSettings(db).controlChatIds, "", "chat 传空串就是真的清空");
  db.close();
});

test("非法 token 被拒，且不写坏已有配置", () => {
  const db = database();
  saveTelegramSettings(db, { controlBotToken: TOKEN }, "a");
  assert.throws(
    () => saveTelegramSettings(db, { controlBotToken: "not-a-token" }, "a"),
    (e) => e.status === 400 && /token/i.test(e.message)
  );
  assert.equal(getTelegramSettings(db).controlBotToken, TOKEN, "失败的保存不应破坏已有值");
  db.close();
});

test("非法 chat id 被拒，错误信息点名是哪个", () => {
  const db = database();
  assert.throws(
    () => saveTelegramSettings(db, { controlChatIds: "555, abc, -100, xyz" }, "a"),
    (e) => e.status === 400 && e.message.includes("abc") && e.message.includes("xyz")
  );
  assert.equal(getTelegramSettings(db).controlChatIds, "", "失败的保存不应落库");
  db.close();
});

test("间隔被钳制到范围内而不是报错", () => {
  const db = database();
  const s = getTelegramSettings(
    (saveTelegramSettings(
      db,
      { pollTimeoutSeconds: 0, outboxFlushSeconds: 99999, reconcileSeconds: "abc" },
      "a"
    ),
    db)
  );
  assert.equal(s.pollTimeoutSeconds, RANGES.pollTimeoutSeconds.min, "太小 → 钳到下限");
  assert.equal(s.outboxFlushSeconds, RANGES.outboxFlushSeconds.max, "太大 → 钳到上限");
  assert.equal(s.reconcileSeconds, RANGES.reconcileSeconds.def, "非数字 → 用默认值");
  db.close();
});

test("负数与小数间隔也被规范到合法整数", () => {
  const db = database();
  saveTelegramSettings(db, { pollTimeoutSeconds: -10, outboxFlushSeconds: 7.6 }, "a");
  const s = getTelegramSettings(db);
  assert.equal(s.pollTimeoutSeconds, RANGES.pollTimeoutSeconds.min);
  assert.equal(s.outboxFlushSeconds, 8, "小数应四舍五入成整数");
  assert.ok(Number.isInteger(s.outboxFlushSeconds));
  db.close();
});

test("库里的 JSON 损坏时退回默认值而不是炸掉", () => {
  const db = database();
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('telegram', '{ not json')").run();
  const s = getTelegramSettings(db);
  assert.equal(s.configured, false);
  assert.equal(s.enabled, true);
  db.close();
});

test("陌生字段不会被写进存储", () => {
  const db = database();
  saveTelegramSettings(db, { controlBotToken: TOKEN, evilField: "x", __proto__: {} }, "a");
  const stored = JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key='telegram'").get().value);
  assert.equal(stored.evilField, undefined, "只持久化已知字段");
  assert.equal(stored.controlBotToken, TOKEN);
  db.close();
});
