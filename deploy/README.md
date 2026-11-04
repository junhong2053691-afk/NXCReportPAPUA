# deploy/ — 生产部署文件

新加坡 VPS（Ubuntu 24.04）+ systemd + Cloudflare 命名隧道 + SQLite。

这个目录只放**部署产物**。完整的部署教程在 [../DEPLOY.md](../DEPLOY.md)，
上线前的缺陷清单在 [../docs/pre-launch-review-2026-09-24.md](../docs/pre-launch-review-2026-09-24.md)。

| 文件 | 装到哪里 |
|---|---|
| `trader-dashboard.service` | `/etc/systemd/system/` |
| `trader-backup.sh` | `/usr/local/bin/`（0755，root 所有） |
| `trader-backup.service` | `/etc/systemd/system/` |
| `trader-backup.timer` | `/etc/systemd/system/` |
| `../config.example.json` | 填好后放 `/etc/trader-dashboard/config.json` |

---

## 为什么是 systemd 而不是 PM2

这个应用**必须单实例**，这是硬约束而非偏好：

- `server/scheduler.js` 的 `timers` / `started` 是模块级进程内状态
- `sync-state-*.json` 是本地文件、**非原子写**、无锁

两个副本 = 两套同步循环抢写同一批状态文件 = **重复入账**。

systemd 天然单实例；PM2 的 cluster 模式只要配错一个参数就会破坏这个保证。
另外 systemd 不需要全局 npm 依赖，与 `cloudflared` 的管理方式统一，日志进
journald 自带轮转（可以顺手解决仓库根目录那 17 个无轮转 `.log` 文件的老问题）。

---

## VPS 基线（第一次登录后立刻做）

应用只绑 127.0.0.1，但服务器本身也在公网上。库里有全部客户数据，这几步不能省：

```bash
adduser deploy && usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh && cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh
# 另开一个窗口确认 ssh deploy@vps 能登录且能 sudo，再做下面这步，否则会把自己锁在外面

sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sshd -t && systemctl reload ssh

ufw default deny incoming && ufw default allow outgoing
ufw allow OpenSSH && ufw enable       # cloudflared 是出站连接，不需要开 80/443
apt install -y unattended-upgrades && dpkg-reconfigure -f noninteractive unattended-upgrades
```

---

## 目录约定

unit 文件里的三个 `TRADER_*` 环境变量与这套目录对应（定义见 `server/lib/paths.js`）：

```
/opt/trader-dashboard/              代码（git checkout，运行时只读）
/etc/trader-dashboard/config.json   凭证        root:trader 0640
/var/lib/trader-dashboard/          trader.db（+ -wal）
/var/lib/trader-dashboard/state/    sync-state-*.json / active-company.json / sessions.db
/var/backups/trader-dashboard/      备份暂存（用完即删）
```

```bash
sudo useradd --system --home-dir /opt/trader-dashboard --shell /usr/sbin/nologin trader
sudo mkdir -p /opt/trader-dashboard /etc/trader-dashboard \
              /var/lib/trader-dashboard/state /var/backups/trader-dashboard
sudo chown -R trader:trader /opt/trader-dashboard /var/lib/trader-dashboard /var/backups/trader-dashboard
sudo chown root:trader /etc/trader-dashboard
sudo chmod 0750 /etc/trader-dashboard
```

---

## 两件必须在应用首次启动【之前】做的事

### 1. 时区

```bash
sudo timedatectl set-timezone Australia/Sydney
timedatectl   # 确认 Time zone: Australia/Sydney (AEST, +1000)
```

`server/lib/dates.js` 用 `Date.parse` 解析平台返回的**不带时区**的时间戳，按服务器
本地时区处理。VPS 默认 UTC 会让所有交易归错日期，`verifyDaySync` 永久 mismatch
并无限触发 repair。unit 里也设了 `Environment=TZ`，但 Node 在启动时缓存 TZ，
运行中改 `timedatectl` 对已跑起来的进程不可靠 —— 所以要先设好。

