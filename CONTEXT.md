# CONTEXT — 领域术语表

本文件只记**词的定义与口径**，代码结构见 `CLAUDE.md`。同一个词在不同页面口径不同时，两边都写在这里。

## 月报（MONTHLY REPORT › REPORT）

数据源只有 `bank_ledger`（已审批流水，HELP TRF 计入，按 `entry_time` 悉尼墙上时间分日），
只看当前公司，仅 admin 可见。口径实现只有一份：`server/lib/monthlyReport.js`。

| 术语 | 定义 |
|---|---|
| **DEP / TOPUP** | 状态 `deposit` + `new` + `amopay` 的入账金额（`amount_in + |trf_amount|`，与日报的 `inTotal` 同算法）。TOPUP 就是 DEP。**不含 `unclaim`** |
| **WD** | 状态 `withdraw` 的出账金额（`|amount_out| + |help_amount|`），显示为正数 |
| **WIN/LOSE** | `DEP − WD`，站在公司角度：正 = WIN（公司赚），负 = LOSE。**不扣** WRONG / EXPENSES |
| **WIN RATE** | `WIN/LOSE ÷ DEP`；DEP = 0 时为「—」。合计行用合计相除，**不是**每日百分比的平均 |
| **UNCLAIM** | 状态 `unclaim` 的入账金额，单列，不进 DEP |
| **WRONG** | 状态 `wrong` 的出账金额（转账 / 操作失误亏损），正数显示 |
| **EXPENSES** | 状态 `expenses` 的出账金额（开销）**+ 当天的封禁户余额变动**（见下文「封禁户余额」），正数显示；从封禁户收回钱的日子可能是负数 |
| **DEP单 / WD单** | 上面 DEP 那组状态 / `withdraw` 中金额 > 0 的笔数 |
| **总单** | DEP单 + WD单 |
| **UNIQUE CUST** | 当天有 DEP 流水的不同 `username` 数（当天充值顾客数）。按 `TRIM` 后原样比较，区分大小写，与日报一致 |
| **合计行** | 所有列都是每日相加（UNIQUE CUST 因此是人次，不是去重人数）；只有 WIN RATE 用合计相除 |

年视图：每月一行，各列为该月合计（同上口径），末行年合计。

## 与「支付渠道」日报的口径差（刻意不一致，别去「修平」）

`server/lib/bankReport.js` 的 `computeBankDailyReport` 对应运营的 Excel，口径不同：

| 指标 | 日报 | 月报 |
|---|---|---|
| DEPOSIT 金额 | `deposit + new`（**不含 `unclaim`**，UNCLAIM 单列） | `deposit + new + amopay` |
| DEP COUNT | `deposit + amopay` | `deposit + new + amopay`（与金额同一组） |
| UNIQUE CUST | 当天任何带 username 的流水（含提现）去重 | 只数 DEP 那组状态 |
| TRANSACTION / 总单 | TRANSACTION = `deposit` / `amopay` / `withdraw` **以外**的所有流水笔数（带不带 username 都算；2026-11-10 按 Excel 确认） | 总单 = DEP单 + WD单（正好相反：只数充值提现） |
| WIN/LOSE | `TOTAL WIN/LOSE` = DEPOSIT + WITHDRAW（`totals.win_loss`，WITHDRAW 是负数），显示在 REPORT 最底下 | `DEP − WD`，DEP 含 amopay |

同一天两个页面的 DEPOSIT 数字不一样是**对的**。要统一须先和运营对齐 Excel。

日报 REPORT 的 **EXPENSES 同样含封禁户余额变动**（负数显示，与月报逐分相等），但**笔数只数 `expenses` 流水**——
卡住的钱不是一笔流水。数字下面另起一行「其中封禁 X」，接口字段是 `totals.blocked_expense` / reportPairs 的 `leftBlocked`。

日报 REPORT 里另外三条看着像 bug、其实是 Excel 口径（2026-11-06 与运营确认，`daily-report-status.test.js` 守着）：
**GIVE BACK** 单独一行、负数；**EXCHANGE** 显示正数（换钱总额），与其他出账类不同号；
**REDEP** 只记笔数，手工录的 REDEPOSIT 入账金额只进余额、不进任何汇总行。

