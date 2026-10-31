# 上线前代码审查报告

**日期**：2026-09-24
**范围**：全库（`server/` + `public/`），三轴审查——数据准确性 / 路由与安全 / 前端与运维
**取证环境**：`server/db/trader.db`（237MB，4 家公司、162,493 笔交易、230,148 个客户、568 条账单流水），只读访问
**运行时**：Node v24.15.0，审查当时未修改任何源码与生产数据

---

## 修复状态（2026-09-24 生产部署时更新）

后续的部署工作修掉了下列各项，**其余条目仍然成立**。生产数据始终未被改动。

| 编号 | 状态 | 说明 |
|---|---|---|
| B1 | **已修** | `color` 服务端强制 `^#[0-9a-fA-F]{6}$`；status-options / c-status-options 的 5 个写操作加 `requireAdmin`（两个 GET 保持 operator 可读）。实测 operator 提交 payload 返回 403，admin 提交也被规范成 `#64748b` |
| B5 | **已修** | 新增全局 4 参数 error handler + `/api` 的 JSON 404；systemd unit 里带 `NODE_ENV=production`。实测 500 只返回 `{"error":"服务器内部错误"}`，无堆栈、无路径、无 SQL 细节 |
| B6 | **已修** | `deleteCompany` 改用 `runAtomic`，不再调用 better-sqlite3 专有的 `db.transaction()` |
| B7 | **部分修复** | `runAtomic` 现在同时判 `isTransaction` 与 `inTransaction`，嵌套保护在两个驱动上都生效（实测）。但**测试仍只跑 better-sqlite3 路径**，双驱动测试与统一兼容层仍在 backlog |
| B8 | **已修** | session 换成 SQLite store（`server/lib/sessionStore.js`，独立 `sessions.db`），实测强杀进程重启后登录态存活；`api()` 拦 401 跳登录页。**另外发现并修掉一个更深层的 bug**：`requireLogin` 用 `req.path` 判断 API 请求，而在 `router.use()` 里该值已被剥掉挂载前缀，导致后端从来只发 302 不发 401 —— 前端的 401 处理原本会是死代码 |
| B9 | **已修** | `.gitignore` 已排除 `config.json` 与 `server/db/*.db*` 等。仓库已初始化（此前 `.git` 是空目录），首个 commit 只含护栏，实测 93 个入库文件中九类危险模式零命中 |
| B4 | **缓解，未拆除** | `config.json` 的 `maxPages` 由 500 提到 1200（覆盖约 24 万客户，pokies7bet 余量从 126 页变为 826 页）。**代码层的熔断仍未加**，仍在 backlog 第 1 项 |
| H3 | **部分修复** | `/api/banks` 的 `requireCompany` 与 `banks.js` 的 session 回退**尚未处理** |
| H3 补充（2026-10-31） | **已修** | `/api/banks` 挂 `requireCompany`，去掉 session 回退 |
| H7（2026-10-31） | **已修** | 应用层限流 + 异步 bcrypt + 账号不存在时也跑哈希 |
| B4（2026-10-31） | **已修** | `pruneStaleCustomers` 加熔断 |
| B2（2026-10-31） | **路径已失效** | `startAdding` 无调用方，新增行从 UI 走不到。`commitRow` 的新增分支已补清空逻辑，但无法在页面验证 |
| B3（2026-10-31） | **未修** | 全量 1 个 ID 跨公司重复（aussiex6 / ezspin68），未造成吞单 |
| 其他 | 未处理 | 见文末 backlog |

另外新增两项部署期加固：应用只监听 `127.0.0.1`（此前绑 0.0.0.0，VPS 公网 IP:3000
可直接访问并绕过隧道）；`ensurePublicUtf8` 包了 try/catch（它在 `app.listen` 之前
对代码目录写文件，而生产用 `ProtectSystem=strict` 挂成只读）。

---

## 摘要

**核心记账机制是健康的。** 14 个活跃账户的 `balance` 与流水净额逐一核对，一分不差；测试套件 11/11 通过；权限层设计扎实（`requireAdmin` 覆盖完整、排序字段全白名单无注入、公司范围一律来自 session 而非请求参数、无 IDOR）。

但有 **9 条阻断级缺陷**（会掉钱、掉数据或可提权）和 **10 条高危**（数据长期错但不掉钱）。其中最该先处理的三条：

| # | 问题 | 为什么危险 |
|---|---|---|
| B2 | 录流水双计 | UI 反馈缺失**主动诱导**操作员重复提交，且对账查不出来 |
| B7 | 测试与生产跑在不同 SQLite 驱动上 | `npm test` 全绿覆盖不到生产路径，B6 就是这么漏掉的 |
| B1 | 存储型 XSS | operator 可提权成 admin，进而改公司 API 凭证 |

### 证据等级

报告对每条缺陷标注证据等级——这是本报告的主要价值，请据此决定复核成本：

- `[实测]`——本次在真库或隔离环境实际跑过、亲自确认
- `[读码确认]`——逐行读过完整调用链确认
- `[待验证]`——来自子审查、未单独复核，建议修复前先自行确认

---

## 两个必须先建立的认知

### 一、「余额对得上」不等于「没有双计」

`refreshBankBalance`（[server/routes/banks.js:602](../server/routes/banks.js)）是**按流水求和重算**账户余额的。所以余额永远等于流水净额——重复录入的那一笔会同时进流水和余额，两边一起错，**靠对账永远发现不了**。

本次真库 14 个活跃账户余额全部吻合，这只证明两者一致，**不能作为「没有双计」的证据**。真正的检出手段是查流水层面的重复条目，见文末核对脚本第 1 项。

### 二、测试全绿覆盖不到生产路径

[server/db/init.js:12-18](../server/db/init.js) 在 Node major ≥ 22 时优先使用内置 `node:sqlite` 的 `DatabaseSync`；本机 Node v24.15.0，**生产跑的是 `node:sqlite`**。而测试文件用 `new Database(":memory:")` 直接 require **better-sqlite3**。

