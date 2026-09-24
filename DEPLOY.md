# trader-dashboard 部署与运维教程

> 适用项目：`C:\Users\junho\trader-dashboard`  
> Node.js ≥20 · Express · SQLite · 默认端口 **3000**  
> 公网入口：**Cloudflare Tunnel** · 可选 **VPS** 24/7 运行

---

## 一、整体架构

```text
用户浏览器 / 手机
        │
        ▼ HTTPS（Cloudflare 自动证书）
Cloudflare Edge（CDN + 防护）
        │
        ▼ cloudflared 隧道（加密，无需开 80/443 端口）
┌───────────────────────────────────────┐
│  你的机器（Windows 或 VPS）              │
│  ┌─────────────┐   ┌────────────────┐ │
│  │ cloudflared │ → │ Node :3000     │ │
│  └─────────────┘   │ trader-dashboard│ │
│                    └────────┬───────┘ │
│                             │         │
│                    SQLite trader.db   │
└─────────────────────────────┬─────────┘
                              │ HTTPS
                              ▼
                    盘方 Platform API
                    （需 IP 白名单）
```

**两种常见部署方式：**

| 方式 | 适合场景 | 优点 | 缺点 |
|------|----------|------|------|
| **A. 本机 Windows + Cloudflare** | 测试、临时给操盘手看 | 免费、改代码立刻生效 | 电脑要一直开着 |
| **B. VPS + Cloudflare** | 正式 24/7 运营 | 稳定、固定 IP、关机也能访问 | 每月 VPS 费用 |

---

## 二、前置准备

### 2.1 本机（Windows）需要

- Node.js 20+：`node -v`
- 项目依赖：`cd C:\Users\junho\trader-dashboard` → `npm install`
- cloudflared：已安装在 `C:\Program Files (x86)\cloudflared\cloudflared.exe`
- Cloudflare 账号（固定域名时需要，把域名 NS 指到 Cloudflare）

### 2.2 VPS（Linux）推荐配置

- Ubuntu 24.04，**2 GB RAM**（systemd unit 的 `MemoryMax` 设在 2500M）
- **节点选新加坡**：操作员在马来西亚 / 柬埔寨 / 印尼，录流水和审批是高频人工
  交互，那 100ms 是每次点击的体感；而同步是 6s/60s 的后台循环，延迟只影响
  每轮耗时，不影响任何人。提供商：Vultr / DigitalOcean / Linode 都有新加坡节点
- 固定公网 IP（盘方 API 白名单要用）
- **磁盘用 ext4 或 xfs，不要 btrfs / ZFS** —— CoW 与 SQLite 的原地更新是病态组合。
  若服务商给的是 btrfs，在放 `trader.db` **之前**对该目录 `chattr +C` 关掉 CoW
- 两个必须在应用首次启动**之前**做好的设置（时区、Node 22），见
  [deploy/README.md](deploy/README.md)

> **必须单实例。** `scheduler.js` 的 `timers` 是模块级进程内状态，`sync-state-*.json`
> 非原子写且无锁 —— 跑两个副本会抢写同一批状态文件并产生**重复入账**。
> 所以不要用会自动扩容或自动休眠的 PaaS，也不要用 PM2 的 cluster 模式。

### 2.3 盘方 API 白名单

后台同步数据时会从**运行 Node 的那台机器**访问盘方 API。

1. 打开盘方后台 → Manage API → 创建 Key  
2. **IP Address** 填运行服务的公网 IP（查：https://ifconfig.me）  
3. 勾选至少：`/users/getAllUsers`、`/transactions/getAllTransactions`、`Show Member Mobile`  
4. 凭证填进 `config.json` 或后台「公司 / API」页面

> 换机器、换 VPS、VPN 断线导致 IP 变了 → 同步会报 `Invalid Access!`，要去盘方改白名单。

**迁移前必须先问盘方三件事**，它们决定回滚窗口有多大：

1. 每家公司能否**同时**白名单两个 IP（家里出口 + VPS）？
2. 改白名单的**生效时间**（人工审批？几分钟？下一个工作日？）
3. 四家公司是同一个盘方后台还是四套独立对接？`companies` 表里四家的
   `api_url` 各自独立，所以很可能是四套流程、四次沟通

若只允许单 IP，**回滚耗时 = 盘方的 SLA**。那就别在周五晚上切。

