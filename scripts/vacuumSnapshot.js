// 一次性子进程：把主库 VACUUM INTO 成一个干净的单文件快照，然后退出。
//
// 用法: node scripts/vacuumSnapshot.js <srcDbPath> <destPath>
// 输出: 一行 JSON 到 stdout，{ ok, ms, bytes } 或 { ok:false, error }
//
// ── 为什么必须是子进程 ──
// 两个 SQLite 驱动（node:sqlite 的 DatabaseSync 和 better-sqlite3）都是**同步** API。
// 226MB 的库 VACUUM INTO 要 3-10 秒，在主进程里跑会把事件循环整个卡住：HTTP 全挂、
// 同步 lane 全停。fork 出来就只是另一个进程在读同一个文件。
//
// ── 为什么是 VACUUM INTO，不是别的 ──
// · 直接拷 .db 文件：库是 WAL 模式，拷贝时还有几十 MB 没 checkpoint 的 WAL。只拷主库
//   等于丢掉最近所有事务；拷三个文件又不是原子的，拷贝期间的写入会造成不一致。
// · db.backup()：那是 better-sqlite3 专有 API。本机 Node 24 实际走的是 node:sqlite 的
//   DatabaseSync，它没有这个方法。用它等于埋一个「换驱动就炸」的雷。
// · VACUUM INTO 是纯 SQL，两个驱动都支持，在一个读事务里产出单文件、无 WAL、已整理
//   碎片的一致快照。

function openReadonly(file) {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major >= 22) {
    try {
      const { DatabaseSync } = require("node:sqlite");
      return new DatabaseSync(file, { readOnly: true });
    } catch (_) {
      /* 落到 better-sqlite3 */
    }
  }
  const Database = require("better-sqlite3");
  return new Database(file, { readonly: true });
}

function main() {
  const src = process.argv[2];
  const dest = process.argv[3];
  if (!src || !dest) throw new Error("usage: vacuumSnapshot.js <src> <dest>");

  let db;
  try {
    db = openReadonly(src);
    // 主库一直在被 fast lane 写。默认 5 秒的锁等待对 200MB+ 的 VACUUM 太短。
    db.exec("PRAGMA busy_timeout = 60000");
    const t0 = Date.now();
    // VACUUM INTO 不接受参数绑定，路径只能拼进 SQL——单引号必须翻倍转义。
    db.exec("VACUUM INTO '" + String(dest).replace(/'/g, "''") + "'");
    const ms = Date.now() - t0;
    let bytes = 0;
    try {
      bytes = require("fs").statSync(dest).size;
    } catch (_) {
      /* 大小只是给日志看的，取不到不算失败 */
    }
    return { ok: true, ms, bytes };
  } finally {
    try {
      if (db) db.close();
    } catch (_) {}
  }
}

try {
  process.stdout.write(JSON.stringify(main()));
  process.exit(0);
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  process.exit(1);
}
