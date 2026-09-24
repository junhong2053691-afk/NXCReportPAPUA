function attachCustomerExtras(db, customers, companyId) {
  if (!customers?.length) return customers;
  const ids = [...new Set(customers.map((c) => c.id).filter(Boolean))];
  if (!ids.length) return customers;

  const ph = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT t.customer_id,
        SUM(CASE WHEN t.type = 'BONUS' THEN 1 ELSE 0 END) AS bonus_count,
        COALESCE(SUM(CASE WHEN t.type = 'BONUS' THEN t.amount ELSE 0 END), 0) AS bonus_total,
        SUM(CASE WHEN t.type = 'MANUAL' THEN 1 ELSE 0 END) AS manual_count,
        COALESCE(SUM(CASE WHEN t.type = 'MANUAL' THEN t.amount ELSE 0 END), 0) AS manual_total,
        SUM(CASE WHEN t.type = 'COMMISSION' THEN 1 ELSE 0 END) AS commission_count,
        COALESCE(SUM(CASE WHEN t.type = 'COMMISSION' THEN t.amount ELSE 0 END), 0) AS commission_total
       FROM transactions t
       WHERE t.company_id = ? AND t.type IN ('BONUS', 'MANUAL', 'COMMISSION')
         AND COALESCE(t.customer_id, '') != '' AND t.customer_id IN (${ph})
       GROUP BY t.customer_id`
    )
    .all(companyId, ...ids);

  const map = Object.fromEntries(rows.map((r) => [r.customer_id, r]));
  for (const c of customers) {
    const e = map[c.id] || {};
    c.bonus_count = Number(e.bonus_count || 0);
    c.bonus_total = Number(e.bonus_total || 0);
    c.manual_count = Number(e.manual_count || 0);
    c.manual_total = Number(e.manual_total || 0);
    c.commission_count = Number(e.commission_count || 0);
    c.commission_total = Number(e.commission_total || 0);
  }
  return customers;
}

module.exports = { attachCustomerExtras };
