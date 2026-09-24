function customerIdExpr(cAlias = "c") {
  return `COALESCE(NULLIF(t.customer_id, ''), ${cAlias}.id)`;
}

function customerJoin(cAlias = "c") {
  return `LEFT JOIN customers ${cAlias} ON ${cAlias}.company_id = t.company_id
  AND (t.customer_id IS NULL OR t.customer_id = '')
  AND t.mobile IS NOT NULL AND t.mobile != ''
  AND ${cAlias}.mobile = t.mobile`;
}

const CUSTOMER_ID_EXPR = customerIdExpr("c");
const CUSTOMER_JOIN = customerJoin("c");

const TX_CUSTOMER_JOIN = "LEFT JOIN customers c ON c.company_id = t.company_id AND c.id = t.customer_id";

function testUsernameSql(txAlias = "t", customerAlias = "c") {
  const tx = txAlias ? `${txAlias}.` : "";
  const cx = customerAlias ? `${customerAlias}.` : "";
  const userPart = customerAlias
    ? `LOWER(COALESCE(NULLIF(TRIM(${tx}username), ''), ${cx}username, '')) NOT LIKE '%test%'`
    : `LOWER(COALESCE(${tx}username, '')) NOT LIKE '%test%'`;
  const namePart = customerAlias
    ? `LOWER(COALESCE(NULLIF(TRIM(${tx}name), ''), ${cx}name, '')) NOT LIKE '%test%'`
    : `LOWER(COALESCE(${tx}name, '')) NOT LIKE '%test%'`;
  return `(${userPart} AND ${namePart})`;
}

/** @deprecated use testUsernameSql */
function testNameExclude(col = "t") {
  return testUsernameSql(col, null);
}

function testCustomerUsernameSql(alias = "c") {
  return `(LOWER(COALESCE(${alias}.username, '')) NOT LIKE '%test%' AND LOWER(COALESCE(${alias}.name, '')) NOT LIKE '%test%')`;
}


function sumDepWinLoss(alias = "t") {
  return `COALESCE(SUM(CASE WHEN ${alias}.type = 'DEPOSIT' AND ${testUsernameSql(alias, "c")} THEN ${alias}.amount ELSE 0 END), 0)`;
}

function sumWdWinLoss(alias = "t") {
  return `COALESCE(SUM(CASE WHEN ${alias}.type = 'WITHDRAW' AND ${testUsernameSql(alias, "c")} THEN ${alias}.amount ELSE 0 END), 0)`;
}

function winLossSubquery() {
  return `(${sumDepWinLoss("t")} - ${sumWdWinLoss("t")})`;
}

