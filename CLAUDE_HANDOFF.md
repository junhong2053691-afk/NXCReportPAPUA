# 操盘手后台：交接给 Claude

交接日期：2026-09-23（Australia/Sydney）  
项目目录：`C:\Users\junho\trader-dashboard`

## 1. 接手说明

请用中文协助用户继续维护本项目。先阅读本文，再按下一项需求查看相关源码。本文依据当前会话、项目说明和本地源码整理，不包含其他历史会话的完整记录。

**当前用户要求是生成交接 Markdown；本次没有指定下一项功能或待修复问题。** 本次仅新增本文，没有修改业务代码、配置或数据库，也没有启动、停止服务或触发同步。不要将下文列出的功能当成本次新完成的工作。

项目已有 `AGENTS.md` 和 `CLAUDE.md`，两者内容基本一致，但部分业务说明落后于当前实现。尤其注意第 4 节的支付审批流程，接手时以实际调用链确认行为。

可直接复制给 Claude 的开场指令：

> 请接手 `C:\Users\junho\trader-dashboard`。先阅读根目录的 `CLAUDE_HANDOFF.md` 和现有项目约定，核实与下一项需求相关的源码。优先保证公司隔离、交易去重、余额和审计记录准确；保持最小改动，保护现有数据与凭证。交接文档中的状态是检查时的快照，运行服务和测试情况需要重新确认。读完后简要说明你理解的项目状态，等待我给出下一项具体需求。

## 2. 项目与环境

这是一个多公司操盘后台，从外部平台同步充值、提现和客户数据，提供看板、交易列表、报表、客户分群、支付渠道和账单流水管理。

| 项目 | 当前信息 |
|---|---|
| 后端 | Node.js、Express 4、express-session |
| 数据库 | SQLite，使用 better-sqlite3 |
| 前端 | 原生 HTML/CSS/JS，无前端框架 |
| 页面生成 | 主要在 `server/index.js` 的 `pageLayout` / `pageRoutes` 中 |
| Node 要求 | `package.json` 要求 Node.js ≥20 |
| 本机工具 | 本次检查为 Node.js v24.15.0、npm 12.0.2 |
| 主环境 | 配置端口 3000，时区 Australia/Sydney |
| 演示环境 | 配置端口 3100，独立配置、数据库和同步状态目录 |
| 依赖 | `node_modules` 已存在，未验证所有依赖可正常加载 |
| Git | `.git` 路径存在，但缺少 HEAD、config、objects；`git status` 返回非 Git 仓库，无法确认分支、提交或未提交改动 |

主配置、演示配置和两个数据库文件均存在。本次未检查登录、页面可用性、外部 API 连通性、同步健康、数据库内容或公网隧道状态，也未运行 `npm test`。

## 3. 按需求定位代码

| 范围 | 入口 |
|---|---|
| 服务启动、页面 HTML、页面权限 | `server/index.js` |
| 登录、当前公司、接口权限 | `server/middleware.js`、`server/lib/userAccess.js` |
| 数据库初始化和迁移 | `server/db/init.js`、`server/db/schema.sql`、`server/db/migrateMultiCompany.js` |
| 配置与路径覆盖 | `server/lib/readConfig.js`、`server/lib/paths.js` |
| 同步调度 | `server/scheduler.js` |
| 平台 API、数据同步、统计 | `server/services/platform.js`、`sync.js`、`stats.js` |
| 同步完整性 | `server/lib/syncIntegrity.js` |
| 看板、客户、交易、报表 API | `server/routes/data.js` |
| 支付账户、流水、待处理审批 API | `server/routes/banks.js` |
| 入账、审批、HELP/TRF、待处理状态 | `server/lib/bankApply.js` |
| 支付状态选项、报表 | `server/lib/bankStatusOptions.js`、`server/lib/bankReport.js` |
| 审计记录和审计 API | `server/lib/auditLog.js`、`server/routes/audit.js` |
| 客户详情、历史交易 | `server/lib/customerDetail.js`、`public/js/customer-detail.js` |
| 全局请求、公司切换、公共交互 | `public/js/app.js` |
| 支付页面交互 | `public/js/bank-ledger.js`（当日流水）、`public/js/bank-channels.js`（支付渠道）、`public/js/bank-common.js`（共用） |
| 全局样式 | `public/css/style.css` |
| 已有测试 | `server/tests/audit.test.js`、`server/tests/customer-history.test.js` |

主要页面包括：

