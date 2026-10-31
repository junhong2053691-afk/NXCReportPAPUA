// Telegram Bot API 客户端。
//
// 骨架照抄 services/platform.js:89-157 的「AbortController 超时 + 指数退避 + 按 key
// 哈希抖动」，刻意不引入 axios 或任何 bot SDK —— 本项目只有 4 个依赖，用 Node 20+ 的
// 原生 fetch 就够。
//
// 与 platform.js 的两处差异：
//   1. Telegram 的 429 会带 parameters.retry_after（秒），必须尊重这个值而不是用固定
//      梯度，否则会被继续限流。
//   2. 401/403/409 是不可重试的配置错误（token 无效 / 被踢出群 / 另一个消费者在抢
//      getUpdates），照 platform.js 对 ACCESS_DENIED 的做法 fail-fast。

const { stripHtml } = require("../lib/telegramFormat");

const API_ROOT = "https://api.telegram.org";
const MAX_ATTEMPTS = 4;
const DEFAULT_TIMEOUT_MS = 20000;

// Telegram 单条消息上限 4096 字符。留出页脚和多字节 emoji 的余量。
const MAX_MESSAGE_CHARS = 3900;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function retryJitterMs(key) {
  const text = String(key || "");
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash % 450;
}

// token 形如 "123456789:AA...."。只暴露 bot id 和尾段短哈希，绝不落明文。
function tokenFingerprint(token) {
  const t = String(token || "");
  if (!t) return "";
  const botId = t.split(":")[0] || "?";
  let hash = 0;
  for (let i = 0; i < t.length; i++) hash = (hash * 31 + t.charCodeAt(i)) >>> 0;
  return botId + ":" + hash.toString(36);
}

function isValidToken(token) {
  return /^\d+:[\w-]{20,}$/.test(String(token || "").trim());
}

// 把错误原文里任何 bot token 形状的字符串抹掉，再截断。
// 用在「要把内部错误展示给人看」的地方（后台状态面板、日志）。当前的错误构造路径
// 不会写进 token，但展示原始错误不能靠「当前恰好安全」。
function sanitizeErrorText(text, limit = 300) {
  return String(text == null ? "" : text)
    .replace(/\d{6,}:[\w-]{20,}/g, "***")
    .slice(0, limit);
}

// 配置错误，重试没有意义。
const FATAL_STATUS = new Set([401, 403, 404, 409]);

// parse_mode 解析失败。400 本身可能是暂时性的（比如 chat 状态），所以不整个进
// FATAL_STATUS；但这一类 400 是确定性的，重试 4 次只是白等 5 秒，识别出来立刻交给
// sendMessage 降级成纯文本重发。
const PARSE_ERROR_RE = /can'?t parse entities|can not parse entities|unsupported start tag|unclosed/i;

// 删除 / 编辑消息的「确定性 400」。同理不整个把 400 当 fatal，但这几种描述重试多少次
// 结果都一样：消息被人手删过、超过了 Telegram 允许机器人删自己消息的 48 小时、或者新
// 正文和旧的一模一样。识别出来立刻交回调用方决定退路（见 retractFailureKind）。
const DETERMINISTIC_400_RE =
  /message to delete not found|message to edit not found|message can'?t be deleted|message can'?t be edited|message is not modified|message identifier is not specified/i;

function fatalError(status, description) {
  const err = new Error("Telegram HTTP " + status + ": " + (description || ""));
  err.code = "TELEGRAM_FATAL";
  err.status = status;
  return err;
}

/**
 * 调用一个 Bot API 方法。
 * @param {string} token   bot token
 * @param {string} method  例如 "sendMessage" / "getUpdates"
 * @param {object} payload JSON body
 * @param {object} opts    { timeoutMs, signal, fetchImpl, botKey }
 */
