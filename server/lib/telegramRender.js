// /balance 与 /today 的消息渲染。
//
// /balance 只回答「在跑着的钱在哪」：运营中 + PaymentGateway 两组，**封禁账户整组不在
// 这里**。封进去的钱由 /blocked 回答（lib/bankCleanupReport.js，与每周一那份待清理汇总
// 共用同一套采集与版式）。
//
// 总控 Bot 和公司 Bot 共用这整套渲染，差别只在传进来的 companies 数组长度——公司 Bot
// 传一家，总控 Bot 传全部启用公司。多家时默认只给**概要**（每家一行小计 + 仅列出超标
// 账户），明细按需 `/balance <公司>`：4 家公司 × 十几个账户全展开是上百行，没人读。
//
// 输出是**块数组**（每公司一节 + 总计一节），交给 telegram.chunkMessage 装箱，
// 这样切分总是发生在公司之间而不是某公司的账户列表中间。
//
// 排版走 HTML parse_mode 的 <pre> 等宽块（见 lib/telegramFormat.js 头部的三条约定）：
// Telegram 正文是比例字体，纯文本靠空格对齐在手机上一定歪。由此而来的两条硬约束：
//
//   1. **每个块必须自带成对闭合的 <pre>**，且长度不超过 MAX_BLOCK_CHARS。chunkMessage
//      在单块装不下时会按行切，切在 <pre> 中间 Telegram 返回 400，整条消息发不出去。
//      账户多到一个块装不下时由 splitSection 拆成多个自闭合块。
//   2. 转义只在 telegramFormat.pre() / escapeHtml() 这两个出口做，渲染过程一路用原文；
//      先转义再补白会把 `&amp;` 当 5 格宽。

const { todayKey } = require("./dates");
const { displayBalanceForAccount, bankBranchOf } = require("./bankReport");
const { formatAmount } = require("./bankAlerts");
const {
  isBanned,
  isAlertEligible,
  isVisibleInTelegram,
  kindOf,
  KIND_LABELS,
} = require("./bankLifecycle");
const {
  TABLE_MAX_WIDTH,
  displayWidth,
  truncateToWidth,
  escapeHtml,
  pre,
  renderTable,
} = require("./telegramFormat");

// 单个消息块的上限。chunkMessage 的正文上限是 3900，页脚预留 16，这里再留一大截余量
// 给块间的 "\n\n" 与转义膨胀（`&` → `&amp;`）。
const MAX_BLOCK_CHARS = 3000;

// 多公司 /today 的表天生就宽（公司 + 三个金额列），手机上会横向滚动。这仍然远好过
// 每家 4 行铺满一屏，所以单独给它一个更宽的上限。
const WIDE_TABLE_WIDTH = 46;

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function companyName(company) {
  return String(company.name || company.id || "");
}

function listAccounts(db, companyId) {
  return db
    .prepare("SELECT * FROM bank_accounts WHERE company_id = ? ORDER BY sort_order ASC, id ASC")
    .all(companyId);
}

/** 账户在 /balance 里的一行数据。 */
function accountEntry(db, account, dateKey) {
  const balance = displayBalanceForAccount(db, account, dateKey);
  const threshold = Number(account.alert_threshold || 0);
  const marks = [];
  if (account.reset_daily_balance) marks.push("日");
  if (!account.active) marks.push("停");
  return {
    bank: bankBranchOf(account) || "(未命名渠道)",
    holder: String(account.account_name || "").trim(),
    tail: String(account.account_number || "").trim().slice(-4),
    marker: marks.length ? " " + marks.join("") : "",
    amount: formatAmount(balance),
    balance,
    // 封禁 / 归档账户永远不报警（bankAlerts.js 的 isAlertEligible 闸门），所以也不该
    // 打 ⚠️——那会让人以为该处理它。
    over:
      isAlertEligible(account) &&
      threshold > 0 &&
      Math.round(balance * 100) >= Math.round(threshold * 100),
    account,
  };
}

/**
 * 账户在表里的显示名。
 *
 * **有尾号就用尾号认人，没有尾号才补户名。** 真实数据里两者互补：挂了卡号的账户尾号唯一，
 * 而没挂卡号的（`bank_branch` 常常只是 "NAB"）只能靠户名区分——同一家银行 3 个账户全显示
 * "NAB" 是没法用的。两者都塞进去则一律被截成 "NAB BRIDGET ISABE…·7122"，比原来还乱。
 */