- `/`：首页看板。
- `/transactions.html`：交易；旧充值、提现页面会重定向到这里。
- `/customers.html`：客户和分群。
- `/bank-ledger.html`：当日流水、接单区（待处理平台单）、调钱。旧地址 `/bank-accounts.html` 302 到这里。
- `/bank-channels.html`：支付渠道（运营中 / 封禁中 / 已归档）。
- `/company-settings.html`、`/bank-settings.html`、`/admin-users.html`：管理员设置。
- `/audit-history.html`：管理员审计历史。
- `/daily-archive.html`、`/deposit-leaderboard.html`、`/promo-claims.html`、`/referrer-leaderboard.html`、`/referrer-report.html`、`/customer-return.html`：归档、排行榜及报表。

已有 `server/pages.js`、`server/setup-pages.js` 和部分静态 HTML；修改页面前先确认 `server/index.js` 当前实际返回哪个页面，避免改到未使用的副本。

## 4. 业务约束与旧文档差异

### 公司隔离和权限

- `resolveCompany` 设置 `req.companyId`；公司业务路由使用该字段。当前 session 内保存的是 `companyId`，不是 `activeCompanyId`。
- 公司相关查询、更新和删除必须验证所属公司；JOIN 查询明确表别名，例如 `l.company_id`。
- `operator` 有公司授权限制，页面访问主要限定在支付渠道；数据接口也有专门限制。管理员页面和审计接口需要管理员权限。
- `bank_balance_log` 当前实现存在按 `tx_id` 查重的逻辑。若修改交易 ID 或公司隔离方式，连同平台交易、待处理记录和去重表一起核实，不要假定每张历史表都有直接的 `company_id` 条件。

### 同步

- 各公司独立运行 fast / slow 循环，一家失败不能拖住其他家；同一公司的同步由内部锁串行化。
- 当前主配置是 fast 6 秒、slow 60 秒。调度器源码缺省值分别是 6 秒和 45 秒，实际取配置并受最小间隔、任务耗时和失败退避影响。
- fast 主要处理今日交易和统计；slow 处理用户、完整性校验等工作。
- 外部平台出现 `Invalid Access!` 时按 `ACCESS_DENIED` 处理，保留失败隔离和恢复逻辑。
- 修改同步前核实分页完整性、去重、公司隔离及重启后的恢复，不能以空结果覆盖真实数据。

### 支付：当前经过待处理与审批

**旧 `AGENTS.md` / `CLAUDE.md` 中“新充值自动进入使用中的银行账户”不能直接当作当前流程。** 本次源码检查确认：

1. `server/services/sync.js` 保存平台交易后调用 `enqueuePendingTx`。
2. `bankApply.js` 将符合条件且未记账的 DEPOSIT / WITHDRAW 放入 `bank_tx_pending`。
3. 操作者通过审批选择银行、REDEPOSIT 或 HELP 等处理方式；审批代码负责写流水、更新相关状态和去重记录，并记录审计事件。
4. 同步文件仍保留 `applyDepositsToBank` 函数，但本次在该文件中只找到定义，当前保存交易的调用点走待处理队列。修改时沿调用链核对，避免同时启用两套入账路径而双计。

相关表包括 `bank_accounts`、`bank_ledger`、`bank_balance_log` 和 `bank_tx_pending`。流水新增、修改、删除和恢复会影响账户余额或待处理状态，需一起验证。

常用 API，统一前缀 `/api/banks`：

| 操作 | 路径 |
|---|---|
| 账户与汇总 | `GET /`、`GET /summary` |
| 流水查询 / 新增 | `GET /ledger`、`POST /ledger` |
| 流水修改 / 删除 | `PUT /ledger/:id`、`DELETE /ledger/:id` |
| 已删除流水 / 恢复 | `GET /ledger/deleted`、`POST /ledger/deleted/:deletedId/restore` |
| 待处理 / 已跳过 | `GET /pending-tx`、`GET /pending-tx/skipped` |
| 审批 / 跳过 / 恢复 | `POST /pending-tx/:txId/approve`、`/skip`、`/restore` |
| 转账 | `POST /ledger/transfer` |
| 状态选项 | `/status-options`、`/c-status-options` |

HELP/TRF 涉及 `help_amount`、`trf_amount`、方向、状态和 C STATUS；当前已支持更多状态及拆分审批。具体字段映射查看 `bankApply.js` 和 `bank-ledger.js`，不要仅按旧快捷录入说明重写。默认状态除旧列表外还包括 `amopay`、`test in`、`test out`，并提供公司级选项管理。

### 审计与客户历史

- 审计 API 在 `/api/audit` 下，包含 options、events、timeline 和事件详情，要求管理员与有效公司上下文。
- `audit_events`、`audit_event_refs` 有数据库触发器保护，只允许追加。业务操作与审计写入使用原子事务；保留操作者、原因、变更前后信息及关联记录。
- 已有审计测试覆盖公司隔离、凭证脱敏、去重、失败回滚、只追加约束、管理员权限、历史回填和平台单状态变更。
- 客户详情当前返回所属公司内最新 50 条交易。已有测试覆盖公司范围、客户历史链接以及支付页面不混入客户历史链接的约定。
- 上述是源码与测试内容的检查结果，不代表本次已执行这些测试。

