const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const {
  SCOPE,
  TOKEN_URL,
  normalizePrivateKey,
  privateKeyFingerprint,
  assertUsablePrivateKey,
  signAssertion,
  classifyGoogleError,
  getAccessToken,
  invalidateToken,
  _resetTokenCache,
} = require("../lib/googleAuth");

const { getSheetsSettings, saveSheetsSettings, SHEETS_RANGES } = require("../lib/appSettings");

// 2048 位密钥生成约 100ms，整个文件只生成一次。
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const EMAIL = "svc@proj.iam.gserviceaccount.com";
const CREDS = { clientEmail: EMAIL, privateKey };

function decodeSegment(seg) {
  return JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
}

/** 造一个假的 fetch，按顺序吐出预设响应，并记录调用次数。 */
function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (typeof r === "function") return r();
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    };
  };
  impl.calls = calls;
  return impl;
}

function okToken(token = "ya29.test", expiresIn = 3600) {
  return { status: 200, body: { access_token: token, expires_in: expiresIn, token_type: "Bearer" } };
}

function settingsDb() {
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

test.beforeEach(() => _resetTokenCache());

// ------------------------------------------------------------ 私钥处理

test("私钥里字面量的 \\n 被还原成真换行，否则 createSign 会报看不懂的 PEM 错", () => {
  const mangled = privateKey.replace(/\n/g, "\\n");
  assert.ok(!mangled.includes("\n"), "前提：模拟从 JSON 复制粘贴，里面没有真换行");
  const restored = normalizePrivateKey(mangled);
  assert.equal(restored, privateKey.trim());
  // 还原后必须真的能用来签名
  assert.doesNotThrow(() => crypto.createSign("RSA-SHA256").update("x").sign(restored));
});

test("assertUsablePrivateKey 放行合法私钥、以 400 挡住乱填的", () => {
  assert.equal(assertUsablePrivateKey(privateKey), privateKey.trim());
  assert.equal(assertUsablePrivateKey(privateKey.replace(/\n/g, "\\n")), privateKey.trim());
  for (const bad of ["", "   ", "not a key", "-----BEGIN PRIVATE KEY-----\nrubbish\n-----END PRIVATE KEY-----"]) {
    assert.throws(
      () => assertUsablePrivateKey(bad),
      (e) => e.status === 400,
      "应以 400 拒绝: " + JSON.stringify(bad.slice(0, 20))
    );
  }
});

test("私钥指纹稳定、不含明文片段、对换行写法不敏感", () => {
  const fp = privateKeyFingerprint(privateKey);
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.equal(fp, privateKeyFingerprint(privateKey.replace(/\n/g, "\\n")), "两种换行写法应同指纹");
  const body = privateKey.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "");
  assert.ok(!body.includes(fp), "指纹不能是私钥内容的片段");
  assert.equal(privateKeyFingerprint(""), "");
});

// ------------------------------------------------------------ JWT 签名

