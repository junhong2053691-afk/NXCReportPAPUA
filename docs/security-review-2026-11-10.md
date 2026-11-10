# 代码逻辑与安全审计报告

**日期**：2026-11-10
**范围**：全库 `server/` + `public/` + `scripts/` 与 `deploy/`，HEAD = `f573fad`
**上一份**：[pre-launch-review-2026-09-24.md](pre-launch-review-2026-09-24.md)（之后又有 78 个提交）
**方法**：白盒审查分四路并行（认证与会话 / 授权与公司隔离 / 注入、输出与资源 / 资金与同步），
主审逐条复核调用链，另做了一次生产机只读检查；能复现的在本机**隔离靶场**上实测（空库 + 假数据，`127.0.0.1:3100`，
两家公司 alpha / beta，operator `op_a` 只授权 alpha）。全程没有读写真库，也没有改源码。
**基线**：`npm test` 554/554 通过；本地 `npm audit --omit=dev` 0 漏洞。

证据等级沿用上一份报告：

- `[实测]`——在靶场上发请求复现，或在内存库里用脚本跑出来
- `[读码确认]`——主审读过完整调用链
- `[待验证]`——机制成立，但取决于线上数据或外部行为，修之前要先确认

---

## 摘要

**认证、会话和公司隔离这一层是扎实的。** 上次的 H3、H7 已修好，大部分 H8 也修了。路由逐个核对，
没有找到 IDOR/BOLA：operator 拿别家的户口 id 去打 17 个端点，全部返回 403/404/400。CSP、
cookie 标志、改密或停用后立即踢出、用户名枚举这几项也都到位。

**线上运维有两条要今天处理**（详见「生产机配置检查」）：异地加密备份的 timer 没在跑（P1）；
服务器上躺着 5 份 0644 的明文全库快照（P2）。

**代码层的风险集中在资金状态机。** 最该先处理的三条：

| # | 问题 | 为什么危险 |
|---|---|---|
| N1 | 跨过悉尼午夜才拉到的平台单永远不进待审批 | 这笔钱永远进不了账本，而且没有任何报警 |
| N3 | 拆分组只恢复一行，同一笔平台单就能再审批一次 | 双计，而且余额对账查不出来 |
| N4 | operator 能借「调钱」改写 C STATUS 关联，绕过 B1 修复时加的 admin 限制 | 能凭空给两家公司造出对平差额，还能让别家的往来名字录不进去 |

---

## 阻断级（会掉钱或掉单）

### N1. 迟到的平台单永远不进待审批 `[读码确认]`

- 入队只有一个入口：[sync.js:524-527](../server/services/sync.js) `syncTransactions` 里的
  `enqueuePendingTx`（全库 grep 没有第二个调用点）。
- fast lane 的时间窗只有「今天」（[sync.js:433-445](../server/services/sync.js)），
  scheduler 的两条 lane 都传 `quick: true`（[scheduler.js:69](../server/scheduler.js)）。
- 昨天的单只能靠 slow lane 的 integrity 补回来。但补的路径只调 `upsertTransactions`
  （[syncIntegrity.js:140](../server/lib/syncIntegrity.js)），**不入队**。
- 一次性的 recent-days 回补（[sync.js:931](../server/services/sync.js)）只在库里不足 7 天数据时跑一次。

**会出事的场景**：

- ACCESS_DENIED、VPN 断线或停机正好跨过午夜；
- 23:59:5x 落的单，下一轮 fast tick 已经切到新的一天；
- 平台 `created_at` 是建单时间、单子过了午夜才出现在列表里。

这些单会进 `transactions`，报表里看得到，但**永远不出现在接单区**，也就永远不会被审批入账。

**修复方向**：integrity repair 之后对补回来的 DEPOSIT/WITHDRAW 调一次 `enqueuePendingTx`。
它已经有 `bank_balance_log` + `UNIQUE(company_id, tx_id)` 两道防重，重复调用是安全的。

**建议先量化**：在生产库上只读查一次自切换日起「DEPOSIT/WITHDRAW 在 `transactions` 里、
但 `bank_tx_pending` 和 `bank_balance_log` 里都没有」的笔数（查询见文末附录 B）。