两条不同的代码路径。在补上双驱动测试之前，`npm test` 的绿色不能作为生产就绪的证据——B6（删除公司必定 500）正是这个盲区的产物。

---

## 阻断级

### B1. 存储型 XSS → operator 提权 admin `[实测确认整条链路]`

四个环节缺一不可，本次逐一验证全部成立：

1. **写入无校验**——[server/lib/bankStatusOptions.js:77](../server/lib/bankStatusOptions.js)
   ```js
   const color = String(body.color || "#64748b").trim();   // 无 hex 格式校验
   ```
2. **授权缺口**——[server/index.js:58](../server/index.js) 的 `/api/banks` 只挂了 `requireLogin`，而 `POST /api/banks/status-options`（[server/routes/banks.js:182](../server/routes/banks.js)）**没有 `requireAdmin`**。页面 `/bank-settings.html` 有 `requireAdminPage` 保护，但对应的 API 没有——operator 直接 curl 即可。
3. **渲染无转义**——[public/js/bank-accounts.js:179](../public/js/bank-accounts.js) 取原值 → `:184` 拼进 style 字符串 → `:423`：
   ```js
   if (f === "status") attrs += ` style="${statusStyleAttr(val)}"`;   // 零转义，插入 <input>
   ```
   `:608`（`roCellHtml`）同样。注意 `tint` 经过 `hexToRgba` 是安全的，但 `accent` 和 `text` 是原始字符串。
4. **触发**——color 里含 `"` 即可闭合属性并注入新属性。admin 打开 `/bank-accounts.html`，鼠标经过任一 STATUS 单元格即执行。

**放大因素**：全站无 CSRF token；`esc`（[public/js/bank-accounts.js:87](../public/js/bank-accounts.js)）与 `escHtml`（[public/js/app.js:972](../public/js/app.js)）都不转义单引号（当前所有属性都用双引号，故暂无额外突破口，但离一次 XSS 只差一个单引号属性）。

**后果**：窃取 admin 身份后可改公司 API 凭证（`PUT /api/companies/:id`）、创建账号（`/api/admin/users`）。

**修复方向**：服务端校验 `/^#[0-9a-f]{6}$/i`；渲染改用 CSS 自定义属性而非拼接 style 字符串；status-options 与 c-status-options 的写操作加 `requireAdmin`。

---

### B2. 录流水双计——UI 反馈缺失直接诱导重复提交 `[读码确认完整链路]`

这是本次最该先修的功能性缺陷，因为它不是「用户手滑」，而是**界面主动把用户往错误操作上引**。

**第一步**，[public/js/bank-accounts.js:713-722](../public/js/bank-accounts.js) `commitRow` 成功分支：

```js
showToast(id ? "已更新" : "已保存", { tone: "success" });
if (id) {                    // ← 全部重置动作都在这个分支里
  editingRowId = null;
  hideGridPicker();
  resetEnterSave();
  renderGrid();
}
return loadBanks().then(loadSheet).then(loadDailyReport);
```

新增行的 `id` 是 `null`，所以**不清空录入行、不 `stopAdding()`**——刚才填的 tx_id、金额、username、备注全都还在。

**第二步**，[public/js/bank-accounts.js:877](../public/js/bank-accounts.js) `loadSheet` 早退：

```js
if (request !== ledgerLoadRequest || ... || isGridBusy()) return;
```

`isGridBusy()` 判的是 `adding || editingRowId != null`，而 `adding` 仍为 `true` → `renderSheet()` 不执行 → **新保存的行不出现在表格里，页脚合计也不更新**。`refreshSharedWorkspace` 因同样原因早退。

**第三步**，操作员看到的是：提示"已保存"，但表格没变化、合计没变化、录入行数据还在。自然反应就是再按一次 Enter 确认。

**第四步**，[server/routes/banks.js:566](../server/routes/banks.js) `POST /ledger` **零去重**——不查 `bank_balance_log`、不查已存在的 `bank_ledger`，`bank_ledger` 表也没有 `(company_id, tx_id)` 唯一约束。于是插入第二条流水，`refreshBankBalance` 重算 → **余额多一笔**。

**当前状态**：核对脚本第 1 项（双击 Enter 指纹）在真库里 **0 命中**——这个 bug 还没造成实际损失。但最近一条手工流水是 8-19，样本期很短。

**修复方向**：`commitRow` 成功分支对新行也要 `resetNewRow(tr)`，并强制一次忽略 `adding` 的 `loadSheet()`；服务端补一层内容去重或 `(company_id, tx_id)` 约束作为兜底。

---

### B3. `bank_balance_log` 缺 `company_id`，`UNIQUE(tx_id)` 是全局唯一 `[实测]`

表定义（[server/db/schema.sql:129](../server/db/schema.sql)、[server/db/init.js:296](../server/db/init.js)）：

```sql
CREATE TABLE bank_balance_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id INTEGER NOT NULL,
  tx_id TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tx_id)          -- ← 全局唯一，没有 company_id
)
```

可判定为遗漏而非设计：同一批次的 `bank_tx_pending` 用的是正确的 `UNIQUE(company_id, tx_id)`。

全部读写点都不带公司过滤：[server/lib/bankApply.js:284](../server/lib/bankApply.js)（防重判定）、`:265`（`INSERT OR IGNORE`）、`:718`（DELETE）、[server/routes/banks.js:777](../server/routes/banks.js)、[server/services/sync.js:542](../server/services/sync.js)。

**实测撞号已真实发生 1 次**：

| company | tx_id | 金额 | 类型/状态 |
|---|---|---|---|
| aussiex6 | 17027429560 | $20 | COMPLETED DEPOSIT |
| ezspin68 | 17027429560 | $100 | COMPLETED DEPOSIT |

**当前尚未造成资损**：这两笔都不在 `bank_balance_log` 中，`bank_tx_pending` 的跨公司撞号为 0 例。

但机制已被证实会发生。下次撞号时，第二家公司那笔充值会在 `bankApply.js:284` 被判定"已处理"，**永不进入待处理列表、不入流水、不报错**——操作员完全看不到这笔钱。4 家公司、16 万笔交易已撞 1 次，继续跑必然再撞。

