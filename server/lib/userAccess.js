const { getCompany, listCompanies } = require("./companies");

// 公司授权的唯一口子。三种人：
//   · 全部公司 admin：role = admin 且 users.company_scope = 'all'（默认）→ 所有公司
//   · 受限 admin：role = admin 且 company_scope = 'limited' → 只有 user_companies 里那几家（2026-11-13）
//   · operator：永远只有 user_companies 里那几家（company_scope 列对它无意义）
// company_scope 每次查库，不存 session：和 sessionGuard 一样，收紧范围下一个请求就生效。
// 库里查不到这个 admin 时按受限处理——失败要关门，不是开门。

function isAdmin(user) {
  return user?.role === "admin";
}

function isOperator(user) {
  return user?.role === "operator";
}

function companyScopeOf(db, user) {
  if (!user?.id) return "";
  const row = db.prepare("SELECT company_scope FROM users WHERE id = ?").get(user.id);
  return row ? String(row.company_scope || "") : "";
}

function isFullAdmin(db, user) {
  return isAdmin(user) && companyScopeOf(db, user) === "all";
}

// operator 或受限 admin：公司范围由 user_companies 决定。
function isCompanyRestricted(db, user) {
  return isOperator(user) || (isAdmin(user) && !isFullAdmin(db, user));
}

function companyIdsForUser(db, userId) {
  if (!userId) return [];
  return db
    .prepare("SELECT company_id FROM user_companies WHERE user_id = ? ORDER BY company_id ASC")
    .all(userId)
    .map((row) => row.company_id);
}

function authorizedCompanyIds(db, user) {
  if (isFullAdmin(db, user)) {
    return listCompanies(db).map((company) => company.id);
  }
  if (isCompanyRestricted(db, user)) {
    const existing = new Set(listCompanies(db).map((company) => company.id));
    return companyIdsForUser(db, user.id).filter((id) => existing.has(id));
  }
  return [];
}

function hasCompanyAccess(db, user, companyId) {
  const id = String(companyId || "").trim().toLowerCase();
  if (!id || !getCompany(db, id)) return false;
  if (isFullAdmin(db, user)) return true;
  if (!isCompanyRestricted(db, user)) return false;
  return db
    .prepare("SELECT 1 FROM user_companies WHERE user_id = ? AND company_id = ?")
    .get(user.id, id) != null;
}

function listCompaniesForUser(db, user) {
  if (isFullAdmin(db, user)) return listCompanies(db);
  const allowed = new Set(authorizedCompanyIds(db, user));
  return listCompanies(db).filter((company) => allowed.has(company.id));
}

function firstAuthorizedCompanyId(db, user) {
  const companies = listCompaniesForUser(db, user);
  return companies[0]?.id || null;
}

function companyDetailsForUser(db, userId) {
  const ids = companyIdsForUser(db, userId);
  if (!ids.length) return [];
  const allowed = new Set(ids);
  return listCompanies(db).filter((company) => allowed.has(company.id));
}

module.exports = {
  isAdmin,
  isOperator,
  isFullAdmin,
  isCompanyRestricted,
  companyScopeOf,
  companyIdsForUser,
  authorizedCompanyIds,
  hasCompanyAccess,
  listCompaniesForUser,
  firstAuthorizedCompanyId,
  companyDetailsForUser,
};
