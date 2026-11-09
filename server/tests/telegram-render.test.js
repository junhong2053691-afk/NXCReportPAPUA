const test = require("node:test");
const assert = require("node:assert/strict");

const { bankDatabase, addAccount, addLedger } = require("./bank-fixture");
const { renderBalance, renderToday } = require("../lib/telegramRender");
const { computeBankDailyReport, refreshBankBalance } = require("../lib/bankReport");
const { chunkMessage } = require("../services/telegram");
const { TABLE_MAX_WIDTH, displayWidth, stripHtml } = require("../lib/telegramFormat");
const { todayKey, shiftDateKey } = require("../lib/dates");

const TODAY = todayKey();
const YESTERDAY = shiftDateKey(TODAY, -1);

const ALPHA = { id: "alpha", name: "AussieX6" };
const BETA = { id: "beta", name: "Rolex66" };

function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 块用 \n\n 连起来——chunkMessage 就是这么装箱的。 */
function raw(blocks) {
  return blocks.join("\n\n");
}

/** Telegram 实际渲染出来的样子：去掉标签、反转义。断言文案一律看这个。 */
function shown(blocks) {
  return stripHtml(raw(blocks));
}

function seedCompany(db, companyId) {
  const normal = addAccount(db, { company_id: companyId, bank_branch: "CBA Sydney", sort_order: 1 });
  const daily = addAccount(db, {
    company_id: companyId,
    bank_branch: "ANZ Melbourne",
    reset_daily_balance: 1,
    sort_order: 2,
  });
  const inactive = addAccount(db, { company_id: companyId, bank_branch: "NAB Perth", active: 0, sort_order: 3 });
  // 幽灵户。在钱的口径上与人头完全同等（isCountedInTotals），加它只为验证粒数总结
  // 把两类分开数：少了它，「人头 N 粒」把 ghost 混进去也看不出来。
  const ghost = addAccount(db, {
    company_id: companyId,
    bank_branch: "Ubank Ghost",
    account_kind: "ghost",
    sort_order: 4,
  });
  const gateway = addAccount(db, {
    company_id: companyId,
    bank_branch: "FastPay",
    account_kind: "payment_gateway",
    sort_order: 5,
  });
  const banned = addAccount(db, {
    company_id: companyId,
    bank_branch: "Westpac Old",
    lifecycle_status: "banned",
    sort_order: 6,
  });
  // 已归档账户。刻意给它一笔余额：归档闸门在现实中保证余额为 0，但这里要验证的是
  // 「即使有余额，归档账户也既不出现在消息里、也不进合计」——漏过滤时两条断言同时红。
  const archived = addAccount(db, {
    company_id: companyId,
    bank_branch: "Bendigo Retired",
    lifecycle_status: "archived",
    active: 0,
    sort_order: 7,
  });

  addLedger(db, normal, 1500, YESTERDAY);
  addLedger(db, normal, 500, TODAY);
  addLedger(db, daily, 4000, YESTERDAY);
  addLedger(db, daily, 300.25, TODAY);
  addLedger(db, inactive, 777, TODAY);
  // 2500 刻意避开其余断言靠的子串（456 归档、123 封禁、4,300.25 累计）。
  addLedger(db, ghost, 2500, TODAY);
  addLedger(db, gateway, 9999, TODAY);
  addLedger(db, banned, 123, TODAY);
  addLedger(db, archived, 456, TODAY);
  for (const id of [normal, daily, inactive, ghost, gateway, banned, archived]) {
    refreshBankBalance(db, id, { alert: false });
  }
  return { normal, daily, inactive, ghost, gateway, banned, archived };
}

test("/balance 的合计与页面 KPI total_balance 完全一致", () => {
  const db = bankDatabase();
  seedCompany(db, "alpha");

  const report = computeBankDailyReport(db, "alpha", { date: TODAY });
  const text = shown(renderBalance(db, [ALPHA], { dateKey: TODAY }));

  const expected = report.totals.total_balance.toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  assert.match(
    text,
    new RegExp("合计\\s+" + esc(expected)),
    "Telegram 合计必须等于页面 KPI，否则报警不可信\n" + text
  );
  db.close();
});