**IPv6 是个隐蔽坑**：Node 的 fetch（undici）在双栈机器上可能走 IPv6 出口，而
白名单往往只有 IPv4 → `Invalid Access!`。记下 VPS 的 IPv4 **和** IPv6
（`curl -4 ifconfig.me` / `curl -6 ifconfig.me`），若盘方只收 IPv4，就禁用
IPv6 出口或给 Node 加 `--dns-result-order=ipv4first`。

切换后要**逐公司验证白名单真的生效了**（直接读 `companies` 表取凭证打最小请求，
不经过应用），看到 `Invalid Access` 就**不要启动服务** —— `runLane` 会把该公司
退避 300s → 1800s，你会以为"起来了在等"，其实它在睡觉。命令见
[deploy/README.md](deploy/README.md)。

---

## 三、方式 A：本机 Windows + Cloudflare（快速上线）

### 3.1 启动应用

```powershell
cd C:\Users\junho\trader-dashboard
npm start
```

浏览器打开 http://localhost:3000 确认能登录。

### 3.2 临时公网链接（Quick Tunnel）

适合：演示、临时给同事看。**每次 URL 会变，关窗口就失效。**

```powershell
# 新开一个 PowerShell 窗口，先确保 localhost:3000 在跑
$env:TUNNEL_EDGE_IP_VERSION = "4"
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000 --edge-ip-version 4
```

终端会出现：

```text
Your quick Tunnel has been created! Visit it at:
https://xxxx-xxxx.trycloudflare.com
```

把这个 `https://...trycloudflare.com` 发给操盘手即可。

**常见报错：**

| 报错 | 处理 |
|------|------|
| `DNS local resolver ... i/o timeout` | 多为 VPN 干扰；关 VPN 或加 `--edge-ip-version 4` |
| `Cannot determine default origin certificate` | Quick Tunnel 可忽略；命名隧道才需要 `tunnel login` |
| 页面 502 | Node 没跑或端口不是 3000 |

### 3.3 固定域名（命名隧道）

适合：长期固定地址，如 `dash.yourdomain.com`。

**第一步：登录 Cloudflare**

```powershell
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel login
```

浏览器授权后，会在 `%USERPROFILE%\.cloudflared\cert.pem` 生成证书。

**第二步：一键配置（推荐）**

```powershell
cd C:\Users\junho\marketing-bot
.\setup-cloudflare-tunnel.ps1 -Hostname "dash.yourdomain.com" -TunnelName "trader-dashboard" -Port 3000
```

**第三步：启动隧道**

```powershell
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel run trader-dashboard
```

**第四步：安装为 Windows 服务（开机自启）**

```powershell
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" service install
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" service start
```

Node 应用也要设成开机自启（见下文「Windows 计划任务」）。

---

## 四、方式 B：VPS + Cloudflare（推荐生产）

### 4.1 初始化 VPS

```bash
# SSH 登录
ssh root@你的VPS_IP

# 基础环境
apt update && apt upgrade -y
apt install -y curl git build-essential

# Node.js 22（NodeSource）—— Node 20 已 EOL，不要再用
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v   # 应为 v22.x

# 备份与运维要用到
apt install -y sqlite3 age jq

# 时区：必须在应用首次启动【之前】设好。
# server/lib/dates.js 用 Date.parse 解析平台返回的【不带时区】的时间戳，按服务器
# 本地时区处理 —— VPS 默认 UTC 会让所有交易归错日期，verifyDaySync 永久 mismatch
# 并无限触发 repair。Node 启动时会缓存 TZ，运行中改对已跑起来的进程不可靠。
timedatectl set-timezone Australia/Sydney
timedatectl                # 确认 Time zone: Australia/Sydney (AEST, +1000)

# 确认 ICU 完整（dates.js 全靠 Intl 的 Australia/Sydney）
node -e "console.log(new Date('2026-09-15T12:34:54+00:00').toLocaleDateString('en-CA',{timeZone:'Australia/Sydney'}))"
# 期望输出 2026-09-15；异常或抛错说明 ICU 不完整，换官方 tarball 版 Node

# journald 上限（小盘 VPS 上无限增长会吃满磁盘）
sed -i 's/^#\?SystemMaxUse=.*/SystemMaxUse=2G/' /etc/systemd/journald.conf
sed -i 's/^#\?MaxRetentionSec=.*/MaxRetentionSec=30day/' /etc/systemd/journald.conf
systemctl restart systemd-journald
```

