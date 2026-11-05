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
| **EXPENSES** | 状态 `expenses` 的出账金额（开销），正数显示 |
| **DEP单 / WD单** | 上面 DEP 那组状态 / `withdraw` 中金额 > 0 的笔数 |
| **总单** | DEP单 + WD单 |
| **UNIQUE CUST** | 当天有 DEP 流水的不同 `username` 数（当天充值顾客数）。按 `TRIM` 后原样比较，区分大小写，与日报一致 |
| **合计行** | 所有列都是每日相加（UNIQUE CUST 因此是人次，不是去重人数）；只有 WIN RATE 用合计相除 |

年视图：每月一行，各列为该月合计（同上口径），末行年合计。

## 与「支付渠道」日报的口径差（刻意不一致，别去「修平」）

`server/lib/bankReport.js` 的 `computeBankDailyReport` 对应运营的 Excel，口径不同：

| 指标 | 日报 | 月报 |
|---|---|---|
| DEPOSIT 金额 | `deposit + new + unclaim` | `deposit + new + amopay` |
| DEP COUNT | `deposit + amopay` | `deposit + new + amopay`（与金额同一组） |
| UNIQUE CUST | 当天任何带 username 的流水（含提现）去重 | 只数 DEP 那组状态 |

同一天两个页面的 DEPOSIT 数字不一样是**对的**。要统一须先和运营对齐 Excel。

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
