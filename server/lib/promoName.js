function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function promoFromTransaction(t, details = {}) {
  let promoId = "";
  let promoName = "";
  if (t.promotion && typeof t.promotion === "object") {
    promoId = String(t.promotion.id || "");
    promoName = stripHtml(t.promotion.name);
  }
  if (!promoName && details.angpao) promoName = stripHtml(details.angpao);
  if (!promoId && details.promotionId) promoId = String(details.promotionId);
  return { promo_id: promoId, promo_name: promoName };
}

module.exports = { stripHtml, promoFromTransaction };