test("/balance 只给在跑着的账户：运营中 + PG 两组，封禁整组不出现", () => {
  const db = bankDatabase();
  seedCompany(db, "alpha");
  const text = shown(renderBalance(db, [ALPHA], { dateKey: TODAY }));

  assert.match(text, /^运营中$/m);
  assert.match(text, /^PaymentGateway（不计入合计）$/m);
  // 封禁整组已经移到 /blocked——它回答的是另一个问题（封了多久、哪些能归档）。
  assert.ok(!text.includes("封禁中"), "封禁组不该再出现在 /balance 里\n" + text);
  assert.ok(!text.includes("Westpac Old"), "封禁账户不该出现在任何一组里\n" + text);
  assert.ok(!text.includes("123.00"), "封禁户的钱不该出现在 /balance 里\n" + text);

  const operating = text.slice(text.indexOf("运营中"), text.indexOf("PaymentGateway"));
  assert.ok(operating.includes("NAB Perth"), "遗留 active = 0 的运营中账户照样出现在运营中组");
  assert.ok(operating.includes("Ubank Ghost"), "幽灵户在钱的口径上与人头同等，照样在运营中组");
  db.close();
});

test("/balance 明细模式底部给粒数总结，人头与幽灵分开数、封禁不算", () => {
  const db = bankDatabase();
  seedCompany(db, "alpha");
  const text = shown(renderBalance(db, [ALPHA], { dateKey: TODAY }));

  // 3 而不是 4：fixture 里封禁那户也是 nominee，粒数的范围必须和上面那张表一致，
  // 否则读者会去找第 4 粒在哪一行。
  assert.match(text, /人头 3 粒/, "运营中的 nominee 是 normal/daily/inactive 三个\n" + text);
  assert.match(text, /幽灵 1 粒/);
  assert.match(text, /PG 1 粒/);
  db.close();
});

test("/balance 只在真有封禁时提一句 /blocked，且不带数字与金额", () => {
  const db = bankDatabase();
  seedCompany(db, "alpha");
  const withBanned = shown(renderBalance(db, [ALPHA], { dateKey: TODAY }));
  assert.match(withBanned, /封禁渠道详情：\/blocked/);
  // 指路就只是指路：数字留给 /blocked，否则 /balance 又开始回答封禁的问题了。
  assert.ok(
    !/\/blocked[^\n]*\d/.test(withBanned),
    "指路行不该带笔数或金额\n" + withBanned
  );

  const clean = bankDatabase();
  addAccount(clean, { company_id: "alpha", bank_branch: "CBA Sydney" });
  const noBanned = shown(renderBalance(clean, [ALPHA], { dateKey: TODAY }));
  assert.ok(!noBanned.includes("/blocked"), "一个封禁户都没有时不该提\n" + noBanned);
  db.close();
  clean.close();
});

test("已归档账户不出现在 /balance 的任何一组里", () => {
  const db = bankDatabase();
  seedCompany(db, "alpha");
  const text = shown(renderBalance(db, [ALPHA], { dateKey: TODAY }));

  assert.ok(!text.includes("Bendigo Retired"), "归档账户已退役，不该再占版面\n" + text);
  assert.ok(!text.includes("456"), "归档账户的余额不该出现在消息里\n" + text);
  db.close();
});

test("/balance 标注当日口径，并给超标账户打标记；「使用中」已取消，不再标「停」", () => {
  const db = bankDatabase();
  const ids = seedCompany(db, "alpha");
  db.prepare("UPDATE bank_accounts SET alert_threshold = 100 WHERE id = ?").run(ids.normal);

  const text = shown(renderBalance(db, [ALPHA], { dateKey: TODAY }));
  assert.match(text, /ANZ Melbourne·\d{4} 日/, "每日归零账户应标注当日口径");
  assert.ok(!/NAB Perth·\d{4} 停/.test(text), "遗留 active = 0 不再标注\n" + text);
  assert.ok(!text.includes("停="), "图例里也不该再有「停」\n" + text);
  assert.match(text, /⚠️/, "超标账户应有标记");
  // 标记是单字，含义必须在同一条消息里说明，否则没人看得懂。
  assert.match(text, /日=当日净额/);

  // 当日口径账户显示的是当日净额 300.25，而不是累计 4300.25。
  assert.match(text, /300\.25/);
  assert.ok(!text.includes("4,300.25"), "每日归零账户不应显示累计余额");
  db.close();
});

