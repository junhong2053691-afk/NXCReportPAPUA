const test = require("node:test");
const assert = require("node:assert/strict");

const {
  tgApi,
  sendMessage,
  deleteMessage,
  editMessageText,
  retractFailureKind,
  chunkMessage,
  tokenFingerprint,
  isValidToken,
  sanitizeErrorText,
  MAX_MESSAGE_CHARS,
} = require("../services/telegram");

const TOKEN = "123456789:AAEEaaBBccDDeeFFggHHiiJJkkLLmmNNoo";

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  };
}

// 记录每次调用，并按脚本依次返回响应。
function scriptedFetch(script) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    if (typeof next === "function") return next();
    return next;
  };
  impl.calls = calls;
  return impl;
}

test("sendMessage：parseMode 传下去，不传就不带 parse_mode", async () => {
  const plain = scriptedFetch([jsonResponse(200, { ok: true, result: {} })]);
  await sendMessage(TOKEN, 1, "hi", { fetchImpl: plain });
  assert.equal(plain.calls[0].body.parse_mode, undefined, "纯文本消息不该带 parse_mode");

  const html = scriptedFetch([jsonResponse(200, { ok: true, result: {} })]);
  await sendMessage(TOKEN, 1, "<pre>hi</pre>", { fetchImpl: html, parseMode: "HTML" });
  assert.equal(html.calls[0].body.parse_mode, "HTML");
});

test("sendMessage：解析失败立刻降级成纯文本重发，不消耗重试梯度", async () => {
  // 报警掉一条 = 那个账户被永久静音（alert_fired_at 已置位），所以必须有这层兜底。
  const fetchImpl = scriptedFetch([
    jsonResponse(400, { ok: false, description: "Bad Request: can't parse entities: unsupported start tag" }),
    jsonResponse(200, { ok: true, result: {} }),
  ]);
  const started = Date.now();
  await sendMessage(TOKEN, 1, "<pre>A & B</pre>", { fetchImpl, parseMode: "HTML" });

  assert.equal(fetchImpl.calls.length, 2, "解析失败是确定性的，不该退避重试 4 次");
  assert.ok(Date.now() - started < 1000, "不该在这上面白等退避时间");
  assert.equal(fetchImpl.calls[1].body.parse_mode, undefined, "重发必须去掉 parse_mode");
  assert.equal(fetchImpl.calls[1].body.text, "A & B", "标签去掉、实体反转义");
});

test("sendMessage：非解析类的 400 仍然照常退避重试后抛出", async () => {
  const fetchImpl = scriptedFetch([jsonResponse(400, { ok: false, description: "Bad Request: chat not found" })]);
  await assert.rejects(
    () => sendMessage(TOKEN, 1, "<pre>hi</pre>", { fetchImpl, parseMode: "HTML" }),
    /chat not found/
  );
  assert.ok(fetchImpl.calls.length > 1, "普通 400 可能是暂时的，该重试");
});

// 以下三条守着「复位时能把这一轮报警撤回」的前提：没有 message_id 就撤不回，
// 而撤不回的那条 ⚠️ 会永远挂在聊天里误导人。

test("sendMessage 返回真实 message_id，分条时每条一个", async () => {
  const one = scriptedFetch([jsonResponse(200, { ok: true, result: { message_id: 42 } })]);
  assert.deepEqual(await sendMessage(TOKEN, 1, "hi", { fetchImpl: one }), [42]);

  const many = scriptedFetch([
    jsonResponse(200, { ok: true, result: { message_id: 7 } }),
    jsonResponse(200, { ok: true, result: { message_id: 8 } }),
  ]);
  const long = "x".repeat(MAX_MESSAGE_CHARS + 100);
  const ids = await sendMessage(TOKEN, 1, long, { fetchImpl: many });
  assert.equal(many.calls.length, 2, "超长消息应被切成两条");
  assert.deepEqual(ids, [7, 8], "每条都要有自己的 id，否则只能撤回一半");
});

test("sendMessage 降级成纯文本后，message_id 取自成功的那一次", async () => {
  const fetchImpl = scriptedFetch([
    jsonResponse(400, { ok: false, description: "Bad Request: can't parse entities" }),
    jsonResponse(200, { ok: true, result: { message_id: 99 } }),
  ]);
  const ids = await sendMessage(TOKEN, 1, "<pre>A & B</pre>", { fetchImpl, parseMode: "HTML" });
  assert.deepEqual(ids, [99], "失败那次没有 message_id，不能把它算进去");
});

test("sendMessage 分条后半截失败时，错误上带着已发出的 message_id", async () => {
  // 前半截已经在聊天里了，撤回时必须撤得到它，否则会永远留着。
  const fetchImpl = scriptedFetch([
    jsonResponse(200, { ok: true, result: { message_id: 5 } }),
    jsonResponse(403, { ok: false, description: "Forbidden: bot was blocked by the user" }),
  ]);
  const long = "x".repeat(MAX_MESSAGE_CHARS + 100);
  const err = await sendMessage(TOKEN, 1, long, { fetchImpl }).then(
    () => null,
    (e) => e
  );
  assert.ok(err, "后半截失败应该抛");
  assert.deepEqual(err.messageIds, [5]);
});

