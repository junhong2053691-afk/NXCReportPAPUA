// 待处理平台单的搜索 / 类型筛选——纯函数，DOM 与分批渲染留在 bank-accounts.js。
//
// 2026-11-06 员工演练：待处理 400+ 行一次全部渲染，没有搜索、筛选、分页，找一笔单只能整页滚。
// 渲染改成先画 PENDING_PAGE_SIZE 行、「显示更多」往后追加（不重画已有行，填了一半的不丢）。
const PENDING_PAGE_SIZE = 50;

function pendingAmountKeys(amount) {
  const n = Number(amount || 0);
  if (!Number.isFinite(n)) return "";
  return [
    String(n),
    n.toFixed(2),
    n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  ].join(" ");
}

function filterPendingRows(rows, opts) {
  const o = opts || {};
  const type = String(o.type || "").trim().toUpperCase();
  const q = String(o.q || "").trim().toLowerCase();
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    if (type && String(r.tx_type || "").toUpperCase() !== type) return false;
    if (!q) return true;
    const hay = [r.tx_id, r.username, r.name, r.tx_time, pendingAmountKeys(r.amount)]
      .map((v) => String(v == null ? "" : v))
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

if (typeof window !== "undefined") {
  window.filterPendingRows = filterPendingRows;
  window.PENDING_PAGE_SIZE = PENDING_PAGE_SIZE;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { filterPendingRows, PENDING_PAGE_SIZE };
}
