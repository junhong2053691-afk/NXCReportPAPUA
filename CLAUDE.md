# CLAUDE.md — NXC Report (trader-dashboard)

> 产品名 2026-11 起改为 **NXC Report**（原「操盘手后台」）。目录、`package.json`、`deploy/*.service`、
> 日志前缀 `[trader-dashboard]` 等内部标识刻意保留旧名。图标资源在 `public/brand/` 与
> `public/favicon.ico`，设计原图存档在 `design-system/brand/`。

本文件供 AI 助手（Claude / Cursor）快速理解项目上下文与开发约束。

## 项目概述

多公司操盘后台：从外部平台 API 同步充值/提现/客户数据，提供实时看板、报表、客户分群，以及支付渠道与账单流水管理。

- **路径**: `C:\Users\junho\trader-dashboard`
- **默认端口**: `3000`
- **时区**: `Australia/Sydney`（`config.json` → `timezone`）
- **数据库**: SQLite `server/db/trader.db`（`better-sqlite3`）
- **默认管理员**: `config.json` → `admin`（勿提交真实 token 到 git）

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Node.js ≥20、Express、express-session |
| 数据库 | SQLite + `server/db/init.js` 迁移 |
| 前端 | 原生 HTML/CSS/JS（无框架），页面 HTML 在 `server/index.js` 的 `pageLayout` 内联生成 |
| 同步 | `server/services/sync.js` + `server/services/platform.js` |
| 调度 | `server/scheduler.js`（每公司独立 fast/slow 循环） |

## 目录结构

```
trader-dashboard/
├── config.json              # 全局配置 + 默认公司 API（可被 companies 表覆盖）
├── server/
│   ├── index.js             # Express 入口、路由注册、页面 HTML
│   ├── middleware.js        # requireLogin / resolveCompany / requireAdmin
│   ├── scheduler.js         # 后台同步调度
│   ├── db/
│   │   ├── init.js          # DB 连接、迁移、索引
│   │   └── schema.sql       # 表结构参考（新库初始化）
│   ├── routes/
│   │   ├── auth.js
│   │   ├── data.js          # 看板/客户/交易等数据 API
│   │   ├── companies.js
│   │   ├── banks.js         # 支付渠道 + 账单流水
│   │   └── admin.js
│   ├── services/
│   │   ├── sync.js          # 核心同步逻辑（勿随意改分页/去重）
│   │   ├── platform.js      # 外部 API 调用、ACCESS_DENIED 处理
│   │   └── stats.js
│   └── lib/                 # 业务工具（分群、报表、完整性检查等）
├── public/
│   ├── css/style.css
│   └── js/
│       ├── app.js           # 全局 api()、公司切换、进度条
│       └── *.js             # 各页面脚本
└── sync-state-*.json        # 每公司同步状态（运行时生成）
```

## 启动与运维

```powershell
cd C:\Users\junho\trader-dashboard
npm install
npm start                    # 或 node server/index.js
```

### Cloudflare 临时公网（Quick Tunnel）

```powershell
# 先确保 localhost:3000 在跑
$env:TUNNEL_EDGE_IP_VERSION="4"
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000 --edge-ip-version 4
```

- Quick Tunnel URL **每次重启会变**，关掉进程即失效
- VPN（如 Surfshark）易导致隧道不稳定；`DNS local resolver` 报错通常可忽略，看 connectivity pre-check 是否 PASS
- 固定域名需 `cloudflared tunnel login` + 命名隧道，脚本参考 `C:\Users\junho\marketing-bot\setup-cloudflare-tunnel.ps1`

### Windows 注意

- PowerShell **不要用** `&&` 链接命令，用 `;`
- `node --check file.js` 做语法检查
- 部分 JS/CSS 曾被存成 UTF-16；`server/index.js` 启动时会 `ensurePublicUtf8` 自动修复
- ⚠️ 重启服务**不要用** CLAUDE.md 旧写法 `Get-Process node | Stop-Process` —— 那会连带杀掉
  正在跑的编辑器 / Claude Code 会话。按端口精确定位：
  `Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`

### 运维脚本

| 脚本 | 用途 |
|---|---|
| `scripts/check-api-access.js` | 改完盘方 IP 白名单后逐公司自检，**退出码 0 才允许启动服务** |
| `scripts/vacuumSnapshot.js` | `VACUUM INTO` 打一致快照。库是 WAL，**别直接拷 `.db`**（会丢未 checkpoint 的 WAL） |
| `scripts/skipAllPending.js` | 批量清空 `bank_tx_pending` 积压。默认 dry-run，`--yes` 才写 |
| `scripts/preview-telegram.js` | 把 `/balance` `/blocked` `/today` 各分支渲一遍并打印每行显示宽度，肉眼查排版。只读内存库 |
| `scripts/reset-ledger-for-cutover.js` | 上线切换一次性：清 `bank_ledger`+回收站、待审批标 `expired`（**不删**，否则同步会重新入队）、余额归零。保留 `bank_balance_log`。默认 dry-run，`--yes` 才写；先停服、先 `vacuumSnapshot` |
| `scripts/set-password.js` | 直接改库里的账号密码，密码只从 stdin 读。**搬库后改 `config.json` 不生效**，这是唯一入口 |

