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

// 数据库快照的默认落地目录。默认放在 server/db/backups —— 那里 .gitignore 已经忽略，
// 且已经堆着以前手动做的备份。可用 TRADER_BACKUP_DIR 或后台设置里的 dir 覆盖。
//
// 注意别改成项目根目录：根目录的 *.db 不在忽略规则里（只忽略了 server/db/*.db）。
function backupDir() {
  const dir = resolveEnvPath("TRADER_BACKUP_DIR", path.join(ROOT, "server", "db", "backups"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  projectRoot,
  configPath,
  dbPath,
  stateDir,
  syncStatePath,
  activeCompanyPath,
  backupDir,
};
