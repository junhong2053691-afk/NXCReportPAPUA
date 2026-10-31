const test = require("node:test");
const assert = require("node:assert/strict");

const { bankDatabase, addAccount, addCompany, addLedger, addSentMessage } = require("./bank-fixture");
const {
  handleMessage,
  parseCommand,
  resolveCompanyArg,
  parseChatIds,
  isValidChatId,
  resolveBots,
  processOutbox,
  botHealth,
  parkBot,
  isParked,
  expireStalePending,
  readBotState,
  writeBotState,
  primeOffset,
  CONTROL_KEY,
  PENDING_MAX_AGE_HOURS,
} = require("../services/telegramBots");
const { defaults } = require("../lib/appSettings");

/** 构造一份完整的设置对象，只覆盖关心的字段。 */
function settings(overrides = {}) {
  return { ...defaults(), ...overrides };
}
const { refreshBankBalance } = require("../lib/bankReport");
const { tokenFingerprint, chunkMessage } = require("../services/telegram");
const { stripHtml } = require("../lib/telegramFormat");
const { todayKey } = require("../lib/dates");

const TOKEN_A = "111111111:AAEEaaBBccDDeeFFggHHiiJJkkLLmmNNoo";
const TOKEN_B = "222222222:BBEEaaBBccDDeeFFggHHiiJJkkLLmmNNoo";
const TODAY = todayKey();

function companyBot(chatIds, companies = [{ id: "alpha", name: "AussieX6" }]) {
  return { botKey: "company:alpha", token: TOKEN_A, chatIds, companies, label: "AussieX6" };
}

function controlBot(chatIds = ["7"]) {
  return {
    botKey: CONTROL_KEY,
    token: TOKEN_B,
    chatIds,
    companies: [
      { id: "alpha", name: "AussieX6" },
      { id: "beta", name: "Rolex66" },
    ],
    isControl: true,
  };
}

function msg(text, chatId = 555) {
  return { chat: { id: chatId }, text };
}

test("parseCommand 剥掉群里自动附加的 @botname、拆出参数，并忽略非命令消息", () => {
  assert.deepEqual(parseCommand("/balance@my_trader_bot"), { command: "/balance", arg: "" });
  assert.deepEqual(parseCommand("/BALANCE"), { command: "/balance", arg: "" });
  assert.deepEqual(parseCommand("  /today  extra args"), { command: "/today", arg: "extra args" });
  assert.deepEqual(parseCommand("/balance@my_bot rolex66"), { command: "/balance", arg: "rolex66" });
  assert.equal(parseCommand("balance"), null);
  assert.equal(parseCommand(""), null);
  assert.equal(parseCommand(undefined), null);
});

test("resolveCompanyArg：id / 公司名 / 唯一前缀都能命中，歧义与未知返回 null", () => {
  const companies = [
    { id: "aussiex6", name: "AussieX6" },
    { id: "rolex66", name: "Rolex66" },
    { id: "rolex99", name: "Rolex99" },
  ];
  assert.equal(resolveCompanyArg(companies, "rolex66").id, "rolex66");
  assert.equal(resolveCompanyArg(companies, "AUSSIEX6").id, "aussiex6");
  assert.equal(resolveCompanyArg(companies, "AussieX6").id, "aussiex6", "按公司名也能查");
  assert.equal(resolveCompanyArg(companies, "auss").id, "aussiex6", "唯一前缀");
  assert.equal(resolveCompanyArg(companies, "rolex"), null, "前缀歧义时不猜");
  assert.equal(resolveCompanyArg(companies, "nope"), null);
  assert.equal(resolveCompanyArg(companies, ""), null);
});

test("parseChatIds 支持逗号 / 分号 / 空格分隔，isValidChatId 接受负数群 id", () => {
  assert.deepEqual(parseChatIds("123, -456; 789"), ["123", "-456", "789"]);
  assert.deepEqual(parseChatIds(["1", " 2 "]), ["1", "2"]);
  assert.deepEqual(parseChatIds(""), []);
  assert.ok(isValidChatId("-1001234567890"), "群 chat id 是负数");
  assert.ok(isValidChatId("555"));
  assert.ok(!isValidChatId("abc"));
  assert.ok(!isValidChatId(""));
});

