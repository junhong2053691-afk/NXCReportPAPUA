// 跨公司来单提醒的数据源（GET /api/banks/pending-tx/all-companies）。
//
// operator 停在 A 公司时，B 公司进了平台待审批单，前端靠这个接口知道，滑一条通知下来
// （public/js/cross-company-alerts.js）。只对 operator 开：admin 不弹（产品决定，见 CONTEXT.md）。
//
// 权限是**每次按库复核**的（authorizedCompanyIds 查 user_companies），不信前端传的公司列表，
// 也不看 session 里缓存的公司——撤掉某家的授权，下一次轮询就看不到那家了。
//
// 返回的行**包含当前公司**：前端要用它把「停在这家时看到的单」记成已看过（Q18），
// 切回别家后才不会把刚处理剩下的单再弹一遍。字段刻意只给通知要用的几个：
// 不带客户真名 `name`，免得个人信息出现在每个页面的角落里。
const { isOperator, authorizedCompanyIds } = require("./userAccess");
const { listCompanies } = require("./companies");

// 待审批正常是个位数到几十笔；这只是挡住异常积压把 8 秒一次的轮询撑大。
// **每家各取**最新 N 笔，不能是全局 LIMIT：一家积压上千笔时会把别家挤成 0 笔，
// 前端据此对那家 `update("")`，清掉与 app.js 共用的 `bank-pending-alarm:<公司>`（静默期被重置）、
// 已看过也被裁空。每家只要有 pending 就至少出现一行。
const MAX_ROWS_PER_COMPANY = 300;

function crossCompanyPending(db, user, currentCompanyId) {
  const current = String(currentCompanyId || "");
  const off = { enabled: false, current, companies: [], rows: [] };
  if (!isOperator(user)) return off;

  const ids = authorizedCompanyIds(db, user);
  if (ids.length < 2) return off; // 只授权一家就没有「别家」

  const allowed = new Set(ids);
  const companies = listCompanies(db)
    .filter((c) => allowed.has(c.id))
    .map((c) => ({ id: c.id, name: c.name }));
  const marks = companies.map(() => "?").join(", ");
  const rows = companies.length
    ? db
        .prepare(
          `SELECT id, company_id, tx_type, amount, username FROM (
             SELECT id, company_id, tx_type, amount, username,
                    ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY id DESC) AS rn
               FROM bank_tx_pending
              WHERE state = 'pending' AND company_id IN (${marks})
           )
            WHERE rn <= ?
            ORDER BY id DESC`
        )
        .all(...companies.map((c) => c.id), MAX_ROWS_PER_COMPANY)
    : [];

  return { enabled: true, current, companies, rows };
}

module.exports = { crossCompanyPending, MAX_ROWS_PER_COMPANY };