`skipAllPending.js` 有三条不可回避的前提，详见其文件头注释：**skip 掉的钱永远不进账本**；
**过了本地午夜就转成 `expired` 且无法恢复**（`expireSkippedPendingTx` 按跳过日 `decided_at`
判定，不是平台单日期——按 `tx_time` 判会让往日的单一跳过就几秒内定型，演练里 4 家都这样丢过单）；
**跑之前必须先 `vacuumSnapshot`**，那是唯一退路。
它复用 `skipPendingTx` 逐笔调用以保留审计，**绝不在外层包 `runAtomic`**（会嵌套回滚，见下文）。

备份落在 `server/db/backup-<时间戳>/`，已被 `.gitignore` 挡住 —— 那里面是含 23 万客户
姓名手机号的完整库，**任何情况下都不能进 git**。

## 核心架构

### 多公司

- `companies` 表存各公司 API 凭证；侧边栏 `#company-select` 切换
- `resolveCompany` 中间件设置 **`req.companyId`**（不是 `req.session.activeCompanyId`）
- `customers` / `transactions` / `bank_*` 均按 `company_id` 隔离
- 路由写公司相关逻辑时**必须用 `req.companyId`**

### 同步（最高优先级：数据准确）

- **Fast lane**（约 6s）：今日 DEPOSIT/WITHDRAW + stats
- **Slow lane**（约 60s）：用户全量/尾部页、完整性校验、修剪
- 每家公司**独立并行**循环，一家公司失败不阻塞其他家
- `platform.js` 检测 `Invalid Access!` → `ACCESS_DENIED`，fail-fast，不污染数据
- `syncIntegrity.js` 做 API vs DB 对账
- 新 DEPOSIT/WITHDRAW 只进**待审批队列** `bank_tx_pending`（`bankApply.js` 的 `enqueuePendingTx`），
  用 `bank_balance_log` 按 `tx_id` 查重。**同步本身不碰余额**——必须有人在后台点「审批」，
  `approvePendingTx` 才会写 `bank_ledger` 并刷新余额
- ⚠️ `sync.js` 的 `applyDepositsToBank`（自动入账）是**死代码，无任何调用**，别照它推断行为

**修改同步逻辑前必须考虑**：分页完整性、去重、公司隔离、重启后 fast-recovery。

### 安全边界（上线前审计留下的约束）

- **CSP 是 `script-src 'self'`**（`lib/securityHeaders.js`）。内联 `<script>`、`on*` 属性、CDN 脚本
  都会被浏览器静默拦下。新脚本放 `public/js/`，第三方库锁版本放 `public/vendor/`。
- **`sessionGuard`（`middleware.js`）每个请求按库复核账号**，所以停用、删除、改密立即生效；
  session 里只存 `password_hash` 的派生标签。写登录逻辑要走 `establishSession`。
- **`/api/banks` 的公司只认 `req.companyId`，不能回退 session**，否则被撤销授权的 operator 还能读写。
- **流水 `status` 校验格式而不是名单**（`isValidStatusValue`），状态可由公司自定义，但它会变成
  前端 CSS 类名。`statusClass` 再过滤一次，挡住库里已有的值。
- **改 `api_url` 必须同时给新 token**（`lib/apiUrlPolicy.js`）。库里的 token 只存不显示，
  但会被发往这个地址：放开它就等于能把 token 发到任意服务器。
- **`NODE_ENV=production` 下，默认密码或弱 `sessionSecret` 拒绝启动**（`lib/startupGuards.js`）。
- **登录旋转验证码（`lib/captcha.js`）的角度只存在服务端**：图用 `@resvg/resvg-wasm` 栅格化成 PNG 再发，
  别改成直接发 SVG 或在前端旋转初始角度——答案会出现在 DOM 里。题目一次性（对错都作废），
  校验在 `limiter.attempt` 之前，过不了验证的请求不占账号的失败额度。
- **`pruneStaleCustomers` 有熔断**：待删超过 `max(50, 5%)` 一个都不删，日志打 `PRUNE BLOCKED`。

### 前端约定

- **改了 `public/js/*.js` / `style.css` 必须同时换 `server/index.js` 里那个文件的 `?v=` 版本号**。线上在 Cloudflare 后面，
  地址不变就会继续拿到旧文件——2026-11-09「只勾 1 户就预选」第一次上线就是漏了这一步，员工那边完全没变化
