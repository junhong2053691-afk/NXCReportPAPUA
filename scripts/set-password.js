#!/usr/bin/env node
/**
 * 直接在库里改账号密码。
 *
 * 为什么需要它：seedAdmin 只在 users 表为空时写入，整库搬到 VPS 之后改 config.json 的
 * admin.password 不生效；账号管理页也没有 admin 的改密入口。这是搬库后唯一可靠的路径。
 *
 * 密码只从 stdin 读，绝不走命令行参数 —— 参数会进 shell history 和 ps。
 * 不跑 migration（不 require db/init.js），服务运行中也能用：改完 password_hash，
 * sessionGuard 在下一个请求上就会踢掉该账号的旧 session。
 *
 * 用法（VPS，-s 让输入不回显）：
 *   read -rs P; printf %s "$P" | sudo -u trader TRADER_DB=/var/lib/trader-dashboard/trader.db \
 *     node /opt/trader-dashboard/scripts/set-password.js admin; unset P
 *
 * 退出码：0 成功 / 1 参数或密码不合格 / 2 账号不存在
 */

const bcrypt = require("bcryptjs");
const { dbPath } = require("../server/lib/paths");
const { MIN_PASSWORD_LENGTH } = require("../server/lib/passwordPolicy");

function openDb(file) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(file);
  } catch (_) {
    const Database = require("better-sqlite3");
    return new Database(file, { fileMustExist: true });
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    // Windows PowerShell 的管道会在开头塞一个 UTF-8 BOM。不去掉的话它就成了密码的一部分，
    // 改完之后用同一个密码永远登不上，而且看不出原因。
    process.stdin.on("end", () => resolve(data.replace(/^﻿/, "").replace(/\r?\n$/, "")));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const username = String(process.argv[2] || "").trim();
  if (!username) {
    console.error("用法: printf %s \"$P\" | node scripts/set-password.js <账号>");
    process.exit(1);
  }
  const password = await readStdin();
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`密码至少 ${MIN_PASSWORD_LENGTH} 个字符`);
    process.exit(1);
  }

  const db = openDb(dbPath());
  db.exec("PRAGMA busy_timeout = 15000");
  const hash = bcrypt.hashSync(password, 10);
  const result = db
    .prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE username = ? COLLATE NOCASE")
    .run(hash, username);
  if (!Number(result.changes)) {
    console.error("账号不存在:", username);
    process.exit(2);
  }
  console.log("已更新密码:", username);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