function accountLabelFor(entry, nameWidth) {
  const markerWidth = displayWidth(entry.marker);
  if (entry.tail) {
    // 尾号与标记绝不参与截断：前者是辨认依据，后者决定这个数字怎么读。
    const budget = Math.max(4, nameWidth - markerWidth - 1 - entry.tail.length);
    return truncateToWidth(entry.bank, budget) + "·" + entry.tail + entry.marker;
  }
  const who = entry.holder ? entry.bank + " " + entry.holder : entry.bank;
  return truncateToWidth(who, Math.max(4, nameWidth - markerWidth)) + entry.marker;
}

function accountRows(entries, nameWidth) {
  return entries.map((e) => ({
    name: accountLabelFor(e, nameWidth),
    amount: e.amount,
    flag: e.over ? "⚠️" : "",
  }));
}

/**
 * 「粒数」= 在跑着的账户构成。
 *
 * 刻意只数 operating + gateways，**不数封禁**——/balance 的范围就是「在跑着的」，粒数
 * 和它上面那张表必须是同一批账户，否则读者会去找那几粒在哪一行。
 *
 * ghost 与 nominee 在钱的口径上完全同等（isCountedInTotals，bank-lifecycle.test.js 有
 * 断言），分开数只为回答另一个问题：这家现在靠几个人头、几个幽灵在跑。
 */
function countsOf(operating, gateways) {
  let nominee = 0;
  let ghost = 0;
  for (const e of operating) {
    if (kindOf(e.account) === "ghost") ghost++;
    else nominee++;
  }
  return { nominee, ghost, gateway: gateways.length };
}

/** 明细模式脚注里那句总结。只给粒数不给小计：钱的数字上面那张表已经逐行给过了。 */
function countsNote(counts) {
  const parts = [];
  if (counts.nominee) parts.push(`${KIND_LABELS.nominee} ${counts.nominee} 粒`);
  if (counts.ghost) parts.push(`${KIND_LABELS.ghost} ${counts.ghost} 粒`);
  if (counts.gateway) parts.push(`${KIND_LABELS.payment_gateway} ${counts.gateway} 粒`);
  // 0 粒的那一类不占位置——照 marker 图例那条规矩，只说真的出现了的东西。
  return parts.length ? "※ 构成：" + parts.join(" · ") : null;
}

/**
 * 概要模式那一列。PG 刻意不进这一列：34 格的表装不下第三个数，而 PG 本来也不计入
 * 合计，「这家靠几个人头几个幽灵在跑」才是看概要的人要的那条信息。
 */
function countsCell(counts) {
  const parts = [];
  if (counts.nominee) parts.push(`${counts.nominee}人`);
  if (counts.ghost) parts.push(`${counts.ghost}幽`);
  return parts.join("/");
}

// 只在真的有封禁账户时才提一句，且不带数字不带金额：/balance 已经不回答封禁的问题了，
// 这里只负责让人知道还有另一条命令。
const BLOCKED_HINT = "封禁渠道详情：/blocked";

/**
 * 整条消息共用一套列宽：所有公司的表、小计行、合计行的金额右边界必须落在同一条线上，
 * 否则每家一个宽度，看起来比原来还乱。
 */
function balanceLayout(amounts) {
  const amountWidth = amounts.reduce((w, a) => Math.max(w, displayWidth(a)), 8);
  const width = Math.max(TABLE_MAX_WIDTH, amountWidth + 14);
  const nameWidth = width - 2 - amountWidth;
  return {
    width,
    nameWidth,
    columns: [
      { key: "name", align: "left", min: nameWidth, max: nameWidth },
      { key: "amount", align: "right", min: amountWidth, max: amountWidth },
    ],
  };
}

/**
 * 把一节的行拆成若干个自闭合的 <pre> 块，保证每块都在 MAX_BLOCK_CHARS 以内。
 *
 * 这是 <pre> 不被 chunkMessage 从中间切开的唯一保障。正常数据量下只会返回一个块。
 */
function splitSection(title, lines) {
  const blocks = [];
  let batch = [];
  const flush = (isFirst) => {
    if (!batch.length) return;
    const head = title ? escapeHtml(isFirst ? title : title + "（续）") + "\n" : "";
    blocks.push(head + pre(batch));
    batch = [];
  };
  for (const line of lines) {
    batch.push(line);
    // 用已转义后的长度估算，转义膨胀已经算进去了。
    if (pre(batch).length > MAX_BLOCK_CHARS) {
      batch.pop();
      flush(blocks.length === 0);
      batch.push(line);
    }
  }
  flush(blocks.length === 0);
  return blocks;
}

