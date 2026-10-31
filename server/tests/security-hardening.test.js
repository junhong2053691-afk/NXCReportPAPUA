const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const { sessionSecretProblem, productionStartupProblems } = require("../lib/startupGuards");
const { sessionStillValid, passwordTag } = require("../middleware");
const { createLoginLimiter, MAX_PER_USERNAME, MAX_PER_IP } = require("../lib/loginLimiter");
const { apiUrlProblem, credentialChangeProblem } = require("../lib/apiUrlPolicy");
const { isValidStatusValue, upsertStatusOption } = require("../lib/bankStatusOptions");
const { isInsidePublicDir, saveBackupSettings } = require("../lib/appSettings");
const { pruneStaleCustomers } = require("../services/sync");
const { CONTENT_SECURITY_POLICY } = require("../lib/securityHeaders");

const ROOT = path.join(__dirname, "..", "..");
const STRONG_SECRET = "a".repeat(64);

function usersDb(password) {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE users (username TEXT, password_hash TEXT, status TEXT)");
  db.prepare("INSERT INTO users VALUES ('admin', ?, 'active')").run(bcrypt.hashSync(password, 4));
  return db;
}

// ---- 启动闸门

test("startup：生产环境拒绝占位或过短的 sessionSecret", () => {
  assert.ok(sessionSecretProblem(""));
  assert.ok(sessionSecretProblem("__FILL_ME__"));
  assert.ok(sessionSecretProblem("change-me-" + "x".repeat(40)));
  assert.ok(sessionSecretProblem("short-but-not-placeholder"));
  assert.equal(sessionSecretProblem(STRONG_SECRET), "");
});

test("startup：账号仍是默认密码时拒绝启动，这是搬库后唯一拦得住的地方", () => {
  const problems = productionStartupProblems(
    { sessionSecret: STRONG_SECRET },
    usersDb("admin123"),
    { NODE_ENV: "production" }
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /admin/);
});

test("startup：密码已改且 secret 够强时放行", () => {
  const problems = productionStartupProblems(
    { sessionSecret: STRONG_SECRET },
    usersDb("a-long-random-passphrase"),
    { NODE_ENV: "production" }
  );
  assert.deepEqual(problems, []);
});

test("startup：非生产环境不检查，本机开发不受影响", () => {
  assert.deepEqual(productionStartupProblems({ sessionSecret: "" }, usersDb("admin123"), {}), []);
});

// ---- 会话

const NOW = 1_800_000_000_000;
const row = { role: "operator", status: "active", password_hash: "hash-1" };
const session = (over = {}) => ({
  user: { role: "operator" },
  loginAt: NOW - 1000,
  passwordTag: passwordTag("hash-1"),
  ...over,
});

test("session：账号正常时有效", () => {
  assert.equal(sessionStillValid(row, session(), NOW), true);
});

test("session：删除、停用、改角色、改密都立即失效", () => {
  assert.equal(sessionStillValid(undefined, session(), NOW), false);
  assert.equal(sessionStillValid({ ...row, status: "disabled" }, session(), NOW), false);
  assert.equal(sessionStillValid({ ...row, role: "admin" }, session(), NOW), false);
  assert.equal(sessionStillValid({ ...row, password_hash: "hash-2" }, session(), NOW), false);
});

test("session：12 小时绝对上限不被请求顺延，缺 loginAt 的旧 session 也失效", () => {
  assert.equal(sessionStillValid(row, session({ loginAt: NOW - 12 * 3600 * 1000 }), NOW), false);
  assert.equal(sessionStillValid(row, session({ loginAt: undefined }), NOW), false);
});

// ---- 登录限流

test("limiter：同一账号超限后返回等待秒数，换 IP 也挡得住", () => {
  const limiter = createLoginLimiter(() => NOW);
  for (let i = 0; i < MAX_PER_USERNAME; i++) {
    assert.equal(limiter.attempt("10.0.0." + i, "admin"), 0);
  }
  assert.ok(limiter.attempt("10.9.9.9", "ADMIN") > 0, "账号大小写不能绕过");
});

test("limiter：同一 IP 换账号也挡得住，窗口过后恢复", () => {
  let t = NOW;
  const limiter = createLoginLimiter(() => t);
  for (let i = 0; i < MAX_PER_IP; i++) assert.equal(limiter.attempt("1.1.1.1", "user" + i), 0);
  assert.ok(limiter.attempt("1.1.1.1", "another") > 0);
  t += 15 * 60 * 1000;
  assert.equal(limiter.attempt("1.1.1.1", "another"), 0);
});

test("limiter：登录成功清掉账号计数", () => {
  const limiter = createLoginLimiter(() => NOW);
  for (let i = 0; i < MAX_PER_USERNAME; i++) limiter.attempt("1.1.1.1", "amy");
  limiter.succeeded("amy");
  assert.equal(limiter.attempt("1.1.1.1", "amy"), 0);
});

// ---- 平台 token 不外发

test("apiUrl：只放行公网 https", () => {
  assert.equal(apiUrlProblem("https://jk.example.com/api/v1/index.php"), "");
  assert.equal(apiUrlProblem(""), "");
  for (const bad of [
    "http://jk.example.com/",
    "file:///etc/passwd",
    "not a url",
    "https://localhost/",
    "https://127.0.0.1/",
    "https://10.0.0.1/",
    "https://172.16.0.1/",
    "https://192.168.1.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://metadata.google.internal/",
  ]) {
    assert.ok(apiUrlProblem(bad), bad);
  }
});

