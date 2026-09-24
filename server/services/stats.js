const { todayKey, shiftDateKey } = require("../lib/dates");
const {
  computeDayWinLoss,
  computeMonthWinLoss,
  testUsernameSql,
  testCustomerUsernameSql,
  TX_CUSTOMER_JOIN,
} = require("../lib/winLoss");

const MONEY_TX_TEST_FILTER = ` AND ${testUsernameSql("t", "c")}`;

function typeStats(db, date, type, companyId) {
  const money = type === "DEPOSIT" || type === "WITHDRAW";
  const join = money ? ` ${TX_CUSTOMER_JOIN}` : "";
  const testFilter = money ? MONEY_TX_TEST_FILTER : "";
  return db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(t.amount), 0) AS total
       FROM transactions t${join}
       WHERE t.company_id = ? AND t.type = ? AND t.created_date = ?${testFilter}`
    )
    .get(companyId, type, date);
}

function parseReportDate(queryDate) {
  const today = todayKey();
  if (!queryDate) return today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(queryDate))) return null;
  if (queryDate > today) return null;
  return queryDate;
}

function readDailySnapshot(db, companyId, date) {
  return db
    .prepare(
      "SELECT total_customers, new_customers FROM daily_stats WHERE company_id = ? AND date = ?"
    )
    .get(companyId, date);
}

function readApiUserTotal(companyId) {
  try {
    const fs = require("fs");
    const { syncStatePath } = require("../lib/paths");
    const p = syncStatePath(companyId);
    if (!fs.existsSync(p)) return null;
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    return s.apiUserTotal != null ? Number(s.apiUserTotal) : null;
  } catch {
    return null;
  }
}

function computeDashboard(db, date, companyId) {
  const deposits = typeStats(db, date, "DEPOSIT", companyId);
  const withdrawals = typeStats(db, date, "WITHDRAW", companyId);
  const bonus = typeStats(db, date, "BONUS", companyId);
  const manual = typeStats(db, date, "MANUAL", companyId);
  const commission = typeStats(db, date, "COMMISSION", companyId);
  const today = todayKey();
  const isHistorical = date < today;
  const snapshot = readDailySnapshot(db, companyId, date);
  let customersTotal = null;
  let customersTotalSource = "unavailable";
  if (isHistorical) {
    if (snapshot && snapshot.total_customers != null) {
      customersTotal = Number(snapshot.total_customers);
      customersTotalSource = "snapshot";
    }
  } else {
    const apiTotal = readApiUserTotal(companyId);
    const dbTotal = db.prepare("SELECT COUNT(*) AS count FROM customers WHERE company_id = ?").get(companyId);
    customersTotal = apiTotal != null ? apiTotal : dbTotal.count;
    customersTotalSource = apiTotal != null ? "api" : "db";
  }
  const customers = { total: customersTotal, newToday: null };
  const newCustomers = db
    .prepare(
      `SELECT COUNT(*) AS count FROM customers
       WHERE company_id = ? AND register_date_key = ? AND ${testCustomerUsernameSql("customers")}`
    )
    .get(companyId, date);
  customers.newToday =
    isHistorical && snapshot && snapshot.new_customers != null
      ? Number(snapshot.new_customers)
      : newCustomers.count;
  const onlineToday = db
    .prepare(
      `SELECT COUNT(*) AS count FROM customers
       WHERE company_id = ? AND last_login_date = ? AND ${testCustomerUsernameSql("customers")}`
    )
    .get(companyId, date);
  const depositUsersToday = db
    .prepare(
      `SELECT COUNT(DISTINCT COALESCE(NULLIF(TRIM(t.customer_id), ''), NULLIF(TRIM(t.mobile), ''))) AS count
       FROM transactions t
       ${TX_CUSTOMER_JOIN}
       WHERE t.company_id = ? AND t.type = 'DEPOSIT' AND t.created_date = ?
         AND COALESCE(NULLIF(TRIM(t.customer_id), ''), NULLIF(TRIM(t.mobile), '')) IS NOT NULL
         AND COALESCE(NULLIF(TRIM(t.customer_id), ''), NULLIF(TRIM(t.mobile), '')) != ''
         ${MONEY_TX_TEST_FILTER}`
    )
    .get(companyId, date);

  return {
    date,
    companyId,
    deposits: { count: deposits.count, total: deposits.total },
    withdrawals: { count: withdrawals.count, total: Math.abs(withdrawals.total) },
    customers: { total: customers.total, newToday: customers.newToday },
    onlineToday: onlineToday.count,
    depositUsersToday: depositUsersToday.count,
    bonus: { count: bonus.count, total: bonus.total },
    manual: { count: manual.count, total: manual.total },
    commission: { count: commission.count, total: commission.total },
    winLoss: computeDayWinLoss(db, date, companyId),
    monthWinLoss: computeMonthWinLoss(db, date, companyId, today),
    isHistorical,
    customersTotalSource,
  };
}

function saveDailyStats(db, stats, companyId) {
  const cid = companyId || stats.companyId;
  db.prepare(
    `INSERT INTO daily_stats (
      company_id, date, dep_count, dep_total, wd_count, wd_total,
      online_count, dep_users_count, new_customers, total_customers, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(company_id, date) DO UPDATE SET
      dep_count = excluded.dep_count,
      dep_total = excluded.dep_total,
      wd_count = excluded.wd_count,
      wd_total = excluded.wd_total,
      online_count = excluded.online_count,
      dep_users_count = excluded.dep_users_count,
      new_customers = excluded.new_customers,
      total_customers = excluded.total_customers,
      updated_at = datetime('now')`
  ).run(
    cid,
    stats.date,
    stats.deposits.count,
    stats.deposits.total,
    stats.withdrawals.count,
    stats.withdrawals.total,
    stats.onlineToday,
    stats.depositUsersToday,
    stats.customers.newToday,
    stats.customers.total
  );
}

function lastNDays(db, days, companyId) {
  const rows = db
    .prepare(
      `SELECT date, dep_count, dep_total, wd_count, wd_total,
              online_count, dep_users_count, new_customers, total_customers
       FROM daily_stats
       WHERE company_id = ?
       ORDER BY date DESC
       LIMIT ?`
    )
    .all(companyId, days)
    .reverse();
  return rows;
}

function listReportDates(db, companyId, opts = {}) {
  const limit = Math.min(90, Math.max(7, Number(opts.limit) || 30));
  const today = todayKey();
  const minDate = shiftDateKey(today, -(limit - 1));
  const fromStats = db
    .prepare(
      `SELECT date FROM daily_stats
       WHERE company_id = ? AND date >= ? AND date <= ?
       ORDER BY date DESC`
    )
    .all(companyId, minDate, today)
    .map((r) => r.date);
  const fromTx = db
    .prepare(
      `SELECT DISTINCT created_date AS date FROM transactions
       WHERE company_id = ? AND created_date >= ? AND created_date <= ?
       ORDER BY created_date DESC`
    )
    .all(companyId, minDate, today)
    .map((r) => r.date);
  const set = new Set([...fromStats, ...fromTx, today]);
  return [...set].filter((d) => d >= minDate && d <= today).sort().reverse();
}

module.exports = {
  todayKey,
  parseReportDate,
  computeDashboard,
  saveDailyStats,
  lastNDays,
  listReportDates,
};
