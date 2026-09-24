const { getDb } = require("./db/init");
const { defaultCompanyId, getCompany } = require("./lib/companies");
const { isOperator, hasCompanyAccess, firstAuthorizedCompanyId } = require("./lib/userAccess");

function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "\u8bf7\u5148\u767b\u5f55" });
    }
    return res.redirect("/login.html");
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: "\u8bf7\u5148\u767b\u5f55" });
  }
  if (req.session.user.role !== "admin") {
    return res.status(403).json({ error: "\u9700\u8981\u7ba1\u7406\u5458\u6743\u9650" });
  }
  next();
}

function resolveCompany(req, res, next) {
  if (!req.session || !req.session.user) return next();
  const db = getDb();
  const user = req.session.user;
  let companyId = req.session.companyId;

  if (isOperator(user)) {
    if (!hasCompanyAccess(db, user, companyId)) {
      companyId = firstAuthorizedCompanyId(db, user);
    }
  } else if (!companyId || !getCompany(db, companyId)) {
    companyId = defaultCompanyId(db);
  }

  if (companyId) {
    req.session.companyId = companyId;
  }
  req.companyId = companyId;
  const row = getCompany(db, companyId);
  req.companyName = row?.name || companyId;
  next();
}

function requireCompany(req, res, next) {
  if (!req.companyId) {
    if (isOperator(req.session?.user)) {
      return res.status(403).json({ error: "管理员尚未为此账号分配公司" });
    }
    return res.status(400).json({ error: "\u8bf7\u5148\u9009\u62e9\u516c\u53f8" });
  }
  next();
}

function requireDataAccess(req, res, next) {
  if (isOperator(req.session?.user) && req.path !== "/sync-status") {
    return res.status(403).json({ error: "operator \u53ea\u80fd\u8bbf\u95ee\u652f\u4ed8\u901a\u9053" });
  }
  next();
}

module.exports = { requireLogin, requireAdmin, resolveCompany, requireCompany, requireDataAccess };
