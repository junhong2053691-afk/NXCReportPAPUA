// 数据库每日快照备份。
//
// Google Sheets 负责可读性与月度对比，这里负责**真容灾**：整库一致快照，出事能完整还原。
// 两者不可互相替代——Sheets 有单元格上限、类型会丢、23 万客户无法可靠回灌。
//
// 实际的 VACUUM INTO 在 scripts/vacuumSnapshot.js 的子进程里跑（原因见那个文件的注释：
// 两个 SQLite 驱动都是同步 API，在主进程里跑会把事件循环卡住 3-10 秒）。

const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");

const { getDb } = require("../db/init");
const { dbPath, backupDir } = require("../lib/paths");
const { getBackupSettings, isInsidePublicDir } = require("../lib/appSettings");
const { todayKey, formatSydneyDateTime } = require("../lib/dates");

const VACUUM_SCRIPT = path.join(__dirname, "..", "..", "scripts", "vacuumSnapshot.js");
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// 只认自己产出的文件名。目录里还躺着 trader-pre-audit-20260812.db 这类历史手动备份，
// 正则匹配不上 —— 保留策略绝不会删它们，这是刻意的。
const SNAPSHOT_RE = /^trader-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.db$/;

// 同一时刻只允许一个快照在跑（手动触发 + 定时触发可能撞上）。
let running = false;
// 定时器的内存哨兵：记住今天已经跑过了，避免在目标小时内每轮都重跑。
let lastDailyDateKey = "";

/**
 * 按保留天数挑出该删的快照文件名。纯函数。
 *
 * 文件名里的日期是 YYYY-MM-DD，所以字典序 == 时间序，直接 sort 即可。
 *
 * @param {string[]} fileNames 目录里的全部文件名
 * @param {number} keepDays 保留几份
 * @returns {string[]} 应删除的文件名
 */
function selectForPruning(fileNames, keepDays) {
  const keep = Math.max(1, Number(keepDays) || 1);
  const mine = (fileNames || []).filter((n) => SNAPSHOT_RE.test(n)).sort();
  if (mine.length <= keep) return [];
  return mine.slice(0, mine.length - keep);
}

/**
 * 给今天的快照取一个不冲突的文件名。纯函数。
 *
 * 同一天再跑一次（手动触发）时加 -2、-3 后缀，而不是覆盖已有快照——覆盖等于在写入
 * 过程中把当天唯一一份备份先毁掉。
 */
function nextSnapshotName(dateKey, existingNames) {
  const base = "trader-" + dateKey;
  const taken = new Set(existingNames || []);
  if (!taken.has(base + ".db")) return base + ".db";
  for (let n = 2; n < 100; n++) {
    if (!taken.has(base + "-" + n + ".db")) return base + "-" + n + ".db";
  }
  return base + "-" + Date.now() + ".db";
}

function resolveDir(settings) {
  const custom = String(settings?.dir || "").trim();
  if (!custom) return backupDir();
  // 保存时已拦过；这里再拦一次，挡住库里已有的旧设置。
  if (isInsidePublicDir(custom)) throw new Error("备份目录不能放在 public 下");
  const dir = path.isAbsolute(custom) ? custom : path.join(__dirname, "..", "..", custom);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 列出目录里由本功能产出的快照，新的在前。 */
function listSnapshots(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  return names
    .filter((n) => SNAPSHOT_RE.test(n))
    .map((name) => {
      let bytes = 0;
      let mtime = "";
      try {
        const st = fs.statSync(path.join(dir, name));
        bytes = st.size;
        mtime = st.mtime.toISOString();
      } catch (_) {}
      return { name, bytes, mtime };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

/**
 * 磁盘空间预检。
 *
 * 必须在动手之前查：VACUUM INTO 写到一半把盘塞满，倒霉的不只是备份——**主库也会写不
 * 进去**，等于备份行为本身搞挂了生产。
 */
function assertEnoughSpace(dir, srcBytes) {
  let stat;
  try {
    stat = fs.statfsSync(dir);
  } catch (_) {
    return; // 拿不到就别拦，让 VACUUM 自己去失败
  }
  const free = Number(stat.bavail) * Number(stat.bsize);
  const need = srcBytes * 1.5;
  if (Number.isFinite(free) && free < need) {
    throw new Error(
      "磁盘空间不足：需要约 " +
        mb(need) +
        "，可用 " +
        mb(free) +
        "。请清理磁盘或把备份目录改到别的盘"
    );
  }
}

function mb(bytes) {
  return Math.round(Number(bytes || 0) / 1024 / 1024) + "MB";
}

function runVacuum(src, dest, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = fork(VACUUM_SCRIPT, [src, dest], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    } catch (e) {
      reject(new Error("无法启动备份子进程: " + e.message));
      return;
    }

    let out = "";
    let errOut = "";
    let timedOut = false;
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (errOut += d));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch (_) {}
    }, timeoutMs);

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error("备份子进程出错: " + e.message));
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("备份超时（超过 " + Math.round(timeoutMs / 1000) + " 秒）"));
        return;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(out.trim());
      } catch (_) {}
      if (parsed && parsed.ok) {
        resolve(parsed);
        return;
      }
      const reason =
        (parsed && parsed.error) || errOut.trim().slice(0, 300) || "子进程退出码 " + code;
      reject(new Error(reason));
    });
  });
}