- 全局 `api(url, opts)` 在 `public/js/app.js`，**只接受 2 个参数** `(url, opts)`；后台轮询用 `{ bg: true }`
- Modal 显示用 `classList.add("show")`，不是 `open`
- 页面 HTML 大量在 `server/index.js` 字符串拼接（Unicode `\uXXXX`），改 UI 时注意编码
- 暗色模式：`data-theme="dark"` on `:root`
- 声音报警一律走 `public/js/alarm.js`，不要自己 `new Audio()`（见下）
- **手机宽表 = 卡片 + 底部抽屉**（`public/js/mobile-table-drawer.js`，≤700）：报表页 13 张表的 `<table>` 上写
  `data-m="lead:1 title:2 metric:6,14 meta:3 native:tr[data-month]"`（列号按表头列算，从 1 起）。脚本只给 td 加
  `data-m` 等属性、跟着重渲染补，页面脚本不用改。新加的宽报表照这个挂；**行本身有点击动作的表必须写 `native`**，
  否则手机上点行会弹通用抽屉而不是原动作。测试 `server/tests/mobile-table-drawer.test.js` 数着 `data-m` 的张数。
  抽屉里现拼的表（顾客详情「最近交易」、TOP REFERRAL 推荐人抽屉的下线表）在 JS 字符串里写 `data-m` 也生效，
  脚本靠 body 上的 observer 发现新插入的表；底部抽屉的层级在这两个抽屉之上

### 声音报警 (`public/js/alarm.js`)

全站唯一的报警状态机，由 `server/index.js` 在 `app.js` **之前**注入。两个用户：
`app.js` 的平台待审批、`bank-ledger.js` 的 C STATUS 未对平。

**铁律：永不 `loop`。** 这个模块存在的理由就是替掉「一出问题立刻响、且响到你点掉为止」。
分级是：问题出现后静默 `FIRST_DELAY_MS`（5 分钟，只有视觉提示）→ 响**一遍** →
之后每 `REPEAT_MS`（10 分钟）响一遍 → 手动 ack 后静默 `SNOOZE_MS`（20 分钟）。
阈值只有 `alarm.js` 顶部那一份，改它就是改两套报警。

- **状态必须持久化到 localStorage**（`{ sig, firstSeenAt, quietUntil, firedAt, acked }`，每 scope 一个键）。
  旧实现把 ack 存在内存里，于是**刷新页面就重新开响**——那是「吵」的主要来源，别改回去。
- **`scope` 用函数传**（`() => activeCompanyId` / `reconcileScope`），公司与日期各自独立计时。
- **自带 15s tick**，不依赖调用方的渲染频率：`renderReconcileAlertV2` 只挂在 5 分钟一轮的
  `loadDailyReport` 上，靠它驱动升级会差出好几分钟。
- **signature 决定「是不是同一个问题」**。待审批故意**不把笔数写进 signature**：清掉 2 笔还剩 1 笔
  不该重置静默期，而 0→1 该重置。未对平则用 `reconcileSignature()`（含差额），差额一变就是新问题。
- `onStageChange` 回调会重入调用方的渲染函数（`bank-ledger.js` 有 `reconcileRendering` 守门），
  加新用户时注意别写成无限递归。
- **第三个用户：跨公司来单提醒**（`public/js/cross-company-alerts.js`，在 `app.js` 之后注入）。
  operator 停在 A 时给每家别家建一个报警，**与 `app.js` 当前公司报警共用 key `bank-pending-alarm:<公司>`**，
  切公司就是交接，静默期不重置。交出去的那家只 `dispose`，**绝不 `update("")`**（会 `clearState` 清掉共用 key）。
  数据源 `GET /api/banks/pending-tx/all-companies`（`lib/crossCompanyPending.js`）是 `/api/banks` 里**唯一跨公司读**
  的端点：公司范围每次按 `user_companies` 复核，admin / 只授权一家返回 `enabled=false`，不带客户真名。
  产品规则（一笔一条、5 条上限、已看过按 id 记）见 `CONTEXT.md`「跨公司来单提醒」。
- 测试 `server/tests/alarm.test.js`：注入假 `now` 与假播放器，**「静默期内一次都不播」和
  「重建实例不重响」两条断言是守着上面两段的**，别为了让新行为通过就删。

### 中英切换 (`public/js/i18n.js`)

字典 + 翻译引擎独立成 `i18n.js`，由 `server/index.js` 的替换循环注入 `<head>`（样式表之前），
并在 `</body>` 前插一句 `window.dashI18nApply()` 做一次全量翻译——**在两个 CDN 脚本之前**，
所以首屏绘制出来就是目标语言。`app.js` 的 `setupLanguage()` 只负责绑按钮和起 observer。

**引擎的三条铁律：**

1. **永远从中文原文翻译**。每个文本节点的源文和「我们写出去的值」存在 `WeakMap` 里；
   当前值 ≠ 写出去的值，说明页面脚本重渲染过，当前值就是新原文。
   由此 zh→en→zh 无漂移、重复执行是 no-op、**不需要 `disconnect()` observer**
   （自己的写入靠 `out` 比对识破，页面脚本的变动一条不漏）。
