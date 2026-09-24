const { getCompany, listCompanies } = require("./companies");

function isAdmin(user) {
  return user?.role === "admin";
}

function isOperator(user) {
  return user?.role === "operator";
}

function companyIdsForUser(db, userId) {
  if (!userId) return [];
  return db
    .prepare("SELECT company_id FROM user_companies WHERE user_id = ? ORDER BY company_id ASC")
    .all(userId)
    .map((row) => row.company_id);
}

function authorizedCompanyIds(db, user) {
  if (isAdmin(user)) {
    return listCompanies(db).map((company) => company.id);
  }
  if (isOperator(user)) {
    return companyIdsForUser(db, user.id);
  }
  return [];
}

function hasCompanyAccess(db, user, companyId) {
  const id = String(companyId || "").trim().toLowerCase();
  if (!id || !getCompany(db, id)) return false;
  if (isAdmin(user)) return true;
  if (!isOperator(user)) return false;
  return db
    .prepare("SELECT 1 FROM user_companies WHERE user_id = ? AND company_id = ?")
    .get(user.id, id) != null;
}

function listCompaniesForUser(db, user) {
  if (isAdmin(user)) return listCompanies(db);
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
  companyIdsForUser,
  authorizedCompanyIds,
  hasCompanyAccess,
  listCompaniesForUser,
  firstAuthorizedCompanyId,
  companyDetailsForUser,
};