### N2. `bank_balance_log` 仍是全局 `UNIQUE(tx_id)`（09-24 的 B3，未修）`[读码确认]`

- [schema.sql:141](../server/db/schema.sql)。删除路径
  [bankApply.js:810](../server/lib/bankApply.js) 的 `DELETE ... WHERE tx_id = ?` 也不带公司条件。
- 09-24 在真库上实测过一次跨公司撞号（aussiex6 / ezspin68）。
- 后果：后到那家公司的单被判定为「已处理」，不入队、不报错。另外，A 公司删一条流水，会把 B 公司同号单的防重锁一起删掉。
- 修复需要数据迁移：补 `company_id` 列，改成 `UNIQUE(company_id, tx_id)`。

---

## 高危

### N3. 拆分组只恢复一行，同一笔平台单可以再审批一次 `[读码确认 + 双驱动脚本实测]`

[banks.js:1010-1019](../server/routes/banks.js)：只要组里还有别的行留在回收站（`hasDeletedSibling`），
恢复时就跳过把单改回 `approved`。于是一行已经回到账上，单子却还是 `pending`。再审批一次，就记了两次。

- 子审查在 better-sqlite3 和 node:sqlite 上都跑出同样结果：单笔 100 拆两户 → 整组删除 →
  恢复其中一行 → 再审批，余额变成 -140，正确值是 -100。
- `restoreConflictForDeleted` 挡不住，因为它查的是「这单是否已经被重新审批」，而这时还没有。

**修复方向**：只要恢复了任意一行，就把单置回 `approved`；或者恢复时强制整组一起恢复。

### N4. operator 借「调钱 / 转出余额」改写 C STATUS 关联 `[实测]`

`POST /api/banks/ledger/transfer` 和 `POST /api/banks/:id/drain` 的 `to_company_id`
会直接进 `upsertCStatusOptions`（[bankApply.js:881-887](../server/lib/bankApply.js)、`:975`）。
对已有规则，它会覆盖 `target_company_id`（`:216-221`）。不校验公司是否存在，也不查 `user_companies`。
前端从来不发这个字段。

靶场复现（`op_a` 只授权 alpha）：

```
admin 建 C STATUS「BETA → beta」                                  → 200
op_a POST /ledger/transfer {amount:1, c_status:"BETA", to_company_id:"nonexistent-co"} → 200
op_a POST /ledger/transfer {amount:1, c_status:"GHOST", to_company_id:"beta"}          → 200
admin 看选项：BETA → nonexistent-co，GHOST → beta
op_a 直接 POST /c-status-options                                    → 403（admin 限制本身是好的）
```

**后果**：

- alpha 与 beta 之间的对平断开，两边都冒出假差额报警。
- 把规则指向别家之后，别家员工录这个 C STATUS 名字会被「是本公司」拒掉（子审查实测）。
- 错误响应里的 `target_company_name` 会带出别家公司名。

**修复方向**：去掉 `to_company_id`，只用 `linkedCompanyForCStatus` 查已有关联；审批、调钱、
录流水路径上调 `upsertCStatusOptions` 一律传 `null`。改 target 只留 admin 的设置接口，
而且要校验公司存在。

### N5. redeposit 或被改过 STATUS 的自动行，删除后单子吞掉（09-24 的 H5，未修，范围更大）`[读码确认]`

[bankApply.js:800-802](../server/lib/bankApply.js) 调 `platformTxTypeForLedger`：status 是 `redeposit`，
或者自动行被改成别的 STATUS，就返回空，于是不打回待审批。这时 `bank_tx_pending` 停在 `approved`，
`bank_balance_log` 还在，单子再也没有出口，只能手工改库。

### N6. 同公司「转出余额」的两条流水不联动删除 `[读码确认 + 脚本实测]`

drain 生成的出账、入账两行都是 `auto_generated = 0`，而
[banks.js:1085](../server/routes/banks.js) 只联删 `auto_generated = 1` 的组。只删其中一条，
总资金就凭空多出（或少掉）这笔钱（子审查实测 +50）。
**修复方向**：按 `transfer_group_id` 联删，不看 `auto_generated`；或者给 drain 的两行打上组标记。

