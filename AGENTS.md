# AGENTS.md — NXC Report (trader-dashboard)

本文件供 AI 助手（Codex / Cursor）快速理解项目上下文与开发约束。

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
- 新 DEPOSIT（排除 `method === redeposit`）会自动：
  - 更新**打勾使用中**的 `bank_accounts.balance`
  - 写入 `bank_ledger`（`auto_generated = 1`）
  - 用 `bank_balance_log` 防重复入账

**修改同步逻辑前必须考虑**：分页完整性、去重、公司隔离、重启后 fast-recovery。

### 前端约定

- 全局 `api(url, opts)` 在 `public/js/app.js`，**只接受 2 个参数** `(url, opts)`；后台轮询用 `{ bg: true }`
- Modal 显示用 `classList.add("show")`，不是 `open`
- 页面 HTML 大量在 `server/index.js` 字符串拼接（Unicode `\uXXXX`），改 UI 时注意编码
- 暗色模式：`data-theme="dark"` on `:root`

## 主要页面

| 路由 | 脚本 | 说明 |
|---|---|---|
| `/` | `home.js` | 首页看板 |
| `/transactions.html` | `transactions.js` | 实时交易 |
| `/customers.html` | `customers.js` | 客户列表 + 分群 |
| `/bank-ledger.html` | `bank-ledger.js` | 当日流水：运营中银行列表（点行筛流水、逐行勾实时收款）+ KPI + 接单区 + 调钱 + 今日报表 / C STATUS + 流水表格 |
| `/bank-channels.html` | `bank-channels.js` | 支付渠道：全部渠道汇总 + 运营中 / 封禁中 / 已归档 + 渠道编辑 / 转出余额 |
| `/company-settings.html` | `company-settings.js` | 公司/API 配置（admin） |

## 支付渠道 & 账单流水 (`/api/banks`)

### 表

- `bank_accounts` — 银行账户。`active` 是遗留列（原「使用中」，2026-11-09 取消），「正在收款」看 `live_receiving`
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

## 开发原则（给 AI）

1. **数据准确 > 功能炫技** — 同步、余额、流水不能双计或漏计
2. **最小改动** — 只改需求相关文件，保持现有命名与风格
3. **公司隔离** — 所有 DB 查询带 `company_id`
4. **不提交密钥** — `config.json` 含 API token，勿写入 git/文档明文
5. **改 `index.js` HTML** — 长字符串用 Node 脚本替换，避免 PowerShell 转义问题
6. **改完重启** — `Get-Process node | Stop-Process` 后重新 `node server/index.js`

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 账单流水空白 | JOIN 查询 `company_id` 未加表别名 `l.` |
| 保存银行/流水无反应 | 路由用了错误的 companyId 字段 |
| Modal 点不开 | JS 用了 `open` 而非 `show` |
| 同步全部异常 | API `Invalid Access!`；检查公司 token / VPN |
| 重启后今日数据为 0 | 等 fast-recovery 或手动触发同步 |
| cloudflared 断开 | node + cloudflared 进程都停了，需分别重启 |
| EADDRINUSE :3000 | `netstat -ano \| findstr :3000` 杀占用 PID |

## 相关项目

- `C:\Users\junho\marketing-bot` — 独立的营销爬虫/定时任务项目，与本后台**不是同一应用**，但含 `setup-cloudflare-tunnel.ps1` 可复用。
