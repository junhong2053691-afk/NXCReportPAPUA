// 生产启动闸门。不满足就拒绝启动，而不是带着已知弱点跑起来。
//
// seedAdmin 只在 users 表为空时写入，而部署流程是把本机库整库搬上 VPS —— 所以改
// config.json 里的 admin.password 对已有库**完全不生效**，默认密码会随库进入公网。
// 文档提醒不住这件事，只能在启动时拦。改密用 scripts/set-password.js。

const bcrypt = require("bcryptjs");

const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER_SECRET_RE = /^(__fill_me__|change|replace)/i;
const KNOWN_DEFAULT_PASSWORDS = ["admin123", "__FILL_ME__", "replace-me"];

/** 返回 sessionSecret 的问题描述；没问题返回空串。 */
function sessionSecretProblem(secret) {
  const value = String(secret || "");
  if (!value) return "sessionSecret 未配置";
  if (PLACEHOLDER_SECRET_RE.test(value)) return "sessionSecret 仍是占位值";
  if (value.length < MIN_SECRET_LENGTH) return `sessionSecret 少于 ${MIN_SECRET_LENGTH} 个字符`;
  return "";
}

/** 列出仍在用已知默认密码的账号名。 */
function usersWithDefaultPassword(db) {
  const rows = db.prepare("SELECT username, password_hash FROM users WHERE status = 'active'").all();
  return rows
    .filter((row) => KNOWN_DEFAULT_PASSWORDS.some((p) => bcrypt.compareSync(p, row.password_hash)))
    .map((row) => row.username);
}

/** 只在 NODE_ENV=production 时检查，返回全部问题，空数组表示可以启动。 */
function productionStartupProblems(cfg, db, env = process.env) {
  if (env.NODE_ENV !== "production") return [];
  const problems = [];
  const secret = sessionSecretProblem(cfg.sessionSecret);
  if (secret) problems.push(secret);
  const users = usersWithDefaultPassword(db);
  if (users.length) {
    problems.push(`账号仍在用默认密码：${users.join(", ")}（用 scripts/set-password.js 修改）`);
  }
  return problems;
}

module.exports = { sessionSecretProblem, usersWithDefaultPassword, productionStartupProblems };
