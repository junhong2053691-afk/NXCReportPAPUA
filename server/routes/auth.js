const express = require("express");
const bcrypt = require("bcryptjs");
const { getDb } = require("../db/init");
const { defaultCompanyId } = require("../lib/companies");
const { isOperator, firstAuthorizedCompanyId } = require("../lib/userAccess");
const { createLoginLimiter } = require("../lib/loginLimiter");
const { establishSession } = require("../middleware");

const router = express.Router();
const limiter = createLoginLimiter();

// 账号不存在时也跑一次 bcrypt，否则响应时间差会暴露哪些账号存在。
const DUMMY_HASH = bcrypt.hashSync("no-such-user", 10);

// 源站只绑 127.0.0.1、只有本机 cloudflared 连得上，所以这个头可信；
// 本机直连开发时没有它，退回 req.ip。
function clientIp(req) {
  return String(req.headers["cf-connecting-ip"] || req.ip || "");
}

function regenerate(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

router.post("/login", async (req, res, next) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "请输入账号和密码" });
  }
  const name = String(username).trim();

  const retryAfter = limiter.attempt(clientIp(req), name);
  if (retryAfter) {
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "尝试次数过多，请稍后再试" });
  }

  try {
    const db = getDb();
    const user = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(name);

    // 异步 compare：compareSync 一次约 100ms 且阻塞事件循环，会拖住四家公司的同步。
    const matched = await bcrypt.compare(String(password), user ? user.password_hash : DUMMY_HASH);
    if (!user || !matched) {
      return res.status(401).json({ error: "账号或密码错误" });
    }
    // 状态与角色放在验密之后：只有拿得出正确密码的人才该知道账号的状态。
    if (user.status !== "active") {
      return res.status(403).json({ error: "账号已停用，请联系管理员" });
    }
    if (user.role !== "admin" && user.role !== "operator") {
      return res.status(403).json({ error: "账号角色无效，请联系管理员" });
    }

    const operatorCompanyId = isOperator(user) ? firstAuthorizedCompanyId(db, user) : null;
    if (isOperator(user) && !operatorCompanyId) {
      return res.status(403).json({ error: "管理员尚未为此账号分配公司" });
    }

    limiter.succeeded(name);
    // 换 sid 防 session fixation：登录前被种下的 cookie 不能变成已登录会话。
    await regenerate(req);
    establishSession(req, user);
    req.session.companyId = operatorCompanyId || defaultCompanyId(db);
    res.json({ ok: true, user: req.session.user, companyId: req.session.companyId });
  } catch (e) {
    next(e);
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

router.get("/me", (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: "未登录" });
  }
  res.json({
    user: req.session.user,
    companyId: req.session.companyId || null,
  });
});

module.exports = router;
