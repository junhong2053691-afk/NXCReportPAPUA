// Google Service Account 认证：用 RS256 签一个 JWT assertion，换 1 小时有效的
// access_token。
//
// 为什么不用 googleapis：全仓只有 4 个依赖，连 dotenv 都没装，而 googleapis 会拖进
// google-auth-library / gaxios / gtoken / node-forge 等几十个传递依赖。这个模块的核心
// 价值是**错误分类**（见 classifyGoogleError），googleapis 在这件事上帮不上忙——它抛
// GaxiosError，我们照样要写一层翻译。签名部分 node:crypto 就够，不到 40 行。
//
// 重试/退避/jitter 的形状照抄 services/platform.js:48-157，让维护者不用学第二套心智模型。

const crypto = require("node:crypto");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const JWT_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

// access_token 名义有效期 3600s。提前 5 分钟换新的，避免"签发时还有效、到达 Google
// 时已过期"的边界，也给时钟微小偏移留余量。
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 15000;
const MAX_TOKEN_ATTEMPTS = 4;

// clientEmail -> { token, expiresAt }
const tokenCache = new Map();
// clientEmail -> Promise<string>。单飞：4 家公司共用一个 service account 时，
// 不该在 token 过期的那一刻同时发 4 个换票请求。
const inflight = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * 还原私钥里的换行。
 *
 * Google 发的 service account JSON 里，private_key 的换行是**字面量的两个字符** \ 和 n；
 * 用户从 JSON 里复制粘贴到表单时也会原样带过来。不还原的话 createSign 会直接报
 * "error:0909006C:PEM routines:get_name:no start line"，而那个报错完全看不出是这个原因。
 */
function normalizePrivateKey(pem) {
  return String(pem || "")
    .replace(/\\n/g, "\n")
    .trim();
}

/** 私钥指纹，给 UI 显示"已保存 xxxxxxxxxxxx"用。永远不要把私钥本身回给前端。 */
function privateKeyFingerprint(pem) {
  const normalized = normalizePrivateKey(pem);
  if (!normalized) return "";
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

/**
 * 校验私钥能不能真的用来签名。保存设置时调用，把"凭证填错"挡在配置阶段，
 * 而不是等 30 秒后在后台循环里反复失败。
 *
 * @returns {string} 规范化后的 PEM
 * @throws {Error} err.status = 400
 */
function assertUsablePrivateKey(pem) {
  const normalized = normalizePrivateKey(pem);
  if (!normalized) {
    const err = new Error("私钥不能为空");
    err.status = 400;
    throw err;
  }
  try {
    crypto.createPrivateKey(normalized);
  } catch (e) {
    const err = new Error(
      "私钥格式不正确，应是 service account JSON 里 private_key 的完整内容" +
        "（以 -----BEGIN PRIVATE KEY----- 开头）[" +
        e.message +
        "]"
    );
    err.status = 400;
    throw err;
  }
  return normalized;
}

/**
 * 签出一个 JWT assertion。纯函数（除了读 nowMs 默认值），可用 crypto.createVerify 离线验签。
 *
 * @param {{clientEmail: string, privateKey: string, scope?: string, nowMs?: number}} input
 * @returns {string}
 */
function signAssertion({ clientEmail, privateKey, scope = SCOPE, nowMs = Date.now() }) {
  const email = String(clientEmail || "").trim();
  if (!email) throw new Error("clientEmail required");
  const key = normalizePrivateKey(privateKey);
  if (!key) throw new Error("privateKey required");

  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({ iss: email, scope, aud: TOKEN_URL, exp: iat + 3600, iat })
  );
  const signingInput = header + "." + claim;
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(key);
  return signingInput + "." + b64url(signature);
}

/**
 * 把一次 Google API 失败归成四类，并挂上调度层认识的 err.code。
 *
 * ⚠️ 这里最容易写错的一点：**Google 对配额超限返回 403，不是 429**。如果按 status code
 * 一刀切把 403 当权限失败，一次几秒钟的限流就会被当成凭证失效，进 30 分钟长退避。
 * 必须先看 body.error.status 和 body.error.errors[*].reason。
 *
 * @param {number} status HTTP 状态码
 * @param {any} body 已解析的响应体（解析失败传 null）
 * @param {string} [raw] 原始响应文本，用于兜底的错误消息
 * @returns {Error} err.googleKind = AUTH | RATE_LIMIT | NOT_FOUND | TRANSIENT | FATAL
 */
function classifyGoogleError(status, body, raw) {
  const err = body?.error;
  // token 端点用扁平的 {error, error_description}；API 端点用嵌套的 {error:{status,message}}。
  const oauthCode = typeof err === "string" ? err : "";
  const apiStatus = String(err?.status || "");
  const reasons = Array.isArray(err?.errors)
    ? err.errors.map((e) => String(e?.reason || "").toLowerCase())
    : [];
  const message =
    (typeof err === "object" && err?.message) ||
    body?.error_description ||
    oauthCode ||
    String(raw || "").slice(0, 300) ||
    "HTTP " + status;

  const rateLimited =
    status === 429 ||
    apiStatus === "RESOURCE_EXHAUSTED" ||
    reasons.some((r) => r.includes("ratelimitexceeded") || r.includes("quotaexceeded"));

  let kind;
  if (rateLimited) {
    kind = "RATE_LIMIT";
  } else if (
    status === 401 ||
    oauthCode === "invalid_grant" ||
    oauthCode === "invalid_client" ||
    oauthCode === "unauthorized_client" ||
    apiStatus === "PERMISSION_DENIED" ||
    apiStatus === "UNAUTHENTICATED" ||
    (status === 403 && !rateLimited)
  ) {
    kind = "AUTH";
  } else if (status === 404 || apiStatus === "NOT_FOUND") {
    kind = "NOT_FOUND";
  } else if (status >= 500) {
    kind = "TRANSIENT";
  } else {
    kind = "FATAL";
  }

  const hint = authHint(oauthCode, apiStatus);
  const out = new Error("Google " + kind + " (HTTP " + status + "): " + message + hint);
  out.googleKind = kind;
  out.status = status;
  // 复用调度层已有的两档退避：ACCESS_DENIED 走长退避（凭证问题人不改好不会自愈），
  // RATE_LIMIT 走中等退避（等一会儿就好）。
  if (kind === "AUTH") out.code = "ACCESS_DENIED";
  if (kind === "RATE_LIMIT") out.code = "RATE_LIMIT";
  return out;
}

