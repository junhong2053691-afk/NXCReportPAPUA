const { getDb } = require("../server/db/init");
const { bankBranchOf, balanceFromLedger, refreshAllBankBalances } = require("../server/lib/bankReport");

const APPLY = process.argv.includes("--apply");

function normName(row) {
  return bankBranchOf(row).toLowerCase().replace(/\s+/g, " ").trim();
}

const db = getDb();
const accounts = db.prepare("SELECT * FROM bank_accounts ORDER BY company_id, id").all();
const groups = new Map();

for (const account of accounts) {
  const key = account.company_id + "\u0000" + normName(account);
  if (!normName(account)) continue;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(account);
}

const duplicateGroups = [...groups.values()].filter((items) => items.length > 1);
console.log("=== duplicate bank accounts (same company + same normalized BankBranch) ===");
if (!duplicateGroups.length) console.log("none");
for (const items of duplicateGroups) {
  const canonical = [...items].sort((a, b) => {
    const rowsA = db.prepare("SELECT COUNT(*) AS n FROM bank_ledger WHERE bank_account_id = ?").get(a.id).n;
    const rowsB = db.prepare("SELECT COUNT(*) AS n FROM bank_ledger WHERE bank_account_id = ?").get(b.id).n;
    return rowsB - rowsA || a.id - b.id;
  })[0];
  console.log({
    company_id: canonical.company_id,
    bank_branch: bankBranchOf(canonical),
    keep_id: canonical.id,
    merge_ids: items.filter((x) => x.id !== canonical.id).map((x) => x.id),
  });
  if (APPLY) {
    const mergeIds = items.filter((x) => x.id !== canonical.id).map((x) => x.id);
    const tx = db.transaction(() => {
      for (const id of mergeIds) {
        db.prepare("UPDATE bank_ledger SET bank_account_id = ? WHERE bank_account_id = ?").run(canonical.id, id);
        db.prepare("UPDATE bank_balance_log SET bank_account_id = ? WHERE bank_account_id = ?").run(canonical.id, id);
        db.prepare("DELETE FROM bank_accounts WHERE id = ?").run(id);
      }
    });
    tx();
  }
}

const before = db.prepare("SELECT id, company_id, bank_branch, bank, branch, balance FROM bank_accounts ORDER BY id").all()
  .map((b) => ({ ...b, ledger_balance: balanceFromLedger(db, b.id) }))
  .filter((b) => Math.round((Number(b.ledger_balance || 0) - Number(b.balance || 0)) * 100) !== 0);

console.log("\n=== balance mismatches before refresh ===");
if (!before.length) console.log("none");
for (const b of before) {
  console.log({
    id: b.id,
    company_id: b.company_id,
    bank_branch: b.bank_branch || b.bank,
    stored_balance: Math.round(Number(b.balance || 0) * 100) / 100,
    ledger_balance: Math.round(Number(b.ledger_balance || 0) * 100) / 100,
    diff: Math.round((Number(b.ledger_balance || 0) - Number(b.balance || 0)) * 100) / 100,
  });
}

if (APPLY) {
  const result = refreshAllBankBalances(db);
  console.log("\nupdated stored balances:", result);
} else {
  console.log("\ndry-run only; rerun with --apply to merge same-company duplicates and refresh stored balances");
}