test("deleteMessage / editMessageText 的确定性 400 不走退避，并被正确归类", async () => {
  const cases = [
    ["Bad Request: message to delete not found", "gone"],
    ["Bad Request: message can't be deleted for everyone", "too_old"],
    ["Bad Request: message is not modified", "not_modified"],
    ["Bad Request: message can't be edited", "unavailable"],
  ];
  for (const [description, expected] of cases) {
    const fetchImpl = scriptedFetch([jsonResponse(400, { ok: false, description })]);
    const started = Date.now();
    const err = await deleteMessage(TOKEN, 1, 5, { fetchImpl }).then(
      () => null,
      (e) => e
    );
    assert.ok(err, description);
    assert.equal(err.code, "TELEGRAM_BAD_REQUEST");
    assert.equal(fetchImpl.calls.length, 1, "这类 400 是确定性的，重试 4 次只是白等 5 秒");
    assert.ok(Date.now() - started < 1000);
    assert.equal(retractFailureKind(err), expected);
  }

  // 真失败（网络/5xx/403）必须归 null 交回去重试，不能被当成「已经撤过了」。
  const fatal = scriptedFetch([jsonResponse(403, { ok: false, description: "Forbidden" })]);
  const err = await deleteMessage(TOKEN, 1, 5, { fetchImpl: fatal }).then(
    () => null,
    (e) => e
  );
  assert.equal(retractFailureKind(err), null);
});

test("editMessageText 不带 parse_mode，正文原样发出", async () => {
  const fetchImpl = scriptedFetch([jsonResponse(200, { ok: true, result: { message_id: 5 } })]);
  await editMessageText(TOKEN, 1, 5, "✅ 已处理 · A & B", { fetchImpl });
  const body = fetchImpl.calls[0].body;
  assert.equal(body.parse_mode, undefined, "纯文本就不必操心渠道名里的 &");
  assert.equal(body.text, "✅ 已处理 · A & B");
  assert.equal(body.message_id, 5);
});

test("chunkMessage：不超上限时只出一条且不加页脚", () => {
  const parts = chunkMessage("短消息", 100);
  assert.equal(parts.length, 1);
  assert.equal(parts[0], "短消息");
});

test("chunkMessage：按块装箱，块是优先的切分边界", () => {
  const blocks = ["A".repeat(40), "B".repeat(40), "C".repeat(40)];
  const parts = chunkMessage(blocks, 100);
  // 40 + 2 + 40 = 82 放得下；再加 42 就超了，所以切成两条。
  assert.equal(parts.length, 2);
  assert.match(parts[0], /^A{40}\n\nB{40}/);
  assert.match(parts[1], /^C{40}/);
  for (const p of parts) assert.ok(p.length <= 100, "每条都不应超过上限");
});

test("chunkMessage：整块超长时按行切，绝不在行中间断开", () => {
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push("行" + i + "：" + "x".repeat(20));
  const parts = chunkMessage([lines.join("\n")], 200);
  assert.ok(parts.length > 1, "应该切成多条");
  for (const part of parts) {
    assert.ok(part.length <= 200, "每条都不应超过上限");
    const body = part.replace(/\n\n（第 \d+\/\d+ 条）$/, "");
    for (const line of body.split("\n")) {
      if (!line) continue;
      assert.ok(
        lines.includes(line),
        `出现了被截断的行：${JSON.stringify(line)}`
      );
    }
  }
  // 内容无损：所有原始行都还在。
  const rejoined = parts
    .map((p) => p.replace(/\n\n（第 \d+\/\d+ 条）$/, ""))
    .join("\n")
    .split("\n");
  for (const line of lines) assert.ok(rejoined.includes(line), "丢了一行：" + line);
});

test("chunkMessage：多条时每条都带页脚且仍不超上限", () => {
  const parts = chunkMessage(["A".repeat(60), "B".repeat(60)], 100);
  assert.equal(parts.length, 2);
  assert.match(parts[0], /^A{60}\n\n（第 1\/2 条）$/);
  assert.match(parts[1], /^B{60}\n\n（第 2\/2 条）$/);
  for (const p of parts) assert.ok(p.length <= 100, "带页脚后也不应超过上限");
});

test("chunkMessage：单行超长时硬切", () => {
  const parts = chunkMessage("y".repeat(250), 100);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= 100);
});

test("chunkMessage：空输入返回空数组", () => {
  assert.deepEqual(chunkMessage(""), []);
  assert.deepEqual(chunkMessage([]), []);
  assert.deepEqual(chunkMessage(["", ""]), []);
});

