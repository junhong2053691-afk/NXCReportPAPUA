---
name: NXC Report
description: 多公司操盘账房后台——精密、密集、数字为主角
colors:
  ledger-blue: "#1768e5"
  ledger-blue-hover: "#0f56c4"
  ledger-blue-ink: "#0d4ba6"
  settled-green: "#0b7a55"
  alert-red: "#c43d4d"
  caution-amber: "#a95a0a"
  bonus-violet: "#7650b5"
  commission-teal: "#067a8b"
  mist-paper: "#edf2f7"
  mist-paper-deep: "#e6ecf3"
  sheet-white: "#ffffff"
  ink: "#17202c"
  ink-soft: "#4e5d70"
  ink-muted: "#6c7a8c"
  night-bg: "#10151c"
  night-bg-deep: "#0b1016"
  night-surface: "#202833"
  night-ink: "#f1f5f9"
  night-blue: "#6ba2f8"
typography:
  page-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Segoe UI, Microsoft YaHei, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.2
  kpi-value:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Segoe UI, Microsoft YaHei, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.1
    fontFeature: "tnum, lnum"
  panel-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Segoe UI, Microsoft YaHei, sans-serif"
    fontSize: "16px"
    fontWeight: 700
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Segoe UI, Microsoft YaHei, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  table-cell:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Segoe UI, Microsoft YaHei, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Segoe UI, Microsoft YaHei, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.35
  mono:
    fontFamily: "SFMono-Regular, SF Mono, Cascadia Code, Roboto Mono, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  pill: "999px"
spacing:
  3xs: "2px"
  2xs: "4px"
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "16px"
  2xl: "24px"
  3xl: "32px"
components:
  button-default:
    backgroundColor: "{colors.sheet-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "6px 14px"
    height: "36px"
  button-primary:
    backgroundColor: "{colors.ledger-blue}"
    textColor: "{colors.sheet-white}"
    rounded: "{rounded.sm}"
    padding: "6px 14px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.ledger-blue-hover}"
  button-compact:
    rounded: "{rounded.sm}"
    padding: "4px 10px"
    height: "32px"
  input:
    backgroundColor: "{colors.sheet-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "6px 11px"
    height: "36px"
  card:
    rounded: "{rounded.md}"
    padding: "14px"
  table-header:
    textColor: "{colors.ink-soft}"
    typography: "{typography.label}"
    padding: "10px 12px"
  table-cell:
    textColor: "{colors.ink}"
    typography: "{typography.table-cell}"
    padding: "10px 12px"
  badge:
    rounded: "{rounded.pill}"
    padding: "3px 7px"
    height: "24px"
---

# Design System: NXC Report

> 本文件由 `/impeccable document` 于 2026-11-09 从 `public/css/style.css` 反推，并在同日 UI 精修
> （`.scratch/ui-polish/decisions.md`，提交 d74fd31 → 611efe6）落地后刷新。字号与控件高度已收进刻度；
> 间距、圆角仍有漂移，见「Do's and Don'ts」末尾的「剩余漂移」。

## Overview

**Creative North Star: "精密账房"**

NXC Report 是一本摊开在屏幕上的账簿。数字是主角：充值、提现、余额、差额，每一个都要经得起对账，所以界面的第一职责是让数字**对齐、可扫读、不抢戏**。密度高但不挤——操盘手一屏要看十四列流水、四个 KPI、一排银行，任何多余的留白或放大都是在浪费他们的视线。

材质上，后台内页是一层冷灰蓝的「雾面纸」（`#edf2f7` 底 + 两团极淡的蓝绿光晕），上面浮着半透明的玻璃面板（`backdrop-filter: blur(28px)`），面板内是实底的表格与控件。这套玻璃质感是现任视觉的一部分，**本轮精修保留不动**（用户 2026-11-09 确认）；登录页另有自己的世界，见 `.impeccable/surfaces/public-login-html.md`。

色彩克制：一个账本蓝负责「可操作 / 当前」，绿与红只用来表达钱的方向（入 / 出、正 / 负），琥珀表达「需要人看一眼」。亮暗两套主题共用同一组语义 token，暗色下所有色相提亮、阴影加深。

**Key Characteristics:**
- 数字一律 `tabular-nums`，金额列右对齐，等宽字体只给单号与余额。
- 三层结构：雾面纸底 → 玻璃面板（卡片、表格外壳、侧栏、筛选条）→ 实底控件。
- 绿 = 入 / 正，红 = 出 / 负，琥珀 = 待人处理；蓝只给交互与当前状态。
- 手机 ≤700 是一套独立的触控密度（44px 目标、卡片 + 底部抽屉、底部标签栏）。

