const fs = require("fs");

function looksUtf16Le(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return true;
  const sample = Math.min(buf.length, 200);
  let zeroAtOdd = 0;
  let checked = 0;
  for (let i = 1; i < sample; i += 2) {
    checked++;
    if (buf[i] === 0) zeroAtOdd++;
  }
  return checked > 8 && zeroAtOdd / checked > 0.8;
}

function readTextFile(filePath) {
  const buf = fs.readFileSync(filePath);
  if (looksUtf16Le(buf)) {
    return buf.toString("utf16le").replace(/^\uFEFF/, "");
  }
  return buf.toString("utf8").replace(/^\uFEFF/, "");
}

function readConfig() {
  const { configPath } = require("./paths");
  return JSON.parse(readTextFile(configPath()));
}

function isDemoTenant() {
  try {
    return Boolean(readConfig().demoTenant);
  } catch {
    return false;
  }
}

module.exports = { readTextFile, readConfig, isDemoTenant };
