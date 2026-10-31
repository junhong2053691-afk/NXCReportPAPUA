"use strict";

// 封禁渠道「待清理」：每周一自动汇总 + /blocked 命令，两个入口共用这一份采集与版式。
//
// 存在的理由：封禁账户不参与余额合计（bankReport 的 isCountedInTotals），也不参与阈值
// 报警（bankAlerts 的 isAlertEligible）。这两条都是对的——封禁的钱不是自有余额，反复
// 报同一个不变的数字也只是噪音——但它们叠起来的效果是：一笔钱封进去之后就**彻底静默**
// 了。没有任何机制会再提起它。这个模块补上那个缺口。
//
// 封禁账户已经整组从 /balance 移走——那条命令只回答「在跑着的钱在哪」。所以本模块是
// 封进去那部分钱的**唯一出口**：钱在哪、封了多久、哪些已经可以归档了。
//
// 契约照 bankAlerts：**纯 DB，绝不发网络请求**，只往 telegram_outbox 写行，发送由
// services/telegramBots 的 flush 循环在事务外做。（renderBlocked 是个例外的纯函数：
// 它只把队列渲染成块数组交还给命令分发，同样不碰网络。）

const { balanceFromLedger, bankBranchOf } = require("./bankReport");
const { isBanned, cents, kindOf, kindTag, KIND_TAGS, KIND_LABELS } = require("./bankLifecycle");
const { formatAmount } = require("./bankAlerts");
const { formatSydneyDateTime } = require("./dates");
const { TABLE_MAX_WIDTH, escapeHtml, renderTable } = require("./telegramFormat");
// splitSection 守着「每个块自带成对闭合的 <pre> 且不超 MAX_BLOCK_CHARS」这条铁律。
// 复制一份出去早晚会漂移，所以从 telegramRender 复用。
const { splitSection, WIDE_TABLE_WIDTH } = require("./telegramRender");

// 周一 09:00（Sydney）。做成常量而不是 app_setting：这是一条低频提醒，多一个可配置项
// 就多一处要解释、要校验、要测的地方。
const DIGEST_WEEKDAY = 1; // 0=周日
const DIGEST_HOUR = 9;

// 每公司记住「最近一次入队是哪一周」。内存哨兵扛不住重启，所以下面还有一层 outbox 兜底。
const lastDigestWeek = new Map();

function accountLabel(account) {
  const bank = bankBranchOf(account);
  const name = String(account.account_name || "").trim();
  const tail = String(account.account_number || "").trim().slice(-4);
  const parts = [bank || "(未命名渠道)"];
  if (name) parts.push(name);
  if (tail) parts.push("·" + tail);
  return parts.join(" ");
}

// 距今多少天。created_at 存的是 UTC 的 'YYYY-MM-DD HH:MM:SS'。
function daysSince(isoish, now) {
  const raw = String(isoish || "").trim();
  if (!raw) return null;
  const t = Date.parse(raw.replace(" ", "T") + (raw.includes("Z") ? "" : "Z"));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86400000));
}

/**
 * 读一家公司的待清理队列。纯读，不写任何东西。
 *
 * 分两组是因为需要的动作不同：archivable 只差点一下「归档」，dirty 还得先把钱清出去。
 * 已归档账户不在里面——它们已经完事了。
 */
function collectCleanupQueue(db, companyId, opts = {}) {
  const now = opts.now || new Date();
  const rows = db
    .prepare("SELECT * FROM bank_accounts WHERE company_id = ? ORDER BY sort_order ASC, id ASC")
    .all(String(companyId || ""))
    .filter(isBanned);

  const archivable = [];
  const dirty = [];
  for (const account of rows) {
    // 余额用无上界的 balanceFromLedger，与归档闸门同一个口径——否则周报说「可以归档了」
    // 而闸门拦住，或者反过来，两边谁都不可信。
    const balance = balanceFromLedger(db, account.id);
    let bannedDays = null;
    try {
      const ev = db
        .prepare(
          `SELECT MAX(created_at) AS at FROM bank_account_events
           WHERE bank_account_id = ? AND event = 'banned'`
        )
        .get(account.id);
      bannedDays = daysSince(ev?.at, now);
    } catch (_) {
      bannedDays = null;
    }
    const entry = { account, label: accountLabel(account), balance, bannedDays };
    if (cents(balance) === 0) archivable.push(entry);
    else dirty.push(entry);
  }
  // 拖得越久越该先处理。
  dirty.sort((a, b) => (b.bannedDays || 0) - (a.bannedDays || 0));
  archivable.sort((a, b) => (b.bannedDays || 0) - (a.bannedDays || 0));
  const total = dirty.reduce((s, e) => s + Number(e.balance || 0), 0);
  return { archivable, dirty, total };
}