> Node ≥ 22 会让 `server/db/init.js` 选用内置 `node:sqlite` 而非 better-sqlite3，
> 两者 API 有差异（相关兼容问题已在代码里处理）。要知道：**`npm test` 跑的是
> better-sqlite3 路径，测试全绿不代表生产路径没问题。**

### 4.2 上传项目

**方法 1：Git（推荐）**

```bash
# 建专用系统用户与目录（详见 deploy/README.md）
useradd --system --home-dir /opt/trader-dashboard --shell /usr/sbin/nologin trader
mkdir -p /opt/trader-dashboard /etc/trader-dashboard \
         /var/lib/trader-dashboard/state /var/backups/trader-dashboard
chown -R trader:trader /opt/trader-dashboard /var/lib/trader-dashboard /var/backups/trader-dashboard
chown root:trader /etc/trader-dashboard && chmod 0750 /etc/trader-dashboard

# 用 trader 身份 clone（别 root clone 再 chown，容易漏掉 .git/）
sudo -u trader git clone <你的私有库地址> /opt/trader-dashboard
cd /opt/trader-dashboard
sudo -u trader npm ci --omit=dev
```

> better-sqlite3 自带 `prebuilds/linux-x64.node`，**零编译零联网**即可用。

**方法 2：本机 scp 打包上传**

```powershell
# 在本机 PowerShell（排除 node_modules）
cd C:\Users\junho
tar -czf trader-dashboard.tar.gz --exclude=node_modules --exclude=.git trader-dashboard
scp trader-dashboard.tar.gz root@VPS_IP:/opt/
```

```bash
# VPS 上
cd /opt && tar -xzf trader-dashboard.tar.gz
cd trader-dashboard && npm install --production
```

### 4.3 配置文件

生产配置放在 `/etc/trader-dashboard/config.json`（由 systemd 的 `TRADER_CONFIG`
指定），**不在代码目录里** —— 代码目录在生产是只读挂载的。

用仓库里的 `config.example.json` 做模板（32 个键，敏感字段已置为 `__FILL_ME__`）。

**不要 scp，不要粘到聊天软件。** 用 ssh stdin：

```bash
# 在本机（注意命令前的空格，避开 shell history）
 cat config.prod.json | ssh trader@VPS_IP 'sudo tee /etc/trader-dashboard/config.json > /dev/null'
```

```bash
# VPS 上收紧权限
chown root:trader /etc/trader-dashboard/config.json
chmod 0640 /etc/trader-dashboard/config.json
```

相对本机 `config.json` 必改的项：

| 字段 | 生产值 | 原因 |
|---|---|---|
| `sessionSecret` | **全新 48 字节随机** | 旧值可能出现在日志、截图或对话里；换掉等于强制所有旧 session 失效 |
| `admin.password` | **全新强密码** | 登录零限流 + 密码策略只要求 4 位，公网暴露后是字典攻击面 |
| `maxPages` | **1200**（已改，别调回 500） | 500 页 × 200 = 10 万客户上限，而 pokies7bet 已有 74,794（374 页）。触顶时 `fetchAllPages` 会**正常退出不报错**，`apiIds` 残缺 → `pruneStaleCustomers` 删掉真实客户 |
| `platform.*` | **整段可以删掉** | `services/platform.js` 优先从 `companies` 表读凭证，config 里的回落只对 `aussiex6` 生效。留着等于多一份明文凭证 |
| `host` | **不要写这个字段** | 留空即绑 127.0.0.1。写了会让服务暴露在公网 IP 上，绕过隧道 |

### 4.4 用 systemd 守护进程

**不要用 PM2。** 这个应用必须单实例（见 2.2），而 PM2 的 cluster 模式只要配错一个
参数就会跑起两套同步循环并产生重复入账；systemd 天然单实例，也不需要全局 npm
依赖，日志进 journald 自带轮转。

unit 文件在仓库里，安装与逐项说明见 **[deploy/README.md](deploy/README.md)**：

```bash
cd /opt/trader-dashboard
install -m 0644 deploy/trader-dashboard.service /etc/systemd/system/
command -v node                    # 必须是 /usr/bin/node，否则改 unit 里的 ExecStart
systemd-analyze verify /etc/systemd/system/trader-dashboard.service
systemctl daemon-reload
systemctl enable --now trader-dashboard
journalctl -fu trader-dashboard
```