2. **没有子串替换**。查不到的字符串**原样返回**——这是租户数据的护栏。
   历史上的 `i18nReplaceParts` 会把 `Public Bank Amy` 在中文模式下改成 `Public 银行 Amy`。
3. **数据一律 `translate="no"`**。`bank_ledger` 的 remark/name/c_status、
   `bank_status_options.label`、`bank_c_status_options.name`、客户姓名手机、审计 summary/reason
   全部标记；`walk()` 遇到就整棵子树剪掉。标准 HTML 属性，**顺带挡住浏览器自带的自动翻译**。

**改动前必看：**

- `I18N_ATTRS` **永远不要加 `value`**——`readRow`/`parseStatus` 会把显示文本反解析成
  `bank_ledger.status` 再进 `refreshBankBalance`。`i18n.test.js` 有断言守着。
- 文案插了变量（`共 ${n} 笔`）时整个文本节点不是字典 key，要加 `I18N_PHRASES` 规则。
  **反向（en→zh）规则必须锚定数字或中文**，`/^Total (.+)$/` 这种会命中真实数据。
- 枚举映射表（`TYPE_LABELS`/`SEGMENT_LABELS` 等）走字典，不改成 `dashT()` 调用——
  字典由引擎自动重译，`dashT()` 是渲染时快照，切换语言后会留在旧语言。
- Intl 产出的文字（`toLocaleDateString` 的星期）引擎翻不了，需要监听 `language-changed`
  重渲染（见 `home.js` 的 `lastWeekRows`）。`todaySydney()` / `sydneyDateKey()` 的 `en-CA`
  是 ISO 日期键**不是语言**，改了所有日期筛选都会坏。
- 语言偏好只存 `localStorage["dash-lang"]` + 内存缓存，不跟账号走、不入库。

测试：`server/tests/i18n.test.js`（护栏）、`i18n-coverage.test.js`（漏翻棘轮，
`KNOWN_FRAGMENTS` 只许降不许升）。

## 主要页面

| 路由 | 脚本 | 说明 |
|---|---|---|
| `/` | `home.js` | 首页看板 |
| `/transactions.html` | `transactions.js` | 实时交易 |
| `/customers.html` | `customers.js` | 客户列表 + 分群 |
| `/bank-ledger.html` | `bank-ledger.js` | 当日流水：运营中银行列表（点行筛流水、逐行勾实时收款）+ KPI + 接单区（平台单审批 / 已跳过）+ 调钱 + 今日报表 / C STATUS + 流水表格 |
| `/bank-channels.html` | `bank-channels.js` | 支付渠道：全部渠道汇总 + 运营中 / 封禁中 / 已归档 + 渠道编辑 / 转出余额 |
| `/company-settings.html` | `company-settings.js` | 公司/API + 各公司 Telegram Bot（admin） |
| `/telegram-settings.html` | `telegram-settings.js` | 总控 Bot、总开关、运行参数、推送状态（admin） |

> 2026-11 拆页：原 `/bank-accounts.html`（`bank-accounts.js`）拆成侧边栏「流水记录」分组下的当日流水与支付渠道，旧地址 302 到当日流水（`#channels` 再转去支付渠道）。两页共用的格式化、STATUS 词表与余额口径在 `bank-common.js`。operator 只能进这两页（`server/index.js` 的 `OPERATOR_PAGES` 与 `app.js` 的 `loadUser` 是同一份名单）。接单区常驻当日流水页：后台刷新只做增量，员工动过的行（`data-dirty`）绝不重画，被别人处理掉的只标灰；刷新时切页签必须带 `{ silent: true }`，否则会把平台待审批报警顺手 ack 掉。

> 2026-11-09 当日流水重排：顶上是**运营中银行列表**（`renderBankList`，点行与工具栏 `#sheet-bank-filter` 是同一个筛选
> `selectBankFilter`），下面才是 4 个 KPI；「当前公司 / 流水日期 / 同步状态」那一行删了。银行列表**可以折叠**（头部常驻，
> 收起时列出实时收款户名，`localStorage["bk-banklist-collapsed"]`，没存过时电脑展开、手机收起）。**接单区、今日报表与支付渠道每行详情都不再折叠**。支付渠道页详情常驻后靠 `bkdDetailCache` 按签名复用，别改回每次重画都重拉。

> **实时收款银行**（`bank_accounts.live_receiving`，`lib/bankLiveReceiving.js`）：在当日流水**银行列表的每一行**勾，最多 3 个「现在正在收款的户」
> （2026-11-09 起取代「使用中」：不用的户直接封禁，只要求运营中），
> 充值单的 BANK 下拉只列它们，**恰好勾 1 户时预选它、勾 2～3 户不预选**（2026-11-09 用户要求），末尾「其他渠道…」展开完整列表；一个没勾就是完整列表（不预选）；提现不受影响。
> 只能经 `PUT /api/banks/live-receiving` 整组替换（注册在 `PUT /:id` 之前），**不进 PUT 白名单**——逐户开关时两人同时勾
> 会各自通过「≤ 3」变成 4 个。封禁 / 归档在同一条 UPDATE 里清零，解封不恢复。改动写审计
> `bank_account.live_receiving`。它只决定下拉列谁，**绝不自动审批**。测试 `server/tests/live-receiving.test.js`。

