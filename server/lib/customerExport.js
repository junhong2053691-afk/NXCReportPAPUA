const { todayKey } = require("./dates");
const { segmentWhere } = require("./customerSegments");

const EXPORT_SEGMENTS = new Set([
  "all",
  "never_deposited",
  "active_depositor",
  "offline_3_7",
  "offline_7plus",
]);

function parseExportSegments(raw) {
  const list = String(raw || "all")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = list.filter((s) => EXPORT_SEGMENTS.has(s));
  if (!valid.length || valid.includes("all")) return ["all"];
  return valid;
}

function fetchExportPhones(db, segments, q, companyId) {
  const today = todayKey();
  const byMobile = new Map();
  const segList = parseExportSegments(segments);

  for (const seg of segList) {
    const where = segmentWhere(seg, today, "c", companyId);
    let sql =
      "SELECT c.mobile, c.name FROM customers c WHERE " +
      where +
      " AND c.mobile IS NOT NULL AND TRIM(c.mobile) != ''";
    const params = [];
    if (q) {
      sql +=
        " AND (c.mobile LIKE ? OR c.name LIKE ? OR c.username LIKE ? OR c.id LIKE ? OR c.referrer LIKE ?)";
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
    }
    for (const row of db.prepare(sql).all(...params)) {
      const mobile = String(row.mobile || "").trim();
      if (!mobile) continue;
      if (!byMobile.has(mobile)) {
        byMobile.set(mobile, { mobile, name: String(row.name || "").trim() });
      }
    }
  }

  return Array.from(byMobile.values()).sort((a, b) => a.mobile.localeCompare(b.mobile));
}

function formatExport(format, rows) {
  const fmt = String(format || "csv").toLowerCase();
  if (fmt === "txt") {
    return { body: rows.map((r) => r.mobile).join("\n") + (rows.length ? "\n" : ""), ext: "txt", mime: "text/plain; charset=utf-8" };
  }
  const lines = ["mobile,name", ...rows.map((r) => csvEscape(r.mobile) + "," + csvEscape(r.name))];
  const body = lines.join("\n") + "\n";
  if (fmt === "googlesheet" || fmt === "sheets") {
    return { body: "\uFEFF" + body, ext: "csv", mime: "text/csv; charset=utf-8" };
  }
  return { body, ext: "csv", mime: "text/csv; charset=utf-8" };
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

module.exports = { EXPORT_SEGMENTS, parseExportSegments, fetchExportPhones, formatExport };