test("/balance 明细模式多公司分节，各公司小计相加等于合计", () => {
  const db = bankDatabase();
  seedCompany(db, "alpha");
  seedCompany(db, "beta");

  const text = shown(renderBalance(db, [ALPHA, BETA], { dateKey: TODAY, detail: true }));
  assert.match(text, /【AussieX6】/);
  assert.match(text, /【Rolex66】/);

  const subtotals = [...text.matchAll(/小计\s+([\d,]+\.\d{2})/g)].map((m) => Number(m[1].replace(/,/g, "")));
  assert.equal(subtotals.length, 2);
  const grand = Number(/合计\s+([\d,]+\.\d{2})/.exec(text)[1].replace(/,/g, ""));
  assert.equal(
    Math.round(grand * 100),
    Math.round((subtotals[0] + subtotals[1]) * 100),
    "合计应等于各公司小计之和"
  );
  db.close();
});

test("/balance 多公司默认只给概要：不展开账户，给出取明细的办法", () => {
  const db = bankDatabase();
  seedCompany(db, "alpha");
  seedCompany(db, "beta");

  const text = shown(renderBalance(db, [ALPHA, BETA], { dateKey: TODAY }));
  assert.ok(!text.includes("CBA Sydney"), "概要模式不该出现单个账户——上百行是这次重排的起因");
  assert.match(text, /AussieX6\s+3人\/1幽\s+[\d,]+\.\d{2}/, "每家公司一行小计 + 一列粒数");
  assert.match(text, /Rolex66\s+3人\/1幽\s+[\d,]+\.\d{2}/);
  // 合计行刻意不填粒数：这一行回答的是钱。空格由 renderTable 补白，\s+ 照样吃掉。
  assert.match(text, /合计\s+[\d,]+\.\d{2}/);
  assert.match(text, /明细：\/balance alpha/, "概要必须给出看明细的办法");

  // 概要与明细的合计必须是同一个数。
  const summary = /合计\s+([\d,]+\.\d{2})/.exec(text)[1];
  const detail = shown(renderBalance(db, [ALPHA, BETA], { dateKey: TODAY, detail: true }));
  assert.equal(summary, /合计\s+([\d,]+\.\d{2})/.exec(detail)[1]);
  db.close();
});

test("/balance 概要模式列出超标账户，一个都没有时明确说没有", () => {
  const db = bankDatabase();
  const ids = seedCompany(db, "alpha");
  seedCompany(db, "beta");

  const clean = shown(renderBalance(db, [ALPHA, BETA], { dateKey: TODAY }));
  assert.match(clean, /✅ 无账户超过阈值/, "留空是歧义——必须说清楚");

  db.prepare("UPDATE bank_accounts SET alert_threshold = 100 WHERE id = ?").run(ids.normal);
  const alerted = shown(renderBalance(db, [ALPHA, BETA], { dateKey: TODAY }));
  assert.match(alerted, /⚠️ 超标 1 个账户/);
  assert.match(alerted, /AussieX6\s+CBA Sydney·\d{4}\s+[\d,]+\.\d{2}/, "超标的那个账户要点名");
  db.close();
});

test("/balance 概要模式里封禁账户不参与超标提醒，PG 参与", () => {
  const db = bankDatabase();
  const ids = seedCompany(db, "alpha");
  seedCompany(db, "beta");
  db.prepare("UPDATE bank_accounts SET alert_threshold = 1 WHERE id IN (?, ?)").run(
    ids.banned,
    ids.gateway
  );

  const text = shown(renderBalance(db, [ALPHA, BETA], { dateKey: TODAY }));
  const list = text.slice(text.indexOf("超标"));
  assert.ok(!list.includes("Westpac Old"), "封禁账户本来就不报警（bankAlerts.js:122-125）");
  assert.ok(list.includes("FastPay"), "PG 不计入合计，但钱躺在里面照样要提醒");
  db.close();
});