必须用 `Australia/Sydney`（含 DST 规则），**不要**用 `Etc/GMT-10` 这类固定偏移。

### 2. Node 22 且 ICU 完整

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # v22.x（Node 20 已 EOL）

# dates.js 全靠 Intl 的 Australia/Sydney，ICU 不完整会静默出错
node -e "console.log(new Date('2026-09-15T12:34:54+00:00').toLocaleDateString('en-CA',{timeZone:'Australia/Sydney'}))"
# 期望输出 2026-09-15
```

> Node ≥ 22 会让 `server/db/init.js` 选用内置 `node:sqlite` 而非 better-sqlite3。
> 这两个驱动的 API 有差异，相关兼容问题已在代码里处理（`runAtomic` 同时判
> `isTransaction` 与 `inTransaction`，`deleteCompany` 不再用 `db.transaction()`）。
> 但要知道：**`npm test` 跑的是 better-sqlite3 路径，测试全绿不代表生产路径没问题。**

---

## 安装

代码用 `git archive` 打包：它只含已提交的文件，**从机制上带不出** `config.json`、库、
备份和日志。不要手写 `tar` —— 项目目录里有 `server/db/backup-*/` 明文全库。

```bash
# 本机（必须已 commit，archive 只打包 HEAD）
git archive --format=tar.gz -o trader-dashboard.tar.gz HEAD
scp trader-dashboard.tar.gz deploy@vps:/tmp/
```

```bash
# VPS（deploy 是下面「VPS 基线」里建的 sudo 用户）
sudo -u trader tar -xzf /tmp/trader-dashboard.tar.gz -C /opt/trader-dashboard
rm /tmp/trader-dashboard.tar.gz
cd /opt/trader-dashboard
sudo -u trader npm ci --omit=dev --ignore-scripts

# --ignore-scripts 不能省：better-sqlite3 带 binding.gyp，npm 默认会跑 node-gyp rebuild，
# 没装 make/g++ 就报 `gyp ERR! not found: make`。它自带 prebuilds/linux-x64.node，跳过
# 编译直接用即可；其余依赖都是纯 JS。验证两个驱动都能开：
sudo -u trader node -e "const D=require('better-sqlite3');new D(':memory:');console.log('better-sqlite3 OK')"
sudo -u trader node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(':memory:');console.log('node:sqlite OK')"

sudo install -m 0644 deploy/trader-dashboard.service /etc/systemd/system/
sudo install -m 0644 deploy/trader-backup.service /etc/systemd/system/
sudo install -m 0644 deploy/trader-backup.timer /etc/systemd/system/
sudo install -m 0755 -o root -g root deploy/trader-backup.sh /usr/local/bin/

command -v node   # 必须是 /usr/bin/node，否则改 unit 里的 ExecStart
sudo systemd-analyze verify /etc/systemd/system/trader-dashboard.service
sudo systemctl daemon-reload
```

`config.json` **不要 scp、不要粘到聊天软件**：

```bash
# 前导空格避开 shell history。trader 是 nologin 且无 sudo，这里必须用 deploy 用户
 cat config.prod.json | ssh deploy@vps 'sudo tee /etc/trader-dashboard/config.json > /dev/null'
sudo chown root:trader /etc/trader-dashboard/config.json
sudo chmod 0640 /etc/trader-dashboard/config.json
```

生产 `config.json` 相对本机必须改的：`sessionSecret`（全新 48 字节随机，≥32 字符）、
`maxPages`（已是 1200，别调回 500）。
`platform.*` 整段**可以删掉** —— `services/platform.js` 优先从 `companies` 表读凭证，
config 里的回落只对 `aussiex6` 生效，留着等于多一份明文凭证。
**不要**写 `host` 字段（留空即绑 127.0.0.1）。

### 改账号密码（搬库之后、启动之前）

**改 `config.json` 的 `admin.password` 对搬过来的库不生效**：`seedAdmin` 只在 users 表为空时
写入。必须用脚本直接改库，新密码至少 6 位，不走命令行参数：

```bash
read -rs P; printf %s "$P" | sudo -u trader TRADER_DB=/var/lib/trader-dashboard/trader.db \
  node /opt/trader-dashboard/scripts/set-password.js admin; unset P