**修复需数据迁移**：现有 543 条记录可按 `tx_id` 回查 `transactions` 补 `company_id`，再改约束为 `UNIQUE(company_id, tx_id)`。注意其中 26 条 `bank_account_id=0` 的记录（合计 $1822.37）需人工判断归属。

---

### B4. `pruneStaleCustomers` 依据可能被截断的分页结果批量删客户，无熔断 `[读码确认 + 实测规模]`

[server/services/sync.js:337](../server/services/sync.js) 取全量用户后调用 `pruneStaleCustomers`；`:283` 分批 DELETE **不在事务内**，中途抛错会留下半删状态。

截断是静默的——[server/services/platform.js:172-190](../server/services/platform.js)：
- `maxPages` 到顶后直接结束，**不报错、不标记不完整**
- 中间页返回空数组时 `continue` 静默跳过，行数丢了但 `pagesFetched` 照加
- `totalPage` 只在第一页读一次，扫描期间新增的尾页取不到

**实测已逼近上限**：

| 公司 | 客户数 | 所需页数（pageSize 200） | maxPages | 余量 |
|---|---|---|---|---|
| pokies7bet | 74,794 | ~374 | 500 | 126 |
| ezspin68 | 71,601 | ~359 | 500 | 141 |
| rolex66 | 69,739 | ~349 | 500 | 151 |
| aussiex6 | 14,014 | ~71 | 500 | 429 |

三家公司都在逼近上限。一旦突破，或平台某页瞬时返回空，`apiIds` 就是残缺集合 → **直接 DELETE 掉数千真实客户档案**，连带 `dep_total` / `win_loss`，报表、分群、推荐人统计全部塌陷。`transactions` 还在，但客户档案没了，不可逆。

**修复方向**：`fetchAllPages` 返回 `truncated` 标记；prune 前置熔断（例如 `apiTotal < dbCount × 0.9` 直接拒绝执行并告警）；DELETE 包进事务。

---

### B5. 无全局错误处理器 + `NODE_ENV` 从未设置 → 500 泄露完整堆栈 `[实测]`

全项目 **0 个 4 参数错误处理中间件**，`NODE_ENV` **0 处出现**（`start.cmd`、两个 demo 启动脚本都没设）。Express 4 的 `finalhandler` 在 `env === "development"` 时把 `err.stack` 原样写进 HTTP 响应体。

可复现路径：[server/routes/banks.js:348-368](../server/routes/banks.js) 的 `PUT /api/banks/:id` 把 `req.body[key]` 未做类型校验直接 bind，传 `{"balance": {"x":1}}` 即抛 `TypeError` → 500 + 完整堆栈（绝对路径、SQL 片段、依赖版本）。

叠加约 25 处 `res.status(500).json({ error: e.message })` 直接回显 SQLite 原始错误文本（含表名列名）。

经 Cloudflare 隧道暴露到公网时，这是给攻击者画地图。**一行 `NODE_ENV=production` + 一个 error handler 就能挡住，性价比最高。**

---

### B6. `deleteCompany` 在生产运行时必定 500 `[实测]`

实测 `node:sqlite` 的 `DatabaseSync`（Node v24.15.0）：

```
typeof db.transaction    : undefined      ← better-sqlite3 有，node:sqlite 没有
typeof db.inTransaction  : undefined      ← better-sqlite3 的属性名
typeof db.isTransaction  : boolean        ← node:sqlite 的属性名
d.transaction() THROWS   : TypeError: d.transaction is not a function
```

[server/lib/companies.js:160](../server/lib/companies.js) 直接调用，**没有 typeof 守卫**：

```js
const run = db.transaction(() => { ... });
```

→ 删除公司功能 **100% 失败**。好消息是 fail-safe：TypeError 在任何 DELETE 之前抛出，不会半删；坏消息是配合 B5 会连带泄露堆栈。

同类：`scripts/repair-bank-balances.js:38`（余额修复脚本跑不了）。
[server/lib/bankStatusOptions.js:47](../server/lib/bankStatusOptions.js) 有 typeof 守卫，安全。

---

### B7. 测试与生产跑在不同 SQLite 驱动上 `[实测]`

本次最重要的结构性发现，详见前文「两个必须先建立的认知」第二条。

`runAtomic` 有**三份副本**，且防护强度不一：

| 位置 | `inTransaction` 早退 | `typeof transaction` 守卫 |
|---|---|---|
| [server/lib/auditLog.js:49](../server/lib/auditLog.js) | 有（但在 node:sqlite 上恒 undefined，**永不生效**） | 有 |
| [server/routes/banks.js:461](../server/routes/banks.js) | **没有** | 有 |
| [server/routes/admin.js:31](../server/routes/admin.js) | **没有** | 有 |

**实测嵌套后果**（隔离环境复现）：

```
NESTED THROWS: cannot start a transaction within a transaction
rows after nested: [{"v":"single"}]        ← 外层的 outer-write 也被回滚了
```

内层 `BEGIN` 抛错 → catch 里的 `ROLLBACK` **回滚掉外层全部已完成的写入** → 错误上抛。

> **修正子审查的结论**：子审查称此处会「提前 COMMIT → 留下半更新」。实测为 fail-loud 的完整回滚——数据安全性比报告的好，但功能会直接报错。

**当前无现存嵌套链**：已确认 `appendAuditEvent`（[server/lib/auditLog.js:260](../server/lib/auditLog.js)）和 `upsertCStatusOptions`（[server/lib/bankApply.js:215](../server/lib/bankApply.js)）都不使用 `runAtomic`，所以 `POST /ledger` 的单层事务在生产上正常工作。真库里 18,359 条 platform 审计事件、最新到 9-15 12:35，证明同步路径的单层 `runAtomic` 是好的。

**这是颗地雷**：任何一次把 `approvePendingTx` / `submitTransfer` 包进外层事务的改动都会引爆。

