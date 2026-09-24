function cleanDisplayName(s) {
  // The upstream platform wraps VIP/blacklist metadata in a misleading
  // name-blacklist span. Keep the source row untouched, but never include
  // that metadata in the customer-facing name.
  return String(s || "")
    .replace(/<span[^>]*class="name-blacklist"[^>]*>[\s\S]*?<\/span>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanLedgerName(s) {
  return cleanDisplayName(s)
    .replace(/\s*[（(][\s\S]*[）)]\s*$/, "")
    .trim();
}

module.exports = { cleanDisplayName, cleanLedgerName };