function daysCell(entry) {
  return entry.bannedDays == null ? "-" : `${entry.bannedDays}天`;
}

function entryRows(entries) {
  return entries.map((e) => ({
    name: e.label,
    days: daysCell(e),
    amount: formatAmount(e.balance),
    // 人头还是幽灵，是看封禁队列时第一个要问的问题——两类的处理路径完全不同。
    flag: kindTag(e.account),
  }));
}

const COLUMNS = [
  { key: "name", align: "left", min: 10 },
  { key: "days", align: "right", min: 4 },
  { key: "amount", align: "right" },
];

// 明细行的行尾挂一个类型标（人/幽/PG）。用 renderTable 的 flag 位是因为它不占宽度预算、
// 而封禁账户永不报警（isAlertEligible 闸门）所以这个位子天然空着，不和渠道名抢 min:10。
//
// **但 flag 不占预算 ≠ 不占屏幕。** /balance 里 ⚠️ 只偶尔出现，整表偶尔超宽还能忍；
// 这里**每一行**都有标，整表会恒定宽 3 格，TABLE_MAX_WIDTH 那条「手机上 <pre> 不横向
// 滚动」的承诺就作废了。所以把表宽让出标 2 格 + 分隔空格 1 格，含标之后正好落回去。
// 只给逐户明细用；总控那份概要没有 flag，照旧用默认宽度。
const ENTRY_TABLE_WIDTH = TABLE_MAX_WIDTH - 3;

function digestTitle(companyName) {
  return companyName ? `🧹 封禁渠道待清理 · ${companyName}` : "🧹 封禁渠道待清理";
}

/** 一家公司的两组表。刻意不含尾注——多公司拼进一条消息时那段话只该出现一次。 */
function cleanupGroupBlocks(queue, title) {
  const blocks = [];
  if (queue.dirty.length) {
    const rows = entryRows(queue.dirty);
    rows.push({ divider: true });
    rows.push({ name: "小计", days: "", amount: formatAmount(queue.total) });
    const { lines } = renderTable(rows, COLUMNS, { maxWidth: ENTRY_TABLE_WIDTH });
    blocks.push(...splitSection(`${title}｜仍有余额（${queue.dirty.length}）`, lines));
  }
  if (queue.archivable.length) {
    const { lines } = renderTable(entryRows(queue.archivable), COLUMNS, {
      maxWidth: ENTRY_TABLE_WIDTH,
    });
    blocks.push(
      ...splitSection(
        `${queue.dirty.length ? "" : title + "｜"}已清零，可直接归档（${queue.archivable.length}）`,
        lines
      )
    );
  }
  return blocks;
}

/**
 * 尾注。类型标是单字，含义必须跟在同一条消息里（照 /balance 那条 marker 图例的规矩），
 * 并且只说真的出现了的那几类——PG 的标就是 PG，不必再解释一遍，所以靠「标≠全称」过滤。
 *
 * emoji 与说明文字只放在 <pre> 外面：等宽宽度各平台不一致，混进表格会把列顶歪。
 */
function cleanupFooter(queues) {
  const kinds = new Set();
  for (const queue of queues) {
    for (const e of [...queue.dirty, ...queue.archivable]) kinds.add(kindOf(e.account));
  }
  const legend = Object.keys(KIND_TAGS)
    .filter((k) => kinds.has(k) && KIND_TAGS[k] !== KIND_LABELS[k])
    .map((k) => `${KIND_TAGS[k]}=${KIND_LABELS[k]}`);
  const lines = [];
  if (legend.length) lines.push(legend.join("　"));
  lines.push("在「渠道管理 → 封禁中」清账后即可归档，归档后不再出现在任何列表里。");
  return escapeHtml(lines.join("\n"));
}