**修复方向**（按已定方向：两种驱动都要能跑）：抽一个兼容层，判定 `db.isTransaction ?? db.inTransaction`，并为缺失的 `transaction()` 提供 BEGIN/COMMIT 兜底；删掉 `banks.js` / `admin.js` 的两份副本统一引用；`npm test` 对两个驱动各跑一遍（例如用环境变量强制驱动，CI 跑两轮）。

---

### B8. 401 不跳登录 + MemoryStore → 测试期大面积静默失败 `[机制读码确认，个别行号待验证]`

**这条在测试阶段会高频撞上**，因为你会频繁重启服务器。

- session 用默认 **MemoryStore**（[server/index.js:43](../server/index.js)）→ **每次重启全员掉线**
- [public/js/app.js:890](../public/js/app.js) 的 `api()` 只看 `res.ok`，**全项目没有任何 401 状态判断**。唯一的 `location.href = "/login.html"` 在 `loadUser()` 的 catch（仅页面加载时）和登出里
- 之后约 8 处 loader 是 `.catch(() => {})` 静默吞掉：`loadSheet`、`loadDailyReport`、`loadCStatus`、`loadStatusOptions`、`refreshPendingBadge`、`refreshSharedWorkspace`、`startSyncWatcher`、`startBankPendingWatcher`

操作员看到的是：**页面停留在旧数字，不再更新，没有任何提示**。更糟的是 [public/js/app.js:1143](../public/js/app.js) 把失败映射成「等待首次同步」——对过期会话是主动误导。

[public/js/bank-accounts.js:2299](../public/js/bank-accounts.js) `reloadAll()` 无 `.catch` → 401 时整页空白无提示。`company-settings.js` / `bank-settings.js` 同样。

**另一条**：`api()` 无 timeout 也无 `AbortController`。请求挂死（隧道停顿，仓库里有 1.3MB 的 `cloudflared-err.log`）则 `saveLock` 永久为 `true`，此后 `commitRow` 在 `:686` **静默 return，不保存也不提示**，只能刷新页面恢复。

即使不挂死也有静默丢失：保存 A 行未完成时录入 B 行并双击 Enter，`if (saveLock) return Promise.resolve()` 直接丢弃 B 行，**没有任何反馈**，而 `.then(() => focusNewRow(0))` 让它看起来像保存成功了。

---

### B9. 密钥与全量客户数据未被 `.gitignore` 排除 `[实测]`

`.gitignore` 只有 7 行，排除了 `config.demo.json`，但：

- **未排除 `config.json`**——含 `sessionSecret`、明文管理员密码、平台 `accessToken` / `accessId`
- **未排除 `server/db/trader.db`**——237MB，16 万笔交易 + 全部客户手机号

一次 `git add .` 就全部进仓库。

附带问题：[server/index.js:45-46](../server/index.js) 的

```js
name: cfg.sessionName || cfg.sessionName,
secret: cfg.sessionSecret || cfg.sessionSecret,
```

是复制粘贴造成的 no-op（原意应该是环境变量兜底），所以密钥只能来自那个未被忽略的文件。

> **注意**：如果 `config.json` 已经进过 git 历史，单改 `.gitignore` 不够——需要清理历史并**轮换全部凭证**。

---

## 高危

### H1. slow lane 形同虚设，BONUS/MANUAL/COMMISSION 永不例行同步 `[实测 + 系统自证]`

[server/scheduler.js:69](../server/scheduler.js)：

```js
await runSync({ quick: true, lane, companyId });    // ← 两条 lane 都传 quick: true
```

于是 [server/services/sync.js:939](../server/services/sync.js) 的 `txTypes: quick ? fastTxTypes : undefined` 永远取 `["DEPOSIT", "WITHDRAW"]`——**slow lane 也只拉充提**。

而 `:928-930` 的注释明确声称：

> Bonus/manual/commission are kept accurate by the slow-lane integrity pass (which verifies + repairs every type)

**与代码不符。**

**系统自己记下了证据**——`sync-state-pokies7bet.json`：

```json
"integrityMismatches": [
  { "date": "2026-09-15", "type": "BONUS",
    "db":  { "count": 365, "total": 3964.18 },
    "api": { "count": 366, "total": 3971.06 },
    "countOk": false, "amountOk": false }
],
"lastIntegrityOk": true,          ← 与上面的 mismatch 并存，会误导操作员
"lastPruneAt": "2026-08-28T05:55:47.528Z",
"lastFullUserReconcileAt": "2026-08-28T05:55:47.528Z",
"at": "2026-09-15T12:35:45.524Z"  ← 距上次全量对账 18 天
```

差 1 笔 BONUS、$6.88，而完整性标志仍是 `true`。且 integrity 只比对今天/昨天 → **两天前漏掉的 BONUS 永久补不回**。

**而唯一的手动全量通道是坏的**：根目录 `sync.js:8` 的 CLI 调 `runSync` 时不传 `companyId` → [server/services/sync.js:1139](../server/services/sync.js) 直接 reject。`npm run sync --full` / `--backfill` 100% 失败，全系统没有任何补历史的入口。

### H2. 轮转全量用户导入的游标会永久卡死 `[实测旁证]`

[server/services/sync.js:880](../server/services/sync.js) 只在 `pagesFetched > 0 && totalPages > 0` 时推进或重置 `userNextPage`；而 [server/services/platform.js:176](../server/services/platform.js) 在 `startPage >= totalPage` 时立即 break 返回 `pagesFetched = 0`。

游标越界后既不前进也不归零，每轮取 0 页，日志只打 `users saved: 0`。四个 sync-state 全部是 `userNextPage: 0 / userTotalPages: 0 / userImportComplete: false`——这个分支从未走到过。

后果：除最新 tail 5 页外，绝大多数客户的金额字段不再被 API 刷新。

### H3. 被撤销授权的 operator 仍可写原公司流水 `[读码确认]`

三个缺口叠加：