/**
 * 读一家公司的账户，分「运营中 / PaymentGateway」两组。
 *
 * **封禁账户整组不在这里露面。** /balance 只回答「在跑着的钱在哪」；封进去的钱封了
 * 多久、哪些已经可以归档，由 /blocked 回答（lib/bankCleanupReport.js，与每周汇总同一
 * 份版式）。所以这里对封禁户只数个数——那个数字唯一的用途是决定要不要在末尾提一句
 * /blocked，连 displayBalanceForAccount 那次 SQL 都不必跑。
 *
 * 小计口径仍然刻意与页面 KPI 对齐（bankReport.js 的 total_balance / isCountedInTotals）：
 * 排除 PaymentGateway。否则 Telegram 里的总额和后台页面上的 sum-balance 对不上，报警的
 * 可信度立刻归零。
 *
 * 已归档账户在入口就被滤掉——它们已经清零并退役，列出来只会占版面。注意 count 现在是
 * 「在 /balance 里露面的行数」而不是账户总数：「（无支付渠道）」与「合计 0.00」的判定
 * 都跟着它，用账户总数会让一家只剩封禁户的公司渲染出一张空表加一行 0.00 的合计。
 */
function collectCompany(db, company, dateKey) {
  const accounts = listAccounts(db, company.id).filter(isVisibleInTelegram);
  const operating = [];
  const gateways = [];
  let bannedCount = 0;
  for (const account of accounts) {
    if (isBanned(account)) {
      bannedCount++;
      continue;
    }
    const entry = accountEntry(db, account, dateKey);
    if (kindOf(account) === "payment_gateway") gateways.push(entry);
    else operating.push(entry);
  }
  return {
    company,
    count: operating.length + gateways.length,
    bannedCount,
    operating,
    gateways,
    counts: countsOf(operating, gateways),
    subtotal: operating.reduce((s, e) => s + money(e.balance), 0),
    // PG 留着：不计入合计，但钱躺在里面照样要提醒。封禁户本来就不参与报警判定
    // （bankAlerts.js:122-125），现在连行都没有了。
    over: [...operating, ...gateways].filter((e) => e.over).map((entry) => ({ company, entry })),
  };
}

function companyDetailBlocks(section, layout) {
  const title = `【${companyName(section.company)}】`;
  if (!section.count) {
    // 有封禁户却一粒在跑的都没有时，「无支付渠道」是错的——这家有渠道，只是全封了。
    return splitSection(title, [section.bannedCount ? "（无运营中渠道）" : "（无支付渠道）"]);
  }

  const rows = [{ raw: "运营中" }];
  if (section.operating.length) rows.push(...accountRows(section.operating, layout.nameWidth));
  else rows.push({ raw: "（无）" });
  rows.push({ divider: true }, { name: "小计", amount: formatAmount(section.subtotal) });
  if (section.gateways.length) {
    rows.push({ raw: "" }, { raw: "PaymentGateway（不计入合计）" });
    rows.push(...accountRows(section.gateways, layout.nameWidth));
  }
  const { lines } = renderTable(rows, layout.columns, { maxWidth: layout.width });
  return splitSection(title, lines);
}

function overBlocks(overEntries) {
  if (!overEntries.length) return ["✅ 无账户超过阈值"];
  const rows = overEntries.map(({ company, entry }) => ({
    company: companyName(company),
    name: accountLabelFor(entry, 24),
    amount: entry.amount,
  }));
  const { lines } = renderTable(
    rows,
    [
      { key: "company", align: "left", min: 6, max: 10 },
      { key: "name", align: "left", min: 8 },
      { key: "amount", align: "right" },
    ],
    { maxWidth: WIDE_TABLE_WIDTH, gap: 1 }
  );
  return splitSection(`⚠️ 超标 ${overEntries.length} 个账户`, lines);
}

/**
 * 渲染 /balance。
 *
 * @param {object} db
 * @param {Array<{id: string, name: string}>} companies
 * @param {{ dateKey?: string, detail?: boolean }} opts
 *        detail 不传时按公司数量决定：单家给明细，多家给概要。
 */
