const { getDb } = require("./db/init");
const { defaultCompanyId, getCompany } = require("./lib/companies");
const { isOperator, hasCompanyAccess, firstAuthorizedCompanyId } = require("./lib/userAccess");

function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    // \u5fc5\u987b\u770b originalUrl\uff1a\u5728 router.use(requireLogin) \u91cc\uff08routes/data.js \u5c31\u662f\u8fd9\u6837\u7528\u7684\uff09
    // req.path \u5df2\u88ab\u5265\u6389\u6302\u8f7d\u524d\u7f00\uff0c\u662f "/sync-status" \u800c\u4e0d\u662f "/api/data/sync-status"\uff0c
    // startsWith("/api/") \u6052\u4e3a false \u2014\u2014 \u4e8e\u662f API \u8bf7\u6c42\u4f1a\u6536\u5230 302 \u91cd\u5b9a\u5411\u800c\u975e 401\u3002
    // fetch \u9ed8\u8ba4\u8ddf\u968f\u91cd\u5b9a\u5411\uff0c\u62ff\u56de login.html \u7684 HTML 200\uff0c\u524d\u7aef res.json() \u89e3\u6790\u5931\u8d25
    // \u5f97\u5230\u7a7a\u5bf9\u8c61\uff0c\u65e2\u4e0d\u62a5\u9519\u4e5f\u6ca1\u6709\u6570\u636e\uff0c\u8868\u73b0\u4e3a\u9759\u9ed8\u5931\u8d25\u3002
    // \u4e24\u4e2a\u90fd\u5224\u662f\u4e3a\u4e86\u65e0\u8bba\u8def\u7531\u600e\u4e48\u6302\u8f7d\u90fd\u6210\u7acb\u3002
    if (req.originalUrl.startsWith("/api/") || req.path.startsWith("/api/")) {
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