1. [server/middleware.js:39](../server/middleware.js)：`if (companyId) { req.session.companyId = companyId; }`——解析失败时**不覆盖**，旧值残留
2. [server/routes/banks.js:72-74](../server/routes/banks.js)：`req.companyId || (req.session && req.session.companyId) || ""`——回退到残留值
3. [server/index.js:58](../server/index.js)：`/api/banks` **缺 `requireCompany`**（对比 [server/routes/data.js:48](../server/routes/data.js) 有）

admin 撤销 operator 的公司授权后，该会话仍可 `POST /api/banks/ledger`、审批平台单，写进原公司。

另一后果：连 session 也没有时 `cid = ""`，流水以 `company_id = ''` 落库 → 任何公司的报表都查不到，**资金行凭空消失**。真库已有 1 个 `company_id = ''` 的支付渠道，说明这条路走通过。

### H4. 平台单入队后金额永不刷新 `[待验证]`

[server/lib/bankApply.js:272](../server/lib/bankApply.js) 用 `INSERT OR IGNORE INTO bank_tx_pending`，命中已存在行时**不更新** `amount` / `tx_type` / `tx_time`；审批时取 `pending.amount`，不回查 `transactions`。

平台事后修改金额（同步会更新 `transactions.amount` 并记审计），pending 仍是旧快照 → 按旧金额入账，且系统没有任何 ledger ↔ 平台金额的核对告警。

### H5. 删除 redeposit 自动流水 → 平台单被永久吞掉 `[待验证]`

[server/lib/bankApply.js:694](../server/lib/bankApply.js) 的 `platformTxTypeForLedger` 对 `status = 'redeposit'` 返回 `""` → `reopenPendingForLedger` 直接 `return false`。

于是：`bank_balance_log` 记录仍在、`bank_tx_pending.state` 仍是 `approved` → `bankApply.js:284` 永远跳过 → 这笔充值再也不会出现在待处理列表，也进不了任何流水。只能手工改库。

### H6. 无分页上限 → 单请求打爆进程 `[实测，并修正子审查结论]`

[server/routes/data.js:170](../server/routes/data.js) 与 `:202`：

```js
const offset = (Math.max(1, Number(page)) - 1) * Number(limit);
params.push(Number(limit), offset);      // 完全没有 clamp
```

对比同文件 `:128` 有 `Math.min(500, Math.max(20, Number(limit) || 100))`——是漏改。

> **修正子审查结论**：子审查称 `limit=abc` 会因 `LIMIT NULL` 返回全表。实测并非如此：
> ```
> limit=abc (NaN)   => THROWS: SqliteError: datatype mismatch
> limit=99999999    => 全表
> limit=-1          => 全表          ← SQLite 中 LIMIT -1 即无限制
> ```
> 所以 DoS 成立，但机制是显式传大数或 `-1`，不是非数字。

237MB 库全表 `JSON.stringify` → 堆溢出 → 进程崩溃 → **全部公司同步中断**。

### H7. 登录无限流 + `bcrypt.compareSync` 阻塞事件循环 `[待验证]`

[server/routes/auth.js:25](../server/routes/auth.js) 用同步 `bcrypt.compareSync`。`bcryptjs` 是纯 JS 实现，cost 10 约 100ms，且**阻塞事件循环**。全项目无任何 rate limit，密码策略只要求 4 位。

约 10 req/s 即让整个服务不可用；配合 4 位密码，字典攻击成本极低。经 Cloudflare 隧道暴露后风险直接放大。

附带：`:19-21` 用户不存在时直接 return **不执行 bcrypt** → 约 100ms 的响应时间差 → 稳定的用户名枚举 oracle。停用账号返回 403、密码错误返回 401，也能区分账号是否存在。

### H8. session 配置不安全 `[实测]`

[server/index.js:43-51](../server/index.js)：无 `store`（重启全掉线）、无 `cookie.secure`、无 `cookie.sameSite`、无 `app.set("trust proxy", 1)`、登录后无 `req.session.regenerate()`、全站无 CSRF token。

Cloudflare 隧道到源站是 HTTP，cookie 未标 Secure。同时 `express.urlencoded({ extended: true })` 已启用，意味着跨站表单 POST 的 body 会被解析——在 SameSite 不生效的场景下 `POST /api/admin/users`、`DELETE /api/banks/ledger/:id` 均可被 CSRF 触发。

### H9. 公司切换竞态：`/api/banks/*` 响应不带 `companyId`，无法校验 `[待验证]`

[public/js/app.js:1308](../public/js/app.js) 已经提供了 `guardCompanyPayload`，`home.js` / `customers.js` / `daily-archive.js` / `promo-claims.js` / `referrer-leaderboard.js` 都在用。

但 **`bank-accounts.js` 一次都没调**——而且调不了：`GET /api/banks`、`/ledger`、`/pending-tx`、`/daily-report` 的响应体里**没有 `companyId` 字段**（`/api/data/*` 有，见 [server/routes/data.js:61](../server/routes/data.js)）。

`bumpFetchEpoch` 能挡住切换瞬间在途的响应，但挡不住「`bumpFetchEpoch` 之后、服务端真正处理完 `POST /api/companies/active` 之前」那个窗口里触发的定时器（5s/8s 各若干）——它们拿到新 epoch 但收到旧公司数据，通过 epoch 校验。

写操作有服务端二次校验（`bank_accounts WHERE id=? AND company_id=?`），所以这是**显示层风险**：A 公司的余额和流水可能渲染在 B 公司标题下，且无从察觉。对操盘决策来说仍然危险。

### H10. `sync-state-*.json` 与 `active-company.json` 非原子写 `[待验证]`

[server/services/sync.js:640](../server/services/sync.js) 直接 `fs.writeFileSync`（truncate-then-write）。Windows 上用 `Stop-Process` 杀进程（CLAUDE.md 里的标准重启姿势）可能留下半个文件。

读取端有兜底（`:597-604` 解析失败返回 `{}`），所以不会崩溃启动——但后果更难诊断：`writeSyncState` 从 `{}` 展开，于是 `userNextPage`、`userImportComplete`、`lastTxSyncedAt`、`recentDaysDone`、`integrityFailStreak` 全部重置为默认值 → 触发最长 365 天 / 2000 页的全量重拉，**日志里没有任何一行说明原因**。

