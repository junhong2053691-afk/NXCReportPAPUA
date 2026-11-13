// 拆分调钱「一批」的前端校验与每个自付行的「余额 · 付后」——纯函数，DOM 留在 bank-ledger.js。
// 规则与 server/lib/bankApply.js 的 help_split 一致（CONTEXT.md「拆分调钱」，2026-11-13 用户定）：
// - 自付行 = 本公司户口 + 金额，一批最多 10 个不同户口，同一户口可以填多行；
// - 协助方行 = C STATUS + 金额；
// - 至少 1 行，合计 ≤ 还差（少于还差就是分批付，单子留在接单区）；
// - 余额不够不拦，只把「付后」< 0 的行标红。同一户口填多行时「付后」逐行累减。
// 完全空白的行（户口 / C STATUS 和金额都没填）当作没有。
const SPLIT_MAX_SELF_BANKS = 10;

// 符号不算数：员工习惯把付出去的钱写成负数（-201.33），以前的 parseNum 与后端 money() 都取绝对值，
// 这里同口径（2026-11-13 上线后截图里协助方填负数被拦）。0 和不是数字的才算没填对。
function splitCents(value) {
  const raw = String(value == null ? "" : value).replace(/,/g, "").trim();
  if (!raw) return 0;
  const n = Math.abs(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : -1;
}

function computeSplitAllocation(input) {
  const o = input || {};
  const fmt = typeof o.fmt === "function" ? o.fmt : (n) => Number(n).toFixed(2);
  const targetCents = Math.max(0, Math.round(Number(o.remaining || 0) * 100));
  const balances = o.balances || {};
  const running = {};
  let invalidSelf = false;
  let invalidHelper = false;
  const banks = new Set();
  const selfRows = [];
  const helperRows = [];

  const selfView = (Array.isArray(o.selfRows) ? o.selfRows : []).map((r) => {
    const bankId = String(r && r.bank_account_id != null ? r.bank_account_id : "").trim();
    const rawAmount = String(r && r.amount != null ? r.amount : "").trim();
    if (!bankId && !rawAmount) return { blank: true, balance: null, after: null, negative: false };
    const cents = splitCents(rawAmount);
    const valid = Boolean(bankId) && cents > 0;
    if (!valid) invalidSelf = true;
    let balance = null;
    let after = null;
    if (bankId) {
      banks.add(bankId);
      if (balances[bankId] != null && Number.isFinite(Number(balances[bankId]))) {
        const startCents = Math.round(Number(balances[bankId]) * 100);
        const before = running[bankId] != null ? running[bankId] : startCents;
        running[bankId] = before - Math.max(0, cents);
        balance = startCents / 100;
        after = running[bankId] / 100;
      }
    }
    if (valid) selfRows.push({ bank_account_id: Number(bankId), amount: cents / 100 });
    return { blank: false, valid, balance, after, negative: after != null && after < 0 };
  });

  (Array.isArray(o.helperRows) ? o.helperRows : []).forEach((r) => {
    const cStatus = String(r && r.c_status != null ? r.c_status : "").trim();
    const rawAmount = String(r && r.amount != null ? r.amount : "").trim();
    if (!cStatus && !rawAmount) return;
    const cents = splitCents(rawAmount);
    if (!cStatus || cents <= 0) {
      invalidHelper = true;
      return;
    }
    helperRows.push({ c_status: cStatus, amount: cents / 100 });
  });

  const totalCents = selfRows.reduce((s, r) => s + Math.round(r.amount * 100), 0)
    + helperRows.reduce((s, r) => s + Math.round(r.amount * 100), 0);
  const remainingCents = targetCents - totalCents;

  let error = "";
  if (invalidSelf) error = "请填写每个自付户口和金额";
  else if (invalidHelper) error = "请填写每个协助方和金额";
  else if (banks.size > SPLIT_MAX_SELF_BANKS) error = "一次最多 10 个不同的自付户口";
  else if (!selfRows.length && !helperRows.length) error = "请至少填写 1 个自付户口或协助方";
  else if (remainingCents < 0) error = `超出 ${fmt(Math.abs(remainingCents) / 100)}`;

  const valid = !error;
  const partial = valid && remainingCents > 0;
  return {
    valid,
    partial,
    error,
    info: partial ? `付完这批还差 ${fmt(remainingCents / 100)}` : "",
    totalCents,
    remainingCents,
    selfView,
    body: { self_rows: selfRows, splits: helperRows },
  };
}

if (typeof window !== "undefined") {
  window.computeSplitAllocation = computeSplitAllocation;
  window.SPLIT_MAX_SELF_BANKS = SPLIT_MAX_SELF_BANKS;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { computeSplitAllocation, SPLIT_MAX_SELF_BANKS };
}
