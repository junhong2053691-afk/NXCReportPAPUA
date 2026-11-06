// 封禁户银行申诉 CSV——纯函数（数据来自 GET /api/banks/:id/appeal-deposits，见 server/lib/appealExport.js）。
//
// 抬头：户口、户名、BSB、账号、PayID、期间、笔数、合计；空一行；明细按时间正序。
// 字段名用英文（交给银行看）。文本单元格以 = + - @ 开头时前面加单引号，防止 Excel 把客户姓名
// 当公式执行；金额是我们自己格式化的数字，不加。
function appealCsvCell(value, opts) {
  let text = String(value == null ? "" : value);
  // 单独一个「-」（期间为空的占位）构不成公式，不加。
  if (!(opts && opts.numeric) && /^[=+\-@]./.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildAppealCsv(bank, rows, opts) {
  const b = bank || {};
  const list = Array.isArray(rows) ? rows : [];
  const nameOf = (opts && typeof opts.nameOf === "function") ? opts.nameOf : (v) => String(v == null ? "" : v);
  const cents = list.reduce((sum, r) => sum + Math.round((Number(r.amount_in) || 0) * 100), 0);
  const dates = list.map((r) => String(r.entry_time || "").slice(0, 10)).filter(Boolean);
  const period = dates.length ? `${dates[0]} to ${dates[dates.length - 1]}` : "-";
  const lines = [
    ["Account", b.bank_branch || b.bank || ""],
    ["Account name", b.account_name || ""],
    ["BSB", b.bsb || ""],
    ["Account number", b.account_number || ""],
    ["PayID", b.payid || ""],
    ["Period", period],
    ["Deposits", String(list.length)],
    ["Total", (cents / 100).toFixed(2)],
  ].map(([k, v]) => `${appealCsvCell(k)},${appealCsvCell(v)}`);
  lines.push("");
  lines.push("DATE,TIME,AMOUNT,TRANS ID,USERNAME,NAME,STATUS");
  for (const r of list) {
    const time = String(r.entry_time || "");
    lines.push([
      appealCsvCell(time.slice(0, 10)),
      appealCsvCell(time.slice(11, 16)),
      appealCsvCell((Math.round((Number(r.amount_in) || 0) * 100) / 100).toFixed(2), { numeric: true }),
      appealCsvCell(r.tx_id),
      appealCsvCell(r.username),
      appealCsvCell(nameOf(r.name)),
      appealCsvCell(String(r.status || "").trim().toUpperCase()),
    ].join(","));
  }
  return lines.join("\r\n");
}

if (typeof window !== "undefined") window.buildAppealCsv = buildAppealCsv;
if (typeof module !== "undefined" && module.exports) module.exports = { buildAppealCsv };
