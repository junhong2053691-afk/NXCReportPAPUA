// Telegram Bot 供应、long polling 与出站队列发送。
//
// 架构：每公司一个独立 Bot（token 存 companies 表，公司设置页可改）+ 一个总控 Bot
// （token、白名单与全局开关存 app_settings 表，「Telegram 设置」页可改）。两者都是
// 改完即时生效，不读 config.json、不用重启。公司 Bot 只看自己公司，总控 Bot 看全部
// 启用公司；两者共用同一套渲染与命令分发，差别只是 companies 数组。
//
// 刻意不挂进 scheduler.js 的 per-company lane：同步调度炸了不该拖垮 Bot，反之亦然。

const { getDb } = require("../db/init");
const { getTelegramSettings } = require("../lib/appSettings");
const {
  tgApi,
  sendMessage,
  deleteMessage,
  editMessageText,
  retractFailureKind,
  tokenFingerprint,
  isValidToken,
  sleep,
} = require("./telegram");
const { renderBalance, renderToday } = require("../lib/telegramRender");
// /blocked 的渲染与每周那份封禁汇总共用一套采集与版式，所以住在 bankCleanupReport。
// 顶层 require 安全：那个模块只顶层 require telegramRender（终点），对**本**模块的
// require 是惰性的（它函数体内取 scheduleFlush）。**那一条必须保持惰性**——改成顶层
// 就真成环了，谁先被加载谁拿到半个 exports。
const { renderBlocked } = require("../lib/bankCleanupReport");
const { escapeHtml, pre, renderTable } = require("../lib/telegramFormat");
const { appendAuditEvent } = require("../lib/auditLog");

const CONTROL_KEY = "control";
const MAX_SEND_ATTEMPTS = 3;

let stopped = true;
let generation = 0;
const running = new Map(); // botKey -> { generation, controller, fingerprint }
const timers = new Set();
let flushScheduled = false;

// ---------------------------------------------------------------- 配置解析

function parseChatIds(raw) {
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  return String(raw || "")
    .split(/[,;\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function isValidChatId(value) {
  return /^-?\d+$/.test(String(value || "").trim());
}

function listBotCompanies(db) {
  // 刻意不用 listEnabledCompanies：它还要求平台 API 凭证三项齐全，会漏掉「有银行账户
  // 但还没配 API」的公司，而那样的公司一样需要余额报警。
  return db.prepare("SELECT * FROM companies WHERE enabled = 1 ORDER BY sort_order ASC, id ASC").all();
}

/**
 * 算出当前「应该在跑」的 bot 集合。
 *
 * settings 来自 app_settings 表（后台「Telegram 设置」页），不再读 config.json。
 * 传 null 时自行读取，方便调用方省事。
 */
function resolveBots(db, settings) {
  const tg = settings || getTelegramSettings(db);
  const bots = [];
  // 总开关关掉时一个 bot 都不起——包括公司 bot。
  if (tg.enabled === false) return bots;

  const companies = listBotCompanies(db);
  const publicCompanies = companies.map((c) => ({ id: c.id, name: c.name || c.id }));

  for (const company of companies) {
    const token = String(company.telegram_bot_token || "").trim();
    if (!isValidToken(token)) continue;
    bots.push({
      botKey: "company:" + company.id,
      token,
      chatIds: parseChatIds(company.telegram_chat_ids),
      companies: [{ id: company.id, name: company.name || company.id }],
      label: company.name || company.id,
    });
  }

  // 总控 Bot 未配置不影响公司 Bot——公司 Bot 照常推送和响应命令。
  const controlToken = String(tg.controlBotToken || "").trim();
  if (isValidToken(controlToken)) {
    bots.push({
      botKey: CONTROL_KEY,
      token: controlToken,
      chatIds: parseChatIds(tg.controlChatIds),
      companies: publicCompanies,
      label: "总控",
      isControl: true,
    });
  }
  return bots;
}

function findBot(bots, botKey) {
  return bots.find((b) => b.botKey === botKey) || null;
}

// ---------------------------------------------------------------- 出站发送

function markOutbox(db, id, patch) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(id);
  db.prepare(`UPDATE telegram_outbox SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

function recordSendFailure(db, row, reason) {
  console.warn("[telegram] send failed:", row.bot_key, "outbox#" + row.id, reason);
  try {
    // appendAuditEvent 在 companyId 为空时会抛（auditLog.js:268），所以没有公司归属的
    // 行就只留 console.warn。metadata 里刻意不出现 token 相关字段。
    if (String(row.company_id || "").trim()) {
      appendAuditEvent(db, {
        companyId: row.company_id,
        action: "telegram.send_failed",
        source: "system",
        actor: { type: "system", name: "Telegram 报警" },
        summary: `Telegram 推送失败（outbox #${row.id}）`,
        metadata: {
          bot_key: row.bot_key,
          kind: row.kind,
          bank_account_id: row.bank_account_id,
          attempts: row.attempts + 1,
          reason: String(reason).slice(0, 500),
        },
        refs: row.bank_account_id ? [{ type: "bank_account", id: row.bank_account_id }] : [],
      });
    }
  } catch (e) {
    console.warn("[telegram] audit write failed:", e.message);
  }
}