async function tgApi(token, method, payload = {}, opts = {}, attempt = 1) {
  if (!isValidToken(token)) {
    throw fatalError(401, "token 缺失或格式不合法");
  }
  // fetchImpl 可注入，让超时 / 退避 / 401 / 429 阶梯可以单测。
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  const botKey = opts.botKey || tokenFingerprint(token);
  const url = `${API_ROOT}/bot${token}/${method}`;

  let status = 0;
  let json = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // 调用方（轮询循环）可以用自己的 signal 提前掐断在飞的请求，用于热更新时立刻停掉
    // 旧 token 的长轮询，而不必等满一个 timeout。
    const onAbort = () => controller.abort();
    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      status = res.status;
      const text = await res.text();
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    }
  } catch (netErr) {
    if (opts.signal && opts.signal.aborted) {
      const err = new Error("aborted by caller");
      err.code = "TELEGRAM_ABORTED";
      throw err;
    }
    const timedOut = netErr && netErr.name === "AbortError";
    const cause = netErr?.cause?.code || netErr?.cause?.message || "";
    const reason = timedOut
      ? "timeout after " + timeoutMs + "ms"
      : [netErr.message || String(netErr), cause].filter(Boolean).join(" cause=");
    if (attempt < MAX_ATTEMPTS) {
      await sleep(Math.min(600 * attempt, 3000) + retryJitterMs(botKey));
      return tgApi(token, method, payload, opts, attempt + 1);
    }
    throw new Error("telegram " + method + " network error: " + reason);
  }

  if (json && json.ok) return json.result;

  const description = (json && (json.description || json.error_code)) || "HTTP " + status;

  if (FATAL_STATUS.has(status)) throw fatalError(status, description);

  if (status === 400 && PARSE_ERROR_RE.test(String(description))) {
    const err = new Error("telegram " + method + " parse error: " + description);
    err.code = "TELEGRAM_PARSE_ERROR";
    err.status = 400;
    throw err;
  }

  if (status === 400 && DETERMINISTIC_400_RE.test(String(description))) {
    const err = new Error("telegram " + method + ": " + description);
    err.code = "TELEGRAM_BAD_REQUEST";
    err.status = 400;
    err.description = String(description);
    throw err;
  }

  // 429：尊重 Telegram 给的 retry_after，别用自己的梯度。
  if (status === 429) {
    const retryAfter = Number(json?.parameters?.retry_after || 1);
    if (attempt < MAX_ATTEMPTS) {
      await sleep(Math.min(retryAfter, 60) * 1000 + retryJitterMs(botKey));
      return tgApi(token, method, payload, opts, attempt + 1);
    }
    const err = new Error("telegram " + method + " rate limited: " + description);
    err.code = "TELEGRAM_RATE_LIMIT";
    throw err;
  }

  if (attempt < MAX_ATTEMPTS) {
    await sleep(900 * attempt + retryJitterMs(botKey));
    return tgApi(token, method, payload, opts, attempt + 1);
  }
  throw new Error("telegram " + method + " failed: " + description);
}

/**
 * 把文本切成若干条不超过上限的消息。
 *
 * 输入可以是字符串，也可以是「块」数组（例如每公司一节）——块是优先的切分边界，
 * 装得下就整块放进当前条。块本身超长时退化为按行切，绝不在一行中间断开；单行超长
 * （理论上不该发生）才硬切。
 *
 * ⚠️ 用 HTML parse_mode 时，**每个块必须自带成对闭合的标签**且自身不超上限：按行切会
 * 把 <pre> 切成两半，Telegram 直接返回 400。渲染层负责这个保证（telegramRender.js 的
 * splitSection / MAX_BLOCK_CHARS），这里不做标签感知。
 */
// "\n\n（第 999/999 条）" 共 15 字符，留 16 够用。页脚空间必须在装箱时就预留——事后
// 裁剪正文会把一行切断，那正是按行切要避免的。
const FOOTER_RESERVE = 16;

function packBlocks(blocks, limit) {
  const out = [];
  let current = "";

  const push = () => {
    if (current.length) out.push(current);
    current = "";
  };
  const appendPiece = (piece, separator) => {
    const candidate = current.length ? current + separator + piece : piece;
    if (candidate.length <= limit) {
      current = candidate;
      return true;
    }
    return false;
  };

  for (const block of blocks) {
    const text = String(block);
    if (appendPiece(text, "\n\n")) continue;
    push();
    if (text.length <= limit) {
      current = text;
      continue;
    }
    // 整块放不下：按行切。
    for (const line of text.split("\n")) {
      if (appendPiece(line, "\n")) continue;
      push();
      if (line.length <= limit) {
        current = line;
        continue;
      }
      // 单行超长：硬切（理论上不该发生）。
      for (let i = 0; i < line.length; i += limit) {
        const slice = line.slice(i, i + limit);
        if (i + limit < line.length) out.push(slice);
        else current = slice;
      }
    }
  }
  push();
  return out;
}

function chunkMessage(input, limit = MAX_MESSAGE_CHARS) {
  const blocks = Array.isArray(input) ? input.filter((b) => String(b || "").length) : [String(input || "")];
  if (!blocks.length) return [];

  // 先按完整上限试一次。只出一条就不需要页脚，正文可以用满。
  const single = packBlocks(blocks, limit);
  if (single.length <= 1) return single;

  // 要分条，就得给页脚留位置，重新装一次箱。
  const parts = packBlocks(blocks, Math.max(1, limit - FOOTER_RESERVE));
  if (parts.length <= 1) return parts;
  return parts.map((part, i) => part + `\n\n（第 ${i + 1}/${parts.length} 条）`);
}

