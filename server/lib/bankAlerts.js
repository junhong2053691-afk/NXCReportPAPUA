const { todayKey, formatSydneyDateTime } = require("./dates");
const { displayBalanceForAccount, bankBranchOf } = require("./bankReport");
const { isAlertEligible } = require("./bankLifecycle");
const { escapeHtml, pre, renderTable } = require("./telegramFormat");

// 余额上限报警的判定与入队。
//
// 这个模块**只做 DB 操作**，绝不发网络请求：它运行在调用方（审批 / 流水 CRUD）的事务
// 内部，在那里 await 一个 HTTP 请求会把整个事务卡住，后台点「审批」就会转圈。
// 判定结果写进 telegram_outbox 表，与业务写入同一事务——回滚时一起回滚，不会出现
// 「消息发了但余额没变」。真正的发送由 services/telegramOutbox.js 在事务外完成。

// 金额一律转成「分」的整数再比较，避免浮点边界抖动（bankApply.js:411 已是同样惯例）。
function cents(value) {
  return Math.round(Number(value || 0) * 100);
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function formatAmount(value) {
  return money(value).toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function accountLabel(account) {
  const bank = bankBranchOf(account);
  const name = String(account.account_name || "").trim();
  const tail = String(account.account_number || "").trim().slice(-4);
  const parts = [bank || "(未命名渠道)"];
  if (name) parts.push(name);
  if (tail) parts.push("·" + tail);
  return parts.join(" ");
}

// 阈值 <= 0 / 非有限数 一律视为「未启用」。前端把留空映射成 0。
function thresholdOf(account) {
  const n = Number(account.alert_threshold || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 是否处于「已报警」状态。
//
// 每日归零账户的比较基准每天午夜重置，所以它的已报警标记也必须跨日作废：否则
// 23:50 触发过一次之后，第二天第一笔流水就把当日净额顶过阈值时，会因为标记还在而
// 被误判成「已经报过了」从而漏报。累计余额账户的基准不重置，忽略日期。
function isFired(account, dateKey) {
  if (!String(account.alert_fired_at || "")) return false;
  if (!account.reset_daily_balance) return true;
  return String(account.alert_fired_date || "") === dateKey;
}

/**
 * 复位已报警状态，并把这一轮已经发出去的报警从聊天里撤回。
 *
 * 三列一次清干净。不变量是 `alert_fired_at = '' ⇒ 另外两列也为空`——留下一个「标记空
 * 但基准非空」的中间态，下一个读 alert_fired_balance 的人就会踩。
 *
 * **撤回在这里只排队，绝不发包**：本函数运行在调用方的事务里，和报警入队同一条规矩。
 * 真正的 deleteMessage / editMessageText 由事务外的 flush 循环做
 * （services/telegramBots.js 的 deliverRetract）。事务回滚时这行任务一起回滚。
 *
 * 四个复位入口（阈值停用 / 阈值变更 / 账户封禁归档 / 跌回阈值下）共用这一个函数：
 * 报警不再成立的理由各不相同，但「那条 ⚠️ 不该再挂在聊天里」是一样的。各入口自己
 * 抄一遍撤回逻辑，早晚会漏掉一处。
 *
 * 接 account 行而不是 id：调用方手上都有，而渲染「✅ 已处理 · <渠道>」要用它。
 */
function clearFired(db, account) {
  const id = Number(account?.id ?? account);
  db.prepare(
    `UPDATE bank_accounts
     SET alert_fired_at = '', alert_fired_date = '', alert_fired_balance = 0
     WHERE id = ?`
  ).run(id);
  if (account && typeof account === "object" && hasOutstandingMessages(db, id)) {
    enqueue(db, account, renderRetracted(account), { kind: "retract", parseMode: "" });
  }
}

/**
 * 还有没有挂在聊天里、没被撤回的报警消息。
 *
 * 只在真有消息挂着时才排撤回任务：清掉残留标记（阈值停用、账户刚被封禁）在现实中
 * 几乎都对应「一条都没发出去」，无条件排队只会在 outbox 里堆一堆空活。
 *
 * 查不到表就当没有——与下面查公司名同一个原则：**报警判定永不因为撤回而失败**。
 */
function hasOutstandingMessages(db, bankAccountId) {
  try {
    return !!db
      .prepare(
        "SELECT 1 FROM telegram_sent_messages WHERE bank_account_id = ? AND retracted_at = '' LIMIT 1"
      )
      .get(bankAccountId);
  } catch {
    return false;
  }
}

// 撤不掉（超过 Telegram 允许删除的 48 小时）时，原消息被就地改成这一行。
// 纯文本、不进 <pre>，所以不转义——parse_mode 也是空的（见 telegram.editMessageText）。
function renderRetracted(account) {
  return "✅ 已处理 · " + accountLabel(account);
}

/**
 * 报警正文。与 /balance 共用 telegramFormat 的等宽块：真正需要对齐的只有「当前余额」和
 * 「报警阈值」两个数字——一眼看出超了多少是这条消息的全部意义，所以只有它们进 <pre>，
 * 其余是普通行。
 *
 * 输出是**含 HTML 标签的单个字符串**，enqueue 会把 parse_mode='HTML' 一起写进 outbox。
 * 发送侧解析失败会自动降级成纯文本（telegram.js 的 sendMessage），不会丢消息。
 */
function renderAlert(account, balance, threshold, dateKey, companyName) {
  const basis = account.reset_daily_balance ? "当日净额" : "累计余额";
  const { lines } = renderTable(
    [
      { label: basis, amount: formatAmount(balance) },
      { label: "报警阈值", amount: formatAmount(threshold) },
    ],
    [
      { key: "label", align: "left", min: 8 },
      { key: "amount", align: "right" },
    ],
    { maxWidth: 28 }
  );
  const title = companyName ? "⚠️ 余额报警 · " + companyName : "⚠️ 余额报警";
  const now = formatSydneyDateTime(new Date().toISOString());
  const stamp = account.reset_daily_balance
    ? `统计日期 ${dateKey} · 时间 ${now}`
    : `时间 ${now}`;
  return [
    escapeHtml(title),
    escapeHtml("渠道：" + accountLabel(account)),
    pre(lines),
    escapeHtml(stamp),
    escapeHtml("发送 /balance 查看全部账户余额。"),
  ].join("\n");
}

function enqueue(db, account, text, opts = {}) {
  // parse_mode 跟着行走，而不是发送时统一决定：升级前积压在 pending 的老行是未转义的
  // 纯文本，按 HTML 发会让含 `&` 的银行名 400（见 telegramBots.deliver）。
  const kind = opts.kind || "alert";
  const parseMode = opts.parseMode === undefined ? "HTML" : opts.parseMode;
  db.prepare(
    `INSERT INTO telegram_outbox (company_id, bot_key, kind, bank_account_id, text, parse_mode)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    String(account.company_id || ""),
    "company:" + String(account.company_id || ""),
    kind,
    Number(account.id),
    text,
    parseMode
  );
  // 写完立刻催一次发送，正常延迟 <100ms；定时轮询只作兜底。
  //
  // 这里只是 setImmediate 排个队，仍然不在事务内发网络请求。万一调用方的事务随后
  // 回滚，上面这行 INSERT 也会一起回滚，届时 flush 读不到任何 pending 行——出站队列
  // 用 DB 表而不是内存队列，正是为了这个性质。
  //
  // 惰性 require 断开 telegramBots -> telegramRender -> bankAlerts 的循环依赖；
  // 服务未启动时 scheduleFlush 是 no-op，所以单元测试不会去碰真实数据库。
  try {
    require("../services/telegramBots").scheduleFlush();
  } catch (e) {
    console.warn("[alert] schedule flush:", e.message);
  }
}

// 判定一个账户是否需要报警，并在需要时写入 outbox。纯 DB，事务安全，永不抛出到调用方
// 之外（调用方 refreshBankBalance 另有 try/catch 兜底）。
function evaluateBalanceAlert(db, bankAccountId, opts = {}) {
  if (!bankAccountId) return null;
  const account = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(bankAccountId);
  if (!account) return null;

  const dateKey = opts.dateKey || todayKey();
  const threshold = thresholdOf(account);
  const fired = isFired(account, dateKey);

  // 未启用阈值：顺手复位残留状态，以免以后重新启用时第一次跨越被吞掉。
  if (!threshold) {
    if (String(account.alert_fired_at || "")) clearFired(db, account);
    return null;
  }

  // 已封禁 / 已归档账户不报警（需求 6）。注意 active = 0 的账户**照常报警**——里面可能
  // 正躺着一笔没转走的钱，那恰恰最该被提醒。
  // 封禁户的余额改由每周一条「待清理」汇总盯着（lib/bankCleanupReport.js），归档户
  // 的余额已被归档闸门保证为 0。
  if (!isAlertEligible(account)) {
    if (String(account.alert_fired_at || "")) clearFired(db, account);
    return null;
  }

  const balance = displayBalanceForAccount(db, account, dateKey);
  const over = cents(balance) >= cents(threshold);

  // 跌回阈值下：静默复位，不发「已恢复」之类的消息。下次再跨越会重新报。
  if (!over) {
    if (fired) clearFired(db, account);
    return null;
  }

  // 超标期间：只有比「上次报警时的余额」更高才再报一次。
  //
  // 基准刻意是上次报警时的余额，而不是上一笔流水前的余额：阈值 200、在 400 时报过之后，
  // 转走 50 变 350、再进 20 变 370 都不该再响——同一桶钱来回动不是新信息，涨过 400 才是。
  //
  // 必须写成 `fired && ...` 而不是直接比 alert_fired_balance：每日归零账户跨日时 isFired
  // 已经是 false，这样昨天那个高点才不会把今天第一笔吞掉（那一列此刻还是昨天的残值）。
  //
  // 刻意不做合并间隔 / 最短间隔：真实数据上近 7 天 29 个设了阈值的账户也只从 3 条变 8 条，
  // 节流唯一的作用是制造「该响的那条被压掉」。
  if (fired && cents(balance) <= cents(account.alert_fired_balance)) return null;

  db.prepare(
    `UPDATE bank_accounts
     SET alert_fired_at = datetime('now'), alert_fired_date = ?, alert_fired_balance = ?
     WHERE id = ?`
  ).run(dateKey, balance, bankAccountId);
  // 公司名只是抬头（报警会抄送总控 chat，那里必须一眼看出是哪家）。查不到就省掉，
  // 绝不能让它挡住报警——单测用的内存库里可能根本没有 companies 行。
  let name = "";
  try {
    name =
      db.prepare("SELECT name FROM companies WHERE id = ?").get(String(account.company_id || ""))
        ?.name || "";
  } catch {
    name = "";
  }
  const text = renderAlert(account, balance, threshold, dateKey, name);
  enqueue(db, account, text);
  return { bankAccountId, companyId: account.company_id, balance, threshold, text };
}

/**
 * 当前超上限的账户，喂网页余额报警（public/js/balance-alerts.js，经 GET /pending-counts）。
 *
 * **纯读**：不写 alert_fired_* 也不入队。判定口径与 evaluateBalanceAlert 完全一致
 * （thresholdOf / isAlertEligible / displayBalanceForAccount / 按分比较）。
 *
 * alertedBalance 是网页报警的 signature 基准：已报警时取 alert_fired_balance（只在余额涨过
 * 上次报警值时才变），所以网页「涨过上次就重响」直接跟着 Telegram 走，同一桶钱来回动不重响。
 * 还没报过（例如报警判定此刻还没跑到它）就退回当前余额。
 */
function overLimitAccounts(db, companyId, dateKey = todayKey()) {
  if (!companyId) return [];
  const rows = db
    .prepare(
      "SELECT * FROM bank_accounts WHERE company_id = ? AND alert_threshold > 0 ORDER BY sort_order ASC, id ASC"
    )
    .all(companyId);
  const out = [];
  for (const account of rows) {
    const threshold = thresholdOf(account);
    if (!threshold || !isAlertEligible(account)) continue;
    const balance = displayBalanceForAccount(db, account, dateKey);
    if (cents(balance) < cents(threshold)) continue;
    const alerted = isFired(account, dateKey) ? money(account.alert_fired_balance) : balance;
    out.push({
      id: account.id,
      label: accountLabel(account),
      balance,
      threshold,
      alertedBalance: alerted,
    });
  }
  return out;
}

module.exports = {
  evaluateBalanceAlert,
  overLimitAccounts,
  // 导出给 routes/banks.js：阈值被改时也要复位。复位要清哪几列只有这一份，
  // 调用方自己抄一遍 UPDATE 早晚会漏掉新加的列。
  clearFired,
  renderAlert,
  accountLabel,
  formatAmount,
  thresholdOf,
  isFired,
  cents,
};
