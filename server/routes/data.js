const fs = require("fs");
const express = require("express");
const { syncStatePath } = require("../lib/paths");
const { getDb } = require("../db/init");
const { requireLogin, requireAdmin, resolveCompany, requireCompany, requireDataAccess } = require("../middleware");
const { computeMonthlyReport, computeYearlyReport } = require("../lib/monthlyReport");
const { computeCompanyExpenses, computeCompanyExpensesYear } = require("../lib/companyExpenses");
const {
  todayKey,
  parseReportDate,
  computeDashboard,
  saveDailyStats,
  lastNDays,
  listReportDates,
} = require("../services/stats");
const {
  SEGMENTS,
  LEADERBOARD_SORTS,
  inactiveDays,
  dormantMaxDays,
  segmentWhere,
  segmentCounts,
  depositLeaderboardQuery,
} = require("../lib/customerSegments");
const { computeTodayLeaderboard } = require("../lib/todayLeaderboard");
const {
  SORTS: REFERRER_SORTS,
  normalizeDateRange,
  decodeReferrerParam,
  computeReferrerLeaderboard,
  computeReferrerReport,
} = require("../lib/referrerReport");
const { attachCustomerExtras } = require("../lib/customerExtras");
const { customerApiWinLoss } = require("../lib/winLoss");

const { computePromoClaims } = require("../lib/promoClaims");
const { computeCustomerReturnReport } = require("../lib/customerReturnReport");
const { computeDepositChannels } = require("../lib/depositChannels");
const { computeRedepositSummary } = require("../lib/depositKind");
const { backfillPromoNames } = require("../lib/promoBackfill");
const { fetchExportPhones, formatExport } = require("../lib/customerExport");
const { computeCustomerDetail } = require("../lib/customerDetail");

const { getSegmentCountsCached } = require("../lib/segmentCountCache");

const router = express.Router();
router.use(requireLogin);
router.use(resolveCompany);
router.use(requireDataAccess);
router.use(requireCompany);

router.get("/dashboard", (req, res) => {
  const db = getDb();
  const cid = req.companyId;
  const today = todayKey();
  const date = parseReportDate(req.query.date) || today;
  if (req.query.date && !parseReportDate(req.query.date)) {
    return res.status(400).json({ error: "无效日期" });
  }
  const stats = computeDashboard(db, date, cid);
  res.json({
    ...stats,
    companyId: cid,
    companyName: req.companyName,
    isToday: date === today,
  });
});

router.get("/report-dates", (req, res) => {
  const db = getDb();
  const cid = req.companyId;
  const limit = Number(req.query.limit) || 30;
  res.json({ companyId: cid, dates: listReportDates(db, cid, { limit }) });
});

router.get("/sync-status", (req, res) => {
  const p = syncStatePath(req.companyId);
  if (!fs.existsSync(p)) {
    return res.json({ ok: false, message: "never synced", at: null, companyId: req.companyId });
  }
  try {
    const state = JSON.parse(fs.readFileSync(p, "utf8"));
    res.json({ ...state, companyId: req.companyId });
  } catch {
    res.json({ ok: false, message: "sync state unreadable", at: null, companyId: req.companyId });
  }
});

router.get("/trend", (req, res) => {
  const db = getDb();
  const cid = req.companyId;
  const days = Math.min(30, Math.max(3, Number(req.query.days) || 7));
  const today = todayKey();
  res.json({ days, companyId: cid, rows: lastNDays(db, days, cid) });
});