/** 公司 Bot 收的明细版（周一自动推送与 /blocked 单公司都走它）。返回块数组。 */
function renderCleanupDigest(queue, companyName) {
  return [...cleanupGroupBlocks(queue, digestTitle(companyName)), cleanupFooter([queue])];
}

/** 总控 Bot 收的概要版：每家一行。四家公司全展开是上百行，没人读。 */
function renderCleanupSummaryLine(companyName, queue) {
  const oldest = [...queue.dirty, ...queue.archivable].reduce(
    (m, e) => Math.max(m, e.bannedDays || 0),
    0
  );
  return {
    name: companyName,
    days: oldest ? `${oldest}天` : "-",
    amount: formatAmount(queue.total),
    extra: `${queue.dirty.length}待清/${queue.archivable.length}可归档`,
  };
}

/**
 * 渲染 /blocked。
 *
 * 封禁账户整组从 /balance 移走之后，这里是「封进去的钱」唯一的查询入口，所以版式直接
 * 沿用每周汇总（同一份 COLUMNS、同样的两组划分、同样的封禁天数、同样的类型标），差别
 * 只有两处：
 *   1. 这是对一条显式命令的回答，队列空也**必须**有回应——周报那边空队列静默是对的
 *      （见 maybeSendCleanupDigest 里那段注释），命令留空就是歧义；
 *   2. 多公司默认给概要，照 /balance 的分寸（4 家全展开是上百行，没人读）。
 *
 * ⚠️ 金额仍然是 collectCleanupQueue 的 balanceFromLedger（无上界累计），与归档闸门同
 * 口径——这和 /balance 的 displayBalanceForAccount（当日口径、与页面 KPI 一致）**刻意
 * 不同**。同一个每日归零的封禁户在两条命令里数字不一样是对的：那里问「今天在跑的钱
 * 有多少」，这里问「这户里还有没有钱，任何时候」。别去「修平」。
 *
 * @param {object} db
 * @param {Array<{id: string, name: string}>} companies
 * @param {{ detail?: boolean, now?: Date }} opts detail 不传时按公司数量决定。
 */
function renderBlocked(db, companies, opts = {}) {
  if (!companies.length) return ["没有可查看的公司。"];
  const now = opts.now || new Date();
  const detail = opts.detail === undefined ? companies.length <= 1 : Boolean(opts.detail);

  const sections = companies
    .map((company) => ({
      name: String(company.name || company.id || ""),
      queue: collectCleanupQueue(db, company.id, { now }),
    }))
    .filter((sec) => sec.queue.dirty.length || sec.queue.archivable.length);

  // 照 overBlocks 的 ✅ 那条：对一条显式命令，「什么都没有」必须说出来。
  if (!sections.length) return ["✅ 无封禁渠道"];

  if (detail) {
    const blocks = [];
    for (const sec of sections) blocks.push(...cleanupGroupBlocks(sec.queue, digestTitle(sec.name)));
    blocks.push(cleanupFooter(sections.map((sec) => sec.queue)));
    return blocks;
  }

  // 概要：每家一行，复用周一那份总控概要的形状，一个字都不用另写。
  //
  // 唯一的差别是表宽：公司名 + 「2待清/1可归档」挤进 34 格会被截成「2待清/1…」，而那
  // 两个数正是看概要的人唯一要的东西。照多公司 /today 的先例放宽到 WIDE_TABLE_WIDTH
  // ——手机上可能横向滚一点，仍然远好过把信息截没。
  const { lines } = renderTable(
    sections
      .map((sec) => renderCleanupSummaryLine(sec.name, sec.queue))
      .map((r) => ({ name: `${r.name} ${r.extra}`, days: r.days, amount: r.amount })),
    COLUMNS,
    { maxWidth: WIDE_TABLE_WIDTH }
  );
  return [...splitSection("🧹 封禁渠道 · 概要", lines), `单家明细：/blocked ${companies[0].id}`];
}

function enqueue(db, companyId, botKey, text) {
  db.prepare(
    `INSERT INTO telegram_outbox (company_id, bot_key, kind, bank_account_id, text, parse_mode)
     VALUES (?, ?, 'cleanup', 0, ?, 'HTML')`
  ).run(String(companyId || ""), botKey, text);
}

