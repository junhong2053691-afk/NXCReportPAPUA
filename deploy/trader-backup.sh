#!/usr/bin/env bash
#
# trader-dashboard 备份：VACUUM INTO 一致快照 -> gzip -> age 加密 -> Cloudflare R2
#
# 设计要点：
#  - 用 sqlite3 CLI 而非 node 脚本：备份进程必须独立于应用进程。应用因 OOM
#    死掉的时候，恰恰是最需要备份还能跑的时候。
#  - VACUUM INTO 在源库上只开读事务，不停机、不加锁。产出的快照【包含】WAL 里
#    已提交的内容，所以是一致的；但它【不会】truncate 源库的 WAL，因此下面
#    另有一步 wal_checkpoint。
#  - 加密是必须的：库里有 23 万客户的姓名、手机号与完整资金流水。裸传意味着
#    R2 token 泄露等于全量 PII 泄露，而 token 就明文躺在这台机器的 rclone.conf
#    里。用 age 非对称加密，本机只放公钥，私钥离线保管 —— 攻下这台机器也解不开
#    任何一份备份。
#  - 顺序必须是 gzip -> age（age 自身不压缩）。
#
# 本机实测（226MB 库 + 39MB WAL）：VACUUM INTO 约 6s，产出约 208MB，gzip 后约 54MB。
#
set -Eeuo pipefail

DB=/var/lib/trader-dashboard/trader.db
WORK=/var/backups/trader-dashboard
R2=r2:trader-dashboard-backups
RECIPIENT_FILE=/etc/trader-dashboard/backup-recipient.age

TS=$(date +%Y%m%dT%H%M%S)   # TZ 由 systemd 的 Environment=TZ 决定（Australia/Sydney）
HOUR=$(date +%H)
DOM=$(date +%d)
SNAP="$WORK/trader-$TS.db"
OUT="$WORK/trader-$TS.db.gz.age"

log() { echo "[backup] $*"; }
cleanup() { rm -f "$SNAP" "$SNAP-wal" "$SNAP-shm" "$OUT"; }
trap cleanup EXIT

# ── 0) 磁盘预检：快照 + gz 峰值约 260MB，留 3 倍余量 ──
FREE_KB=$(df -Pk "$WORK" | awk 'NR==2{print $4}')
DB_KB=$(( $(stat -c%s "$DB") / 1024 ))
if (( FREE_KB < DB_KB * 3 )); then
  log "FATAL: 磁盘不足 free=${FREE_KB}KB db=${DB_KB}KB"
  exit 1
fi

# ── 1) 一致快照 ──
# 不要用 mode=ro 或 immutable=1：immutable 会忽略 WAL，得到陈旧/不一致的快照。
# VACUUM INTO 要求目标文件不存在。
rm -f "$SNAP"
log "VACUUM INTO -> $SNAP"
sqlite3 "$DB" "PRAGMA busy_timeout=60000; VACUUM INTO '$SNAP';"

# ── 2) 顺手 checkpoint 源库 WAL（VACUUM INTO 不做这件事）──
# 本机观察到 WAL 涨到 39MB 而 wal_autocheckpoint 是默认的 1000 页（约 4MB），
# 说明存在 checkpoint 饥饿（单连接同时读写，几乎总有未完成的读快照压着 WAL）。
# best-effort：应用正在写就会返回 busy，忽略即可。
WAL_BEFORE=$(stat -c%s "$DB-wal" 2>/dev/null || echo 0)
sqlite3 "$DB" "PRAGMA busy_timeout=15000; PRAGMA wal_checkpoint(TRUNCATE);" || log "WAL checkpoint busy（可忽略）"
WAL_AFTER=$(stat -c%s "$DB-wal" 2>/dev/null || echo 0)
log "WAL $WAL_BEFORE -> $WAL_AFTER"
if (( WAL_AFTER > 200 * 1024 * 1024 )); then
  log "WARN: WAL 超过 200MB，checkpoint 长期失败，需要排查"
fi

# ── 3) 快照自检：坏备份比没备份更危险，因为你会信它 ──
CHK=$(sqlite3 "$SNAP" "PRAGMA integrity_check;")
if [[ "$CHK" != "ok" ]]; then
  log "FATAL: integrity_check = $CHK"
  exit 1
fi
ROWS=$(sqlite3 "$SNAP" "SELECT (SELECT COUNT(*) FROM customers)||'/'||(SELECT COUNT(*) FROM transactions)||'/'||(SELECT COUNT(*) FROM bank_ledger);")
log "integrity=ok rows(cust/tx/ledger)=$ROWS"

# 数据只增不减：客户数暴跌是 pruneStaleCustomers 误删的早期告警。
# 基线（2026-09-24）：230148。低于 150000 一定有问题。
CUST=$(sqlite3 "$SNAP" "SELECT COUNT(*) FROM customers;")
if (( CUST < 150000 )); then
  log "ALERT: customers=$CUST 远低于基线 230148，疑似 prune 误删 —— 立刻检查"
fi

# ── 4) 压缩 + 加密 ──
gzip -6 -c "$SNAP" | age -R "$RECIPIENT_FILE" -o "$OUT"
log "artifact $(stat -c%s "$OUT") bytes"
rm -f "$SNAP"

# ── 5) 上传：三个 prefix，各自独立保留策略 ──
rclone copyto "$OUT" "$R2/hourly/trader-$TS.db.gz.age"
[[ "$HOUR" == "04" ]] && rclone copyto "$OUT" "$R2/daily/trader-$TS.db.gz.age"        # 04:00 悉尼 = 盘口低谷
[[ "$DOM" == "01" && "$HOUR" == "04" ]] && rclone copyto "$OUT" "$R2/monthly/trader-$TS.db.gz.age"

# ── 6) 保留策略 ──
# hourly 48 份 + daily 21 份 + monthly 7 份，单份约 54MB -> 合计约 4.1GB，
# 在 R2 免费额度 10GB 内（约 41%），留 2.4 倍增长空间。
rclone delete "$R2/hourly"  --min-age 48h
rclone delete "$R2/daily"   --min-age 21d
rclone delete "$R2/monthly" --min-age 200d

log "done"