router.get("/transactions", (req, res) => {
  const { q, status, date, type, page = 1, limit = 100 } = req.query;
  const db = getDb();
  const cid = req.companyId;
  const txTypes = ["DEPOSIT", "WITHDRAW", "REDEPOSIT", "BONUS", "MANUAL", "COMMISSION"];
  let sql =
    "SELECT * FROM transactions WHERE company_id = ? AND type IN ('DEPOSIT', 'WITHDRAW', 'BONUS', 'MANUAL', 'COMMISSION')";
  const params = [cid];

  if (type && txTypes.includes(type)) {
    if (type === "REDEPOSIT") {
      sql += " AND type = 'DEPOSIT' AND (LOWER(TRIM(COALESCE(method, ''))) = 'redeposit' OR TRIM(COALESCE(attachment_url, '')) = '')";
    } else {
      sql += " AND type = ?";
      params.push(type);
    }
  }
  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  if (date) {
    sql += " AND created_date = ?";
    params.push(date);
  }
  if (q) {
    sql += " AND (id LIKE ? OR mobile LIKE ? OR name LIKE ? OR username LIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  const countSql = sql.replace("SELECT *", "SELECT COUNT(*) AS n");
  const total = db.prepare(countSql).get(...params).n;
  const pageSize = Math.min(500, Math.max(20, Number(limit) || 100));
  const pageNum = Math.max(1, Number(page) || 1);

  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  const offset = (pageNum - 1) * pageSize;
  params.push(pageSize, offset);

  const rows = db.prepare(sql).all(...params);
  const payload = { total, page: pageNum, limit: pageSize, rows, companyId: cid };
  if (date && (!type || type === "DEPOSIT" || type === "REDEPOSIT")) {
    payload.depositChannels = computeDepositChannels(db, date, cid);
    payload.redepositSummary = computeRedepositSummary(db, date, cid);
    payload.depositChannelDate = date;
  }
  res.json(payload);
});

router.get("/deposits", (req, res) => {
  const { q, status, date, page = 1, limit = 50 } = req.query;
  const db = getDb();
  const cid = req.companyId;
  let sql = "SELECT * FROM transactions WHERE company_id = ? AND type = 'DEPOSIT'";
  const params = [cid];

  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  if (date) {
    sql += " AND created_date = ?";
    params.push(date);
  }
  if (q) {
    sql += " AND (id LIKE ? OR mobile LIKE ? OR name LIKE ? OR username LIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  const countSql = sql.replace("SELECT *", "SELECT COUNT(*) AS n");
  const total = db.prepare(countSql).get(...params).n;

  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  const offset = (Math.max(1, Number(page)) - 1) * Number(limit);
  params.push(Number(limit), offset);

  const rows = db.prepare(sql).all(...params);
  res.json({ total, page: Number(page), rows, companyId: cid });
});

router.get("/withdrawals", (req, res) => {
  const { q, status, date, page = 1, limit = 50 } = req.query;
  const db = getDb();
  const cid = req.companyId;
  let sql = "SELECT * FROM transactions WHERE company_id = ? AND type = 'WITHDRAW'";
  const params = [cid];

  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  if (date) {
    sql += " AND created_date = ?";
    params.push(date);
  }
  if (q) {
    sql += " AND (id LIKE ? OR mobile LIKE ? OR name LIKE ? OR username LIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  const countSql = sql.replace("SELECT *", "SELECT COUNT(*) AS n");
  const total = db.prepare(countSql).get(...params).n;

  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  const offset = (Math.max(1, Number(page)) - 1) * Number(limit);
  params.push(Number(limit), offset);

  const rows = db.prepare(sql).all(...params);
  res.json({ total, page: Number(page), rows, companyId: cid });
});

router.get("/customers", (req, res) => {
  const { q, page = 1, limit = 100, segment = "all", counts: countsParam } = req.query;
  const db = getDb();
  const cid = req.companyId;
  const today = todayKey();
  const seg = SEGMENTS[segment] ? segment : "all";
  const pageSize = Math.min(500, Math.max(20, Number(limit) || 100));
  const pageNum = Math.max(1, Number(page) || 1);
  const includeCounts = countsParam !== "0";

  const where = segmentWhere(seg, today, "c", cid);
  let sql = `SELECT c.* FROM customers c WHERE ${where}`;
  let countSql = `SELECT COUNT(*) AS n FROM customers c WHERE ${where}`;
  const params = [];

  if (q) {
    const search = " AND (c.mobile LIKE ? OR c.name LIKE ? OR c.username LIKE ? OR c.id LIKE ? OR c.referrer LIKE ?)";
    sql += search;
    countSql += search;
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }

  const total = db.prepare(countSql).get(...params).n;

  let orderBy = " ORDER BY c.register_date DESC";
  if (seg === "dep_today") {
    orderBy = " ORDER BY c.last_deposit DESC";
  } else if (seg === "active_depositor") {
    orderBy = " ORDER BY c.last_login_date DESC";
  } else if (seg === "offline_3_7" || seg === "offline_7plus") {
    orderBy = " ORDER BY c.last_login_date ASC";
  }
  sql += orderBy + " LIMIT ? OFFSET ?";
  const offset = (pageNum - 1) * pageSize;
  const rows = attachCustomerExtras(db, db.prepare(sql).all(...params, pageSize, offset), cid).map((c) => ({
    ...c,
    win_loss: customerApiWinLoss(c),
  }));

  res.json({
    total,
    page: pageNum,
    limit: pageSize,
    segment: seg,
    companyId: cid,
    inactiveDays: inactiveDays(),
    dormantMaxDays: dormantMaxDays(),
    counts: includeCounts ? getSegmentCountsCached(db, today, cid) : null,
    rows,
  });
});

router.get("/customer-segment-counts", (req, res) => {
  const db = getDb();
  const cid = req.companyId;
  res.json({ companyId: cid, counts: getSegmentCountsCached(db, todayKey(), cid) });
});

function dayLbHandler(req, res) {
  try {
    const db = getDb();
    const cid = req.companyId;
    const today = todayKey();
    const date = parseReportDate(req.query.date) || today;
    if (req.query.date && !parseReportDate(req.query.date)) {
      return res.status(400).json({ error: "无效日期" });
    }
    const sort = String(req.query.sort || "dep_total");
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 50;
    res.json(computeTodayLeaderboard(db, date, cid, { page, limit, sort }));
  } catch (e) {
    console.error("[day-lb]", e.message);
    res.status(500).json({ error: e.message, date: todayKey(), total: 0, page: 1, pages: 1, rows: [] });
  }
}

router.get("/today-deposit-leaderboard", dayLbHandler);
router.get("/today-customer-leaderboard", dayLbHandler);
router.get("/day-leaderboard", dayLbHandler);

router.get("/deposit-leaderboard", (req, res) => {
  const { q, page = 1, limit = 100, sort = "total" } = req.query;
  const db = getDb();
  const cid = req.companyId;
  const sortKey = LEADERBOARD_SORTS[sort] ? sort : "total";
  const pageSize = Math.min(500, Math.max(20, Number(limit) || 100));
  const pageNum = Math.max(1, Number(page) || 1);
  const { select, orderBy, params, countSql } = depositLeaderboardQuery(sortKey, q, cid);
  const total = db.prepare(countSql).get(...params).n;

  const sql = `${select} ${orderBy} LIMIT ? OFFSET ?`;
  const offset = (pageNum - 1) * pageSize;
  const rows = attachCustomerExtras(db, db.prepare(sql).all(...params, pageSize, offset), cid);

  res.json({ total, page: pageNum, limit: pageSize, sort: sortKey, companyId: cid, rows });
});

router.post("/promo-claims/backfill", async (req, res) => {
  try {
    const db = getDb();
    const result = await backfillPromoNames(db, { companyId: req.companyId });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("[promo-backfill]", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/promo-claims", (req, res) => {
  try {
    const db = getDb();
    const cid = req.companyId;
    const today = todayKey();
    const dateFrom = req.query.dateFrom || req.query.start || req.query.date || today;
    const dateTo = req.query.dateTo || req.query.end || req.query.date || dateFrom;
    res.json(computePromoClaims(db, dateFrom, dateTo, { q: req.query.q, companyId: cid }));
  } catch (e) {
    console.error("[promo-claims]", e.message);
    res.status(500).json({ error: e.message, date: todayKey(), total: 0, rows: [] });
  }
});

router.get("/referrer-leaderboard", (req, res) => {
  try {
    const db = getDb();
    const cid = req.companyId;
    const { dateFrom, dateTo } = normalizeDateRange(
      req.query.dateFrom || req.query.start || req.query.date,
      req.query.dateTo || req.query.end || req.query.date
    );
    const sort = REFERRER_SORTS[req.query.sort] ? req.query.sort : "first_dep";
    res.json(computeReferrerLeaderboard(db, dateFrom, dateTo, { sort, q: req.query.q, companyId: cid }));
  } catch (e) {
    console.error("[referrer-lb]", e.message);
    res.status(500).json({ error: e.message, date: todayKey(), total: 0, rows: [] });
  }
});

router.get("/customer-return-report", (req, res) => {
  try {
    const db = getDb();
    const cid = req.companyId;
    const today = todayKey();
    const dateFrom = req.query.dateFrom || req.query.start || req.query.date || today;
    const dateTo = req.query.dateTo || req.query.end || req.query.date || dateFrom;
    const segment = ["all", "gap_3", "gap_7"].includes(req.query.segment) ? req.query.segment : "all";
    res.json(computeCustomerReturnReport(db, dateFrom, dateTo, { segment, q: req.query.q, companyId: cid }));
  } catch (e) {
    console.error("[customer-return]", e.message);
    res.status(500).json({ error: e.message, date: todayKey(), total: 0, rows: [] });
  }
});

router.get("/referrer-report", (req, res) => {
  try {
    const db = getDb();
    const cid = req.companyId;
    const { dateFrom, dateTo } = normalizeDateRange(
      req.query.dateFrom || req.query.start || req.query.date,
      req.query.dateTo || req.query.end || req.query.date
    );
    const { key } = decodeReferrerParam(req.query.referrer || "");
    const segment = ["all", "new_today", "first_dep_today"].includes(req.query.segment)
      ? req.query.segment
      : "all";
    res.json(computeReferrerReport(db, key, dateFrom, dateTo, { segment, companyId: cid }));
  } catch (e) {
    console.error("[referrer-report]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// 月报含盈亏，仅 admin。requireDataAccess 已挡掉 operator，这里再显式要求一次，
// 免得以后加新角色时被默认放行。?year=YYYY 返回年视图，否则 ?month=YYYY-MM。
router.get("/monthly-report", requireAdmin, (req, res) => {
  try {
    const db = getDb();
    const cid = req.companyId;
    const report = req.query.year
      ? computeYearlyReport(db, cid, { year: req.query.year })
      : computeMonthlyReport(db, cid, { month: req.query.month });
    res.json({ companyId: cid, ...report });
  } catch (e) {
    console.error("[monthly-report]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// 往来账（COMPANY EXPENSES）：本公司与各 C STATUS 往来方的按日 NET，仅 admin、只读本公司。
// 口径见 CONTEXT.md「往来账」。?year=YYYY 返回年视图，否则 ?month=YYYY-MM。
router.get("/company-expenses", requireAdmin, (req, res) => {
  try {
    const db = getDb();
    const cid = req.companyId;
    const report = req.query.year
      ? computeCompanyExpensesYear(db, cid, { year: req.query.year })
      : computeCompanyExpenses(db, cid, { month: req.query.month });
    res.json({ companyId: cid, ...report });
  } catch (e) {
    console.error("[company-expenses]", e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get("/customers/export", (req, res) => {
  try {
    const db = getDb();
    const cid = req.companyId;
    const rows = fetchExportPhones(db, req.query.segments, req.query.q, cid);
    const { body, ext, mime } = formatExport(req.query.format, rows);
    const stamp = todayKey();
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="phones-${cid}-${stamp}.${ext}"`);
    res.send(body);
  } catch (e) {
    console.error("[customers/export]", e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get("/customer-detail", (req, res) => {
  try {
    const db = getDb();
    const cid = req.companyId;
    const detail = computeCustomerDetail(db, cid, {
      id: req.query.id,
      mobile: req.query.mobile,
    });
    if (!detail) return res.status(404).json({ error: "客户不存在" });
    res.json(detail);
  } catch (e) {
    console.error("[customer-detail]", e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get("/customers/:id", (req, res) => {
  try {
    const db = getDb();
    const cid = req.companyId;
    const detail = computeCustomerDetail(db, cid, { id: req.params.id, mobile: req.query.mobile });
    if (!detail) return res.status(404).json({ error: "客户不存在" });
    res.json(detail);
  } catch (e) {
    console.error("[customers/:id]", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