## 封禁户余额（计入 EXPENSES）

2026-11-09 用户定：**封禁里的银行数额一律视作 expenses**。只改报表口径，**不写任何流水**。
实现只有一份：`server/lib/blockedExpense.js`，日报与月报共用，测试 `blocked-expense.test.js`。

| 术语 / 规则 | 定义 |
|---|---|
| **卡住的钱 stuck(X)** | X 日结束时处于封禁 / 归档的户，各自累计余额（`entry_time <= X 23:59:59`）之和 |
| **封禁 EXPENSES(D)** | `stuck(D) − stuck(D−1)`：封禁当天 +余额；之后「转出余额」那天 −转出数；解封当天 −全部；归档 / 取消归档不变 |
| **封禁日** | 按 `bank_account_events`（banned / unbanned / archived / unarchived）回放；`created_at` 是 UTC，换成实例时区的日期 |
| **老户** | 没有任何生命周期事件、但现在是封禁 / 归档的户：视作一直封禁，每天的流水净额落在当天。事件回放终态与当前状态不符时，在最后一个事件日补一次转换 |
| **PG** | 不算。PG 的钱本来就不是自有资金 |
| **每日归零** | 忽略，用累计余额（与归档闸门、`/blocked` 同问题：「这户里还卡着多少」） |
| **封禁户上记的 expenses 流水** | 已经在流水 EXPENSES 里，卡住的钱随之减少，不重复计 |

- 已封禁的老户**补记在各自的封禁日**，所以过去某些日子的 EXPENSES 会因此改变；改封禁户的旧流水也会改动旧日子。
- 恒等式 `全部 BALANCE + 累计封禁 EXPENSES = 全部的钱` **只对今天、且非每日归零户成立**：`total_balance` 用的是当前生命周期和当日口径。

## 往来账（MONTHLY REPORT › COMPANY EXPENSES）

名字叫 EXPENSES，但**和状态 `expenses` 无关**：记的是本公司与各 C STATUS 往来方之间「欠来欠去」的账。
不做对平、不读对方公司的数据（对平归「支付渠道」页的巡检）。只看当前公司，仅 admin 可见。
口径实现只有一份：`server/lib/companyExpenses.js`。

| 术语 | 定义 |
|---|---|
| **往来方** | 流水的 `c_status`（`TRIM` 后原样）。不按 status 过滤，`c_status` 为空的流水不进来 |
| **IN / OUT / NET** | 与「支付渠道」日报的 C STATUS 表**逐格同口径**：IN = `amount_in + |help_amount|`，OUT = `|amount_out| + |trf_amount|`，NET = IN − OUT（HELP TRF 与余额方向对调，见 `CLAUDE.md`） |
| **正负号** | NET **正 = 我方欠对方**，负 = 对方欠我方 |
| **列** | **C STATUS 是什么就是什么**，与「支付渠道」C STATUS 表同一份名单：选项按 `sort_order`，再补上流水里出现过但不在选项里的名字。不做任何隐藏，整列为 0 也照样显示（列位固定，粘到 Sheet 对得齐）；不想要的列去 C STATUS 设置里删。新往来方第一次被「调钱」用到时会自动存成选项，从此出现 |
| **合计行** | 每日 NET 相加；只给本期合计，**不给累计**（上线切换清过账本，切换前的欠款不在库里） |

月视图每天一行（当月所有日子），年视图每月一行，末行 TOTAL。导出表头用往来方原名。

## 推荐人月报（MONTHLY REPORT › TOP REFERRAL）

对照的是平台自己的 **Top Referrer Report**，所以数据源是平台同步的 `customers` + `transactions`，
**不是** `bank_ledger`（与 REPORT / COMPANY EXPENSES 不同源，数字不必对得上）。只看当前公司，仅 admin 可见。
周期是月 / 年（年 = 全年合计），日界按 `register_date_key` / `created_date` 日期键。
口径实现只有一份：`server/lib/topReferral.js`。