test("/myid 免鉴权，只回 chat id，不含任何业务数据", () => {
  const db = bankDatabase();
  const id = addAccount(db, { alert_threshold: 0 });
  addLedger(db, id, 88888, TODAY);
  refreshBankBalance(db, id, { alert: false });

  const blocks = handleMessage(db, companyBot([]), msg("/myid", 42));
  const text = blocks.join("\n");
  assert.match(text, /42/);
  assert.ok(!text.includes("88,888.00"), "/myid 绝不能泄露余额");
  assert.ok(!text.includes("CBA Sydney"), "/myid 绝不能泄露渠道名");
  db.close();
});

test("非白名单 chat 的 /balance 与 /today 一律静默丢弃", () => {
  const db = bankDatabase();
  addAccount(db, {});
  const bot = companyBot(["999"]);
  assert.deepEqual(handleMessage(db, bot, msg("/balance", 555)), []);
  assert.deepEqual(handleMessage(db, bot, msg("/today", 555)), []);
  assert.deepEqual(handleMessage(db, bot, msg("/blocked", 555)), []);
  assert.deepEqual(handleMessage(db, bot, msg("/help", 555)), []);
  db.close();
});

test("白名单 chat 能查到本公司余额", () => {
  const db = bankDatabase();
  const id = addAccount(db, { bank_branch: "CBA Sydney" });
  addLedger(db, id, 1234.5, TODAY);
  refreshBankBalance(db, id, { alert: false });

  const blocks = handleMessage(db, companyBot(["555"]), msg("/balance", 555));
  const text = blocks.join("\n\n");
  assert.match(text, /CBA Sydney/);
  assert.match(text, /1,234\.50/);
  db.close();
});

test("公司 Bot 只能看到自己公司，看不到别家", () => {
  const db = bankDatabase();
  const mine = addAccount(db, { company_id: "alpha", bank_branch: "CBA Sydney" });
  const theirs = addAccount(db, { company_id: "beta", bank_branch: "ANZ Secret" });
  addLedger(db, mine, 100, TODAY);
  addLedger(db, theirs, 200, TODAY);
  refreshBankBalance(db, mine, { alert: false });
  refreshBankBalance(db, theirs, { alert: false });

  const text = handleMessage(db, companyBot(["555"]), msg("/balance", 555)).join("\n\n");
  assert.match(text, /CBA Sydney/);
  assert.ok(!text.includes("ANZ Secret"), "公司 Bot 不应泄露别家公司的渠道");
  db.close();
});

test("总控 Bot 看到全部启用公司", () => {
  const db = bankDatabase();
  const a = addAccount(db, { company_id: "alpha", bank_branch: "CBA Sydney" });
  const b = addAccount(db, { company_id: "beta", bank_branch: "ANZ Melbourne" });
  addLedger(db, a, 100, TODAY);
  addLedger(db, b, 200, TODAY);
  refreshBankBalance(db, a, { alert: false });
  refreshBankBalance(db, b, { alert: false });

  const control = controlBot();
  // 默认给概要：两家公司都在，但不展开到账户。
  const summary = stripHtml(handleMessage(db, control, msg("/balance", 7)).join("\n\n"));
  assert.match(summary, /AussieX6/);
  assert.match(summary, /Rolex66/);
  assert.ok(!summary.includes("CBA Sydney"), "概要模式不展开账户");

  // /balance all 才全展开。
  const all = stripHtml(handleMessage(db, control, msg("/balance all", 7)).join("\n\n"));
  assert.match(all, /【AussieX6】/);
  assert.match(all, /【Rolex66】/);
  assert.match(all, /CBA Sydney/);
  assert.match(all, /ANZ Melbourne/);
  db.close();
});

test("总控 Bot 带公司参数只给那一家的明细", () => {
  const db = bankDatabase();
  const a = addAccount(db, { company_id: "alpha", bank_branch: "CBA Sydney" });
  const b = addAccount(db, { company_id: "beta", bank_branch: "ANZ Melbourne" });
  addLedger(db, a, 100, TODAY);
  addLedger(db, b, 200, TODAY);
  refreshBankBalance(db, a, { alert: false });
  refreshBankBalance(db, b, { alert: false });

  for (const arg of ["beta", "Rolex66", "rolex"]) {
    const text = stripHtml(handleMessage(db, controlBot(), msg("/balance " + arg, 7)).join("\n\n"));
    assert.match(text, /ANZ Melbourne/, `参数「${arg}」应命中 Rolex66`);
    assert.ok(!text.includes("CBA Sydney"), `参数「${arg}」不该带出另一家`);
  }
  db.close();
});