function attachWinLoss(db, customers, companyId) {
  if (!customers?.length) return customers;
  const ids = [...new Set(customers.map((c) => c.id).filter(Boolean))];
  if (!ids.length) return customers;

  const ph = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT ${CUSTOMER_ID_EXPR} AS customer_id,
              ${sumDepWinLoss("t")} AS dep_wl,
              ${sumWdWinLoss("t")} AS wd_wl
       FROM transactions t
       ${CUSTOMER_JOIN}
       WHERE t.company_id = ? AND ${CUSTOMER_ID_EXPR} IN (${ph})
         AND t.type IN ('DEPOSIT', 'WITHDRAW')
       GROUP BY ${CUSTOMER_ID_EXPR}`
    )
    .all(companyId, ...ids);

  const map = Object.fromEntries(
    rows.map((r) => [r.customer_id, Number(r.dep_wl || 0) - Number(r.wd_wl || 0)])
  );
  for (const c of customers) {
    c.win_loss = map[c.id] ?? 0;
  }
  return customers;
}

function referrerNetTotals(db, opts = {}) {
  const { dateFrom, dateTo, companyId } = opts;
  const idExpr = customerIdExpr("cm");
  let sql = `
    SELECT COALESCE(NULLIF(TRIM(c.referrer), ''), '__organic__') AS referrer_key,
           ${sumDepWinLoss("t")} AS dep_wl,
           ${sumWdWinLoss("t")} AS wd_wl
    FROM transactions t
    ${customerJoin("cm")}
    INNER JOIN customers c ON c.company_id = t.company_id AND c.id = ${idExpr}
    WHERE t.company_id = ? AND t.type IN ('DEPOSIT', 'WITHDRAW')`;
  const params = [companyId];
  if (dateFrom && dateTo) {
    sql += " AND t.created_date >= ? AND t.created_date <= ?";
    params.push(dateFrom, dateTo);
  }
  sql += " GROUP BY referrer_key";
  const rows = db.prepare(sql).all(...params);
  return Object.fromEntries(
    rows.map((r) => [r.referrer_key, Number(r.dep_wl || 0) - Number(r.wd_wl || 0)])
  );
}

function computeMonthWinLoss(db, dateKey, companyId, today) {
  const { monthBounds, todayKey } = require("./dates");
  const bounds = monthBounds(dateKey, today || todayKey());
  if (!bounds) return null;
  const row = db
    .prepare(
      `SELECT ${sumDepWinLoss("t")} AS dep_total,
              ${sumWdWinLoss("t")} AS wd_total
       FROM transactions t
       ${TX_CUSTOMER_JOIN}
       WHERE t.company_id = ? AND t.created_date >= ? AND t.created_date <= ?
         AND t.type IN ('DEPOSIT', 'WITHDRAW')`
    )
    .get(companyId, bounds.from, bounds.to);
  const dep = Number(row?.dep_total || 0);
  const wd = Math.abs(Number(row?.wd_total || 0));
  return {
    month: bounds.month,
    label: bounds.label,
    from: bounds.from,
    to: bounds.to,
    isComplete: bounds.isComplete,
    dep,
    wd,
    total: dep - wd,
  };
}

function customerApiWinLoss(customer) {
  const dep = Number(customer?.dep_total || 0);
  const wd = Math.abs(Number(customer?.wd_total || 0));
  return dep - wd;
}

function computeDayWinLoss(db, date, companyId) {
  const row = db
    .prepare(
      `SELECT ${sumDepWinLoss("t")} AS dep_total,
              ${sumWdWinLoss("t")} AS wd_total
       FROM transactions t
       ${TX_CUSTOMER_JOIN}
       WHERE t.company_id = ? AND t.created_date = ?
         AND t.type IN ('DEPOSIT', 'WITHDRAW')`
    )
    .get(companyId, date);
  const dep = Number(row?.dep_total || 0);
  const wd = Math.abs(Number(row?.wd_total || 0));
  return { dep, wd, total: dep - wd };
}

function computeDayWinLossRaw(db, date, companyId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN t.type = 'DEPOSIT' THEN t.amount ELSE 0 END), 0) AS dep_total,
              COALESCE(SUM(CASE WHEN t.type = 'WITHDRAW' THEN t.amount ELSE 0 END), 0) AS wd_total
       FROM transactions t
       WHERE t.company_id = ? AND t.created_date = ?
         AND t.type IN ('DEPOSIT', 'WITHDRAW')`
    )
    .get(companyId, date);
  const dep = Number(row?.dep_total || 0);
  const wd = Math.abs(Number(row?.wd_total || 0));
  return { dep, wd, total: dep - wd };
}

function refreshAllCustomerWinLoss(db, companyId) {
  const ids = db.prepare("SELECT id FROM customers WHERE company_id = ?").all(companyId).map((r) => r.id);
  let n = 0;
  for (const id of ids) {
    refreshCustomerWinLoss(db, companyId, id);
    n++;
  }
  return n;
}

function refreshCustomerWinLoss(db, companyId, customerId) {
  const row = db
    .prepare(
      `SELECT ${sumDepWinLoss("t")} AS dep_wl, ${sumWdWinLoss("t")} AS wd_wl
       FROM transactions t
       ${CUSTOMER_JOIN}
       WHERE t.company_id = ? AND ${CUSTOMER_ID_EXPR} = ?
         AND t.type IN ('DEPOSIT', 'WITHDRAW')`
    )
    .get(companyId, customerId);
  const winLoss = Number(row?.dep_wl || 0) - Number(row?.wd_wl || 0);
  db.prepare("UPDATE customers SET win_loss = ? WHERE company_id = ? AND id = ?").run(winLoss, companyId, customerId);
  return winLoss;
}

module.exports = {
  customerIdExpr,
  customerJoin,
  CUSTOMER_ID_EXPR,
  CUSTOMER_JOIN,
  testNameExclude,
  testUsernameSql,
  testCustomerUsernameSql,
  TX_CUSTOMER_JOIN,
  sumDepWinLoss,
  sumWdWinLoss,
  winLossSubquery,
  attachWinLoss,
  customerApiWinLoss,
  computeDayWinLoss,
  computeMonthWinLoss,
  computeDayWinLossRaw,
  referrerNetTotals,
  refreshCustomerWinLoss,
  refreshAllCustomerWinLoss,
};