test("signAssertion 签出的 JWT 能用公钥验签，claims 也对", () => {
  const nowMs = 1_700_000_000_000;
  const jwt = signAssertion({ clientEmail: EMAIL, privateKey, nowMs });
  const [h, c, s] = jwt.split(".");
  assert.ok(h && c && s, "应是三段式");

  const verified = crypto
    .createVerify("RSA-SHA256")
    .update(h + "." + c)
    .verify(publicKey, Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
  assert.equal(verified, true, "签名必须能用配对公钥验过");

  assert.deepEqual(decodeSegment(h), { alg: "RS256", typ: "JWT" });
  const claim = decodeSegment(c);
  assert.equal(claim.iss, EMAIL);
  assert.equal(claim.aud, TOKEN_URL);
  assert.equal(claim.scope, SCOPE);
  assert.equal(claim.iat, Math.floor(nowMs / 1000));
  assert.equal(claim.exp - claim.iat, 3600, "Google 不接受超过 1 小时的有效期");
});

test("signAssertion 的输出是 base64url（不含 + / =），否则 Google 会拒", () => {
  // 多签几次：base64 里出现 + 和 / 有随机性，一次可能碰不上
  for (let i = 0; i < 20; i++) {
    const jwt = signAssertion({ clientEmail: EMAIL, privateKey, nowMs: Date.now() + i * 1000 });
    assert.ok(!/[+/=]/.test(jwt), "第 " + i + " 次签名出现了非 base64url 字符");
  }
});

test("signAssertion 缺 email 或私钥时直接抛，不会签出一个注定被拒的 JWT", () => {
  assert.throws(() => signAssertion({ clientEmail: "", privateKey }), /clientEmail/);
  assert.throws(() => signAssertion({ clientEmail: EMAIL, privateKey: "" }), /privateKey/);
});

// ------------------------------------------------------------ 错误分类（最易写错的一块）

test("403 + rateLimitExceeded 是限流不是权限失败 —— 分错会把几秒的限流变成 30 分钟停摆", () => {
  const err = classifyGoogleError(403, {
    error: {
      code: 403,
      status: "PERMISSION_DENIED",
      message: "Quota exceeded",
      errors: [{ reason: "rateLimitExceeded", message: "Rate Limit Exceeded" }],
    },
  });
  assert.equal(err.googleKind, "RATE_LIMIT");
  assert.equal(err.code, "RATE_LIMIT");
  assert.notEqual(err.code, "ACCESS_DENIED", "绝不能落进长退避那一档");
});

test("错误分类表：每种响应落到正确的档位", () => {
  const cases = [
    // [status, body, 期望 kind, 期望 code]
    [400, { error: "invalid_grant", error_description: "Invalid JWT" }, "AUTH", "ACCESS_DENIED"],
    [400, { error: "invalid_client" }, "AUTH", "ACCESS_DENIED"],
    [400, { error: "unauthorized_client" }, "AUTH", "ACCESS_DENIED"],
    [401, { error: { status: "UNAUTHENTICATED", message: "bad token" } }, "AUTH", "ACCESS_DENIED"],
    [403, { error: { status: "PERMISSION_DENIED", message: "caller has no access" } }, "AUTH", "ACCESS_DENIED"],
    [403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }, "RATE_LIMIT", "RATE_LIMIT"],
    [403, { error: { errors: [{ reason: "quotaExceeded" }] } }, "RATE_LIMIT", "RATE_LIMIT"],
    [429, { error: { status: "RESOURCE_EXHAUSTED" } }, "RATE_LIMIT", "RATE_LIMIT"],
    [404, { error: { status: "NOT_FOUND", message: "Requested entity was not found" } }, "NOT_FOUND", undefined],
    [500, { error: { message: "Internal error" } }, "TRANSIENT", undefined],
    [503, null, "TRANSIENT", undefined],
    [400, { error: { status: "INVALID_ARGUMENT", message: "bad range" } }, "FATAL", undefined],
  ];
  for (const [status, body, kind, code] of cases) {
    const err = classifyGoogleError(status, body, "raw");
    assert.equal(err.googleKind, kind, `HTTP ${status} ${JSON.stringify(body)} 应是 ${kind}`);
    assert.equal(err.code, code, `HTTP ${status} 的 err.code 应是 ${code}`);
    assert.equal(err.status, status);
  }
});

test("三个最常见的坑在报错里直接给出线索", () => {
  assert.match(
    classifyGoogleError(400, { error: "invalid_grant" }).message,
    /服务器时间/,
    "invalid_grant 最常见的原因是时钟偏移，必须写出来"
  );
  assert.match(
    classifyGoogleError(403, { error: { status: "PERMISSION_DENIED" } }).message,
    /分享给 service account/
  );
  assert.match(
    classifyGoogleError(404, { error: { status: "NOT_FOUND" } }).message,
    /Spreadsheet ID/
  );
});

test("响应体不是 JSON 时退回原始文本，不吞掉信息", () => {
  const err = classifyGoogleError(502, null, "<html>Bad Gateway</html>");
  assert.equal(err.googleKind, "TRANSIENT");
  assert.match(err.message, /Bad Gateway/);
});

// ------------------------------------------------------------ token 缓存 / 单飞 / 重试