test("token 指纹不含明文，格式校验能挡住空值和乱填", () => {
  const fp = tokenFingerprint(TOKEN);
  assert.match(fp, /^123456789:/);
  assert.ok(!fp.includes("AAEEaaBBcc"), "指纹不应包含 token 内容");
  assert.notEqual(tokenFingerprint(TOKEN), tokenFingerprint(TOKEN + "x"));
  assert.equal(tokenFingerprint(""), "");

  assert.ok(isValidToken(TOKEN));
  assert.ok(!isValidToken(""));
  assert.ok(!isValidToken("nonsense"));
  assert.ok(!isValidToken("123:short"));
});

test("sanitizeErrorText 抹掉错误原文里的 bot token —— 状态面板要把它展示给人看", () => {
  const withToken = `telegram sendMessage failed for ${TOKEN}: Unauthorized`;
  const cleaned = sanitizeErrorText(withToken);
  assert.ok(!cleaned.includes(TOKEN), "不能泄露完整 token");
  assert.ok(!cleaned.includes("AAEEaaBBcc"), "不能泄露 token 的密钥段");
  assert.match(cleaned, /\*\*\*/);
  assert.match(cleaned, /Unauthorized/, "其余错误信息应保留，否则排查不了问题");

  // URL 形式的也要抹掉
  const withUrl = `fetch failed https://api.telegram.org/bot${TOKEN}/sendMessage`;
  assert.ok(!sanitizeErrorText(withUrl).includes(TOKEN));

  assert.equal(sanitizeErrorText(""), "");
  assert.equal(sanitizeErrorText(null), "");
  assert.equal(sanitizeErrorText("x".repeat(500)).length, 300, "应截断到上限");
});

test("tgApi：成功时直接返回 result，不重试", async () => {
  const impl = scriptedFetch([jsonResponse(200, { ok: true, result: { message_id: 7 } })]);
  const result = await tgApi(TOKEN, "sendMessage", { chat_id: 1, text: "hi" }, { fetchImpl: impl });
  assert.deepEqual(result, { message_id: 7 });
  assert.equal(impl.calls.length, 1);
  assert.equal(impl.calls[0].body.text, "hi");
});

test("tgApi：401 / 403 / 409 立即失败，绝不重试（重试会加剧封禁）", async () => {
  for (const status of [401, 403, 409]) {
    const impl = scriptedFetch([jsonResponse(status, { ok: false, description: "nope" })]);
    await assert.rejects(
      () => tgApi(TOKEN, "getUpdates", {}, { fetchImpl: impl }),
      (e) => e.code === "TELEGRAM_FATAL" && e.status === status
    );
    assert.equal(impl.calls.length, 1, `HTTP ${status} 不应重试`);
  }
});

test("tgApi：token 不合法时不发请求", async () => {
  const impl = scriptedFetch([jsonResponse(200, { ok: true, result: 1 })]);
  await assert.rejects(
    () => tgApi("", "getUpdates", {}, { fetchImpl: impl }),
    (e) => e.code === "TELEGRAM_FATAL"
  );
  assert.equal(impl.calls.length, 0);
});

test("tgApi：500 会退避重试，耗尽后抛错", async () => {
  const impl = scriptedFetch([jsonResponse(500, { ok: false, description: "boom" })]);
  await assert.rejects(() => tgApi(TOKEN, "sendMessage", {}, { fetchImpl: impl }));
  assert.equal(impl.calls.length, 4, "应尝试 MAX_ATTEMPTS 次");
});

test("tgApi：500 后恢复则返回成功结果", async () => {
  const impl = scriptedFetch([
    jsonResponse(500, { ok: false, description: "boom" }),
    jsonResponse(200, { ok: true, result: "recovered" }),
  ]);
  const result = await tgApi(TOKEN, "sendMessage", {}, { fetchImpl: impl });
  assert.equal(result, "recovered");
  assert.equal(impl.calls.length, 2);
});

test("tgApi：429 尊重 retry_after 而不是固定梯度", async () => {
  const started = Date.now();
  const impl = scriptedFetch([
    jsonResponse(429, { ok: false, description: "Too Many Requests", parameters: { retry_after: 1 } }),
    jsonResponse(200, { ok: true, result: "ok" }),
  ]);
  const result = await tgApi(TOKEN, "sendMessage", {}, { fetchImpl: impl });
  assert.equal(result, "ok");
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1000, `应至少等 retry_after=1s，实际 ${elapsed}ms`);
  assert.ok(elapsed < 4000, `不应等过久，实际 ${elapsed}ms`);
});

test("tgApi：调用方 abort 时立刻放弃且不重试", async () => {
  const controller = new AbortController();
  const impl = async () => {
    controller.abort();
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  };
  impl.calls = [];
  await assert.rejects(
    () => tgApi(TOKEN, "getUpdates", {}, { fetchImpl: impl, signal: controller.signal }),
    (e) => e.code === "TELEGRAM_ABORTED"
  );
});

test("tgApi：网络错误退避重试，耗尽后报网络错误", async () => {
  let calls = 0;
  const impl = async () => {
    calls++;
    throw new Error("fetch failed");
  };
  await assert.rejects(
    () => tgApi(TOKEN, "sendMessage", {}, { fetchImpl: impl }),
    /network error/
  );
  assert.equal(calls, 4);
});