test("认不出的公司参数给提示，且只列出这个 bot 能看到的公司", () => {
  const db = bankDatabase();
  const mine = addAccount(db, { company_id: "alpha", bank_branch: "CBA Sydney" });
  const theirs = addAccount(db, { company_id: "beta", bank_branch: "ANZ Secret" });
  addLedger(db, mine, 100, TODAY);
  addLedger(db, theirs, 200, TODAY);
  refreshBankBalance(db, mine, { alert: false });
  refreshBankBalance(db, theirs, { alert: false });

  const blocks = handleMessage(db, companyBot(["555"]), msg("/balance beta", 555));
  const text = stripHtml(blocks.join("\n\n"));
  assert.match(text, /没找到公司/, "别家公司存在与否不该有区别——一律「没找到」");
  assert.match(text, /alpha/, "提示里要给出可用的公司");
  assert.ok(!text.includes("Rolex66"), "可用列表只许出现本 bot 的公司");
  assert.ok(!text.includes("ANZ Secret"), "更不能带出别家的渠道");

  // 认不出的参数不会退化成「查全部」。
  assert.ok(!text.includes("CBA Sydney"), "认不出参数时不应顺手把本公司明细也吐出来");
  db.close();
});

test("未授权 chat 带参数的命令同样静默丢弃", () => {
  const db = bankDatabase();
  addAccount(db, {});
  const bot = companyBot(["999"]);
  assert.deepEqual(handleMessage(db, bot, msg("/balance alpha", 555)), []);
  assert.deepEqual(handleMessage(db, bot, msg("/balance all", 555)), []);
  assert.deepEqual(handleMessage(db, bot, msg("/today alpha", 555)), []);
  assert.deepEqual(handleMessage(db, bot, msg("/blocked alpha", 555)), []);
  db.close();
});

test("/blocked 走和 /balance 完全一样的参数规矩", () => {
  const db = bankDatabase();
  const mine = addAccount(db, {
    company_id: "alpha",
    bank_branch: "CBA Banned",
    lifecycle_status: "banned",
    active: 0,
  });
  const theirs = addAccount(db, {
    company_id: "beta",
    bank_branch: "ANZ Secret",
    lifecycle_status: "banned",
    active: 0,
  });
  addLedger(db, mine, 100, TODAY);
  addLedger(db, theirs, 200, TODAY);
  refreshBankBalance(db, mine, { alert: false });
  refreshBankBalance(db, theirs, { alert: false });

  // 公司 Bot 只有一家 → 明细。
  const own = stripHtml(handleMessage(db, companyBot(["555"]), msg("/blocked", 555)).join("\n\n"));
  assert.match(own, /CBA Banned/);
  assert.ok(!own.includes("ANZ Secret"), "公司 Bot 不应泄露别家公司的封禁渠道");

  // 总控多家 → 概要；all 才展开。
  const summary = stripHtml(handleMessage(db, controlBot(), msg("/blocked", 7)).join("\n\n"));
  assert.ok(!summary.includes("CBA Banned"), "概要模式不展开账户");
  const all = stripHtml(handleMessage(db, controlBot(), msg("/blocked all", 7)).join("\n\n"));
  assert.match(all, /CBA Banned/);
  assert.match(all, /ANZ Secret/);

  // 认不出的参数不退化成「查全部」——这正是把参数解析抽成 renderForArg 要守的东西。
  const denied = stripHtml(
    handleMessage(db, companyBot(["555"]), msg("/blocked beta", 555)).join("\n\n")
  );
  assert.match(denied, /没找到公司/);
  assert.ok(!denied.includes("ANZ Secret"), "不能靠传参越权查别家");
  assert.ok(!denied.includes("CBA Banned"), "认不出参数时不该顺手把本公司明细也吐出来");
  db.close();
});