---

## 中危

| # | 问题 | 证据 | 位置 | 修复方向 |
|---|---|---|---|---|
| M1 | operator 对**已归档**的户发 `{unban:true}`，户口直接回到运营中，绕过「取消归档仅 admin」。发 `{ban:true}` 也能把它拉回封禁 | `[实测]` | [banks.js:125-137](../server/routes/banks.js)：ban/unban 没设 `requiresStatus` | ban 限 active，unban 限 banned |
| M2 | `GET /api/companies` 和 `GET /api/banks/c-status-options` 的 `companies` 字段，给 operator 返回 `api_url`、`access_id`、token 脱敏片段、Telegram chat id、上游报错原文（09-24 已报过，未修） | `[实测]` 字段存在 | [companies.js:107-123](../server/routes/companies.js)、[lib/companies.js:19-40](../server/lib/companies.js)、[banks.js:234](../server/routes/banks.js) | 非 admin 只返回 `{id,name,enabled}` |
| M3 | operator 能改 `alert_threshold`（设 0 = 静音余额报警）、`reset_daily_balance`，以及 `account_kind`（改成 PG 后这户的钱就退出余额合计）。有审计但没有拦截 | `[读码确认]` | [banks.js:506-510](../server/routes/banks.js) | 改成 admin-only，或改动时推一条 Telegram |
| M4 | 平台单入队后平台又改了金额，审批时按旧金额入账（09-24 的 H4，未修） | `[读码确认]` | [bankApply.js:324-327](../server/lib/bankApply.js) `INSERT OR IGNORE` | pending 时刷新金额，或审批时回查 `transactions` |
| M5 | C STATUS 带尾部空格时对平误报：PUT 不 trim，报表先按原值分组、再 trim 合并，同名的组会互相覆盖 | `[脚本实测]` | [banks.js:912](../server/routes/banks.js)、[bankReport.js:191-206](../server/lib/bankReport.js) | 写入时 trim；SQL 用 `GROUP BY TRIM(c_status)` |
| M6 | 金额与时间几乎不校验：负数取绝对值照收；接受 0.005、1e15；调钱接受 2099 年的 `entry_time`；`c_status` 传对象会落库成 `[object Object]`；不选银行也不填 C STATUS 的调钱照样记账 | `[实测]` | [banks.js:639-644](../server/routes/banks.js)、[bankApply.js:857-862](../server/lib/bankApply.js) | 统一金额校验（>0、≤上限、整分）；未来时间挡住；字段先 `typeof` 再 `String` |
| M7 | prune 熔断留了 5% 窗口：中间某页返回空数组时静默跳过（约少 200 人），低于阈值就照删真实客户；DELETE 不在事务里（09-24 的 B4 部分修复） | `[读码确认]` | [platform.js:179-181](../server/services/platform.js)、[sync.js:286-313](../server/services/sync.js) | `fetchAllPages` 返回截断标记，有空页就不 prune；DELETE 包进事务 |
| M8 | 客户电话导出存在 CSV 公式注入：玩家姓名是平台侧自填的，`=HYPERLINK(...)` 能原样进 CSV | `[读码确认]` | [customerExport.js:65-69](../server/lib/customerExport.js)；另有 `app.js:489` 的 `downloadTableCsv`，以及 `appeal-csv.js:9` 漏了 `\t`/`\r` | 单元格以 `= + - @ \t \r` 开头时前置 `'` |
| M9 | `/api/data/deposits`、`/withdrawals` 的 `limit` 仍没有上限（09-24 的 H6 残留），`limit=-1` 会读全表。只有 admin 能调，但 GET 加上 SameSite=Lax，点一个链接就能触发 | `[读码确认]` | [data.js:174,206](../server/routes/data.js) | 前端已经不用这两个端点，直接删 |
| M10 | 按 IP 的限额用完整 IPv6 地址作 key，换一个 /64 里的地址就能绕过：captcha 出图每张约 12ms，阻塞事件循环 | `[读码确认 + 出图耗时实测]` | [auth.js:19-21](../server/routes/auth.js)、[captcha.js:116-131](../server/lib/captcha.js)、[loginLimiter.js:49](../server/lib/loginLimiter.js) | IPv6 按 /64 归一化；出图和登录各加一道全局令牌桶 |
| M11 | `deleteCompany` 只清 3 张表：bank_\*、audit_\*、`user_companies`、别家指向它的 C STATUS 规则都会残留。用同一 id 重建，会继承旧流水和旧授权（09-24 已报过，未修） | `[读码确认]` | [lib/companies.js:183-188](../server/lib/companies.js) | 要么全清，要么禁止复用 id |
| M12 | 入队不看交易 status：如果平台会返回 PENDING/REJECTED 的单，这些单也会进接单区，可能被审批入账 | `[待验证]` | [bankApply.js:330-333](../server/lib/bankApply.js) | 先确认平台返回什么，再决定是否按状态过滤 |