```

operator 账号同样各改一次。`NODE_ENV=production` 下，服务发现任何账号还在用默认密码，或
`sessionSecret` 是占位值、不足 32 字符，会打印 `[startup] 拒绝启动` 并退出 ——
`systemctl status` 里循环重启时先看这一行。

---

## 启动之前：白名单自检

**先验白名单，再启动服务。** 顺序反了会很难受：白名单没通就 start，`runLane` 会把该公司
× 该 lane 退避 300s → 指数到 1800s，你会以为"起来了在等"，其实它在睡觉。

```bash
sudo -u trader TRADER_DB=/var/lib/trader-dashboard/trader.db \
  node /opt/trader-dashboard/scripts/check-api-access.js
echo "exit=$?"
```

| 退出码 | 含义 | 动作 |
|---|---|---|
| 0 | 四家全通 | **唯一允许 `systemctl start` 的状态** |
| 2 | 有公司被拒（`Invalid Access`） | 不要启动。用脚本提取的**盘方回显源 IP** 逐字比对白名单 |
| 3 | 网络或业务层失败，不是白名单 | 可重试；先排 IPv6、DNS、防火墙 |
| 4 | 没测起来（DB 打不开、`--company` 写错） | 环境或参数错 —— VPS 上八成是忘了给 `TRADER_DB` |

这个脚本只读开库、不跑 migration、不碰 state 目录、零写入，所以在服务没起来的时候跑是安全的；
用 `sudo -u trader` 跑还顺带验证了服务用户对 0640 的库有读权限。逐家改白名单时用
`--company=rolex66` 单测一家。完整切换流程见 [../DEPLOY.md](../DEPLOY.md) 的 4.6。

---

## 启动与验证

`enable` 与 `start` 故意分开：先让 unit 装好并开机自启，`start` 留到上面的自检退出码为 0 之后。

```bash
sudo systemctl enable trader-dashboard      # 只登记开机自启，不启动
# —— 此处先跑白名单自检，退出码 0 才继续 ——
sudo systemctl start trader-dashboard
sudo journalctl -fu trader-dashboard
```

按顺序盯这三条（顺序由 `server/index.js` 的 getDb → startScheduler → listen 决定）：

```
[scheduler] per-company parallel loops — fast 6s / slow 60s   <- migration 已完成的精确标记
[scheduler] start loops for <四家公司>                          <- 四家都在
[trader-dashboard] http://127.0.0.1:3000                       <- 端口已开
```

> **`systemctl status` 显示绿色 ≠ 服务可用。** `Type=simple` 在进程 fork 的瞬间就报
> active，而端口要等 migration 跑完才开 —— 本机实测 208MB 库上约 10 秒。
> 这 10 秒里外网会看到 Cloudflare 502，属正常。

migration 期间没有日志时，这样区分"卡住"和"在干活"：

```bash
PID=$(systemctl show -p MainPID --value trader-dashboard)
top -b -n 2 -d 2 -p $PID | tail -5      # CPU 接近满载单核 = 在跑 SQL
cat /proc/$PID/io                        # read_bytes 在涨 = 在扫表
ss -ltnp | grep 127.0.0.1:3000          # 空 = 还在 migration
```

**首次启动后必须查一次**：

```bash
journalctl -u trader-dashboard --since "5 min ago" | grep '\[db\]'
```

`db/init.js` 的 migration 里有 9 处 `catch { console.warn }`，失败是**静默**的——
服务照样起来，只是某张表/某列没建好，然后在第一个请求上报一个诡异的 SQL 错误。
**任何 warn 都按部署失败处理。**

同步是否真的在工作，看这三条，都不碰 HTTP：

```bash
# 1) 状态文件每 6s 重写
watch -n5 'for f in /var/lib/trader-dashboard/state/sync-state-*.json; do
  echo "== $(basename $f)"; jq -c "{ok,accessDenied,at,transactions,message}" $f; done'