function weekKeyOf(dateKey) {
  return dateKey;
}

/**
 * 定时器每轮调一次；到点且本周没发过才入队。
 *
 * 时间判定走 formatSydneyDateTime 而不是 new Date().getHours()——后者是服务器本地时区，
 * 与业务时区不一定一致（backup.js:308-309 踩过同一个坑）。
 *
 * opts.now / opts.force 供测试注入。
 */
function maybeSendCleanupDigest(db, opts = {}) {
  const now = opts.now || new Date();
  const stamp = formatSydneyDateTime(now.toISOString());
  const dateKey = stamp.slice(0, 10);

  if (!opts.force) {
    const hour = Number(stamp.slice(11, 13));
    if (hour !== DIGEST_HOUR) return [];
    const [y, m, d] = dateKey.split("-").map(Number);
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== DIGEST_WEEKDAY) return [];
  }

  let companies = [];
  try {
    companies = db.prepare("SELECT id, name FROM companies WHERE enabled = 1 ORDER BY sort_order, id").all();
  } catch (_) {
    return [];
  }

  const sent = [];
  const summaryRows = [];
  for (const company of companies) {
    const week = weekKeyOf(dateKey);
    if (!opts.force && lastDigestWeek.get(company.id) === week) continue;

    // 内存哨兵扛不住重启，所以再问一次 outbox：最近 7 天发过没有。
    // 刻意不算「自然周边界」——created_at 是 UTC，和 Sydney 的周一零点对不齐，而要问的
    // 问题本来就是「这周发过没」。
    if (!opts.force) {
      try {
        const done = db
          .prepare(
            `SELECT 1 FROM telegram_outbox
             WHERE kind = 'cleanup' AND company_id = ? AND created_at >= datetime('now', '-7 days')
             LIMIT 1`
          )
          .get(company.id);
        if (done) {
          lastDigestWeek.set(company.id, week);
          continue;
        }
      } catch (_) {}
    }

    const queue = collectCleanupQueue(db, company.id, { now });
    lastDigestWeek.set(company.id, week);
    // 队列空就什么都不发。主动推送里的「✅ 无待清理」是纯噪音——那和 /balance 末尾的
    // ✅ 不同，后者是对一条显式命令的回答，必须有回应。
    if (!queue.dirty.length && !queue.archivable.length) continue;

    for (const text of renderCleanupDigest(queue, company.name)) {
      enqueue(db, company.id, "company:" + company.id, text);
    }
    summaryRows.push(renderCleanupSummaryLine(company.name || company.id, queue));
    sent.push({ companyId: company.id, queue });
  }

  if (summaryRows.length) {
    const { lines } = renderTable(
      summaryRows.map((r) => ({ name: `${r.name} ${r.extra}`, days: r.days, amount: r.amount })),
      COLUMNS
    );
    for (const text of splitSection("🧹 封禁渠道待清理 · 概要", lines)) {
      enqueue(db, "", "control", text);
    }
  }

  if (sent.length) {
    // 只排个队，仍然不在事务内发网络请求。服务未启动时是 no-op。
    try {
      require("../services/telegramBots").scheduleFlush();
    } catch (e) {
      console.warn("[cleanup] schedule flush:", e.message);
    }
  }
  return sent;
}

let digestTimer = null;

function startCleanupDigestScheduler() {
  if (digestTimer) return;
  digestTimer = setInterval(() => {
    try {
      const { getDb } = require("../db/init");
      maybeSendCleanupDigest(getDb());
    } catch (e) {
      console.warn("[cleanup] digest:", e.message);
    }
  }, 60 * 1000);
  if (digestTimer.unref) digestTimer.unref();
}

function stopCleanupDigestScheduler() {
  if (!digestTimer) return;
  clearInterval(digestTimer);
  digestTimer = null;
}

module.exports = {
  collectCleanupQueue,
  renderCleanupDigest,
  renderBlocked,
  maybeSendCleanupDigest,
  startCleanupDigestScheduler,
  stopCleanupDigestScheduler,
  accountLabel,
  DIGEST_WEEKDAY,
  DIGEST_HOUR,
};
