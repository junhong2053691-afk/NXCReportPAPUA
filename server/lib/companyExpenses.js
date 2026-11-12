// 往来账（MONTHLY REPORT › COMPANY EXPENSES）。口径定义见仓库根目录 CONTEXT.md「往来账」一节。
//
// 名字叫 EXPENSES，但与状态 `expenses` 无关：这里记的是本公司与各 C STATUS 往来方之间
// 「欠来欠去」的账。IN / OUT 与「支付渠道」日报 C STATUS 表（bankReport 的 companyMap /
// cStatusTotalsForCompany）逐格同口径——HELP TRF 与余额方向对调，理由见那边的注释。
// NET 正 = 我方欠对方，负 = 对方欠我方。只读本公司，不做对平。
//
// 末尾的 EXCHANGE 列不是往来方、也不是 NET：它是 status = exchange 流水的换钱总额（入 + 出，正数），
// 与日报 REPORT 的 EXCHANGE（bankReport 里 inTotal + outTotal）同口径，不看 C STATUS。
// 所以它单独放在 exchange / exchange_total，不进 columns（columns 必须与日报 companyRows 一致）。
const { todayKey } = require("./dates");
const { isDemoTenant } = require("./readConfig");
const { C_STATUS_DEFAULTS } = require("./bankReport");

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const YEAR_RE = /^\d{4}$/;

// 金额全部按「分」整数累加，避免浮点残差出现在合计行里。
const cents = (v) => Math.round(Number(v || 0) * 100);
const pad = (n) => String(n).padStart(2, "0");

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function nextMonthKey(year, month) {
  return month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
}

/** [from, toExclusive) 区间按 (日期, 往来方) 汇总的 NET（分）。 */
function dailyNets(db, companyId, from, toExclusive) {
  return db
    .prepare(
      // 别名刻意不叫 name：bank_ledger 自己有 name 列，GROUP BY name 会绑到那一列上。
      `SELECT substr(entry_time, 1, 10) AS d, TRIM(c_status) AS cs,
         COALESCE(SUM(amount_in + ABS(help_amount)), 0) - COALESCE(SUM(ABS(amount_out) + ABS(trf_amount)), 0) AS net
       FROM bank_ledger
       WHERE company_id = ? AND entry_time >= ? AND entry_time < ? AND TRIM(c_status) <> ''
       GROUP BY d, cs
       ORDER BY MIN(entry_time), MIN(id)`
    )
    .all(companyId, `${from} 00:00:00`, `${toExclusive} 00:00:00`)
    .map((r) => ({ date: r.d, name: r.cs, net: cents(r.net) }));
}

/** [from, toExclusive) 区间按日期汇总的 EXCHANGE 金额（分）。口径见文件头。 */
function dailyExchange(db, companyId, from, toExclusive) {
  return db
    .prepare(
      `SELECT substr(entry_time, 1, 10) AS d,
         COALESCE(SUM(amount_in + ABS(trf_amount) + ABS(amount_out) + ABS(help_amount)), 0) AS amount
       FROM bank_ledger
       WHERE company_id = ? AND entry_time >= ? AND entry_time < ? AND LOWER(TRIM(status)) = 'exchange'
       GROUP BY d`
    )
    .all(companyId, `${from} 00:00:00`, `${toExclusive} 00:00:00`)
    .map((r) => ({ date: r.d, amount: cents(r.amount) }));
}

// 列「C STATUS 是什么就是什么」，与「支付渠道」日报 companyRows 一致：选项按 sort_order
// （一个都没有时与日报同样回退到默认名单，demo 租户除外），再补上流水里出现过但不在选项里
// 的名字（按首次出现）。不做任何隐藏：全 0 的列、指向本公司自己的选项都照样显示——
// 不想要的列去 C STATUS 设置里删。列位固定，粘到 Google Sheet 才对得齐。
function columnsFor(db, companyId, rows) {
  const names = db
    .prepare("SELECT name FROM bank_c_status_options WHERE company_id = ? ORDER BY sort_order ASC, name ASC")
    .all(companyId)
    .map((r) => String(r.name || "").trim())
    .filter(Boolean);
  if (!names.length && !isDemoTenant()) names.push(...C_STATUS_DEFAULTS);
  const seen = new Set(names);
  for (const r of rows) {
    if (!seen.has(r.name)) {
      names.push(r.name);
      seen.add(r.name);
    }
  }
  return names;
}

/**
 * 把区间内的流水按 bucketOf(date) 分桶，每桶一个与 columns 对齐的 NET 数组（分）。
 * keys 决定输出哪些行（没数据的桶也出一行 0），合计 = 各行相加。
 */
function tabulate(db, companyId, from, toExclusive, keys, bucketOf) {
  const rows = dailyNets(db, companyId, from, toExclusive);
  const columns = columnsFor(db, companyId, rows);
  const index = new Map(columns.map((name, i) => [name, i]));
  const zero = () => new Array(columns.length).fill(0);

  const buckets = new Map(keys.map((k) => [k, zero()]));
  for (const r of rows) buckets.get(bucketOf(r.date))[index.get(r.name)] += r.net;

  const exchange = new Map(keys.map((k) => [k, 0]));
  for (const r of dailyExchange(db, companyId, from, toExclusive)) {
    const key = bucketOf(r.date);
    exchange.set(key, exchange.get(key) + r.amount);
  }

  const total = zero();
  let exchangeTotal = 0;
  const lines = keys.map((key) => {
    const nets = buckets.get(key);
    nets.forEach((v, i) => (total[i] += v));
    exchangeTotal += exchange.get(key);
    return { key, nets: nets.map((v) => v / 100), exchange: exchange.get(key) / 100 };
  });
  return { columns, lines, total: total.map((v) => v / 100), exchangeTotal: exchangeTotal / 100 };
}

function computeCompanyExpenses(db, companyId, opts = {}) {
  const today = opts.today || todayKey();
  const m = MONTH_RE.exec(String(opts.month || "")) || MONTH_RE.exec(today.slice(0, 7));
  const year = Number(m[1]);
  const month = Number(m[2]);
  const monthKey = `${m[1]}-${m[2]}`;

  const dates = Array.from({ length: daysInMonth(year, month) }, (_, i) => `${monthKey}-${pad(i + 1)}`);
  const t = tabulate(db, companyId, dates[0], nextMonthKey(year, month), dates, (date) => date);
  return {
    month: monthKey,
    today,
    columns: t.columns,
    days: t.lines.map((l) => ({ date: l.key, future: l.key > today, nets: l.nets, exchange: l.exchange })),
    total: t.total,
    exchange_total: t.exchangeTotal,
  };
}

function computeCompanyExpensesYear(db, companyId, opts = {}) {
  const today = opts.today || todayKey();
  const yearKey = YEAR_RE.test(String(opts.year || "")) ? String(opts.year) : today.slice(0, 4);

  const months = Array.from({ length: 12 }, (_, i) => `${yearKey}-${pad(i + 1)}`);
  const t = tabulate(db, companyId, `${yearKey}-01-01`, `${Number(yearKey) + 1}-01-01`, months, (date) => date.slice(0, 7));
  return {
    year: yearKey,
    today,
    columns: t.columns,
    months: t.lines.map((l) => ({ month: l.key, future: `${l.key}-01` > today, nets: l.nets, exchange: l.exchange })),
    total: t.total,
    exchange_total: t.exchangeTotal,
  };
}

module.exports = { computeCompanyExpenses, computeCompanyExpensesYear };
