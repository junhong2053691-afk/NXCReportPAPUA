// 2026-11 拆页：/bank-accounts.html 拆成「流水记录」分组下的当日流水（/bank-ledger.html，
// 含常驻接单区）与支付渠道（/bank-channels.html）。这里按源码守住几条拆页时定下的约束。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "..", ...p), "utf8");
const index = read("server", "index.js");
const app = read("public", "js", "app.js");
const ledger = read("public", "js", "bank-ledger.js");
const channels = read("public", "js", "bank-channels.js");

test("operator 只能进当日流水与支付渠道，服务端与前端是同一份名单", () => {
  assert.match(index, /const OPERATOR_PAGES = new Set\(\["\/bank-ledger\.html", "\/bank-channels\.html"\]\)/);
  assert.match(index, /role === "operator" && !OPERATOR_PAGES\.has\(req\.path\)/);
  assert.match(app, /const operatorPages = new Set\(\["bank-ledger", "bank-channels"\]\)/);
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

test("流水记录分组在总览正下方：当日流水 → 支付渠道 → 支付设置", () => {
  const nav = index.indexOf('<nav class="nav-stack"');
  const home = index.indexOf("${homeLink}", nav);
  const group = index.indexOf("${bankGroup}", nav);
  const rest = index.indexOf("${primaryLinks}", nav);
  assert.ok(nav > 0 && home > nav && group > home && rest > group, "顺序应为 总览 / 流水记录 / 其余");
  const bankNav = index.slice(index.indexOf("const bankNav = ["), index.indexOf("];", index.indexOf("const bankNav = [")));
  const order = ["/bank-ledger.html", "/bank-channels.html", "/bank-settings.html"].map((u) => bankNav.indexOf(u));
  assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2]);
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

test("支付渠道页点渠道行去当日流水并带 ?bank=；当日流水从地址栏读回筛选", () => {
  assert.match(channels, /location\.href = `\/bank-ledger\.html\?bank=\$\{encodeURIComponent\(bankId\)\}`/);
  assert.match(ledger, /new URLSearchParams\(location\.search\)\.get\("bank"\)/);
  assert.match(ledger, /url\.searchParams\.set\("bank"/);
  // 拆页后渠道页不再碰流水表
  assert.doesNotMatch(channels, /loadSheet|activeBankId/);
});

test("当日流水页顺序：工具栏 → 运营中银行列表 → KPI → 对平告警 → 接单区 → 今日报表；当前公司那一行已删", () => {
  const page = index.slice(index.indexOf('"/bank-ledger.html": pageLayout('), index.indexOf('"/bank-channels.html": pageLayout('));
  const order = ['class="bk-toolbar"', 'id="bk-banklist"', 'class="bk-kpis"', 'id="reconcile-alert"', 'id="bk-intake"', 'id="sheet-upper-wrap"']
    .map((k) => page.indexOf(k));
  order.forEach((pos, i) => assert.ok(pos > 0 && (i === 0 || pos > order[i - 1]), `第 ${i + 1} 块位置不对`));
  assert.doesNotMatch(page, /bk-context-strip|bk-current-company|bk-current-sync/, "当前公司 / 流水日期 / 同步状态那一行已移除");
  assert.doesNotMatch(ledger, /refreshWorkspaceContext|updateWorkspaceSyncContext/);
});

test("当日流水的银行列表可以折叠：头部常驻，收起时列出实时收款户名，状态记在 localStorage", () => {
  assert.match(ledger, /const BANKLIST_COLLAPSED_KEY = "bk-banklist-collapsed"/);
  assert.match(ledger, /class="bk-banklist-toggle" aria-expanded=/);
  assert.match(ledger, /id="bk-banklist-body"\$\{collapsed \? " hidden" : ""\}/);
  assert.match(ledger, /const liveNames = collapsed && live\.length/);
  // 没存过时：电脑展开、手机收起
  assert.match(ledger, /saved === "1" \? true : saved === "0" \? false : Boolean\(MOBILE_MQ\.matches\)/);
});

test("接单区与支付渠道不折叠：没有折叠按钮、没有折叠状态", () => {
  assert.doesNotMatch(index, /bk-intake-toggle/);
  assert.doesNotMatch(ledger, /setIntakeCollapsed|INTAKE_COLLAPSED_KEY/);
  assert.doesNotMatch(channels, /bkd-toggle-btn|bkdExpanded/);
  // 详情常驻后要靠缓存，后台每 5 秒重画不能每行重打请求
  assert.match(channels, /const bkdDetailCache = new Map\(\)/);
  assert.match(channels, /if \(hit && hit\.sig === detailSig\(b\)\) return/);
});

test("实时收款取代使用中：入口只在当日流水银行列表的每一行，旧勾选器与使用中勾都没了", () => {
  assert.doesNotMatch(index, /id="bk-live"/);
  assert.doesNotMatch(ledger, /renderLivePicker|bindLivePicker/);
  assert.match(ledger, /class="bk-live-chk" data-id="\$\{b\.id\}"/);
  assert.match(ledger, /api\("\/api\/banks\/live-receiving", \{ method: "PUT"/);
  assert.doesNotMatch(channels, /bank-active-chk|active: chk\.checked/);
  // 列表点行与工具栏下拉是同一个筛选
  assert.match(ledger, /selectBankFilter\(activeBankId === id \? ALL_BANKS : id\)/);
  assert.match(ledger, /getElementById\("sheet-bank-filter"\)\?\.addEventListener\("change", \(e\) => \{\s*selectBankFilter\(e\.target\.value\);/);
});
