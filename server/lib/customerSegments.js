const { readConfig } = require("./readConfig");
const { todayKey, shiftDateKey } = require("./dates");
const { testUsernameSql, TX_CUSTOMER_JOIN } = require("./winLoss");

const SEGMENTS = {
  all: "all",
  dep_today: "dep_today",
  never_deposited: "never_deposited",
  active_depositor: "active_depositor",
  offline_3_7: "offline_3_7",
  offline_7plus: "offline_7plus",
};

function inactiveDays() {
  const cfg = readConfig();
  return Math.max(1, Number(cfg.customerInactiveDays || 2));
}

function dormantMaxDays() {
  const cfg = readConfig();
  return Math.max(3, Number(cfg.customerDormantMaxDays || 7));
}

function depositedSql(prefix = "", _companyId = "") {
  const p = prefix ? `${prefix}.` : "";
  return `(COALESCE(${p}dep_total, 0) > 0 OR COALESCE(${p}dep_count, 0) > 0 OR (${p}last_deposit IS NOT NULL AND ${p}last_deposit != ''))`;
}

function depTodaySql(prefix, today, companyId) {
  const p = prefix ? `${prefix}.` : "";
  const cid = String(companyId).replace(/'/g, "''");
  const testFilter = ` AND ${testUsernameSql("t", "c")}`;
  return `(${p}id IN (
    SELECT DISTINCT t.customer_id FROM transactions t ${TX_CUSTOMER_JOIN}
    WHERE t.company_id = '${cid}' AND t.type = 'DEPOSIT' AND t.created_date = '${today}'
      AND COALESCE(NULLIF(TRIM(t.customer_id), ''), '') != ''${testFilter}
  ) OR (${p}mobile != '' AND ${p}mobile IN (
    SELECT DISTINCT t.mobile FROM transactions t ${TX_CUSTOMER_JOIN}
    WHERE t.company_id = '${cid}' AND t.type = 'DEPOSIT' AND t.created_date = '${today}'
      AND COALESCE(NULLIF(TRIM(t.customer_id), ''), '') = ''
      AND COALESCE(NULLIF(TRIM(t.mobile), ''), '') != ''${testFilter}
  )))`;
}

function segmentWhere(segment, today = todayKey(), prefix = "", companyId = "") {
  const dep = depositedSql(prefix, companyId);
  const p = prefix ? `${prefix}.` : "";
  const activeCutoff = shiftDateKey(today, -inactiveDays());
  const dormantCutoff = shiftDateKey(today, -dormantMaxDays());
  const co = companyId ? `${p}company_id = '${String(companyId).replace(/'/g, "''")}' AND ` : "";

  switch (segment) {
    case "dep_today":
      return co + depTodaySql(prefix, today, companyId);
    case "never_deposited":
      return co + `NOT (${dep})`;
    case "active_depositor":
      return (
        co +
        `${dep} AND ${p}last_login_date IS NOT NULL AND ${p}last_login_date != '' AND ${p}last_login_date > '${activeCutoff}' AND ${p}last_login_date <= '${today}'`
      );
    case "offline_3_7":
      return (
        co +
        `${dep} AND ${p}last_login_date IS NOT NULL AND ${p}last_login_date != '' AND ${p}last_login_date <= '${activeCutoff}' AND ${p}last_login_date > '${dormantCutoff}'`
      );
    case "offline_7plus":
      return co + `${dep} AND (${p}last_login_date IS NULL OR ${p}last_login_date = '' OR ${p}last_login_date <= '${dormantCutoff}')`;
    default:
      return co ? co.slice(0, -5) : "1=1";
  }
}

function segmentCounts(db, today = todayKey(), companyId) {
  const dep = depositedSql("c", companyId);
  const activeCutoff = shiftDateKey(today, -inactiveDays());
  const dormantCutoff = shiftDateKey(today, -dormantMaxDays());
  const row = db
    .prepare(
      `SELECT
        COUNT(*) AS all_n,
        SUM(CASE WHEN dep.cust_id IS NOT NULL THEN 1 ELSE 0 END) AS dep_today,
        SUM(CASE WHEN NOT (${dep}) THEN 1 ELSE 0 END) AS never_deposited,
        SUM(CASE WHEN (${dep}) AND c.last_login_date IS NOT NULL AND c.last_login_date != ''
          AND c.last_login_date > ? AND c.last_login_date <= ? THEN 1 ELSE 0 END) AS active_depositor,
        SUM(CASE WHEN (${dep}) AND c.last_login_date IS NOT NULL AND c.last_login_date != ''
          AND c.last_login_date <= ? AND c.last_login_date > ? THEN 1 ELSE 0 END) AS offline_3_7,
        SUM(CASE WHEN (${dep}) AND (c.last_login_date IS NULL OR c.last_login_date = '' OR c.last_login_date <= ?) THEN 1 ELSE 0 END) AS offline_7plus
      FROM customers c
      LEFT JOIN (
        SELECT DISTINCT COALESCE(NULLIF(TRIM(t.customer_id), ''), c2.id) AS cust_id
        FROM transactions t
        LEFT JOIN customers c2 ON c2.company_id = t.company_id AND c2.id = t.customer_id
        WHERE t.company_id = ? AND t.type = 'DEPOSIT' AND t.created_date = ?
          AND COALESCE(NULLIF(TRIM(t.customer_id), ''), NULLIF(TRIM(t.mobile), '')) IS NOT NULL
          AND COALESCE(NULLIF(TRIM(t.customer_id), ''), NULLIF(TRIM(t.mobile), '')) != ''
          AND ${testUsernameSql("t", "c2")}
      ) dep ON dep.cust_id = c.id
      WHERE c.company_id = ?`
    )
    .get(activeCutoff, today, activeCutoff, dormantCutoff, dormantCutoff, companyId, today, companyId);

  return {
    all: row.all_n || 0,
    dep_today: row.dep_today || 0,
    never_deposited: row.never_deposited || 0,
    active_depositor: row.active_depositor || 0,
    offline_3_7: row.offline_3_7 || 0,
    offline_7plus: row.offline_7plus || 0,
  };
}

const LEADERBOARD_SORTS = {
  total: "total",
  volume: "volume",
  max_single: "max_single",
};

function depositLeaderboardWhere(sort, q, companyId) {
  const deposited = depositedSql("c", companyId);
  const params = [companyId];
  let where = `WHERE c.company_id = ? AND ${deposited}`;
  if (q) {
    where += " AND (c.mobile LIKE ? OR c.name LIKE ? OR c.username LIKE ? OR c.id LIKE ? OR c.referrer LIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  return { where, params, sort };
}

function depositLeaderboardQuery(sort, q, companyId) {
  const { where, params } = depositLeaderboardWhere(sort, q, companyId);
  const cid = String(companyId).replace(/'/g, "''");

  if (sort === "max_single") {
    const txJoin = `LEFT JOIN (
      SELECT customer_id, MAX(amount) AS max_single_deposit
      FROM transactions
      WHERE company_id = '${cid}' AND type = 'DEPOSIT' AND COALESCE(customer_id, '') != ''
      GROUP BY customer_id
    ) tx ON c.id = tx.customer_id`;
    const select = `SELECT c.*,
      COALESCE(tx.max_single_deposit, 0) AS max_single_deposit,
      COALESCE(NULLIF(TRIM(c.last_deposit), ''), '') AS last_deposit_show,
      COALESCE(NULLIF(TRIM(c.last_login), ''), NULLIF(TRIM(c.last_login_date), '')) AS last_login_show
      FROM customers c ${txJoin} ${where}`;
    const orderBy = "ORDER BY COALESCE(tx.max_single_deposit, 0) DESC, c.dep_total DESC";
    return { select, orderBy, params, countSql: `SELECT COUNT(*) AS n FROM customers c ${where}` };
  }

  const select = `SELECT c.*,
    COALESCE(NULLIF(TRIM(c.last_deposit), ''), '') AS last_deposit_show,
    COALESCE(NULLIF(TRIM(c.last_login), ''), NULLIF(TRIM(c.last_login_date), '')) AS last_login_show
    FROM customers c ${where}`;
  let orderBy = "ORDER BY c.dep_total DESC, c.dep_count DESC";
  if (sort === "volume") orderBy = "ORDER BY c.dep_count DESC, c.dep_total DESC";
  return { select, orderBy, params, countSql: `SELECT COUNT(*) AS n FROM customers c ${where}` };
}

module.exports = {
  SEGMENTS,
  LEADERBOARD_SORTS,
  inactiveDays,
  dormantMaxDays,
  depositedSql,
  segmentWhere,
  segmentCounts,
  depositLeaderboardQuery,
  depositLeaderboardWhere,
};