启动后按顺序盯这三条：

```
[scheduler] per-company parallel loops — fast 6s / slow 60s   <- migration 已跑完的精确标记
[scheduler] start loops for <四家公司>                          <- 四家都在
[trader-dashboard] http://127.0.0.1:3000                       <- 端口已开
```

> **`systemctl status` 显示绿色 ≠ 服务可用。** `Type=simple` 在进程 fork 的瞬间就报
> active，端口要等 migration 跑完才开 —— 本机实测 208MB 库上约 10 秒。这 10 秒里
> 外网会看到 Cloudflare 502，属正常。

**首次启动后必须查一次** `journalctl -u trader-dashboard --since "5 min ago" | grep '\[db\]'`：
migration 里有 9 处 `catch { console.warn }`，失败是**静默**的（服务照样起来，只是某
列没建好，然后在第一个请求上报一个诡异的 SQL 错误）。**任何 warn 都按部署失败处理。**

常用命令：

```bash
systemctl status trader-dashboard
journalctl -fu trader-dashboard          # 跟踪日志
journalctl -u trader-dashboard -n 200    # 最近 200 行
systemctl restart trader-dashboard
systemctl stop trader-dashboard
systemctl show -p NRestarts trader-dashboard   # 重启次数（频繁重启是故障信号）
```

### 4.5 VPS 上装 Cloudflare Tunnel

```bash
# 安装 cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
dpkg -i cloudflared.deb

# 登录（会打开浏览器链接，复制 URL 到本机浏览器完成授权）
cloudflared tunnel login

# 创建隧道
cloudflared tunnel create trader-dashboard

# 记下输出的 Tunnel ID，配置 DNS
cloudflared tunnel route dns trader-dashboard dash.yourdomain.com

# 写配置 ~/.cloudflared/config.yml
nano ~/.cloudflared/config.yml
```

```yaml
tunnel: <你的-Tunnel-ID>
credentials-file: /root/.cloudflared/<Tunnel-ID>.json

ingress:
  - hostname: dash.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

```bash
# 测试
cloudflared tunnel run trader-dashboard

# 安装为系统服务
cloudflared service install
systemctl enable cloudflared
systemctl start cloudflared
```

### 4.6 更新盘方 API 白名单

VPS 部署完成后，到盘方后台把 **IP Address** 改成 VPS 公网 IP。

---

## 五、日常运维（Daily Maintenance）

### 5.1 每日检查清单（2 分钟）

| 检查项 | 怎么做 | 正常状态 |
|--------|--------|----------|
| 网站能打开 | 浏览器访问公网 URL | 能登录、数据在刷新 |
| 同步正常 | 首页看「最后同步时间」 | 几分钟内有更新 |
| 今日数据 | 首页充值/提现数字 | 与盘方大致一致 |
| 进程存活 | 见下方命令 | node + cloudflared 都在跑 |

**Windows 检查：**

```powershell
curl.exe -s -o NUL -w "%{http_code}" http://localhost:3000
Get-Process node, cloudflared -ErrorAction SilentlyContinue
```

**VPS 检查：**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000
pm2 status
systemctl status cloudflared
```

### 5.2 每周维护

- 看磁盘空间（SQLite 会增长）：`server/db/trader.db`
- 备份数据库（见第六节）
- 看 Node / cloudflared 有没有新版本（非必须）
- 确认 `config.json` 里 admin 密码仍是强密码

### 5.3 重启服务（最常见操作）

**Windows：**

```powershell
# 停 Node
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force

# 重启应用
cd C:\Users\junho\trader-dashboard
npm start

# 若用 Quick Tunnel，另开窗口重新跑 cloudflared 命令
# 若用命名隧道服务：
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" service restart
```

**VPS：**

```bash
sudo systemctl restart trader-dashboard
# cloudflared 不用一起重启：它连不上源站会自己重试，node 起来后自动恢复
```

> 重启期间外网会看到约 10 秒 502（migration 跑完才开端口），属正常。
> 重启**不会**让操作员掉线 —— session 存在 `sessions.db` 里，不是内存里。

### 5.4 Windows 计划任务（本机 24/7 自启）

若应用不在 PM2 里，可用计划任务：

