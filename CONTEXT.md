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