## Colors

冷灰蓝雾面中性色 + 一个账本蓝 + 三个只表达「钱的方向与状态」的语义色。

### Primary
- **账本蓝 Ledger Blue** (`ledger-blue`)：主按钮、当前导航项、选中页签、链接、焦点环、加载进度条。暗色下换成更亮的 `night-blue`。悬停用 `ledger-blue-hover`，承载文字（链接、选中标签）用更深的 `ledger-blue-ink` 保证对比度。

### Secondary
- **结清绿 Settled Green** (`settled-green`)：入账金额、正数、成功提示、DEPOSIT 徽章。
- **警示红 Alert Red** (`alert-red`)：出账金额、负数、删除 / 封禁按钮、错误、待审批角标。

### Tertiary
- **待办琥珀 Caution Amber** (`caution-amber`)：需要人处理但不是错误（同步警告、MANUAL、未设置实时收款）。
- **奖励紫 Bonus Violet** (`bonus-violet`) 与 **佣金青 Commission Teal** (`commission-teal`)：只用于交易类型徽章（BONUS / COMMISSION）与 HELP TRF KPI，不扩散到别处。

### Neutral
- **雾面纸 Mist Paper** (`mist-paper` → `mist-paper-deep`)：页面底，145° 线性渐变 + 两团 22% / 16% 的蓝绿径向光晕。
- **账页白 Sheet White** (`sheet-white`)：控件与实底面板；玻璃面板是它的 54%–94% 透明度变体。
- **墨 Ink** (`ink`)：正文与数字。**淡墨 Ink Soft** (`ink-soft`)：表头、标签、次要按钮文字。**灰墨 Ink Muted** (`ink-muted`)：说明、占位、时间戳。
- 边框是 18% / 28% 透明度的墨色，不用实色线。
- 暗色：`night-bg` → `night-bg-deep` 底、`night-surface` 实底、`night-ink` 正文。

### Named Rules
**The Money Has Direction Rule.** 绿与红只表达钱的方向或正负，绝不用来装饰、分组或表示「好看的强调」。
**The One Blue Rule.** 蓝色只出现在可点的、或「你现在在这里」的元素上。

## Typography

**Body Font:** 系统 UI 字体栈（`-apple-system, SF Pro Text, PingFang SC, Segoe UI, Microsoft YaHei`）
**Label/Mono Font:** `SFMono-Regular, SF Mono, Cascadia Code, Consolas`

**Character:** 不引入品牌字体，靠系统字体在中英混排下的稳定与清晰；层级完全靠字号与字重建立，数字统一表格数字。

### Hierarchy
字号只有 8 档 token：`--text-2xs` 11 / `xs` 12 / `sm` 13 / `base` 14 / `lg` 16 / `xl` 20 / `2xl` 24 / `3xl` 32（`style.css` 里 98% 的 `font-size` 走 token）。

- **Page title** (700, 24px)：每页标题行左侧的 H1，一页一个，和侧栏页名一字不差；标题行右侧是同步状态 / 中 EN / 主题。
- **KPI value** (700, 24px, 1.1, tabular)：卡片里的大数字；首页主数字 32px；渠道卡片 20px。
- **Panel title** (700, 16px)：面板 / 图表区块标题；弹窗标题 20px。
- **Body** (400, 14px, 1.5)：`body` 默认；按钮 13px。
- **Table cell** (400, 12px, 1.4)：报表表格；当日流水 `.sheet-table` 豁免（10–12px）。
- **Label** (700, 11px, uppercase 可选)：表头、表单标签、徽章；≤700 时 `--text-2xs` 本身变成 12px，手机上没有 11px 的字。
- **口径说明**（400, 12px, 灰墨）：标题下一行，只讲数字怎么算。

### Named Rules
**The Tabular Rule.** 任何会和别的数字上下比较的数字都用 `tabular-nums lining-nums`；单号、账号、余额用等宽字体。
**The Dense-Grid Floor Rule.** `table-layout: fixed` 的流水表按 11/12px 算死了列宽（`.col-*`），字号上调会撑爆 14 列——密集档 10–13px 必须保留。

## Layout

