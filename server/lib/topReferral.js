// TOP REFERRAL（MONTHLY REPORT › TOP REFERRAL）。口径定义见仓库根目录 CONTEXT.md「推荐人月报」一节，
// 对照的是平台自己的 Top Referrer Report。数据源是平台同步的 customers + transactions，
// 不是 bank_ledger。推荐人 = 下线客户的 customers.referrer（TRIM 后原样），空 = 自然流量。
//
// 日界一律用日期键字符串比较：customers.register_date_key / transactions.created_date
// 已经是实例时区的 YYYY-MM-DD。
const { todayKey } = require("./dates");
const { testUsernameSql, customerJoin, customerIdExpr } = require("./winLoss");
const { ORGANIC_KEY } = require("./referrerReport");

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const YEAR_RE = /^\d{4}$/;
const pad = (n) => String(n).padStart(2, "0");

const REF_EXPR = "TRIM(COALESCE(c.referrer, ''))";

// 交易 → 客户的归属与全站 WIN/LOSE（winLoss.CUSTOMER_JOIN）同口径：先认 customer_id，
// 为空时按手机号回退（cm）。cx 是归属后的那个客户，用来做 test 账号判据
// （与 winLoss.sumDepWinLoss 同一个判据）。两者都与外层的 c 无关。
const TX_CUSTOMER_ID = customerIdExpr("cm");
const TX_JOIN = `${customerJoin("cm")}
  LEFT JOIN customers cx ON cx.company_id = t.company_id AND cx.id = ${TX_CUSTOMER_ID}`;
const NOT_TEST = testUsernameSql("t", "cx");

/** month / year 参数 → 本期 [from, toExclusive) 日期键。 */
function periodOf(opts) {
  const today = opts.today || todayKey();
  if (YEAR_RE.test(String(opts.year || ""))) {
    const year = String(opts.year);
    return { view: "year", period: year, from: `${year}-01-01`, to: `${Number(year) + 1}-01-01`, today };
  }
  const m = MONTH_RE.exec(String(opts.month || "")) || MONTH_RE.exec(today.slice(0, 7));
  const year = Number(m[1]);
  const month = Number(m[2]);
  const to = month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
  return { view: "month", period: `${m[1]}-${m[2]}`, from: `${m[1]}-${m[2]}-01`, to, today };
}

// 金额全部按「分」整数累加，避免浮点残差出现在合计行里。
const cents = (v) => Math.round(Number(v || 0) * 100);

/**
 * 本期有动静的下线，一人一行（本期注册，或本期有充值 / 提现）。
 * 首充看库里该客户**全部历史**的第一笔 DEPOSIT，不只看本期 —— 否则上个月首充、本月再充
 * 的人会被算成本月首充。「第一笔」先比日期键 created_date（日界口径的那一列），同一天再比
 * created_at、id；不直接按 created_at 排，是因为它为空的单子会排到最前面被当成首笔。
 */