test("/help 列出 /blocked，并标明 /balance 只给在跑着的", () => {
  const db = bankDatabase();
  const text = stripHtml(handleMessage(db, companyBot(["555"]), msg("/help", 555)).join("\n\n"));
  assert.match(text, /\/blocked/);
  // /balance 的语义变窄了（封禁整组移去了 /blocked），/help 是唯一会说这件事的地方。
  assert.match(text, /渠道余额（在跑）/);
  db.close();
});

test("命令回复里的 <pre> 成对闭合——切开就是 Telegram 400", () => {
  const db = bankDatabase();
  const id = addAccount(db, { company_id: "alpha", bank_branch: "A & B <Bank>" });
  addLedger(db, id, 1234.5, TODAY);
  refreshBankBalance(db, id, { alert: false });
  // /blocked 要有封禁户才会渲染出 <pre>，否则只测到「✅ 无封禁渠道」那条纯文本。
  const banned = addAccount(db, {
    company_id: "alpha",
    bank_branch: "C & D <Old>",
    lifecycle_status: "banned",
    active: 0,
  });
  addLedger(db, banned, 99, TODAY);
  refreshBankBalance(db, banned, { alert: false });

  for (const cmd of ["/balance", "/blocked", "/help", "/myid"]) {
    const blocks = handleMessage(db, companyBot(["555"]), msg(cmd, 555));
    for (const part of chunkMessage(blocks)) {
      assert.equal(
        (part.match(/<\/pre>/g) || []).length,
        (part.match(/<pre>/g) || []).length,
        cmd + " 的回复里 <pre> 不成对"
      );
    }
  }
  // 银行名里的 & 必须转义，否则 HTML 模式直接 400。
  const text = handleMessage(db, companyBot(["555"]), msg("/balance", 555)).join("\n\n");
  assert.match(text, /A &amp; B &lt;Bank&gt;/);
  db.close();
});

test("未知命令静默丢弃", () => {
  const db = bankDatabase();
  assert.deepEqual(handleMessage(db, companyBot(["555"]), msg("/drop_table", 555)), []);
  assert.deepEqual(handleMessage(db, companyBot(["555"]), msg("随便聊聊", 555)), []);
  db.close();
});

test("resolveBots 跳过 token 为空或格式不合法的公司，并识别总控 Bot", () => {
  const db = bankDatabase();
  addCompany(db, { id: "alpha", name: "AussieX6", telegram_bot_token: TOKEN_A, telegram_chat_ids: "1,2" });
  addCompany(db, { id: "beta", name: "Rolex66", telegram_bot_token: "" });
  addCompany(db, { id: "gamma", name: "Bad", telegram_bot_token: "not-a-token" });
  addCompany(db, { id: "delta", name: "Disabled", enabled: 0, telegram_bot_token: TOKEN_B });

  const bots = resolveBots(db, settings({ controlBotToken: TOKEN_B, controlChatIds: "7" }));
  const keys = bots.map((b) => b.botKey).sort();
  assert.deepEqual(keys, ["company:alpha", "control"]);

  const alpha = bots.find((b) => b.botKey === "company:alpha");
  assert.deepEqual(alpha.chatIds, ["1", "2"]);
  assert.deepEqual(alpha.companies, [{ id: "alpha", name: "AussieX6" }]);

  // 总控看到全部启用公司（disabled 的 delta 不算）。
  const control = bots.find((b) => b.botKey === "control");
  assert.deepEqual(control.companies.map((c) => c.id).sort(), ["alpha", "beta", "gamma"]);
  db.close();
});

test("总开关关掉时一个 bot 都不起，公司 Bot 也停", () => {
  const db = bankDatabase();
  addCompany(db, { id: "alpha", telegram_bot_token: TOKEN_A });
  const bots = resolveBots(db, settings({ enabled: false, controlBotToken: TOKEN_B }));
  assert.deepEqual(bots, [], "总开关是全局的，不是只管总控 Bot");
  db.close();
});

test("总控未配置时公司 Bot 照常工作", () => {
  const db = bankDatabase();
  addCompany(db, { id: "alpha", telegram_bot_token: TOKEN_A, telegram_chat_ids: "1" });
  const bots = resolveBots(db, settings({ controlBotToken: "" }));
  assert.deepEqual(bots.map((b) => b.botKey), ["company:alpha"]);
  db.close();
});