function renderBalance(db, companies, opts = {}) {
  if (!companies.length) return ["没有可查看的公司。"];
  const dateKey = opts.dateKey || todayKey();
  const detail = opts.detail === undefined ? companies.length <= 1 : Boolean(opts.detail);
  const header = `💰 渠道余额 · ${dateKey}`;

  const sections = companies.map((company) => collectCompany(db, company, dateKey));
  const grandTotal = sections.reduce((s, sec) => s + sec.subtotal, 0);
  const over = sections.flatMap((sec) => sec.over);
  const totalText = formatAmount(grandTotal);

  if (detail) {
    const amounts = [totalText];
    for (const sec of sections) {
      amounts.push(formatAmount(sec.subtotal));
      for (const e of [...sec.operating, ...sec.gateways]) amounts.push(e.amount);
    }
    const layout = balanceLayout(amounts);
    const blocks = [header];
    for (const sec of sections) blocks.push(...companyDetailBlocks(sec, layout));

    // 一家公司一个渠道都没有时不再挂个 0.00 的合计——那一行只是噪音。
    if (sections.some((sec) => sec.count)) {
      const { lines } = renderTable([{ name: "合计", amount: totalText }], layout.columns, {
        maxWidth: layout.width,
      });
      // 标记是单字，含义必须跟在同一条消息里——但只在真的出现了才占一行宽度。
      const shownMarkers = sections.flatMap((sec) =>
        [...sec.operating, ...sec.gateways].map((e) => e.marker)
      );
      const marks = [];
      if (shownMarkers.some((m) => m.includes("日"))) marks.push("日=当日净额");
      if (shownMarkers.some((m) => m.includes("停"))) marks.push("停=未勾使用中");
      // 多公司明细（/balance all）时粒数是整条消息的合计——脚注跟着合计块走，一条
      // 消息一份，不必每家重复一遍。
      const totalCounts = sections.reduce(
        (acc, sec) => ({
          nominee: acc.nominee + sec.counts.nominee,
          ghost: acc.ghost + sec.counts.ghost,
          gateway: acc.gateway + sec.counts.gateway,
        }),
        { nominee: 0, ghost: 0, gateway: 0 }
      );
      // 分行而不是一长行：说明文字在 <pre> 外面，太长会在手机上折得很难看。
      // 「※ 合计不含 PG 与封禁」保留原文：它声明的是与页面 KPI 对齐的合计口径。封禁户
      // 虽然不再露面，改成「不含 PG」反而让人以为封禁的钱算进去了。
      const note = [
        countsNote(totalCounts),
        "※ 合计不含 PG 与封禁",
        marks.length ? "　" + marks.join("　") : null,
      ]
        .filter(Boolean)
        .join("\n");
      blocks.push(pre(lines) + "\n" + escapeHtml(note));
    }
    if (sections.some((sec) => sec.bannedCount)) blocks.push(BLOCKED_HINT);
    return blocks;
  }

  // 概要模式：每家一行小计 + 一列粒数，账户明细一概不展开。整张表只有一个，列宽让它
  // 自己按数据取，不必套 balanceLayout 那套跨块对齐。
  //
  // 加了第三列仍然用默认的 TABLE_MAX_WIDTH(34)/gap 2：典型行 8+2+7+2+10 = 29；最坏
  // （四字中文公司名 + 七位数金额）12+2+9+2+12 = 37，压缩只动 left 列，公司名退到下限
  // 8 ⇒ 33，仍然不横向滚动。telegram-render.test.js 有逐行宽度断言守着。
  const rows = [{ name: "公司", kinds: "粒数", amount: "余额" }];
  for (const sec of sections) {
    rows.push({
      name: companyName(sec.company),
      kinds: sec.count ? countsCell(sec.counts) : "",
      // 一粒在跑的都没有但有封禁户：说「无渠道」是错的，这家有渠道，只是全封了。
      // 两个词刻意同宽（10 格），换哪个都不会把金额列顶宽。
      amount: sec.count
        ? formatAmount(sec.subtotal)
        : sec.bannedCount
          ? "（全封禁）"
          : "（无渠道）",
    });
  }
  // 合计行刻意不填粒数：这一行回答的是钱，而「全部公司一共几粒」没人据此做决定；
  // 顺带让「合计 <金额>」这一行保持可直读（telegram-render.test.js 有断言照着它写）。
  rows.push({ divider: true }, { name: "合计", amount: totalText });
  const { lines } = renderTable(rows, [
    { key: "name", align: "left", min: 8 },
    // 右对齐不是为了好看，是为了别被截断：renderTable 超宽时只压缩 left 列
    // （telegramFormat.js 的压缩循环跳过 right），「3人/1幽」截成「3人/…」毫无意义。
    { key: "kinds", align: "right" },
    { key: "amount", align: "right" },
  ]);

  const blocks = [
    header,
    pre(lines) + "\n" + escapeHtml("※ 合计不含 PG 与封禁"),
    ...overBlocks(over),
    `明细：/balance ${companies[0].id}`,
  ];
  if (sections.some((sec) => sec.bannedCount)) blocks.push(BLOCKED_HINT);
  return blocks;
}