test("token 被缓存：连调三次只换一次票", async () => {
  const f = fakeFetch([okToken()]);
  for (let i = 0; i < 3; i++) {
    assert.equal(await getAccessToken(CREDS, { fetchImpl: f }), "ya29.test");
  }
  assert.equal(f.calls.length, 1, "应只发一次换票请求");
});

test("快过期的 token 提前换新（5 分钟余量），不等它真的失效", async () => {
  // expires_in = 120s < REFRESH_SKEW_MS(300s) → 第二次调用必须重新换
  const f = fakeFetch([okToken("first", 120), okToken("second", 3600)]);
  assert.equal(await getAccessToken(CREDS, { fetchImpl: f }), "first");
  assert.equal(await getAccessToken(CREDS, { fetchImpl: f }), "second");
  assert.equal(f.calls.length, 2);
});

test("单飞：并发请求只触发一次换票", async () => {
  let resolveIt;
  const gate = new Promise((r) => (resolveIt = r));
  const f = fakeFetch([
    async () => {
      await gate;
      return { ok: true, status: 200, text: async () => JSON.stringify(okToken().body) };
    },
  ]);
  const all = Promise.all([
    getAccessToken(CREDS, { fetchImpl: f }),
    getAccessToken(CREDS, { fetchImpl: f }),
    getAccessToken(CREDS, { fetchImpl: f }),
  ]);
  resolveIt();
  const tokens = await all;
  assert.deepEqual(tokens, ["ya29.test", "ya29.test", "ya29.test"]);
  assert.equal(f.calls.length, 1, "三个并发调用应合并成一次请求");
});

test("force 绕过缓存，invalidateToken 之后也会重新换票", async () => {
  const f = fakeFetch([okToken("a"), okToken("b"), okToken("c")]);
  assert.equal(await getAccessToken(CREDS, { fetchImpl: f }), "a");
  assert.equal(await getAccessToken(CREDS, { fetchImpl: f, force: true }), "b");
  invalidateToken(EMAIL);
  assert.equal(await getAccessToken(CREDS, { fetchImpl: f }), "c");
  assert.equal(f.calls.length, 3);
});

test("请求形状对：POST 到 token 端点，form 编码，带 jwt-bearer grant", async () => {
  const f = fakeFetch([okToken()]);
  await getAccessToken(CREDS, { fetchImpl: f });
  const { url, init } = f.calls[0];
  assert.equal(url, TOKEN_URL);
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
  const params = new URLSearchParams(init.body);
  assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  assert.equal(params.get("assertion").split(".").length, 3);
});

test("凭证错误（invalid_grant）立刻失败，绝不重试 —— 硬重试只会加剧封禁", async () => {
  const f = fakeFetch([{ status: 400, body: { error: "invalid_grant" } }]);
  await assert.rejects(
    () => getAccessToken(CREDS, { fetchImpl: f }),
    (e) => e.code === "ACCESS_DENIED"
  );
  assert.equal(f.calls.length, 1, "只能发一次");
});

