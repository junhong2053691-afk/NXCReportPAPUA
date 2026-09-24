const fs = require("fs");
const { activeCompanyPath } = require("./paths");

function setActiveCompany(id) {
  try {
    fs.writeFileSync(activeCompanyPath(), JSON.stringify({ id, at: Date.now() }), "utf8");
  } catch (_) {}
}

function getActiveCompany() {
  try {
    const file = activeCompanyPath();
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")).id || null;
  } catch {
    return null;
  }
}

module.exports = { setActiveCompany, getActiveCompany };