| 术语 | 定义 |
|---|---|
| **推荐人** | 下线客户的 `customers.referrer`（`TRIM` 后原样，区分大小写）。它存的是**名字**，不是 username；推荐人本人的手机号、上级推荐人刻意不显示（同名客户多，对不准） |
| **自然流量** | `referrer` 为空的客户。不参与排名，固定在列表底部单独一行 |
| **NEW MEMBER** | 本期注册的下线人数。**含** test 账号 |
| **FIRST DEPOSIT 人数 / 金额** | 首笔充值落在本期的下线；金额是**首笔那一单**。首笔看库里全部历史（按 `created_at`），不只看本期 |
| **FIRST DAY DEPOSIT 笔数 / 金额** | 上面这些人首充**当天**的全部充值 |
| **SAME DAY DEPOSIT 人数 / 金额** | 注册当天就首充、且那天在本期内的下线；金额是他们那一天的全部充值 |
| **REGULAR DEPOSIT 笔数 / 金额** | 本期充值中除首充当天以外的部分 |
| **TOTAL DEPOSIT 笔数 / 金额** | 本期全部充值 = FIRST DAY + REGULAR |
| **TOTAL WITHDRAW 笔数 / 金额** | 本期全部提现，**照平台显示为负数**（REPORT 页的 WD 是正数，别统一） |
| **TOTAL NET** | TOTAL DEPOSIT + TOTAL WITHDRAW |
| **test 账号** | username 或姓名含 `test`（不分大小写）的充值提现全部排除，判据与全站 WIN/LOSE（`winLoss.testUsernameSql`）同一份 |
| **交易归属** | 与全站 WIN/LOSE 同口径（`winLoss.customerJoin`）：先认 `customer_id`，为空时按手机号回退到客户 |
| **有动静** | 本期注册，或本期有充值 / 提现。没动静的推荐人不进排行，但搜索框里照样能选到（抽屉显示全 0） |

排行默认按 NEW MEMBER 从高到低，可切 首充人数 / TOTAL DEPOSIT / TOTAL NET；并列时依次比 NEW MEMBER、
首充人数、TOTAL DEPOSIT，最后按名字。TOTAL 行 = 全部推荐人 + 自然流量。平台的 MOBILE、AVG DAILY MEMBER
两列不做（后者算法反推不出来）。

**已知局限（首充）**：首充只能看库里有的交易。EZSPIN68 / POKIES7BET / ROLEX66 的客户最早 2023 年注册，
交易却 2026-05/06 才开始同步，所以同步开始前就充过值的老客户回来再充，会被算成本期首充（平台的 `dep_count`
大多是 0，没法校正）。AUSSIEX6 的客户与交易同期开始，不受影响。「推荐人榜」有同样的问题。

### 与「推荐人榜」（洞察 › 推荐人榜）的关系

推荐人定义相同（`customers.referrer`），其余都不同：推荐人榜是任意日期区间（≤ 90 天）、首充按日期而非首笔
那一单、净额走 `referrerNetTotals`。两页暂时并存，TOP REFERRAL 用顺手后再决定是否删推荐人榜。

## 两户互转（BANK TRF / BANK TRANSFER）

2026-11-12 需求访谈定下：**`bank trf` / `bank transfer` 只表示本公司自己两个户口之间挪钱**，永远不记 C STATUS。
跨公司的钱一律用别的状态（出 `cash out`、入 `cash in` 等）。

