const path = require("path");
const express = require("express");
const session = require("express-session");

const { readConfig } = require("./lib/readConfig");
const { getDb, seedAdmin } = require("./db/init");
const { requireLogin, requireCompany, resolveCompany, sessionGuard } = require("./middleware");
const { configPath, dbPath } = require("./lib/paths");
const { createSessionStore } = require("./lib/sessionStore");
const { productionStartupProblems } = require("./lib/startupGuards");
const { securityHeaders } = require("./lib/securityHeaders");

const cfg = readConfig();

getDb();
seedAdmin(cfg);

// 必须在 startScheduler 之前：拒绝启动时不能已经开始同步。
const startupProblems = productionStartupProblems(cfg, getDb());
if (startupProblems.length) {
  for (const problem of startupProblems) console.error("[startup] 拒绝启动:", problem);
  process.exit(1);
}

const { startScheduler } = require("./scheduler");
startScheduler(cfg);

// Telegram 余额报警与查询 Bot。整体 try/catch：token 配错、网络不通都绝不能让整个
// Web 服务起不来。
try {
  require("./services/telegramBots").startTelegram();
} catch (e) {
  console.warn("[telegram] start failed:", e.message);
}

// 数据库每日快照。同样整体 try/catch：备份起不来绝不能让 Web 服务起不来。
try {
  require("./services/backup").startBackupScheduler();
} catch (e) {
  console.warn("[backup] start failed:", e.message);
}

// 封禁渠道「待清理」每周汇总。封禁账户既不进余额合计也不参与阈值报警、也不出现在
// /balance 里，没有这条提醒，封进去的钱就彻底静默了。同一份采集与版式也是 /blocked
// 命令的后端。同样 try/catch 兜底。
try {
  require("./lib/bankCleanupReport").startCleanupDigestScheduler();
} catch (e) {
  console.warn("[cleanup] start failed:", e.message);
}


function ensurePublicUtf8(publicDir) {
  const fs = require("fs");
  const path = require("path");
  for (const sub of ["js", "css"]) {
    const dir = path.join(publicDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      // 整体 try/catch：这个函数在 app.listen 之前跑，而生产用 systemd 的
      // ProtectSystem=strict 把代码目录挂成只读。一旦真触发写入就会抛 EROFS，
      // 让服务直接起不来，且报错内容与"UTF-8 转换"毫无关联，极难排查。
      // 当前代码树上所有 public 文件的第二字节都不是 0x00，此函数是 no-op。
      try {
        const file = path.join(dir, name);
        if (!fs.statSync(file).isFile()) continue;
        const buf = fs.readFileSync(file);
        if (buf.length >= 2 && buf[1] === 0) {
          fs.writeFileSync(file, buf.toString("utf16le"), "utf8");
          console.log("[utf8-fix] converted", sub + "/" + name);
        }
      } catch (error) {
        console.warn("[utf8-fix] skipped", sub + "/" + name, error.message);
      }
    }
  }
}

const app = express();
app.disable("x-powered-by");
const publicDir = path.join(__dirname, "..", "public");
ensurePublicUtf8(publicDir);
app.use(securityHeaders);

// 只信任 loopback。绑定 127.0.0.1 后，唯一能连上 socket 的就是本机的 cloudflared。
// 用 "loopback" 而不是 1：req.ip 会解析成真实客户端 IP，且语义比"信任右边第 1 跳"精确。
app.set("trust proxy", "loopback");

