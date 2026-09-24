const { todayKey } = require("./dates");
const { ensurePromoColumns } = require("../db/init");

const MAX_RANGE_DAYS = 90;
const UNKNOWN_PROMO = "\u672a\u540c\u6b65\u6d3b\u52a8\u540d";

function daysBetween(start, end) {
  const [y1, m1, d1] = start.split("-").map(Number);
  const [y2, m2, d2] = end.split("-").map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.floor((b - a) / 86400000) + 1;
}

function shiftDateKey(dateKey, deltaDays) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + deltaDays);
  const yy = t.getUTCFullYear();
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return yy + "-" + mm + "-" + dd;
}

function normalizeDateRange(from, to) {
  const today = todayKey();
  let dateFrom = String(from || to || today).trim();
  let dateTo = String(to || from || today).trim();
  if (dateFrom > dateTo) {
    const tmp = dateFrom;
    dateFrom = dateTo;
    dateTo = tmp;
  }
  if (daysBetween(dateFrom, dateTo) > MAX_RANGE_DAYS) {
    dateFrom = shiftDateKey(dateTo, -(MAX_RANGE_DAYS - 1));
  }
  return {
    dateFrom,
    dateTo,
    label: dateFrom === dateTo ? dateFrom : dateFrom + " \u81f3 " + dateTo,
  };
}

function claimantKey(alias = "t") {
  return "COALESCE(NULLIF(TRIM(" + alias + ".customer_id), ''), NULLIF(TRIM(" + alias + ".mobile), ''))";
}

function bonusWhere(alias = "t") {
  return (
    alias +
    ".type = 'BONUS'" +
    " AND " +
    alias +
    ".created_date >= ? AND " +
    alias +
    ".created_date <= ?" +
    " AND LOWER(COALESCE(" +
    alias +
    ".name, '')) NOT LIKE '%test%'" +
    " AND " +
    claimantKey(alias) +
    " IS NOT NULL AND " +
    claimantKey(alias) +
    " != ''"
  );
}

function sortPromoRows(rows) {
  return rows.sort((a, b) => {
    const au = a.promo_name === UNKNOWN_PROMO;
    const bu = b.promo_name === UNKNOWN_PROMO;
    if (au !== bu) return au ? 1 : -1;
    return (
      b.claim_users - a.claim_users ||
      b.claim_count - a.claim_count ||
      b.total_amount - a.total_amount ||
      String(a.promo_name).localeCompare(String(b.promo_name))
    );
  });
}

function computePromoClaims(db, dateFrom, dateTo, opts = {}) {
  const companyId = opts.companyId;
  if (!companyId) throw new Error("companyId required");
  ensurePromoColumns(db);
  const range = normalizeDateRange(dateFrom, dateTo);
  const q = (opts.q || "").trim().toLowerCase();
  const promoExpr = "COALESCE(NULLIF(TRIM(t.promo_name), ''), '" + UNKNOWN_PROMO + "')";
  const where = bonusWhere("t");

  const sql =
    "SELECT " +
    promoExpr +
    " AS promo_name," +
    " COUNT(*) AS claim_count," +
    " COUNT(DISTINCT " +
    claimantKey("t") +
    ") AS claim_users," +
    " COALESCE(SUM(t.amount), 0) AS total_amount" +
    " FROM transactions t" +
    " WHERE t.company_id = ? AND " +
    where +
    " GROUP BY " +
    promoExpr +
    " ORDER BY claim_users DESC";

  let rows = db
    .prepare(sql)
    .all(companyId, range.dateFrom, range.dateTo)
    .map((r) => ({
      promo_name: r.promo_name,
      claim_users: Number(r.claim_users || 0),
      claim_count: Number(r.claim_count || 0),
      total_amount: Number(r.total_amount || 0),
      is_unknown: r.promo_name === UNKNOWN_PROMO,
    }));

  if (q) rows = rows.filter((r) => String(r.promo_name).toLowerCase().includes(q));
  rows = sortPromoRows(rows).map((r, i) => ({ rank: i + 1, ...r }));

  const bonusTotal = db
    .prepare(
      "SELECT COUNT(*) AS claim_count," +
        " COUNT(DISTINCT " +
        claimantKey("t") +
        ") AS claim_users," +
        " COALESCE(SUM(t.amount), 0) AS total_amount" +
        " FROM transactions t WHERE t.company_id = ? AND " +
        where
    )
    .get(companyId, range.dateFrom, range.dateTo);

  const unknownPending = db
    .prepare(
      "SELECT COUNT(*) AS n FROM transactions t WHERE t.type = 'BONUS'" +
        " AND t.created_date >= ? AND t.created_date <= ?" +
        " AND COALESCE(TRIM(t.promo_name), '') = ''"
    )
    .get(range.dateFrom, range.dateTo).n;

  const knownRows = rows.filter((r) => !r.is_unknown);

  return {
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    date: range.label,
    total: rows.length,
    unknownPending,
    bonusTotal: {
      claim_users: Number(bonusTotal?.claim_users || 0),
      claim_count: Number(bonusTotal?.claim_count || 0),
      total_amount: Number(bonusTotal?.total_amount || 0),
      promo_count: knownRows.length,
    },
    totals: {
      claim_users: Number(bonusTotal?.claim_users || 0),
      claim_count: Number(bonusTotal?.claim_count || 0),
      total_amount: Number(bonusTotal?.total_amount || 0),
      promo_count: rows.length,
    },
    rows,
  };
}

module.exports = { normalizeDateRange, computePromoClaims, UNKNOWN_PROMO };