- **外壳**：左侧悬浮侧栏 248px（1366 以下可收成 72px 图标栏），距视口 16px；主区左边距 = 侧栏宽 + 32px 间隙，内边距 16px，内容最大宽 1780px。**没有顶栏**：`.page-shell` 是两列网格，`pageLayout` 放进去的 `.page-actions`（同步状态 / 中 EN / 主题）排在第一行右侧；紧随其后的若是页头（`.page-toolbar` / `.page-header`）就排在左侧，不是页头则开关单独占一行。其余子元素横跨两列。
- **网格**：KPI 卡 flex 换行，每行最多 4 张、最后一行拉宽；3 / 5 / 6 / 9 张时每行 3 张；手机每行 2 张。公司卡片 `minmax(320px, 1fr)`。
- **限宽**：表单页（Telegram 设置、公司 / API 设置）内容区最大 960px 靠左；支付设置两张表并排，最大 1200px；报表与表格页铺满。
- **表格密度**：769–1500 宽度下报表格子左右内边距 8px（大屏 12px），18 列的顾客列表在 1366 下一屏放下。
- **间距节奏**（现状）：控件间 6–8px，面板内边距 14px，区块之间 12–14px，页头下 14px。设计意图是三段落差——密集网格 2–8px、结构层 10–16px、页级 24–32px——但实际声明是 128 种 padding 取值、29 种 gap 取值，没有落在刻度上。
- **断点**：决定只用三档 ≤700 / ≤1100 / 桌面（`.scratch/ui-responsive/decisions.md`），实际 CSS 里有 17 种 `@media` 宽度（700 ×16、768 ×6、900 ×3、720、460、980、960、1180、1300、1500 等）。
- **手机 ≤700**：侧栏变抽屉、底部五键标签栏、宽表变「卡片 + 底部抽屉」（`mobile-table-drawer.js`）、弹窗全屏、触控目标 44px。

## Elevation & Depth

混合式：雾面纸底 + **玻璃面板**（半透明 + `backdrop-filter: blur(28px) saturate(1.28)` + 顶部 52% 白色高光渐变 + 多层柔和投影）承担层次；面板内部的表格、控件是实底，靠细边框分隔。卡片悬停上浮 1px 并加深阴影。

### Shadow Vocabulary
- **xs** (`0 1px 2px rgba(26,37,51,.06)`)：按钮悬停、选中页签。
- **sm** (`0 8px 22px rgba(33,47,64,.08)`)：公司卡片、浮层小件。
- **md** (`0 2px 6px …, 0 12px 32px …`)：更多菜单弹层。
- **material** (`inset 高光 + 0 18px 44px + 0 2px 8px`)：所有玻璃面板的静止态；悬停换 **material-hover**。
- **lg / xl**：弹窗、抽屉。

### Named Rules
**The Glass Shell, Solid Core Rule.** 玻璃只做外壳（面板、侧栏、筛选条、表格外框）；表格单元格、输入框、按钮必须是实底，数字永远压在不透明的面上。

## Shapes

圆角刻度把「容器」和「控件」分成两个物种：控件 4 / 6 / 8px（徽章 4、输入与按钮 6、下拉 8），容器设计上是 12 / 16px（卡片面板 12、弹窗抽屉 16）。**现状偏差**：`--radius-lg` / `--radius-xl` 定义了但没人用，卡片、面板、弹窗、侧栏实际都是 8px，与按钮几乎同圆；另有 10px、5px、3px、20px 等散值。徽章、角标、状态胶囊用 999px 全圆。

## Components

### Buttons
可靠、略带触感：悬停上浮 1px，按下缩 0.98。
- **Shape:** 微圆角 (6px)
- **两档高度**（`--control-h` / `--control-h-sm`）：标准 36px 配 13px 字（`.btn`、`.btn-sm`、输入框、下拉、页签），紧凑 32px 配 12px 字（`.btn-xs`、电脑端表格行内按钮）。≤768 两档都是 44px。同一行的控件必须同档。
- **Default:** 实底白 + 顶部高光，墨色字 600，内边距 6px 14px；按钮里的 lucide 图标 16px。
- **Primary / Success / Danger:** 自上而下的同色系浅渐变（账本蓝 / 结清绿 / 警示红），白字；主按钮带一层 24% 主色的投影。
- **Outline:** 浅底 + 细边框 + 淡墨字，悬停加深边框。

### Chips / Segment tabs
- **Segment tabs:** 浅底托盘（4px 内边距、8px 圆角）里的一排透明按钮，标准档 36px、13px / 600、最小宽 36px；选中项变实底白 + 账本蓝字 + xs 阴影。
- **Badges:** 全圆胶囊、11px / 700、soft 底 + 同色字（绿 / 红 / 琥珀 / 紫 / 青）。计数角标是实心红底白字 20px 圆。