## 支付渠道 & 账单流水 (`/api/banks`)

### 表

- `bank_accounts` — 银行账户。`active` 是遗留列（原「使用中」，2026-11-09 取消），无任何读者、不在 PUT 白名单，
  封禁 / 归档时照写 0；「在用」看生命周期（运营中），「正在收款」看 `live_receiving`
- `bank_ledger` — 账单流水
- `bank_balance_log` — 已处理充值 tx_id（防双计）

### API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/banks` | 账户列表 + 流水统计 |
| GET | `/api/banks/summary` | 右侧汇总面板 |
| GET | `/api/banks/ledger` | 流水分页（JOIN 查询用 `l.company_id` 避免歧义） |
| POST/PUT/DELETE | `/api/banks/ledger/:id` | 流水 CRUD，会联动账户余额 |
| GET | `/api/banks/suggestions` | 银行名自动补全 |

### 前端快捷录入（`bank-ledger.js`）

> ⚠️ 下表已过时：页面上没有这些按钮了，`startAdding` 没有任何调用方。新流水目前只来自
> 审批和调钱，表格里只能编辑已有行。`POST /api/banks/ledger` 接口本身还在，照样要守校验。

| 按钮 | mode | 字段 |
|---|---|---|
| + 入账 | `in` | TIME, BANK(可选), STATUS(入账列表), C STATUS, IN 金额, REMARK |
| + 出账 | `out` | 同上，OUT 金额 |
| + HELP TRF | `ht` | 方向, TIME, BANK(可选), C STATUS, TRANS ID, USERNAME, NAME, HELP/TRF 金额, REMARK |
| + 其他 | `null` | 完整表单 + 方向切换 |

**STATUS 分组：**

- 入账: deposit, cash in, new, bank transfer, unclaim, redeposit
- 出账: withdraw, wrong, cash out, give back, expenses, exchange, bank trf

**HELP TRF 保存逻辑：**

- 入账 → `trf_amount`，status = `bank transfer`
- 出账 → `help_amount`，status = `bank trf`
- 跨公司代操作：BANK ACC 可留空，C STATUS 填对方公司
- 落哪个字段由 **status** 决定（`bank-ledger.js` 的 `splitHelpTrf` + `OUT_STATUSES`），
  不看金额正负。所以 status = `withdraw` 时 HELP TRF 列的钱一定进 `help_amount`

### C STATUS 表的方向（与银行余额相反，别改平）

C STATUS 表记的是**我方相对这家对方公司的净收支**，不是资金流向 —— 这是它和余额
（`NET_EXPR`）唯一的分歧点，也是最容易被"顺手改一致"的地方：

| 列 | 走谁的账户 | C STATUS 记 |
|---|---|---|
| IN / OUT | 我方 | 按实际方向 |
| HELP TRF → `help_amount`（对方替我付）| 对方 | **IN**（我欠对方） |
| HELP TRF → `trf_amount`（对方替我收）| 对方 | **OUT**（对方欠我） |

即 `bankReport.js` 的 `cStatusTotalsForCompany`（SQL）和 `companyMap`（逐行累加）两处，
help/trf 与 `NET_EXPR` 是**对调**的。**BANK ACC 填不填只决定余额，不改变这里的方向。**
两处必须同口径：一个喂页面 `companyRows`，一个喂跨公司对平；只改一处会让
`reconcileAlerts` 凭空冒出差额。月报的往来账页（`lib/companyExpenses.js`，COMPANY EXPENSES）
是第三份同口径的 SQL，`company-expenses.test.js` 断言它逐格等于 `companyRows`——翻转口径时三处一起改。对平判据 `current.total + counterparty.total === 0`
在双方同步翻转后不受影响。

REPORT 的 STATUS 汇总（WITHDRAW / CASH OUT / DEPOSIT …）**照常计入 HELP TRF**，
金额和笔数都算 —— Excel 的 WITHDRAW 合计含那几笔，漏掉就永远对不上。

测试 `server/tests/bank-c-status.test.js` 守着以上每一条。

## Telegram 余额报警与查询

每公司一个独立 Bot（token 在 `companies` 表，「公司 / API」页可改）+ 一个总控 Bot（token、
白名单与全局开关在 `app_settings` 表，「Telegram 设置」页可改）。命令：`/balance [公司|all]`、
`/blocked [公司|all]`、`/today [公司|all]`、`/myid`、`/help`。**全部配置都在后台改、即时生效、
不读 `config.json`、不用重启。**

