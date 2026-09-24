const { CUSTOMER_ID_EXPR, CUSTOMER_JOIN, testUsernameSql } = require("./winLoss");

function attachCustomerTxStats(db, customers, companyId) {
  if (!customers?.length) return customers;
  const ids = [...new Set(customers.map((c) => c.id).filter(Boolean))];
  if (!ids.length) return customers;

  const ph = ids.map(() => "?").join(",");
  // Use the SAME identity + test-account exclusion rules as the aggregate dashboards
  // (winLoss.js): resolve the customer via customer_id with a mobile fallback join, and
  // drop test accounts. Otherwise per-customer numbers here drift from the home totals.
  const rows = db
    .prepare(
      `SELECT ${CUSTOMER_ID_EXPR} AS customer_id,
        SUM(CASE WHEN t.type = 'DEPOSIT' THEN 1 ELSE 0 END) AS dep_count,
        COALESCE(SUM(CASE WHEN t.type = 'DEPOSIT' THEN t.amount ELSE 0 END), 0) AS dep_total,
        COALESCE(SUM(CASE WHEN t.type = 'WITHDRAW' THEN t.amount ELSE 0 END), 0) AS wd_total,
        MAX(CASE WHEN t.type = 'DEPOSIT' THEN t.created_at END) AS last_deposit
       FROM transactions t
       ${CUSTOMER_JOIN}
       WHERE t.company_id = ? AND ${CUSTOMER_ID_EXPR} IN (${ph})
         AND t.type IN ('DEPOSIT', 'WITHDRAW')
         AND ${testUsernameSql("t", "c")}
       GROUP BY ${CUSTOMER_ID_EXPR}`
    )
    .all(companyId, ...ids);

  const map = Object.fromEntries(rows.map((r) => [r.customer_id, r]));
  for (const c of customers) {
    const t = map[c.id];
    if (!t) continue;
    if (Number(t.dep_count) > 0) c.dep_count = Number(t.dep_count);
    if (Number(t.dep_total) > 0) c.dep_total = Number(t.dep_total);
    if (Number(t.wd_total) !== 0) c.wd_total = Math.abs(Number(t.wd_total));
    if (t.last_deposit) c.last_deposit = t.last_deposit;
    c.win_loss = Number(c.dep_total || 0) - Math.abs(Number(c.wd_total || 0));
  }
  return customers;
}

module.exports = { attachCustomerTxStats };