1. 任务计划程序 → 创建基本任务  
2. 触发器：**计算机启动时**  
3. 操作：启动程序  
   - 程序：`C:\Program Files\nodejs\node.exe`  
   - 参数：`server\index.js`  
   - 起始于：`C:\Users\junho\trader-dashboard`  

cloudflared 若已 `service install`，会随系统自动启动。

---

## 六、备份与恢复

> **绝对不要用 `cp` 或 `Copy-Item` 备份 SQLite。** 两个原因：
> 1. 运行中直接拷贝，拷出来的可能是**坏文件**（拷到一半数据库又写了）
> 2. 数据在 `.db` **和** `-wal` 两个文件里。只拷 `.db` 会**静默丢失** WAL 里的全部
>    数据 —— 本机当前 WAL 是 39MB。这是最容易发生、也最难发现的灾难
>
> 正确做法是 `VACUUM INTO`：它在源库上只开读事务（不停机、不加锁），产出的单个
> 文件**已整合 WAL**，而且顺带重建索引。本机实测 226MB + 39MB WAL → 208MB，约 6 秒，
> `integrity_check=ok`，行数与源库完全一致。

### 6.1 必须备份的文件

| 文件 | 说明 |
|------|------|
| `trader.db` | 全部业务数据。用 `VACUUM INTO` 导出，**不要**直接拷 |
| `config.json` | 配置与 API 凭证 |
| `sync-state-*.json` | 各公司同步水位。**不是"可选"** —— 丢了会导致所有水位归零，触发最长 365 天 / 2000 页的全量重拉，且日志里不会说明原因 |

**手动导出一份一致快照（Windows 或 VPS 都适用）：**

```bash
sqlite3 <库路径> "PRAGMA integrity_check;"                  # 必须输出 ok，不是 ok 就停下
sqlite3 <库路径> "PRAGMA wal_checkpoint(TRUNCATE);"
sqlite3 <库路径> "VACUUM INTO '/目标路径/trader-$(date +%Y%m%d).db';"
sqlite3 /目标路径/trader-*.db "PRAGMA integrity_check;"      # 验证产出物
```

**VPS 自动备份**：仓库里已有完整方案，用 systemd timer 每小时跑一次 ——
`VACUUM INTO` → 自检 → gzip → **age 加密** → 传 Cloudflare R2，保留 48 小时 + 21 天
+ 7 个月（约 4.1GB，在 R2 免费额度内）。安装步骤见
**[deploy/README.md](deploy/README.md)**，脚本是 `deploy/trader-backup.sh`。

> **加密不是可选的。** 库里有 23 万客户的姓名、手机号与完整资金流水。裸传对象存储
> 意味着 R2 token 泄露等于全量 PII 泄露，而那个 token 就明文躺在 VPS 的
> `rclone.conf` 里。用 age 非对称加密，**VPS 上只放公钥，私钥离线保管** ——
> 攻下 VPS 也解不开任何一份备份。

### 6.2 恢复

1. 停服务：`systemctl stop trader-dashboard`
2. 解密解压：`age -d -i <离线私钥> backup.db.gz.age | gunzip > trader.db`
3. **先验证再覆盖**：`sqlite3 trader.db "PRAGMA integrity_check;"` 必须输出 `ok`，
   并核对行数不低于基线（2026-09-24：customers 230148 / transactions 162493 /
   bank_ledger 568 / bank_tx_pending 6921 / audit_events 18507）
4. 覆盖 `/var/lib/trader-dashboard/trader.db`，并**删掉可能残留的 `-wal` / `-shm`**
5. 重启服务，按 4.4 的三条日志标记确认起来了

> 恢复出来的文件**没有 `-wal`** 是正常的：`VACUUM INTO` 产出的库 `journal_mode`
> 是 delete（新库默认），`applyDbPragmas` 会在首次打开时设回 WAL。

### 6.3 恢复演练（每月一次，写进日历）

**没验证过的备份等于没有备份。** 完整流程见 [deploy/README.md](deploy/README.md)。
关键技巧：恢复库里先 `UPDATE companies SET enabled = 0`，这样 `listEnabledCompanies()`
返回空数组，调度器只打印 `no enabled companies with API credentials` 而不发一个请求 ——
**零双同步风险**，可以安全地把恢复库真起一次。

验收标准四条，全绿才算这份备份有效：`integrity_check=ok` ＋ 五张表行数不低于上次
演练 ＋ `node scripts/audit-data-integrity.js` 无新增告警 ＋ 能登录并拉到
`/api/data/sync-status`。