/**
 * 记下真实发出的 message_id，供日后撤回（余额跌回阈值下时把这一轮报警从聊天里删掉）。
 *
 * 只记报警：撤回只为报警存在，cleanup 汇总和命令回复记下来只会让表白长。
 *
 * 整个包 try/catch 且绝不往外抛——落不了库最多是「以后撤不回」，**绝不能因此把已经发
 * 成功的消息判成失败**，那会让 deliver 走进重试分支再发一遍。
 */
function recordSent(db, row, bot, chatId, messageIds) {
  if (row.kind !== "alert" || !Number(row.bank_account_id) || !messageIds?.length) return;
  try {
    const stmt = db.prepare(
      `INSERT INTO telegram_sent_messages
        (outbox_id, company_id, bank_account_id, bot_key, chat_id, message_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const mid of messageIds) {
      stmt.run(
        Number(row.id),
        String(row.company_id || ""),
        Number(row.bank_account_id),
        bot.botKey,
        String(chatId),
        Number(mid)
      );
    }
  } catch (e) {
    console.warn("[telegram] record sent message:", e.message);
  }
}

/**
 * 发送一条出站消息。
 *
 * 权衡：一条消息可能有多个收件 chat，但我们不逐 chat 记录投递进度。如果第一个 chat 成功、
 * 第二个失败，下一轮重试会给第一个 chat 再发一遍。实际的失败模式（token 填错、网络断）
 * 是全有或全无的，而重复一条报警远好过漏掉一条。
 *
 * （这条权衡正是 telegram_sent_messages 必须是独立表的原因：真实消息数比收件人数多，
 * 撤回只能按真正记下的 message_id 逐条做。）
 */
async function deliver(db, row, bots, settings) {
  // 撤回不是「发文本」：收件人来自 telegram_sent_messages 里真实记下的 message_id，
  // 而不是 bot.chatIds。走独立一支，下面整段都不适用。
  if (row.kind === "retract") return deliverRetract(db, row, bots);

  const targets = [];
  const bot = findBot(bots, row.bot_key);
  if (bot) for (const chatId of bot.chatIds) targets.push({ bot, chatId });

  // 报警默认同时抄送总控 chat——总控 Bot 存在的意义就是一个地方看到全部。
  // 不想要就在后台「Telegram 设置」页关掉「报警抄送总控」。
  const mirror = settings?.mirrorAlertsToControl !== false;
  if (mirror && row.kind === "alert" && row.bot_key !== CONTROL_KEY) {
    const control = findBot(bots, CONTROL_KEY);
    if (control) for (const chatId of control.chatIds) targets.push({ bot: control, chatId });
  }

  if (!targets.length) {
    // 没有配收件人不是错误（比如这家公司还没填 chat id），标成 skipped 免得无限重试。
    markOutbox(db, row.id, { state: "skipped", last_error: "无收件 chat" });
    return;
  }

  const errors = [];
  for (const { bot, chatId } of targets) {
    try {
      // parse_mode 跟着行走：升级前积压在 pending 的老行是未转义的纯文本，
      // 一律按 HTML 发会让含 `&` 的银行名 400。
      const ids = await sendMessage(bot.token, chatId, row.text, {
        botKey: bot.botKey,
        parseMode: row.parse_mode || "",
      });
      recordSent(db, row, bot, chatId, ids);
    } catch (e) {
      // 分条时前半截可能已经发出去了，那几条一样要能撤回。
      recordSent(db, row, bot, chatId, e.messageIds);
      errors.push(`${bot.botKey}->${chatId}: ${e.message}`);
    }
  }

  if (!errors.length) {
    markOutbox(db, row.id, { state: "sent", sent_at: new Date().toISOString(), last_error: "" });
    return;
  }

  const reason = errors.join(" | ");
  const attempts = row.attempts + 1;
  const exhausted = attempts >= MAX_SEND_ATTEMPTS;
  markOutbox(db, row.id, {
    attempts,
    last_error: reason.slice(0, 1000),
    state: exhausted ? "failed" : "pending",
  });
  if (exhausted) recordSendFailure(db, row, reason);
}

/**
 * 执行一条撤回任务：把这一轮已经发出去的报警从聊天里删掉。
 *
 * 删不掉就改。Telegram 只允许机器人删**不足 48 小时**的消息，而钱隔两三天才处理的情况
 * 真实存在；editMessageText 没有时间限制，所以超时的退路是把原消息就地改成一行
 * 「✅ 已处理」，而不是放弃——留着一条已经不成立的 ⚠️ 挂在聊天里才是最坏的结果。
 */
async function deliverRetract(db, row, bots) {
  // 水位线 outbox_id < row.id：只撤「这次复位之前发出的」。自增 id 天然就是这条线，
  // 不需要任何显式的「轮次」字段。没有它的话，撤回任务失败重试期间余额又超标发了新警，
  // 下一轮重试会把那条新警一起删掉。
  let pending;
  try {
    pending = db
      .prepare(
        `SELECT * FROM telegram_sent_messages
         WHERE bank_account_id = ? AND retracted_at = '' AND outbox_id < ?
         ORDER BY id`
      )
      .all(Number(row.bank_account_id), Number(row.id));
  } catch (e) {
    markOutbox(db, row.id, { state: "failed", last_error: "读已发消息失败: " + e.message });
    return;
  }

  if (!pending.length) {
    // 幂等：没有挂着的消息（从没发出去 / 已经撤过）就算做完，不留重试。
    markOutbox(db, row.id, { state: "sent", sent_at: new Date().toISOString(), last_error: "" });
    return;
  }

  const done = (sent, method, error = "") => {
    try {
      db.prepare(
        `UPDATE telegram_sent_messages
         SET retracted_at = datetime('now'), retract_method = ?, retract_error = ?
         WHERE id = ?`
      ).run(method, String(error || "").slice(0, 300), sent.id);
    } catch (e) {
      console.warn("[telegram] mark retracted:", e.message);
    }
  };

  const errors = [];
  for (const sent of pending) {
    // 一条消息只有发它的那个 bot 删得掉。token 被清空 / 公司停用时找不到 bot——那是
    // 暂时的还是永久的我们分不出来，所以当失败重试，**绝不标成「撤过了」**：标错了
    // 就再也没人会来撤它。
    const bot = findBot(bots, sent.bot_key);
    if (!bot) {
      errors.push(`${sent.bot_key}->${sent.chat_id}: 找不到 bot`);
      continue;
    }
    try {
      await deleteMessage(bot.token, sent.chat_id, sent.message_id, { botKey: bot.botKey });
      done(sent, "delete");
      continue;
    } catch (e) {
      const kind = retractFailureKind(e);
      if (kind === "gone") {
        // 已经被人手删了。目的已达成。
        done(sent, "gone", e.description || e.message);
        continue;
      }
      if (kind !== "too_old") {
        errors.push(`${sent.bot_key}->${sent.chat_id}: ${e.message}`);
        continue;
      }
    }
    try {
      await editMessageText(bot.token, sent.chat_id, sent.message_id, row.text, {
        botKey: bot.botKey,
      });
      done(sent, "edit");
    } catch (e2) {
      const kind2 = retractFailureKind(e2);
      if (kind2 === "gone") done(sent, "gone", e2.description || e2.message);
      else if (kind2 === "not_modified") done(sent, "edit", e2.description || e2.message);
      // 删不掉也改不动：再试多少次都一样，记下来收尾，别让它一直占着队列。
      else if (kind2 === "unavailable") done(sent, "unavailable", e2.description || e2.message);
      else errors.push(`${sent.bot_key}->${sent.chat_id}: ${e2.message}`);
    }
  }

  if (!errors.length) {
    markOutbox(db, row.id, { state: "sent", sent_at: new Date().toISOString(), last_error: "" });
    return;
  }
  // 失败处理与 deliver 完全一致：耗尽重试就 failed，不无限重试。没撤掉的行留着
  // retracted_at = ''，下一次复位的撤回任务（水位线更高）会把它们再捞一次。
  const reason = errors.join(" | ");
  const attempts = row.attempts + 1;
  const exhausted = attempts >= MAX_SEND_ATTEMPTS;
  markOutbox(db, row.id, {
    attempts,
    last_error: reason.slice(0, 1000),
    state: exhausted ? "failed" : "pending",
  });
  if (exhausted) recordSendFailure(db, row, reason);
}

// 总开关关掉期间积压的消息，超过这个时长就不再补发。
// 没有它的话，关掉几天再打开会被几百条过期报警轰炸。
const PENDING_MAX_AGE_HOURS = 24;

function expireStalePending(db) {
  try {
    const info = db
      .prepare(
        `UPDATE telegram_outbox
         SET state = 'expired', last_error = '超过 ${PENDING_MAX_AGE_HOURS} 小时未发出'
         WHERE state = 'pending'
           -- 撤回任务刻意不过期。24 小时这条线是为了「关几天再打开别被几百条过期报警
           -- 轰炸」，而撤回不产生任何通知——迟到的撤回依然是对的动作（超 48 小时会自动
           -- 退到 editMessageText）。过期掉只会让一条已经不成立的 ⚠️ 永远留在聊天里。
           -- 不怕它永远躺着：失败 MAX_SEND_ATTEMPTS 次就进 failed。
           AND kind <> 'retract'
           AND created_at < datetime('now', '-${PENDING_MAX_AGE_HOURS} hours')`
      )
      .run();
    if (info.changes) console.warn("[telegram] expired", info.changes, "stale outbox row(s)");
  } catch (e) {
    console.warn("[telegram] expire stale:", e.message);
  }
}

/**
 * 出站队列处理的核心。与定时器 / 全局状态解耦，方便单测直接喂一个内存库。
 */
async function processOutbox(db, settings, shouldStop = () => false) {
  const tg = settings || getTelegramSettings(db);

  // 总开关关掉时**一行都不碰**。
  //
  // 千万不要走 deliver() 把它们标成 skipped：边沿触发状态 alert_fired_at 已经置位了，
  // 消息被丢掉之后余额继续超标也不会再报，那个账户就被永久静音了。留在 pending，
  // 重新打开时补发。
  if (tg.enabled === false) return 0;

  expireStalePending(db);

  let rows;
  try {
    rows = db
      .prepare("SELECT * FROM telegram_outbox WHERE state = 'pending' ORDER BY id LIMIT 50")
      .all();
  } catch (e) {
    console.warn("[telegram] flush: read outbox:", e.message);
    return 0;
  }
  if (!rows.length) return 0;

  const bots = resolveBots(db, tg);
  let handled = 0;
  for (const row of rows) {
    if (shouldStop()) break;
    try {
      await deliver(db, row, bots, tg);
      handled++;
    } catch (e) {
      console.warn("[telegram] deliver:", e.message);
    }
  }
  return handled;
}

async function flushOutbox() {
  if (stopped) return;
  let db;
  try {
    db = getDb();
  } catch (e) {
    console.warn("[telegram] flush: db unavailable:", e.message);
    return;
  }
  await processOutbox(db, getTelegramSettings(db), () => stopped);
}

/** 报警写入 outbox 后立刻触发一次发送，正常延迟 <100ms；定时轮询只作兜底与重试。 */
function scheduleFlush() {
  if (stopped || flushScheduled) return;
  flushScheduled = true;
  setImmediate(async () => {
    flushScheduled = false;
    try {
      await flushOutbox();
    } catch (e) {
      console.warn("[telegram] flush:", e.message);
    }
  });
}

// ---------------------------------------------------------------- 命令分发

/** 拆出命令与参数：`/balance@my_bot rolex66` → `{ command: "/balance", arg: "rolex66" }`。 */
function parseCommand(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith("/")) return null;
  const first = raw.split(/\s+/)[0];
  return {
    // 群里 Telegram 会自动把命令写成 /balance@my_bot
    command: first.split("@")[0].toLowerCase(),
    arg: raw.slice(first.length).trim(),
  };
}

const ALL_ARGS = new Set(["all", "全部", "所有"]);

/**
 * 把参数解析成一家公司。**只在 bot.companies 里找**——公司 Bot 不能靠传参数越权查别家。
 *
 * 依次尝试：id 精确、公司名精确（不分大小写）、唯一前缀匹配。
 * 返回 null 表示没认出来（调用方负责提示可用名字）。
 */
function resolveCompanyArg(companies, arg) {
  const needle = String(arg || "").trim().toLowerCase();
  if (!needle) return null;
  const exactId = companies.find((c) => String(c.id).toLowerCase() === needle);
  if (exactId) return exactId;
  const exactName = companies.find((c) => String(c.name || "").toLowerCase() === needle);
  if (exactName) return exactName;
  const prefixed = companies.filter(
    (c) =>
      String(c.id).toLowerCase().startsWith(needle) ||
      String(c.name || "").toLowerCase().startsWith(needle)
  );
  return prefixed.length === 1 ? prefixed[0] : null;
}

function isAuthorized(bot, chatId) {
  return bot.chatIds.includes(String(chatId));
}

/**
 * /balance /today /blocked 的参数规矩完全一样：不带参数按 bot 的公司数决定概要/明细，
 * `all` 强制全展开，其余当公司名解析。
 *
 * 抽出来是为了第三、第四条命令不必再抄一遍——三份一样的五行里只要有一份忘了跟着改，
 * 就会出现「某条命令能靠传参越权查别家」这种 bug。
 */
function renderForArg(db, bot, arg, render) {
  if (!arg) return render(db, bot.companies);
  if (ALL_ARGS.has(arg.toLowerCase())) return render(db, bot.companies, { detail: true });
  const company = resolveCompanyArg(bot.companies, arg);
  if (company) return render(db, [company], { detail: true });
  const names = bot.companies.map((c) => c.id).join(" / ") || "（无）";
  return [`没找到公司「${escapeHtml(arg)}」。可用：${escapeHtml(names)}`];
}

// 命令 → 渲染器。做成表而不是 if-else 链：新增命令只要在这里和 /help 的 rows 里各加
// 一行，不会漏掉上面那五行参数解析。
const COMMAND_RENDERERS = {
  "/balance": renderBalance,
  "/today": renderToday,
  "/blocked": renderBlocked,
};

/**
 * 处理一条消息，返回要回复的文本块数组（空数组 = 静默丢弃）。
 * 纯函数式：不自己发消息，方便单测。
 */
function handleMessage(db, bot, message) {
  const chatId = message?.chat?.id;
  if (chatId == null) return [];
  const parsed = parseCommand(message.text);
  if (!parsed) return [];
  const { command, arg } = parsed;

  // /myid 在鉴权之前处理：任何人可用，只回显调用者自己的 chat id，不含任何业务数据。
  // 这是首次配置时拿到 chat id 的唯一办法。<code> 让它在 Telegram 里点一下就能复制。
  if (command === "/myid" || command === "/start") {
    return [
      "本聊天的 chat id：",
      "<code>" + escapeHtml(String(chatId)) + "</code>",
      "把它填进后台「公司 / API」页对应公司的 Telegram 收件 chat，即可接收余额报警。",
    ];
  }

  // 其余命令：不在白名单一律静默丢弃，不给探测者任何反馈。
  if (!isAuthorized(bot, chatId)) {
    console.log("[telegram] ignored command from unauthorized chat", chatId, "on", bot.botKey);
    return [];
  }

  const render = COMMAND_RENDERERS[command];
  if (render) return renderForArg(db, bot, arg, render);

  if (command === "/help") {
    const example = bot.companies[0]?.id || "<公司>";
    const rows = [
      // /balance 的语义比以前窄了（封禁整组移去了 /blocked），而 /help 是唯一会告诉
      // 人这件事的地方，所以描述里那个「在跑」不是废话。
      { cmd: "/balance", desc: "渠道余额（在跑）" },
      { cmd: "/balance " + example, desc: "指定公司明细" },
      { cmd: "/balance all", desc: "全部公司明细" },
      { cmd: "/blocked", desc: "封禁渠道余额" },
      { cmd: "/blocked " + example, desc: "指定公司明细" },
      { cmd: "/today", desc: "今日业绩" },
      { cmd: "/today " + example, desc: "指定公司明细" },
      { cmd: "/myid", desc: "本聊天的 chat id" },
    ];
    const { lines } = renderTable(
      rows,
      [
        { key: "cmd", align: "left", min: 12 },
        { key: "desc", align: "left" },
      ],
      { maxWidth: 40, gap: 2 }
    );
    return ["可用命令", pre(lines)];
  }
  return [];
}

// ---------------------------------------------------------------- long polling

function readBotState(db, botKey) {
  return (
    db.prepare("SELECT * FROM telegram_bot_state WHERE bot_key = ?").get(botKey) || {
      bot_key: botKey,
      update_offset: 0,
      token_fingerprint: "",
      last_error: "",
    }
  );
}

function writeBotState(db, botKey, patch) {
  const current = readBotState(db, botKey);
  const next = { ...current, ...patch };
  db.prepare(
    `INSERT INTO telegram_bot_state (bot_key, update_offset, token_fingerprint, last_error, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(bot_key) DO UPDATE SET
       update_offset = excluded.update_offset,
       token_fingerprint = excluded.token_fingerprint,
       last_error = excluded.last_error,
       updated_at = datetime('now')`
  ).run(
    botKey,
    Number(next.update_offset || 0),
    String(next.token_fingerprint || ""),
    String(next.last_error || "")
  );
}

/**
 * 冷启动时把游标对齐到「最后一条」并丢弃历史。
 *
 * 否则服务停机期间攒下的几百条消息会在启动瞬间被全部执行一遍。token 换掉时
 * update_id 的序列也会变，所以指纹不匹配同样要重走这一步。
 */
async function primeOffset(db, bot, signal) {
  const updates = await tgApi(
    bot.token,
    "getUpdates",
    { offset: -1, timeout: 0, allowed_updates: ["message"] },
    { botKey: bot.botKey, signal, timeoutMs: 15000 }
  );
  const last = Array.isArray(updates) && updates.length ? updates[updates.length - 1] : null;
  const offset = last ? Number(last.update_id) + 1 : 0;
  writeBotState(db, bot.botKey, {
    update_offset: offset,
    token_fingerprint: tokenFingerprint(bot.token),
    last_error: "",
  });
  return offset;
}

// 命令回复。渲染层产出的块自带闭合的 <pre>，所以这里统一用 HTML 模式发；
// 万一解析失败，sendMessage 会自动降级成纯文本重发一次。
async function replyBlocks(bot, chatId, blocks) {
  await sendMessage(bot.token, chatId, blocks, { botKey: bot.botKey, parseMode: "HTML" });
}

async function pollOnce(db, bot, state, signal, settings) {
  // settings 已经由 appSettings 钳制在 5–50s，这里不用再夹一次。
  const timeoutSec = Number(settings?.pollTimeoutSeconds) || 30;
  const updates = await tgApi(
    bot.token,
    "getUpdates",
    { offset: state.update_offset, timeout: timeoutSec, allowed_updates: ["message"] },
    // abort 必须比服务端 timeout 长，否则每次正常的长轮询都会被自己掐断。
    { botKey: bot.botKey, signal, timeoutMs: timeoutSec * 1000 + 15000 }
  );
  if (!Array.isArray(updates) || !updates.length) return state.update_offset;

  for (const update of updates) {
    const message = update.message;
    if (!message) continue;
    let blocks = [];
    try {
      blocks = handleMessage(db, bot, message);
    } catch (e) {
      console.warn("[telegram] command error:", bot.botKey, e.message);
      blocks = isAuthorized(bot, message.chat?.id) ? ["查询失败，请稍后重试。"] : [];
    }
    if (!blocks.length) continue;
    try {
      await replyBlocks(bot, message.chat.id, blocks);
    } catch (e) {
      console.warn("[telegram] reply failed:", bot.botKey, e.message);
    }
  }

  // 处理完整批才推进游标：崩溃会重放最后一批，而所有命令都是只读的，重复无害；
  // 反过来「先存后处理」会静默吞掉命令，那才是真损失。
  const maxId = Math.max(...updates.map((u) => Number(u.update_id) || 0));
  const next = maxId + 1;
  writeBotState(db, bot.botKey, { update_offset: next, last_error: "" });
  return next;
}

function startBotLoop(bot, myGeneration) {
  const controller = new AbortController();
  running.set(bot.botKey, {
    generation: myGeneration,
    controller,
    fingerprint: tokenFingerprint(bot.token),
  });

  let backoffMs = 0;
  const alive = () => !stopped && running.get(bot.botKey)?.generation === myGeneration;

  const loop = async () => {
    console.log("[telegram] polling started:", bot.botKey);
    while (alive()) {
      try {
        const db = getDb();
        const settings = getTelegramSettings(db);
        let state = readBotState(db, bot.botKey);
        const fingerprint = tokenFingerprint(bot.token);
        if (!state.update_offset || state.token_fingerprint !== fingerprint) {
          await primeOffset(db, bot, controller.signal);
          state = readBotState(db, bot.botKey);
        }
        await pollOnce(db, bot, state, controller.signal, settings);
        backoffMs = 0;
      } catch (e) {
        if (!alive()) break;
        if (e.code === "TELEGRAM_ABORTED") break;
        if (e.code === "TELEGRAM_FATAL") {
          // token 无效 / 被踢出群 / 另一个消费者在抢 getUpdates。重试没有意义。
          //
          // 光 break 不够：reconcileBots 每 30s 发现「该跑的 bot 没在跑」就又拉起来，
          // 等于拿坏 token 每 30 秒敲一次 Telegram，永远不停（platform.js 里警告过
          // 重试会延长封禁）。所以要登记到 parked，让 reconcile 认得它。
          parkBot(bot, e.message);
          try {
            writeBotState(getDb(), bot.botKey, { last_error: String(e.message).slice(0, 500) });
          } catch (_) {}
          break;
        }
        backoffMs = Math.min(60000, backoffMs ? backoffMs * 2 : 1000);
        console.warn("[telegram] poll error:", bot.botKey, e.message, "- retry in", backoffMs + "ms");
        await sleep(backoffMs);
      }
    }
    if (running.get(bot.botKey)?.generation === myGeneration) running.delete(bot.botKey);
    console.log("[telegram] polling stopped:", bot.botKey);
  };

  loop().catch((e) => console.warn("[telegram] loop crashed:", bot.botKey, e.message));
}

// ---------------------------------------------------------------- 故障隔离

// 遇到配置性故障（401 token 无效 / 403 被踢出群 / 409 有别的消费者在抢）后暂停多久
// 再试一次。不做成永久停用是因为 403/409 可能被对面修好（重新拉进群、关掉重复进程），
// 而 token 没变我们就没有别的信号知道它好了；10 分钟一次比 30 秒一次温和 20 倍，
// 又仍然能自愈。换 token 会立刻解除，不用等。
const PARK_MS = 10 * 60 * 1000;
const parked = new Map(); // botKey -> { fingerprint, reason, until }

function parkBot(bot, reason) {
  const until = Date.now() + PARK_MS;
  parked.set(bot.botKey, {
    fingerprint: tokenFingerprint(bot.token),
    reason: String(reason || "").slice(0, 300),
    until,
  });
  console.warn(
    "[telegram] fatal, loop parked:",
    bot.botKey,
    reason,
    "- 暂停",
    Math.round(PARK_MS / 60000) + " 分钟（换 token 会立即重试）"
  );
}

/** 这个 bot 当前是否处于「别再敲了」状态。token 变了或时间到了就解除。 */
function isParked(bot) {
  const entry = parked.get(bot.botKey);
  if (!entry) return false;
  if (entry.fingerprint !== tokenFingerprint(bot.token)) {
    parked.delete(bot.botKey);
    return false;
  }
  if (Date.now() >= entry.until) {
    parked.delete(bot.botKey);
    return false;
  }
  return true;
}

/** 当前 bot 的运行 / 暂停情况，给后台状态面板用。 */
function botHealth() {
  const now = Date.now();
  return {
    running: [...running.keys()].sort(),
    parked: [...parked.entries()]
      .filter(([, p]) => p.until > now)
      .map(([botKey, p]) => ({
        bot_key: botKey,
        reason: p.reason,
        retry_in_seconds: Math.max(0, Math.round((p.until - now) / 1000)),
      })),
  };
}

// ---------------------------------------------------------------- 热更新

/**
 * 对比「应该在跑的 bot」与「正在跑的 bot」，启动新增的、停掉消失或换了 token 的。
 * 公司设置页保存后会直接调它，所以改配置无需重启。
 */
function reconcileBots() {
  if (stopped) return;
  let db;
  let settings;
  try {
    db = getDb();
    settings = getTelegramSettings(db);
  } catch (e) {
    console.warn("[telegram] reconcile:", e.message);
    return;
  }

  let desired;
  try {
    desired = resolveBots(db, settings);
  } catch (e) {
    console.warn("[telegram] resolve bots:", e.message);
    return;
  }
  const desiredKeys = new Set(desired.map((b) => b.botKey));

  for (const [botKey, entry] of [...running.entries()]) {
    if (!desiredKeys.has(botKey)) {
      running.delete(botKey);
      entry.controller.abort(); // 掐断在飞的长轮询，1 秒内生效而不是等满一轮
    }
  }

  for (const bot of desired) {
    const entry = running.get(bot.botKey);
    if (entry && entry.fingerprint === tokenFingerprint(bot.token)) continue;
    // 上一轮因为配置性故障（401/403/409）停掉的，别每 30 秒拉起来再挨一次拒绝。
    if (!entry && isParked(bot)) continue;
    if (entry) {
      running.delete(bot.botKey);
      entry.controller.abort();
    }
    startBotLoop(bot, ++generation);
  }
}

/**
 * 按当前设置（重）建定时器。间隔进了后台设置页，所以保存后必须能重建，否则改了
 * 间隔要重启服务才生效——那正是这次要消灭的东西。
 */
function applyTimers(settings) {
  const tg = settings || (() => {
    try {
      return getTelegramSettings(getDb());
    } catch (_) {
      return null;
    }
  })();
  const flushSec = Number(tg?.outboxFlushSeconds) || 5;
  const reconcileSec = Number(tg?.reconcileSeconds) || 30;

  for (const t of timers) clearInterval(t);
  timers.clear();
  if (stopped) return;

  const flushTimer = setInterval(() => {
    flushOutbox().catch((e) => console.warn("[telegram] flush:", e.message));
  }, flushSec * 1000);
  const reconcileTimer = setInterval(reconcileBots, reconcileSec * 1000);
  timers.add(flushTimer);
  timers.add(reconcileTimer);
  console.log("[telegram] timers — flush", flushSec + "s / reconcile", reconcileSec + "s");
}

/** 后台保存设置后调用：重建定时器并立刻按新配置调整 bot 集合。 */
function applySettings(settings) {
  if (stopped) return;
  // 人工点了保存就当作「我修好了」：清掉暂停状态立刻重试一次，而不是让他等满 10 分钟。
  // 403（被踢出群）/ 409（有别的进程在抢）这类故障往往是在 Telegram 那边修的，token
  // 没变，光靠指纹比对察觉不到。
  parked.clear();
  applyTimers(settings);
  reconcileBots();
}

function startTelegram() {
  stopped = false;
  parked.clear();
  reconcileBots();
  applyTimers(null);
  console.log("[telegram] started");
}

function stopTelegram() {
  stopped = true;
  for (const t of timers) clearInterval(t);
  timers.clear();
  for (const entry of running.values()) entry.controller.abort();
  running.clear();
  parked.clear();
}

module.exports = {
  startTelegram,
  stopTelegram,
  applySettings,
  applyTimers,
  reconcileBots,
  botHealth,
  parkBot,
  isParked,
  scheduleFlush,
  flushOutbox,
  processOutbox,
  expireStalePending,
  deliver,
  PENDING_MAX_AGE_HOURS,
  resolveBots,
  handleMessage,
  parseCommand,
  resolveCompanyArg,
  parseChatIds,
  isValidChatId,
  readBotState,
  writeBotState,
  primeOffset,
  CONTROL_KEY,
};
