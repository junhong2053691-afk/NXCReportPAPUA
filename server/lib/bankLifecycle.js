"use strict";

// 支付渠道生命周期的唯一真源。
//
// 三态：active（运营中）→ banned（封禁中 / 待清理）→ archived（已归档，终态）。
// 归档是封禁的出口——没有它，封禁区只会越堆越多，把运营中的渠道挤出视野。
//
// 为什么所有判定都收敛到这里：改造之前，全仓 20 多处写的是 `lifecycle_status != 'banned'`
// 这种**反向白名单**，于是任何新状态（以及任何手工改库改出来的错别字）都会被默认当成
// 「可用账户」——能收钱、算进合计、会报警。这里一律改成正向白名单 + 失败关闭。
//
// 本模块对外只暴露纯函数与 SQL 片段常量；唯一碰 db 的是 archiveBlockReason，它惰性
// require bankReport 以断开 bankLifecycle <-> bankReport 的循环依赖（同 bankReport.js
// 惰性 require bankAlerts 的做法）。

const LIFECYCLE = Object.freeze({
  ACTIVE: "active",
  BANNED: "banned",
  ARCHIVED: "archived",
});

const KNOWN = new Set([LIFECYCLE.ACTIVE, LIFECYCLE.BANNED, LIFECYCLE.ARCHIVED]);

// 空值按 schema 默认（lifecycle_status TEXT NOT NULL DEFAULT 'active'）归到 active；
// 枚举外的任何值归到 archived —— 失败关闭。一个来历不明的状态绝不能变成能收钱的账户。
function statusOf(account) {
  if (!account) return LIFECYCLE.ARCHIVED;
  const raw = String(account.lifecycle_status ?? "").trim();
  if (!raw) return LIFECYCLE.ACTIVE;
  return KNOWN.has(raw) ? raw : LIFECYCLE.ARCHIVED;
}

function isOperating(account) {
  return statusOf(account) === LIFECYCLE.ACTIVE;
}
function isBanned(account) {
  return statusOf(account) === LIFECYCLE.BANNED;
}
function isArchived(account) {
  return statusOf(account) === LIFECYCLE.ARCHIVED;
}

// 能不能作为流水 / 审批的落账目标。目前等同 isOperating，单独命名是因为调用点的问题
// 不同（「这户能收钱吗」vs「这户在运营吗」），将来可能分叉。
function isUsableForEntry(account) {
  return isOperating(account);
}

// 计不计进余额合计。PaymentGateway 的钱不是自有资金，历来不计——这条规则的唯一真源，
// 后端 bankReport 与前端 isBalanceExcluded 都走它。
function isCountedInTotals(account) {
  if (!isOperating(account)) return false;
  return String(account.account_kind || "nominee") !== "payment_gateway";
}

// ---------------------------------------------------------- 渠道类型（account_kind）
//
// 枚举真源是 bankApply.js 的 ACCOUNT_KINDS；这里只管「怎么读给人看」，刻意不 require
// 它——那边是整套入账流程，为三个字符串把它拖进 Telegram 的渲染链不值。
//
// 为什么住在本模块而不是渲染层：telegramRender 与 bankCleanupReport 两边都要用，而这
// 两者的依赖只能单向（后者 require 前者取 splitSection），放进任一侧都会成环。本模块
// 已经被双方 require，且已经是唯一读 account_kind 做语义判定的地方（isCountedInTotals）。
//
// 枚举外的值一律落 nominee，与 routes/banks.js 的 normalizeKind 同口径。这是个**显示**
// 判定，不是钱的判定——钱的判定在 isCountedInTotals，那条只问「是不是 payment_gateway」，
// 脏值在那边永远落在「计入合计」一侧，与这里互不影响。

const KIND_LABELS = Object.freeze({
  nominee: "人头",
  ghost: "幽灵",
  // 前端 public/js/bank-accounts.js 那份写的是全称 PaymentGateway；这里刻意用短名：
  // Telegram 的 <pre> 只有 TABLE_MAX_WIDTH(34) 格，全称一个词就吃掉 14 格。
  payment_gateway: "PG",
});