---

## 低危

| 问题 | 位置 |
|---|---|
| SSRF 校验只看主机名字符串：`localhost.`、`*.nip.io`、`[::7f00:1]`、`64:ff9b::/96` 都能通过，DNS rebinding 也挡不住；同步路径没设 `redirect:"error"`（仅 admin） | `lib/apiUrlPolicy.js:4-42`、`services/platform.js:103` |
| 约 30 处 `res.status(e.status \|\| 500).json({ error: e.message })` 回显原始错误。靶场上常见的畸形输入都落到了全局 handler（只回「服务器内部错误」），**没能触发出 SQLite 原文**，所以风险低，但写法本身应收掉 | `banks.js:254-392`、`data.js:286-492`、`admin.js:142-466` |
| `fmtDate` 遇到解析不了的值时返回原串的前 16 个字符，6 个页面未转义直接进 innerHTML（CSP 挡住脚本，只能注入 16 字符的 HTML） | `public/js/app.js:719` |
| `statusStyleAttr` 在前端不再校验 hex，库里旧行没有迁移清洗 | `public/js/bank-common.js:147-151` |
| CSRF 只靠 SameSite=Lax，而服务端仍接受 `express.urlencoded`（前端从不用表单提交）（09-24 H8 的残余） | `server/index.js:102` |
| 账号锁定可以被别人恶意触发（锁 admin 15 分钟，可循环）；限流 Map 满 1 万个 key 时整表 `clear()`，等于把锁定计数一起清零；用户名 key 不限长度 | `lib/loginLimiter.js:6-11,43,48`、`lib/captcha.js:123` |
| 旋转验证码容差 ±12°，随机猜中率约 6.7%，图案固定一张，只能算减速带 | `lib/captcha.js:18,84` |
| admin 改自己的密码不要求旧密码；`hashSync` 在请求里同步阻塞 | `routes/admin.js:407-426` |
| 密码最短 6 位，没有弱口令表；运行中仍可以把密码设回 `admin123` | `lib/passwordPolicy.js:2` |
| PUT 白名单含 `balance`，值不做类型校验（实测写进去后会被流水重算覆盖，无实际影响）；传对象会 500 | `routes/banks.js:506-524` |
| admin 写 `target_company_id` 时不校验公司是否存在、不统一大小写 | `routes/banks.js:247` |
| 写请求不带公司标识：另一个标签页切了公司之后，旧页面发出的不带户口 id 的写请求会落到新公司 | 前后端约定 |
| 封禁 / 归档不撤回已发出的余额报警（`bank-alerts.test.js:282` 手动调了 evaluate，没覆盖路由） | `routes/banks.js:583-588` |
| Telegram flush 没有重入锁，退避超过 5 秒时可能重复发消息 | `services/telegramBots.js:422-432` |
| PUT 流水时传 `bank_account_id:0`，可以绕过「归档户不能改金额」 | `routes/banks.js:864-883` |
| 审批的 UPDATE 不带 `AND state='pending'`（单进程无碍） | `lib/bankApply.js:421,666` |
| `scripts/repair-bank-balances.js:38` 仍用 `db.transaction`，在 node:sqlite 上必崩 | — |
| scheduler 的 `timers` Set 只增不删，每天约 6 万个 | `scheduler.js:26` |
| `displayName.js` 的正则是平方级回溯，5 万字符要 0.25–0.66 秒，跑在同步路径上 | `lib/displayName.js:6,14` |
| 日期非法时 `daysBetween` 返回 NaN，90 天上限失效 | `promoClaims.js:34`、`customerReturnReport.js:30`、`referrerReport.js:46` |
| **全新空库首次启动时，`migrateMultiCompany` 中途报错**（`table companies has no column named telegram_bot_token`，telegram 列是在它之后才加的），默认 / demo 公司建不出来。生产库早就迁移过，只影响从零重建 | `db/init.js:200-209`（`[实测]`） |
| 死代码：`server/pages.js`、`setup-pages.js`、`scripts/write-pages.js` 一旦运行，会覆盖 `public/login.html`；还有 `applyDepositsToBank`、`getActiveCompany` | — |