旁证：真库 WAL 残留 41MB，最后写入 9-15 至今未 checkpoint——说明进程一直被强杀，没有优雅关闭。

**另外**：`startScheduler` 在 [server/index.js:16](../server/index.js) 执行，**早于** `app.listen`，且无单实例锁。启动第二个进程时，它会在 `EADDRINUSE` 挂掉之前抢写同一批 `sync-state-*.json`。

---

## 中低危

### 两条降级修正

**跨公司 C STATUS 数据泄露——经复核不成立，已降级为「中」**

子审查称「任意登录用户可自建 `target_company_id` 规则，然后通过 `daily-report` 拉取其他公司当日资金进出汇总」。**读码复核不成立**：

[server/lib/bankReport.js:345-358](../server/lib/bankReport.js) 的 `ensurePair` 中 `counterpartyNames` 初始为空数组，**只由 inbound 规则填充**——也就是**对方公司自己配置的**指向你的规则（`:366-379`）。攻击者自建 outbound 规则时，`sumNames(group.otherId, [])` 传空数组，`result` 恒为 `{in:0, out:0, total:0}`。拿不到任何金额。

对方公司主动配置了指向你的规则时才会出数——那正是跨公司代操作对账的设计意图。

**真实缺陷是反方向的**：[server/routes/banks.js:161](../server/routes/banks.js) 的 `target_company_id` 零校验，攻击者可以：
- 往**别人的**对账面板注入虚假差额告警（数据污染 / 误导）
- 通过返回的 `target_company_name` 枚举其他公司的 id 与名称（轻度信息泄露）

修复仍然需要（校验 `target_company_id` 在 `hasCompanyAccess` 范围内），但不是「严重」。

**mobile 回退 JOIN 造成金额倍增——机制成立但当前未激活，已降级为「低」**

[server/lib/winLoss.js:5-10](../server/lib/winLoss.js) 在 `customer_id` 为空时按 `c.mobile = t.mobile` 回退 JOIN，而 `customers.mobile` 没有唯一约束。真库确有 5 组重复手机号（ezspin68 1 组、pokies7bet 3 组、rolex66 1 组）。

但**实测 `customer_id` 为空的交易 = 0 条**——回退路径当前完全不被触发，实际影响为零。

一旦平台开始返回空 `customer_id`，这条立即变高危（会污染持久化的 `customers.win_loss`）。核对脚本第 7 项会同时打印这个前提条件。

### 其余

- **两个 UTF-16 侦测函数各有盲区，都会漏判** `[实测]`

  > **勘误（2026-09-24）**：此条原先说 `readConfig.js` 的 `looksUtf16Le` "已经写对了"并建议 `ensurePublicUtf8` 直接复用它。**这个建议是错的**，实测两者各有盲区：
  >
  > | 函数 | 判据 | 盲区 |
  > |---|---|---|
  > | `ensurePublicUtf8`（[server/index.js:19-35](../server/index.js)） | `buf[1] === 0` | **带 BOM 的文件**（`FF FE` 开头，`buf[1]` 是 `0xFE`）——正是 PowerShell 5.1 `Out-File` 的产物 |
  > | `looksUtf16Le`（[server/lib/readConfig.js:3-13](../server/lib/readConfig.js)） | BOM + 前 200 字节里奇数位 NUL 比例 > 0.8 | **中文密集的无 BOM 文件**。中文在 UTF-16LE 里两个字节都非 0（`操` = `cd 64`），所以开头是中文的文件比例上不去 |
  >
  > **真实受害者就在本仓库**：`README.md` 是 UTF-16LE 无 BOM，505 个 NUL 里 492 个在奇数位（97.4%），但全文比例只有 68%，低于 0.8 阈值 → `readTextFile` 读出的是乱码。（已在本次部署中转为 UTF-8。）
  >
  > 可靠的判据是**扫全文**而非前 200 字节，并改用"NUL 存在且绝大多数落在奇数位"：合法 UTF-8 文本不含 NUL，而 UTF-16LE 里 ASCII 字符编码为 `xx 00`，NUL 几乎全在奇数位。即 `nul > 0 && nul / len > 0.05 && oddNul / nul > 0.9`。改动 `readConfig.js` 会影响启动时读 `config.json` 的路径，所以**未在本次部署中动它**，列入 backlog。

  此外 `ensurePublicUtf8` 在**服务源码树上**做非原子 `writeFileSync`、且位于 `app.listen` 之前——进程在此被杀会留下截断的 `app.js`/`style.css`；`EPERM`/`EBUSY`（编辑器锁、OneDrive、杀毒）或生产的只读挂载会让服务直接起不来。**已在本次部署中给它包了 try/catch**（降级为 warn），但判定逻辑本身未改。

- **`deleteCompany` 只清 3 张表**——[server/lib/companies.js:161-164](../server/lib/companies.js) 删了 `transactions` / `customers` / `daily_stats`，遗漏全部 `bank_*`、`audit_*` 和 `user_companies`。重建同 ID 公司会「继承」旧流水与余额，老 operator 自动重获授权。

  > **勘误（2026-09-24）**：此条原先写「`user_companies` 无外键、`PRAGMA foreign_keys` 未开启」，**后半句是错的**。实测 better-sqlite3 与 `node:sqlite` 的 `foreign_keys` 默认都是 **1（开启）**。但 `server/db/schema.sql` 里 `REFERENCES` / `FOREIGN KEY` 的命中数是 **0** —— 全库根本没有任何外键定义，所以这个 pragma 开与不开完全等价。结论不变，归因应为「没有外键定义」：去开那个 pragma 不会有任何作用。

- **删除银行账户后日报不自洽**——保留了它的 `bank_ledger` 行，于是 [server/lib/bankReport.js:186](../server/lib/bankReport.js) 的总余额丢掉它，但 `totalIn` / `totalOut` / DEPOSIT / WITHDRAW / C STATUS 仍统计它的流水。

