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

// ── 性能 ──
// 下面几个报表以前都是 customers（一家 7 万多行）LEFT JOIN first_dep 等 CTE。SQLite 不给 CTE
// 建自动索引，每个客户都把 CTE 整个扫一遍（客户数 × 首充人数），一次 1.5–2 秒；better-sqlite3
// 是同步的，这期间整个进程都停着，几个人同时开报表就能把审批和同步一起卡住（线上出过 524）。
// 现在 CTE 各自单独查出来放进 Map，按客户在 JS 里拼，口径与原 SQL 逐格相同。

/** 客户 id → 历史首充日期（firstDepCte 同一口径，含按手机号回退归属）。 */
function firstDepMap(db, companyId) {
  const map = new Map();
  for (const r of db.prepare("WITH " + firstDepCte(companyId) + " SELECT customer_id, first_dep_date FROM first_dep").all()) {
    map.set(String(r.customer_id), r.first_dep_date);
  }
  return map;
}

/** 本公司全部客户的推荐人分组键（与原 SQL 的 GROUP BY referrer_key 同一表达式）。 */
function customersWithReferrer(db, companyId) {
  return db
    .prepare(
      `SELECT c.id, ${refKeySql("c.referrer")} AS referrer_key, ${refLabelSql("c.referrer")} AS referrer,
         c.register_date_key AS reg
       FROM customers c WHERE c.company_id = ?`
    )
    .all(companyId);
}

/** 区间内某类交易按 customer_id（原样，不回退手机号）求和；NULL 的 customer_id 原 SQL 也 JOIN 不上，跳过。 */
function rangeSumByCustomer(db, companyId, type, dateFrom, dateTo) {
  const map = new Map();
  for (const r of db
    .prepare(
      `SELECT customer_id, SUM(amount) AS total FROM transactions
       WHERE company_id = ? AND type = ? AND created_date >= ? AND created_date <= ?
       GROUP BY customer_id`
    )
    .all(companyId, type, dateFrom, dateTo)) {
    if (r.customer_id != null) map.set(String(r.customer_id), r.total);
  }
  return map;
}

function groupFor(groups, c) {
  let g = groups.get(c.referrer_key);
  if (!g) {
    g = {
      referrer_key: c.referrer_key,
      referrer: c.referrer,
      total_customers: 0,
      new_regs: 0,
      first_dep_count: 0,
      dep_users: 0,
      dep_total: 0,
      wd_total: 0,
    };
    groups.set(c.referrer_key, g);
  }
  return g;
}

function computeReferrerLeaderboardAllTime(db, opts = {}) {
  const companyId = opts.companyId;
  const sort = "total_sum";
  const q = (opts.q || "").trim().toLowerCase();

  const firstDep = firstDepMap(db, companyId);
  const custDep = new Map();
  for (const r of db
    .prepare(
      `SELECT
         COALESCE(NULLIF(t.customer_id, ''), c.id) AS customer_id,
         SUM(CASE WHEN t.type = 'DEPOSIT' THEN t.amount ELSE 0 END) AS dep_total,
         SUM(CASE WHEN t.type = 'WITHDRAW' THEN t.amount ELSE 0 END) AS wd_total
       FROM transactions t
       LEFT JOIN customers c ON c.company_id = t.company_id
         AND (t.customer_id IS NULL OR t.customer_id = '')
         AND t.mobile IS NOT NULL AND t.mobile != ''
         AND c.mobile = t.mobile
       WHERE t.company_id = ? AND t.type IN ('DEPOSIT', 'WITHDRAW')
       GROUP BY COALESCE(NULLIF(t.customer_id, ''), c.id)`
    )
    .all(companyId)) {
    if (r.customer_id != null) custDep.set(String(r.customer_id), r);
  }

  const groups = new Map();
  for (const c of customersWithReferrer(db, companyId)) {
    const g = groupFor(groups, c);
    const id = String(c.id);
    g.total_customers += 1;
    g.new_regs += 1;
    if (firstDep.get(id) != null) g.first_dep_count += 1;
    const cd = custDep.get(id);
    if (cd) {
      if (cd.dep_total > 0) g.dep_users += 1;
      g.dep_total += cd.dep_total || 0;
      g.wd_total += cd.wd_total || 0;
    }
  }

  let rows = [...groups.values()]
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

  const inRange = (d) => d != null && d >= dateFrom && d <= dateTo;
  const firstDep = firstDepMap(db, companyId);
  // range_dep_users（区间内有充值的 DISTINCT customer_id）与 range_dep 的分组键是同一个集合。
  const rangeDep = rangeSumByCustomer(db, companyId, "DEPOSIT", dateFrom, dateTo);
  const rangeWd = rangeSumByCustomer(db, companyId, "WITHDRAW", dateFrom, dateTo);

  const groups = new Map();
  for (const c of customersWithReferrer(db, companyId)) {
    const g = groupFor(groups, c);
    const id = String(c.id);
    g.total_customers += 1;
    if (inRange(c.reg)) g.new_regs += 1;
    if (inRange(firstDep.get(id))) g.first_dep_count += 1;
    if (rangeDep.has(id)) {
      g.dep_users += 1;
      g.dep_total += rangeDep.get(id) || 0;
    }
    if (rangeWd.has(id)) g.wd_total += rangeWd.get(id) || 0;
  }

  let rows = [...groups.values()]
    .filter((r) => r.new_regs > 0 || r.first_dep_count > 0 || r.dep_total > 0 || r.wd_total > 0)
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

  // 首充日期从 Map 里补，不再 LEFT JOIN first_dep（自然流量一组就有几万人，逐个扫 CTE 很慢）。
  const firstDep = firstDepMap(db, companyId);
  let customerSql = `
    SELECT
      c.id, c.username, c.name, c.mobile, c.register_date_key, c.last_login_date,
      c.dep_count, c.dep_total, c.wd_total, c.last_deposit, c.last_login
    FROM customers c
    WHERE c.company_id = ? AND ${refKeySql("c.referrer")} = ?`;

  const params = [companyId, referrerKey];
  if (segment === "new_today") {
    customerSql += " AND c.register_date_key >= ? AND c.register_date_key <= ?";
    params.push(dateFrom, dateTo);
  } else if (segment === "first_dep_today") {
    const ids = [];
    for (const [id, d] of firstDep) if (d != null && d >= dateFrom && d <= dateTo) ids.push(id);
    customerSql += " AND c.id IN (SELECT value FROM json_each(?))";
    params.push(JSON.stringify(ids));
  }

  customerSql += " ORDER BY c.register_date DESC LIMIT 500";
  const customers = db
    .prepare(customerSql)
    .all(...params)
    .map((c) => ({ ...c, first_dep_date: firstDep.get(String(c.id)) ?? null }));

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
