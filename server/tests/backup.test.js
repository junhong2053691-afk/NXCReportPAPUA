const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Database = require("better-sqlite3");

const {
  SNAPSHOT_RE,
  selectForPruning,
  nextSnapshotName,
  listSnapshots,
} = require("../services/backup");

const { getBackupSettings, saveBackupSettings, BACKUP_RANGES } = require("../lib/appSettings");

const VACUUM_SCRIPT = path.join(__dirname, "..", "..", "scripts", "vacuumSnapshot.js");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trader-backup-test-"));
}

function settingsDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT NOT NULL DEFAULT ''
    );
  `);
  return db;
}

// ------------------------------------------------------------ 保留策略（纯函数）

test("保留策略：只删自己产出的快照，历史手动备份和别的文件一律不碰", () => {
  const names = [
    "trader-2026-09-01.db",
    "trader-2026-09-02.db",
    "trader-2026-09-03.db",
    // 目录里真实存在的历史手动备份 —— 命名不匹配，必须留着
    "trader-pre-audit-20260812.db",
    "readme.txt",
    "trader-demo.db",
    "before-help-trf",
  ];
  const doomed = selectForPruning(names, 2);
  assert.deepEqual(doomed, ["trader-2026-09-01.db"], "只删最旧的那一份");
  for (const keep of ["trader-pre-audit-20260812.db", "readme.txt", "trader-demo.db", "before-help-trf"]) {
    assert.ok(!doomed.includes(keep), keep + " 不该被删");
  }
});

test("保留策略：份数没超过保留天数时一个都不删", () => {
  const names = ["trader-2026-09-01.db", "trader-2026-09-02.db"];
  assert.deepEqual(selectForPruning(names, 30), []);
  assert.deepEqual(selectForPruning(names, 2), []);
});

test("保留策略：按日期而不是按读目录的顺序判断新旧", () => {
  // readdirSync 的返回顺序不保证有序，所以刻意打乱输入
  const names = [
    "trader-2026-10-02.db",
    "trader-2026-09-30.db",
    "trader-2026-10-01.db",
    "trader-2026-09-29.db",
  ];
  assert.deepEqual(selectForPruning(names, 2), ["trader-2026-09-29.db", "trader-2026-09-30.db"]);
});

test("保留策略：keepDays 非法值退回至少保留 1 份，不会把目录清空", () => {
  const names = ["trader-2026-09-01.db", "trader-2026-09-02.db"];
  assert.deepEqual(selectForPruning(names, 0), ["trader-2026-09-01.db"]);
  assert.deepEqual(selectForPruning(names, -5), ["trader-2026-09-01.db"]);
  assert.deepEqual(selectForPruning(names, undefined), ["trader-2026-09-01.db"]);
});

test("带后缀的同日快照也被正则认得", () => {
  assert.ok(SNAPSHOT_RE.test("trader-2026-09-24.db"));
  assert.ok(SNAPSHOT_RE.test("trader-2026-09-24-2.db"));
  assert.ok(!SNAPSHOT_RE.test("trader-2026-09-24.db.tmp"), "半截文件不算快照");
  assert.ok(!SNAPSHOT_RE.test("trader-pre-audit-20260812.db"));
});

test("同日重复备份取不冲突的文件名，不覆盖已有快照", () => {
  assert.equal(nextSnapshotName("2026-09-24", []), "trader-2026-09-24.db");
  assert.equal(
    nextSnapshotName("2026-09-24", ["trader-2026-09-24.db"]),
    "trader-2026-09-24-2.db"
  );
  assert.equal(
    nextSnapshotName("2026-09-24", ["trader-2026-09-24.db", "trader-2026-09-24-2.db"]),
    "trader-2026-09-24-3.db"
  );
});

// ------------------------------------------------------------ VACUUM INTO 真跑一遍

test("VACUUM INTO 产出一致快照，且目标目录没有 -wal / -shm 伴生文件", () => {
  const dir = tmpdir();
  const src = path.join(dir, "src.db");
  const dest = path.join(dir, "snap.db");

  const db = new Database(src);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
  for (let i = 0; i < 500; i++) insert.run("row-" + i);
  // 刻意不 checkpoint：这正是"直接拷 .db 会丢数据"的场景，快照必须包含 WAL 里的内容
  assert.ok(fs.existsSync(src + "-wal"), "前提：WAL 文件应存在且未合并");

  const out = execFileSync(process.execPath, [VACUUM_SCRIPT, src, dest], { encoding: "utf8" });
  const result = JSON.parse(out);
  assert.equal(result.ok, true, "子进程应返回 ok:true，实际: " + out);

  const snap = new Database(dest, { readonly: true });
  assert.equal(snap.prepare("SELECT COUNT(*) AS n FROM t").get().n, 500, "行数应与源库一致");
  assert.equal(
    snap.prepare("SELECT v FROM t ORDER BY id DESC LIMIT 1").get().v,
    "row-499",
    "WAL 里最后写入的那行也必须在快照里"
  );
  assert.deepEqual(snap.prepare("PRAGMA integrity_check").all(), [{ integrity_check: "ok" }]);
  snap.close();

  assert.ok(!fs.existsSync(dest + "-wal"), "快照不该带 -wal");
  assert.ok(!fs.existsSync(dest + "-shm"), "快照不该带 -shm");

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("VACUUM INTO 目标已存在时子进程失败并返回 ok:false，不静默成功", () => {
  const dir = tmpdir();
  const src = path.join(dir, "src.db");
  const dest = path.join(dir, "snap.db");
  const db = new Database(src);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  db.close();
  fs.writeFileSync(dest, "occupied");

  let out = "";
  try {
    out = execFileSync(process.execPath, [VACUUM_SCRIPT, src, dest], { encoding: "utf8" });
    assert.fail("目标已存在时应该非零退出");
  } catch (e) {
    out = String(e.stdout || "");
  }
  const result = JSON.parse(out);
  assert.equal(result.ok, false);
  assert.ok(result.error, "应带上失败原因");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("listSnapshots 过滤掉非快照文件，并按新到旧排序", () => {
  const dir = tmpdir();
  for (const n of [
    "trader-2026-09-01.db",
    "trader-2026-09-03.db",
    "trader-2026-09-02.db",
    "trader-pre-audit-20260812.db",
    "notes.txt",
  ]) {
    fs.writeFileSync(path.join(dir, n), "x");
  }
  const found = listSnapshots(dir).map((f) => f.name);
  assert.deepEqual(found, ["trader-2026-09-03.db", "trader-2026-09-02.db", "trader-2026-09-01.db"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("listSnapshots 目录不存在时返回空数组而不是抛异常", () => {
  assert.deepEqual(listSnapshots(path.join(os.tmpdir(), "definitely-not-here-" + Date.now())), []);
});

// ------------------------------------------------------------ 备份设置

test("空库读出完整的备份默认设置，默认是关闭的", () => {
  const db = settingsDb();
  const s = getBackupSettings(db);
  assert.equal(s.enabled, false, "默认关闭：要用户看过磁盘占用提示后显式打开");
  assert.equal(s.dir, "");
  assert.equal(s.hour, BACKUP_RANGES.hour.def);
  assert.equal(s.keepDays, BACKUP_RANGES.keepDays.def);
  db.close();
});

test("备份设置：越界的小时和保留天数被钳制而不是报错", () => {
  const db = settingsDb();
  assert.equal(saveBackupSettings(db, { hour: 99 }, "t").hour, BACKUP_RANGES.hour.max);
  assert.equal(saveBackupSettings(db, { hour: -3 }, "t").hour, BACKUP_RANGES.hour.min);
  assert.equal(saveBackupSettings(db, { keepDays: 9999 }, "t").keepDays, BACKUP_RANGES.keepDays.max);
  assert.equal(saveBackupSettings(db, { keepDays: 0 }, "t").keepDays, BACKUP_RANGES.keepDays.min);
  assert.equal(saveBackupSettings(db, { hour: "abc" }, "t").hour, BACKUP_RANGES.hour.def);
  db.close();
});

test("备份设置：局部更新不会顺手把别的字段清掉", () => {
  const db = settingsDb();
  saveBackupSettings(db, { enabled: true, dir: "D:\\backups", hour: 3, keepDays: 7 }, "t");
  const after = saveBackupSettings(db, { hour: 5 }, "t");
  assert.equal(after.hour, 5);
  assert.equal(after.enabled, true, "enabled 不该被重置");
  assert.equal(after.dir, "D:\\backups", "dir 不该被清空");
  assert.equal(after.keepDays, 7);
  db.close();
});

test("备份设置：dir 传空字符串是真的恢复默认目录（和私钥的「留空=不变」不同）", () => {
  const db = settingsDb();
  saveBackupSettings(db, { dir: "D:\\backups" }, "t");
  assert.equal(saveBackupSettings(db, { dir: "" }, "t").dir, "");
  db.close();
});

test("备份设置：带空字节的目录被拒绝为 400", () => {
  const db = settingsDb();
  assert.throws(
    () => saveBackupSettings(db, { dir: "D:\\bad\0path" }, "t"),
    (e) => e.status === 400
  );
  db.close();
});

test("app_settings 表不存在时读备份设置退回默认值而不是炸掉", () => {
  const db = new Database(":memory:");
  assert.equal(getBackupSettings(db).enabled, false);
  db.close();
});
