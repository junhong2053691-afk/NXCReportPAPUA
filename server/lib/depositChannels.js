const { testNameExclude } = require("./winLoss");

const CHANNEL_LABELS = {
  PAYID: "PayID",
  AMPBL: "AMP",
  PIG: "PIG",
  CBA: "CBA",
  WBC: "Westpac",
  ANZ: "ANZ",
  NAB: "NAB",
};

function channelCode(row) {
  const payid = String(row.payid || "").trim();
  const bank = String(row.bank_name || "").trim();
  if (payid) return "PAYID";
  if (!bank) return "OTHER";
  const upper = bank.toUpperCase();
  if (upper.startsWith("PAYID")) return "PAYID";
  const code = bank.split(/[\s(]/)[0].toUpperCase();
  return code || "OTHER";
}

function channelLabel(code) {
  return CHANNEL_LABELS[code] || code;
}

function methodLabel(method) {
  const m = String(method || "").trim();
  if (!m) return "-";
  if (/online/i.test(m) && /manual/i.test(m)) return "\u5728\u7ebf";
  if (/online/i.test(m)) return "\u5728\u7ebf";
  if (/manual/i.test(m)) return "\u4eba\u5de5";
  return m;
}

function rowChannelDisplay(row) {
  const code = channelCode(row);
  return { code, label: channelLabel(code) };
}

function computeDepositChannels(db, date, companyId) {
  const rows = db
    .prepare(
      `SELECT bank_name, payid, method, amount
       FROM transactions
       WHERE company_id = ? AND type = 'DEPOSIT' AND created_date = ?
         AND ${testNameExclude("")}`
    )
    .all(companyId, date);

  const map = {};
  for (const row of rows) {
    const { code, label } = rowChannelDisplay(row);
    if (!map[code]) map[code] = { code, label, count: 0, total: 0 };
    map[code].count += 1;
    map[code].total += Number(row.amount || 0);
  }

  return Object.values(map)
    .map((r) => ({ ...r, total: Math.round(r.total * 100) / 100 }))
    .sort((a, b) => b.total - a.total || b.count - a.count);
}

module.exports = {
  CHANNEL_LABELS,
  channelCode,
  channelLabel,
  methodLabel,
  rowChannelDisplay,
  computeDepositChannels,
};
