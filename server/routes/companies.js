const express = require("express");
const { getDb } = require("../db/init");
const { requireLogin, requireAdmin, requireFullAdmin } = require("../middleware");
const {
  upsertCompany,
  deleteCompany,
  getCompany,
  rowToPublic,
  defaultCompanyId,
} = require("../lib/companies");
const { isCompanyRestricted, hasCompanyAccess, listCompaniesForUser, firstAuthorizedCompanyId } = require("../lib/userAccess");
const { setActiveCompany } = require("../lib/activeCompany");
const { invalidateSegmentCounts } = require("../lib/segmentCountCache");
const { parseChatIds, isValidChatId } = require("../services/telegramBots");
const { formatSydneyDateTime } = require("../lib/dates");
const { apiUrlProblem, credentialChangeProblem } = require("../lib/apiUrlPolicy");

const router = express.Router();

const TEST_TIMEOUT_MS = 15000;

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// 两栏都是 password 框、上下紧挨着，Bot Token 粘进 Access Token 是很容易犯的错，
// 而且后果隐蔽：保存会成功、toast 显示"已保存"，只有卡片底部的同步状态在几秒后变成
// "API 拒绝访问"，看起来像网络问题而不是填错了栏。两种 token 的形状差别很大
// （平台 token 是 64 位十六进制，Telegram 是 <bot_id>:<35+ 字符>），直接按形状拦。
const TELEGRAM_TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
// 浏览器会把保存的后台登录密码自动填进 Access Token 这个 password 框（Access ID 被当成用户名），
// 点保存就静默覆盖掉真 token。按形状拦：平台 token 只能是 64 位十六进制。
// public/js/company-settings.js 有同一条前端校验。
const ACCESS_TOKEN_RE = /^[0-9a-f]{64}$/i;

function checkTokenSwap(body) {
  const access = String(body.access_token || "").trim();
  const tg = String(body.telegram_bot_token || "").trim();
  if (access && TELEGRAM_TOKEN_RE.test(access)) {
    return "Access Token 里填的是 Telegram Bot Token（形如 123456:AA...）。平台 Access Token 不含冒号——请检查是不是粘错了输入框。";
  }
  if (access && !ACCESS_TOKEN_RE.test(access)) {
    return "Access Token 应为 64 位十六进制。可能是浏览器自动填入了登录密码——清空该框（留空即保持原 token 不变）。";
  }
  if (tg && !TELEGRAM_TOKEN_RE.test(tg)) {
    return "Telegram Bot Token 格式不对，应形如 123456789:AAxxxxxxxx（向 @BotFather 索取）。";
  }
  return null;
}