**`/balance` 只给在跑着的账户**（运营中 + PaymentGateway 两组），底部一行粒数总结
（`人头 N 粒 · 幽灵 N 粒 · PG N 粒`，概要模式则是每家一列 `3人/1幽`）。封禁账户整组归
**`/blocked`** —— 它和每周一那份待清理汇总共用同一套采集与版式（两组划分、封禁天数、
行尾的 `人`/`幽`/`PG` 类型标）。三条命令的参数规矩完全一样（`telegramBots.js` 的
`renderForArg`）：不带参数按公司数决定概要/明细，`all` 全展开，其余当公司名解析且**只在
本 bot 的公司里找**。

| 文件 | 职责 |
|---|---|
| `server/lib/appSettings.js` | 全局设置访问器（`app_settings` KV 表），校验与默认值只有这一份 |
| `server/lib/bankAlerts.js` | 阈值判定状态机 + 复位时排撤回任务，写 `telegram_outbox`。**纯 DB，绝不发 HTTP** |
| `server/lib/telegramFormat.js` | 排版工具（显示宽度、截断补白、转义、`<pre>` 表格）。纯函数零依赖 |
| `server/lib/telegramRender.js` | `/balance` `/today` 的消息渲染，总控与公司 Bot 共用 |
| `server/lib/bankCleanupReport.js` | 封禁渠道「待清理」的采集与版式；**每周一自动汇总与 `/blocked` 两个入口共用** |
| `server/lib/bankLifecycle.js` | 生命周期三态 + `account_kind` 的「怎么读给人看」（`kindOf` / `KIND_TAGS`） |
| `server/services/telegram.js` | Bot API 客户端（原生 fetch + 退避 + 429 retry_after + 4096 分条） |
| `server/services/telegramBots.js` | 出站发送与撤回、long polling、命令分发、热更新 |
| `server/routes/admin.js` | `/api/admin/telegram*` 四个端点（挂这里因为 `router.use(requireAdmin)` 已全局生效，且在 `resolveCompany` 之前，天然无公司上下文） |

**总开关（`enabled`）关掉时，`processOutbox` 必须直接 return，绝不能走 `deliver()` 把行标成
`skipped`** —— 边沿触发状态 `alert_fired_at` 已经置位，消息被丢掉之后余额继续超标也不会再报，
那个账户就被永久静音了。留在 `pending`，重新打开时补发（超过 24 小时的标 `expired`）。
**撤回任务（`kind='retract'`）同样留在 `pending`，并且刻意不参与那个 24 小时过期**——理由见
下面「复位时的撤回」。

**改这块前必须知道的四件事：**

1. **报警判定挂在 `refreshBankBalance()` 内部**（`lib/bankReport.js`）——它是全项目唯一的余额
   写入路径，所以 5 个调用点一行都不用改。修数据脚本传 `{ alert: false }` 跳过。
2. **绝不在事务内发网络请求**。`refreshBankBalance` 运行在 `runAtomic` 事务里，报警只往
   `telegram_outbox` 表写一行（回滚时一起回滚），发送由事务外的 flush 循环做。也因此这里
   **不能调 `runAtomic`**：`banks.js` / `bankApply.js` 那两份拷贝没有嵌套保护，嵌套调用的
   `ROLLBACK` 会把外层写入一起回滚（只有 `auditLog.js` 那份有保护）。
   **撤回受同一条约束**：复位时只排一行 `kind='retract'`，`deleteMessage` / `editMessageText`
   由事务外的 flush 循环发。`bank-alerts.test.js` 里「整条复位路径一个 HTTP 请求都不发」那条
   断言（把 `globalThis.fetch` 换成会抛的桩）就是守这个的。
3. **报警余额必须用 `displayBalanceForAccount()`**，不能用 `bank_accounts.balance` 那一列。
   前者跟随账户的 `reset_daily_balance` 并带 `entry_time` 上界，与页面日报一致；后者是无上界的
   累计值，存在未来日期流水或每日归零账户时两者不等。`bank-alerts.test.js` 有断言守着这条。
4. **`/balance` 与 `/blocked` 的余额口径刻意不同，别去「修平」**。`/balance` 用
   `displayBalanceForAccount`（当日口径，与页面 KPI 一致）；`/blocked` 走 `collectCleanupQueue`
   的 `balanceFromLedger`（无上界累计，与归档闸门一致）。同一个每日归零的封禁户在两条命令里
   数字不一样是**对的**：那里问「今天在跑的钱有多少」，这里问「这户里还有没有钱，任何时候」。

### 触发规则

**跨越阈值报一次 → 超标期间每当余额比上次报警时更高就再报一次 → 跌回阈值下自动复位，
并把这一轮发出的报警全部从聊天里撤回。**