# 2) 交易在增长 —— 这才是"真的在写入"的硬证据
watch -n30 "sqlite3 -readonly /var/lib/trader-dashboard/trader.db \
  'SELECT company_id, COUNT(*) n, MAX(created_at) latest FROM transactions GROUP BY 1;'"

# 3) 异常关键字
journalctl -u trader-dashboard --since "10 min ago" | grep -Ei 'ACCESS_DENIED|backoff|pruned|Invalid Access'
```

**看到 `PRUNE BLOCKED` 就立刻 `systemctl stop`。** 这是熔断：待删客户超过
`max(50, 5%)` 时一个都不删，说明这轮 API 结果是残缺的（`maxPages` 不够、
`/users/getAllUsers` 权限没勾）。熔断生效期间每轮都会全量重拉一次，所以要尽快处理。
`pruned stale customers:` 后面正常应是 0 或个位数。
客户数基线：aussiex6 14014 / ezspin68 71601 / pokies7bet 74794 / rolex66 69739。

不动 DNS 的浏览器验证：

```bash
ssh -N -L 8080:127.0.0.1:3000 deploy@vps   # 然后本机开 http://127.0.0.1:8080/login.html
```

`curl http://<VPS公网IP>:3000/` **必须连接被拒**（应用只绑 127.0.0.1）。

---

## 备份

```bash
sudo apt-get install -y sqlite3 age
curl https://rclone.org/install.sh | sudo bash   # 仓库版本较老，官方脚本更稳
```

**age 密钥对在你自己的机器上生成，VPS 只放公钥**：

```bash
age-keygen -o trader-backup.key     # 私钥！离线保管（1Password / 纸 / 另一台机器）
                                    # 绝不进 git、绝不上 VPS
echo 'age1...你的公钥...' | sudo tee /etc/trader-dashboard/backup-recipient.age
sudo chown root:trader /etc/trader-dashboard/backup-recipient.age
sudo chmod 0640 /etc/trader-dashboard/backup-recipient.age
```

rclone 要以 `trader` 身份配（service 以该用户运行）：

```bash
sudo -u trader HOME=/opt/trader-dashboard rclone config
# name=r2  type=s3  provider=Cloudflare  region=auto
# endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
# R2 API Token 权限只给 Object Read & Write，且只绑这一个 bucket —— 绝不给 Admin
sudo -u trader HOME=/opt/trader-dashboard rclone lsd r2:
sudo chmod 600 /opt/trader-dashboard/.config/rclone/rclone.conf
```

```bash
sudo systemctl enable --now trader-backup.timer
sudo systemctl start trader-backup.service     # 立刻跑一次
journalctl -u trader-backup -n 60 --no-pager   # 应看到 integrity=ok
systemctl list-timers trader-backup.timer
```

容量（本机实测单份加密压缩包约 54MB）：hourly 48 份 + daily 21 份 + monthly 7 份
≈ **4.1GB**，在 R2 免费额度 10GB 内（约 41%）。库涨到两倍时约 8.1GB，届时把
hourly 降到 24h 即可。

### 恢复演练（每月一次，写进日历）

**没验证过的备份等于没有备份。** 难点是不能并行跑第二个实例，绕法是把恢复库里的
公司全部停用 —— `scheduler.js` 的 `listEnabledCompanies()` 返回空数组，只会打印
`no enabled companies with API credentials` 然后什么都不做，零双同步风险。