/**
 * 跑一次快照。
 *
 * 顺序上有两个刻意的选择：
 * 1. 先写 .tmp 再 rename —— 备份目录里永远不会出现半截文件，被误当成可用快照。
 * 2. 开头就往 db_backup_log 插一行 ok=0 —— 进程中途被杀时那行会留着，如实显示为失败，
 *    而不是什么记录都没有。
 *
 * @param {{kind?: "daily"|"manual", timeoutMs?: number}} [opts]
 * @returns {Promise<{ok:boolean, file:string, bytes:number, durationMs:number, pruned:number, message:string}>}
 */
async function runSnapshot(opts = {}) {
  if (running) {
    return { ok: false, file: "", bytes: 0, durationMs: 0, pruned: 0, message: "已有备份在进行中" };
  }
  running = true;

  const kind = opts.kind === "manual" ? "manual" : "daily";
  const db = getDb();
  const started = Date.now();
  let logId = 0;
  let dir = "";
  let tmpPath = "";

  try {
    const settings = getBackupSettings(db);
    dir = resolveDir(settings);
    const src = dbPath();

    let srcBytes = 0;
    try {
      srcBytes = fs.statSync(src).size;
    } catch (e) {
      throw new Error("读不到主数据库文件: " + e.message);
    }
    assertEnoughSpace(dir, srcBytes);

    const name = nextSnapshotName(todayKey(), fs.readdirSync(dir));
    const destPath = path.join(dir, name);
    tmpPath = destPath + ".tmp";
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {}

    logId = Number(
      db
        .prepare(
          `INSERT INTO db_backup_log (kind, file_path, started_at, ok, message)
           VALUES (?, ?, datetime('now'), 0, '进行中')`
        )
        .run(kind, destPath).lastInsertRowid
    );

    const result = await runVacuum(src, tmpPath, Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS));
    fs.renameSync(tmpPath, destPath);
    tmpPath = "";

    const bytes = Number(result.bytes || 0) || fs.statSync(destPath).size;

    // 保留策略：只在快照成功落地之后才删旧的，绝不先删后备。
    let pruned = 0;
    for (const old of selectForPruning(fs.readdirSync(dir), settings.keepDays)) {
      if (old === name) continue;
      try {
        fs.unlinkSync(path.join(dir, old));
        pruned++;
      } catch (e) {
        console.warn("[backup] 删除旧快照失败", old + ":", e.message);
      }
    }

    // 刚备份完写压力最小，顺手把 WAL 截断，避免它长期停在几十 MB。
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (e) {
      console.warn("[backup] wal_checkpoint:", e.message);
    }

    const durationMs = Date.now() - started;
    db.prepare(
      `UPDATE db_backup_log
       SET finished_at = datetime('now'), duration_ms = ?, ok = 1, bytes = ?, pruned = ?, message = ''
       WHERE id = ?`
    ).run(durationMs, bytes, pruned, logId);

    console.log(
      "[backup] " + name + " " + mb(bytes) + " in " + (durationMs / 1000).toFixed(1) + "s" +
        (pruned ? "，清理 " + pruned + " 份旧快照" : "")
    );
    return { ok: true, file: destPath, bytes, durationMs, pruned, message: "" };
  } catch (e) {
    const message = String((e && e.message) || e);
    const durationMs = Date.now() - started;
    try {
      if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {}
    try {
      if (logId) {
        db.prepare(
          `UPDATE db_backup_log
           SET finished_at = datetime('now'), duration_ms = ?, ok = 0, message = ?
           WHERE id = ?`
        ).run(durationMs, message.slice(0, 500), logId);
      } else {
        db.prepare(
          `INSERT INTO db_backup_log (kind, started_at, finished_at, duration_ms, ok, message)
           VALUES (?, datetime('now'), datetime('now'), ?, 0, ?)`
        ).run(kind, durationMs, message.slice(0, 500));
      }
    } catch (logErr) {
      console.warn("[backup] 写日志失败:", logErr.message);
    }
    // 这个库没有告警通道。日志 + db_backup_log + 设置页标红是仅有的三层。
    console.error("[backup] 失败:", message);
    warnOnFailureStreak(db);
    return { ok: false, file: "", bytes: 0, durationMs, pruned: 0, message };
  } finally {
    running = false;
  }
}