状态存 `bank_accounts` 的三列：`alert_fired_at`、`alert_fired_date`（专治每日归零账户跨午夜
漏报）、`alert_fired_balance`（上次报警时的余额，就是「再涨一次」的比较基准）。不变量是
**`alert_fired_at = '' ⇒ 另外两列也为空`**，所以复位一律走 `clearFired` 那一份，调用方自己抄
一遍 UPDATE 早晚会漏掉新加的列。三列**都不在 PUT 白名单、也不在审计字段里**，否则可以伪造
已报警状态、或伪造一个极高的 `alert_fired_balance` 把账户永久静音。

比较基准刻意是「上次报警时的余额」而不是「上一笔流水前的余额」：阈值 200、在 400 时报过
之后，转走 50 变 350、再进 20 变 370 都不再响，直到涨过 400——同一桶钱来回动不是新信息。
判定必须写成 `fired && cents(balance) <= cents(account.alert_fired_balance)`，**前半截那个
`fired` 不能省**：每日归零账户跨日时 `isFired` 已经是 false，靠它昨天那个高点才不会把今天
第一笔吞掉（那一列此刻还是昨天的残值）。`bank-alerts.test.js` 有专门一条守着。

也刻意**不做合并间隔 / 最短间隔**：真实数据上近 7 天 29 个设了阈值的账户也只从 3 条变 8 条，
节流唯一的作用是制造「该响的那条被压掉」。

### 复位时的撤回

钱转走之后那条 ⚠️ 已经不成立了，留在聊天里只会误导人。所以复位时把这一轮发出的报警撤掉。

- **只排队不发包。** `clearFired` 运行在调用方的事务里，只往 `telegram_outbox` 插一行
  `kind='retract'`（随外层事务回滚）。真正的 `deleteMessage` / `editMessageText` 由事务外的
  `telegramBots.deliverRetract` 做。四个复位入口（阈值停用 / 阈值变更 / 账户封禁归档 /
  跌回阈值下）共用 `clearFired` 这一个口子，各自抄一遍早晚漏一处。
- **撤哪些**：`telegram_sent_messages` 里该账户 `retracted_at = ''` **且
  `outbox_id < 该 retract 行自己的 id`** 的全部。自增 id 天然就是「这一轮」的水位线，所以
  不需要任何显式轮次字段；**没有这条水位线**，撤回任务失败重试期间余额又超标发的新警会被
  旧任务一起删掉。
- **删不掉就改。** Telegram 只允许机器人删**不足 48 小时**的消息（这条限制对删自己发的消息
  同样适用）；`editMessageText` 没有时间限制，所以超时的退路是把原消息就地改成一行
  `✅ 已处理 · <渠道>`，不是放弃。两者都不成立时（`gone` / `unavailable`）按「目的已达成」
  收尾，**绝不无限重试**。找不到 bot（token 被清空）则按失败重试，**绝不标成已撤回**——标
  错了就再也没人会来撤它。
- **`expireStalePending` 刻意跳过 `kind='retract'`。** 24 小时那条线是为了「关几天再打开别被
  几百条过期报警轰炸」，而撤回不产生任何通知，迟到的撤回依然是对的动作。过期掉只会让一条
  已经不成立的 ⚠️ 永远留在聊天里。
- `telegram_sent_messages` 必须是独立表，不能是 outbox 上的一列：一行 outbox 发到多个
  (bot, chat)、每条还可能被 `chunkMessage` 切成多条，而 `deliver` 刻意不逐 chat 记录投递进度
  （重试会给已成功的 chat 再发一遍）。真实消息数比收件人数多，只能按真正记下的 message_id
  逐条撤。落库失败只 `console.warn`，**绝不能因此把已发成功的消息判成失败**——那会重发。

### 消息排版（`lib/telegramFormat.js`）

Telegram 正文是**比例字体**，纯文本靠空格对齐在手机上一定歪。所以所有出站文案走 HTML
`parse_mode`，需要成列的部分放进等宽 `<pre>` 块。四条铁律：

1. **每个消息块必须自带成对闭合的 `<pre>`，且不超过 `MAX_BLOCK_CHARS`（3000）。**
   `chunkMessage` 在单块装不下时按行切，切在 `<pre>` 中间 Telegram 直接返回 400，整条消息
   发不出去。`telegramRender.splitSection` 负责这个保证（续块标 `（续）`）。
   `telegram-render.test.js` 里「`<pre>` 成对」和「150 个账户拆块」两条断言守着它。
2. **补白按显示宽度算，不是 `String.length`** —— 中文一个字两格。只有 `displayWidth()` 这一份
   宽度表，`escapeHtml` 之后再补白会把 `&amp;` 当 5 格宽，所以**转义只在 `pre()` / `escapeHtml()`
   这两个出口做**，渲染过程一路用原文。