---

## 七、修改与更新代码

### 7.1 改配置（不动代码）

| 改什么 | 在哪里改 | 要不要重启 |
|--------|----------|------------|
| 管理员密码 | `config.json` → `admin` 或后台「账号管理」 | 改 config 要重启 |
| 盘方 API | `config.json` 或「公司 / API」页面 | 页面保存即时生效 |
| 同步频率 | `config.json` 里 `syncIntervalSeconds` 等 | 要重启 |
| 时区 | `config.json` → `timezone` | 要重启 |

改完 `config.json` 后重启 Node。

### 7.2 改前端 / 后端代码

**本机开发流程：**

```powershell
cd C:\Users\junho\trader-dashboard

# 语法检查
node --check server/index.js

# 改完后重启
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
npm start
```

**VPS 更新流程（Git）：**

```bash
cd /opt/trader-dashboard
git pull
npm install --production
pm2 restart trader-dashboard
```

**注意：**

- 改 `public/js/*.js` 或 `server/index.js` 里的 HTML → 重启 Node 即可，用户浏览器 **Ctrl+F5** 强刷  
- 改同步逻辑（`server/services/sync.js`）前先看 `AGENTS.md` 里的约束  
- PowerShell 不要用 `&&`，用 `;` 分行  

### 7.3 改 Cloudflare / 域名

- 换子域名：改 `~/.cloudflared/config.yml` 的 `hostname`，重新 `tunnel route dns`  
- 加 Cloudflare Access（限制谁能访问）：Cloudflare Zero Trust → Access → 给 `dash.yourdomain.com` 加邮箱/OTP 验证  

---

## 八、故障排查

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| 公网打不开，本地可以 | cloudflared 挂了 | 重启 cloudflared / 检查隧道服务 |
| 502 Bad Gateway | Node 没跑 | `npm start` 或 `pm2 restart` |
| 同步全部失败 `Invalid Access!` | API Key 错或 IP 不在白名单 | 查 ifconfig.me，更新盘方白名单 |
| 重启后今日数据为 0 | 正常，等 fast-recovery（约 1–2 分钟） | 或手动触发同步 |
| `EADDRINUSE :3000` | 端口被占 | `netstat -ano \| findstr :3000` 杀 PID |
| VPN 开着隧道不稳定 | Surfshark 等干扰 DNS | 关 VPN 或固定用 `--edge-ip-version 4` |
| 页面 JS 报错 / 空白 | 文件曾被存成 UTF-16 | 重启 Node（会自动 `ensurePublicUtf8`） |
| VPS 内存爆 | SQLite + 多公司同步 | 升级 RAM 或减 `maxPages` |

**看日志：**

```powershell
# Windows：Node 输出在启动它的终端窗口
```

```bash
# VPS
pm2 logs trader-dashboard --lines 100
journalctl -u cloudflared -n 50
```

---

## 九、安全清单

**凭证**

- [ ] 改掉默认 admin 密码（登录零限流 + 策略只要求 4 位，公网上是字典攻击面）
- [ ] `sessionSecret` 用全新 48 字节随机值（旧值可能出现在日志、截图或对话里）
- [ ] 盘方 API Key 只开必要模块，IP 白名单只填 VPS 固定 IP
- [ ] `config.json` **不进 git**（已在 `.gitignore` 里，别用 `git add -f` 绕过）
- [ ] `server/db/*.db` 也不进 git（237MB + 23 万客户的手机号）
- [ ] 备份的 age **私钥离线保管**，VPS 上只放公钥

**服务器**

- [ ] `NODE_ENV=production`（否则 Express 把完整堆栈写进 HTTP 响应体）
- [ ] 应用只监听 `127.0.0.1` —— `curl http://<VPS公网IP>:3000/` 必须连接被拒
- [ ] `config.json` 里**没有** `host` 字段
- [ ] 时区是 `Australia/Sydney`（`timedatectl` 确认）
- [ ] session cookie 带 `Secure` + `HttpOnly` + `SameSite=Lax`（DevTools 里看）
- [ ] 重启服务后登录态不丢（验证 session store 生效）

**Cloudflare**（零代码，性价比最高的两项）

- [ ] Rate Limiting Rule：`POST /api/auth/login` → 5 次/分钟/IP。免费 plan 有 1 条
      额度，就用在这里 —— `bcrypt.compareSync` 阻塞事件循环，约 10 req/s 就能让
      整个服务连同四家公司的同步一起不可用