test("/balance 概要加了粒数列之后，每行仍不超 TABLE_MAX_WIDTH", () => {
  const db = bankDatabase();
  // 最坏输入：四字中文公司名 + 七位数金额。超宽时 renderTable 只压缩 left 列，粒数列
  // 右对齐所以不会被截成「3人/…」——这条断言是「加列」唯一的硬保护。
  seedCompany(db, "alpha");
  const rich = seedCompany(db, "beta");
  addLedger(db, rich.normal, 1234567.89, TODAY);
  refreshBankBalance(db, rich.normal, { alert: false });

  const blocks = renderBalance(db, [ALPHA, { id: "beta", name: "新公司名字" }], {
    dateKey: TODAY,
  });
  // 只检 <pre> 里面的行：脚注与标题在 <pre> 外面，由 Telegram 自己折行。
  for (const block of blocks) {
    for (const m of block.matchAll(/<pre>([\s\S]*?)<\/pre>/g)) {
      for (const line of stripHtml(m[1]).split("\n")) {
        assert.ok(
          displayWidth(line) <= TABLE_MAX_WIDTH,
          `概要表第 ${displayWidth(line)} 格超宽，手机上会横向滚动：\n${line}`
        );
      }
    }
  }
  db.close();
});

test("只剩封禁户的公司：明细说「无运营中渠道」，概要说「全封禁」", () => {
  const db = bankDatabase();
  seedCompany(db, "alpha");
  // beta 只有一个封禁户。「无渠道」是错的——这家有渠道，只是全封了。
  const onlyBanned = addAccount(db, {
    company_id: "beta",
    bank_branch: "HSBC Gone",
    lifecycle_status: "banned",
    active: 0,
  });
  addLedger(db, onlyBanned, 88, TODAY);
  refreshBankBalance(db, onlyBanned, { alert: false });

  const detail = shown(renderBalance(db, [ALPHA, BETA], { dateKey: TODAY, detail: true }));
  assert.match(detail, /（无运营中渠道）/);
  assert.ok(!detail.includes("（无支付渠道）"), "有渠道，只是全封了\n" + detail);

  const summary = shown(renderBalance(db, [ALPHA, BETA], { dateKey: TODAY }));
  assert.match(summary, /Rolex66\s+（全封禁）/);
  assert.ok(!summary.includes("（无渠道）"), "（无渠道）留给真的零渠道\n" + summary);
  db.close();
});

test("/balance 对没有渠道的公司给出明确提示而不是空白", () => {
  const db = bankDatabase();
  const blocks = renderBalance(db, [ALPHA], { dateKey: TODAY });
  const text = shown(blocks);
  assert.match(text, /【AussieX6】/);
  assert.match(text, /（无支付渠道）/);
  assert.ok(!/合计\s+0\.00/.test(text), "一个渠道都没有时不该挂一行 0.00 的合计");
  db.close();
});

test("/balance 没有可见公司时不返回空消息", () => {
  const db = bankDatabase();
  const blocks = renderBalance(db, [], { dateKey: TODAY });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /没有可查看的公司/);
  db.close();
});

// ------------------------------------------------------------------ HTML 安全

/** 每条消息里的 <pre> 必须成对。这是 HTML parse_mode 下最致命的失败：Telegram 返回 400，
 *  整条消息发不出去，报警就此丢掉。 */
function assertPreBalanced(parts) {
  for (const part of parts) {
    const open = (part.match(/<pre>/g) || []).length;
    const close = (part.match(/<\/pre>/g) || []).length;
    assert.equal(close, open, "<pre> 被切开了，Telegram 会 400：\n" + part);
  }
}

