const { testUsernameSql, TX_CUSTOMER_JOIN } = require("./winLoss");
const { cleanDisplayName } = require("./displayName");

const SORTS = {
  dep_total: { sql: "dep_total DESC, dep_count DESC", label: "充值总额" },
  dep_count: { sql: "dep_count DESC, dep_total DESC", label: "充值笔数" },
  max_single: { sql: "max_single DESC, dep_total DESC", label: "最大单笔" },
  last_dep: { sql: "last_deposit DESC", label: "最后充值" },
  win_loss: { sql: "win_loss DESC, dep_total DESC", label: "今日输赢" },
};

const MAX_PAGES = 10;
const DEFAULT_LIMIT = 50;

function customerKeySql() {
  return "COALESCE(NULLIF(TRIM(t.customer_id), ''), NULLIF(TRIM(t.mobile), ''))";
}

function mapRow(r) {
  return {
    customer_id: r.customer_key,
    name: cleanDisplayName(r.name),
    mobile: r.mobile,
    referrer: r.referrer,
    dep_count: r.dep_count,
    dep_total: r.dep_total,
    max_single: r.max_single,
    last_deposit: r.last_deposit,
    wd_count: r.wd_count,
    wd_total: r.wd_total,
    last_withdraw: r.last_withdraw,
    win_loss: Number(r.win_loss != null ? r.win_loss : Number(r.dep_total || 0) - Number(r.wd_total || 0)),
  };
}

function computeTodayLeaderboard(db, today, companyId, opts = {}) {
  const ck = customerKeySql();
  const testFilter = ` AND ${testUsernameSql("t", "c")}`;
  const baseFrom = `
    FROM transactions t
    ${TX_CUSTOMER_JOIN}
    WHERE t.company_id = ? AND t.created_date = ?
      AND t.type IN ('DEPOSIT', 'WITHDRAW')
      AND ${ck} IS NOT NULL AND ${ck} != ''
      ${testFilter}`;

  const aggSelect = `
    SELECT
      ${ck} AS customer_key,
      COALESCE(MAX(c.name), MAX(t.name), MAX(t.username), '-') AS name,
      COALESCE(MAX(c.mobile), MAX(t.mobile), '-') AS mobile,
      COALESCE(MAX(c.referrer), '') AS referrer,
      SUM(CASE WHEN t.type = 'DEPOSIT' THEN 1 ELSE 0 END) AS dep_count,
      COALESCE(SUM(CASE WHEN t.type = 'DEPOSIT' THEN t.amount ELSE 0 END), 0) AS dep_total,
      COALESCE(MAX(CASE WHEN t.type = 'DEPOSIT' THEN t.amount END), 0) AS max_single,
      MAX(CASE WHEN t.type = 'DEPOSIT' THEN t.created_at END) AS last_deposit,
      SUM(CASE WHEN t.type = 'WITHDRAW' THEN 1 ELSE 0 END) AS wd_count,
      COALESCE(SUM(CASE WHEN t.type = 'WITHDRAW' THEN t.amount ELSE 0 END), 0) AS wd_total,
      MAX(CASE WHEN t.type = 'WITHDRAW' THEN t.created_at END) AS last_withdraw,
      COALESCE(SUM(CASE WHEN t.type = 'DEPOSIT' THEN t.amount ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN t.type = 'WITHDRAW' THEN t.amount ELSE 0 END), 0) AS win_loss
    ${baseFrom}
    GROUP BY ${ck}
    HAVING COALESCE(SUM(CASE WHEN t.type = 'DEPOSIT' THEN t.amount ELSE 0 END), 0) > 0`;

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM (${aggSelect})`)
    .get(companyId, today).n;

  const sortKey = SORTS[opts.sort] ? opts.sort : "dep_total";
  const limit = Math.min(DEFAULT_LIMIT, Math.max(1, Number(opts.limit) || DEFAULT_LIMIT));
  let page = Math.max(1, Number(opts.page) || 1);
  const maxPage = Math.max(1, Math.min(Math.ceil(total / limit) || 1, MAX_PAGES));
  if (page > maxPage) page = maxPage;
  const offset = (page - 1) * limit;
  const orderSql = SORTS[sortKey].sql;

  const rows = db
    .prepare(`${aggSelect} ORDER BY ${orderSql} LIMIT ? OFFSET ?`)
    .all(companyId, today, limit, offset)
    .map(mapRow);

  return {
    date: today,
    total,
    page,
    limit,
    pages: maxPage,
    sort: sortKey,
    sortLabel: SORTS[sortKey].label,
    rows,
  };
}

module.exports = { computeTodayLeaderboard, SORTS, DEFAULT_LIMIT, MAX_PAGES };