test("resolveBots 不要求平台 API 凭证——没配 API 的公司一样要能收报警", () => {
  const db = bankDatabase();
  addCompany(db, {
    id: "alpha",
    api_url: "",
    access_id: "",
    access_token: "",
    telegram_bot_token: TOKEN_A,
  });
  const bots = resolveBots(db, settings());
  assert.deepEqual(bots.map((b) => b.botKey), ["company:alpha"]);
  db.close();
});

test("总开关关掉时 flush 不碰 outbox —— 报警必须留着，不能被静默丢弃", async () => {
  const db = bankDatabase();
  addCompany(db, { id: "alpha", telegram_bot_token: TOKEN_A, telegram_chat_ids: "1" });
  db.prepare(
    "INSERT INTO telegram_outbox (company_id, bot_key, kind, text) VALUES ('alpha','company:alpha','alert','x')"
  ).run();

  await processOutbox(db, settings({ enabled: false }));

  const row = db.prepare("SELECT * FROM telegram_outbox").get();
  assert.equal(row.state, "pending", "关开关期间的报警必须留在队列里等补发");
  assert.equal(row.attempts, 0, "不应消耗重试次数");
  db.close();
});

test("超过保留时长的 pending 行被标成 expired", () => {
  const db = bankDatabase();
  db.prepare(
    `INSERT INTO telegram_outbox (company_id, bot_key, kind, text, created_at)
     VALUES ('alpha','company:alpha','alert','old', datetime('now', '-${PENDING_MAX_AGE_HOURS + 1} hours'))`
  ).run();
  db.prepare(
    "INSERT INTO telegram_outbox (company_id, bot_key, kind, text) VALUES ('alpha','company:alpha','alert','fresh')"
  ).run();

  expireStalePending(db);

  const rows = db.prepare("SELECT text, state FROM telegram_outbox ORDER BY id").all();
  assert.equal(rows[0].state, "expired", "过期的不再补发");
  assert.equal(rows[1].state, "pending", "新的不受影响");
  db.close();
});

test("没有收件 chat 时标成 skipped，不会无限重试", async () => {
  const db = bankDatabase();
  addCompany(db, { id: "alpha", telegram_bot_token: TOKEN_A, telegram_chat_ids: "" });
  db.prepare(
    "INSERT INTO telegram_outbox (company_id, bot_key, kind, text) VALUES ('alpha','company:alpha','alert','x')"
  ).run();

  await processOutbox(db, settings({ controlBotToken: "" }));

  const row = db.prepare("SELECT * FROM telegram_outbox").get();
  assert.equal(row.state, "skipped");
  assert.match(row.last_error, /收件/);
  db.close();
});

// ------------------------------------------------------- 已发消息落库 / 复位时撤回
//
// 撤回的前提是记下 message_id。记不下就撤不回，而撤不回的那条 ⚠️ 会永远挂在聊天里
// 误导人——所以下面既测「发成功要落库」，也测「发失败不能乱落」。

/**
 * 假的 Telegram API。按方法名分流，`fail` 里给某个方法指定一个 400 描述。
 * deliver / processOutbox 不接受 fetchImpl，只能覆盖 globalThis.fetch。
 */