// 连续失败时把措辞升级一档，让日志里那行更容易被扫到。
function warnOnFailureStreak(db) {
  try {
    const rows = db
      .prepare("SELECT ok FROM db_backup_log ORDER BY id DESC LIMIT 3")
      .all();
    if (rows.length === 3 && rows.every((r) => Number(r.ok) === 0)) {
      console.error("[backup] ⚠ 连续 3 次备份失败 —— 当前没有任何可用的新快照，请立即处理");
    }
  } catch (_) {}
}

/**
 * 定时器每轮调一次。到点才跑，一天只跑一次。
 *
 * 用 formatSydneyDateTime 取小时而不是 new Date().getHours()：后者是**服务器本地时区**，
 * 这台机器和业务时区（Australia/Sydney）不一定一致，会让备份跑在意料之外的时间。
 */
function maybeRunDailyBackup() {
  let settings;
  let db;
  try {
    db = getDb();
    settings = getBackupSettings(db);
  } catch (e) {
    console.warn("[backup] 读设置失败:", e.message);
    return;
  }
  if (!settings.enabled) return;

  const now = formatSydneyDateTime(new Date().toISOString());
  const dateKey = now.slice(0, 10);
  const hour = Number(now.slice(11, 13));
  if (hour !== settings.hour) return;
  if (lastDailyDateKey === dateKey) return;

  // 内存哨兵扛不住重启（刚好在目标小时内重启会重跑一次），所以再查一次日志兜底。
  try {
    const done = db
      .prepare(
        "SELECT 1 FROM db_backup_log WHERE kind = 'daily' AND ok = 1 AND date(started_at) = ? LIMIT 1"
      )
      .get(dateKey);
    if (done) {
      lastDailyDateKey = dateKey;
      return;
    }
  } catch (_) {}

  lastDailyDateKey = dateKey;
  // 不 await：备份要跑十秒级，不能拖住调用它的循环。
  runSnapshot({ kind: "daily" }).catch((e) => console.error("[backup]", e.message));
}

/** 最近几次备份记录，给设置页用。 */
function recentBackupLog(db, limit = 30) {
  const n = Math.min(200, Math.max(1, Number(limit) || 30));
  try {
    return db
      .prepare(
        `SELECT id, kind, file_path, bytes, started_at, finished_at, duration_ms, ok, message, pruned
         FROM db_backup_log ORDER BY id DESC LIMIT ?`
      )
      .all(n);
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------- 定时器
//
// 只需要小时级精度，所以每分钟醒一次去看看到点没有就够了，不用自递归那套。
// 照 services/telegramBots.js 的做法：独立的启动函数，由 index.js 调用并整体 try/catch。

let timer = null;

function startBackupScheduler() {
  if (timer) return;
  timer = setInterval(maybeRunDailyBackup, 60 * 1000);
  // 启动时不立刻跑一次：进程刚起来最忙，而且刚好卡在目标小时重启的话会多跑一份。
  console.log("[backup] 定时器已启动（每分钟检查一次是否到点）");
}

function stopBackupScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 仅供测试：重置定时哨兵。 */
function _resetDailySentinel() {
  lastDailyDateKey = "";
}

module.exports = {
  SNAPSHOT_RE,
  selectForPruning,
  nextSnapshotName,
  listSnapshots,
  resolveDir,
  runSnapshot,
  maybeRunDailyBackup,
  recentBackupLog,
  startBackupScheduler,
  stopBackupScheduler,
  _resetDailySentinel,
};