---

## 09-24 遗留条目状态

| 条目 | 状态 | 说明 |
|---|---|---|
| B1 存储型 XSS → 提权 | 已修 | 但出现了新的绕过路径（N4）；前端 `statusStyleAttr` 缺第二道校验（低危表） |
| B2 录流水双计 | 已失效 | `startAdding` 没有调用方；服务端 `POST /ledger` 仍然零去重 |
| B3 `bank_balance_log` 全局唯一 | **未修** | N2 |
| B4 prune 无熔断 | 部分 | 熔断已加；空页静默与事务问题仍在（M7） |
| B5 堆栈泄露 | 已修 | 逐路由的 `e.message` 写法还剩约 30 处（低危表） |
| B6 deleteCompany 500 | 已修 | `repair-bank-balances.js` 未修 |
| B7 驱动差异 | 部分 | `runAtomic` 仍有 4 份副本，其中 3 份没有嵌套守卫；测试仍只跑 better-sqlite3；没找到嵌套调用链 |
| B8 401 / MemoryStore | 已修 | — |
| B9 `.gitignore` | 已修 | — |
| H1 slow lane 只拉充提 | 部分 | integrity 会修今天和昨天，两天前的补不回；`sync.js` 的 CLI 仍不传 companyId；**而且 integrity 补回来的单不入队（N1）** |
| H2 用户游标卡死 | 未修 | `sync.js:895` |
| H3 撤权后仍可写 | 已修 | 实测：撤销授权后 GET 和 POST 都返回 403 |
| H4 pending 金额快照 | 未修 | M4 |
| H5 redeposit 吞单 | 未修 | N5 |
| H6 分页无上限 | 部分 | M9 |
| H7 登录限流 / bcrypt | 已修 | 残留风险见 M10 |
| H8 session 配置 | 部分 | store、secure、httpOnly、SameSite、trust proxy、regenerate 都到位；CSRF token 没有，urlencoded 仍开着 |
| H9 公司切换竞态 | 部分 | 读路径有 epoch 保护，写路径不带公司标识（低危表） |
| H10 非原子写状态文件 | 未修 | `sync.js:655`；scheduler 仍在 listen 之前启动 |
| 跨公司 C STATUS 零校验 | 部分 | 设置接口已加 admin，但存在性不校验；N4 是新的绕过 |
| `GET /api/companies` 凭证暴露 | **未修** | M2 |
| test-connection SSRF | 大部分修复 | 已加：只允许 https、拦内网 IP 字面量、`redirect:"error"`、超时。剩余见低危表 |
| `unknownPending` 缺公司过滤 | 未修 | 只有 admin 能看到 |
| `deleteCompany` 只清 3 张表 | 未修 | M11 |
| 删除银行账户后日报不自洽 | 已修 | 有流水时返回 409 |
| 未转义 innerHTML（home / company-settings） | 已修 | `company-settings` 的局部 `esc` 仍只处理 `"` 和 `<` |
| `deposits.js` / `withdrawals.js` 死代码 | 已删 | 其余死代码仍在 |

---

## 生产机配置检查（2026-11-10 01:03 AEDT，只读）

