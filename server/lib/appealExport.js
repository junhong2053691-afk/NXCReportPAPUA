// 封禁户的银行申诉导出：这个户口的**全部客户入账**（2026-11-06 与用户确认用途是给银行申诉）。
//
// 员工演练：旧的「下载 Excel」只有最近 10 笔入账 + 10 笔出账，混着内部调钱行，没有户口抬头，
// 拿去银行申诉不够用。客户入账 = status 为 deposit / new / amopay / unclaim 且 amount_in > 0；
// 内部调钱（BANK TRANSFER 走 trf_amount、CASH IN、带 transfer_group_id 的行）一律不要。
// CSV 由前端 public/js/appeal-csv.js 拼（它还要处理客户姓名的显示清洗）。
const CUSTOMER_DEPOSIT_STATUSES = ["deposit", "new", "amopay", "unclaim"];

// 户口不属于本公司时返回 null（路由回 404）。
function appealDeposits(db, companyId, bankId) {
  const bank = db
    .prepare("SELECT id FROM bank_accounts WHERE id = ? AND company_id = ?")
    .get(Number(bankId || 0), String(companyId || ""));
  if (!bank) return null;
  const placeholders = CUSTOMER_DEPOSIT_STATUSES.map(() => "?").join(", ");
  return db
    .prepare(`
      SELECT id, entry_time, tx_id, status, amount_in, username, name
      FROM bank_ledger
      WHERE bank_account_id = ? AND company_id = ?
        AND amount_in > 0
        AND lower(trim(status)) IN (${placeholders})
        AND COALESCE(transfer_group_id, '') = ''
      ORDER BY entry_time ASC, id ASC
    `)
    .all(bank.id, String(companyId), ...CUSTOMER_DEPOSIT_STATUSES);
}

module.exports = { appealDeposits, CUSTOMER_DEPOSIT_STATUSES };