| 术语 / 规则 | 定义 |
|---|---|
| **两户互转** | 同一家公司的「从」户把钱转到「到」户。一笔互转 = 两条流水：「从」户 `bank trf` 出、「到」户 `bank transfer` 入，金额相同，C STATUS 空，同一个 `transfer_group_id`。总余额不变，不进 C STATUS 表和对平 |
| **从 / 到** | 两个都必须是本公司运营中的户，且不是同一户。系统**不替员工挑户**：「从」沿用当前选中的户，「到」由员工自己选 |
| **录入口** | 调钱弹窗：填负数金额、STATUS 选 `bank trf`。调钱入账（正数）**不再提供** `bank transfer`——它只作为互转的另一半自动产生。支付渠道页「转出封禁户余额 → 本公司户口」是同一种互转 |
| **调钱默认 STATUS** | 负数 `cash out`，正数 `cash in`（2026-11-12 前是 `bank trf` / `bank transfer`） |
| **转出封禁户余额 → 别家公司** | 记 `cash out` + C STATUS（2026-11-12 前记 `bank trf`） |
| **改一条** | 删除时两条一起删，从「最近删除」恢复任一条时两条一起恢复（11-12 审查后补上，之前只删一条）；改金额 / 户口只改那一条，不联动——要改就删了重录 |
| **老数据** | 规矩只管新录入。11-12 之前带 C STATUS 的 `bank trf` / `bank transfer` 原样保留，交易记录页照常可编辑 |

## 跨公司来单提醒

operator 停在 A 公司时，B 公司进了**平台待审批单**（`bank_tx_pending.state = 'pending'`），右上角滑下一条通知。
2026-11-09 需求访谈定下，实现在 `public/js/cross-company-alerts.js` + `server/lib/crossCompanyPending.js`，
测试 `cross-company-alerts.test.js` / `cross-company-pending.test.js` 每条断言对应下面一行。

| 术语 / 规则 | 定义 |
|---|---|
| **别家** | 该 operator 在 `user_companies` 里授权的公司，**不含当前公司**。每次轮询按库复核，撤权下一轮就消失 |
| **谁会收到** | 只有授权 ≥ 2 家的 operator。**admin 不弹**（产品决定，不是遗漏）；只授权一家的 operator 没有别家 |
| **一条通知** | 一笔单。标题 = 公司名，正文 = `充值 500.00 · user123`（类型、金额、会员 username）。**不放客户真名** |
| **显示上限** | 最新的 5 条；其余折成「还有 N 笔（Rolex66 3 · EzSpin68 2）」。点折叠条切去笔数最多的那家 |
| **手机（≤700）** | 显示上限是 0：全部折进**一条汇总条**「别家待审批 N / 公司 a 3 · 公司 b 2」，贴底栏上方（接单浮层打开时贴屏幕底）。点它、关掉它的规则就是折叠条的规则。只改显示，下面的已看过 / ack / 收起全部不变（2026-11-09 手机适配决定） |
| **点通知** | 切到那家公司，整页进 `/bank-ledger.html#pending`（接单区自动打开） |
| **收起** | 不自动消失。只有：点它 / 关掉它；那笔不再是 pending（别人审批或跳过了）；关掉折叠条（折进去的全收） |
| **已看过** | 每家公司**一组 tx 的 `bank_tx_pending.id`**（不是一个水位线：关掉 50 号不能吞掉还开着的 45 号），存 localStorage `cross-company-seen`，多标签页共享。只在两种情况记：点或关掉通知；**停在某家时，它当前全部 pending 自动记上**——所以切回别家后不会把刚处理剩下的再弹一遍 |
| **刷新 / 刚登录** | 没关掉、仍是 pending 的照样弹（第一次没有记录 = 积着的全弹） |
| **报警** | 每家别家一个 escalating alarm，规则同 `alarm.js` 的 `pending` 预设（2026-11-10 起：来单立刻响一遍 → 每 10 分钟一遍）、同一个 `platform-pending.mp3`。与当前公司报警**共用 key** `bank-pending-alarm:<公司>`，所以切公司不重置静默期 |
| **知道了（ack）** | 点开或关掉某家**任意一条**通知 = ack 那家（静默 20 分钟），别家照常计时 |

### 与「平台待审批报警」（当前公司）的关系

同一批单只有一条时间线：当前公司由 `app.js` 的 `platformPendingAlarm` 管，其余由本功能管，切公司时交接。
后台报警交出去时只 `dispose`，**绝不 `update("")`**——那会 `clearState` 把共用的 key 清掉。