// 行内标记。<pre> 里要成列，所以三个标的**显示宽度必须一致**（都是 2 格，中文字一个
// 顶两格）。换成全称「人头」(4 格) 与「PG」(2 格) 混用，那一列立刻散掉。
// bank-lifecycle.test.js 有断言守着这条。
const KIND_TAGS = Object.freeze({ nominee: "人", ghost: "幽", payment_gateway: "PG" });

function kindOf(account) {
  const raw = String(account?.account_kind || "").trim();
  return Object.prototype.hasOwnProperty.call(KIND_LABELS, raw) ? raw : "nominee";
}

function kindLabel(account) {
  return KIND_LABELS[kindOf(account)];
}

function kindTag(account) {
  return KIND_TAGS[kindOf(account)];
}

// 要不要参与 alert_threshold 阈值报警。注意 active = 0（未启用）的账户**照常报警**，
// 里面可能躺着还没转走的钱——那条规则在 bankAlerts.js 里，不归这里管。
function isAlertEligible(account) {
  return isOperating(account);
}

// 出现在 Telegram /balance /today 里吗。归档 = 已经完事，不再占版面。
function isVisibleInTelegram(account) {
  return !isArchived(account);
}

// SQL 片段。正向白名单，不写 NOT IN ('banned','archived')：反向写法对将来的第四态和
// 任何脏值都是放行的，而放行的后果是那个账户开始收钱。片段里没有用户输入，无注入面。
const SQL_OPERATING = "lifecycle_status = 'active'";
const SQL_NOT_ARCHIVED = "lifecycle_status <> 'archived'";

function cents(n) {
  return Math.round(Number(n || 0) * 100);
}

function fmtMoney(n) {
  const v = Number(n || 0);
  const s = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${v < 0 ? "-" : ""}$${s}`;
}

// 归档闸门。返回 null 表示可以归档，否则返回给人看的中文拦截原因。
//
// 抽成纯函数是为了可测——路由只负责把它翻译成 409。三条规则的顺序就是给操作者的
// 指路顺序：先封禁 → 再清钱 → 再处理可恢复的已删流水。
//
// ⚠️ 余额必须用 balanceFromLedger（无上界累计），**不能**用 displayBalanceForAccount。
// 后者对 reset_daily_balance = 1 的账户只算当日净额：一个每日归零的封禁户累计躺着
// 5000、今天恰好没有流水，它就返回 0，闸门放行，钱被归档藏起来。它还有 entry_time
// 上界，存在未来日期流水时同样偏低（见 bankReport.js:60-63 的注释）。
// CLAUDE.md 里「报警余额必须用 displayBalanceForAccount」说的是**报警**——报警要和页面
// 上那个数一致；归档闸门问的是另一个问题：「这户里还有没有钱，任何时候」。
function archiveBlockReason(db, account) {
  if (!account) return "渠道不存在";
  if (!isBanned(account)) {
    return isArchived(account) ? "该渠道已归档" : "请先封禁该渠道再归档";
  }

  const { balanceFromLedger } = require("./bankReport");
  const balance = balanceFromLedger(db, account.id);
  if (cents(balance) !== 0) {
    return `尚余 ${fmtMoney(balance)} 待清，归档前请先清空余额`;
  }

  // 已删流水可以被 POST /api/banks/ledger/deleted/:id/restore 塞回去并刷新余额——
  // 对已归档的户做这件事，会让它在所有视图之外悄悄带上余额。restore 端点那边也补了
  // 一道拒绝，这里是第一道。
  const del = db
    .prepare("SELECT COUNT(*) AS n FROM bank_ledger_deleted WHERE bank_account_id = ?")
    .get(account.id);
  const n = Number(del?.n || 0);
  if (n > 0) {
    return `该渠道有 ${n} 条可恢复的已删流水，请先彻底处理`;
  }

  return null;
}

module.exports = {
  LIFECYCLE,
  statusOf,
  isOperating,
  isBanned,
  isArchived,
  isUsableForEntry,
  isCountedInTotals,
  KIND_LABELS,
  KIND_TAGS,
  kindOf,
  kindLabel,
  kindTag,
  isAlertEligible,
  isVisibleInTelegram,
  SQL_OPERATING,
  SQL_NOT_ARCHIVED,
  archiveBlockReason,
  cents,
  fmtMoney,
};