async function testApiCredentials(creds) {
  const apiUrl = String(creds.api_url || "").trim();
  const accessId = String(creds.access_id || "").trim();
  const accessToken = String(creds.access_token || "").trim();
  if (!apiUrl || !accessId || !accessToken) {
    throw new Error("请先填写完整的 API URL、Access ID 和 Access Token");
  }
  const urlProblem = apiUrlProblem(apiUrl);
  if (urlProblem) throw new Error(urlProblem);
  const form = new FormData();
  form.append("module", "/transactions/getAllTransactions");
  form.append("accessId", accessId);
  form.append("accessToken", accessToken);
  form.append("type", "DEPOSIT");
  form.append("pageIndex", "0");
  form.append("pageSize", "1");
  // 盘方对交易查询有 31 天窗口上限（与 config.json 的 transactionChunkDays 对应，
  // sync.js 就是按 31 天分块拉的）。这里原先写的是 2020-01-01 → 2030-01-01，超限，
  // 于是无论凭证和白名单对不对，都只会回 "Start and end date cannot be more than
  // 31 days." —— 按钮永远测不出"连接成功"。只问最近 1 天就够：我们要验的是鉴权能不能过。
  form.append("sDate", formatSydneyDateTime(new Date(Date.now() - 24 * 3600 * 1000).toISOString()));
  form.append("eDate", formatSydneyDateTime(new Date().toISOString()));
  // redirect:"error"：307/308 会把含 token 的表单原样重放到跳转目标。
  const response = await fetch(apiUrl, {
    method: "POST",
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("API 返回非 JSON，请检查 URL");
  }
  if (json.status !== "SUCCESS") {
    const msg =
      (json.data && (json.data.message || json.data.msg)) ||
      json.message ||
      json.msg ||
      json.status ||
      "API error";
    throw new Error(msg);
  }
  const n = (json.data?.transactions || []).length;
  return "连接成功（返回 " + n + " 条样本）";
}

function resolveCredentials(db, id, body) {
  const existing = id ? getCompany(db, id) : null;
  const api_url = String(body.api_url ?? existing?.api_url ?? "").trim();
  const access_id = String(body.access_id ?? existing?.access_id ?? "").trim();
  let access_token = body.access_token != null && body.access_token !== "" ? String(body.access_token).trim() : "";
  if (!access_token) access_token = String(existing?.access_token || "").trim();
  return { api_url, access_id, access_token };
}

router.get("/", requireLogin, (req, res) => {
  const db = getDb();
  const restricted = isCompanyRestricted(db, req.session.user); // operator 或受限 admin
  const companies = listCompaniesForUser(db, req.session.user);
  if (restricted && !companies.length) {
    return res.status(403).json({ error: "管理员尚未为此账号分配公司" });
  }
  // req.companyId 由 resolveCompany 定：有 X-Company-Id 头时是本标签页的公司（不写 session），
  // 没有头时就是 session 默认值（resolveCompany 已校正并写回）。
  const current = req.companyId || req.session.companyId;
  const active = companies.some((company) => company.id === current)
    ? current
    : restricted
      ? firstAuthorizedCompanyId(db, req.session.user)
      : current || defaultCompanyId(db);
  res.json({
    active: active || null,
    companies,
  });
});

// 新建 / 删除公司只给「全部公司」admin（受限 admin 只能改自己范围内的公司设置）。
router.post("/", requireFullAdmin, (req, res) => {
  const body = req.body || {};
  const id = String(body.id || "").trim().toLowerCase();
  const name = String(body.name || "").trim();
  if (!id || !ID_RE.test(id)) {
    return res.status(400).json({ error: "公司 ID 仅支持小写字母、数字、下划线和连字符（2-32位）" });
  }
  if (!name) return res.status(400).json({ error: "请填写显示名称" });
  const swap = checkTokenSwap(body);
  if (swap) return res.status(400).json({ error: swap });
  const urlProblem = apiUrlProblem(body.api_url);
  if (urlProblem) return res.status(400).json({ error: urlProblem });
  const db = getDb();
  if (getCompany(db, id)) return res.status(409).json({ error: "该公司 ID 已存在" });
  const row = upsertCompany(db, {
    id,
    name,
    api_url: String(body.api_url || "").trim(),
    access_id: String(body.access_id || "").trim(),
    access_token: String(body.access_token || "").trim(),
    enabled: false,
  });
  res.status(201).json({ ok: true, company: rowToPublic(row) });
});

router.post("/test-connection", requireAdmin, async (req, res) => {
  try {
    const message = await testApiCredentials(req.body || {});
    res.json({ ok: true, message });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post("/active", requireLogin, (req, res) => {
  const id = String(req.body?.id || "").trim().toLowerCase();
  const db = getDb();
  const row = getCompany(db, id);
  if (!row) return res.status(404).json({ error: "公司不存在" });
  if (!hasCompanyAccess(db, req.session.user, id)) {
    return res.status(403).json({ error: "无权访问此公司" });
  }
  req.session.companyId = id;
  setActiveCompany(id);
  invalidateSegmentCounts(id);
  res.json({ ok: true, active: id, company: rowToPublic(row) });
});

// 受限 admin 只能改 / 测自己范围内的公司：按 :id 改的是 token 与 Bot，不能只看「是不是 admin」。
function requireCompanyParamAccess(req, res, next) {
  const id = String(req.params.id || "").trim().toLowerCase();
  const db = getDb();
  if (getCompany(db, id) && !hasCompanyAccess(db, req.session.user, id)) {
    return res.status(403).json({ error: "无权修改此公司" });
  }
  next();
}

router.put("/:id", requireAdmin, requireCompanyParamAccess, (req, res) => {
  const id = String(req.params.id || "").trim().toLowerCase();
  const db = getDb();
  const existing = getCompany(db, id);
  if (!existing) return res.status(404).json({ error: "公司不存在" });
  const body = req.body || {};
  const swap = checkTokenSwap(body);
  if (swap) return res.status(400).json({ error: swap });
  const credentialProblem = credentialChangeProblem(existing, body);
  if (credentialProblem) return res.status(400).json({ error: credentialProblem });
  const creds = resolveCredentials(db, id, body);
  const enabling = body.enabled === true || body.enabled === 1;
  if (enabling && (!creds.api_url || !creds.access_id || !creds.access_token)) {
    return res.status(400).json({ error: "启用同步前请填写完整 API URL、Access ID 和 Token" });
  }
  if (body.telegram_chat_ids !== undefined) {
    const bad = parseChatIds(body.telegram_chat_ids).filter((v) => !isValidChatId(v));
    if (bad.length) {
      return res.status(400).json({ error: "Telegram chat id 必须是整数（群为负数）：" + bad.join(", ") });
    }
  }
  const row = upsertCompany(db, {
    id,
    name: body.name,
    api_url: body.api_url,
    access_id: body.access_id,
    access_token: body.access_token,
    enabled: body.enabled,
    sort_order: body.sort_order,
    telegram_bot_token: body.telegram_bot_token,
    telegram_chat_ids: body.telegram_chat_ids,
  });
  // Bot 配置改完即时生效，不用重启服务。整体 try/catch：Bot 起不来不该让保存失败。
  try {
    require("../services/telegramBots").reconcileBots();
  } catch (e) {
    console.warn("[telegram] reconcile after company update:", e.message);
  }
  res.json({ ok: true, company: rowToPublic(row) });
});

router.delete("/:id", requireFullAdmin, (req, res) => {
  const id = String(req.params.id || "").trim().toLowerCase();
  const confirm = String(req.body?.confirm || "").trim().toLowerCase();
  if (confirm !== id) {
    return res.status(400).json({ error: "请在确认框输入正确的公司 ID" });
  }
  const db = getDb();
  try {
    const row = deleteCompany(db, id);
    if (!row) return res.status(404).json({ error: "公司不存在" });
    if (req.session.companyId === id) {
      req.session.companyId = defaultCompanyId(db);
    }
    res.json({ ok: true, active: req.session.companyId, deleted: id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/:id/test", requireAdmin, requireCompanyParamAccess, async (req, res) => {
  const id = String(req.params.id || "").trim().toLowerCase();
  const db = getDb();
  const existing = getCompany(db, id);
  if (!existing) return res.status(404).json({ error: "公司不存在" });
  const credentialProblem = credentialChangeProblem(existing, req.body || {});
  if (credentialProblem) return res.status(400).json({ ok: false, error: credentialProblem });
  try {
    const creds = resolveCredentials(db, id, req.body || {});
    const message = await testApiCredentials(creds);
    res.json({ ok: true, message });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
