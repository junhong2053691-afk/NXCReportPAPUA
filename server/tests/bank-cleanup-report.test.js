const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bankDatabase: database,
  addCompany,
  addAccount,
  addLedger,
  addAccountEvent,
  outbox,
} = require("./bank-fixture");
const {
  collectCleanupQueue,
  renderBlocked,
  maybeSendCleanupDigest,
} = require("../lib/bankCleanupReport");
const { MAX_BLOCK_CHARS } = require("../lib/telegramRender");
const { TABLE_MAX_WIDTH, displayWidth, stripHtml } = require("../lib/telegramFormat");
const { todayKey, shiftDateKey } = require("../lib/dates");

const TODAY = todayKey();
const YESTERDAY = shiftDateKey(TODAY, -1);

function seed(db) {
  addCompany(db, { id: "alpha", name: "AussieX6", enabled: 1 });
  return db;
}

function shown(rows) {
  return rows.map((r) => stripHtml(r.text)).join("\n");
}

test("队列为空时什么都不发——主动推送里的「无待清理」是纯噪音", () => {
  const db = seed(database());
  addAccount(db, { company_id: "alpha", lifecycle_status: "active" });

  const sent = maybeSendCleanupDigest(db, { force: true });
  assert.equal(sent.length, 0);
  assert.equal(outbox(db).length, 0);
  db.close();
});

test("按余额分成「仍有余额 / 已清零可归档」两组，金额用无上界累计", () => {
  const db = seed(database());
  const dirty = addAccount(db, {
    company_id: "alpha",
    bank_branch: "NAB",
    account_name: "ETHAN JACK",
    lifecycle_status: "banned",
    active: 0,
  });
  const clean = addAccount(db, {
    company_id: "alpha",
    bank_branch: "Suncorp",
    account_name: "Debryan",
    lifecycle_status: "banned",
    active: 0,
  });
  // 每日归零账户：累计有钱但今天没有流水。显示余额会是 0，累计口径必须看见这笔钱。
  const daily = addAccount(db, {
    company_id: "alpha",
    bank_branch: "Ubank",
    lifecycle_status: "banned",
    active: 0,
    reset_daily_balance: 1,
  });

  addLedger(db, dirty, 9966.64, YESTERDAY);
  addLedger(db, clean, 500, YESTERDAY);
  addLedger(db, clean, 0, YESTERDAY, { amount_out: 500 });
  addLedger(db, daily, 5000, YESTERDAY);

  const queue = collectCleanupQueue(db, "alpha");
  assert.deepEqual(queue.archivable.map((e) => e.account.id), [clean]);
  assert.deepEqual(
    queue.dirty.map((e) => e.account.id).sort(),
    [dirty, daily].sort(),
    "每日归零账户的累计余额也必须算进待清"
  );
  assert.equal(Math.round(queue.total * 100), Math.round((9966.64 + 5000) * 100));
  db.close();
});

test("运营中与已归档账户都不进队列", () => {
  const db = seed(database());
  addAccount(db, { company_id: "alpha", bank_branch: "Operating", lifecycle_status: "active" });
  const archived = addAccount(db, {
    company_id: "alpha",
    bank_branch: "Retired",
    lifecycle_status: "archived",
    active: 0,
  });
  addLedger(db, archived, 777, YESTERDAY);

  const queue = collectCleanupQueue(db, "alpha");
  assert.equal(queue.archivable.length, 0);
  assert.equal(queue.dirty.length, 0);

  maybeSendCleanupDigest(db, { force: true });
  assert.ok(!shown(outbox(db)).includes("Retired"), "归档账户已经完事，不该再被催");
  db.close();
});

test("封禁天数取自 bank_account_events —— 这是 /balance 里根本不存在的那一半", () => {
  const db = seed(database());
  const id = addAccount(db, {
    company_id: "alpha",
    bank_branch: "NAB",
    lifecycle_status: "banned",
    active: 0,
  });
  addLedger(db, id, 300, YESTERDAY);
  const now = new Date("2026-03-01T00:00:00Z");
  addAccountEvent(db, id, "banned", "2025-12-01 00:00:00");

  const queue = collectCleanupQueue(db, "alpha", { now });
  assert.equal(queue.dirty[0].bannedDays, 90);
  db.close();
});

