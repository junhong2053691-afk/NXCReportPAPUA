"use strict";

// 封禁户余额计入 EXPENSES（2026-11-09 用户定的口径，CONTEXT.md「封禁户余额」一节）。
//
// 封禁 / 归档户里躺着的钱不算自有余额（total_balance 不含它们），也不会凭空消失——
// 它被当成一笔开销。只改报表口径，**不写任何流水**：
//
//   stuck(X)          = 截至 X 日结束时处于封禁 / 归档的非 PG 户，各自累计余额之和
//   封禁EXPENSES(D)   = stuck(D) − stuck(D−1)
//
// 于是：封禁当天 +余额；之后哪天「转出余额」，那天 −转出数；解封当天 −全部；
// 归档 / 取消归档不变（都还算卡住）。已经封禁的老户补记在各自的封禁日。
//
// 日报（bankReport.computeBankDailyReport）与月报（monthlyReport.dailyRows）**共用这一份**，
// 所以同一天两边的数逐分相等（blocked-expense.test.js 守着）。
//
// 刻意的取舍：
// - **PG 不算**：PG 的钱本来就不是自有资金（isCountedInTotals），封禁一个 PG 不是我方损失，
//   解封它也不会「找回」一笔出现在 total_balance 里的钱。用的是**当前** account_kind，
//   类型变更没有历史，接受。
// - **忽略 reset_daily_balance**：问的是「这户里卡着多少钱」，与归档闸门、/blocked 同问题，
//   用无下界的累计余额（带当天 23:59:59 上界）。
// - 生命周期按 bank_account_events 回放，不看 lifecycle_status 的当前值——过去某天的报表
//   要的是「那天结束时」的状态。
//
// ⚠️ 不能 require ./bankReport：bankReport 顶层 require 本模块，反过来就成环。净额表达式
// 因此在这里另写一份，与 bankReport.NET_EXPR 同算法（只多了逐行取整到分）。

const { dateKeyFromIso, shiftDateKey } = require("./dates");
const { statusOf, LIFECYCLE, isPaymentGateway } = require("./bankLifecycle");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 每个生命周期事件发生之后，这户算不算「卡住」。归档与取消归档（回到封禁）都还卡着，
// 只有解封才放出来。
const STUCK_AFTER = Object.freeze({
  banned: true,
  archived: true,
  unarchived: true,
  unbanned: false,
});
const LIFECYCLE_EVENTS = Object.keys(STUCK_AFTER);

// 与 bankReport.NET_EXPR 同算法，但逐行取整成整数「分」再求和：整数相加没有浮点残差，
// 日报（单日区间）和月报（整月 / 整年区间）不论怎么分组，结果都逐分一致。
const NET_CENTS_EXPR =
  "CAST(ROUND((amount_in + trf_amount - ABS(amount_out) - ABS(help_amount)) * 100) AS INTEGER)";

function isStuckNow(account) {
  const s = statusOf(account);
  return s === LIFECYCLE.BANNED || s === LIFECYCLE.ARCHIVED;
}

// bank_account_events.created_at 是 SQLite datetime('now') 写的 **UTC**，换成实例时区的日期键。
// 解析不了返回 ""——它比任何日期键都小，等于「从一开始就生效」。
function localDayOfUtc(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
  return dateKeyFromIso(iso);
}

/**
 * 本公司每个非 PG 户的生命周期时间线：{ initial, transitions: [{ day, stuck }] }，
 * transitions 按发生顺序排列（同一天多次变更，最后一次说了算 = 「当天结束时」的状态）。
 */
function loadTimelines(db, companyId) {
  const accounts = db
    .prepare("SELECT id, lifecycle_status, account_kind FROM bank_accounts WHERE company_id = ?")
    .all(companyId)
    .filter((a) => !isPaymentGateway(a));
  const timelines = new Map();
  if (!accounts.length) return timelines;

  const byAccount = new Map(accounts.map((a) => [Number(a.id), []]));
  const placeholders = LIFECYCLE_EVENTS.map(() => "?").join(", ");
  const events = db
    .prepare(
      `SELECT bank_account_id, event, created_at, id
       FROM bank_account_events
       WHERE company_id = ? AND event IN (${placeholders})
       ORDER BY created_at ASC, id ASC`
    )
    .all(companyId, ...LIFECYCLE_EVENTS);
  for (const e of events) {
    const list = byAccount.get(Number(e.bank_account_id));
    // 别家公司的户、或已删的户：不在本公司账户表里，忽略。
    if (list) list.push({ day: localDayOfUtc(e.created_at), stuck: STUCK_AFTER[e.event] });
  }

  for (const a of accounts) {
    const transitions = byAccount.get(Number(a.id));
    const now = isStuckNow(a);
    let initial;
    if (transitions.length) {
      // 有事件的户：POST /api/banks 一律以 active 建户，所以起点是「没卡住」。
      initial = false;
      const replayed = transitions[transitions.length - 1].stuck;
      // 终态兜底：回放结果与当前状态对不上（丢过事件 / 手工改库），在最后一个事件日补一次
      // 转换。确定性，且保证「今天」的结论永远跟着当前状态走。
      if (replayed !== now) transitions.push({ day: transitions[transitions.length - 1].day, stuck: now });
    } else {
      // 没有任何生命周期事件的户：按当前状态「从一开始」算。init.js 那条迁移把脏状态直接
      // 改成封禁、不写事件；updated_at 又会被每次 refreshBankBalance 改写，当不了封禁日。
      // 这类户每天的流水净额就落在当天，合计起来仍等于它的余额。
      initial = now;
    }
    if (initial || transitions.length) timelines.set(Number(a.id), { initial, transitions });
  }
  return timelines;
}