test("/balance 的块能被 chunkMessage 安全切分：切点落在公司之间，<pre> 不被切开", () => {
  const db = bankDatabase();
  const companies = [];
  for (let i = 0; i < 6; i++) {
    const id = "co" + i;
    seedCompany(db, id);
    companies.push({ id, name: "公司" + i });
  }
  const blocks = renderBalance(db, companies, { dateKey: TODAY, detail: true });
  const parts = chunkMessage(blocks, 600);
  assert.ok(parts.length > 1, "内容够长时应切成多条");
  for (const part of parts) assert.ok(part.length <= 600, "每条都不应超过上限");
  assertPreBalanced(parts);

  // 每个公司的标题行都完整出现，没有被切成半截。
  const joined = parts.join("\n");
  for (const c of companies) assert.ok(joined.includes(`【${c.name}】`), `丢了公司节：${c.name}`);
  db.close();
});

test("账户多到一个块装不下时，拆成多个自闭合的块而不是一个超长块", () => {
  const db = bankDatabase();
  for (let i = 0; i < 150; i++) {
    const id = addAccount(db, {
      company_id: "alpha",
      bank_branch: "Bank No " + i,
      account_number: String(100000000 + i),
      sort_order: i,
    });
    addLedger(db, id, 100 + i, TODAY);
    refreshBankBalance(db, id, { alert: false });
  }

  const blocks = renderBalance(db, [ALPHA], { dateKey: TODAY });
  const company = blocks.filter((b) => b.includes("【AussieX6】") || b.includes("（续）"));
  assert.ok(company.length > 1, "一家公司的账户列表超长时必须拆块");
  assert.ok(company.some((b) => b.includes("（续）")), "续块要标出来，不然读者以为是另一家");
  for (const block of blocks) {
    assert.equal((block.match(/<pre>/g) || []).length, (block.match(/<\/pre>/g) || []).length);
  }
  assertPreBalanced(chunkMessage(blocks));
  db.close();
});

test("银行名里的 & < > 被转义，不会被当成标签", () => {
  const db = bankDatabase();
  const id = addAccount(db, { company_id: "alpha", bank_branch: "A & B <Bank>", sort_order: 1 });
  addLedger(db, id, 500, TODAY);
  refreshBankBalance(db, id, { alert: false });

  const blocks = renderBalance(db, [ALPHA], { dateKey: TODAY });
  const text = raw(blocks);
  assert.match(text, /A &amp; B &lt;Bank&gt;/, "必须转义，否则 Telegram 报 unsupported start tag");
  assert.ok(!text.includes("<Bank>"), "裸标签会被当成 HTML");
  // 转义只是传输形态，读者看到的仍然是原文。
  assert.match(shown(blocks), /A & B <Bank>/);
  db.close();
});

test("有尾号用尾号认人，没尾号才补户名——同行没有两个账户长得一样", () => {
  const db = bankDatabase();
  // 真实数据里 bank_branch 常常只是 "NAB"，卡号可能为空：这时只能靠户名区分。
  const withTail = addAccount(db, {
    company_id: "alpha",
    bank_branch: "NAB",
    account_name: "BRIDGET ISABELLA DUNHAM",
    account_number: "501207122",
    sort_order: 1,
  });
  const noTailA = addAccount(db, {
    company_id: "alpha",
    bank_branch: "NAB",
    account_name: "Leonard Chen",
    account_number: "",
    sort_order: 2,
  });
  const noTailB = addAccount(db, {
    company_id: "alpha",
    bank_branch: "NAB",
    account_name: "Adam Degnan",
    account_number: "",
    sort_order: 3,
  });
  for (const [id, amt] of [[withTail, 111], [noTailA, 222], [noTailB, 333]]) {
    addLedger(db, id, amt, TODAY);
    refreshBankBalance(db, id, { alert: false });
  }

  const text = shown(renderBalance(db, [ALPHA], { dateKey: TODAY }));
  assert.match(text, /NAB·7122\s+111\.00/, "有尾号时用尾号，不必再塞户名把行挤爆");
  assert.match(text, /NAB Leonard Chen\s+222\.00/, "没尾号必须补户名");
  assert.match(text, /NAB Adam Degnan\s+333\.00/);
  db.close();
});

