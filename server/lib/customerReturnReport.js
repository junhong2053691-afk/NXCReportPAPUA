const { todayKey, shiftDateKey } = require("./dates");
const { inactiveDays, dormantMaxDays } = require("./customerSegments");
const { testNameExclude } = require("./winLoss");

const MAX_RANGE_DAYS = 90;
const MAX_TREND_DAYS = 31;

const SEGMENTS = {
  all: "all",
  gap_3: "gap_3",
  gap_7: "gap_7",
};

function daysBetween(start, end) {
  const [y1, m1, d1] = start.split("-").map(Number);
  const [y2, m2, d2] = end.split("-").map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.floor((b - a) / 86400000) + 1;
}

function normalizeDateRange(from, to) {
  const today = todayKey();
  let dateFrom = String(from || to || today).trim();
  let dateTo = String(to || from || today).trim();
  if (dateFrom > dateTo) {
    const tmp = dateFrom;
    dateFrom = dateTo;
    dateTo = tmp;
  }
  if (daysBetween(dateFrom, dateTo) > MAX_RANGE_DAYS) {
    dateFrom = shiftDateKey(dateTo, -(MAX_RANGE_DAYS - 1));
  }
  return {
    dateFrom,
    dateTo,
    date: dateFrom === dateTo ? dateFrom : dateFrom + " ~ " + dateTo,
  };
}

function segmentGapFilter(segment) {
  switch (segment) {
    case "gap_3":
      return (r) => r.silent_days >= 3 && r.silent_days < 7;
    case "gap_7":
      return (r) => r.silent_days >= 7;
    default:
      return (r) => r.silent_days >= 3;
  }
}

function customerKeySql(alias = "t") {
  return `COALESCE(NULLIF(TRIM(${alias}.customer_id), ''), NULLIF(TRIM(${alias}.mobile), ''))`;
}

function poolCounts(db, today, companyId) {
  const activeCutoff = shiftDateKey(today, -inactiveDays());
  const dormantCutoff = shiftDateKey(today, -dormantMaxDays());
  const dep =
    "(COALESCE(c.dep_total,0) > 0 OR COALESCE(c.dep_count,0) > 0 OR (c.last_deposit IS NOT NULL AND c.last_deposit != ''))";
  const offline37 = db
    .prepare(
      `SELECT COUNT(*) AS n FROM customers c
       WHERE c.company_id = ? AND ${dep}
         AND c.last_login_date IS NOT NULL AND c.last_login_date != ''
         AND c.last_login_date <= ? AND c.last_login_date > ?`
    )
    .get(companyId, activeCutoff, dormantCutoff).n;
  const offline7plus = db
    .prepare(
      `SELECT COUNT(*) AS n FROM customers c
       WHERE c.company_id = ? AND ${dep}
         AND (c.last_login_date IS NULL OR c.last_login_date = '' OR c.last_login_date <= ?)`
    )
    .get(companyId, dormantCutoff).n;
  return { offline_3_7: offline37, offline_7plus: offline7plus };
}

function queryReturns(db, companyId, dateFrom, dateTo, minGap) {
  const testFilter = testNameExclude("t");
  const ck = customerKeySql("t");
  const ck2 = customerKeySql("t2");
  return db
    .prepare(
      `WITH range_deps AS (
         SELECT
           t.id AS tx_id,
           t.created_date,
           t.created_at,
           t.amount,
           t.name AS tx_name,
           t.mobile,
           ${ck} AS ck
         FROM transactions t
         WHERE t.company_id = ? AND t.type = 'DEPOSIT'
           AND t.created_date >= ? AND t.created_date <= ?
           AND ${testFilter}
           AND ${ck} IS NOT NULL AND ${ck} != ''
       ),
       with_prev AS (
         SELECT r.*,
           (
             SELECT MAX(t2.created_date)
             FROM transactions t2
             WHERE t2.company_id = ?
               AND t2.type = 'DEPOSIT'
               AND ${testNameExclude("t2")}
               AND ${ck2} = r.ck
               AND t2.created_at < r.created_at
           ) AS prev_dep_date
         FROM range_deps r
       ),
       returns AS (
         SELECT *,
           CAST(julianday(created_date) - julianday(prev_dep_date) AS INTEGER) AS silent_days
         FROM with_prev
         WHERE prev_dep_date IS NOT NULL
           AND julianday(created_date) - julianday(prev_dep_date) >= ?
       )
       SELECT
         r.ck,
         MIN(r.prev_dep_date) AS prev_dep_date,
         MAX(r.silent_days) AS silent_days,
         COUNT(*) AS return_dep_count,
         COALESCE(SUM(r.amount), 0) AS return_dep_total,
         MIN(r.created_date) AS first_return_date,
         MAX(r.created_at) AS last_return_at,
         MAX(r.tx_name) AS tx_name
       FROM returns r
       GROUP BY r.ck`
    )
    .all(companyId, dateFrom, dateTo, companyId, minGap);
}