function stuckAt(timeline, day) {
  let state = timeline.initial;
  for (const t of timeline.transitions) {
    if (t.day <= day) state = t.stuck;
    else break;
  }
  return state;
}

/**
 * [from, to]（含两端，实例时区日期键）每天的封禁 EXPENSES，单位「分」，只含非零的日子。
 * 正数 = 当天有钱被卡住（开销），负数 = 当天从封禁户收回了钱。
 *
 * 不论区间多长都只有 4 条 SQL：账户、生命周期事件、期初余额、按户按日净额。
 */
function blockedExpenseByDay(db, companyId, from, to) {
  const result = new Map();
  if (!companyId || !DATE_RE.test(String(from || "")) || !DATE_RE.test(String(to || "")) || from > to) {
    return result;
  }

  const timelines = loadTimelines(db, companyId);
  const prev = shiftDateKey(from, -1);
  const candidates = [];
  for (const [id, tl] of timelines) {
    if (stuckAt(tl, prev) || tl.transitions.some((t) => t.day >= from && t.day <= to)) {
      candidates.push({ id, tl, running: 0 });
    }
  }
  if (!candidates.length) return result;
  const byId = new Map(candidates.map((c) => [c.id, c]));

  const opening = db
    .prepare(
      `SELECT bank_account_id AS id, COALESCE(SUM(${NET_CENTS_EXPR}), 0) AS n
       FROM bank_ledger
       WHERE company_id = ? AND entry_time <= ?
       GROUP BY bank_account_id`
    )
    .all(companyId, `${prev} 23:59:59`);
  for (const r of opening) {
    const c = byId.get(Number(r.id));
    if (c) c.running = Number(r.n) || 0;
  }

  const netByDay = new Map();
  const daily = db
    .prepare(
      `SELECT bank_account_id AS id, substr(entry_time, 1, 10) AS d, COALESCE(SUM(${NET_CENTS_EXPR}), 0) AS n
       FROM bank_ledger
       WHERE company_id = ? AND entry_time >= ? AND entry_time <= ?
       GROUP BY bank_account_id, d`
    )
    .all(companyId, `${from} 00:00:00`, `${to} 23:59:59`);
  for (const r of daily) {
    if (!byId.has(Number(r.id))) continue;
    if (!netByDay.has(r.d)) netByDay.set(r.d, []);
    netByDay.get(r.d).push([Number(r.id), Number(r.n) || 0]);
  }

  const stuckTotal = (day) => candidates.reduce((s, c) => (stuckAt(c.tl, day) ? s + c.running : s), 0);

  let before = stuckTotal(prev);
  for (let day = from; day <= to; day = shiftDateKey(day, 1)) {
    for (const [id, n] of netByDay.get(day) || []) byId.get(id).running += n;
    const after = stuckTotal(day);
    if (after !== before) result.set(day, after - before);
    before = after;
  }
  return result;
}

/** 截至某日结束时卡在封禁 / 归档户里的钱（分）。给测试与排查用。 */
function stuckBalanceCents(db, companyId, day) {
  const timelines = loadTimelines(db, companyId);
  const ids = [...timelines].filter(([, tl]) => stuckAt(tl, day)).map(([id]) => id);
  if (!ids.length) return 0;
  const rows = db
    .prepare(
      `SELECT bank_account_id AS id, COALESCE(SUM(${NET_CENTS_EXPR}), 0) AS n
       FROM bank_ledger WHERE company_id = ? AND entry_time <= ? GROUP BY bank_account_id`
    )
    .all(companyId, `${day} 23:59:59`);
  const want = new Set(ids);
  return rows.reduce((s, r) => (want.has(Number(r.id)) ? s + (Number(r.n) || 0) : s), 0);
}

module.exports = { blockedExpenseByDay, stuckBalanceCents, localDayOfUtc };