test("限流会退避重试，恢复后返回 token", async () => {
  const f = fakeFetch([
    { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED" } } },
    okToken("after-retry"),
  ]);
  assert.equal(await getAccessToken(CREDS, { fetchImpl: f }), "after-retry");
  assert.equal(f.calls.length, 2);
});

test("换票失败时不写缓存，下次调用会重新尝试", async () => {
  const f = fakeFetch([{ status: 400, body: { error: "invalid_client" } }, okToken("later")]);
  await assert.rejects(() => getAccessToken(CREDS, { fetchImpl: f }));
  assert.equal(await getAccessToken(CREDS, { fetchImpl: f }), "later", "失败不该毒化缓存");
});

test("非瞬时网络错误不重试，报错里带上原因", async () => {
  const f = fakeFetch([new Error("certificate has expired")]);
  await assert.rejects(() => getAccessToken(CREDS, { fetchImpl: f }), /certificate has expired/);
  assert.equal(f.calls.length, 1);
});

test("瞬时网络错误会重试", async () => {
  const f = fakeFetch([new Error("fetch failed"), okToken("recovered")]);
  assert.equal(await getAccessToken(CREDS, { fetchImpl: f }), "recovered");
  assert.equal(f.calls.length, 2);
});

test("响应 200 但没有 access_token 时报错，而不是把 undefined 当票用", async () => {
  const f = fakeFetch([{ status: 200, body: { token_type: "Bearer" } }]);
  await assert.rejects(() => getAccessToken(CREDS, { fetchImpl: f }), /missing access_token/);
});

// ------------------------------------------------------------ Sheets 全局设置

test("空库读出完整的 Sheets 默认设置，未配置且默认关闭", () => {
  const db = settingsDb();
  const s = getSheetsSettings(db);
  assert.equal(s.enabled, false);
  assert.equal(s.configured, false);
  assert.equal(s.manualImportEnabled, true);
  assert.equal(s.pushIntervalSeconds, SHEETS_RANGES.pushIntervalSeconds.def);
  db.close();
});

test("Sheets 设置：私钥留空 = 保持不变，这样前端可以只显示指纹", () => {
  const db = settingsDb();
  saveSheetsSettings(db, { saClientEmail: EMAIL, saPrivateKey: privateKey }, "t");
  const after = saveSheetsSettings(db, { saClientEmail: EMAIL, saPrivateKey: "" }, "t");
  assert.equal(after.saPrivateKey, privateKey.trim(), "留空不该把已存的私钥清掉");
  assert.equal(after.configured, true);
  db.close();
});

test("Sheets 设置：乱填的私钥在保存时就被挡住，而不是等后台循环反复失败", () => {
  const db = settingsDb();
  assert.throws(
    () => saveSheetsSettings(db, { saPrivateKey: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----" }, "t"),
    (e) => e.status === 400
  );
  db.close();
});

test("Sheets 设置：粘贴整条网址而不是 Spreadsheet ID 时给出明确报错", () => {
  const db = settingsDb();
  assert.throws(
    () =>
      saveSheetsSettings(
        db,
        { globalSpreadsheetId: "https://docs.google.com/spreadsheets/d/abc/edit" },
        "t"
      ),
    (e) => e.status === 400 && /不是整条网址/.test(e.message)
  );
  // 合法 ID 放行
  assert.equal(
    saveSheetsSettings(db, { globalSpreadsheetId: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms" }, "t")
      .globalSpreadsheetId,
    "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
  );
  db.close();
});

test("Sheets 设置：邮箱格式不对以 400 拒绝", () => {
  const db = settingsDb();
  assert.throws(
    () => saveSheetsSettings(db, { saClientEmail: "not-an-email" }, "t"),
    (e) => e.status === 400
  );
  db.close();
});

test("Sheets 设置：没凭证就想启用会被挡住", () => {
  const db = settingsDb();
  assert.throws(
    () => saveSheetsSettings(db, { enabled: true }, "t"),
    (e) => e.status === 400 && /私钥/.test(e.message)
  );
  // 凭证齐了才能开
  saveSheetsSettings(db, { saClientEmail: EMAIL, saPrivateKey: privateKey }, "t");
  assert.equal(saveSheetsSettings(db, { enabled: true }, "t").enabled, true);
  db.close();
});

test("Sheets 设置：清私钥会顺带关掉启用开关，不留「已启用但没凭证」的状态", () => {
  const db = settingsDb();
  const { clearSheetsPrivateKey } = require("../lib/appSettings");
  saveSheetsSettings(db, { saClientEmail: EMAIL, saPrivateKey: privateKey, enabled: true }, "t");
  const after = clearSheetsPrivateKey(db, "t");
  assert.equal(after.saPrivateKey, "");
  assert.equal(after.enabled, false);
  assert.equal(after.configured, false);
  db.close();
});

test("Sheets 设置：间隔越界被钳制而不是报错", () => {
  const db = settingsDb();
  const r = SHEETS_RANGES.pushIntervalSeconds;
  assert.equal(saveSheetsSettings(db, { pushIntervalSeconds: 1 }, "t").pushIntervalSeconds, r.min);
  assert.equal(saveSheetsSettings(db, { pushIntervalSeconds: 99999 }, "t").pushIntervalSeconds, r.max);
  db.close();
});
