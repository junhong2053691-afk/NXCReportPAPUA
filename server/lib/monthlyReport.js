// 月报（MONTHLY REPORT › REPORT）。口径定义见仓库根目录 CONTEXT.md「月报」一节，
// 与「支付渠道」日报（bankReport.computeBankDailyReport）在 DEPOSIT / DEP COUNT /
// UNIQUE CUST 上刻意不同 —— 那边对应运营的 Excel，别把两边「修平」。
//
// 数据源只有 bank_ledger。entry_time 是实例时区的墙上时间字符串，所以日界一律用
// 字符串前缀比较（substr 前 10 位 = 日期键），不做任何时区换算。
const { todayKey, shiftDateKey } = require("./dates");
const { blockedExpenseByDay } = require("./blockedExpense");

const DEP_STATUSES = ["deposit", "new", "amopay"];

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const YEAR_RE = /^\d{4}$/;

const SUM_KEYS = ["dep", "wd", "unclaim", "wrong", "expenses", "blocked", "exchange", "depCount", "wdCount", "uniqueCust"];

// 金额全部按「分」整数累加，避免 0.1 + 0.2 这类浮点残差出现在合计行里。
const cents = (v) => Math.round(Number(v || 0) * 100);

function sqlList(values) {
  return values.map((v) => `'${v}'`).join(", ");
}

const STATUS_EXPR = "LOWER(TRIM(status))";
const IN_EXPR = "(amount_in + ABS(trf_amount))";
const OUT_EXPR = "(ABS(amount_out) + ABS(help_amount))";
const IS_DEP = `${STATUS_EXPR} IN (${sqlList(DEP_STATUSES)})`;

/** 按日期键汇总 [from, toExclusive) 区间的流水，返回 Map<dateKey, 分为单位的原始累加值>。 */
function dailyRows(db, companyId, from, toExclusive) {
  const rows = db
    .prepare(
      `SELECT substr(entry_time, 1, 10) AS d,
         COALESCE(SUM(CASE WHEN ${IS_DEP} THEN ${IN_EXPR} ELSE 0 END), 0) AS dep,
         COALESCE(SUM(CASE WHEN ${IS_DEP} AND ${IN_EXPR} > 0 THEN 1 ELSE 0 END), 0) AS depCount,
         COALESCE(SUM(CASE WHEN ${STATUS_EXPR} = 'withdraw' THEN ${OUT_EXPR} ELSE 0 END), 0) AS wd,
         COALESCE(SUM(CASE WHEN ${STATUS_EXPR} = 'withdraw' AND ${OUT_EXPR} > 0 THEN 1 ELSE 0 END), 0) AS wdCount,
         COALESCE(SUM(CASE WHEN ${STATUS_EXPR} = 'unclaim' THEN ${IN_EXPR} ELSE 0 END), 0) AS unclaim,
         COALESCE(SUM(CASE WHEN ${STATUS_EXPR} = 'wrong' THEN ${OUT_EXPR} ELSE 0 END), 0) AS wrong,
         COALESCE(SUM(CASE WHEN ${STATUS_EXPR} = 'expenses' THEN ${OUT_EXPR} ELSE 0 END), 0) AS expenses,
         -- EXCHANGE 与日报 REPORT 同口径：入 + 出，正数（换钱总额）。
         COALESCE(SUM(CASE WHEN ${STATUS_EXPR} = 'exchange' THEN ${IN_EXPR} + ${OUT_EXPR} ELSE 0 END), 0) AS exchange,
         COUNT(DISTINCT CASE WHEN ${IS_DEP} AND ${IN_EXPR} > 0 AND TRIM(username) != ''
           THEN TRIM(username) END) AS uniqueCust
       FROM bank_ledger
       WHERE company_id = ? AND entry_time >= ? AND entry_time < ?
       GROUP BY d`
    )
    .all(companyId, `${from} 00:00:00`, `${toExclusive} 00:00:00`);
  const map = new Map();
  for (const r of rows) {
    map.set(r.d, {
      dep: cents(r.dep),
      wd: cents(r.wd),
      unclaim: cents(r.unclaim),
      wrong: cents(r.wrong),
      expenses: cents(r.expenses),
      blocked: 0,
      exchange: cents(r.exchange),
      depCount: r.depCount,
      wdCount: r.wdCount,
      uniqueCust: r.uniqueCust,
    });
  }
  // 封禁户余额计入 EXPENSES，与日报同一份实现（blockedExpense.js），所以同一天两边逐分相等。
  // 封禁那天可能一笔流水都没有，所以要能新建一行。
  for (const [d, c] of blockedExpenseByDay(db, companyId, from, shiftDateKey(toExclusive, -1))) {
    if (!map.has(d)) map.set(d, emptyAcc());
    const row = map.get(d);
    row.expenses += c;
    row.blocked += c;
  }
  return map;
}