### 前端约定

- 全局请求是 `api(url, opts)`，只接受两个参数；后台轮询传 `{ bg: true }`。
- Modal 用 `classList.add("show")` 显示。
- 暗色模式由根元素 `data-theme="dark"` 控制。
- `server/index.js` 包含长 HTML 字符串和 Unicode 转义，编辑长字符串优先使用 Node 脚本或可靠补丁，保持 UTF-8。
- 项目有 UTF-16 历史文件；本次默认读取 `README.md` 出现 NUL 和乱码，读取时需确认编码。服务启动的 `ensurePublicUtf8` 针对 public 下资源，不能推断所有文档都已转换。

## 5. 启动、演示与验证

### 主环境

在 PowerShell 中逐行执行。依赖缺失时才需要安装：

```powershell
Set-Location 'C:\Users\junho\trader-dashboard'
npm install
npm start
```

主配置默认使用 `config.json`，数据库默认是 `server/db/trader.db`。启动应用会涉及初始化及后台业务，因此接手阅读交接文件时无需为了确认环境而立即启动另一个主实例。

### 演示环境

```powershell
Set-Location 'C:\Users\junho\trader-dashboard'
npm run start:demo
```

演示脚本使用以下隔离路径，当前配置端口为 3100：

| 环境变量 | 演示值 |
|---|---|
| `TRADER_CONFIG` | `config.demo.json` |
| `TRADER_DB` | `server/db/trader-demo.db` |
| `TRADER_STATE_DIR` | `demo-state` |

`scripts/ensure-demo-config.js` 在配置缺失时从示例生成演示配置和随机凭证；已有配置会复用。启动脚本会在本机终端显示演示登录信息，不要复制到共享交接文档。演示用于独立测试，不代表主库数据已迁移。

需要临时公开演示时，项目提供 `npm run start:demo-tunnel`。主环境 Quick Tunnel 的项目约定命令是：

```powershell
$env:TUNNEL_EDGE_IP_VERSION = '4'
& 'C:\Program Files (x86)\cloudflared\cloudflared.exe' tunnel --url http://localhost:3000 --edge-ip-version 4
```

应用与隧道是两个独立进程。Quick Tunnel 地址随重启变化；本文未记录或验证当前公网地址。

### 修改后的验证

```powershell
node --check server/index.js
node --check server/routes/banks.js
node --check public/js/bank-ledger.js
node --check public/js/bank-channels.js
node --check public/js/bank-common.js
npm test
```

语法检查按实际修改的 JS 文件调整；`npm test` 当前执行 `node --test server/tests/*.test.js`。余额、同步、权限或审计修改还需要验证对应业务场景，语法检查不能替代这些验证。UI 修改需在浏览器检查交互和公司切换。

需要重启时，先识别本项目监听端口对应的进程，再仅重启该实例。旧文档中的 `Get-Process node | Stop-Process` 会影响其他 Node 应用，应避免照搬。Windows PowerShell 命令使用独立行，兼容不支持 `&&` 的环境；后台启动辅助进程使用隐藏窗口。

## 6. 文件与凭证交接边界

- 本文可以交给 Claude 作为上下文，但不包含源码、数据库或完整历史对话。在另一台电脑或网页会话接手时，需要另行提供必要的源码文件。
- `config.json`、`config.demo.json`、公司表和数据库可能含 API 凭证、密码或客户业务数据；凭证只在受控本地环境读取，输出时脱敏。
- 当前 `.gitignore` 已忽略演示配置、演示库、演示状态、依赖及日志，但没有覆盖主配置和主数据库。若未来恢复 Git 或提交代码，先处理这些忽略规则并核对待提交文件。
- 若需要迁移 SQLite 数据，使用一致性备份或停写后备份；保留相应同步状态，避免复制运行中主库单文件而漏掉 WAL 数据。
- `scripts/repair-bank-balances.js` 等修复脚本需要在理解其影响、完成备份和明确修复需求后使用，本次没有执行。
- `C:\Users\junho\marketing-bot` 是另一个应用，本项目工作保持在 trader-dashboard 范围内。

## 7. 接手完成标准

接手者应能确认：下一项用户需求涉及哪些文件、使用主环境还是演示环境、是否影响公司隔离或余额，以及如何验证结果。随后按用户的具体需求继续工作。

当前没有从本会话确认的待办清单，也没有可核实的历史提交记录；不要推断已有功能是刚完成的改动，或声称服务、测试和外部同步已经验证通过。
