const { todayKey, shiftDateKey } = require("./dates");
const { referrerNetTotals } = require("./winLoss");

const ORGANIC_KEY = "__organic__";
const ORGANIC_LABEL = "\u81ea\u7136\u6d41\u91cf";
const MAX_RANGE_DAYS = 90;

const SORTS = {
  first_dep: "first_dep",
  new_regs: "new_regs",
  dep_total: "dep_total",
  total_sum: "total_sum",
};

function refKeySql(col = "referrer") {
  return "COALESCE(NULLIF(TRIM(" + col + "), ''), '" + ORGANIC_KEY + "')";
}

function refLabelSql(col = "referrer") {
  return "COALESCE(NULLIF(TRIM(" + col + "), ''), '" + ORGANIC_LABEL + "')";
}

function decodeReferrerParam(raw) {
  const key = decodeURIComponent(String(raw || "").trim());
  if (!key || key === ORGANIC_KEY) return { key: ORGANIC_KEY, label: ORGANIC_LABEL };
  return { key, label: key };
}

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
    isSingleDay: dateFrom === dateTo,
    label: dateFrom === dateTo ? dateFrom : dateFrom + " \u81f3 " + dateTo,
  };
}

function firstDepCte(companyId) {
  const cid = String(companyId || "").replace(/'/g, "''");
  return `
    first_dep AS (
      SELECT
        COALESCE(NULLIF(t.customer_id, ''), c.id) AS customer_id,
        MIN(t.created_date) AS first_dep_date
      FROM transactions t
      LEFT JOIN customers c ON c.company_id = t.company_id
        AND (t.customer_id IS NULL OR t.customer_id = '')
        AND t.mobile IS NOT NULL AND t.mobile != ''
        AND c.mobile = t.mobile
      WHERE t.company_id = '${cid}' AND t.type = 'DEPOSIT'
        AND COALESCE(NULLIF(t.customer_id, ''), c.id) IS NOT NULL
        AND COALESCE(NULLIF(t.customer_id, ''), c.id) != ''
      GROUP BY COALESCE(NULLIF(t.customer_id, ''), c.id)
    )`;
}

function sortRows(rows, sort) {
  const key = SORTS[sort] ? sort : "first_dep";
  const order = {
    first_dep: ["first_dep_count", "new_regs", "dep_total"],
    new_regs: ["new_regs", "first_dep_count", "dep_total"],
    dep_total: ["dep_total", "first_dep_count", "new_regs"],
    total_sum: ["activity_sum", "total_customers", "dep_total", "dep_users"],
  }[key];
  return rows.sort((a, b) => {
    for (const k of order) {
      const diff = Number(b[k] || 0) - Number(a[k] || 0);
      if (diff !== 0) return diff;
    }
    return String(a.referrer).localeCompare(String(b.referrer));
  });
}

function rangeParams(dateFrom, dateTo) {
  return [dateFrom, dateTo, dateFrom, dateTo, dateFrom, dateTo, dateFrom, dateTo, dateFrom, dateTo, dateFrom, dateTo, dateFrom, dateTo];
}

function depositedSql(prefix = "c") {
  const p = prefix ? prefix + "." : "";
  return `(COALESCE(${p}dep_total, 0) > 0 OR COALESCE(${p}dep_count, 0) > 0 OR (${p}last_deposit IS NOT NULL AND ${p}last_deposit != ''))`;
}

function buildTotals(rows) {
  const totals = rows.reduce(
    (acc, r) => {
      acc.new_regs += r.new_regs;
      acc.first_dep_count += r.first_dep_count;
      acc.dep_users += r.dep_users;
      acc.dep_total += r.dep_total;
      acc.wd_total += r.wd_total;
      acc.net_total += r.net_total;
      acc.activity_sum += r.activity_sum;
      acc.total_customers += r.total_customers;
      return acc;
    },
    {
      new_regs: 0,
      first_dep_count: 0,
      dep_users: 0,
      dep_total: 0,
      wd_total: 0,
      net_total: 0,
      activity_sum: 0,
      total_customers: 0,
    }
  );
  return totals;
}

function computeReferrerLeaderboardAllTime(db, opts = {}) {
  const companyId = opts.companyId;
  const sort = "total_sum";
  const q = (opts.q || "").trim().toLowerCase();

  const sql =
    "WITH " +
    firstDepCte(companyId) +
    `,
    cust_dep AS (
      SELECT
        COALESCE(NULLIF(t.customer_id, ''), c.id) AS customer_id,
        SUM(CASE WHEN t.type = 'DEPOSIT' THEN t.amount ELSE 0 END) AS dep_total,
        SUM(CASE WHEN t.type = 'WITHDRAW' THEN t.amount ELSE 0 END) AS wd_total
      FROM transactions t
      LEFT JOIN customers c ON c.company_id = t.company_id
        AND (t.customer_id IS NULL OR t.customer_id = '')
        AND t.mobile IS NOT NULL AND t.mobile != ''
        AND c.mobile = t.mobile
      WHERE t.company_id = ? AND t.type IN ('DEPOSIT', 'WITHDRAW')
      GROUP BY COALESCE(NULLIF(t.customer_id, ''), c.id)
    )
    SELECT
      ${refKeySql("c.referrer")} AS referrer_key,
      ${refLabelSql("c.referrer")} AS referrer,
      COUNT(*) AS total_customers,
      COUNT(*) AS new_regs,
      COUNT(DISTINCT CASE WHEN fd.first_dep_date IS NOT NULL THEN c.id END) AS first_dep_count,
      COUNT(DISTINCT CASE WHEN cd.customer_id IS NOT NULL AND cd.dep_total > 0 THEN c.id END) AS dep_users,
      COALESCE(SUM(cd.dep_total), 0) AS dep_total,
      COALESCE(SUM(cd.wd_total), 0) AS wd_total
    FROM customers c
    LEFT JOIN first_dep fd ON fd.customer_id = c.id
    LEFT JOIN cust_dep cd ON cd.customer_id = c.id
    WHERE c.company_id = ?
    GROUP BY referrer_key`;

  let rows = db
    .prepare(sql)
    .all(companyId, companyId)
    .map((r) => {
      const totalCustomers = Number(r.total_customers || 0);
      const depUsers = Number(r.dep_users || 0);
      const depTotal = Number(r.dep_total || 0);
      const wdTotal = Number(r.wd_total || 0);
      return {
        referrer_key: r.referrer_key,
        referrer: r.referrer,
        total_customers: totalCustomers,
        new_regs: totalCustomers,
        first_dep_count: Number(r.first_dep_count || 0),
        dep_users: depUsers,
        dep_total: depTotal,
        wd_total: wdTotal,
        net_total: depTotal - wdTotal,
        activity_sum: totalCustomers + depUsers,
      };
    });

  if (q) rows = rows.filter((r) => String(r.referrer).toLowerCase().includes(q));

  const netMap = referrerNetTotals(db, { companyId });
  rows = rows.map((r) => ({ ...r, net_total: netMap[r.referrer_key] ?? 0 }));

  rows = sortRows(rows, sort).map((r, i) => ({ rank: i + 1, ...r }));

  return {
    mode: "all_time",
    dateFrom: null,
    dateTo: null,
    date: "\u5168\u90e8\u7d2f\u8ba1",
    sort,
    total: rows.length,
    totals: buildTotals(rows),
    rows,
  };
}

function computeReferrerLeaderboard(db, dateFrom, dateTo, opts = {}) {
  const companyId = opts.companyId;
  const sort = opts.sort || "first_dep";
  if (sort === "total_sum") {
    return computeReferrerLeaderboardAllTime(db, opts);
  }

  const range = normalizeDateRange(dateFrom, dateTo);
  dateFrom = range.dateFrom;
  dateTo = range.dateTo;
  const q = (opts.q || "").trim().toLowerCase();

  const sql =
    "WITH " +
    firstDepCte(companyId) +
    `,
    range_dep AS (
      SELECT customer_id, SUM(amount) AS dep_total
      FROM transactions
      WHERE company_id = ? AND type = 'DEPOSIT' AND created_date >= ? AND created_date <= ?
      GROUP BY customer_id
    ),
    range_wd AS (
      SELECT customer_id, SUM(amount) AS wd_total
      FROM transactions
      WHERE company_id = ? AND type = 'WITHDRAW' AND created_date >= ? AND created_date <= ?
      GROUP BY customer_id
    ),
    range_dep_users AS (
      SELECT DISTINCT customer_id
      FROM transactions
      WHERE company_id = ? AND type = 'DEPOSIT' AND created_date >= ? AND created_date <= ?
    )
    SELECT
      ${refKeySql("c.referrer")} AS referrer_key,
      ${refLabelSql("c.referrer")} AS referrer,
      COUNT(DISTINCT c.id) AS total_customers,
      COUNT(DISTINCT CASE WHEN c.register_date_key >= ? AND c.register_date_key <= ? THEN c.id END) AS new_regs,
      COUNT(DISTINCT CASE WHEN fd.first_dep_date >= ? AND fd.first_dep_date <= ? THEN c.id END) AS first_dep_count,
      COUNT(DISTINCT CASE WHEN du.customer_id IS NOT NULL THEN c.id END) AS dep_users,
      COALESCE(SUM(rd.dep_total), 0) AS dep_total,
      COALESCE(SUM(rw.wd_total), 0) AS wd_total
    FROM customers c
    LEFT JOIN first_dep fd ON fd.customer_id = c.id
    LEFT JOIN range_dep rd ON rd.customer_id = c.id
    LEFT JOIN range_wd rw ON rw.customer_id = c.id
    LEFT JOIN range_dep_users du ON du.customer_id = c.id
    WHERE c.company_id = ?
    GROUP BY referrer_key
    HAVING COUNT(DISTINCT CASE WHEN c.register_date_key >= ? AND c.register_date_key <= ? THEN c.id END) > 0
        OR COUNT(DISTINCT CASE WHEN fd.first_dep_date >= ? AND fd.first_dep_date <= ? THEN c.id END) > 0
        OR COALESCE(SUM(rd.dep_total), 0) > 0
        OR COALESCE(SUM(rw.wd_total), 0) > 0`;

  const rp = rangeParams(dateFrom, dateTo);
  const lbParams = [
    companyId, dateFrom, dateTo,
    companyId, dateFrom, dateTo,
    companyId, dateFrom, dateTo,
    ...rp.slice(6, 10),
    companyId,
    ...rp.slice(10),
  ];
  let rows = db
    .prepare(sql)
    .all(...lbParams)
    .map((r) => {
      const newRegs = Number(r.new_regs || 0);
      const firstDep = Number(r.first_dep_count || 0);
      const depUsers = Number(r.dep_users || 0);
      const depTotal = Number(r.dep_total || 0);
      const wdTotal = Number(r.wd_total || 0);
      return {
        referrer_key: r.referrer_key,
        referrer: r.referrer,
        total_customers: r.total_customers,
        new_regs: newRegs,
        first_dep_count: firstDep,
        dep_users: depUsers,
        dep_total: depTotal,
        wd_total: wdTotal,
        net_total: depTotal - wdTotal,
        activity_sum: newRegs + firstDep + depUsers,
      };
    });

  if (q) rows = rows.filter((r) => String(r.referrer).toLowerCase().includes(q));

  const netMap = referrerNetTotals(db, { dateFrom, dateTo, companyId });
  rows = rows.map((r) => ({ ...r, net_total: netMap[r.referrer_key] ?? 0 }));

  rows = sortRows(rows, sort).map((r, i) => ({ rank: i + 1, ...r }));

  return {
    mode: "range",
    dateFrom,
    dateTo,
    date: range.label,
    sort,
    total: rows.length,
    totals: buildTotals(rows),
    rows,
  };
}

function computeReferrerReport(db, referrerKey, dateFrom, dateTo, opts = {}) {
  const companyId = opts.companyId;
  const range = normalizeDateRange(dateFrom, dateTo);
  dateFrom = range.dateFrom;
  dateTo = range.dateTo;
  const segment = opts.segment || "all";
  const label = referrerKey === ORGANIC_KEY ? ORGANIC_LABEL : referrerKey;
  const summary = computeReferrerLeaderboard(db, dateFrom, dateTo, { sort: "first_dep", companyId });
  const summaryRow =
    summary.rows.find((r) => r.referrer_key === referrerKey) || {
      referrer_key: referrerKey,
      referrer: label,
      total_customers: 0,
      new_regs: 0,
      first_dep_count: 0,
      dep_users: 0,
      dep_total: 0,
      wd_total: 0,
      net_total: 0,
    };

  const totalCustomers = db
    .prepare("SELECT COUNT(*) AS n FROM customers c WHERE c.company_id = ? AND " + refKeySql("c.referrer") + " = ?")
    .get(companyId, referrerKey).n;

  let customerSql =
    "WITH " +
    firstDepCte(companyId) +
    `
    SELECT
      c.id, c.username, c.name, c.mobile, c.register_date_key, c.last_login_date,
      c.dep_count, c.dep_total, c.wd_total, c.last_deposit, c.last_login,
      fd.first_dep_date
    FROM customers c
    LEFT JOIN first_dep fd ON fd.customer_id = c.id
    WHERE c.company_id = ? AND ${refKeySql("c.referrer")} = ?`;

  const params = [companyId, referrerKey];
  if (segment === "new_today") {
    customerSql += " AND c.register_date_key >= ? AND c.register_date_key <= ?";
    params.push(dateFrom, dateTo);
  } else if (segment === "first_dep_today") {
    customerSql += " AND fd.first_dep_date >= ? AND fd.first_dep_date <= ?";
    params.push(dateFrom, dateTo);
  }

  customerSql += " ORDER BY c.register_date DESC LIMIT 500";
  const customers = db.prepare(customerSql).all(...params);

  return {
    dateFrom,
    dateTo,
    date: range.label,
    referrer_key: referrerKey,
    referrer: label,
    segment,
    summary: { ...summaryRow, total_customers: totalCustomers },
    customers,
  };
}

module.exports = {
  ORGANIC_KEY,
  ORGANIC_LABEL,
  SORTS,
  normalizeDateRange,
  decodeReferrerParam,
  computeReferrerLeaderboard,
  computeReferrerReport,
};