3. **`<pre>` 里的 emoji 只准放行尾**（`renderTable` 的 `flag`）。emoji 的等宽宽度各平台不一致，
   放中间会把后面的列顶歪。页眉的 💰 📊 ⚠️ 都在 `<pre>` 外面。
   ⚠️ **`flag` 不占 `renderTable` 的宽度预算，但照样占手机屏幕。** `/balance` 的 ⚠️ 只偶尔出现
   还能忍；`/blocked` 每行都挂类型标，所以它把 `maxWidth` 让出 3 格（`ENTRY_TABLE_WIDTH`），
   含标之后才落回 `TABLE_MAX_WIDTH`。每行都有 flag 的表都得这么让。
4. **`telegram_outbox.parse_mode` 跟着行走**，不是发送时统一决定。升级前积压在 `pending` 的老行
   是未转义纯文本，一律按 HTML 发会让含 `&` 的银行名 400。另外 `sendMessage` 还有一层兜底：
   Telegram 报 `can't parse entities` 时立刻 `stripHtml` 无 parse_mode 重发一次（这类 400 是
   确定性的，`tgApi` 里单独识别，不走 4 次退避）。**报警掉一条就等于那个账户被永久静音，
   不能只靠「我们转义对了」这个假设。**
   撤回时的 `editMessageText` 则**刻意不带 parse_mode**：那一行（`✅ 已处理 · <渠道>`）没有
   要对齐的东西，纯文本就不必操心渠道名里的 `&`，也不会掉进上面那条降级路径。
   `deleteMessage` / `editMessageText` 的确定性 400（消息已被人手删、超 48 小时、正文没变化）
   同样在 `tgApi` 里单独识别成 `TELEGRAM_BAD_REQUEST`，由 `retractFailureKind` 分类。

信息量上的取舍：总控 Bot 查全部公司时 `/balance` `/today` `/blocked` **默认只给概要**（每家
一行小计 + 仅点名超标账户），明细要 `/balance <公司>` 或 `/balance all`。4 家公司全展开是上百行，
没人读——这正是重排之前的样子。公司 Bot 只有一家，永远给明细。`resolveCompanyArg` 只在
`bot.companies` 里解析参数，**不能靠传参数越权查别家**。

`/blocked` 查不到封禁渠道时**必须回一句 `✅ 无封禁渠道`**，不能静默——那和每周一主动推送
里「无待清理就不发」是两回事：主动推送的 ✅ 是纯噪音，而对一条显式命令留空就是歧义，用户
分不清是真没有还是坏了。`/balance` 末尾的 `封禁渠道详情：/blocked` 只在真有封禁户时才出现，
且刻意不带笔数与金额——数字留给 `/blocked`，否则 `/balance` 又开始回答封禁的问题了。

排版预览：`node scripts/preview-telegram.js` 把三条命令的各种分支渲一遍，每行前面打印
`displayWidth`，用来肉眼确认 `<pre>` 里的行没超 `TABLE_MAX_WIDTH`。只读内存库，不碰真库。

## 开发原则（给 AI）

1. **数据准确 > 功能炫技** — 同步、余额、流水不能双计或漏计
2. **最小改动** — 只改需求相关文件，保持现有命名与风格
3. **公司隔离** — 所有 DB 查询带 `company_id`
4. **不提交密钥** — `config.json` 含 API token，勿写入 git/文档明文
5. **改 `index.js` HTML** — 长字符串用 Node 脚本替换，避免 PowerShell 转义问题
6. **改完重启** — 按端口停进程（见「Windows 注意」）后重新 `node server/index.js`

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 账单流水空白 | JOIN 查询 `company_id` 未加表别名 `l.` |
| 保存银行/流水无反应 | 路由用了错误的 companyId 字段 |
| Modal 点不开 | JS 用了 `open` 而非 `show` |
| 同步全部异常 | API `Invalid Access!`；检查公司 token / VPN |
| Telegram 不推送 | 看 `telegram_outbox` 表：`skipped` = 没配收件 chat；`failed` = 看 `last_error` |
| Bot 不响应命令 | chat 不在白名单会**静默丢弃**；先发 `/myid` 拿 id 填进公司设置页 |
| Bot 日志报 409 | 同一个 token 被另一个进程（如 demo 实例）抢 getUpdates |
| 报警撤不回 | 看 `telegram_sent_messages.retract_method`：`edit` = 超 48 小时退到了编辑（正常）；`gone` = 消息已被人手删；`unavailable` = 删不掉也改不动；空 + 对应 outbox 行 `failed` = 找不到 bot / token 被清空 |
| 新设置页 operator 也能进 | 忘了加进 `server/index.js` 的 `ADMIN_ONLY_PAGES` |
| 重启后今日数据为 0 | 等 fast-recovery 或手动触发同步 |
| cloudflared 断开 | node + cloudflared 进程都停了，需分别重启 |
| EADDRINUSE :3000 | `netstat -ano \| findstr :3000` 杀占用 PID |

## 相关项目

- `C:\Users\junho\marketing-bot` — 独立的营销爬虫/定时任务项目，与本后台**不是同一应用**，但含 `setup-cloudflare-tunnel.ps1` 可复用。