test("credentials：改地址不带新 token 被拒，否则库里的 token 会发到新地址", () => {
  const existing = { api_url: "https://old.example.com/", access_token: "stored" };
  assert.ok(credentialChangeProblem(existing, { api_url: "https://evil.example.com/" }));
  assert.equal(
    credentialChangeProblem(existing, { api_url: "https://new.example.com/", access_token: "fresh" }),
    ""
  );
});

test("credentials：地址不变时 token 留空仍表示保持不变", () => {
  const existing = { api_url: "https://old.example.com/", access_token: "stored" };
  assert.equal(credentialChangeProblem(existing, { api_url: "https://old.example.com/" }), "");
  assert.equal(credentialChangeProblem(existing, {}), "");
});

// ---- 流水 status 与 CSS 类名

test("status：放行全部内置值，拒绝能闭合属性的字符", () => {
  for (const ok of ["deposit", "cash in", "bank trf", "test out", "amopay", "vip-2"]) {
    assert.equal(isValidStatusValue(ok), true, ok);
  }
  for (const bad of ['x"><img/src=x/onerror=alert(1)>', "a<b", "a'b", "", " x", "x".repeat(41)]) {
    assert.equal(isValidStatusValue(bad), false, bad);
  }
});

test("status：自定义状态选项同样校验格式", () => {
  assert.throws(
    () => upsertStatusOption(null, "co", { value: 'x"><img>' }),
    (e) => e.status === 400
  );
});

test("statusClass：即便库里已有恶意值，也闭合不了 class 属性", () => {
  const source = fs.readFileSync(path.join(ROOT, "public", "js", "bank-accounts.js"), "utf8");
  const match = source.match(/function statusClass\(status\) \{[\s\S]*?\n  \}/);
  assert.ok(match, "statusClass 不在预期位置");
  const statusClass = new Function(match[0] + "; return statusClass;")();
  assert.equal(statusClass("cash in"), "status-cash-in");
  assert.equal(statusClass("bank trf"), "status-bank-trf");
  assert.doesNotMatch(statusClass('x"><img/src=x/onerror=alert(1)>'), /["<>=/()]/);
});

// ---- 备份目录

test("backup：拒绝 public 及其子目录，放行其他路径", () => {
  assert.equal(isInsidePublicDir("public"), true);
  assert.equal(isInsidePublicDir("public/js"), true);
  assert.equal(isInsidePublicDir("./public/../public/x"), true);
  assert.equal(isInsidePublicDir(path.join(ROOT, "public", "js")), true);
  assert.equal(isInsidePublicDir("server/db/backups"), false);
  assert.equal(isInsidePublicDir("/var/lib/trader-dashboard/backups"), false);
  assert.throws(() => saveBackupSettings({}, { dir: "public" }, "t"), (e) => e.status === 400);
});

// ---- 客户删除熔断

function customersDb(n) {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE customers (company_id TEXT, id TEXT)");
  const insert = db.prepare("INSERT INTO customers VALUES ('co', ?)");
  for (let i = 0; i < n; i++) insert.run("c" + i);
  return db;
}

function idsExcept(n, missing) {
  const ids = new Set();
  for (let i = missing; i < n; i++) ids.add("c" + i);
  return ids;
}

test("prune：残缺结果会删掉大量客户时熔断，一个都不删", () => {
  const db = customersDb(10000);
  const result = pruneStaleCustomers(db, "co", idsExcept(10000, 2000));
  assert.equal(result.removed, 0);
  assert.equal(result.pruneBlocked, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customers").get().n, 10000);
});

test("prune：正常的小额增量照常删除", () => {
  const db = customersDb(10000);
  assert.equal(pruneStaleCustomers(db, "co", idsExcept(10000, 3)).removed, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customers").get().n, 9997);
});

test("prune：小客户量下保留 50 条的绝对额度", () => {
  const db = customersDb(100);
  assert.equal(pruneStaleCustomers(db, "co", idsExcept(100, 50)).removed, 50);
});

// ---- CSP 的前提

test("csp：页面没有内联脚本、事件属性和第三方脚本，否则 script-src 'self' 会把它们拦掉", () => {
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'(;|$)/);
  const pages = [
    fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8"),
    fs.readFileSync(path.join(ROOT, "public", "login.html"), "utf8"),
  ];
  for (const page of pages) {
    assert.doesNotMatch(page, /<script>/);
    assert.doesNotMatch(page, /<script src="https?:/);
    assert.doesNotMatch(page, /\son(click|load|error|change|submit)=/);
  }
});

test("csp：引用的本地脚本都真实存在", () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "login.html"), "utf8");
  const index = fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8");
  const sources = [...(html + index).matchAll(/<script src="(\/[^"?]+)/g)].map((m) => m[1]);
  assert.ok(sources.length >= 5);
  for (const src of sources) {
    if (src.includes("${")) continue;
    assert.ok(fs.existsSync(path.join(ROOT, "public", src)), src);
  }
});
