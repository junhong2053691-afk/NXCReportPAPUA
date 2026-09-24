const { todayKey } = require("./dates");
const { segmentWhere } = require("./customerSegments");
const { customerApiWinLoss } = require("./winLoss");

const SEGMENT_LABELS = {
  dep_today: "今日有充值",
  never_deposited: "从未充值",
  active_depositor: "活跃客户",
  offline_3_7: "沉默 3-7 天",
  offline_7plus: "沉默 7 天+",
  all: "所有顾客",
};

function findCustomer(db, companyId, { id, mobile }) {
  const cid = String(companyId || "").trim();
  const custId = String(id || "").trim();
  const mob = String(mobile || "").trim();
  if (custId) {
    const row = db.prepare("SELECT * FROM customers WHERE company_id = ? AND id = ?").get(cid, custId);
    if (row) return row;
  }
  if (mob) {
    return db.prepare("SELECT * FROM customers WHERE company_id = ? AND mobile = ? ORDER BY dep_total DESC LIMIT 1").get(cid, mob);
  }
  return null;
}

function detectSegment(db, customer, companyId) {
  const today = todayKey();
  const order = ["dep_today", "active_depositor", "offline_3_7", "offline_7plus", "never_deposited"];
  for (const key of order) {
    const hit = db
      .prepare(`SELECT 1 AS ok FROM customers c WHERE c.company_id = ? AND c.id = ? AND ${segmentWhere(key, today, "c", companyId)} LIMIT 1`)
      .get(companyId, customer.id);
    if (hit) return key;
  }
  return "all";
}

function computeCustomerDetail(db, companyId, opts = {}) {
  const customer = findCustomer(db, companyId, opts);
  if (!customer) return null;
  const today = todayKey();
  const mobile = String(customer.mobile || "").trim();
  const testFilter = " AND LOWER(COALESCE(t.username, '')) NOT LIKE '%test%' AND LOWER(COALESCE(t.name, '')) NOT LIKE '%test%'";

  const todayStats = db
    .prepare(
      `SELECT
         SUM(CASE WHEN t.type = 'DEPOSIT' THEN 1 ELSE 0 END) AS dep_count,
         COALESCE(SUM(CASE WHEN t.type = 'DEPOSIT' THEN t.amount ELSE 0 END), 0) AS dep_total,
         SUM(CASE WHEN t.type = 'WITHDRAW' THEN 1 ELSE 0 END) AS wd_count,
         COALESCE(SUM(CASE WHEN t.type = 'WITHDRAW' THEN t.amount ELSE 0 END), 0) AS wd_total
       FROM transactions t
       WHERE t.company_id = ? AND t.created_date = ? AND t.type IN ('DEPOSIT', 'WITHDRAW')
         AND (t.customer_id = ? OR t.mobile = ?)${testFilter}`
    )
    .get(companyId, today, customer.id, mobile);

  const txRows = db
    .prepare(
      `SELECT t.id, t.type, t.amount, t.status, t.created_at, t.created_date, t.method, t.mobile, t.name
       FROM transactions t
       WHERE t.company_id = ?
         AND (t.customer_id = ? OR t.mobile = ?)
       ORDER BY t.created_at DESC
       LIMIT 50`
    )
    .all(companyId, customer.id, mobile);

  const segment = detectSegment(db, customer, companyId);
  const depTotal = Number(customer.dep_total || 0);
  const wdTotal = Math.abs(Number(customer.wd_total || 0));
  const winLoss = customerApiWinLoss(customer);

  return {
    customer: {
      id: customer.id,
      username: customer.username || "",
      name: customer.name || "",
      mobile: customer.mobile || "",
      referrer: customer.referrer || "",
      top_referrer: customer.top_referrer || "",
      bank_account: customer.bank_account || "",
      bank_name: customer.bank_name || "",
      register_date: customer.register_date || "",
      register_date_key: customer.register_date_key || "",
      last_login: customer.last_login || "",
      last_login_date: customer.last_login_date || "",
      last_deposit: customer.last_deposit || "",
      dep_count: customer.dep_count || 0,
      dep_total: depTotal,
      wd_count: customer.wd_count || 0,
      wd_total: wdTotal,
      win_loss: winLoss,
    },
    segment,
    segmentLabel: SEGMENT_LABELS[segment] || segment,
    stats: {
      today: {
        dep_count: todayStats?.dep_count || 0,
        dep_total: todayStats?.dep_total || 0,
        wd_count: todayStats?.wd_count || 0,
        wd_total: Math.abs(Number(todayStats?.wd_total || 0)),
      },
      allTime: {
        dep_count: customer.dep_count || 0,
        dep_total: depTotal,
        wd_count: customer.wd_count || 0,
        wd_total: wdTotal,
        win_loss: winLoss,
      },
    },
    transactions: txRows,
    companyId,
  };
}

module.exports = { computeCustomerDetail, SEGMENT_LABELS };
