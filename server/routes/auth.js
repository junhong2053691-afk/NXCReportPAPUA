const express = require("express");
const bcrypt = require("bcryptjs");
const { getDb } = require("../db/init");
const { defaultCompanyId } = require("../lib/companies");
const { isOperator, firstAuthorizedCompanyId } = require("../lib/userAccess");

const router = express.Router();

router.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "请输入账号和密码" });
  }

  const user = getDb()
    .prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
    .get(String(username).trim());

  if (!user) {
    return res.status(401).json({ error: "账号或密码错误" });
  }
  if (user.status !== "active") {
    return res.status(403).json({ error: "账号已停用，请联系管理员" });
  }
  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "账号或密码错误" });
  }

  if (user.role !== "admin" && user.role !== "operator") {
    return res.status(403).json({ error: "账号角色无效，请联系管理员" });
  }

  const db = getDb();
  const operatorCompanyId = isOperator(user) ? firstAuthorizedCompanyId(db, user) : null;
  if (isOperator(user) && !operatorCompanyId) {
    return res.status(403).json({ error: "管理员尚未为此账号分配公司" });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
  };
  req.session.companyId = operatorCompanyId || defaultCompanyId(db);
  res.json({ ok: true, user: req.session.user, companyId: req.session.companyId });
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
