// 确认框里「动的是哪一个」那一行——纯函数，DOM 留在 bank-accounts.js。
//
// 2026-11-06 员工演练：删除 / 恢复 / 封禁的确认框只写「账单流水 #1848」「封禁支付渠道」，
// 看不出是哪个户口、哪笔钱、哪个单号；同名户口（三个都叫 TEST BANK）只能靠记忆。
// 这里拼出来的是租户数据（户名、客户名），页面上必须放在 translate="no" 的元素里；
// 字段名用 IN / OUT / TRANS ID / BSB / ACC / BAL 这些中英通用写法，不进翻译字典。
function targetMoney(n) {
  const v = Math.round(Math.abs(Number(n) || 0) * 100) / 100;
  return v.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// 余额带符号，但 -0.004 这种不显示成 -0.00。
function signedMoney(n) {
  const cents = Math.round((Number(n) || 0) * 100);
  return (cents < 0 ? "-" : "") + targetMoney(cents / 100);
}

function ledgerTargetDetail(row, opts) {
  const r = row || {};
  const o = opts || {};
  const parts = [];
  const time = String(r.entry_time || "").slice(0, 16);
  if (time) parts.push(time);
  const status = String(o.statusLabel || r.status || "").trim();
  if (status) parts.push(status);
  const inAmt = Math.abs(Number(r.amount_in) || 0) + Math.abs(Number(r.trf_amount) || 0);
  const outAmt = Math.abs(Number(r.amount_out) || 0) + Math.abs(Number(r.help_amount) || 0);
  if (inAmt) parts.push(`IN ${targetMoney(inAmt)}`);
  if (outAmt) parts.push(`OUT -${targetMoney(outAmt)}`);
  const txId = String(r.tx_id || "").trim();
  if (txId) parts.push(`TRANS ID ${txId}`);
  const who = [String(r.username || "").trim(), String(o.name || "").trim()].filter(Boolean).join(" / ");
  if (who) parts.push(who);
  const bank = String(o.bankLabel || "").trim();
  if (bank) parts.push(bank);
  return parts.join(" · ");
}

function bankTargetDetail(bank, opts) {
  const b = bank || {};
  const o = opts || {};
  const parts = [];
  const label = String(o.label || "").trim();
  if (label) parts.push(label);
  const name = String(b.account_name || "").trim();
  if (name && name !== label) parts.push(name);
  const bsb = String(b.bsb || "").trim();
  if (bsb) parts.push(`BSB ${bsb}`);
  const acc = String(b.account_number || "").trim();
  if (acc) parts.push(`ACC ${acc}`);
  const payid = String(b.payid || "").trim();
  if (!acc && payid) parts.push(`PAYID ${payid}`);
  if (o.balance != null) parts.push(`BAL ${signedMoney(o.balance)}`);
  return parts.join(" · ");
}

if (typeof window !== "undefined") {
  window.ledgerTargetDetail = ledgerTargetDetail;
  window.bankTargetDetail = bankTargetDetail;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { ledgerTargetDetail, bankTargetDetail };
}
