# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **操盘手 / 内部员工**：每天登录干活——看实时充值提现、审批待入账流水、维护支付渠道与账单、处理余额报警。办公室电脑大屏为主，也会在路上、家里、半夜收到 Telegram 报警后用手机登录看一眼。
- **老板 / 股东**：偶尔登录看报表与对平结果。
- **合作方 / 外部客户**：系统可能提供给其他公司使用，登录页是对外门面。

## Product Purpose

NXC Report 是多公司操盘后台：从各公司平台 API 同步充值、提现与客户数据，提供实时看板、报表、客户分群，以及支付渠道与账单流水管理。成功 = 每家公司的钱一笔不漏、一笔不重，跨公司往来能对平，余额异常第一时间有人知道。

## Positioning

不是通用 BI，而是一套「操盘账房」：同步只进待审批队列、必须人工审批才入账；跨公司 C STATUS 往来按双方口径互相对平；渠道余额越过阈值即推送 Telegram、回落后自动撤回提醒。多家公司在同一套后台里彼此数据隔离。

## Operating Context

- 时区 Australia/Sydney，币种 AUD；4 家公司在用（具体名称属于租户数据，不出现在公开页面）。
- 工作节奏：fast lane 约 6 秒刷新当日交易，审批与对账在后台手动完成；报警走每家公司各自的 Telegram Bot。
- 登录页在未登录状态下展示，**不能出现任何真实数据**。

## Capabilities and Constraints

- 原生 HTML/CSS/JS，无前端框架；页面脚本放 `public/js/`，第三方库锁版本放 `public/vendor/`。
- CSP `script-src 'self'`：禁止内联脚本、`on*` 属性、CDN 脚本；`style-src` 允许 inline；`img-src 'self' data:`；`font-src 'self'`（字体必须自托管）。
- 亮 / 暗主题：`:root[data-theme]`，偏好存 `localStorage["dash-theme"]`。
- 中英切换：`public/js/i18n.js` 字典，从中文原文翻译，不做子串替换。
- 登录表单的 id（`login-form` / `username` / `password` / `password-toggle` / `login-submit` / `error`）被 `login.js` 依赖，不能改。

## Brand Commitments

- 产品名 **NXC Report**（2026-11 起，原「操盘手后台」）。
- Logo（深蓝斜切 NXC 字母 + 轨道光点 + 加宽字距的 REPORT）保留不改；资源在 `public/brand/`，原图在 `design-system/brand/`。
- 登录页整体配色**不必**跟随 logo 的蓝色科技风（用户确认，2026-11-07）。
- 用户明确不要：科技蓝发光（深色底 + 霓虹光带 / 粒子 / 星空）、玻璃卡片 + 渐变、影响登录的花哨动效。

## Evidence on Hand

- 品牌资源：`public/brand/nxc-icon.png`、`apple-touch-icon.png`、`favicon-32.png`；`design-system/brand/nxc-wordmark.png`（白底，非透明）、`nxc-icon-source.png`。
- 没有客户证言、案例、指标数据可以公开引用；登录页不得编造客户、数字或宣传主张。演示性内容必须标注为演示。

## Product Principles

1. 数据准确高于一切——不双计、不漏计，界面上的每个数字都要经得起对账。
2. 人在回路：钱进账本必须有人审批，系统负责提醒而不是替人做决定。
3. 公司之间严格隔离，公开界面不暴露任何租户信息。
4. 安静可靠：报警克制（不循环响），信息给到够用即止。
