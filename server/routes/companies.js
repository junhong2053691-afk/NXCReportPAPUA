const express = require("express");
const { getDb } = require("../db/init");
const { requireLogin, requireAdmin } = require("../middleware");
const {
  upsertCompany,
  deleteCompany,
  getCompany,
  rowToPublic,
  defaultCompanyId,
} = require("../lib/companies");
const { isOperator, hasCompanyAccess, listCompaniesForUser, firstAuthorizedCompanyId } = require("../lib/userAccess");
const { setActiveCompany } = require("../lib/activeCompany");
const { invalidateSegmentCounts } = require("../lib/segmentCountCache");

const router = express.Router();

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

async function testApiCredentials(creds) {
  const apiUrl = String(creds.api_url || "").trim();
  const accessId = String(creds.access_id || "").trim();
  const accessToken = String(creds.access_token || "").trim();
  if (!apiUrl || !accessId || !accessToken) {
    throw new Error("请先填写完整的 API URL、Access ID 和 Access Token");
  }
  const form = new FormData();
  form.append("module", "/transactions/getAllTransactions");
  form.append("accessId", accessId);
  form.append("accessToken", accessToken);
  form.append("type", "DEPOSIT");
  form.append("pageIndex", "0");
  form.append("pageSize", "1");
  form.append("sDate", "2020-01-01 00:00:00");
  form.append("eDate", "2030-01-01 00:00:00");
  const text = await (await fetch(apiUrl, { method: "POST", body: form })).text();
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
  const companies = listCompaniesForUser(db, req.session.user);
  if (isOperator(req.session.user) && !companies.length) {
    return res.status(403).json({ error: "管理员尚未为此账号分配公司" });
  }
  const active = companies.some((company) => company.id === req.session.companyId)
    ? req.session.companyId
    : isOperator(req.session.user)
      ? firstAuthorizedCompanyId(db, req.session.user)
      : req.session.companyId || defaultCompanyId(db);
  if (active) req.session.companyId = active;
  res.json({
    active: active || null,
    companies,
  });
});

router.post("/", requireAdmin, (req, res) => {
  const body = req.body || {};
  const id = String(body.id || "").trim().toLowerCase();
  const name = String(body.name || "").trim();
  if (!id || !ID_RE.test(id)) {
    return res.status(400).json({ error: "公司 ID 仅支持小写字母、数字、下划线和连字符（2-32位）" });
  }
  if (!name) return res.status(400).json({ error: "请填写显示名称" });
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
  if (isOperator(req.session.user) && !hasCompanyAccess(db, req.session.user, id)) {
    return res.status(403).json({ error: "operator 无权访问此公司" });
  }
  req.session.companyId = id;
  setActiveCompany(id);
  invalidateSegmentCounts(id);
  res.json({ ok: true, active: id, company: rowToPublic(row) });
});

router.put("/:id", requireAdmin, (req, res) => {
  const id = String(req.params.id || "").trim().toLowerCase();
  const db = getDb();
  const existing = getCompany(db, id);
  if (!existing) return res.status(404).json({ error: "公司不存在" });
  const body = req.body || {};
  const creds = resolveCredentials(db, id, body);
  const enabling = body.enabled === true || body.enabled === 1;
  if (enabling && (!creds.api_url || !creds.access_id || !creds.access_token)) {
    return res.status(400).json({ error: "启用同步前请填写完整 API URL、Access ID 和 Token" });
  }
  const row = upsertCompany(db, {
    id,
    name: body.name,
    api_url: body.api_url,
    access_id: body.access_id,
    access_token: body.access_token,
    enabled: body.enabled,
    sort_order: body.sort_order,
  });
  res.json({ ok: true, company: rowToPublic(row) });
});

router.delete("/:id", requireAdmin, (req, res) => {
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

router.post("/:id/test", requireAdmin, async (req, res) => {
  const id = String(req.params.id || "").trim().toLowerCase();
  const db = getDb();
  if (!getCompany(db, id)) return res.status(404).json({ error: "公司不存在" });
  try {
    const creds = resolveCredentials(db, id, req.body || {});
    const message = await testApiCredentials(creds);
    res.json({ ok: true, message });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