/**
 * 发送一条（可能被切成多条）消息。
 *
 * `opts.parseMode` 传 "HTML" 时用 HTML 模式发（排版需要 <pre> 等宽块，见
 * lib/telegramFormat.js）。选 HTML 而不是 Markdown：HTML 只要转义 `&` `<` `>` 三个
 * 字符，而 Markdown 得躲 `_` `*` `[` 等一长串、规则还随 v1/v2 变——银行名和户名里那些
 * 字符随时会出现。
 *
 * 即便如此仍然保留一层降级：解析失败就去掉标签、不带 parse_mode 重发一次。报警消息掉
 * 一条等于那个账户被永久静音（alert_fired_at 已置位，只有跌回阈值下才复位），不能只靠
 * 「我们转义对了」这个假设。
 */
async function sendMessage(token, chatId, text, opts = {}) {
  const parts = chunkMessage(text, opts.limit || MAX_MESSAGE_CHARS);
  const parseMode = String(opts.parseMode || "");
  // 返回真实发出的 message_id：余额跌回阈值下时要凭它把这一轮报警从聊天里撤回
  // （telegramBots.deliver 落进 telegram_sent_messages）。
  const messageIds = [];
  const take = (result) => {
    const id = Number(result?.message_id || 0);
    if (id) messageIds.push(id);
  };
  for (let i = 0; i < parts.length; i++) {
    const payload = { chat_id: chatId, text: parts[i], disable_web_page_preview: true };
    if (parseMode) payload.parse_mode = parseMode;
    try {
      take(await tgApi(token, "sendMessage", payload, opts));
    } catch (e) {
      if (e.code !== "TELEGRAM_PARSE_ERROR") {
        // 分条时前半截可能已经发出去了。那几条照样要能被撤回，否则会永远留在聊天里，
        // 所以把已拿到的 id 挂在错误上交给调用方。
        e.messageIds = messageIds;
        throw e;
      }
      console.warn("[telegram] parse error, falling back to plain text:", e.message);
      // id 必须取自真正成功的那一次。
      take(
        await tgApi(
          token,
          "sendMessage",
          { chat_id: chatId, text: stripHtml(parts[i]), disable_web_page_preview: true },
          opts
        )
      );
    }
    // Telegram 单聊约 1 msg/s，多条之间留间隔。
    if (i < parts.length - 1) await sleep(350);
  }
  return messageIds;
}

/**
 * 撤回一条报警。只有发它的那个 bot 删得掉。
 *
 * ⚠️ Telegram 只允许机器人删除**不足 48 小时**的消息，这条限制对「删自己发的消息」同样
 * 适用。超时的退路是 editMessageText（见下），不是放弃。
 */
function deleteMessage(token, chatId, messageId, opts = {}) {
  return tgApi(token, "deleteMessage", { chat_id: chatId, message_id: Number(messageId) }, opts);
}

/**
 * 就地改写一条已发出的消息。编辑没有时间限制，所以它是删不掉时的兜底。
 *
 * 刻意**不带 parse_mode**：撤回后留下的那一行没有要对齐的东西，纯文本就不必操心渠道名
 * 里的 `&` `<`，也不会掉进 sendMessage 那条解析失败降级的路。
 */
function editMessageText(token, chatId, messageId, text, opts = {}) {
  return tgApi(
    token,
    "editMessageText",
    { chat_id: chatId, message_id: Number(messageId), text: String(text) },
    opts
  );
}

/**
 * 把一次撤回失败归类。Telegram 的错误措辞归本模块管，拿它做什么归调用方管。
 *
 *   "gone"         消息已经不在了（被人手删过）——目的已达成，当成功
 *   "too_old"      删不掉（超过 48 小时 / 没有删除权限）——退到 editMessageText
 *   "not_modified" 正文没变化——上一次编辑其实成功了，当成功
 *   "unavailable"  连编辑都不行——再试多少次都一样，收尾别占着队列
 *   null           网络 / 429 / 5xx / 403 等真失败——交回去重试
 */
function retractFailureKind(err) {
  if (!err || err.code !== "TELEGRAM_BAD_REQUEST") return null;
  const d = String(err.description || err.message);
  if (/not found|identifier is not specified/i.test(d)) return "gone";
  if (/is not modified/i.test(d)) return "not_modified";
  if (/can'?t be deleted/i.test(d)) return "too_old";
  if (/can'?t be edited/i.test(d)) return "unavailable";
  return null;
}

module.exports = {
  tgApi,
  sendMessage,
  deleteMessage,
  editMessageText,
  retractFailureKind,
  chunkMessage,
  tokenFingerprint,
  isValidToken,
  sanitizeErrorText,
  retryJitterMs,
  sleep,
  MAX_MESSAGE_CHARS,
};