### Cards / Containers
- **Corner Style:** 8px（设计意图 12px，见 Shapes）
- **Background:** 玻璃（白 54% + 高光渐变 + blur），左上角一团 13% 账本蓝径向光晕
- **Shadow Strategy:** material → 悬停 material-hover
- **Border:** 1px 玻璃白描边
- **Internal Padding:** 14px；KPI 卡最小高 112px

### Inputs / Fields
- **Style:** 实底白 + 顶部高光、28% 墨色边框、6px 圆角、6px 11px 内边距、标准档 36px（日期 / 时间框写死 `height`，否则多 1px）。
- **Focus:** 边框变焦点蓝 + 3px 16% 焦点蓝光环。
- **Disabled:** 48% 透明度 + `not-allowed`。
- **Checkbox:** 电脑端统一 16px；手机沿用各自的触控尺寸。

### Tables
- **表头:** 吸顶、11px / 700 淡墨、10px 12px（笔记本 8px），半透明渐变底 + blur。
- **单元格:** 12px / 1.4、10px 12px（笔记本 8px）、最大宽 260px 允许断词；悬停整行染淡蓝。行内按钮用紧凑档。
- **合计行:** 吸底、600 字重、加粗上边框。
- **银行流水表 `.sheet-table`:** 独立的密集网格（14 列、`table-layout: fixed`、11–12px）。

### Navigation
- **侧栏:** 玻璃面板；导航项 44px 高、13px / 500 淡墨，悬停浅底，当前项账本蓝 soft 底 + 左侧 3px 蓝条；子级 40px、12.5px，带左侧细线缩进。
- **手机:** 侧栏改左滑抽屉；底部标签栏「菜单 / 流水 / 待处理 / 调钱 / 渠道」，当前页 `aria-current="page"` 高亮。

### KPI Card（签名组件）
雾面玻璃卡片、左上光晕；12px / 600 标签 → 24px / 700 表格数字 → 11px 说明。颜色类（`.green` / `.red` / `.orange` / `.purple` / `.blue`）只染数字。大数字前不挂「合计」之类的字样——标签已经说明了它是什么。

## Do's and Don'ts

### Do:
- **Do** 把金额右对齐并用 `tabular-nums`；单号、账号、余额用 `--font-mono`。
- **Do** 用 `:root` 的语义 token（`--text`、`--muted`、`--primary`、`--green`、`--red`）上色，亮暗主题自动跟随。
- **Do** 手机 ≤700 下保证触控目标 ≥ 44px。
- **Do** 租户数据（客户名、银行名、公司名、备注）加 `translate="no"`。
- **Do** 改了 `style.css` 同时换 `server/index.js` 里的 `?v=`。
- **Do** 字号只用 `--text-*` 8 档、控件高度只用 `--control-h` / `--control-h-sm`；新写死的 px 值就是新的漂移。
- **Do** 页名只在页头 H1 出现一次，并且和侧栏一字不差；标题下只留讲「数字怎么算」的口径说明。

### Don't:
- **Don't** 把绿 / 红用于钱的方向以外的任何含义（The Money Has Direction Rule）。
- **Don't** 让数字或输入框压在半透明面上（The Glass Shell, Solid Core Rule）。
- **Don't** 上调 `.sheet-table` 的字号而不重算 `.col-*` 列宽（The Dense-Grid Floor Rule）。
- **Don't** 在后台加科技蓝霓虹发光、粒子、星空（PRODUCT.md 品牌承诺）。
- **Don't** 新增断点档位。档位是 ≤700（手机）/ ≤768（触控：控件 44）/ ≤1100 / 桌面；`min-width: 769px` 只用作「非触控」守卫（表格行内紧凑按钮、勾选框），769–1500 的报表格子内边距 8px 是唯一记录在案的密度例外。

- **Don't** 加顶栏、眉题或重复页名的副标题（2026-11-09 刚拿掉）。

### 剩余漂移（UI 精修前 → 后，`style.css`）
| 维度 | 精修前用 token | 精修后用 token | 精修后唯一取值 |
|---|---|---|---|
| font-size | 1%（24 种） | **98%** | 17（剩下的是豁免的密集表 + token 本身） |
| font-weight | 98% | 98% | 7 |
| 控件高度 | 0%（38 / 39 / 40 / 41 / 42 / 44 混用） | 按钮 / 输入框 / 页签全部走 token | — |
| padding | 1% | 1% | 127 |
| gap | 1% | 1% | 30 |
| border-radius | 65% | 65% | 21 |
| @media 宽度 | 17 种 | 17 种 | — |

间距、圆角、断点这次刻意没动（范围只到尺寸与骨架），是下一轮精修的候选。