test("没有 banned 事件时天数为 null，渲染成 -（不能因此崩掉整条汇总）", () => {
  const db = seed(database());
  const id = addAccount(db, { company_id: "alpha", lifecycle_status: "banned", active: 0 });
  addLedger(db, id, 100, YESTERDAY);

  const queue = collectCleanupQueue(db, "alpha");
  assert.equal(queue.dirty[0].bannedDays, null);
  maybeSendCleanupDigest(db, { force: true });
  assert.ok(outbox(db).length > 0);
  db.close();
});

test("公司 Bot 收明细，总控收概要；概要不含逐户明细", () => {
  const db = seed(database());
  const id = addAccount(db, {
    company_id: "alpha",
    bank_branch: "NAB",
    account_name: "ETHAN JACK",
    lifecycle_status: "banned",
    active: 0,
  });
  addLedger(db, id, 1288.45, YESTERDAY);

  maybeSendCleanupDigest(db, { force: true });
  const rows = outbox(db);
  const company = rows.filter((r) => r.bot_key === "company:alpha");
  const control = rows.filter((r) => r.bot_key === "control");

  assert.ok(company.length > 0, "公司 Bot 必须收到");
  assert.ok(control.length > 0, "总控必须收到");
  assert.ok(shown(company).includes("ETHAN JACK"), "公司版是明细");
  assert.ok(!shown(control).includes("ETHAN JACK"), "总控版是概要，不逐户展开");
  assert.ok(shown(control).includes("AussieX6"), "总控版要说清是哪家");
  for (const row of rows) {
    assert.equal(row.kind, "cleanup");
    assert.equal(row.parse_mode, "HTML", "parse_mode 跟着行走");
  }
  db.close();
});

test("同一周内重复调用只入队一次", () => {
  const db = seed(database());
  const id = addAccount(db, { company_id: "alpha", lifecycle_status: "banned", active: 0 });
  addLedger(db, id, 400, YESTERDAY);

  maybeSendCleanupDigest(db, { force: true });
  const after = outbox(db).length;
  assert.ok(after > 0);

  // 非 force 走完整的到点 + 7 天 lookback 判定；上面刚写过行，所以这次必须什么都不做。
  maybeSendCleanupDigest(db, { now: new Date("2026-03-02T22:00:00Z") });
  assert.equal(outbox(db).length, after, "一周内不该重复轰炸");
  db.close();
});

test("非周一 / 非目标小时不发", () => {
  const db = seed(database());
  const id = addAccount(db, { company_id: "alpha", lifecycle_status: "banned", active: 0 });
  addLedger(db, id, 400, YESTERDAY);

  // 2026-03-04 是周三（Sydney）。
  maybeSendCleanupDigest(db, { now: new Date("2026-03-03T22:00:00Z") });
  assert.equal(outbox(db).length, 0);
  db.close();
});

// 照 telegram-render.test.js 现成的两条写：<pre> 被切开会让 Telegram 直接返回 400，
// 整条消息发不出去——报警掉一条就等于那个账户被永久静音。
test("150 个封禁账户时拆成多个自闭合的块，且每块不超长", () => {
  const db = seed(database());
  for (let i = 0; i < 150; i++) {
    const id = addAccount(db, {
      company_id: "alpha",
      bank_branch: `Bank ${i} 一二三四五六`,
      account_name: `Holder Name ${i}`,
      lifecycle_status: "banned",
      active: 0,
    });
    addLedger(db, id, 100 + i, YESTERDAY);
  }

  maybeSendCleanupDigest(db, { force: true });
  const rows = outbox(db);
  assert.ok(rows.length > 1, "装不下时必须拆块");
  for (const row of rows) {
    const opens = (row.text.match(/<pre>/g) || []).length;
    const closes = (row.text.match(/<\/pre>/g) || []).length;
    assert.equal(opens, closes, "每个块的 <pre> 必须成对闭合");
    assert.ok(row.text.length <= MAX_BLOCK_CHARS + 500, "单块不得超长");
  }
  db.close();
});