// 源站是 HTTP-only 且只监听 127.0.0.1 → 能到达这里的请求必然来自本机 cloudflared，
// 而 cloudflared 的对外侧永远是 Cloudflare 边缘的 HTTPS。据此把 scheme 显式钉成 https，
// 不依赖 cloudflared 是否注入 X-Forwarded-Proto。
//
// 这一步是 cookie.secure 能工作的前提：express-session 在 cookie.secure 为 true
// 而 issecure() 判定为 false 时会【静默跳过 Set-Cookie】—— 表现是登录返回 200、
// 前端跳首页、requireLogin 发现无 session 又踢回登录页，形成无任何报错的死循环。
app.use((req, _res, next) => {
  if (!req.headers["x-forwarded-proto"]) req.headers["x-forwarded-proto"] = "https";
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(
  session({
    name: cfg.sessionName || "connect.sid",
    secret: cfg.sessionSecret,
    // 持久化 store：默认的 MemoryStore 会让每次重启都把所有人踢下线，
    // 而重启是最常见的运维操作。独立的 sessions.db，不碰主库。
    store: createSessionStore(),
    resave: false,
    saveUninitialized: false,
    // proxy:true 让 issecure() 直接读 X-Forwarded-Proto，
    // 绕开 express 的 trust-proxy 编译细节。
    proxy: true,
    // rolling:true 配 resave:false 会让每个请求都写一次 store，
    // 而前端有 6s 轮询 —— 多个操作员在线就是每秒数次写。
    rolling: false,
    cookie: {
      maxAge: 12 * 60 * 60 * 1000,
      httpOnly: true,
      secure: true,
      // 必须是 lax 而非 strict：操作员会从 WhatsApp / Telegram 点链接进后台，
      // strict 下这种跨站顶层导航不带 cookie，每次都会被弹回登录页。
      // lax 允许顶层 GET 导航带 cookie，同时仍挡住跨站 POST。
      sameSite: "lax",
      path: "/",
    },
  })
);
app.use(sessionGuard);

app.use("/api/auth", require("./routes/auth"));
app.use("/api/admin", require("./routes/admin"));
app.use(resolveCompany);
app.use("/api/companies", require("./routes/companies"));
app.use("/api/data", require("./routes/data"));
app.use("/api/banks", requireLogin, requireCompany, require("./routes/banks"));
app.use("/api/audit", require("./routes/audit"));

// 手机底部标签栏（CSS 只在 ≤700 显示）。员工（operator）只能进支付渠道页，所以放的是
// 那一页里的四个动作而不是页面；「菜单」打开侧栏，对所有角色显示——≤700 没有汉堡按钮了，
// operator 切换公司、退出登录、切主题都靠它。
// 用 <a href> 而不是 button：在别的页点了照常跳到 /bank-ledger.html#<动作>，由
// bank-ledger.js 读 hash 执行；在当日流水页本页则由 app.js 拦下直接执行。「渠道」直接进支付渠道页。
// 顺序 2026-11-09 用户定：菜单 / 流水 / 待处理 / 调钱 / 渠道（最常点的「待处理」放正中）。
const MOBILE_TABBAR = `<nav class="mobile-tabbar" id="mobile-tabbar" aria-label="快捷操作">
<button type="button" data-tab-action="menu" aria-controls="sidebar"><i data-lucide="menu"></i><span>菜单</span></button>
<a href="/bank-ledger.html#ledger" data-tab-action="ledger"><i data-lucide="list"></i><span>流水</span></a>
<a href="/bank-ledger.html#pending" data-tab-action="pending"><i data-lucide="clipboard-check"></i><span>待处理</span><b class="mobile-tabbar-badge" id="mobile-tabbar-badge" hidden></b></a>
<a href="/bank-ledger.html#transfer" data-tab-action="transfer"><i data-lucide="arrow-left-right"></i><span>调钱</span></a>
<a href="/bank-channels.html" data-tab-action="channels"><i data-lucide="landmark"></i><span>渠道</span></a>
</nav>
<button type="button" class="back-to-top" id="back-to-top" aria-label="回到顶部" title="回到顶部" hidden><i data-lucide="arrow-up"></i></button>`;

function pageLayout(title, active, body, script) {
  const primaryNav = [
    ["home", "/", "\u603b\u89c8", "layout-dashboard"],
    ["transactions", "/transactions.html", "\u4ea4\u6613", "arrow-left-right"],
    ["customers", "/customers.html", "\u5ba2\u6237", "users"],
  ];
  // 流水记录分组（总览正下方）：标题本身链到当日流水，右侧箭头只负责展开 / 收起，
  // 不能用 <details><summary>——summary 里放链接点下去会同时切换展开。operator 只能进
  // 当日流水与支付渠道（requirePageAccess），支付设置由 app.js 的 loadUser 按角色藏掉。
  const bankNav = [
    ["bank-ledger", "/bank-ledger.html", "\u5f53\u65e5\u6d41\u6c34", "list"],
    ["bank-channels", "/bank-channels.html", "\u652f\u4ed8\u6e20\u9053", "landmark"],
    ["bank-settings", "/bank-settings.html", "\u652f\u4ed8\u8bbe\u7f6e", "sliders-horizontal"],
  ];
  const insightNav = [
    ["daily-archive", "/daily-archive.html", "\u5386\u53f2\u65e5\u62a5", "calendar-days"],
    ["deposit-leaderboard", "/deposit-leaderboard.html", "\u5145\u503c\u699c", "trending-up"],
    ["referrers", "/referrer-leaderboard.html", "\u63a8\u8350\u4eba\u699c", "network"],
    ["promos", "/promo-claims.html", "\u6d3b\u52a8\u9886\u53d6", "ticket-percent"],
    ["customer-return", "/customer-return.html", "\u56de\u6d41\u62a5", "rotate-ccw"],
  ];
  // MONTHLY REPORT 菜单组，仅 admin（HTML 默认 hidden，app.js 的 loadUser 按角色放出；
  // 三个页面都在 ADMIN_ONLY_PAGES 里）。
  const monthlyNav = [
    ["monthly-report", "/monthly-report.html", "REPORT", "calendar-range"],
    ["company-expenses", "/company-expenses.html", "COMPANY EXPENSES", "receipt"],
    ["top-referral", "/top-referral.html", "TOP REFERRAL", "award"],
  ];
  const settingsNav = [
    ["audit-history", "/audit-history.html", "\u64cd\u4f5c\u5386\u53f2", "history"],
    ["admin", "/admin-users.html", "\u8d26\u53f7\u7ba1\u7406", "shield-check"],
    ["telegram-settings", "/telegram-settings.html", "Telegram", "send"],
    ["company-settings", "/company-settings.html", "\u516c\u53f8 / API", "settings"],
  ];
  const nav = [...primaryNav, ...bankNav, ...insightNav, ...monthlyNav, ...settingsNav];
  const activeItem = nav.find(([key]) => key === active) || nav[0];
  const navLink = ([key, href, label, icon], id) => {
    const cls = key === active ? ' class="active"' : "";
    const idAttr = id ? ` id="${id}" hidden` : "";
    return `<a href="${href}" data-page="${key}"${cls}${idAttr}><i data-lucide="${icon}"></i><span>${label}</span></a>`;
  };
  const homeLink = navLink(primaryNav[0]);
  const primaryLinks = primaryNav.slice(1).map((item) => navLink(item)).join("");
  const bankLinks = bankNav
    .map((item) => navLink(item, item[0] === "bank-settings" ? "nav-bank-settings" : ""))
    .join("");
  const bankOpen = bankNav.some(([key]) => key === active);
  const bankGroup = `<div class="nav-group nav-group-link${bankOpen ? " open" : ""}" id="nav-bank-group"><div class="nav-group-head"><a href="/bank-ledger.html" class="nav-group-title${bankOpen ? " is-current" : ""}"><i data-lucide="wallet"></i><span>\u6d41\u6c34\u8bb0\u5f55</span></a><button type="button" class="nav-group-toggle" aria-expanded="${bankOpen ? "true" : "false"}" aria-controls="nav-bank-children" aria-label="\u5c55\u5f00\u6216\u6536\u8d77\u6d41\u6c34\u8bb0\u5f55"><i data-lucide="chevron-down" class="nav-chevron"></i></button></div><div class="nav-children" id="nav-bank-children"${bankOpen ? "" : " hidden"}>${bankLinks}</div></div>`;
  const insightLinks = insightNav.map((item) => navLink(item)).join("");
  const settingsLinks = settingsNav
    .map((item) => navLink(item, item[0] === "admin" ? "nav-admin" : `nav-${item[0]}`))
    .join("");
  const monthlyLinks = monthlyNav.map((item) => navLink(item)).join("");
  const insightOpen = insightNav.some(([key]) => key === active) ? " open" : "";
  const monthlyOpen = monthlyNav.some(([key]) => key === active) ? " open" : "";
  const settingsOpen = settingsNav.some(([key]) => key === active) ? " open" : "";
  // script 可以是一个路径或按加载顺序排列的数组（纯函数模块要排在页面脚本前面）。
  const extra = (Array.isArray(script) ? script : [script])
    .filter(Boolean)
    .map((src) => `<script src="${src}"></script>`)
    .join("");
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="color-scheme" content="light dark"><title>${title} - NXC Report</title><link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/png" href="/brand/favicon-32.png"><link rel="apple-touch-icon" href="/brand/apple-touch-icon.png"><link rel="stylesheet" href="/css/style.css?v=20260812transferfix1"></head><body><a class="skip-link" href="#main-content">\u8df3\u5230\u4e3b\u5185\u5bb9</a><div class="ambient-field" aria-hidden="true"><span></span><span></span></div><div class="sidebar-backdrop" id="sidebar-backdrop"></div><button type="button" class="mobile-menu-btn icon-btn" id="mobile-menu-btn" aria-label="\u6253\u5f00\u5bfc\u822a" aria-controls="sidebar" aria-expanded="false"><i data-lucide="menu"></i><span class="icon-fallback" aria-hidden="true">Menu</span></button><div class="layout"><aside class="sidebar" id="sidebar" aria-label="\u4e3b\u5bfc\u822a"><div class="brand-mark"><img class="brand-symbol" src="/brand/nxc-icon.png" alt="" width="38" height="38"><div><h2>NXC</h2><p>Report</p></div></div><div class="company-bar glass-control" id="company-bar"><label for="company-select">\u5f53\u524d\u516c\u53f8</label><select id="company-select" aria-describedby="company-sync"></select><span id="company-sync" class="company-sync-hint" aria-live="polite">\u6b63\u5728\u8bfb\u53d6...</span></div><nav class="nav-stack" aria-label="\u5de5\u4f5c\u533a"><div class="nav-section nav-primary">${homeLink}</div>${bankGroup}<div class="nav-section nav-primary">${primaryLinks}</div><details class="nav-group"${insightOpen}><summary><span class="nav-summary-label"><i data-lucide="sparkles"></i><span>\u6d1e\u5bdf</span></span><i data-lucide="chevron-down" class="nav-chevron"></i></summary><div class="nav-children">${insightLinks}</div></details><details class="nav-group" id="nav-monthly-group"${monthlyOpen} hidden><summary><span class="nav-summary-label"><i data-lucide="calendar-range"></i><span>MONTHLY REPORT</span></span><i data-lucide="chevron-down" class="nav-chevron"></i></summary><div class="nav-children">${monthlyLinks}</div></details><details class="nav-group" id="nav-settings-group"${settingsOpen} hidden><summary><span class="nav-summary-label"><i data-lucide="sliders-horizontal"></i><span>\u8bbe\u7f6e</span></span><i data-lucide="chevron-down" class="nav-chevron"></i></summary><div class="nav-children">${settingsLinks}</div></details></nav><div class="sidebar-footer"><div class="user-info"><div class="user-avatar" aria-hidden="true">OP</div><div class="user-copy"><span class="user-label">Operator</span><strong id="current-user" translate="no">-</strong></div><button type="button" class="sidebar-theme-btn icon-btn" aria-label="切换主题" title="切换主题"><i data-lucide="moon"></i></button><button type="button" class="logout-btn icon-btn" id="logout-btn" aria-label="\u9000\u51fa\u767b\u5f55" title="\u9000\u51fa\u767b\u5f55"><i data-lucide="log-out"></i></button></div></div></aside><main class="main" id="main-content" tabindex="-1"><header class="topbar glass-panel"><div class="topbar-heading"><div class="topbar-kicker">NXC Report</div><div class="topbar-title">${activeItem[2]}</div></div><div class="topbar-actions"><div class="sync-state" id="global-sync-state" data-state="loading" role="status" aria-live="polite"><span class="sync-indicator" aria-hidden="true"></span><span class="sync-copy"><strong id="global-sync-text">\u6b63\u5728\u8bfb\u53d6\u540c\u6b65\u72b6\u6001</strong><small id="global-sync-time"></small></span></div><button type="button" class="lang-toggle" id="lang-toggle" translate="no" aria-label="\u5207\u6362\u8bed\u8a00" title="\u5207\u6362\u8bed\u8a00"><span data-lang-choice="zh">中</span><span data-lang-choice="en">EN</span></button><button type="button" class="theme-toggle icon-btn" id="theme-toggle" aria-label="\u5207\u6362\u4e3b\u9898" title="\u5207\u6362\u4e3b\u9898"><i data-lucide="moon"></i></button></div></header><section class="page-shell">${body}</section></main></div>${MOBILE_TABBAR}<script src="/vendor/lucide-1.65.0.min.js"></script><script src="/vendor/gsap-3.12.5.min.js"></script><script src="/js/alarm.js?v=20260930alarm1"></script><script src="/js/modal-guard.js?v=20261106drill1"></script><script src="/js/app.js?v=20260802platformsound3"></script><script src="/js/cross-company-alerts.js?v=20261109mob1"></script><script src="/js/mobile-table-drawer.js?v=20261109mtd2"></script><script src="/js/customer-detail.js?v=20260731bankfix4"></script>${extra}</body></html>`;
}

const pageRoutes = {
  "/": pageLayout(
    "\u603b\u89c8",
    "home",
    `<div class="page-toolbar command-toolbar">
  <div>
    <p class="page-eyebrow">Operations overview</p>
    <h1>\u4eca\u65e5 Command Center</h1>
  </div>
  <div class="hero-meta">
    <div id="report-date">\u6b63\u5728\u8bfb\u53d6\u62a5\u8868...</div>
    <div id="sync-status" class="hero-sync-detail" aria-live="polite"></div>
  </div>
</div>

<section class="command-hero" aria-label="\u4eca\u65e5\u6838\u5fc3\u6307\u6807">
  <article class="hero-net" id="winloss-card">
    <div class="eyebrow">\u4eca\u65e5\u51c0\u8f93\u8d62</div>
    <div class="hero-value" id="winloss-value">-</div>
    <div class="hero-sub" id="winloss-sub">\u5145\u63d0\u6570\u636e\u52a0\u8f7d\u4e2d</div>
  </article>
  <div class="hero-core-grid">
    <article class="hero-core">
      <div class="label">\u5145\u503c</div>
      <div class="value positive" id="dep-total">-</div>
      <div class="sub" id="dep-count">-</div>
    </article>
    <article class="hero-core">
      <div class="label">\u63d0\u73b0</div>
      <div class="value negative" id="wd-total">-</div>
      <div class="sub" id="wd-count">-</div>
    </article>
    <article class="hero-core">
      <div class="label">\u603b\u5ba2\u6237</div>
      <div class="value" id="cust-total">-</div>
      <div class="sub" id="cust-new">-</div>
    </article>
  </div>
</section>

<section class="secondary-kpis" aria-label="\u6b21\u7ea7\u6307\u6807">
  <div class="secondary-kpi"><span>\u4eca\u65e5\u5728\u7ebf</span><strong id="online-count">-</strong></div>
  <div class="secondary-kpi"><span>\u5145\u503c\u4eba\u6570</span><strong id="dep-users-count">-</strong></div>
  <div class="secondary-kpi"><span>Bonus</span><strong><span id="bonus-total">-</span> <small id="bonus-count"></small></strong></div>
  <div class="secondary-kpi"><span>Manual</span><strong><span id="manual-total">-</span> <small id="manual-count"></small></strong></div>
  <div class="secondary-kpi"><span>Commission</span><strong><span id="commission-total">-</span> <small id="commission-count"></small></strong></div>
</section>

<div class="command-grid">
  <section class="insight-panel glass-panel" aria-labelledby="insight-title">
    <div class="panel-heading"><h2 id="insight-title">\u6d1e\u5bdf\u5de5\u4f5c\u533a</h2><span class="panel-note">\u62a5\u8868\u4e0e\u699c\u5355</span></div>
    <div class="insight-grid">
      <a class="insight-link" href="/daily-archive.html"><span class="insight-icon"><i data-lucide="calendar-days"></i></span><span class="insight-copy"><strong>\u5386\u53f2\u65e5\u62a5</strong><small>\u6309\u65e5\u8ffd\u6eaf\u5145\u63d0\u4e0e\u8f93\u8d62</small></span><i data-lucide="chevron-right"></i></a>
      <a class="insight-link" href="/deposit-leaderboard.html"><span class="insight-icon"><i data-lucide="trending-up"></i></span><span class="insight-copy"><strong>\u5145\u503c\u699c</strong><small>\u5927\u989d\u4e0e\u9ad8\u9891\u5ba2\u6237</small></span><i data-lucide="chevron-right"></i></a>
      <a class="insight-link" href="/referrer-leaderboard.html"><span class="insight-icon"><i data-lucide="network"></i></span><span class="insight-copy"><strong>\u63a8\u8350\u4eba\u699c</strong><small>\u6e20\u9053\u8d21\u732e\u4e0e\u8f6c\u5316</small></span><i data-lucide="chevron-right"></i></a>
      <a class="insight-link" href="/promo-claims.html"><span class="insight-icon"><i data-lucide="ticket-percent"></i></span><span class="insight-copy"><strong>\u6d3b\u52a8\u9886\u53d6</strong><small>Bonus \u4eba\u6570\u4e0e\u91d1\u989d</small></span><i data-lucide="chevron-right"></i></a>
      <a class="insight-link" href="/customer-return.html"><span class="insight-icon"><i data-lucide="rotate-ccw"></i></span><span class="insight-copy"><strong>\u56de\u6d41\u62a5\u8868</strong><small>\u6c89\u9ed8\u5ba2\u6237\u4e0e\u633d\u56de\u673a\u4f1a</small></span><i data-lucide="chevron-right"></i></a>
    </div>
  </section>
  <section class="week-panel glass-panel" aria-labelledby="week-title">
    <div class="panel-heading">
      <div><h2 id="week-title">\u8fd1 7 \u65e5\u6458\u8981</h2><span id="week-summary" class="panel-note">\u6b63\u5728\u52a0\u8f7d</span></div>
      <a href="/daily-archive.html">\u67e5\u770b\u65e5\u62a5</a>
    </div>
    <div class="week-strip" id="week-strip" aria-live="polite"></div>
    <div id="week-empty" class="empty-state" hidden>\u6682\u65e0\u53ef\u7528\u7684\u5386\u53f2\u6570\u636e</div>
  </section>
</div>

<section class="data-panel home-rank-panel" aria-labelledby="today-rank-title">
  <div class="panel-heading">
    <div><h2 id="today-rank-title">\u4eca\u65e5\u5ba2\u6237\u699c</h2><span id="today-lb-summary" class="panel-note">\u6b63\u5728\u52a0\u8f7d</span></div>
  </div>
  <div class="segment-tabs" id="today-lb-sort-tabs" aria-label="\u5ba2\u6237\u699c\u6392\u5e8f">
    <button type="button" class="seg-btn active" data-sort="dep_total">\u5145\u503c\u603b\u989d</button>
    <button type="button" class="seg-btn" data-sort="dep_count">\u5145\u503c\u7b14\u6570</button>
    <button type="button" class="seg-btn" data-sort="max_single">\u6700\u5927\u5355\u7b14</button>
    <button type="button" class="seg-btn" data-sort="last_dep">\u6700\u540e\u5145\u503c</button>
    <button type="button" class="seg-btn" data-sort="win_loss">\u4eca\u65e5\u8f93\u8d62</button>
  </div>
  <div class="table-wrap data-surface data-surface home-rank-table">
    <table class="sticky-2" data-m="lead:1 title:2 metric:4,8">
      <thead><tr><th>\u6392\u540d</th><th>\u59d3\u540d</th><th>\u624b\u673a</th><th>\u4eca\u65e5\u5145\u503c</th><th>\u5145\u503c\u7b14\u6570</th><th>\u4eca\u65e5\u63d0\u6b3e</th><th>\u63d0\u6b3e\u7b14\u6570</th><th>\u4eca\u65e5\u8f93\u8d62</th><th>\u6700\u5927\u5355\u7b14</th><th>\u6700\u540e\u5145\u503c</th><th>\u6700\u540e\u63d0\u6b3e</th><th>\u63a8\u8350\u4eba</th></tr></thead>
      <tbody id="today-lb-rows"></tbody>
    </table>
  </div>
  <div id="today-lb-empty" class="empty-state" hidden>\u4eca\u65e5\u6682\u65e0\u5145\u503c\u5ba2\u6237</div>
  <div id="today-lb-pager" class="pager"></div>
</section>`,
    "/js/home.js?v=20260731bankfix3"
  ),
  "/daily-archive.html": pageLayout(
    "\u5386\u53f2\u65e5\u62a5",
    "daily-archive",
    '<div class="page-toolbar"><h1>\u5386\u53f2\u65e5\u62a5</h1><div class="archive-heading-meta"><div id="report-date"></div><div id="report-hint"></div></div></div><div class="filters control-strip archive-filters"><button type="button" class="btn btn-outline btn-sm" id="prev-day">\u2190 \u4e0a\u4e00\u5929</button><input type="date" id="report-day"><button type="button" class="btn btn-outline btn-sm" id="next-day">\u4e0b\u4e00\u5929 \u2192</button><button type="button" class="btn btn-outline btn-sm" id="yesterday-btn">\u6628\u5929</button><button type="button" class="btn btn-primary btn-sm" id="today-btn">\u4eca\u65e5</button><a class="btn btn-outline btn-sm" id="tx-link" href="/transactions.html">\u67e5\u770b\u5f53\u65e5\u4ea4\u6613</a></div><div class="archive-quick" id="quick-dates"></div><div class="cards metric-grid"><div class="card green"><div class="label">\u5145\u503c</div><div class="value" id="dep-count">-</div><div class="sub" id="dep-total"></div></div><div class="card red"><div class="label">\u63d0\u73b0</div><div class="value" id="wd-count">-</div><div class="sub" id="wd-total"></div></div><div class="card orange"><div class="label">\u5728\u7ebf\u4eba\u6570</div><div class="value" id="online-count">-</div><div class="sub">\u6709\u4e0a\u7ebf\u8bb0\u5f55</div></div><div class="card purple"><div class="label">\u5145\u503c\u4eba\u6570</div><div class="value" id="dep-users-count">-</div><div class="sub">\u53bb\u91cd\u4eba\u6570</div></div><div class="card blue"><div class="label">\u603b\u987e\u5ba2</div><div class="value" id="cust-total">-</div><div class="sub" id="cust-new"></div></div><div class="card bonus"><div class="label">Bonus</div><div class="value" id="bonus-count">-</div><div class="sub" id="bonus-total"></div></div><div class="card manual"><div class="label">Manual</div><div class="value" id="manual-count">-</div><div class="sub" id="manual-total"></div></div><div class="card commission"><div class="label">Commission</div><div class="value" id="commission-count">-</div><div class="sub" id="commission-total"></div></div><div class="card winloss" id="winloss-card"><div class="label">\u5f53\u65e5\u8f93\u8d62</div><div class="value" id="winloss-value">-</div><div class="sub" id="winloss-sub"></div></div></div><div class="data-panel month-wl-panel"><h2>本月输赢 <span class="panel-note">(截至当前报表日)</span></h2><div class="cards metric-grid month-wl-cards"><div class="card winloss month-wl-card"><div class="label" id="month-wl-label">本月输赢</div><div class="value" id="month-wl-value">-</div><div class="sub" id="month-wl-sub"></div></div></div></div><div class="data-panel home-rank-panel"><h2 id="lb-title">\u5f53\u65e5\u987e\u5ba2\u699c</h2><div id="day-lb-summary" class="table-summary"></div><div class="segment-tabs" id="day-lb-sort-tabs"><button type="button" class="seg-btn active" data-sort="dep_total">\u5145\u503c\u603b\u989d</button><button type="button" class="seg-btn" data-sort="dep_count">\u5145\u503c\u7b14\u6570</button><button type="button" class="seg-btn" data-sort="max_single">\u6700\u5927\u5355\u7b14</button><button type="button" class="seg-btn" data-sort="last_dep">\u6700\u540e\u5145\u503c</button><button type="button" class="seg-btn" data-sort="win_loss">\u8f93\u8d62</button></div><div class="table-wrap data-surface home-rank-table"><table class="sticky-2" data-m="lead:1 title:2 metric:4,8"><thead><tr><th>\u6392\u540d</th><th>\u59d3\u540d</th><th>\u624b\u673a</th><th>\u5145\u503c\u603b\u989d</th><th>\u5145\u503c\u7b14\u6570</th><th>\u63d0\u6b3e\u603b\u989d</th><th>\u63d0\u6b3e\u7b14\u6570</th><th>\u8f93\u8d62</th><th>\u6700\u5927\u5355\u7b14</th><th>\u6700\u540e\u5145\u503c</th><th>\u63a8\u8350\u4eba</th></tr></thead><tbody id="day-lb-rows"></tbody></table></div><div id="day-lb-empty" class="chart-empty empty-state" hidden>\u5f53\u65e5\u6682\u65e0\u5145\u503c\u987e\u5ba2</div><div id="day-lb-pager" class="pager pager-spaced"></div></div>',
    "/js/daily-archive.js?v=20260731bankfix3"
  ),
  "/transactions.html": pageLayout(
    "\u5b9e\u65f6\u4ea4\u6613",
    "transactions",
    '<div class="page-toolbar"><h1>\u5b9e\u65f6\u4ea4\u6613</h1><div id="tx-summary" class="panel-note"></div></div><div class="segment-tabs" id="type-tabs"><button type="button" class="seg-btn active" data-type="">\u5168\u90e8</button><button type="button" class="seg-btn" data-type="DEPOSIT">\u5145\u503c</button><button type="button" class="seg-btn" data-type="WITHDRAW">\u63d0\u73b0</button><button type="button" class="seg-btn" data-type="REDEPOSIT">Redeposit</button><button type="button" class="seg-btn" data-type="BONUS">Bonus</button><button type="button" class="seg-btn" data-type="MANUAL">Manual</button><button type="button" class="seg-btn" data-type="COMMISSION">Commission</button></div><div class="filters control-strip"><input id="q" placeholder="\u59d3\u540d/\u624b\u673a/\u4ea4\u6613\u53f7"><input type="date" id="date"><button class="btn btn-primary btn-sm" id="search-btn">\u641c\u7d22</button></div><div id="dep-channels" class="data-panel deposit-channel-panel" hidden></div><div class="table-wrap data-surface"><table data-m="title:4 meta:2,1 metric:6"><thead><tr><th>\u65f6\u95f4</th><th>\u7c7b\u578b</th><th>\u91cd\u65b0\u5145\u503c</th><th>\u59d3\u540d</th><th>\u624b\u673a</th><th>\u91d1\u989d</th><th>\u8fdb\u94b1\u65b9\u5f0f</th><th>\u6e20\u9053</th><th>\u72b6\u6001</th><th>\u4ea4\u6613\u53f7</th></tr></thead><tbody id="rows"></tbody></table></div><div class="pager" id="pager"></div>',
    "/js/transactions.js?v=20260731bankfix3"
  ),
  "/deposit-leaderboard.html": pageLayout(
    "\u5145\u503c\u699c",
    "deposit-leaderboard",
    '<div class="page-toolbar"><h1>\u5145\u503c\u699c</h1><div id="lb-summary" class="panel-note">\u4ec5\u663e\u793a\u5145\u8fc7\u94b1\u7684\u987e\u5ba2</div></div><div class="segment-tabs" id="sort-tabs"><button type="button" class="seg-btn active" data-sort="total">\u9ed8\u8ba4\u00b7\u5145\u503c\u603b\u989d</button><button type="button" class="seg-btn" data-sort="volume">\u5355\u91cf\u6700\u591a</button><button type="button" class="seg-btn" data-sort="max_single">\u5355\u5f20\u5145\u503c\u6700\u5927</button></div><div class="filters control-strip"><input id="q" placeholder="\u624b\u673a/\u59d3\u540d/\u63a8\u8350\u4eba"><button class="btn btn-primary btn-sm" id="search-btn">\u641c\u7d22</button></div><div class="table-wrap data-surface"><table class="extra-table sticky-2" data-m="lead:1 title:2 metric:6"><thead><tr><th rowspan="2">\u6392\u540d</th><th rowspan="2">\u59d3\u540d</th><th rowspan="2">\u624b\u673a</th><th rowspan="2">\u6700\u540e\u5145\u503c</th><th rowspan="2">\u6700\u540e\u4e0a\u7ebf</th><th rowspan="2">\u5145\u503c\u603b\u989d</th><th rowspan="2">\u5145\u503c\u6b21\u6570</th><th rowspan="2">\u6700\u5927\u5355\u7b14</th><th colspan="2" class="th-group th-bonus">Bonus</th><th colspan="2" class="th-group th-manual">Manual</th><th colspan="2" class="th-group th-commission">Commission</th><th rowspan="2">\u63a8\u8350\u4eba</th></tr><tr><th class="th-sub">\u7b14\u6570</th><th class="th-sub">\u603b\u989d</th><th class="th-sub">\u7b14\u6570</th><th class="th-sub">\u603b\u989d</th><th class="th-sub">\u7b14\u6570</th><th class="th-sub">\u603b\u989d</th></tr></thead><tbody id="rows"></tbody></table></div><div class="pager" id="pager"></div>',
    "/js/deposit-leaderboard.js?v=20260731bankfix3"
  ),
  "/promo-claims.html": pageLayout(
    "\u6d3b\u52a8\u9886\u53d6",
    "promos",
    '<div class="page-toolbar"><h1>\u6d3b\u52a8\u9886\u53d6</h1><div id="promo-summary" class="panel-note"></div></div><div class="cards metric-grid"><div class="card bonus"><div class="label">Bonus \u53bb\u91cd\u603b\u4eba\u6570</div><div class="value" id="total-users">-</div></div><div class="card purple"><div class="label">Bonus \u9886\u53d6\u603b\u7b14\u6570</div><div class="value" id="total-count">-</div></div><div class="card orange"><div class="label">Bonus \u9886\u53d6\u603b\u91d1\u989d</div><div class="value" id="total-amount">-</div></div></div><div class="filters control-strip"><span class="date-range"><input type="date" id="date-from"><span class="date-sep">\u81f3</span><input type="date" id="date-to"></span><input id="q" placeholder="\u641c\u7d22\u6d3b\u52a8\u540d\u79f0"><button class="btn btn-primary btn-sm" id="search-btn">\u641c\u7d22</button><button class="btn btn-outline btn-sm" id="backfill-btn">\u540c\u6b65\u6d3b\u52a8\u540d</button></div><div class="table-wrap data-surface"><table class="sticky-2" data-m="lead:1 title:2 metric:5"><thead><tr><th>\u6392\u540d</th><th>\u6d3b\u52a8\u540d\u79f0</th><th>\u9886\u53d6\u4eba\u6570\uff08\u53bb\u91cd\uff09</th><th>\u9886\u53d6\u7b14\u6570</th><th>\u603b\u91d1\u989d</th></tr></thead><tbody id="rows"></tbody></table></div><div class="pager" id="promo-pager"></div>',
    "/js/promo-claims.js?v=20260817modalux2"
  ),
  "/referrer-leaderboard.html": pageLayout(
    "\u63a8\u8350\u4eba\u699c",
    "referrers",
    '<div class="page-toolbar"><h1>\u63a8\u8350\u4eba\u699c</h1><div id="ref-summary" class="panel-note"></div></div><div class="segment-tabs" id="sort-tabs"><button type="button" class="seg-btn active" data-sort="first_dep">\u9996\u5145\u4eba\u6570</button><button type="button" class="seg-btn" data-sort="new_regs">\u65b0\u6ce8\u518c</button><button type="button" class="seg-btn" data-sort="dep_total">\u5145\u503c\u603b\u989d</button><button type="button" class="seg-btn" data-sort="total_sum">\u6392\u540d\u603b\u548c</button></div><div class="filters control-strip"><span class="date-range" id="date-range-wrap"><input type="date" id="date-from"><span class="date-sep">\u81f3</span><input type="date" id="date-to"></span><input id="q" placeholder="\u641c\u7d22\u63a8\u8350\u4eba"><button class="btn btn-primary btn-sm" id="search-btn">\u641c\u7d22</button></div><div class="table-wrap data-surface"><table id="ref-table" class="sticky-2" data-m="lead:1 title:2 metric:6,8"><thead><tr><th>\u6392\u540d</th><th>\u63a8\u8350\u4eba</th><th data-col="new_regs">\u65b0\u6ce8\u518c</th><th data-col="first_dep">\u9996\u5145\u4eba\u6570</th><th data-col="dep_users">\u5145\u503c\u4eba\u6570</th><th>\u5145\u503c\u603b\u989d</th><th>\u63d0\u6b3e\u603b\u989d</th><th>\u51c0\u5165\u91d1</th><th data-col="total_customers">\u7d2f\u8ba1\u987e\u5ba2</th></tr></thead><tbody id="rows"></tbody></table></div><div class="pager" id="referrer-pager"></div>',
    "/js/referrer-leaderboard.js?v=20260731bankfix3"
  ),
  "/referrer-report.html": pageLayout(
    "\u63a8\u8350\u4eba\u62a5\u8868",
    "referrers",
    '<div class="page-toolbar"><h1 id="ref-title">-</h1><div id="ref-date" class="panel-note"></div></div><div class="filters control-strip"><span class="date-range"><input type="date" id="date-from"><span class="date-sep">\u81f3</span><input type="date" id="date-to"></span></div><div class="cards metric-grid"><div class="card blue"><div class="label">\u65b0\u6ce8\u518c</div><div class="value" id="card-new">-</div></div><div class="card green"><div class="label">\u9996\u5145\u4eba\u6570</div><div class="value" id="card-first-dep">-</div></div><div class="card purple"><div class="label">\u5145\u503c\u603b\u989d</div><div class="value" id="card-dep">-</div></div><div class="card red"><div class="label">\u63d0\u6b3e\u603b\u989d</div><div class="value" id="card-wd">-</div></div><div class="card orange"><div class="label">\u7d2f\u8ba1\u987e\u5ba2</div><div class="value" id="card-total">-</div></div></div><div class="data-panel"><h2>\u987e\u5ba2\u660e\u7ec6</h2><div id="cust-hint" class="table-summary"></div><div class="segment-tabs" id="segment-tabs"><button type="button" class="seg-btn active" data-segment="all">\u5168\u90e8\u987e\u5ba2</button><button type="button" class="seg-btn" data-segment="new_today">\u4eca\u65e5\u65b0\u6ce8\u518c</button><button type="button" class="seg-btn" data-segment="first_dep_today">\u4eca\u65e5\u9996\u5145</button></div><div class="table-wrap data-surface"><table data-m="title:1 meta:2 metric:5"><thead><tr><th>\u59d3\u540d</th><th>\u624b\u673a</th><th>\u6ce8\u518c\u65e5</th><th>\u9996\u5145\u65e5</th><th>\u7d2f\u8ba1\u5145\u503c</th><th>\u7d2f\u8ba1\u63d0\u6b3e</th><th>\u6700\u540e\u4e0a\u7ebf</th><th>\u6700\u540e\u5145\u503c</th></tr></thead><tbody id="cust-rows"></tbody></table></div><div class="pager" id="ref-report-pager"></div></div>',
    "/js/referrer-report.js?v=20261003nocharts1"
  ),
  "/customer-return.html": pageLayout(
    "\u56de\u6d41\u62a5\u8868",
    "customer-return",
    '<div class="page-toolbar"><h1>\u56de\u6d41\u62a5\u8868</h1><div id="report-date" class="panel-note"></div></div><p id="report-hint" class="panel-note page-hint"></p><div class="cards metric-grid"><div class="card green"><div class="label">\u56de\u6d41\u4eba\u6570</div><div class="value" id="card-return-users">-</div><div class="sub">\u6c89\u9ed8\u22653\u5929\u540e\u518d\u5145\u503c</div></div><div class="card blue"><div class="label">\u56de\u6d41\u5145\u503c\u7b14\u6570</div><div class="value" id="card-return-deps">-</div></div><div class="card purple"><div class="label">\u56de\u6d41\u5145\u503c\u91d1\u989d</div><div class="value" id="card-return-total">-</div></div><div class="card red"><div class="label">\u5f85\u633d\u56de\uff087\u5929+\u672a\u4e0a\u7ebf\uff09</div><div class="value" id="card-recover-pool">-</div><div class="sub">\u53ef\u53d1\u77ed\u4fe1\u540d\u5355</div></div><div class="card orange"><div class="label">\u8fd1\u671f\u79bb\u7ebf 3~7\u5929</div><div class="value" id="card-offline-37">-</div><div class="sub">\u6e29\u548c\u5524\u9192</div></div><div class="card winloss"><div class="label">\u56de\u6d41\u7387</div><div class="value" id="card-return-rate">-</div><div class="sub">\u56de\u6d41\u4eba\u6570 / (\u56de\u6d41+\u5f85\u633d\u56de)</div></div></div><div class="filters control-strip"><span class="date-range"><input type="date" id="date-from"><span class="date-sep">\u81f3</span><input type="date" id="date-to"></span><input id="q" placeholder="\u624b\u673a/\u59d3\u540d/\u63a8\u8350\u4eba"><button class="btn btn-primary btn-sm" id="search-btn">\u641c\u7d22</button></div><div class="segment-tabs" id="segment-tabs"><button type="button" class="seg-btn active" data-segment="all">\u56de\u6d41\u5145\u503c\uff08\u22653\u5929\uff09</button><button type="button" class="seg-btn" data-segment="gap_3">\u6c89\u9ed83~6\u5929</button><button type="button" class="seg-btn" data-segment="gap_7">\u6c89\u9ed87\u5929+\u91cd\u70b9</button></div><div id="table-summary" class="table-summary"></div><div class="table-wrap data-surface"><table class="sticky-2" data-m="lead:1 title:2 metric:4,8"><thead><tr><th>\u6392\u540d</th><th>\u59d3\u540d</th><th>\u624b\u673a</th><th>\u6c89\u9ed8\u5929\u6570</th><th>\u4e0a\u6b21\u5145\u503c\u65e5</th><th>\u56de\u6d41\u65e5</th><th>\u533a\u95f4\u5145\u503c\u7b14\u6570</th><th>\u533a\u95f4\u5145\u503c\u91d1\u989d</th><th>\u7d2f\u8ba1\u5145\u503c</th><th>\u6700\u540e\u4e0a\u7ebf</th><th>\u63a8\u8350\u4eba</th></tr></thead><tbody id="rows"></tbody></table></div><div class="pager" id="return-pager"></div><div id="empty" class="chart-empty empty-state" hidden>\u672c\u533a\u95f4\u6682\u65e0\u56de\u6d41\u8bb0\u5f55</div>',
    "/js/customer-return.js?v=20261003nocharts1"
  ),
  "/customers.html": pageLayout(
    "\u987e\u5ba2\u5217\u8868",
    "customers",
    '<div class="page-toolbar"><h1>\u987e\u5ba2\u5217\u8868</h1><div id="cust-summary" class="panel-note"></div></div><div class="segment-tabs" id="segment-tabs"><button type="button" class="seg-btn active" data-segment="all">\u6240\u6709\u987e\u5ba2</button><button type="button" class="seg-btn" data-segment="dep_today">\u4eca\u65e5\u6709\u5145\u503c</button><button type="button" class="seg-btn" data-segment="never_deposited">\u6ca1\u5145\u503c\u8fc7</button><button type="button" class="seg-btn" data-segment="active_depositor">\u8fdb\u8fc7\u94b1\u00b72\u5929\u5185\u5728\u7ebf</button><button type="button" class="seg-btn" data-segment="offline_3_7">\u8fdb\u8fc7\u94b1\u00b73\u20137\u5929\u672a\u4e0a\u7ebf</button><button type="button" class="seg-btn" data-segment="offline_7plus">\u8fdb\u8fc7\u94b1\u00b7\u8d857\u5929\u672a\u4e0a\u7ebf</button></div><div class="filters control-strip"><input id="q" placeholder="\u624b\u673a/\u59d3\u540d/\u63a8\u8350\u4eba"><button class="btn btn-primary btn-sm" id="search-btn">\u641c\u7d22</button><button class="btn btn-outline btn-sm" id="export-btn">\u5bfc\u51fa\u7535\u8bdd</button></div><div class="modal-overlay" id="export-modal"><div class="modal export-modal"><h2>\u5bfc\u51fa\u7535\u8bdd\u53f7\u7801</h2><p class="modal-note">\u9ed8\u8ba4\u5bfc\u51fa\u6240\u6709\u987e\u5ba2\uff0c\u53ef\u52fe\u9009\u4ee5\u4e0b\u5206\u7ec4\u5408\u5e76\u53bb\u91cd</p><div class="form-group"><label>\u6587\u4ef6\u683c\u5f0f</label><select id="export-format"><option value="csv">CSV</option><option value="txt">TXT\uff08\u6bcf\u884c\u4e00\u4e2a\u53f7\u7801\uff09</option><option value="googlesheet">Google Sheets\uff08CSV \u5bfc\u5165\uff09</option></select></div><div class="form-group"><label>\u987e\u5ba2\u5206\u7ec4</label><div class="export-segments"><label class="export-check"><input type="checkbox" id="exp-all" checked> \u6240\u6709\u987e\u5ba2</label><label class="export-check"><input type="checkbox" data-segment="never_deposited"> \u6ca1\u5145\u503c\u8fc7</label><label class="export-check"><input type="checkbox" data-segment="active_depositor"> \u8fdb\u8fc7\u94b1\u00b72\u5929\u5185\u5728\u7ebf</label><label class="export-check"><input type="checkbox" data-segment="offline_3_7"> \u8fdb\u8fc7\u94b1\u00b73\u20137\u5929\u672a\u4e0a\u7ebf</label><label class="export-check"><input type="checkbox" data-segment="offline_7plus"> \u8fdb\u8fc7\u94b1\u00b7\u8d857\u5929\u672a\u4e0a\u7ebf</label></div></div><div id="export-hint" class="modal-hint"></div><div class="actions"><button class="btn btn-outline btn-sm" id="export-cancel">\u53d6\u6d88</button><button class="btn btn-primary btn-sm" id="export-confirm">\u4e0b\u8f7d</button></div></div></div><div class="table-wrap data-surface"><table class="extra-table cust-table" data-m="title:1 meta:2 metric:6,14"><thead><tr><th rowspan="2">\u59d3\u540d</th><th rowspan="2">\u624b\u673a</th><th rowspan="2">\u6700\u540e\u5145\u503c</th><th rowspan="2">\u6700\u540e\u4e0a\u7ebf</th><th rowspan="2">\u5145\u503c\u6b21\u6570</th><th rowspan="2">\u5145\u503c\u603b\u989d</th><th rowspan="2">\u63d0\u6b3e\u603b\u989d</th><th colspan="2" class="th-group th-bonus">Bonus</th><th colspan="2" class="th-group th-manual">Manual</th><th colspan="2" class="th-group th-commission">Commission</th><th rowspan="2">\u516c\u53f8\u8f93\u8d62</th><th rowspan="2">\u63a8\u8350\u4eba</th></tr><tr><th class="th-sub">\u7b14\u6570</th><th class="th-sub">\u603b\u989d</th><th class="th-sub">\u7b14\u6570</th><th class="th-sub">\u603b\u989d</th><th class="th-sub">\u7b14\u6570</th><th class="th-sub">\u603b\u989d</th></tr></thead><tbody id="rows"></tbody></table></div><div class="pager" id="pager"></div>',
    "/js/customers.js?v=20260817modalux2"
  ),
  "/company-settings.html": pageLayout(
    "\u516c\u53f8/API \u8bbe\u7f6e",
    "company-settings",
    '<div class="page-toolbar"><h1>\u516c\u53f8 / API \u8bbe\u7f6e</h1><button class="btn btn-success btn-sm" id="create-btn">+ \u65b0\u5efa\u516c\u53f8</button></div><p class="page-description">\u914d\u7f6e\u5404\u516c\u53f8\u540e\u53f0 API\uff0c\u542f\u7528\u540e\u5b9a\u65f6\u540c\u6b65\u4f1a\u81ea\u52a8\u62c9\u53d6\u6570\u636e\uff1b\u65b0\u5bf9\u63a5\u76d8\u53ef\u76f4\u63a5\u5728\u6b64\u6dfb\u52a0\uff0c\u65e0\u9700\u6539\u4ee3\u7801</p><div id="company-cards" class="company-cards"></div><div class="modal-overlay" id="create-modal"><div class="modal"><h2>\u65b0\u5efa\u5bf9\u63a5\u76d8</h2><div class="form-group"><label>\u516c\u53f8 ID</label><input id="new-id" placeholder="\u4f8b\u5982 mybrand01"></div><div class="form-group"><label>\u663e\u793a\u540d\u79f0</label><input id="new-name" placeholder="\u4f8b\u5982 MyBrand"></div><div class="form-group"><label>API URL</label><input id="new-api-url" autocomplete="off" data-lpignore="true" data-1p-ignore placeholder="https://.../api/v1/index.php"></div><div class="form-group"><label>Access ID</label><input id="new-access-id" autocomplete="off" data-lpignore="true" data-1p-ignore></div><div class="form-group"><label>Access Token</label><input id="new-access-token" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore></div><p id="create-hint" class="form-message" role="status" aria-live="polite"></p><div class="actions"><button class="btn btn-outline btn-sm" id="cancel-btn">\u53d6\u6d88</button><button class="btn btn-outline btn-sm" id="create-test-btn">\u6d4b\u8bd5\u8fde\u63a5</button><button class="btn btn-primary btn-sm" id="create-submit">\u521b\u5efa</button></div></div></div><div class="modal-overlay" id="delete-modal"><div class="modal"><h2>\u5220\u9664\u516c\u53f8</h2><p class="modal-note">\u5c06\u6c38\u4e45\u5220\u9664 <strong id="delete-name"></strong> \u7684\u6240\u6709\u540c\u6b65\u6570\u636e\uff08\u5ba2\u6237\u3001\u4ea4\u6613\u3001\u7edf\u8ba1\uff09\uff0c\u4e14\u4e0d\u53ef\u6062\u590d\u3002</p><div class="form-group"><label>\u8bf7\u8f93\u5165\u516c\u53f8 ID \u4ee5\u786e\u8ba4</label><input id="delete-confirm-id" placeholder="\u8f93\u5165\u8981\u5220\u9664\u7684\u516c\u53f8 ID"></div><div class="actions"><button class="btn btn-outline btn-sm" id="delete-cancel-btn">\u53d6\u6d88</button><button class="btn btn-danger btn-sm" id="delete-submit-btn">\u786e\u8ba4\u5220\u9664</button></div></div></div>',
    "/js/company-settings.js?v=20260924tgalert1"
  ),
  "/bank-settings.html": pageLayout(
    "\u652f\u4ed8\u8bbe\u7f6e",
    "bank-settings",
    `<div class="page-toolbar"><h1>\u652f\u4ed8\u8bbe\u7f6e</h1><a class="btn btn-outline btn-sm" href="/bank-ledger.html">\u8fd4\u56de\u5f53\u65e5\u6d41\u6c34</a></div>
<div class="settings-grid bank-settings-grid">
<section class="data-panel">
<h2>STATUS</h2>
<div class="settings-inline-form">
<div class="form-group"><label>Title</label><input id="status-title" placeholder="10. NEW STATUS"></div>
<div class="form-group"><label>Value</label><input id="status-value" placeholder="new status"></div>
<div class="form-group"><label>Label Color</label><input id="status-color" type="color" value="#64748b"></div>
<button type="button" class="btn btn-success btn-sm" id="status-add">\u6dfb\u52a0 STATUS</button>
</div>
<div class="table-wrap data-surface"><table class="bank-table m-cards m-status"><thead><tr><th>VALUE</th><th>TITLE</th><th>COLOR</th><th>PREVIEW</th><th></th></tr></thead><tbody id="status-rows"></tbody></table></div>
</section>
<section class="data-panel">
<h2>C STATUS</h2>
<div class="settings-inline-form">
<div class="form-group"><label>C STATUS</label><input id="cs-name" placeholder="\u5bf9\u65b9\u7b80\u79f0"></div>
<div class="form-group"><label>\u5173\u8054\u516c\u53f8</label><select id="cs-company"><option value="">-</option></select></div>
<button type="button" class="btn btn-success btn-sm" id="cs-add">\u6dfb\u52a0 C STATUS</button>
</div>
<div class="table-wrap data-surface"><table class="bank-table m-cards m-cstatus"><thead><tr><th>NAME</th><th>COMPANY</th><th>对平</th><th></th></tr></thead><tbody id="cstatus-rows"></tbody></table></div>
</section>
</div>`,
    "/js/bank-settings.js?v=20261001reconcile1"
  ),
  "/telegram-settings.html": pageLayout(
    "Telegram 设置",
    "telegram-settings",
    `<div class="page-toolbar"><h1>Telegram 设置</h1><a class="btn btn-outline btn-sm" href="/company-settings.html">公司 Bot 配置</a></div>
<div class="settings-grid">
<section class="data-panel">
<h2>总控 Bot</h2>
<p class="form-hint" id="tg-updated"></p>
<label class="form-check"><input type="checkbox" id="tg-enabled"><span>启用 Telegram（关掉后所有 Bot 停止，期间的报警会留在队列里等重新打开）</span></label>
<div class="form-group"><label>总控 Bot Token</label><input id="tg-token" type="password" autocomplete="off" placeholder="向 @BotFather 申请"><small class="form-hint">可查看全部公司。留空保存则保持不变。</small></div>
<div class="form-group"><label>白名单 chat</label><input id="tg-chats" autocomplete="off" placeholder="例如 555,-1001234567890"><small class="form-hint">只有这些 chat 能用 /balance、/today，其余一律静默。把 Bot 拉进群后发 /myid 即可获取，群 chat id 是负数。</small></div>
<label class="form-check"><input type="checkbox" id="tg-mirror"><span>各公司的报警同时抄送到总控 chat</span></label>
<p id="tg-err" class="form-error"></p>
<div class="actions">
<button type="button" class="btn btn-success btn-sm" id="tg-save">保存</button>
<button type="button" class="btn btn-outline btn-sm" id="tg-test">发送测试消息</button>
<button type="button" class="btn btn-danger btn-sm" id="tg-clear">清除 Token</button>
</div>
</section>
<section class="data-panel">
<h2>运行参数</h2>
<div class="form-group"><label>长轮询超时（秒）</label><input id="tg-poll" inputmode="numeric"><small class="form-hint">5–50。Bot 每次向 Telegram 要消息的等待时长。</small></div>
<div class="form-group"><label>发送检查间隔（秒）</label><input id="tg-flush" inputmode="numeric"><small class="form-hint">2–300。报警产生时会立即触发一次发送，这个只是兜底与重试。</small></div>
<div class="form-group"><label>配置刷新间隔（秒）</label><input id="tg-reconcile" inputmode="numeric"><small class="form-hint">10–600。保存后会立即生效，这个是兼顾直接改库的兼容兼顾。</small></div>
<p class="form-hint">填超出范围的值会被自动收到边界，不会保存失败。</p>
</section>
<section class="data-panel">
<h2>最近推送状态</h2>
<div class="table-wrap data-surface"><table class="bank-table"><thead><tr><th>状态</th><th>条数</th><th>说明</th></tr></thead><tbody id="tg-status-rows"></tbody></table></div>
<p class="form-hint" id="tg-last-failure"></p>
<h2 class="tg-subhead">Bot 运行情况</h2>
<div class="form-hint" id="tg-bot-health"></div>
<div class="actions"><button type="button" class="btn btn-outline btn-sm" id="tg-refresh">刷新</button></div>
</section>
</div>`,
    "/js/telegram-settings.js?v=20260924tgadmin2"
  ),
  "/bank-ledger.html": pageLayout(
    "\u5f53\u65e5\u6d41\u6c34",
    "bank-ledger",
    `<div class="sheet-app bkv2">
<div class="bk-toolbar">
<div class="bk-tools">
<input type="date" id="sheet-date" class="sheet-date">
<select id="sheet-bank-filter" class="sheet-filter sheet-bank-filter" aria-label="按渠道筛选流水"><option value="all">全部渠道</option></select>
<select id="sheet-status-filter" class="sheet-filter"><option value="">ALL</option></select>
<input type="text" id="sheet-search" class="sheet-search" placeholder="搜索 STATUS / TRANS ID / USERNAME / NAME">
</div>
<div class="bk-actions">
<details class="bk-more-menu">
<summary class="btn btn-outline btn-sm"><i data-lucide="ellipsis"></i>更多</summary>
<div class="bk-more-popover">
<button class="bk-more-item" id="sheet-deleted-btn" type="button"><i data-lucide="rotate-ccw"></i>最近删除</button>
<a class="bk-more-item" href="/bank-settings.html"><i data-lucide="sliders-horizontal"></i>\u652f\u4ed8\u8bbe\u7f6e</a>
</div>
</details>
</div>
</div>
<div class="bk-context-strip" role="status" aria-live="polite">
<div class="bk-context-item"><span>当前公司</span><strong id="bk-current-company">读取中…</strong></div>
<div class="bk-context-item"><span>流水日期</span><strong id="bk-current-date">-</strong></div>
<div class="bk-context-item bk-context-sync"><span>同步状态</span><strong id="bk-current-sync">读取中…</strong><small id="bk-current-sync-time"></small></div>
</div>
<div class="bk-kpis">
<div class="bk-kpi"><em>全部 BALANCE</em><strong id="sum-balance">0.00</strong></div>
<div class="bk-kpi bk-kpi-in"><em>入账 IN</em><strong id="sum-in">0.00</strong></div>
<div class="bk-kpi bk-kpi-out"><em>出账 OUT</em><strong id="sum-out">0.00</strong></div>
<div class="bk-kpi bk-kpi-help"><em>HELP TRF</em><strong id="sum-help">0.00</strong></div>
</div>
<div class="reconcile-alert" id="reconcile-alert" hidden role="status" aria-live="polite"></div>
<section class="bk-intake" id="bk-intake" aria-labelledby="bk-intake-title">
<div class="bk-intake-head">
<button type="button" class="bk-intake-toggle" id="bk-intake-toggle" aria-expanded="true" aria-controls="bk-intake-body"><i data-lucide="chevron-down"></i><span id="bk-intake-title">接单区</span></button>
<div class="bk-live" id="bk-live" hidden></div>
<div class="pending-tabs" role="tablist" aria-label="待审批类型"><button type="button" class="btn btn-outline btn-xs pending-tab active" data-tab="tx" role="tab" aria-selected="true" aria-controls="pending-tx-panel">平台订单</button><button type="button" class="btn btn-outline btn-xs pending-tab" data-tab="skipped" role="tab" aria-selected="false" tabindex="-1" aria-controls="pending-skipped-panel">已跳过</button></div>
<span class="bk-intake-empty" id="bk-intake-empty" hidden>✅ 暂无待审批</span>
<div class="bk-intake-actions"><button type="button" class="bk-pending-action bk-pending-transfer" id="sheet-transfer-btn"><i data-lucide="arrow-left-right"></i>调钱</button><button type="button" class="icon-btn bk-intake-close" id="bk-intake-close" aria-label="关闭接单区"><i data-lucide="x"></i></button></div>
</div>
<div class="bk-intake-body" id="bk-intake-body">
<div id="pending-tx-panel"><div class="pending-toolbar"><input type="search" id="pending-search" class="sheet-search" placeholder="搜索 TRANS ID / 用户 / 金额" aria-label="搜索平台单" autocomplete="off"><select id="pending-type" aria-label="平台单类型"><option value="">全部类型</option><option value="DEPOSIT">DEPOSIT</option><option value="WITHDRAW">WITHDRAW</option></select></div><div class="table-wrap data-surface"><table class="bank-table"><thead><tr><th>TYPE</th><th>DATE / TIME</th><th>TRANS ID</th><th>USER</th><th>AMT</th><th>MODE</th><th>BANK / C STATUS</th><th>REMARK</th><th></th></tr></thead><tbody id="pending-tx-rows"></tbody></table></div><div class="pending-more"><span id="pending-more-count" translate="no"></span><button type="button" class="btn btn-outline btn-xs" id="pending-more-btn" hidden>显示更多</button></div></div>
<div id="pending-skipped-panel" hidden><div class="table-wrap data-surface"><table class="bank-table"><thead><tr><th>TYPE</th><th>TIME</th><th>TRANS ID</th><th>USER</th><th>AMT</th><th>SKIPPED AT</th><th>BY</th><th></th></tr></thead><tbody id="pending-skipped-rows"></tbody></table></div></div>
</div>
</section>
<div class="bk-report-wrap collapsed" id="sheet-upper-wrap">
<button type="button" class="bk-collapse-btn" id="sheet-collapse-btn" aria-expanded="false">今日报表 ▸</button>
<div class="bk-report-grid" id="sheet-upper">
<section class="sheet-panel sheet-report-panel">
<h3 class="sheet-panel-title">REPORT</h3>
<table class="sheet-info-table sheet-report-table"><tbody id="sheet-report-rows"></tbody></table>
</section>
<section class="sheet-panel sheet-cstatus-panel">
<h3 class="sheet-panel-title">C STATUS <span class="sheet-panel-sub">Help In / Out</span>
</h3>
<table class="sheet-info-table cstatus-summary-table" aria-label="C STATUS Help In / Out"><colgroup><col class="cstatus-col-name"><col class="cstatus-col-num"><col class="cstatus-col-num"><col class="cstatus-col-num"></colgroup><thead><tr><th>NAME</th><th class="num-col">IN</th><th class="num-col">OUT</th><th class="num-col">Total</th></tr></thead>
<tbody id="sheet-cstatus-rows"></tbody></table>
</section>
</div>
</div>
<div class="bk-grid-head"><span class="bk-grid-title" id="bk-grid-title">流水 · ALL</span><button type="button" class="cstatus-drawer-btn" id="cstatus-drawer-btn" aria-haspopup="dialog" aria-controls="cstatus-drawer">C STATUS<b class="cstatus-drawer-badge" id="cstatus-drawer-badge" translate="no" hidden></b></button><span class="sheet-grid-hint">快捷键 · <kbd translate="no">Tab</kbd> 下一格 · <kbd translate="no">Enter</kbd>×2 保存 · <kbd translate="no">Esc</kbd> 取消 · <kbd translate="no">Ctrl+;</kbd> 当前时间 · <kbd translate="no">1</kbd>–<kbd translate="no">9</kbd> 状态</span></div>
<div class="sheet-table-wrap"><table class="sheet-table">
<thead><tr><th class="col-no">NO</th><th class="col-time">TIME</th><th class="col-id">TRANS ID</th><th class="col-status">STATUS</th><th class="col-num">IN</th><th class="col-num">OUT</th><th class="col-num">HELP TRF</th><th class="col-bank">BANK ACC</th><th class="col-user">USERNAME</th><th class="col-name">NAME</th><th class="col-cstatus">C STATUS</th><th class="col-other">OTHER</th><th class="col-remark">REMARK</th><th class="col-act"></th></tr></thead>
<tbody id="sheet-grid"></tbody>
<tfoot><tr class="sheet-total-row"><td colspan="4" class="total-label">TOTAL</td><td class="col-num" id="total-in">0.00</td><td class="col-num" id="total-out">0.00</td><td class="col-num" id="total-help-trf">0.00</td><td colspan="7"></td></tr></tfoot>
</table></div>
<datalist id="status-datalist"></datalist>
<datalist id="cstatus-datalist"></datalist>
</div>

<div class="modal-overlay" id="cstatus-drawer"><div class="modal cstatus-drawer">
<h2>C STATUS <span class="sheet-panel-sub">Help In / Out</span></h2>
<section class="sheet-panel sheet-cstatus-panel">
<table class="sheet-info-table cstatus-summary-table" aria-label="C STATUS Help In / Out"><colgroup><col class="cstatus-col-name"><col class="cstatus-col-num"><col class="cstatus-col-num"><col class="cstatus-col-num"></colgroup><thead><tr><th>NAME</th><th class="num-col">IN</th><th class="num-col">OUT</th><th class="num-col">Total</th></tr></thead>
<tbody id="cstatus-drawer-rows"></tbody></table>
</section>
</div></div>

<div class="modal-overlay" id="deleted-ledger-modal"><div class="modal modal-lg">
<h2>最近删除流水</h2>
<p class="modal-note">误删的流水会先进入这里，点恢复后会回到账单流水并自动重算余额。</p>
<div class="table-wrap data-surface"><table class="bank-table m-cards m-deleted"><thead><tr><th>删除时间</th><th>TIME</th><th>STATUS</th><th>TRANS ID</th><th>IN</th><th>OUT</th><th>HELP/TRF</th><th>BANK</th><th>USER / NAME</th><th></th></tr></thead><tbody id="deleted-ledger-rows"></tbody></table></div>
<div class="actions"><button class="btn btn-outline btn-sm" id="deleted-ledger-close">关闭</button></div>
</div></div>

<div class="modal-overlay" id="transfer-modal"><div class="modal transfer-modal">
<h2 id="trf-title">HELP TRF</h2>
<div class="form-group"><label>方向</label><div class="lf-dir-preview" id="trf-dir-preview" data-direction="empty" role="status" aria-live="polite"><strong id="trf-dir-state">输入金额</strong><span id="trf-dir-detail">正数 = IN · 负数 = OUT</span></div></div>
<div class="form-group"><label>TIME (24h)</label><input id="trf-time" type="time" step="60"></div>
<div class="form-group"><label for="trf-amount">金额</label><input id="trf-amount" inputmode="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="例如 100 或 -100" aria-describedby="trf-amount-hint"><small id="trf-amount-hint" class="form-hint">正数或不带符号 = IN，负数 = OUT</small></div>
<div class="form-group"><label for="trf-status">STATUS</label><select id="trf-status" disabled aria-describedby="trf-status-hint"><option value="">请先输入金额</option></select><small id="trf-status-hint" class="form-hint">根据金额正负显示可用状态</small></div>
<div class="form-group"><label>关联 BANK</label><select id="trf-bank"><option value="">— 不关联渠道 —</option></select></div>
<div class="form-group"><label>NAME</label><input id="trf-name" autocomplete="off"></div>
<div class="form-group"><label>C STATUS (可选)</label>
<input id="trf-cstatus" list="cstatus-datalist" data-cstatus-pick autocomplete="off" placeholder="使用已关联的 C STATUS"></div>
<p class="modal-note">提现代付双方分别录入：客户所在公司在「待处理」里对这张提现单选「调钱」（记 WITHDRAW，放 HELP TRF），协助公司在这里录 CASH OUT；例如 EZ 帮 RX 付，RX 审批选调钱、C STATUS 填 EZ68，EZ 在这里录 CASH OUT、C STATUS 填 RX66。</p>
<div class="form-group"><label>REMARK</label><input id="trf-remark"></div>
<p id="trf-err" class="form-error" role="alert" aria-live="polite"></p>
<div class="actions"><button class="btn btn-outline btn-sm" id="trf-cancel">取消</button><button class="btn btn-success btn-sm" id="trf-submit">保存</button></div>
</div></div>

<div class="modal-overlay" id="cstatus-modal"><div class="modal">
<h2>C STATUS 管理</h2>
<div class="form-group"><label>名称</label><input id="cs-new-name"></div>
<div class="form-group"><label>关联公司</label><select id="cs-new-company"><option value="">—</option></select></div>
<button type="button" class="btn btn-success btn-sm" id="cs-add-btn">添加</button>
<div class="table-wrap data-surface modal-table-gap"><table class="bank-table"><thead><tr><th>NAME</th><th>COMPANY</th><th>对平</th><th></th></tr></thead><tbody id="cs-rows"></tbody></table></div>
<div class="actions"><button class="btn btn-outline btn-sm" id="cs-close">关闭</button></div>
</div></div>

<div class="modal-overlay" id="reason-modal" role="dialog" aria-modal="true" aria-labelledby="reason-modal-title">
<div class="modal reason-modal">
<h2 id="reason-modal-title">填写操作原因</h2>
<p class="modal-note" id="reason-modal-description">此操作会写入永久审计记录。</p>
<div class="reason-target"><div id="reason-modal-target"></div><div class="reason-target-detail" id="reason-modal-detail" translate="no" hidden></div></div>
<div class="form-group"><label for="reason-modal-input">操作原因 <span aria-hidden="true">*</span></label><textarea id="reason-modal-input" rows="4" maxlength="500" placeholder="请说明为什么执行此操作" aria-describedby="reason-modal-count reason-modal-error"></textarea><small id="reason-modal-count" class="form-hint">0 / 500</small></div>
<p id="reason-modal-error" class="form-error" role="alert" aria-live="polite"></p>
<div class="actions"><button class="btn btn-outline btn-sm" id="reason-modal-cancel" type="button">取消</button><button class="btn btn-danger btn-sm" id="reason-modal-confirm" type="button">确认</button></div>
</div></div>`,
    ["/js/ledger-bank-pick.js?v=20261106drill3", "/js/operation-target.js?v=20261106drill1", "/js/render-gate.js?v=20261106drill1", "/js/pending-filter.js?v=20261106drill1", "/js/display-format.js?v=20261106drill2", "/js/cstatus-sheet.js?v=20261106sheet1", "/js/bank-common.js?v=20261109ledger1", "/js/bank-ledger.js?v=20261109mob1"]
  ),
  "/bank-channels.html": pageLayout(
    "\u652f\u4ed8\u6e20\u9053",
    "bank-channels",
    `<div class="channels-app" id="bank-channels-page">
<section class="ch-summary" aria-label="全部渠道">
<div class="ch-summary-copy"><span class="bk-summary-kicker">ALL CHANNELS</span><strong>全部渠道</strong><span>点击渠道行可筛选流水</span></div>
<div class="ch-summary-stat"><small>总余额</small><strong id="ch-total-balance" translate="no">0.00</strong></div>
<div class="ch-summary-stat"><small>人头</small><strong id="ch-count-nominee" translate="no">0</strong></div>
<div class="ch-summary-stat"><small>幽灵</small><strong id="ch-count-ghost" translate="no">0</strong></div>
<div class="ch-summary-stat" id="ch-count-pg-wrap" hidden><small>PG</small><strong id="ch-count-pg" translate="no">0</strong></div>
<button class="btn btn-success btn-sm" id="add-bank-btn" type="button"><i data-lucide="plus"></i>新渠道</button>
</section>
<div class="bkd-cleanup-bar" id="bkd-cleanup-bar" role="status" aria-live="polite"></div>
<div class="ch-toolbar">
<div class="bkd-tabs" id="bkd-tabs" role="tablist" aria-label="\u6e20\u9053\u72b6\u6001">
<button type="button" class="bkd-tab active" data-tab="operating" role="tab" aria-selected="true" aria-controls="bkd-panel">\u8fd0\u8425\u4e2d</button>
<button type="button" class="bkd-tab" data-tab="banned" role="tab" aria-selected="false" aria-controls="bkd-panel">\u5c01\u7981\u4e2d</button>
<button type="button" class="bkd-tab" data-tab="archived" role="tab" aria-selected="false" aria-controls="bkd-panel">\u5df2\u5f52\u6863</button>
</div>
<input type="search" id="bkd-search" class="sheet-search" autocomplete="off" placeholder="\u641c\u7d22\u94f6\u884c / \u6237\u540d / \u8d26\u53f7">
</div>
<div class="ch-month-bar" id="ch-month-bar" hidden><label class="ch-month-pick"><span>\u5c01\u7981\u6708\u4efd</span><select id="ch-month-select" aria-label="\u5c01\u7981\u6708\u4efd"></select></label><div class="ch-month-total" id="ch-month-total" role="status" aria-live="polite"></div></div>
<div class="bkd-panel ch-panel" id="bkd-panel" role="tabpanel"></div>
<div class="pager" id="bkd-pager" hidden></div>
<datalist id="cstatus-datalist"></datalist>
</div>

<div class="modal-overlay" id="bank-modal"><div class="modal bank-modal">
<h2 id="bank-modal-title">支付渠道</h2>
<div class="form-group"><label>TYPE</label>
<select id="f-kind"><option value="nominee">人头</option><option value="ghost">幽灵</option><option value="payment_gateway">PaymentGateway</option></select></div>
<div class="form-group ac-wrap"><label>BankBranch</label><input id="f-bankbranch" autocomplete="off"><ul class="ac-dropdown" id="ac-bankbranch"></ul></div>
<div class="form-group"><label>NAME</label><input id="f-name"></div>
<div class="form-group"><label>BSB</label><input id="f-bsb" maxlength="10"></div>
<div class="form-group"><label>ACCOUNT</label><input id="f-account"></div>
<div class="form-group"><label>PAYID</label><input id="f-payid"></div>
<div class="form-group"><label>REMARK</label><input id="f-note"></div>
<div class="form-group"><label>\u4f59\u989d\u4e0a\u9650\u62a5\u8b66</label><input id="f-alert-threshold" inputmode="decimal" autocomplete="off" placeholder="\u7559\u7a7a = \u4e0d\u542f\u7528"><small class="form-hint">\u4f59\u989d\u8fbe\u5230\u8be5\u91d1\u989d\u65f6\u63a8\u9001 Telegram\u3002\u8dcc\u56de\u9608\u503c\u4e0b\u4f1a\u81ea\u52a8\u590d\u4f4d\uff0c\u4e0b\u6b21\u518d\u8fbe\u5230\u4f1a\u91cd\u65b0\u63d0\u9192\u3002</small></div>
<label class="form-check"><input type="checkbox" id="f-reset-daily"><span>\u6bcf\u5929\u5f52\u96f6\u5206\u5f00\u7b97</span></label>
<p id="bank-modal-err" class="form-error"></p>
<div class="actions"><button class="btn btn-outline btn-sm" id="bank-cancel-btn">取消</button><button class="btn btn-success btn-sm" id="bank-save-btn">保存</button></div>
</div></div>

<div class="modal-overlay" id="drain-modal"><div class="modal drain-modal">
<h2>转出封禁户余额</h2>
<div class="reason-target"><div class="reason-target-detail" id="drain-target" translate="no"></div></div>
<div class="form-group"><label for="drain-mode">去向</label><select id="drain-mode"><option value="bank">本公司户口</option><option value="company">别家公司</option></select></div>
<div class="form-group" id="drain-bank-group"><label for="drain-bank">收款户口</label><select id="drain-bank"></select></div>
<div class="form-group" id="drain-cstatus-group" hidden><label for="drain-cstatus">C STATUS（对方公司）</label><input id="drain-cstatus" list="cstatus-datalist" data-cstatus-pick autocomplete="off"></div>
<div class="form-group"><label for="drain-amount">金额</label><input id="drain-amount" inputmode="decimal" autocomplete="off" aria-describedby="drain-amount-hint"><small class="form-hint" id="drain-amount-hint" translate="no"></small></div>
<div class="form-group"><label for="drain-remark">REMARK</label><input id="drain-remark" autocomplete="off"></div>
<p class="modal-note">本公司户口：记两笔，封禁户 BANK TRF 出、收款户 BANK TRANSFER 入，C STATUS 留空。别家公司：只记封禁户一笔 BANK TRF 出，C STATUS 填对方，对方自己记入账。户口保持封禁；钱拿回后户口还要用的，请用「解封」。</p>
<p id="drain-err" class="form-error" role="alert" aria-live="polite"></p>
<div class="actions"><button class="btn btn-outline btn-sm" id="drain-cancel" type="button">取消</button><button class="btn btn-success btn-sm" id="drain-submit" type="button">确认转出</button></div>
</div></div>`,
    ["/js/ledger-bank-pick.js?v=20261106drill3", "/js/operation-target.js?v=20261106drill1", "/js/render-gate.js?v=20261106drill1", "/js/display-format.js?v=20261106drill2", "/js/appeal-csv.js?v=20261106drill1", "/js/cstatus-sheet.js?v=20261106sheet1", "/js/bank-common.js?v=20261109ledger1", "/js/bank-channels.js?v=20261109ledger1"]
  ),
  "/audit-history.html": pageLayout(
    "\u64cd\u4f5c\u5386\u53f2",
    "audit-history",
    `<div class="audit-page">
<div class="page-toolbar audit-heading"><div><h1>操作历史</h1><p class="page-description">追踪资金操作人、字段变化，以及每笔平台交易与账单流水的完整关联。</p></div><div class="audit-immutability"><i data-lucide="shield-check"></i><span>只追加 · 不可修改</span></div></div>
<section class="data-panel audit-trace-panel" aria-labelledby="trace-title">
<div class="audit-panel-heading"><div><h2 id="trace-title">单笔交易追踪</h2><p>输入完整交易号或流水 ID，查看平台原单、关联流水和时间线。</p></div></div>
<form id="trace-form" class="audit-trace-form"><label class="sr-only" for="trace-query">交易号或流水 ID</label><input id="trace-query" autocomplete="off" placeholder="交易号 / 流水 ID"><select id="trace-type" aria-label="查询类型"><option value="transaction">交易号</option><option value="ledger">流水 ID</option></select><button class="btn btn-primary btn-sm" type="submit"><i data-lucide="search"></i>追踪</button></form>
<p id="trace-message" class="form-message" role="status" aria-live="polite"></p>
</section>
<section class="data-panel audit-list-panel" aria-labelledby="audit-list-title">
<div class="audit-panel-heading"><div><h2 id="audit-list-title">操作记录</h2><p id="audit-total">正在读取...</p></div><button class="btn btn-outline btn-sm" id="audit-refresh" type="button"><i data-lucide="refresh-cw"></i>刷新</button></div>
<form id="audit-filters" class="audit-filters">
<div class="form-group"><label for="audit-from">开始日期</label><input type="date" id="audit-from"></div>
<div class="form-group"><label for="audit-to">结束日期</label><input type="date" id="audit-to"></div>
<div class="form-group"><label for="audit-actor">操作者</label><select id="audit-actor"><option value="">全部操作者</option></select></div>
<div class="form-group"><label for="audit-action">动作</label><select id="audit-action"><option value="">全部动作</option></select></div>
<div class="form-group"><label for="audit-source">来源</label><select id="audit-source"><option value="">全部来源</option><option value="user">后台用户</option><option value="system">系统</option><option value="platform">平台</option><option value="backfill">旧记录回填</option></select></div>
<div class="form-group audit-keyword"><label for="audit-q">关键词</label><input id="audit-q" placeholder="交易号 / 流水 ID / 原因 / 操作者"></div>
<div class="audit-filter-actions"><button class="btn btn-primary btn-sm" type="submit">筛选</button><button class="btn btn-outline btn-sm" id="audit-reset" type="button">重置</button></div>
</form>
<div class="table-wrap data-surface audit-table-wrap"><table class="audit-table" data-m="title:3 meta:1,2"><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>关联对象</th><th>摘要</th><th>原因</th><th><span class="sr-only">详情</span></th></tr></thead><tbody id="audit-rows"></tbody></table></div>
<div class="pager audit-pager" id="audit-pager"></div>
</section>
</div>
<div class="audit-drawer-layer" id="audit-drawer-layer" hidden>
<button class="audit-drawer-backdrop" id="audit-drawer-backdrop" type="button" aria-label="关闭详情"></button>
<aside class="audit-drawer" id="audit-drawer" role="dialog" aria-modal="true" aria-labelledby="audit-drawer-title" tabindex="-1">
<header class="audit-drawer-header"><div><span class="audit-drawer-kicker" id="audit-drawer-kicker">操作详情</span><h2 id="audit-drawer-title">-</h2></div><button class="icon-btn" id="audit-drawer-close" type="button" aria-label="关闭详情"><i data-lucide="x"></i></button></header>
<div class="audit-drawer-body" id="audit-drawer-body"></div>
</aside>
</div>`,
    "/js/audit-history.js?v=20260817customerhistory1"
  ),
  "/admin-users.html": pageLayout(
    "\u8d26\u53f7\u7ba1\u7406",
    "admin",
    '<div class="page-toolbar"><h1>\u8d26\u53f7\u7ba1\u7406</h1><button class="btn btn-success btn-sm" id="create-btn">+ \u65b0\u5efa\u8d26\u53f7</button></div><p class="page-description">\u81ea\u5b9a\u4e49\u8d26\u53f7 ID\u3001\u5bc6\u7801\u548c\u89d2\u8272\uff08Admin / Operator\uff09\uff0c\u521b\u5efa\u540e\u590d\u5236\u53d1\u7ed9\u5bf9\u65b9</p><div class="table-wrap data-surface"><table class="m-cards m-users"><thead><tr><th>\u8d26\u53f7 ID</th><th>\u540d\u79f0</th><th>\u89d2\u8272</th><th>\u72b6\u6001</th><th>\u64cd\u4f5c</th></tr></thead><tbody id="rows"></tbody></table></div><div class="modal-overlay" id="create-modal"><div class="modal"><h2>\u65b0\u5efa\u8d26\u53f7</h2><div class="form-group"><label>\u8d26\u53f7 ID</label><input id="new-username"></div><div class="form-group"><label>\u663e\u793a\u540d\u79f0</label><input id="new-name"></div><div class="form-group"><label>\u5bc6\u7801</label><input id="new-password" type="password"></div><div class="actions"><button class="btn btn-outline btn-sm" id="cancel-btn">\u53d6\u6d88</button><button class="btn btn-success btn-sm" id="save-btn">\u521b\u5efa</button></div></div></div><div class="modal-overlay" id="share-modal"><div class="modal"><h2>\u53d1\u9001\u8d26\u53f7\u4fe1\u606f</h2><div class="copy-box" id="share-text"></div><div class="actions"><button class="btn btn-primary btn-sm" id="copy-btn">\u590d\u5236</button><button class="btn btn-outline btn-sm" id="close-share">\u5173\u95ed</button></div></div></div>',
    "/js/admin-users.js?v=20261105cols1"
  ),
  "/monthly-report.html": pageLayout(
    "月报",
    "monthly-report",
    `<div class="page-toolbar"><div><h1>月报</h1><p class="page-description">只算已审批的账单流水 · 合计行为每日相加</p></div><div id="mr-period" class="panel-note" translate="no"></div></div>
<div class="filters control-strip mr-controls">
<div class="segment-tabs mr-view-tabs" id="mr-view-tabs" role="group" aria-label="视图"><button type="button" class="seg-btn active" data-view="month">月</button><button type="button" class="seg-btn" data-view="year">年</button></div>
<button type="button" class="btn btn-outline btn-sm" id="mr-prev"></button>
<button type="button" class="btn btn-outline btn-sm" id="mr-next"></button>
<button type="button" class="btn btn-primary btn-sm" id="mr-current"></button>
<span class="mr-spacer"></span>
<button type="button" class="btn btn-outline btn-sm" id="mr-copy"><i data-lucide="copy"></i>复制表格</button>
<button type="button" class="btn btn-outline btn-sm" id="mr-csv"><i data-lucide="download"></i>下载 CSV</button>
</div>
<p class="panel-note page-hint" id="mr-hint" hidden>点击月份查看当月每日明细</p>
<div class="table-wrap data-surface"><table class="monthly-table" id="mr-table" data-m="title:1 metric:2,4 native:tr[data-month]"><thead><tr><th id="mr-first-col">日期</th><th>DEP</th><th>WD</th><th>WIN/LOSE</th><th>WIN RATE</th><th>UNCLAIM</th><th>WRONG</th><th>EXPENSES</th><th>DEP单</th><th>WD单</th><th>总单</th><th>UNIQUE CUST</th></tr></thead><tbody id="mr-rows"></tbody><tfoot id="mr-total"></tfoot></table></div>`,
    "/js/monthly-report.js?v=20261104expenses1"
  ),
  "/company-expenses.html": pageLayout(
    "COMPANY EXPENSES",
    "company-expenses",
    `<div class="page-toolbar"><div><h1>COMPANY EXPENSES</h1><p class="page-description">本公司与各 C STATUS 往来方的每日净额 · 合计行为每日相加</p><p class="page-description ce-legend">正数 = 我方欠对方，负数 = 对方欠我方</p></div><div id="ce-period" class="panel-note" translate="no"></div></div>
<div class="filters control-strip mr-controls">
<div class="segment-tabs mr-view-tabs" id="ce-view-tabs" role="group" aria-label="视图"><button type="button" class="seg-btn active" data-view="month">月</button><button type="button" class="seg-btn" data-view="year">年</button></div>
<button type="button" class="btn btn-outline btn-sm" id="ce-prev"></button>
<button type="button" class="btn btn-outline btn-sm" id="ce-next"></button>
<button type="button" class="btn btn-primary btn-sm" id="ce-current"></button>
<span class="mr-spacer"></span>
<button type="button" class="btn btn-outline btn-sm" id="ce-copy"><i data-lucide="copy"></i>复制表格</button>
<button type="button" class="btn btn-outline btn-sm" id="ce-csv"><i data-lucide="download"></i>下载 CSV</button>
</div>
<p class="panel-note page-hint" id="ce-hint" hidden>点击月份查看当月每日明细</p>
<div class="table-wrap data-surface"><table class="monthly-table" id="ce-table" data-m="title:1 metric:2,3,4,5,6,7 native:tr[data-month]"><thead id="ce-head"></thead><tbody id="ce-rows"></tbody><tfoot id="ce-total"></tfoot></table></div>`,
    "/js/company-expenses.js?v=20261104expenses2"
  ),
  "/top-referral.html": pageLayout(
    "TOP REFERRAL",
    "top-referral",
    `<div class="page-toolbar"><div><h1>TOP REFERRAL</h1><p class="page-description">平台同步数据 · 按推荐人汇总下线 · 点一行看详情</p></div><div id="tr-period" class="panel-note" translate="no"></div></div>
<div class="filters control-strip mr-controls">
<div class="segment-tabs mr-view-tabs" id="tr-view-tabs" role="group" aria-label="视图"><button type="button" class="seg-btn active" data-view="month">月</button><button type="button" class="seg-btn" data-view="year">年</button></div>
<button type="button" class="btn btn-outline btn-sm" id="tr-prev"></button>
<button type="button" class="btn btn-outline btn-sm" id="tr-next"></button>
<button type="button" class="btn btn-primary btn-sm" id="tr-current"></button>
<label class="tr-field" for="tr-sort"><span>排序</span><select id="tr-sort"><option value="newMember">NEW MEMBER</option><option value="firstDep">首充人数</option><option value="dep">TOTAL DEPOSIT</option><option value="net">TOTAL NET</option></select></label>
<input type="search" id="tr-search" class="tr-search" list="tr-referrers" placeholder="搜索推荐人" aria-label="搜索推荐人" autocomplete="off"><datalist id="tr-referrers" translate="no"></datalist>
<span class="mr-spacer"></span>
<button type="button" class="btn btn-outline btn-sm" id="tr-copy"><i data-lucide="copy"></i>复制表格</button>
<button type="button" class="btn btn-outline btn-sm" id="tr-csv"><i data-lucide="download"></i>下载 CSV</button>
</div>
<div class="table-wrap data-surface"><table class="monthly-table sticky-2" id="tr-table" data-m="lead:1 title:2 metric:3,5 native:tr[data-referrer]"><thead><tr><th>#</th><th>推荐人</th><th>NEW MEMBER</th><th>首充人数</th><th>TOTAL DEPOSIT</th><th>TOTAL NET</th></tr></thead><tbody id="tr-rows"></tbody><tfoot id="tr-total"></tfoot></table></div>
<div class="pager" id="tr-pager"></div>
<div id="tr-drawer-backdrop" class="customer-drawer-backdrop tr-drawer-backdrop" aria-hidden="true">
<div id="tr-drawer" class="customer-drawer tr-drawer" role="dialog" aria-modal="true" aria-labelledby="tr-drawer-title" tabindex="-1">
<div class="customer-drawer-head"><div><h2 id="tr-drawer-title">推荐人</h2><p id="tr-drawer-sub" class="cd-sub" translate="no"></p></div><button type="button" class="cd-close icon-btn" id="tr-drawer-close" aria-label="关闭">&times;</button></div>
<div class="customer-drawer-body" id="tr-drawer-body"></div>
</div>
</div>`,
    "/js/top-referral.js?v=20261109mtd1"
  ),
};
pageRoutes["/index.html"] = pageRoutes["/"];

const desktopSidebarToggleHtml = '<button type="button" class="sidebar-collapse-btn icon-btn" id="sidebar-collapse-btn" aria-label="展开导航" aria-controls="sidebar" aria-expanded="false" title="展开导航"><i data-lucide="chevron-right"></i><span class="icon-fallback" aria-hidden="true">›</span></button>';
const companyCompactEntryHtml = '<button type="button" class="company-compact-btn icon-btn" id="company-compact-btn" aria-label="切换公司" title="切换公司"><i data-lucide="building-2"></i><span class="icon-fallback" aria-hidden="true">公司</span></button>';
const globalFeedbackHtml = '<div class="app-toast-stack" id="app-toast-stack" aria-live="polite" aria-relevant="additions"></div><div class="modal-overlay app-dialog-overlay" id="app-dialog-overlay" aria-hidden="true"><div class="modal app-dialog" data-tone="info"><h2 id="app-dialog-title">确认操作</h2><p class="app-dialog-message" id="app-dialog-message"></p><div class="app-dialog-prompt" id="app-dialog-prompt" hidden><label for="app-dialog-input" id="app-dialog-label">请输入</label><input id="app-dialog-input" autocomplete="off"><small class="form-hint" id="app-dialog-hint"></small></div><p class="form-error" id="app-dialog-error" role="alert" aria-live="polite"></p><div class="actions"><button class="btn btn-outline btn-sm" id="app-dialog-cancel" type="button" data-modal-dismiss>取消</button><button class="btn btn-primary btn-sm" id="app-dialog-confirm" type="button">确认</button></div></div></div>';
// i18n.js holds the dictionary + translation engine. It is injected into <head> (ahead of the
// render-blocking stylesheet) so the first paint is already in the saved language, instead of
// painting Chinese and rewriting it after the two vendored scripts at the end of <body> load.
const i18nHeadHtml = '<script src="/js/i18n.js?v=20261109mob1"></script>';
// One full translation pass at the end of <body>, where the whole document
// exists but the two vendored scripts below have not been fetched yet. Anything
// painted while they load is already in the right language. Must come after
// globalFeedbackHtml so the dialog skeleton is translated too.
const i18nBootHtml = '<script src="/js/i18n-boot.js"></script>';

for (const route of Object.keys(pageRoutes)) {
  pageRoutes[route] = pageRoutes[route]
    .replace('<div class="layout">', desktopSidebarToggleHtml + '<div class="layout">')
    .replace('<link rel="stylesheet" href="/css/style.css?v=20260812transferfix1">', i18nHeadHtml + '<link rel="stylesheet" href="/css/style.css?v=20260812transferfix1">')
    .replace('<div class="company-bar glass-control" id="company-bar">', '<div class="company-bar glass-control" id="company-bar">' + companyCompactEntryHtml)
    .replace('<script src="/vendor/lucide-1.65.0.min.js"></script>', globalFeedbackHtml + i18nBootHtml + '<script src="/vendor/lucide-1.65.0.min.js"></script>')
    .replace('/css/style.css?v=20260812transferfix1', '/css/style.css?v=20261109mtd3')
    .replace('/js/customer-detail.js?v=20260731bankfix4', '/js/customer-detail.js?v=20261109mtd1')
    .replace('/css/style.css?v=20260802topbarflow1', '/css/style.css?v=20261001archive1')
    .replace('/js/app.js?v=20260802platformsound3', '/js/app.js?v=20261109mob1');
}

function requireAdminPage(req, res, next) {
  return requireLogin(req, res, function () {
    if (req.session.user.role !== "admin") return res.redirect("/bank-ledger.html");
    next();
  });
}

// operator 只能进银行这两页（支付设置在 ADMIN_ONLY_PAGES）。app.js 的 loadUser 有同一份名单。
const OPERATOR_PAGES = new Set(["/bank-ledger.html", "/bank-channels.html"]);

function requirePageAccess(req, res, next) {
  return requireLogin(req, res, function () {
    if (req.session.user.role === "operator" && !OPERATOR_PAGES.has(req.path)) {
      return res.redirect("/bank-ledger.html");
    }
    next();
  });
}

// 仅 admin 可访问的页面。新增设置类页面必须加进来，否则 operator 直接能打开。
const ADMIN_ONLY_PAGES = new Set([
  "/admin-users.html",
  "/company-settings.html",
  "/bank-settings.html",
  "/telegram-settings.html",
  "/audit-history.html",
  "/monthly-report.html",
  "/company-expenses.html",
  "/top-referral.html",
]);

for (const [route, html] of Object.entries(pageRoutes)) {
  const guard = ADMIN_ONLY_PAGES.has(route) ? requireAdminPage : requirePageAccess;
  app.get(route, guard, (_req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.type("html").send(html);
  });
}

app.get("/deposits.html", requirePageAccess, (_req, res) => res.redirect("/transactions.html"));
app.get("/withdrawals.html", requirePageAccess, (_req, res) => res.redirect("/transactions.html"));
// 2026-11 拆页：旧地址（书签、手机底栏的老链接）一律到当日流水。302 而不是 301——301 会被
// 浏览器永久缓存。浏览器跳转时自己保留 #hash；#channels 由 bank-ledger.js 再转去支付渠道页。
app.get("/bank-accounts.html", (req, res) => {
  const q = req.originalUrl.indexOf("?");
  res.redirect(302, "/bank-ledger.html" + (q >= 0 ? req.originalUrl.slice(q) : ""));
});

app.use(express.static(publicDir));

app.get("/login.html", (_req, res) => {
  res.sendFile(path.join(publicDir, "login.html"));
});

// 未知 /api 路径必须返回 JSON。否则它会穿过上面的 express.static 落到
// Express 默认 404（HTML），而前端 api() 的 res.json() 解析失败后
// 只会显示一句笼统的"请求失败"，掩盖真正的路径错误。
// 位置要求：在所有 /api 路由注册之后、error handler 之前。
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "接口不存在" });
});

