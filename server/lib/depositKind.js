function hasAttachment(row) {
  return Boolean(String(row?.attachment_url || "").trim());
}

function isRedeposit(row) {
  const method = String(row?.method || "").trim().toLowerCase();
  return row?.type === "DEPOSIT" && (method === "redeposit" || !hasAttachment(row));
}

function computeRedepositSummary(db, date, companyId) {
  const { testNameExclude } = require("./winLoss");
  const rows = db
    .prepare(
      `SELECT method, attachment_url, amount
       FROM transactions
       WHERE company_id = ? AND type = 'DEPOSIT' AND created_date = ?
         AND ${testNameExclude("")}`
    )
    .all(companyId, date);

  let count = 0;
  let total = 0;
  for (const row of rows) {
    if (isRedeposit({ ...row, type: "DEPOSIT" })) {
      count += 1;
      total += Number(row.amount || 0);
    }
  }
  return { count, total: Math.round(total * 100) / 100 };
}

module.exports = {
  hasAttachment,
  isRedeposit,
  computeRedepositSummary,
};
