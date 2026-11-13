// 2026-11 拆页：/bank-accounts.html 拆成「流水记录」分组下的当日流水（/bank-ledger.html，
// 含常驻接单区）与支付渠道（/bank-channels.html）。2026-11-10 当日流水改名「交易」，流水表
// 再拆出去成「交易记录」（/bank-transactions.html）。这里按源码守住几条拆页时定下的约束。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "..", ...p), "utf8");
const index = read("server", "index.js");
const app = read("public", "js", "app.js");
const ledger = read("public", "js", "bank-ledger.js");
const channels = read("public", "js", "bank-channels.js");

test("operator 只能进交易 / 支付渠道 / 交易记录，服务端与前端是同一份名单", () => {
  assert.match(index, /const OPERATOR_PAGES = new Set\(\["\/bank-ledger\.html", "\/bank-channels\.html", "\/bank-transactions\.html"\]\)/);
  assert.match(index, /role === "operator" && !OPERATOR_PAGES\.has\(req\.path\)/);
  assert.match(app, /const operatorPages = new Set\(\["bank-ledger", "bank-channels", "bank-transactions"\]\)/);
  // 支付设置仍然只给 admin
  assert.match(index, /const ADMIN_ONLY_PAGES = new Set\(\[[\s\S]*?"\/bank-settings\.html"/);
  // operator 下所有分组整组藏掉，唯独流水记录分组留着
  assert.match(app, /group\.id !== "nav-bank-group"/);
});

test("旧地址 302 到当日流水，带上查询串；#channels 再转去支付渠道", () => {
  assert.match(index, /app\.get\("\/bank-accounts\.html", \(req, res\) => \{[\s\S]{0,200}res\.redirect\(302, "\/bank-ledger\.html"/);
  assert.doesNotMatch(index, /"\/bank-accounts\.html": pageLayout\(/, "旧页面不能还在 pageRoutes 里");
  assert.match(ledger, /location\.hash === "#channels"[\s\S]{0,80}location\.replace\("\/bank-channels\.html"\)/);
});

test("流水记录分组在总览正下方：交易 → 支付渠道 → 交易记录 → 支付设置", () => {
  const nav = index.indexOf('<nav class="nav-stack"');
  const home = index.indexOf("${homeLink}", nav);
  const group = index.indexOf("${bankGroup}", nav);
  const rest = index.indexOf("${primaryLinks}", nav);
  assert.ok(nav > 0 && home > nav && group > home && rest > group, "顺序应为 总览 / 流水记录 / 其余");
  const bankNav = index.slice(index.indexOf("const bankNav = ["), index.indexOf("];", index.indexOf("const bankNav = [")));
  const order = ["/bank-ledger.html", "/bank-channels.html", "/bank-transactions.html", "/bank-settings.html"].map((u) => bankNav.indexOf(u));
  assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2] && order[2] < order[3]);
  // 页名改成「交易」，地址不变
  assert.match(bankNav, /\["bank-ledger", "\/bank-ledger\.html", "\\u4ea4\\u6613", "list"\]/);
  assert.match(bankNav, /\["bank-transactions", "\/bank-transactions\.html", "\\u4ea4\\u6613\\u8bb0\\u5f55", "receipt-text"\]/);
  // 标题是链接、箭头是独立按钮——不能套 <details>，summary 里的链接会顺带切换展开
  assert.match(index, /<a href="\/bank-ledger\.html" class="nav-group-title/);
  assert.match(index, /<button type="button" class="nav-group-toggle"/);
  // 设置组里不再重复出现支付设置
  const settingsNav = index.slice(index.indexOf("const settingsNav = ["), index.indexOf("];", index.indexOf("const settingsNav = [")));
  assert.doesNotMatch(settingsNav, /bank-settings/);
});

test("接单区：员工动过的行后台刷新绝不重画，别人处理掉只标灰", () => {
  assert.match(ledger, /function bindPendingTxRow\(tr\) \{[\s\S]{0,400}tr\.dataset\.dirty = "1"/);
  const sync = ledger.slice(ledger.indexOf("function syncPendingTx("), ledger.indexOf("let pendingLoadRequest"));
  assert.match(sync, /row\.dataset\.dirty === "1"[\s\S]{0,60}markPendingRowGone\(row\)/);
  assert.doesNotMatch(sync, /txBody\.innerHTML\s*=/, "增量刷新不能整表重画");
  // 自己审批 / 跳过成功的那一行先拿掉，否则会被当成「已被他人处理」
  assert.match(ledger, /pend-approve[\s\S]*?\.then\(\(\) => \{\s*tr\.remove\(\);/);
});

test("接单区常驻页面：后台刷新不能顺手 ack 平台待审批报警", () => {
  const load = ledger.slice(ledger.indexOf("function loadPendingPanels("), ledger.indexOf("function addPendingSplitRow("));
  const switches = load.match(/switchPendingTab\([^)]*\)/g) || [];
  assert.ok(switches.length >= 2);
  for (const call of switches) assert.match(call, /\{ silent: true \}/, `${call} 要带 silent`);
  assert.match(ledger, /!opts\?\.silent && tab === "tx"[\s\S]{0,80}acknowledgePlatformPendingSound/);
});

test("换公司时接单区清空，不把上一家的行留成「已被他人处理」", () => {
  assert.match(ledger, /bindCompanySwitch\(\(\) => \{\s*resetIntake\(\);/);
});

test("封禁中按月查看：接口带最近一次封禁时间，当月口径含已归档、按悉尼日期分月", () => {
  const routes = read("server", "routes", "banks.js");
  const list = routes.slice(routes.indexOf('router.get("/", (req, res) => {'), routes.indexOf('router.get("/summary"'));
  assert.match(list, /MAX\(created_at\) AS at FROM bank_account_events[\s\S]{0,80}event = 'banned'/);
  assert.match(list, /company_id = \?/, "封禁事件也要按公司隔离");
  assert.match(list, /banned_at:/);
  assert.match(channels, /function bannedInMonth\(b\) \{\s*return \(LC\.isBanned\(b\) \|\| LC\.isArchived\(b\)\) && bannedMonth\(b\) === bkdMonth;/);
  // banned_at 是 UTC，分月必须先换成悉尼日期（UTC 的 1 号凌晨在悉尼还是上个月最后一天之后的上午）
  assert.match(channels, /sqlUtcToSydney\(b\.banned_at, \{ dateOnly: true \}\)\)\.slice\(0, 7\)/);
  // 合计卡住的钱用无上界的账本余额（与归档闸门同口径），不是页面的当日口径
  assert.match(channels, /reduce\(\(s, b\) => s \+ bankLedgerBalance\(b\), 0\)/);
});

test("支付渠道汇总：人头 / 幽灵按运营中的渠道数，不再显示运营中总数", () => {
  assert.match(index, /id="ch-count-nominee"/);
  assert.match(index, /id="ch-count-ghost"/);
  assert.doesNotMatch(index, /id="ch-total-count"/);
  assert.match(channels, /usableBanks\(\)\.forEach\(\(b\) => \{\s*const kind = String\(b\.account_kind \|\| "nominee"\);/);
});

test("支付渠道页 / 交易页点渠道行去交易记录并带 ?bank=；交易记录从地址栏读回筛选", () => {
  assert.match(channels, /location\.href = `\/bank-transactions\.html\?bank=\$\{encodeURIComponent\(bankId\)\}`/);
  assert.match(ledger, /location\.href = `\$\{RECORDS_URL\}\?bank=\$\{encodeURIComponent\(id\)\}`/);
  assert.match(ledger, /const RECORDS_URL = "\/bank-transactions\.html"/);
  assert.match(ledger, /new URLSearchParams\(location\.search\)\.get\("bank"\)/);
  assert.match(ledger, /url\.searchParams\.set\("bank"/);
  // 只有交易记录页认 ?bank=，交易页的 KPI 永远是全部渠道
  assert.match(ledger, /activeBankId = IS_RECORDS \? bankFromUrl\(\) : ALL_BANKS/);
  // 对平告警 / C STATUS 面板点名字：交易页没有流水表，带 ?q= 去交易记录
  assert.match(ledger, /location\.href = `\$\{RECORDS_URL\}\?q=\$\{encodeURIComponent\(name\)\}`/);
  // 拆页后渠道页不再碰流水表
  assert.doesNotMatch(channels, /loadSheet|activeBankId/);
});

function pageSlice(route, nextRoute) {
  return index.slice(index.indexOf(`"${route}": pageLayout(`), index.indexOf(`"${nextRoute}": pageLayout(`));
}

test("交易页顺序：工具栏 → 顶部（渠道列表 | 今日报表）→ 对平告警 → 接单区；没有流水表、没有 KPI 卡片", () => {
  const page = pageSlice("/bank-ledger.html", "/bank-transactions.html");
  assert.match(page, /<h1>交易<\/h1>/);
  assert.match(page, /class="sheet-app bkv2" data-view="workspace"/);
  // 四个 KPI 卡片 2026-11-10 删掉（IN / OUT / HELP TRF 与交易记录的 TOTAL 行重复），
  // 总余额照 Excel 挪到渠道列表底部的 TOTAL BALANCE。
  assert.doesNotMatch(page, /bk-kpis|id="sum-(balance|in|out|help)"/);
  assert.match(ledger, /<div class="bk-banklist-total"[^`]*<span>TOTAL BALANCE<\/span><strong translate="no">\$\{fmt\(totalBalance\(\)\)\}<\/strong><\/div>/);
  assert.match(ledger, /function totalBalance\(\) \{\s*return BC\.totalBalance\(bankRows, dailyReport\);/);
  const order = ['class="bk-toolbar"', 'class="bk-top"', 'id="bk-banklist"', 'id="sheet-upper-wrap"', 'id="reconcile-alert"', 'id="bk-intake"']
    .map((k) => page.indexOf(k));
  order.forEach((pos, i) => assert.ok(pos > 0 && (i === 0 || pos > order[i - 1]), `第 ${i + 1} 块位置不对`));
  assert.doesNotMatch(page, /id="sheet-grid"|id="sheet-bank-filter"|id="deleted-ledger-modal"/, "流水表、渠道筛选、最近删除都在交易记录页");
  assert.doesNotMatch(page, /bk-context-strip|bk-current-company|bk-current-sync/, "当前公司 / 流水日期 / 同步状态那一行已移除");
  assert.doesNotMatch(ledger, /refreshWorkspaceContext|updateWorkspaceSyncContext/);
});

test("交易记录页：独立的流水表 + 筛选 + 最近删除，OPERATOR 列，与交易页共用脚本", () => {
  const page = pageSlice("/bank-transactions.html", "/bank-channels.html");
  assert.match(page, /<h1>交易记录<\/h1>/);
  assert.match(page, /class="sheet-app bkv2" data-view="records"/);
  for (const id of ["sheet-grid", "sheet-bank-filter", "sheet-status-filter", "sheet-search", "sheet-deleted-btn", "deleted-ledger-modal", "reason-modal", "cstatus-drawer"]) {
    assert.match(page, new RegExp(`id="${id}"`), `缺 #${id}`);
  }
  assert.match(page, /<th class="col-remark">REMARK<\/th><th class="col-operator">OPERATOR<\/th><th class="col-act"><\/th>/);
  assert.doesNotMatch(page, /id="bk-intake"|id="bk-banklist"/);
  assert.equal((index.match(/^    BANK_LEDGER_SCRIPTS$/gm) || []).length, 2, "两页共用同一份脚本列表，版本号一起换");
  // 交易记录页不跑接单区轮询（app.js 在每页都管角标与报警声）
  assert.match(ledger, /function refreshPendingBadge\(\) \{[\s\S]{0,200}if \(IS_RECORDS\) return Promise\.resolve\(\);/);
  // OPERATOR 是纯展示格：没有 data-f，readRow 读不到它
  const opCell = ledger.slice(ledger.indexOf("function operatorCellHtml("), ledger.indexOf("function buildGridRow("));
  assert.ok(opCell.length > 0);
  assert.doesNotMatch(opCell, /data-f=/);
  assert.match(ledger, /colspan="15" class="sheet-empty"/);
});

test("手机底栏「流水」直达交易记录页并高亮", () => {
  assert.match(index, /<a href="\/bank-transactions\.html" data-tab-action="ledger">/);
  assert.match(app, /const MOBILE_TAB_CURRENT = \{ "\/bank-transactions\.html": "ledger", "\/bank-channels\.html": "channels" \}/);
});

test("当日流水的银行列表一直展开：没有折叠按钮、没有折叠状态，旧的 localStorage 值清掉", () => {
  assert.doesNotMatch(ledger, /bk-banklist-toggle|BANKLIST_COLLAPSED_KEY|isBankListCollapsed|setBankListCollapsed/);
  assert.match(ledger, /<div class="bk-banklist-body" id="bk-banklist-body">\$\{body\}<\/div>/);
  assert.match(ledger, /localStorage\.removeItem\("bk-banklist-collapsed"\)/);
});

test("接单区与今日报表不折叠：没有折叠按钮、没有折叠状态", () => {
  assert.doesNotMatch(index, /bk-intake-toggle/);
  assert.doesNotMatch(index, /sheet-collapse-btn|bk-report-wrap collapsed/, "今日报表一直展开");
  assert.doesNotMatch(ledger, /applyUpperCollapsed/);
  assert.doesNotMatch(ledger, /setIntakeCollapsed|INTAKE_COLLAPSED_KEY/);
});

test("支付渠道每行详情默认收起：点 ▸ 展开才拉，展开过的按签名复用", () => {
  assert.match(channels, /const bkdExpanded = new Set\(\)/);
  // 两种行模板都带折叠按钮，详情容器没展开就 hidden
  assert.equal((channels.match(/\$\{bkdToggleHtml\(b\)\}/g) || []).length, 2);
  assert.match(channels, /const hidden = bkdExpanded\.has\(b\.id\) \? "" : "hidden "/);
  // 收起的行不打请求
  assert.match(channels, /detailQueue = rows\.filter\(\(b\) => bkdExpanded\.has\(b\.id\)\)/);
  assert.match(channels, /e\.target\.closest\("\.bkd-toggle-btn"\)/);
  // 换公司清掉展开集合
  assert.match(channels, /bindCompanySwitch\(\(\) => \{\s*bkdExpanded\.clear\(\);/);
  // 后台每 5 秒重画，展开着的行不能每次重打请求
  assert.match(channels, /const bkdDetailCache = new Map\(\)/);
  assert.match(channels, /if \(hit && hit\.sig === detailSig\(b\)\) return/);
});

test("实时收款取代使用中：入口只在交易页渠道列表每行最左的勾，旧勾选器与使用中勾都没了", () => {
  assert.doesNotMatch(index, /id="bk-live"/);
  assert.doesNotMatch(ledger, /renderLivePicker|bindLivePicker/);
  assert.match(ledger, /<label class="bk-col-live[^>]*><input type="checkbox" class="bk-live-chk" data-id="\$\{b\.id\}"/);
  assert.match(ledger, /api\("\/api\/banks\/live-receiving", \{ method: "PUT"/);
  assert.doesNotMatch(channels, /bank-active-chk|active: chk\.checked/);
  // 交易记录页的渠道下拉仍是流水筛选
  assert.match(ledger, /getElementById\("sheet-bank-filter"\)\?\.addEventListener\("change", \(e\) => \{\s*selectBankFilter\(e\.target\.value\);/);
});

test("交易页渠道列表收紧：没有银行资料与 Copy info，余额 / 上限用报警阈值画进度条", () => {
  const row = ledger.slice(ledger.indexOf("function limitHtml("), ledger.indexOf("function renderBankList("));
  assert.ok(row.length > 0);
  assert.doesNotMatch(row, /bankInfoHtml|bk-copy-btn|copyBankInfo|bk-col-order/);
  assert.doesNotMatch(ledger, /BC\.copyBankInfo|data-copy-bank-id/);
  assert.match(row, /const threshold = Number\(b\.alert_threshold \|\| 0\)/);
  assert.match(row, /BC\.limitLevel\(balance, threshold\)/);
  // 余额与报警判定同口径（跟随每日归零）
  assert.match(row, /BC\.bankDisplayBalance\(b, dailyReport\)/);
  assert.match(row, /未设上限/);
  // 标签在名字左边（同一格里先 tags 后 text）
  assert.match(row, /<div class="bk-col-channel"><div class="bk-channel-tags">\$\{tags\}<\/div><div class="bk-channel-text">/);
});

test("交易记录流水表最新一条在最上面，序号最新的最大", () => {
  const grid = ledger.slice(ledger.indexOf("function renderGrid("), ledger.indexOf("function renderSheet("));
  assert.ok(grid.length > 0);
  assert.match(grid, /const n = filtered\.length;/);
  assert.match(grid, /filtered\.slice\(\)\.reverse\(\)\.map\(\(r, i\) => buildGridRow\(r, n - i, false\)\)/);
  // 后端仍升序分页：loadSheet 并发拉页再拼，倒序只在渲染时做
  const routes = read("server", "routes", "banks.js");
  const list = routes.slice(routes.indexOf('router.get("/ledger", (req, res) => {'), routes.indexOf('router.get("/ledger/deleted"'));
  assert.match(list, /ORDER BY l\.entry_time ASC, l\.id ASC/);
});

test("Copy info 固定六行：BANK BRANCH / NAME / BSB / ACCOUNT / PAYID / REMARK，没填的留空", () => {
  const common = read("public", "js", "bank-common.js");
  const pick = (name) => {
    const m = common.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`));
    assert.ok(m, `${name} 不在预期位置`);
    return m[0];
  };
  const bankCopyText = new Function(`${pick("bankBranchOf")}\n${pick("bankCopyText")}\nreturn bankCopyText;`)();
  assert.equal(
    bankCopyText({ bank_branch: " CBA Sydney ", account_name: "Amy Lee", bsb: "062-000", account_number: "1234 5678", payid: "amy@pay.id", note: "主收款" }),
    "BANK BRANCH : CBA Sydney\nNAME : Amy Lee\nBSB : 062-000\nACCOUNT : 1234 5678\nPAYID : amy@pay.id\nREMARK : 主收款"
  );
  assert.equal(
    bankCopyText({ bank_branch: "NAB", bsb: "083-111" }),
    "BANK BRANCH : NAB\nNAME :\nBSB : 083-111\nACCOUNT :\nPAYID :\nREMARK :"
  );
  assert.equal(bankCopyText(null).split("\n").length, 6);
});
