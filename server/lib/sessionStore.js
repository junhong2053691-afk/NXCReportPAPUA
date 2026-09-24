const path = require("path");
const { Store } = require("express-session");
const { stateDir } = require("./paths");

// SQLite session store。
//
// 为什么自写而不装包：
//   - better-sqlite3-session-store 的 peerDependencies 声明 ^7.x，本项目装的是 13.x，
//     npm ci 会 ERESOLVE；且该包四年未更新
//   - connect-sqlite3 依赖 sqlite3，那会引入第三个 SQLite 驱动，且它的 prebuild
//     要在 npm install 时联网下载
// better-sqlite3 已经是本项目依赖，所以这个文件零新增依赖。
//
// 为什么用独立的 sessions.db 而不是主库：
//   生产在 Node >= 22 上主库走 node:sqlite，这里走 better-sqlite3。
//   两个不同的 SQLite 库拷贝操作两个不同的文件，互不干扰。
//   绝不要把它指向 trader.db。
class SqliteSessionStore extends Store {
  constructor(file) {
    super();
    const Database = require("better-sqlite3");
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS sessions (" +
        "sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);" +
        "CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);"
    );
    this._get = this.db.prepare("SELECT data FROM sessions WHERE sid = ? AND expires > ?");
    this._set = this.db.prepare(
      "INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) " +
        "ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires"
    );
    this._del = this.db.prepare("DELETE FROM sessions WHERE sid = ?");
    this._reap = this.db.prepare("DELETE FROM sessions WHERE expires <= ?");
    this._reap.run(Date.now());
    // unref：不让这个定时器成为进程退出的阻碍
    this._timer = setInterval(() => {
      try {
        this._reap.run(Date.now());
      } catch (_) {}
    }, 15 * 60 * 1000);
    this._timer.unref();
  }

  _expiresAt(sess) {
    const cookie = sess && sess.cookie;
    // cookie.expires 是绝对时间，如实采用 —— 即使它已经是过去时刻。
    // 不要在这里加"最少再续 N 秒"的下限：那会让一个已过期的 session
    // 在写回时被复活，get() 的 expires > now 过滤就形同虚设。
    if (cookie && cookie.expires) {
      const at = Date.parse(cookie.expires);
      if (Number.isFinite(at)) return at;
    }
    const ms = Number(cookie && cookie.maxAge);
    return Date.now() + (Number.isFinite(ms) && ms > 0 ? ms : 12 * 3600 * 1000);
  }

  get(sid, cb) {
    try {
      const row = this._get.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (error) {
      cb(error);
    }
  }

  set(sid, sess, cb) {
    try {
      this._set.run(sid, JSON.stringify(sess), this._expiresAt(sess));
      cb(null);
    } catch (error) {
      cb(error);
    }
  }

  // 实现 touch 后 express-session 会走 touch 而不是 set，
  // 配合 resave:false 显著减少写入（前端有 6s 轮询）。
  touch(sid, sess, cb) {
    try {
      this._set.run(sid, JSON.stringify(sess), this._expiresAt(sess));
      cb(null);
    } catch (error) {
      cb(error);
    }
  }

  destroy(sid, cb) {
    try {
      this._del.run(sid);
      cb(null);
    } catch (error) {
      cb(error);
    }
  }

  close() {
    try {
      clearInterval(this._timer);
      this.db.close();
    } catch (_) {}
  }
}

function createSessionStore() {
  return new SqliteSessionStore(path.join(stateDir(), "sessions.db"));
}

module.exports = { SqliteSessionStore, createSessionStore };