// 三个最常见的坑，报错里直接写出来，省得每次都要去查文档。
function authHint(oauthCode, apiStatus) {
  if (oauthCode === "invalid_grant") {
    return " —— 常见原因：私钥或 client_email 不对，或**服务器时间偏差超过 5 分钟**（请先校时）";
  }
  if (apiStatus === "PERMISSION_DENIED") {
    return " —— 常见原因：这个表格没有分享给 service account 邮箱（需要「编辑者」权限）";
  }
  if (apiStatus === "NOT_FOUND") {
    return " —— 常见原因：Spreadsheet ID 填错了";
  }
  return "";
}

function isTransientNetworkError(e) {
  if (e && e.name === "AbortError") return true;
  const msg = String((e && e.message) || e || "").toLowerCase();
  return (
    msg.includes("network error") ||
    msg.includes("fetch failed") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up")
  );
}

/** 按 clientEmail 哈希出 0-449ms 抖动，避免多家公司在同一毫秒重试。照抄 platform.js:55-60。 */
function retryJitterMs(seed) {
  const text = String(seed || "");
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash % 450;
}

async function requestToken(creds, opts, attempt) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = Number(opts.timeoutMs || TOKEN_TIMEOUT_MS);
  const assertion = signAssertion({
    clientEmail: creds.clientEmail,
    privateKey: creds.privateKey,
    scope: opts.scope || SCOPE,
    nowMs: opts.nowMs,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let raw;
  let netErr = null;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: JWT_GRANT, assertion }).toString(),
      signal: controller.signal,
    });
    raw = await res.text();
  } catch (e) {
    netErr = e;
  } finally {
    // 必须在退避 sleep 之前清掉：否则这一轮的超时定时器会在退避期间继续挂着。
    clearTimeout(timer);
  }

  if (netErr) {
    if (attempt < MAX_TOKEN_ATTEMPTS && isTransientNetworkError(netErr)) {
      await sleep(Math.min(600 * attempt, 3000) + retryJitterMs(creds.clientEmail));
      return requestToken(creds, opts, attempt + 1);
    }
    const reason =
      netErr?.name === "AbortError" ? "timeout after " + timeoutMs + "ms" : netErr.message;
    throw new Error("Google token network error: " + reason);
  }

  let body = null;
  try {
    body = JSON.parse(raw);
  } catch (_) {
    /* 留 null，classifyGoogleError 会退回 raw 文本 */
  }

  if (!res.ok) {
    const err = classifyGoogleError(res.status, body, raw);
    // AUTH / NOT_FOUND / FATAL 都是重试无意义的（platform.js:62-65 警告过，硬重试只会
    // 延长封禁）。只有限流和 5xx 值得再来一次。
    if ((err.googleKind === "RATE_LIMIT" || err.googleKind === "TRANSIENT") && attempt < MAX_TOKEN_ATTEMPTS) {
      await sleep(Math.min(900 * attempt, 5000) + retryJitterMs(creds.clientEmail));
      return requestToken(creds, opts, attempt + 1);
    }
    throw err;
  }

  const token = body?.access_token;
  if (!token) throw new Error("Google token response missing access_token");
  const expiresIn = Number(body.expires_in || 3600);
  return { token, expiresAt: Date.now() + expiresIn * 1000 };
}

/**
 * 拿一个可用的 access_token。缓存 + 单飞。
 *
 * @param {{clientEmail: string, privateKey: string}} creds
 * @param {{force?: boolean, fetchImpl?: Function, timeoutMs?: number, scope?: string, nowMs?: number}} [opts]
 * @returns {Promise<string>}
 */
async function getAccessToken(creds, opts = {}) {
  const email = String(creds?.clientEmail || "").trim();
  if (!email) throw new Error("clientEmail required");

  if (!opts.force) {
    const cached = tokenCache.get(email);
    if (cached && cached.expiresAt - Date.now() > REFRESH_SKEW_MS) return cached.token;
    const pending = inflight.get(email);
    if (pending) return pending;
  }

  const p = requestToken(creds, opts, 1)
    .then(({ token, expiresAt }) => {
      tokenCache.set(email, { token, expiresAt });
      return token;
    })
    .finally(() => {
      if (inflight.get(email) === p) inflight.delete(email);
    });
  inflight.set(email, p);
  return p;
}

/** 收到 401 后调用：下次强制重新换票。 */
function invalidateToken(clientEmail) {
  tokenCache.delete(String(clientEmail || "").trim());
}

/** 仅供测试使用：清空进程级缓存，让用例之间互不干扰。 */
function _resetTokenCache() {
  tokenCache.clear();
  inflight.clear();
}

module.exports = {
  SCOPE,
  TOKEN_URL,
  REFRESH_SKEW_MS,
  MAX_TOKEN_ATTEMPTS,
  normalizePrivateKey,
  privateKeyFingerprint,
  assertUsablePrivateKey,
  signAssertion,
  classifyGoogleError,
  isTransientNetworkError,
  retryJitterMs,
  getAccessToken,
  invalidateToken,
  _resetTokenCache,
};