全程只跑查看类命令（清单见附录 C），没有改配置、没有重启、没有读库内容。

**线上就是本报告审的代码**：`/opt/trader-dashboard` 下 5 个关键文件的 git blob 哈希与 HEAD
`f573fad` 完全一致（`server/index.js`、`routes/banks.js`、`lib/bankApply.js`、
`public/js/bank-ledger.js`、`package-lock.json`）。所以上面每一条都是线上现状。

### P1. 异地加密备份没有在跑 `[实测，建议再确认一次]` — 高

`trader-backup.service` 和 `/usr/local/bin/trader-backup.sh` 都装了，脚本哈希与仓库
`deploy/trader-backup.sh` 一致；流程是 VACUUM INTO → gzip → age 加密 → R2。
**但 `systemctl list-timers --all` 列出的 19 个 timer 里没有 `trader-backup.timer`。**
仓库里的 `deploy/trader-backup.timer`（`OnCalendar=hourly`）看起来从来没装上，或者没有 enable。

现在唯一在跑的是应用内的本机备份（`TRADER_BACKUP_DIR=/var/lib/trader-dashboard/backups`）。
它和主库在同一块盘上：VPS 一旦丢失或被误删，就没有任何可恢复的副本。

**确认与修复**：在服务器上跑 `systemctl status trader-backup.timer` 和
`journalctl -u trader-backup --since -7d` 确认。确认没跑，就把 timer 装上、
`systemctl enable --now trader-backup.timer`，然后手动触发一次，确认 R2 上出现 `hourly/` 文件。
再挑一个备份做一次解密还原演练。

### P2. 5 份明文全库快照，本机任何用户都能读 `[实测]` — 高（需要先拿到本机立足点）

```
/var/lib/trader-dashboard/              drwxr-xr-x trader
  predeploy-20261109.db                 -rw-r--r--  310MB
  predeploy-20261109-preset.db          -rw-r--r--  313MB
  predeploy-20261109-banklist.db        -rw-r--r--  314MB
  predeploy-20261109-ui.db              -rw-r--r--  317MB
/var/backups/trader-dashboard/          drwxr-xr-x trader
  pre-fix-help-20261106.db              -rw-r--r--  304MB
```

主库 `trader.db` 是 0640，但每次发布前 `vacuumSnapshot` 打出来的快照都是 0644，
放在 0755 的目录里。每份都含 23 万客户的姓名和手机号，本机任何 uid（包括任何一个被攻破的服务账号）都能直接读。
另外，一天就攒了 4 份、约 1.25GB，还没有任何清理机制。

**修复**：现在就跑 `chmod 600` 并移进 0750 的 `backups/`；确认没用了就删掉。
`vacuumSnapshot.js` 和发布脚本落盘之后补一句 `chmod 600`，或者在进程里设 `umask 077`。

### 其余检查项