const TODAY_COLUMNS = [
  { key: "label", align: "left", min: 6 },
  { key: "amount", align: "right" },
  { key: "count", align: "left" },
];

function todayRows(stats) {
  const dep = money(stats.deposits?.total);
  const wd = money(stats.withdrawals?.total);
  return [
    { label: "充值", amount: formatAmount(dep), count: `${stats.deposits?.count || 0} 笔` },
    { label: "提现", amount: formatAmount(wd), count: `${stats.withdrawals?.count || 0} 笔` },
    { label: "净额", amount: formatAmount(money(stats.winLoss?.total)), count: "" },
    { label: "充值人数", amount: String(stats.depositUsersToday || 0), count: "" },
    { label: "新注册", amount: String(stats.customers?.newToday || 0), count: "" },
  ];
}

/**
 * 渲染 /today。复用 stats.js 的 computeDashboard，与首页看板同源——不要另写 SQL，
 * 那会绕过测试账号过滤，数字会和首页对不上。
 *
 * `opts.computeDashboard` 只为单测与排版预览留的注入口：真实路径永远走 stats.js。
 */
function renderToday(db, companies, opts = {}) {
  if (!companies.length) return ["没有可查看的公司。"];
  const dateKey = opts.dateKey || todayKey();
  const computeDashboard = opts.computeDashboard || require("../services/stats").computeDashboard;
  const header = `📊 今日业绩 · ${dateKey}`;

  const stats = [];
  const failed = [];
  for (const company of companies) {
    try {
      stats.push({ company, data: computeDashboard(db, dateKey, company.id) });
    } catch (e) {
      failed.push(`【${companyName(company)}】查询失败：${e.message}`);
    }
  }

  if (companies.length === 1) {
    if (!stats.length) return [header, ...failed];
    const { lines } = renderTable(todayRows(stats[0].data), TODAY_COLUMNS);
    return [header, pre(lines), ...failed];
  }

  // 多公司：一行一家。净额单独累加 winLoss.total，而不是用 充值 - 提现：两者算法不同
  // （winLoss 走 lib/winLoss.js 的口径），混用会让合计和各公司加起来对不上。
  let depTotal = 0;
  let wdTotal = 0;
  let netTotal = 0;
  const rows = [{ company: "公司", dep: "充值", wd: "提现", net: "净额" }];
  for (const { company, data } of stats) {
    const dep = money(data.deposits?.total);
    const wd = money(data.withdrawals?.total);
    const net = money(data.winLoss?.total);
    depTotal += dep;
    wdTotal += wd;
    netTotal += net;
    rows.push({
      company: companyName(company),
      dep: formatAmount(dep),
      wd: formatAmount(wd),
      net: formatAmount(net),
    });
  }
  rows.push(
    { divider: true },
    {
      company: "合计",
      dep: formatAmount(depTotal),
      wd: formatAmount(wdTotal),
      net: formatAmount(netTotal),
    }
  );
  const { lines } = renderTable(
    rows,
    [
      { key: "company", align: "left", min: 6, max: 12 },
      { key: "dep", align: "right" },
      { key: "wd", align: "right" },
      { key: "net", align: "right" },
    ],
    { maxWidth: WIDE_TABLE_WIDTH, gap: 1 }
  );

  return [header, ...splitSection("", lines), ...failed, `单家明细：/today ${companies[0].id}`];
}

// splitSection / MAX_BLOCK_CHARS / WIDE_TABLE_WIDTH 导出给 lib/bankCleanupReport.js 复用：
// 前者守着「每个块自带成对闭合的 <pre> 且不超长」这条铁律，后两个是数字——复制一份
// 出去早晚会漂移。
module.exports = { renderBalance, renderToday, splitSection, MAX_BLOCK_CHARS, WIDE_TABLE_WIDTH };