function queryTrend(db, companyId, trendStart, dateTo) {
  const ck = customerKeySql("t");
  const ck2 = customerKeySql("t2");
  return db
    .prepare(
      `WITH range_deps AS (
         SELECT t.created_date, t.created_at, ${ck} AS ck
         FROM transactions t
         WHERE t.company_id = ? AND t.type = 'DEPOSIT'
           AND t.created_date >= ? AND t.created_date <= ?
           AND ${testNameExclude("t")}
           AND ${ck} IS NOT NULL
       ),
       with_prev AS (
         SELECT r.created_date, r.ck,
           (
             SELECT MAX(t2.created_date)
             FROM transactions t2
             WHERE t2.company_id = ?
               AND t2.type = 'DEPOSIT'
               AND ${testNameExclude("t2")}
               AND ${ck2} = r.ck
               AND t2.created_at < r.created_at
           ) AS prev_dep_date
         FROM range_deps r
       ),
       returns AS (
         SELECT created_date, ck
         FROM with_prev
         WHERE prev_dep_date IS NOT NULL
           AND julianday(created_date) - julianday(prev_dep_date) >= 3
       )
       SELECT created_date AS date,
              COUNT(DISTINCT ck) AS users,
              COUNT(*) AS dep_count
       FROM returns
       GROUP BY created_date
       ORDER BY created_date`
    )
    .all(companyId, trendStart, dateTo, companyId);
}

function computeCustomerReturnReport(db, dateFrom, dateTo, opts = {}) {
  const companyId = opts.companyId;
  const range = normalizeDateRange(dateFrom, dateTo);
  const segment = SEGMENTS[opts.segment] ? opts.segment : "all";
  const minGap = segment === "gap_7" ? 7 : 3;
  const q = String(opts.q || "").trim();
  const gapFn = segmentGapFilter(segment);

  let returnRows = queryReturns(db, companyId, range.dateFrom, range.dateTo, minGap);
  if (segment !== "all") returnRows = returnRows.filter((r) => gapFn(r));

  const keys = returnRows.map((r) => r.ck);
  const byKey = {};
  if (keys.length) {
    const ph = keys.map(() => "?").join(",");
    const customers = db
      .prepare(
        `SELECT id, name, mobile, referrer, last_login_date, last_deposit, dep_count, dep_total, wd_total
         FROM customers
         WHERE company_id = ? AND (id IN (${ph}) OR mobile IN (${ph}))`
      )
      .all(companyId, ...keys, ...keys);
    for (const c of customers) {
      byKey[c.id] = c;
      if (c.mobile) byKey[c.mobile] = c;
    }
  }

  let rows = returnRows.map((r) => {
    const c = byKey[r.ck] || {};
    return {
      customer_id: c.id || r.ck,
      name: c.name || r.tx_name || "-",
      mobile: c.mobile || (String(r.ck).match(/^\d+$/) ? r.ck : "-"),
      referrer: c.referrer || "-",
      silent_days: r.silent_days,
      prev_dep_date: r.prev_dep_date,
      first_return_date: r.first_return_date,
      return_dep_count: r.return_dep_count,
      return_dep_total: Math.round(r.return_dep_total * 100) / 100,
      last_login_date: c.last_login_date || "",
      last_deposit: c.last_deposit || "",
      dep_total: c.dep_total || 0,
      wd_total: c.wd_total || 0,
    };
  });

  if (q) {
    const like = q.toLowerCase();
    rows = rows.filter(
      (r) =>
        String(r.name || "").toLowerCase().includes(like) ||
        String(r.mobile || "").includes(q) ||
        String(r.referrer || "").toLowerCase().includes(like)
    );
  }

  rows.sort((a, b) => b.return_dep_total - a.return_dep_total || b.silent_days - a.silent_days);

  const trendStart =
    daysBetween(range.dateFrom, range.dateTo) <= MAX_TREND_DAYS
      ? range.dateFrom
      : shiftDateKey(range.dateTo, -(MAX_TREND_DAYS - 1));
  const trendRaw = queryTrend(db, companyId, trendStart, range.dateTo);
  const trendMap = Object.fromEntries(trendRaw.map((r) => [r.date, r]));
  const trend = [];
  let d = trendStart;
  while (d <= range.dateTo) {
    const hit = trendMap[d];
    trend.push({ date: d, users: hit?.users || 0, dep_count: hit?.dep_count || 0 });
    d = shiftDateKey(d, 1);
  }

  const today = todayKey();
  const pools = poolCounts(db, today, companyId);
  const returnUsers = rows.length;
  const returnDepCount = rows.reduce((s, r) => s + r.return_dep_count, 0);
  const returnDepTotal = rows.reduce((s, r) => s + r.return_dep_total, 0);
  const recoverPool = pools.offline_7plus || 0;
  const returnRate =
    returnUsers + recoverPool > 0
      ? Math.round((returnUsers / (returnUsers + recoverPool)) * 1000) / 10
      : 0;

  return {
    ...range,
    segment,
    minGapDays: minGap,
    summary: {
      return_users: returnUsers,
      return_dep_count: returnDepCount,
      return_dep_total: Math.round(returnDepTotal * 100) / 100,
      recover_pool: recoverPool,
      offline_3_7: pools.offline_3_7 || 0,
      return_rate_pct: returnRate,
    },
    pools,
    trend,
    rows,
    total: rows.length,
    hint:
      segment === "gap_7"
        ? "沉默 7 天及以上后再次充值"
        : segment === "gap_3"
        ? "沉默 3~6 天后再次充值"
        : "沉默 3 天及以上后再次充值（回流）",
  };
}

module.exports = {
  SEGMENTS,
  normalizeDateRange,
  computeCustomerReturnReport,
};