| 项 | 结果 |
|---|---|
| 网络暴露 | 公网只开 22（ufw 默认 deny）；node 只监听 `127.0.0.1:3000`；cloudflared 的 metrics 端口在 `127.0.0.1:20241` ✅ |
| Cloudflare 隧道 | ingress 只有 `dash.nxcreport.com → 127.0.0.1:3000`，其余一律 404；凭证 json 是 0400 root ✅。公网的 `login.html` 前面挂了 Cloudflare challenge（`Cf-Mitigated: challenge`），对验证码是一层额外的减速 |
| systemd | 运行身份 `trader`；`NODE_ENV=production`、`TZ=Australia/Sydney`；`ProtectSystem=strict`，只有 `/var/lib/trader-dashboard` 可写；`NoNewPrivileges`、`PrivateTmp`、`PrivateDevices`、`ProtectHome`、`ProtectKernel*`、`RestrictSUIDSGID`、`UMask=0027`、`MemoryMax=2500M` ✅。可以再加 `CapabilityBoundingSet=`、`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`、`SystemCallFilter=@system-service`（低） |
| 凭证文件 | `/etc/trader-dashboard/config.json` 是 0640 root:trader，目录 0750 ✅ |
| SSH | 只允许密钥登录（`passwordauthentication no`），`permitrootlogin no` ✅。`x11forwarding yes` 建议关掉（低）。24 小时内有 1161 次失败或无效登录尝试，全是扫描器；没有密码可撞，不构成风险，嫌日志吵可以把 22 限到固定 IP 或加 fail2ban |
| sudo | 只有 cloud-init 默认给 root 的 NOPASSWD；deploy 需要输密码 ✅ |
| 可登录的账号 | 只有 root 和 deploy ✅ |
| 代码目录 | `/opt/trader-dashboard` 归 `trader` 所有、可写。服务进程那一侧被 `ProtectSystem=strict` 挡成只读，但更稳的做法是代码归 root、服务用户只读（低）。发布包里还带着 `.scratch/`、`.impeccable/`、`CLAUDE.md`、`docs/`（不在 `public/` 下，不会被 web 访问到，实测返回 403） |
| 补丁 | unattended-upgrades 已启用。待装：`sqlite3`/`libsqlite3-0` 2.9、内核 6.8.0-149（noble-updates，非 security 源，不会自动装）。下次维护窗口装上并重启（低） |
| 依赖 | 线上 `npm audit --omit=dev` 0 漏洞 ✅ |
| 应用日志 | 近 24 小时 warning 及以上 0 条 ✅ |
| 本机 curl | `/api/auth/me` 返回 401；`login.html` 的安全头齐全（CSP、nosniff、XFO DENY、HSTS）✅ |

## Strix 自动渗透（未执行）

Strix 1.7.0 已装好（`uv tool install strix-agent`），沙箱镜像也拉下来了。但 LLM 认证失败
（Anthropic 返回 `invalid x-api-key`），扫描没有开始，本次跳过。**本报告的结论全部来自白盒审查、
靶场实测和生产机检查，没有经过独立的自动化第二遍。**

以后要补跑：用 `git archive HEAD` 导出一份干净副本作为源码目标（Strix 会以可写方式挂载目标目录，
不能指向工作仓库），黑盒目标只用本机靶场（空库假数据），**不要对 `dash.nxcreport.com`
或任何含真实客户数据的实例跑**——Strix 会把请求和响应发给 LLM 提供方。

---

## 已复核确认无问题（供排除）

| 检查项 | 结论 |
|---|---|
| IDOR / BOLA | **无**。所有按 id 操作的 SQL 都带 `company_id`；`op_a` 拿 beta 的户口 #3 去打 events、appeal-deposits、recent-transactions、PUT、drain、录流水、实时收款、DELETE，全部返回 403/404/400（实测） |
| 公司范围的来源 | 只有 `req.companyId`。全库只有一处从 body 读公司 id，就是 N4 的 `to_company_id` |
| 函数级授权 | operator 访问 `/api/admin`、`/api/audit`、`/api/data`（`sync-status` 除外）、月报、导出、status / C STATUS 的写操作、DELETE 户口，全部返回 403（实测） |
| 跨公司来单接口 | 每次请求按 `user_companies` 复核；admin 和只授权一家的 operator 返回 `enabled=false`；不带客户真名 |
| 会话 | 登录后 regenerate；改密、停用、删号、改角色在下一个请求就踢出；12 小时绝对上限，touch 续期绕不过；登出删 store |
| 用户名枚举 | 不存在和密码错返回同样的 401，耗时等价；403 只在密码正确之后才返回 |
| 验证码 | 答案不出现在响应或 DOM 里；一次性，重放无效；TTL 2 分钟 |
| 安全头 | CSP `script-src 'self'`、`object-src 'none'`、`base-uri 'none'`、`frame-ancestors 'none'`、`form-action 'self'`，nosniff、XFO DENY、HSTS 都在（实测）。唯一放宽的是 `style-src 'unsafe-inline'` |
| `trust proxy` | 只信 loopback；源站只听 127.0.0.1，`CF-Connecting-IP` 可以信任 |
| SQL 注入 | 无。拼进 SQL 的 `${}` 只有常量、白名单和服务端生成值 |
| 前端 XSS | 新页面（bank-ledger、bank-channels、cross-company-alerts、mobile-table-drawer、top-referral、telegram-settings、audit-history 等）的插值都转义了；i18n 只写 `nodeValue` |
| 余额写路径 | 增删改、恢复、四种审批、调钱、转出、cutover，全部在事务内并经 `refreshBankBalance` 全量重算；单进程内同步执行，双击审批时第二个请求返回 404 |
| C STATUS 口径 | 三处公式一致，方向对调正确（只有 M5 的空格问题） |
| Telegram 报警 | `clearFired` 一次清三列；事务内不发网络；总开关关闭时不标 skipped；撤回水位线生效 |
| 依赖 | 本地 `npm audit --omit=dev` 0 漏洞；只有 5 个直接依赖 |