- [ ] Cloudflare Access 覆盖整个 hostname（Zero Trust，免费到 50 seats）

> Access **挡不住已经拿到 operator 账号的人**。相关提权路径（status-options 写操作
> 与 color 校验）已在代码层修掉，不要用 Access 代替它。

**运维**

- [ ] 备份 timer 已启用，且**至少完整走过一次恢复演练**（见 6.3）
- [ ] 知道 `pruneStaleCustomers` 的风险：看到日志里 `pruned stale customers:` 跟着
      四位数就立刻停服（客户数基线：14014 / 71601 / 74794 / 69739）
- [ ] 前端 CDN 依赖 `lucide@latest` **没有版本锁** —— 上游一次 breaking change 就会
      让所有页面图标同时消失。建议锁定具体版本（见 backlog）

---

## 十、命令速查

### Windows（本机）

```powershell
# 启动
cd C:\Users\junho\trader-dashboard; npm start

# 临时公网
$env:TUNNEL_EDGE_IP_VERSION="4"; & "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000 --edge-ip-version 4

# 固定隧道
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel run trader-dashboard

# 重启 Node
Get-Process node | Stop-Process -Force; npm start
```

### VPS（Linux）

```bash
systemctl restart trader-dashboard
journalctl -fu trader-dashboard                 # 跟踪日志
journalctl -u trader-dashboard -n 200           # 最近 200 行
systemctl restart cloudflared
curl -I https://dash.yourdomain.com

# 同步是否真的在工作（不碰 HTTP）
for f in /var/lib/trader-dashboard/state/sync-state-*.json; do
  echo "== $(basename $f)"; jq -c '{ok,accessDenied,at,transactions}' $f; done
sqlite3 -readonly /var/lib/trader-dashboard/trader.db \
  'SELECT company_id, COUNT(*) n, MAX(created_at) latest FROM transactions GROUP BY 1;'

# 数据体检（只读，不做任何订正）
node /opt/trader-dashboard/scripts/audit-data-integrity.js

# 手动跑一次备份
systemctl start trader-backup.service && journalctl -u trader-backup -n 40 --no-pager
```

---

## 相关文件

| 路径 | 用途 |
|------|------|
| [deploy/README.md](deploy/README.md) | **systemd / 备份 / Cloudflare 的完整安装与验证步骤** |
| `deploy/trader-dashboard.service` | systemd unit（每一项配置都有注释说明为什么） |
| `deploy/trader-backup.sh` | 每小时加密备份（VACUUM INTO → gzip → age → R2） |
| [docs/pre-launch-review-2026-09-24.md](docs/pre-launch-review-2026-09-24.md) | 上线前缺陷清单，开头有修复状态表 |
| [scripts/audit-data-integrity.js](scripts/audit-data-integrity.js) | 只读数据体检（七项检查，不做订正） |
| `config.example.json` | 生产配置模板（敏感字段为 `__FILL_ME__`） |
| `config.json` | 全局配置。**不在 git 里**；生产放 `/etc/trader-dashboard/` |
| `AGENTS.md` / `CLAUDE.md` | 开发约束与架构说明 |
| `server/db/trader.db` | SQLite 数据库。**不在 git 里**；生产放 `/var/lib/trader-dashboard/` |
| `C:\Users\junho\marketing-bot\setup-cloudflare-tunnel.ps1` | Windows 固定隧道一键脚本 |

---

## 两个日期提醒

- **2026-10-04 悉尼 DST 切换**（02:00 → 03:00）。`bank_ledger.entry_time` 存的是悉尼
  墙钟时间且**不带时区偏移**，`Date.parse()` 按服务器本地时区解析 —— 跳跃那一小时
  的时间在墙钟上"不存在"，回拨时"重复"。不是部署引入的问题，但会在上线后撞上
- **`bank_ledger` 同一张表里混了两个时区**：`created_at` 来自 `datetime('now')` 是
  **UTC**，`entry_time` 来自 `formatSydneyDateTime()` 是**悉尼时间**，两列都不带偏移，
  相差 10 小时。任何把它们放在一起比较或排序的地方都有 10 小时偏差

---

*最后更新：2026-09-24（VPS + systemd 方案、加密备份、时区与单实例约束）*