- **`unknownPending` 缺公司过滤**——[server/lib/promoClaims.js:133-139](../server/lib/promoClaims.js) 的 `COUNT(*)` 没有 `company_id` 条件（同文件 `:101` 和 `:128` 都有），该数字是所有公司之和。

- **未转义的 innerHTML**——[public/js/home.js:296](../public/js/home.js)/`:314`（`mobile` / `referrer`，而姊妹页 `daily-archive.js:162/180` 对同样两个字段做了转义，属直接遗漏）；[public/js/company-settings.js:77](../public/js/company-settings.js)（`last_sync_msg` 是**上游 API 的错误文本**，无需任何用户操作即可进入 admin 的 DOM）。另 `company-settings.js:16-18` 的局部 `esc()` 只处理 `"` 和 `<`，不处理 `&`，不可当通用转义器用。

- **非网格保存按钮无 in-flight 锁**——[public/js/bank-accounts.js:1547](../public/js/bank-accounts.js) 的 `saveBankModal` 既无锁也不禁用按钮，而 `POST /api/banks` 无重复检测 → 双击可建**两个 `active=1` 的相同支付渠道，两者都会参与自动入账**。`.pend-approve`、`#cs-add-btn`、`admin-users.js` 的 `#save-btn`、`company-settings.js` 的 `#create-submit` 同样缺锁（多被服务端唯一性吸收，但会弹出假的失败提示）。

- **`commitRow` 会连续弹出矛盾提示**——[public/js/bank-accounts.js:713-724](../public/js/bank-accounts.js) 先 toast「已保存」再 return 重载链，而重载失败被同一个 `.catch` 捕获 → 一次成功的写入会显示「已保存」紧接「保存失败：…」。

- **轮询缺 `{ bg: true }`**——`transactions.js:165`、`customers.js:118`/`:89`、`promo-claims.js:125` 等在静默刷新时也走 `progressStart()` + `setListLoading()`，而 `style.css:885` 给 `.table-wrap.is-loading table` 设了 `opacity: .58` → 操作员阅读时表格每 10s 变暗一次。（顺带确认：**全部 78 个 `api()` 调用点都没有传第 3 个参数**，签名约定被遵守。）

- **暗色模式 STATUS 列深字压深底**——[public/js/bank-accounts.js:149-166](../public/js/bank-accounts.js) 硬编码浅色主题墨值，并在 `:184` 以 inline `color:… !important` 输出。inline `!important` 压过任何作者样式表，`style.css:2696` 那条 theme-aware 规则永远赢不了。且 `bank-accounts.js` 从不监听 `applyTheme` 派发的 `theme-changed` 事件。

- **`scheduler.js:15-31` 的 `timers` Set 只增不删**——fast lane 6s 一轮，单公司每天约 1.4 万条，只有 `stopScheduler` 才清理 → 长跑内存持续增长。

- **API 凭证泄露面**——`GET /api/companies`（[server/lib/companies.js:18-34](../server/lib/companies.js)）对普通 operator 也返回 `api_url` 与 `access_id` 明文，以及 token 的首尾各 4 字符。建议非 admin 只返回 `{id, name, enabled}`。

- **SSRF**——`POST /api/companies/test-connection` 的 `api_url` 无白名单、无协议限制、无超时，响应内容还会通过错误信息部分回显。仅限 admin，但可被 B1 的 XSS 串起来。

- **死代码（建议删除）**：`server/pages.js` + `server/setup-pages.js`（**已确认全项目零引用**）；`public/js/deposits.js` / `withdrawals.js`（含未转义插值，页面已被 `server/index.js:498-499` 重定向，留着是陷阱）；`applyDepositsToBank`（[server/services/sync.js:524](../server/services/sync.js)，未被调用也未导出，且用 `balance = balance + ?` 增量累加——这是全项目**唯一**会造成浮点漂移的写法，另外 `:542` 的 `WHERE tx_id IN (...)` 既缺 `company_id` 又可能超出 SQLite 变量上限）；`activeCompany.js` 的 `getActiveCompany`（零引用，但 `setActiveCompany` 仍在被任意用户触发写入进程级共享文件）。

- **杂项**：[server/lib/paths.js:44-45](../server/lib/paths.js) 的 `syncStatePath` 在同一对象字面量里导出两次；`check-node.js` 要求 Node ≥22 而 `package.json` 声明 `>=20`，且 `npm start` 完全绕过该检查；`start.cmd` 每次启动都 `npm install` 且不检查错误码（可能重建 `better-sqlite3`，启动需联网）；`app.js:1152-1155` 在 `pagehide` 时设 `stopped = true` 且 `{ once: true }` 从不复位，bfcache 恢复后全局同步指示器永久冻结；`company-settings.js:2` 与 `admin-users.js:214` 重复调用 `loadUser()`，且 `setupLogout()` 绑定了第二个 click 监听 → 会发两次登出请求。

---

## 已复核确认无问题（供排除，不必再查）