//
// 性能：以前是一条 SQL 用 customers（一家 7 万多行）LEFT JOIN 上面这几个 CTE。SQLite 不给
// CTE 建自动索引，于是每个客户都把 CTE 整个扫一遍 —— 客户数 × 有充值的下线数，单次 4 秒多，
// 而 better-sqlite3 是同步的，这 4 秒里整个进程（审批、同步、所有人的请求）都在等。
// 现在拆成两步：先按客户聚合出「有动静的人」（只有几百上千行），再按主键把这些人和本期注册
// 的人从 customers 里取出来，在 JS 里拼。口径与以前那条 SQL 逐行相同。
function downlineRows(db, companyId, p, referrer) {
  const onlyReferrer = typeof referrer === "string";
  const activity = db
    .prepare(
      `WITH tx AS MATERIALIZED (
         SELECT ${TX_CUSTOMER_ID} AS cid, t.type, t.created_date AS d, t.created_at, t.id, t.amount
         FROM transactions t
         ${TX_JOIN}
         WHERE t.company_id = @cid AND t.type IN ('DEPOSIT', 'WITHDRAW') AND ${NOT_TEST}
           AND COALESCE(${TX_CUSTOMER_ID}, '') <> ''
       ),
       dep AS MATERIALIZED (
         SELECT cid, d, amount, ROW_NUMBER() OVER (PARTITION BY cid ORDER BY d, created_at, id) AS rn
         FROM tx WHERE type = 'DEPOSIT'
       ),
       first AS (SELECT cid, d AS first_date, amount AS first_amount FROM dep WHERE rn = 1),
       per AS (
         SELECT dep.cid, f.first_date, f.first_amount,
           SUM(CASE WHEN dep.d >= @from AND dep.d < @to THEN 1 ELSE 0 END) AS dep_count,
           SUM(CASE WHEN dep.d >= @from AND dep.d < @to THEN dep.amount ELSE 0 END) AS dep_amount,
           SUM(CASE WHEN dep.d = f.first_date THEN 1 ELSE 0 END) AS first_day_count,
           SUM(CASE WHEN dep.d = f.first_date THEN dep.amount ELSE 0 END) AS first_day_amount
         FROM dep JOIN first f ON f.cid = dep.cid
         GROUP BY dep.cid
       )
       SELECT 'dep' AS kind, cid, first_date, first_amount, dep_count, dep_amount, first_day_count, first_day_amount,
         0 AS wd_count, 0 AS wd_amount
       FROM per
       UNION ALL
       SELECT 'wd', cid, NULL, NULL, 0, 0, 0, 0, COUNT(*), SUM(ABS(amount))
       FROM tx WHERE type = 'WITHDRAW' AND d >= @from AND d < @to
       GROUP BY cid`
    )
    .all({ cid: companyId, from: p.from, to: p.to });

  const dep = new Map();
  const wd = new Map();
  for (const a of activity) (a.kind === "dep" ? dep : wd).set(String(a.cid), a);

  // 要取的人：本期有充值或提现的（按主键取），加上本期注册的（按注册日取）。
  const wanted = new Set();
  for (const [id, a] of dep) if (a.dep_count > 0) wanted.add(id);
  for (const id of wd.keys()) wanted.add(id);

  const cols = `c.id, c.username, c.name, ${REF_EXPR} AS referrer, c.register_date_key AS reg`;
  const refFilter = onlyReferrer ? `AND ${REF_EXPR} = @ref` : "";
  const people = new Map();
  for (const c of db
    .prepare(
      `SELECT ${cols} FROM customers c
       WHERE c.company_id = @cid AND c.register_date_key >= @from AND c.register_date_key < @to ${refFilter}`
    )
    .all({ cid: companyId, from: p.from, to: p.to, ...(onlyReferrer ? { ref: referrer } : {}) })) {
    people.set(String(c.id), c);
  }
  const ids = [...wanted].filter((id) => !people.has(id));
  if (ids.length) {
    for (const c of db
      .prepare(
        `SELECT ${cols} FROM customers c
         WHERE c.company_id = @cid AND c.id IN (SELECT value FROM json_each(@ids)) ${refFilter}`
      )
      .all({ cid: companyId, ids: JSON.stringify(ids), ...(onlyReferrer ? { ref: referrer } : {}) })) {
      people.set(String(c.id), c);
    }
  }

  const rows = [];
  for (const [id, c] of people) {
    const d = dep.get(id);
    const w = wd.get(id);
    rows.push({
      ...c,
      first_date: d ? d.first_date : null,
      first_amount: d ? d.first_amount : null,
      dep_count: d ? d.dep_count : 0,
      dep_amount: d ? d.dep_amount : 0,
      first_day_count: d ? d.first_day_count : 0,
      first_day_amount: d ? d.first_day_amount : 0,
      wd_count: w ? w.wd_count : 0,
      wd_amount: w ? w.wd_amount : 0,
    });
  }
  return rows;
}

const METRIC_KEYS = [
  "newMember",
  "firstDepCount",
  "firstDepAmount",
  "firstDayCount",
  "firstDayAmount",
  "sameDayUsers",
  "sameDayAmount",
  "depCount",
  "dep",
  "regularCount",
  "regular",
  "wdCount",
  "wd",
  "net",
];
const MONEY_KEYS = new Set(["firstDepAmount", "firstDayAmount", "sameDayAmount", "dep", "regular", "wd", "net"]);

function emptyMetrics() {
  return Object.fromEntries(METRIC_KEYS.map((k) => [k, 0]));
}

const inPeriod = (date, p) => Boolean(date) && date >= p.from && date < p.to;

/** 一个下线对各列的贡献（金额为分）。 */
function contribution(c, p) {
  const m = emptyMetrics();
  if (inPeriod(c.reg, p)) m.newMember = 1;
  m.depCount = c.dep_count;
  m.dep = cents(c.dep_amount);
  if (inPeriod(c.first_date, p)) {
    m.firstDepCount = 1;
    m.firstDepAmount = cents(c.first_amount);
    m.firstDayCount = c.first_day_count;
    m.firstDayAmount = cents(c.first_day_amount);
    if (c.reg === c.first_date) {
      m.sameDayUsers = 1;
      m.sameDayAmount = m.firstDayAmount;
    }
  }
  m.regularCount = m.depCount - m.firstDayCount;
  m.regular = m.dep - m.firstDayAmount;
  m.wdCount = c.wd_count;
  m.wd = -cents(c.wd_amount) || 0; // 照平台显示为负数；|| 0 把 -0 归一，否则没提现的人会显示 -0
  m.net = m.dep + m.wd;
  return m;
}