function emptyAcc() {
  return Object.fromEntries(SUM_KEYS.map((k) => [k, 0]));
}

function addInto(acc, row) {
  if (!row) return acc;
  for (const k of SUM_KEYS) acc[k] += row[k];
  return acc;
}

/** 分为单位的累加值 → 对外的一行（元、派生列）。 */
function finish(acc) {
  const winLose = acc.dep - acc.wd;
  return {
    dep: acc.dep / 100,
    wd: acc.wd / 100,
    winLose: winLose / 100,
    winRate: acc.dep === 0 ? null : winLose / acc.dep,
    unclaim: acc.unclaim / 100,
    wrong: acc.wrong / 100,
    expenses: acc.expenses / 100,
    // EXPENSES 里属于封禁户余额变动的那一份（已含在 expenses 内）。
    blockedExpense: acc.blocked / 100,
    exchange: acc.exchange / 100,
    depCount: acc.depCount,
    wdCount: acc.wdCount,
    totalCount: acc.depCount + acc.wdCount,
    uniqueCust: acc.uniqueCust,
  };
}

const pad = (n) => String(n).padStart(2, "0");

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function nextMonthKey(year, month) {
  return month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
}

function computeMonthlyReport(db, companyId, opts = {}) {
  const today = opts.today || todayKey();
  const m = MONTH_RE.exec(String(opts.month || "")) || MONTH_RE.exec(today.slice(0, 7));
  const year = Number(m[1]);
  const month = Number(m[2]);
  const monthKey = `${m[1]}-${m[2]}`;

  const map = dailyRows(db, companyId, `${monthKey}-01`, nextMonthKey(year, month));
  const total = emptyAcc();
  const days = [];
  for (let d = 1; d <= daysInMonth(year, month); d++) {
    const date = `${monthKey}-${pad(d)}`;
    const row = map.get(date);
    addInto(total, row);
    days.push({ date, future: date > today, ...finish(addInto(emptyAcc(), row)) });
  }
  return { month: monthKey, today, days, total: finish(total) };
}

function computeYearlyReport(db, companyId, opts = {}) {
  const today = opts.today || todayKey();
  const yearKey = YEAR_RE.test(String(opts.year || "")) ? String(opts.year) : today.slice(0, 4);
  const year = Number(yearKey);

  const map = dailyRows(db, companyId, `${yearKey}-01-01`, `${year + 1}-01-01`);
  const perMonth = Array.from({ length: 12 }, emptyAcc);
  for (const [date, row] of map) addInto(perMonth[Number(date.slice(5, 7)) - 1], row);

  const total = emptyAcc();
  const months = perMonth.map((acc, i) => {
    addInto(total, acc);
    const monthKey = `${yearKey}-${pad(i + 1)}`;
    return { month: monthKey, future: `${monthKey}-01` > today, ...finish(acc) };
  });
  return { year: yearKey, today, months, total: finish(total) };
}

module.exports = { DEP_STATUSES, computeMonthlyReport, computeYearlyReport };
