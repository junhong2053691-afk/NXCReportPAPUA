const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

function resolveEnvPath(envName, defaultAbsPath) {
  const raw = process.env[envName];
  if (raw == null || String(raw).trim() === "") return defaultAbsPath;
  const value = String(raw).trim();
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

function projectRoot() {
  return ROOT;
}

function configPath() {
  return resolveEnvPath("TRADER_CONFIG", path.join(ROOT, "config.json"));
}

function dbPath() {
  return resolveEnvPath("TRADER_DB", path.join(ROOT, "server", "db", "trader.db"));
}

function stateDir() {
  const dir = resolveEnvPath("TRADER_STATE_DIR", ROOT);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function syncStatePath(companyId) {
  return path.join(stateDir(), "sync-state-" + companyId + ".json");
}

function activeCompanyPath() {
  return path.join(stateDir(), "active-company.json");
}

module.exports = {
  projectRoot,
  configPath,
  dbPath,
  stateDir,
  syncStatePath,
  syncStatePath: syncStatePath,
  activeCompanyPath,
};