// 全局错误处理器。必须是最后一个 app.use，且必须恰好 4 个形参
// （少一个 Express 会把它当普通中间件）。
//
// 没有它的话，Express 4 的默认 handler 在 NODE_ENV 不是 production 时
// 会把完整堆栈（绝对路径、SQL 片段、依赖版本）写进 HTTP 响应体。
app.use((err, req, res, next) => {
  const status = Number(err && err.status) || 500;
  console.error("[error]", req.method, req.originalUrl, status, err && (err.stack || err.message));
  if (res.headersSent) return next(err);
  if (req.path.startsWith("/api/")) {
    return res.status(status).json({
      // 只有 4xx 才回显 message；5xx 一律笼统，避免泄露 SQL / 路径 / 结构
      error: status < 500 ? String((err && err.message) || "请求失败") : "服务器内部错误",
    });
  }
  res.status(status).type("html").send("服务暂时不可用，请稍后重试");
});

// Express 4 不捕获 async handler 里 rejected 的 promise，而 Node 22 默认
// --unhandled-rejections=throw 会直接杀掉进程 —— 那会让四家公司的同步循环
// 一起中断。宁可带伤运行并在 journald 留下证据。
// 注意：故意不处理 uncaughtException —— 那种状态下进程语义已不可信，
// 让它退出由 systemd 重启更安全。
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason && (reason.stack || reason));
});

const port = cfg.port || 3000;
// 绑 127.0.0.1：生产用 Cloudflare 隧道入站，不绑的话 VPS 公网 IP:3000
// 可被直接访问，完全绕过隧道与 Cloudflare Access。
// 留 cfg.host 兜底供本机开发（可填 0.0.0.0），生产 config 不写该字段。
const host = cfg.host || "127.0.0.1";
app.listen(port, host, () => {
  console.log("[trader-dashboard] http://" + host + ":" + port);
  console.log("[trader-dashboard] config:", configPath());
  console.log("[trader-dashboard] db:", dbPath());
  console.log("[trader-dashboard] admin login:", cfg.admin.username);
  if (cfg.demoTenant) console.log("[trader-dashboard] demo tenant company id: demo");
});