function addInto(acc, m) {
  for (const k of METRIC_KEYS) acc[k] += m[k];
  return acc;
}

/** 分 → 元。 */
function finish(acc) {
  const out = {};
  for (const k of METRIC_KEYS) out[k] = MONEY_KEYS.has(k) ? acc[k] / 100 : acc[k];
  return out;
}

// 排序键 → 列。并列时依次比 NEW MEMBER、首充人数、TOTAL DEPOSIT，最后按名字，保证名次稳定。
const SORTS = { newMember: "newMember", firstDep: "firstDepCount", dep: "dep", net: "net" };
const TIE_BREAK = ["newMember", "firstDepCount", "dep"];

function compareBy(sort) {
  const keys = [SORTS[sort], ...TIE_BREAK.filter((k) => k !== SORTS[sort])];
  return (a, b) => {
    for (const k of keys) {
      if (b[k] !== a[k]) return b[k] - a[k];
    }
    return a.referrer.localeCompare(b.referrer);
  };
}


function computeTopReferral(db, companyId, opts = {}) {
  const p = periodOf(opts);
  const byRef = new Map();
  const organic = emptyMetrics();
  const total = emptyMetrics();
  for (const c of downlineRows(db, companyId, p)) {
    const m = contribution(c, p);
    addInto(total, m);
    if (!c.referrer) {
      addInto(organic, m);
      continue;
    }
    if (!byRef.has(c.referrer)) byRef.set(c.referrer, emptyMetrics());
    addInto(byRef.get(c.referrer), m);
  }
  const sort = SORTS[opts.sort] ? opts.sort : "newMember";
  const rows = [...byRef]
    .map(([referrer, m]) => ({ referrer, ...finish(m) }))
    .sort(compareBy(sort))
    .map((r, i) => ({ rank: i + 1, ...r }));
  return {
    view: p.view,
    period: p.period,
    today: p.today,
    sort,
    rows,
    organic: finish(organic),
    total: finish(total),
    referrers: allReferrers(db, companyId),
  };
}

/**
 * 抽屉：一个推荐人本期的指标（与排行同一行逐格相等）+ 本期有动静的下线名单。
 * referrer 传 ORGANIC_KEY 打开自然流量。查不到的推荐人返回全 0 与空名单。
 */
function computeReferrerDetail(db, companyId, opts = {}) {
  const p = periodOf(opts);
  const raw = String(opts.referrer ?? "").trim();
  const organic = raw === ORGANIC_KEY;
  const referrer = organic ? "" : raw;
  const acc = emptyMetrics();
  const downlines = [];
  // 空名字不是自然流量的别名：不传 ORGANIC_KEY 就查不到任何人，免得空参数误开自然流量。
  const rows = !organic && !referrer ? [] : downlineRows(db, companyId, p, referrer);
  for (const c of rows) {
    const m = contribution(c, p);
    addInto(acc, m);
    downlines.push({
      id: c.id,
      username: c.username || "",
      name: c.name || "",
      registerDate: c.reg || "",
      firstDepDate: c.first_date || "",
      firstDepAmount: c.first_date ? cents(c.first_amount) / 100 : 0,
      depCount: m.depCount,
      dep: m.dep / 100,
      wdCount: m.wdCount,
      wd: m.wd / 100,
      net: m.net / 100,
    });
  }
  downlines.sort(
    (a, b) => b.dep - a.dep || b.registerDate.localeCompare(a.registerDate) || String(a.id).localeCompare(String(b.id))
  );
  return {
    view: p.view,
    period: p.period,
    today: p.today,
    referrer: organic ? ORGANIC_KEY : referrer,
    organic,
    metrics: finish(acc),
    downlines,
  };
}

/** 搜索框用：本公司全部推荐人（与本期有没有动静无关），不含自然流量。 */
function allReferrers(db, companyId) {
  return db
    .prepare(`SELECT DISTINCT ${REF_EXPR} AS r FROM customers c WHERE c.company_id = ? AND ${REF_EXPR} <> ''`)
    .all(companyId)
    .map((x) => x.r)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

module.exports = { computeTopReferral, computeReferrerDetail };