test("银行名里的 & < > 被转义，不会被当成标签", () => {
  const db = seed(database());
  const id = addAccount(db, {
    company_id: "alpha",
    bank_branch: "A & B <Bank>",
    lifecycle_status: "banned",
    active: 0,
  });
  addLedger(db, id, 250, YESTERDAY);

  maybeSendCleanupDigest(db, { force: true });
  const text = outbox(db).map((r) => r.text).join("\n");
  assert.ok(text.includes("&amp;"), "& 必须转义，否则含 & 的银行名会让消息 400");
  assert.ok(!/<Bank>/.test(text), "< > 不能原样进 HTML");
  db.close();
});

// ------------------------------------------------------------------ /blocked
//
// 封禁账户整组从 /balance 移走之后，这条命令是「封进去的钱」唯一的查询入口。它和周一
// 那份自动汇总共用同一套采集与版式，所以下面有一条断言刻意钉住「周报也跟着变了」。

const ALPHA = { id: "alpha", name: "AussieX6" };
const BETA = { id: "beta", name: "Rolex66" };

/** Telegram 实际渲染出来的样子。块用 \n\n 连起来——chunkMessage 就是这么装箱的。 */
function flat(blocks) {
  return stripHtml(blocks.join("\n\n"));
}

function seedBanned(db, companyId, overrides, amount) {
  const id = addAccount(db, {
    company_id: companyId,
    lifecycle_status: "banned",
    active: 0,
    ...overrides,
  });
  if (amount) addLedger(db, id, amount, YESTERDAY);
  return id;
}

test("/blocked 每行标注人头 / 幽灵 / PG，单字标配一行图例", () => {
  const db = seed(database());
  seedBanned(db, "alpha", { bank_branch: "NAB", account_name: "ETHAN JACK" }, 1230);
  seedBanned(db, "alpha", { bank_branch: "Ubank", account_kind: "ghost" }, 450);
  seedBanned(db, "alpha", { bank_branch: "FastPay", account_kind: "payment_gateway" }, 0);

  const text = flat(renderBlocked(db, [ALPHA]));
  assert.match(text, /NAB[^\n]*1,230\.00 人/, "人头户行尾挂「人」");
  assert.match(text, /Ubank[^\n]*450\.00 幽/, "幽灵户行尾挂「幽」");
  assert.match(text, /FastPay[^\n]*0\.00 PG/);
  // 标是单字，含义必须跟在同一条消息里（照 /balance 那条 marker 图例的规矩）。
  assert.match(text, /人=人头/);
  assert.match(text, /幽=幽灵/);
  assert.ok(!text.includes("PG=PG"), "PG 的标就是 PG，不必再解释一遍\n" + text);
  db.close();
});

test("/blocked 含行尾类型标后，每行仍不超 TABLE_MAX_WIDTH", () => {
  const db = seed(database());
  // 最坏输入：长中文渠道名 + 长户名。flag 不占 renderTable 的宽度预算，却照样占手机
  // 屏幕——这条断言是 ENTRY_TABLE_WIDTH = TABLE_MAX_WIDTH - 3 唯一的保护。
  seedBanned(
    db,
    "alpha",
    { bank_branch: "招商银行深圳分行营业部", account_name: "BRIDGET ISABELLA", account_number: "100007122" },
    1234567.89
  );
  seedBanned(db, "alpha", { bank_branch: "Ubank 旧户", account_kind: "ghost" }, 0);

  for (const block of renderBlocked(db, [ALPHA])) {
    for (const m of block.matchAll(/<pre>([\s\S]*?)<\/pre>/g)) {
      for (const line of stripHtml(m[1]).split("\n")) {
        assert.ok(
          displayWidth(line) <= TABLE_MAX_WIDTH,
          `第 ${displayWidth(line)} 格超宽，手机上会横向滚动：\n${line}`
        );
      }
    }
  }
  db.close();
});

