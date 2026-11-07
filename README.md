# NXC Report (trader-dashboard)

独立后台，供操盘手查看充值单、提现单、顾客动向。与 `marketing-bot` 分开运行。

## 快速开始

```powershell
cd C:\Users\junho\trader-dashboard
npm install
npm start
```

浏览器打开：http://localhost:3000

## 默认管理员

首次启动自动创建，在 `config.json` 修改：

账号和初始密码取自 `config.json` 的 `admin`（只在新库首次启动时写入）。

**已有库改密码用 `scripts/set-password.js`；生产环境检测到默认密码会拒绝启动。**

## 给操盘手开账号

1. 用 admin 登录
2. 左侧点「账号管理」
3. 点「+ 新建账号」
4. 填写自定义 **账号 ID**、**名称**、**密码**
5. 创建后点「复制」，发给操盘手

操盘手用你发的 ID + 密码登录即可。

## 账号规则

- 账号 ID：至少 2 位，可用字母、数字、`._-`
- 密码：至少 4 位
- 可随时改密、停用账号

## 项目结构

```
trader-dashboard/
├── config.json       # 端口、管理员、盘方 API
├── server/           # 后端 API
├── public/           # 网页界面
└── server/db/        # SQLite 数据库
```

## 下一步

- 在 `config.json` 填入盘方 API Key
- 接入 `/transactions/getAllTransactions` 同步充值/提现数据