---

## 建议修复顺序（性价比 × 风险）

0. **P2** 线上明文快照 `chmod 600` 并收进 `backups/`，**P1** 装上并启用 `trader-backup.timer`——都是运维动作，不改代码，今天就能做
1. **N1** 迟到单不入队：在 integrity repair 之后调 `enqueuePendingTx`，改动很小。先跑附录 B 的查询看线上有没有已经漏掉的单
2. **N4** 去掉 `to_company_id`：删一个字段
3. **N3** 拆分组恢复：一处条件
4. **N6** drain 两腿联删
5. **M1** ban/unban 加 `requiresStatus`：两行
6. **M2** operator 只返回 `{id,name,enabled}`
7. **N5** redeposit 吞单：给删除路径一个出口
8. **N2 / B3** `bank_balance_log` 加 `company_id`（需要数据迁移，单独排期）
9. **M6** 统一金额与时间校验
10. **M3** 监管类字段改成 admin-only
11. 其余按需

修复建议走 `/to-tickets` 一条一张票，每张票带回归测试（`/implement` 内部跑 `/tdd`）。

---

## 附录 A：靶场

- 起服务：`config.demo.json` + 临时库（scratchpad 下，不在仓库里），只监听 127.0.0.1:3100，没有平台 API
- 登录有验证码。审计时直接往靶场自己的 `sessions.db` 写 session（脚本 `mint-session.js`），不解验证码
- 造数：两家公司、`op_a` 只授权 alpha、每家两个户口

## 附录 B：量化 N1 的只读查询（未执行，需要在生产库上跑）

```sql
-- 自切换日起：在 transactions 里、但从未进过待审批也没进过防重表的充提
SELECT t.company_id, t.type, COUNT(*) AS n, ROUND(SUM(t.amount), 2) AS total
FROM transactions t
LEFT JOIN bank_tx_pending p ON p.company_id = t.company_id AND p.tx_id = t.id
LEFT JOIN bank_balance_log b ON b.tx_id = t.id
WHERE t.type IN ('DEPOSIT', 'WITHDRAW')
  AND t.created_date >= '<切换日>'
  AND p.id IS NULL AND b.id IS NULL
GROUP BY t.company_id, t.type;
```

## 附录 C：生产机上实际执行过的命令（全部只读）

`uname -a`、`lsb_release -ds`、`uptime`、`node -v`、`npm -v`、`systemctl cat/show/status`（trader-dashboard、
cloudflared、trader-backup）、`git hash-object`（5 个文件）、`sudo -v`、`sudo ss -tlnp`、
`sudo ufw status verbose`、`sudo sshd -T | grep`、`sudo journalctl -u ssh --since -1d | grep -c`、
`grep sh$ /etc/passwd`、`sudo grep -rn NOPASSWD /etc/sudoers*`、`sudo ls -la`（配置、库、状态、备份、代码目录）、
`sudo grep`（`/etc/cloudflared/config.yml` 的 ingress 行、备份脚本的加密与上传行）、`sha256sum` 备份脚本、
`systemctl list-timers --all`、`apt list --upgradable`、`systemctl is-enabled unattended-upgrades`、
`cat /etc/apt/apt.conf.d/20auto-upgrades`、`npm audit --omit=dev`、
`sudo journalctl -u trader-dashboard --since -1d -p warning`、`curl` 本机 3000 端口两次（GET）。
本机另对 `https://dash.nxcreport.com` 发了 4 个 GET/HEAD 看响应头。