```bash
R=/tmp/restore-drill; rm -rf $R; mkdir -p $R/state
rclone copy "r2:trader-dashboard-backups/hourly/$(rclone lsf r2:trader-dashboard-backups/hourly | sort | tail -1)" $R/
cd $R && F=$(ls *.age)

# 解密必须用离线私钥、在保管它的机器上做。在 VPS 上放私钥会完全抵消加密设计。
age -d -i /path/to/trader-backup.key "$F" | gunzip > $R/trader.db

sqlite3 $R/trader.db "PRAGMA integrity_check;"    # 必须恰好输出 ok
sqlite3 $R/trader.db "SELECT 'customers',COUNT(*) FROM customers
  UNION ALL SELECT 'transactions',COUNT(*) FROM transactions
  UNION ALL SELECT 'bank_ledger',COUNT(*) FROM bank_ledger
  UNION ALL SELECT 'bank_tx_pending',COUNT(*) FROM bank_tx_pending
  UNION ALL SELECT 'audit_events',COUNT(*) FROM audit_events;"
# 基线（2026-09-24）：230148 / 162493 / 568 / 6921 / 18507 —— 只应增长

# 业务级核对，用仓库里现成的只读脚本
TRADER_DB=$R/trader.db node /opt/trader-dashboard/scripts/audit-data-integrity.js

# 真起一次（先停用所有公司，确保不发一个请求）
sqlite3 $R/trader.db "UPDATE companies SET enabled = 0;"
sudo jq '.port = 3999' /etc/trader-dashboard/config.json > $R/config.json
TRADER_DB=$R/trader.db TRADER_STATE_DIR=$R/state TRADER_CONFIG=$R/config.json \
  NODE_ENV=production TZ=Australia/Sydney node /opt/trader-dashboard/server/index.js
# 期望日志里出现 "no enabled companies with API credentials"（确认没有同步）
```

**验收标准四条，全绿才算这份备份有效**：`integrity_check=ok` ＋ 五张表行数不低于
上次演练 ＋ `audit-data-integrity.js` 无新增告警 ＋ 能登录并拉到 `/api/data/sync-status`。

> `VACUUM INTO` 产出的库 `journal_mode` 是 delete（新库默认），所以恢复出来的文件
> **没有 `-wal`**，这是正常的 —— `applyDbPragmas` 会在首次打开时设回 WAL。

---

## Cloudflare 侧（上线前必做，两项都是零代码）

1. **Cloudflare Access** 覆盖整个 hostname（Zero Trust，免费到 50 seats）。未通过身份
   校验的请求根本到不了源站。这是 23 万客户数据前面的第一道门，**没配好不要把 DNS 切过来**。
2. **Rate Limiting Rule** on `POST /api/auth/login` → 5 次/分钟/IP → Block 10 分钟。
   免费 plan 有 1 条额度，就用在这里。应用层已有兜底（`lib/loginLimiter.js`：账号 10 次、
   IP 30 次/15 分钟），这条规则是在流量到达源站之前就挡掉。

> Access 挡不住**已经拿到 operator 账号的人**。相关的提权路径已在代码层修掉，不要依赖
> Access 代替它。应用层限流按 `CF-Connecting-IP` 计数，前提是源站只绑 127.0.0.1 ——
> 这也是不能写 `host` 字段的又一个原因。

---

## cloudflared 与本服务的启动顺序

**不要**给 cloudflared 加 `After=trader-dashboard.service`。`Type=simple` 在端口打开
之前就报 active，`After=` 只能保证"进程已 fork"，给的是虚假的安全感。

两者本来就互相独立：node 只监听 127.0.0.1，不关心隧道；cloudflared 连不上源站会
持续重试并向边缘返回 502，node 起来后自动恢复。代价是每次 restart 期间外网看到
约 10 秒 502，测试阶段完全可接受。