test("中英文账户名混排时金额仍然对齐（中文按两格算宽）", () => {
  const db = bankDatabase();
  const defs = [
    { bank_branch: "招商银行深圳分行", n: 1 },
    { bank_branch: "CBA", n: 2 },
    { bank_branch: "汇丰 HSBC 香港", n: 3 },
  ];
  for (const d of defs) {
    const id = addAccount(db, { company_id: "alpha", bank_branch: d.bank_branch, sort_order: d.n });
    addLedger(db, id, d.n * 1111.11, TODAY);
    refreshBankBalance(db, id, { alert: false });
  }

  const text = shown(renderBalance(db, [ALPHA], { dateKey: TODAY }));
  const rows = text.split("\n").filter((l) => /·\d{4}\s+[\d,]+\.\d{2}$/.test(l));
  assert.equal(rows.length, 3, "三行账户都要在\n" + text);
  const widths = new Set(rows.map((l) => displayWidth(l)));
  assert.equal(widths.size, 1, "各行显示宽度必须相同，金额才会成列：\n" + rows.join("\n"));
  db.close();
});

// ------------------------------------------------------------------ /today

// 注入假 computeDashboard：真实的那个要一整套 transactions / customers 表，
// 而这里要验的是排版与合计口径。
const DASH = {
  alpha: {
    deposits: { total: 123456.78, count: 231 },
    withdrawals: { total: 45000, count: 17 },
    winLoss: { total: 78456.78 },
    depositUsersToday: 182,
    customers: { newToday: 41 },
  },
  beta: {
    deposits: { total: 9876.5, count: 12 },
    withdrawals: { total: 12000, count: 3 },
    winLoss: { total: -2123.5 },
    depositUsersToday: 9,
    customers: { newToday: 1 },
  },
};
const fakeDashboard = (_db, _date, id) => {
  if (!DASH[id]) throw new Error("no dashboard for " + id);
  return DASH[id];
};

test("/today 单公司给全字段，金额与笔数分列", () => {
  const blocks = renderToday(null, [ALPHA], { dateKey: TODAY, computeDashboard: fakeDashboard });
  const text = shown(blocks);
  assert.match(text, /充值\s+123,456\.78\s+231 笔/);
  assert.match(text, /提现\s+45,000\.00\s+17 笔/);
  assert.match(text, /净额\s+78,456\.78/);
  assert.match(text, /充值人数\s+182/);
  assert.match(text, /新注册\s+41/);
  assertPreBalanced(chunkMessage(blocks));
});

test("/today 多公司一行一家，合计的净额走 winLoss 而不是 充值 - 提现", () => {
  const blocks = renderToday(null, [ALPHA, BETA], { dateKey: TODAY, computeDashboard: fakeDashboard });
  const text = shown(blocks);
  const total = /合计\s+([\d,.-]+)\s+([\d,.-]+)\s+([\d,.-]+)/.exec(text);
  assert.ok(total, "多公司必须有合计行\n" + text);
  const num = (s) => Number(s.replace(/,/g, ""));
  assert.equal(num(total[1]), 123456.78 + 9876.5);
  assert.equal(num(total[2]), 45000 + 12000);
  assert.equal(
    num(total[3]),
    78456.78 - 2123.5,
    "净额是各公司 winLoss.total 相加，不是 充值 - 提现（口径不同）"
  );
  assert.match(text, /单家明细：\/today alpha/);
  assertPreBalanced(chunkMessage(blocks));
});

test("/today 某公司查询失败不拖垮其他公司", () => {
  const blocks = renderToday(null, [ALPHA, { id: "zzz", name: "Broken" }], {
    dateKey: TODAY,
    computeDashboard: fakeDashboard,
  });
  const text = shown(blocks);
  assert.match(text, /AussieX6/);
  assert.match(text, /【Broken】查询失败/);
});

test("/today 没有可见公司时不返回空消息", () => {
  const blocks = renderToday(null, [], { dateKey: TODAY, computeDashboard: fakeDashboard });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /没有可查看的公司/);
});
