const { fetchAllPages } = require("../services/platform");
const { loadCfg } = require("../services/platform");
const { todayKey, shiftDateKey } = require("./dates");
const { promoFromTransaction } = require("./promoName");

function parseDetails(t) {
  if (!t.details || typeof t.details !== "string") return {};
  try {
    return JSON.parse(t.details);
  } catch (_) {
    return {};
  }
}

async function backfillPromoNames(db, opts = {}) {
  const companyId = opts.companyId;
  if (!companyId) throw new Error("companyId required for promo backfill");
  const cfg = loadCfg();
  const days = Math.min(365, Math.max(7, Number(opts.days || cfg.promoBackfillDays || 365)));
  const chunkDays = Math.min(31, Math.max(1, Number(opts.chunkDays || 31)));
  const delayMs = Number(opts.delayMs ?? cfg.quickRequestDelayMs ?? 60);
  const maxPages = Number(opts.maxPages ?? cfg.promoBackfillMaxPages ?? 2000);

  const missingBefore = db
    .prepare(
      "SELECT COUNT(*) AS n FROM transactions WHERE company_id = ? AND type = 'BONUS' AND COALESCE(TRIM(promo_name), '') = ''"
    )
    .get(companyId).n;

  const upd = db.prepare(
    "UPDATE transactions SET promo_id = ?, promo_name = ? WHERE company_id = ? AND id = ? AND type = 'BONUS'"
  );

  const today = todayKey();
  let end = today;
  let remaining = days;
  let fetched = 0;
  let updated = 0;

  while (remaining > 0) {
    const span = Math.min(chunkDays, remaining);
    const start = shiftDateKey(end, -(span - 1));
    const rows = await fetchAllPages(
      "/transactions/getAllTransactions",
      {
        type: "BONUS",
        sDate: start + " 00:00:00",
        eDate: end + " 23:59:59",
      },
      (data) => data.transactions || data.list || data.records || [],
      { maxPages, delayMs, pageSize: Number(cfg.pageSize || 200), companyId }
    );
    fetched += rows.length;
    for (const t of rows) {
      const promo = promoFromTransaction(t, parseDetails(t));
      if (!promo.promo_name && !promo.promo_id) continue;
      const r = upd.run(promo.promo_id, promo.promo_name, companyId, String(t.id || ""));
      if (r.changes) updated += 1;
    }
    console.log("[promo-backfill]", start, "to", end, "fetched", rows.length, "updated+", updated);
    remaining -= span;
    end = shiftDateKey(start, -1);
    if (end < "2020-01-01") break;
  }

  const missingAfter = db
    .prepare(
      "SELECT COUNT(*) AS n FROM transactions WHERE company_id = ? AND type = 'BONUS' AND COALESCE(TRIM(promo_name), '') = ''"
    )
    .get(companyId).n;

  return { days, fetched, updated, missingBefore, missingAfter };
}

module.exports = { backfillPromoNames };