| 检查项 | 结论 |
|---|---|
| ORDER BY / 排序字段注入 | **无**。`customerSegments.js`、`todayLeaderboard.js`、`referrerReport.js`、`customerExport.js` 全部白名单映射，用户输入从不进 SQL |
| 通过 query/body 传 `company_id` 造成 IDOR | **无**。全项目 grep `query.company_id` / `body.company_id` / `params.company_id` 零命中，公司范围一律来自 session |
| `/api/admin/*` 与 `/api/audit/*` 越权 | **已正确保护**。两者都是 `router.use(requireAdmin)`，admin.js 另有「不能改/停用/删除其他 admin」三重检查 |
| operator 访问 `/api/data/*` | **已正确阻断**。`requireDataAccess` 只放行 `/sync-status`，fail-closed |
| 页面 HTML 内联拼接的 XSS | **无**。`server/index.js` 的 `pageRoutes` 在模块加载时一次性构建，全是常量，参数无一来自 `req` |
| 动态 UPDATE 语句 | **安全**。`admin.js:140-186` 的 `updates` 数组只 push 硬编码列名，值全走 `?` |
| Modal 显示类名 | **无问题**。没有任何 modal 用 `classList.add("open")`，全部用 `"show"`；唯一的 `"open"` 是 `#sidebar`，与 CSS 一致 |
| HELP TRF 字段映射 | **正确**。客户端 `splitHelpTrf` 与服务端 `mapAmountFields` 两侧一致（入账→`trf_amount`/`bank transfer`，出账→`help_amount`/`bank trf`），`assertTransferStatus` 会拒绝方向与状态不符 |
| 金额写入 NaN / null | **不可能**。客户端 `parseNum`/`parseOut` 用 `parseFloat` + `Number.isFinite`；服务端 `readLedgerAmounts` 对非有限值返回 400「金额必须是有效数字」 |
| 密码哈希 | **正确**。bcrypt cost 10，无明文比较 |
| 浮点漂移（现行路径） | **无**。余额每次从流水全量重算，比较取整到分，拆分校验用整数分，完整性用 0.02 容差。唯一的增量累加在死代码里 |
| 定时器叠加 | **不会**。导航是整页加载，公司切换不注册新 interval（但除 `startGlobalSyncWatcher` 外都从不清理） |
| 未处理的 promise rejection（服务端） | **无**。所有 async 路由都有 try/catch，scheduler 的 loop 内部 catch 完整 |
| 审计页前端转义 | **安全**。`audit-history.js` 的 `escAudit` 覆盖 `& < > "` 且调用完整，数字字段用 `Number()` 包裹 |
| 前端内联事件处理器 / `javascript:` URL | **无**。grep `onclick=` / `onerror=` / `javascript:` 零命中，事件全走 `addEventListener` |
| 审计表设计 | **扎实**。append-only 触发器（UPDATE/DELETE 均 RAISE ABORT）、凭证字段递归脱敏、`UNIQUE(company_id, dedupe_key)` 去重。`event_id` 全局自增，故 `GROUP_CONCAT` 子查询缺 `company_id` 不构成跨公司泄露 |

---

## 建议修复顺序

按「性价比 × 风险」排序，不是按严重度：

1. **`NODE_ENV=production` + 加全局 error handler**（B5）——两行改动，挡住堆栈泄露
2. **`commitRow` 新行也要重置 + 强制刷新表格**（B2）——这是会掉钱的，且改动局限在一个函数
3. **`/api/banks` 补 `requireCompany`，去掉 `banks.js:73` 的 session 回退**（H3）；同时给 status-options / c-status-options 的写操作加 `requireAdmin`（B1 的授权环节）
4. **`color` 服务端校验 hex + 渲染改用 CSS 自定义属性**（B1）
5. **`.gitignore` 加 `config.json` 与 `server/db/*.db*`**（B9）——若已进 git 历史，需清理并轮换凭证
6. **`data.js:170` / `:202` 抄 `:128` 的 clamp**（H6）——一行
7. **`bank_balance_log` 加 `company_id` + 改 `UNIQUE(company_id, tx_id)`**（B3）——需数据迁移，是「不能双计/漏计」的根
8. **`pruneStaleCustomers` 加熔断阈值 + 事务 + 要求「本次抓取未被截断」标记**（B4）——三家公司已逼近分页上限，时间窗在缩小
9. **把 `opts.quick` 判定改成 `lane === "fast"`，修 CLI 的 companyId**（H1）
10. **抽统一的驱动兼容层，删掉两份 `runAtomic` 副本，修 `companies.js:160`，`npm test` 跑双驱动**（B6 + B7）
11. **`api()` 加 401 跳转 + AbortController 超时**（B8）；session 加 store / `secure` / `sameSite` / `trust proxy`；登录加限流（H7 / H8）
12. 其余按需

---

## 配套：数据核对脚本

已新增 [scripts/audit-data-integrity.js](../scripts/audit-data-integrity.js)——**只读**，不做任何订正。

```bash
node scripts/audit-data-integrity.js
```

七项检查，其中第 1 项是 B2 双计的**唯一有效检出手段**（因为余额对账查不出来）。

**2026-09-24 基线**（修复后复跑应与此对比）：

| 检查项 | 命中 | 说明 |
|---|---|---|
| 1. 疑似重复录入的手工流水 | **0** | B2 尚未造成实际损失（但最近一条手工流水是 8-19，样本期短） |
| 2. 跨公司 tx_id 撞号 | **1** | `17027429560`（aussiex6 / ezspin68），尚未进入 `bank_balance_log` |
| 3. 孤儿流水（`bank_account_id=0`） | 6 组 / 37 条 | 其中 33 条是自动生成；aussiex6 占 in $988 + trf $1500.90 + help $202.24 |
| 4. `bank_balance_log` 账户归属异常 | 26 条 | 全部是「无账户归属」，合计 $1822.37，时间跨度 8-01 ~ 8-12 |
| 5. `company_id` 为空的记录 | 1 条 | 一个支付渠道 |
| 6. 余额与流水净额不一致 | **0** | 回归基线。注意此项通过**不代表**没有双计 |
| 7. 同公司内重复手机号 | 5 组 | 前提条件「`customer_id` 为空的交易」= **0 条**，故风险未激活 |

脚本已验证对数据库零写入（运行前后 `trader.db` 与 `-wal` 的字节数和时间戳完全一致）。

---

## 附录：本次审查方法

- 三路并行审查（数据准确性 / 路由安全 / 前端运维），结果再由主审逐条复核
- 关键论断在真库（只读）或隔离环境实测，包括：`node:sqlite` 的事务 API 缺失、嵌套 `runAtomic` 的实际回滚行为、`LIMIT` 各种取值的真实结果、跨公司 tx_id 撞号、余额与流水的逐账户核对
- **两条子审查结论被复核推翻或降级**（跨公司 C STATUS 泄露、mobile 回退 JOIN），一条机制描述被修正（`LIMIT NaN`），一条严重性被下调（嵌套事务是完整回滚而非半更新）——标注 `[待验证]` 的条目尚未经过这一层复核
- 未做：渗透测试、压力测试、浏览器端实际操作验证