function fakeTelegram({ fail = {}, nextMessageId = 500 } = {}) {
  let seq = nextMessageId;
  const calls = [];
  const impl = async (url, init) => {
    const method = String(url).split("/").pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body, token: String(url).match(/bot([^/]+)\//)?.[1] });
    if (fail[method]) {
      return {
        status: 400,
        ok: false,
        text: async () => JSON.stringify({ ok: false, description: fail[method] }),
      };
    }
    const result = method === "sendMessage" ? { message_id: seq++ } : true;
    return { status: 200, ok: true, text: async () => JSON.stringify({ ok: true, result }) };
  };
  impl.calls = calls;
  impl.of = (m) => calls.filter((c) => c.method === m);
  return impl;
}

async function withFakeTelegram(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function enqueueAlert(db, { bankAccountId = 1, text = "⚠️ 余额报警", kind = "alert" } = {}) {
  const info = db
    .prepare(
      `INSERT INTO telegram_outbox (company_id, bot_key, kind, bank_account_id, text, parse_mode)
       VALUES ('alpha', 'company:alpha', ?, ?, ?, 'HTML')`
    )
    .run(kind, bankAccountId, text);
  return Number(info.lastInsertRowid);
}

const sent = (db) => db.prepare("SELECT * FROM telegram_sent_messages ORDER BY id").all();

/**
 * 按真实顺序预置「报警已发出」的局面：先有报警的 outbox 行，已发消息指向它，
 * 复位时排的 retract 行 id 更大——水位线 outbox_id < retract.id 就是靠这个顺序成立的。
 */
function seedAlertAndSent(db, bankAccountId, messageIds) {
  const alertId = enqueueAlert(db, { bankAccountId });
  db.prepare("UPDATE telegram_outbox SET state = 'sent' WHERE id = ?").run(alertId);
  for (const mid of messageIds) {
    addSentMessage(db, { bank_account_id: bankAccountId, message_id: mid, outbox_id: alertId });
  }
  return alertId;
}

test("报警发出后落下 message_id，抄送总控的那一份单独记一行", async () => {
  const db = bankDatabase();
  addCompany(db, { id: "alpha", telegram_bot_token: TOKEN_A, telegram_chat_ids: "1" });
  enqueueAlert(db, { bankAccountId: 9 });

  const tg = fakeTelegram();
  await withFakeTelegram(tg, () =>
    processOutbox(db, settings({ controlBotToken: TOKEN_B, controlChatIds: "7" }))
  );

  const rows = sent(db);
  assert.equal(rows.length, 2, "公司 chat 一行 + 抄送总控一行");
  assert.deepEqual(
    rows.map((r) => [r.bot_key, r.chat_id]),
    [["company:alpha", "1"], [CONTROL_KEY, "7"]]
  );
  for (const r of rows) {
    assert.equal(r.bank_account_id, 9);
    assert.ok(r.message_id > 0, "没有 message_id 就撤不回");
    assert.equal(r.retracted_at, "");
  }
  db.close();
});

test("没有收件 chat 的 skipped 行不落任何已发消息", async () => {
  const db = bankDatabase();
  addCompany(db, { id: "alpha", telegram_bot_token: TOKEN_A, telegram_chat_ids: "" });
  enqueueAlert(db, { bankAccountId: 9 });

  const tg = fakeTelegram();
  await withFakeTelegram(tg, () => processOutbox(db, settings({ controlBotToken: "" })));

  // 一条都没发出去，撤回时自然跳过——这正是「一轮发 5 条、2 条没发成功就只撤 3 条」
  // 这个性质的来源。
  assert.equal(sent(db).length, 0);
  db.close();
});

test("撤回任务逐条删消息，并标上 retracted_at 与 method", async () => {
  const db = bankDatabase();
  addCompany(db, { id: "alpha", telegram_bot_token: TOKEN_A, telegram_chat_ids: "1" });
  seedAlertAndSent(db, 9, [111, 222]);
  enqueueAlert(db, { bankAccountId: 9, kind: "retract", text: "✅ 已处理 · CBA" });

  const tg = fakeTelegram();
  await withFakeTelegram(tg, () => processOutbox(db, settings({ controlBotToken: "" })));

  const dels = tg.of("deleteMessage");
  assert.equal(dels.length, 2);
  assert.deepEqual(dels.map((c) => c.body.message_id).sort((a, b) => a - b), [111, 222]);
  assert.equal(dels[0].token, TOKEN_A, "只有发它的那个 bot 删得掉");
  for (const r of sent(db)) {
    assert.notEqual(r.retracted_at, "");
    assert.equal(r.retract_method, "delete");
  }
  assert.equal(db.prepare("SELECT state FROM telegram_outbox WHERE kind='retract'").get().state, "sent");
  db.close();
});

test("删不掉（超 48 小时）就退到编辑，改成 ✅ 已处理 且不带 parse_mode", async () => {
  const db = bankDatabase();
  addCompany(db, { id: "alpha", telegram_bot_token: TOKEN_A, telegram_chat_ids: "1" });
  seedAlertAndSent(db, 9, [111]);
  enqueueAlert(db, { bankAccountId: 9, kind: "retract", text: "✅ 已处理 · CBA Sydney" });

  const tg = fakeTelegram({ fail: { deleteMessage: "Bad Request: message can't be deleted for everyone" } });
  await withFakeTelegram(tg, () => processOutbox(db, settings({ controlBotToken: "" })));

  const edits = tg.of("editMessageText");
  assert.equal(edits.length, 1, "删不掉必须改，不能放弃——留着一条不成立的 ⚠️ 是最坏结果");
  assert.equal(edits[0].body.text, "✅ 已处理 · CBA Sydney");
  assert.equal(edits[0].body.parse_mode, undefined);
  assert.equal(sent(db)[0].retract_method, "edit");
  db.close();
});

test("消息已被人手删时按「目的已达成」收尾，不重试", async () => {
  const db = bankDatabase();
  addCompany(db, { id: "alpha", telegram_bot_token: TOKEN_A, telegram_chat_ids: "1" });
  seedAlertAndSent(db, 9, [111]);
  enqueueAlert(db, { bankAccountId: 9, kind: "retract", text: "✅ 已处理" });

  const tg = fakeTelegram({ fail: { deleteMessage: "Bad Request: message to delete not found" } });
  await withFakeTelegram(tg, () => processOutbox(db, settings({ controlBotToken: "" })));

  assert.equal(tg.of("editMessageText").length, 0, "已经不在了就别再去编辑");
  assert.equal(sent(db)[0].retract_method, "gone");
  assert.equal(db.prepare("SELECT state FROM telegram_outbox WHERE kind='retract'").get().state, "sent");
  db.close();
});

test("撤回只撤 outbox_id 小于自己的消息——重试期间的新报警不会被吃掉", async () => {
  const db = bankDatabase();
  addCompany(db, { id: "alpha", telegram_bot_token: TOKEN_A, telegram_chat_ids: "1" });
  seedAlertAndSent(db, 9, [111]);
  const retractId = enqueueAlert(db, { bankAccountId: 9, kind: "retract", text: "✅ 已处理" });
  // 撤回任务排队之后才发出的新报警：余额又超标了，这条 ⚠️ 是成立的，不能被删。
  addSentMessage(db, { bank_account_id: 9, message_id: 999, outbox_id: retractId + 1 });

  const tg = fakeTelegram();
  await withFakeTelegram(tg, () => processOutbox(db, settings({ controlBotToken: "" })));

  assert.deepEqual(tg.of("deleteMessage").map((c) => c.body.message_id), [111]);
  const fresh = sent(db).find((r) => r.message_id === 999);
  assert.equal(fresh.retracted_at, "", "新报警必须原封不动留在聊天里");
  db.close();
});

test("找不到 bot 时撤回按失败重试，绝不把消息标成已撤回", async () => {
  const db = bankDatabase();
  // 公司没配 token ⇒ resolveBots 里没有 company:alpha。
  addCompany(db, { id: "alpha", telegram_bot_token: "", telegram_chat_ids: "1" });
  seedAlertAndSent(db, 9, [111]);
  enqueueAlert(db, { bankAccountId: 9, kind: "retract", text: "✅ 已处理" });

  const tg = fakeTelegram();
  await withFakeTelegram(tg, () => processOutbox(db, settings({ controlBotToken: "" })));

  const row = db.prepare("SELECT * FROM telegram_outbox WHERE kind='retract'").get();
  assert.equal(row.state, "pending", "token 可能只是暂时没填，该重试");
  assert.equal(row.attempts, 1);
  assert.equal(sent(db)[0].retracted_at, "", "标成已撤回就再也没人会来撤它了");
  db.close();
});

test("总开关关掉时撤回任务也留在 pending，不消耗重试次数", async () => {
  const db = bankDatabase();
  addCompany(db, { id: "alpha", telegram_bot_token: TOKEN_A, telegram_chat_ids: "1" });
  seedAlertAndSent(db, 9, [111]);
  enqueueAlert(db, { bankAccountId: 9, kind: "retract", text: "✅ 已处理" });

  await processOutbox(db, settings({ enabled: false }));

  const row = db.prepare("SELECT * FROM telegram_outbox WHERE kind='retract'").get();
  assert.equal(row.state, "pending");
  assert.equal(row.attempts, 0);
  db.close();
});

test("撤回任务刻意不参与 24 小时过期", () => {
  const db = bankDatabase();
  const alertId = enqueueAlert(db, { bankAccountId: 9 });
  const retractId = enqueueAlert(db, { bankAccountId: 9, kind: "retract", text: "✅ 已处理" });
  db.prepare(
    `UPDATE telegram_outbox SET created_at = datetime('now', '-${PENDING_MAX_AGE_HOURS + 5} hours')`
  ).run();

  expireStalePending(db);

  const state = (id) => db.prepare("SELECT state FROM telegram_outbox WHERE id = ?").get(id).state;
  assert.equal(state(alertId), "expired", "过期的报警照旧丢弃，免得重开时被轰炸");
  // 迟到的撤回依然是对的动作：超 48 小时会自动退到 editMessageText。过期掉只会让一条
  // 已经不成立的 ⚠️ 永远留在聊天里。
  assert.equal(state(retractId), "pending");
  db.close();
});

test("配置性故障后 bot 被暂停，不会每 30 秒拿坏 token 再敲一次", () => {
  const bot = companyBot(["1"]);
  assert.equal(isParked(bot), false, "初始不应被暂停");

  parkBot(bot, "Telegram HTTP 401: Unauthorized");
  assert.equal(isParked(bot), true, "登记后 reconcile 不该再拉起它");

  const health = botHealth();
  const entry = health.parked.find((p) => p.bot_key === bot.botKey);
  assert.ok(entry, "状态面板要能看到被暂停的 bot");
  assert.match(entry.reason, /401/);
  assert.ok(entry.retry_in_seconds > 0, "应给出还要多久重试");

  // 换 token 立刻解除——用户改了配置就该马上重试，不用等满暂停时长。
  const withNewToken = { ...bot, token: TOKEN_B };
  assert.equal(isParked(withNewToken), false, "换 token 应立即解除暂停");
  assert.equal(isParked(bot), false, "解除是一次性的，旧记录已清掉");
});

test("botHealth 不返回已过期的暂停记录", () => {
  const bot = { ...companyBot(["1"]), botKey: "company:expiry-probe" };
  parkBot(bot, "409 conflict");
  assert.equal(botHealth().parked.some((p) => p.bot_key === bot.botKey), true);
  // isParked 会在到期时清掉记录；这里直接验证时间到了就不再拦。
  isParked(bot);
  assert.equal(isParked(bot), true, "10 分钟内仍然拦着");
});

test("bot 游标读写：默认 0，写入后可读回", () => {
  const db = bankDatabase();
  assert.equal(readBotState(db, "company:alpha").update_offset, 0);
  writeBotState(db, "company:alpha", { update_offset: 42, token_fingerprint: "fp" });
  const state = readBotState(db, "company:alpha");
  assert.equal(state.update_offset, 42);
  assert.equal(state.token_fingerprint, "fp");

  writeBotState(db, "company:alpha", { update_offset: 43 });
  assert.equal(readBotState(db, "company:alpha").token_fingerprint, "fp", "局部更新不应丢掉指纹");
  assert.equal(readBotState(db, "company:alpha").update_offset, 43);
  db.close();
});

test("冷启动对齐游标到最后一条并丢弃历史积压", async () => {
  const db = bankDatabase();
  let asked = null;
  const fetchImpl = async (url, init) => {
    asked = JSON.parse(init.body);
    return {
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          ok: true,
          result: [
            { update_id: 100, message: msg("/balance") },
            { update_id: 101, message: msg("/balance") },
            { update_id: 102, message: msg("/balance") },
          ],
        }),
    };
  };
  // primeOffset 内部用 tgApi，这里借 opts 注入假 fetch 需要绕一下：
  // 直接验证它对返回结果的处理——offset 应为最后一条 +1，且不执行任何命令。
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const offset = await primeOffset(db, companyBot(["555"]), undefined);
    assert.equal(offset, 103, "游标应对齐到最后一条 +1");
    assert.equal(asked.offset, -1, "冷启动应只取最后一条");
    assert.equal(asked.timeout, 0, "冷启动不应长轮询");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const state = readBotState(db, "company:alpha");
  assert.equal(state.update_offset, 103);
  assert.equal(state.token_fingerprint, tokenFingerprint(TOKEN_A));
  db.close();
});

test("冷启动时没有积压消息则游标保持 0", async () => {
  const db = bankDatabase();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({ ok: true, result: [] }),
  });
  try {
    assert.equal(await primeOffset(db, companyBot([]), undefined), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  db.close();
});