test("/blocked 没有封禁渠道时也必须有回应", () => {
  const db = seed(database());
  addAccount(db, { company_id: "alpha", lifecycle_status: "active" });

  // 周报那边空队列静默是对的（主动推送里的「无待清理」是纯噪音），但这是对一条显式
  // 命令的回答——留空就是歧义，用户不知道是没有还是坏了。
  assert.deepEqual(renderBlocked(db, [ALPHA]), ["✅ 无封禁渠道"]);
  db.close();
});

test("/blocked 多公司默认只给概要，并给出取明细的办法", () => {
  const db = seed(database());
  addCompany(db, { id: "beta", name: "Rolex66", enabled: 1 });
  seedBanned(db, "alpha", { bank_branch: "NAB", account_name: "ETHAN JACK" }, 1230);
  seedBanned(db, "beta", { bank_branch: "HSBC", account_name: "DEBRYAN LIM" }, 88);

  const text = flat(renderBlocked(db, [ALPHA, BETA]));
  assert.ok(!text.includes("ETHAN JACK"), "概要不逐户展开\n" + text);
  assert.ok(!text.includes("DEBRYAN LIM"));
  assert.match(text, /AussieX6/);
  assert.match(text, /Rolex66/);
  assert.match(text, /待清/, "概要要说清每家还剩几户待清、几户可归档");
  assert.match(text, /单家明细：\/blocked alpha/);
  db.close();
});

test("/blocked all 多公司明细：每家一节，尾注只出现一次", () => {
  const db = seed(database());
  addCompany(db, { id: "beta", name: "Rolex66", enabled: 1 });
  seedBanned(db, "alpha", { bank_branch: "NAB", account_name: "ETHAN JACK" }, 1230);
  seedBanned(db, "beta", { bank_branch: "HSBC", account_name: "DEBRYAN LIM" }, 88);

  const text = flat(renderBlocked(db, [ALPHA, BETA], { detail: true }));
  assert.ok(text.includes("ETHAN JACK") && text.includes("DEBRYAN LIM"), "明细要逐户");
  assert.match(text, /AussieX6｜仍有余额（1）/);
  assert.match(text, /Rolex66｜仍有余额（1）/);
  assert.equal(
    (text.match(/在「渠道管理/g) || []).length,
    1,
    "尾注是整条消息的说明，多公司时只该出现一次\n" + text
  );
  db.close();
});

test("周一那份自动汇总也带上了类型标——两个入口共用一个渲染器", () => {
  const db = seed(database());
  seedBanned(db, "alpha", { bank_branch: "Ubank", account_kind: "ghost" }, 450);

  // 这不是误伤：/blocked 与周报本来就该长一个样。改一处两处一起变，是想要的行为，
  // 所以把它钉成断言，省得下次有人看到周报变了去「修」。
  maybeSendCleanupDigest(db, { force: true });
  const text = shown(outbox(db).filter((r) => r.bot_key === "company:alpha"));
  assert.match(text, /450\.00 幽/);
  assert.match(text, /幽=幽灵/);
  db.close();
});

test("150 个封禁账户经 /blocked 也拆成多个自闭合的块", () => {
  const db = seed(database());
  for (let i = 0; i < 150; i++) {
    seedBanned(
      db,
      "alpha",
      { bank_branch: `Bank ${i} 一二三四五六`, account_name: `Holder Name ${i}` },
      100 + i
    );
  }

  const blocks = renderBlocked(db, [ALPHA]);
  assert.ok(blocks.length > 2, "装不下时必须拆块");
  for (const block of blocks) {
    const opens = (block.match(/<pre>/g) || []).length;
    const closes = (block.match(/<\/pre>/g) || []).length;
    assert.equal(opens, closes, "每个块的 <pre> 必须成对闭合，切开了 Telegram 直接 400");
    assert.ok(block.length <= MAX_BLOCK_CHARS + 500, "单块不得超长");
  }
  db.close();
});
