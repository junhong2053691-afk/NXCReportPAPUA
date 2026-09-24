#!/usr/bin/env node
/**
 * 数据核对脚本（只读，不做任何订正）
 *
 * 用途：上线前/测试期体检，检出「余额对账查不出来」的那一类问题。
 *
 * 关键前提：refreshBankBalance 是按流水求和重算 bank_accounts.balance 的，
 * 所以余额永远等于流水净额 —— 重复录入会同时进流水和余额，
 * 靠「余额对不对得上」永远发现不了。第 1 项检查才是双计的真正检出手段。
 *
 * 用法：
 *   node scripts/audit-data-integrity.js
 *   TRADER_DB=D:\path\to\other.db node scripts/audit-data-integrity.js
 *
 * 本脚本以只读方式打开数据库，不执行任何写操作。
 */

const { dbPath } = require("../server/lib/paths");

// 以只读方式打开。两种驱动的参数名不同（better-sqlite3: readonly / node:sqlite: readOnly），
// 都尝试一遍，任一可用即可。
function openReadonly(file) {
  try {
    const Database = require("better-sqlite3");
    return { db: new Database(file, { readonly: true }), driver: "better-sqlite3" };
  } catch (err) {
    if (err && err.code !== "MODULE_NOT_FOUND") throw err;
  }
  const { DatabaseSync } = require("node:sqlite");
  return { db: new DatabaseSync(file, { readOnly: true }), driver: "node:sqlite" };
}

const DB_FILE = dbPath();
const { db, driver } = openReadonly(DB_FILE);

function all(sql, ...params) {
  try {
    return db.prepare(sql).all(...params);
  } catch (err) {
    return { error: err.message };
  }
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

function line(char) {
  return char.repeat(72);
}

const summary = [];

function report(title, note, rows, render) {
  console.log("");
  console.log(line("="));
  console.log(title);
  if (note) console.log("  " + note);
  console.log(line("="));

  if (rows && rows.error) {
    console.log("  查询失败：" + rows.error);
    summary.push({ title, hits: "ERR" });
    return;
  }
  if (!rows || !rows.length) {
    console.log("  未发现记录。");
    summary.push({ title, hits: 0 });
    return;
  }
  rows.forEach((row) => console.log("  " + render(row)));
  console.log("  —— 共 " + rows.length + " 条");
  summary.push({ title, hits: rows.length });
}

console.log(line("#"));
console.log("数据核对（只读）");
console.log("  数据库: " + DB_FILE);
console.log("  驱动  : " + driver);
console.log("  时间  : " + new Date().toISOString());
console.log(line("#"));

// ---------------------------------------------------------------------------
// 1. 流水层重复：手工录入的双击 Enter 指纹
//    同公司/同账户/同状态/四个金额全同，且 created_at 相距 120 秒内。
//    这是「保存成功但界面无反馈 → 操作员再按一次」留下的痕迹。
// ---------------------------------------------------------------------------
report(
  "1. 疑似重复录入的手工流水（双击 Enter 指纹）",
  "同公司/账户/状态/金额，创建时间相距 120 秒内。这是余额对账查不出来的那一类双计。",
  all(`
    SELECT a.company_id, a.id AS id_a, b.id AS id_b, a.bank_account_id, a.status,
           a.amount_in, a.amount_out, a.help_amount, a.trf_amount,
           a.created_at AS created_a, b.created_at AS created_b,
           CAST((julianday(b.created_at) - julianday(a.created_at)) * 86400 AS INTEGER) AS gap_seconds
    FROM bank_ledger a
    JOIN bank_ledger b
      ON  b.company_id = a.company_id
      AND b.id > a.id
      AND b.auto_generated = 0
      AND b.bank_account_id = a.bank_account_id
      AND b.status = a.status
      AND b.amount_in = a.amount_in
      AND b.amount_out = a.amount_out
      AND b.help_amount = a.help_amount
      AND b.trf_amount = a.trf_amount
    WHERE a.auto_generated = 0
      AND (julianday(b.created_at) - julianday(a.created_at)) * 86400 BETWEEN 0 AND 120
      AND (a.amount_in > 0 OR a.amount_out > 0 OR a.help_amount > 0 OR a.trf_amount > 0)
    ORDER BY a.company_id, gap_seconds
  `),
  (r) =>
    `${r.company_id} 账户#${r.bank_account_id} [${r.status}] ` +
    `流水 #${r.id_a} 与 #${r.id_b} 相隔 ${r.gap_seconds}s | ` +
    `in=${money(r.amount_in)} out=${money(r.amount_out)} ` +
    `help=${money(r.help_amount)} trf=${money(r.trf_amount)} | ${r.created_a}`
);

// ---------------------------------------------------------------------------
// 2. 跨公司 tx_id 撞号
//    bank_balance_log 只有 UNIQUE(tx_id)、没有 company_id，
//    所以一旦两家公司的平台单号相同，第二家那笔会被判「已处理」静默跳过。
// ---------------------------------------------------------------------------
report(
  "2. 跨公司 tx_id 撞号（bank_balance_log 缺 company_id 的暴露面）",
  "bank_balance_log 的唯一约束是全局 UNIQUE(tx_id)。撞号时第二家公司的充值会被静默跳过。",
  all(`
    SELECT t.id AS tx_id,
           COUNT(DISTINCT t.company_id) AS companies,
           GROUP_CONCAT(DISTINCT t.company_id) AS who,
           (SELECT COUNT(1) FROM bank_balance_log b WHERE b.tx_id = t.id) AS in_balance_log
    FROM transactions t
    GROUP BY t.id
    HAVING COUNT(DISTINCT t.company_id) > 1
    ORDER BY in_balance_log DESC, t.id
  `),
  (r) =>
    `tx_id=${r.tx_id} 被 ${r.companies} 家公司共用 (${r.who})` +
    (r.in_balance_log > 0
      ? "  <<< 已进入 bank_balance_log，存在实际漏计风险"
      : "  (尚未进入 bank_balance_log)")
);

// ---------------------------------------------------------------------------
// 3. 孤儿流水：bank_account_id = 0，不归属任何账户
//    这些钱在流水里有记录，但不计入任何账户余额。
// ---------------------------------------------------------------------------
report(
  "3. 孤儿流水（bank_account_id = 0，不计入任何账户余额）",
  "auto_generated=1 的部分尤其可疑：自动入账不应产生无账户归属的流水。",
  all(`
    SELECT company_id, auto_generated, COUNT(1) AS n,
           SUM(amount_in) AS sum_in, SUM(amount_out) AS sum_out,
           SUM(help_amount) AS sum_help, SUM(trf_amount) AS sum_trf
    FROM bank_ledger
    WHERE bank_account_id = 0
    GROUP BY company_id, auto_generated
    ORDER BY company_id, auto_generated
  `),
  (r) =>
    `${r.company_id} ${r.auto_generated ? "自动生成" : "手工录入"}: ${r.n} 条 | ` +
    `in=${money(r.sum_in)} out=${money(r.sum_out)} ` +
    `help=${money(r.sum_help)} trf=${money(r.sum_trf)}`
);

// ---------------------------------------------------------------------------
// 4. 孤儿 balance_log：指向已被删除的银行账户
// ---------------------------------------------------------------------------
report(
  "4. bank_balance_log 中账户归属异常的记录",
  "bank_account_id=0 表示入账时就没有账户归属；>0 但账户不存在表示支付渠道被删除后残留。" +
    "两者都会继续占用 tx_id（该表唯一约束是全局 UNIQUE(tx_id)）。",
  all(`
    SELECT b.bank_account_id,
           CASE WHEN b.bank_account_id = 0 THEN '无账户归属' ELSE '账户已被删除' END AS kind,
           COUNT(1) AS n, SUM(b.amount) AS sum_amount,
           MIN(b.applied_at) AS first_at, MAX(b.applied_at) AS last_at
    FROM bank_balance_log b
    WHERE b.bank_account_id = 0
       OR NOT EXISTS (SELECT 1 FROM bank_accounts a WHERE a.id = b.bank_account_id)
    GROUP BY b.bank_account_id
    ORDER BY n DESC
  `),
  (r) =>
    `${r.kind} (bank_account_id=${r.bank_account_id}): ${r.n} 条 | ` +
    `合计 ${money(r.sum_amount)} | ${r.first_at} ~ ${r.last_at}`
);

// ---------------------------------------------------------------------------
// 5. 空 company_id：任何公司的报表都查不到，资金行凭空消失
// ---------------------------------------------------------------------------
const emptyCompanyRows = [];
[
  ["bank_accounts", "支付渠道"],
  ["bank_ledger", "账单流水"],
  ["bank_tx_pending", "待处理平台单"],
].forEach(([table, label]) => {
  const rows = all(
    `SELECT COUNT(1) AS n FROM ${table} WHERE TRIM(COALESCE(company_id, '')) = ''`
  );
  if (rows && rows.error) {
    emptyCompanyRows.push({ label, table, n: "ERR: " + rows.error });
  } else if (rows[0] && rows[0].n > 0) {
    emptyCompanyRows.push({ label, table, n: rows[0].n });
  }
});
report(
  "5. company_id 为空的记录（任何公司报表都查不到）",
  "成因：/api/banks 缺 requireCompany，companyId 回退成空串后仍允许写入。",
  emptyCompanyRows,
  (r) => `${r.label} (${r.table}): ${r.n} 条`
);

// ---------------------------------------------------------------------------
// 6. 余额 vs 流水净额：回归基线。当前应全为 0。
//    注意：这一项恒为 0 并不能证明没有双计（见文件头说明）。
// ---------------------------------------------------------------------------
report(
  "6. 余额与流水净额不一致的账户",
  "回归基线，正常应为 0 条。提醒：此项通过不代表没有双计 —— 双计会同时进流水和余额。",
  all(`
    SELECT a.company_id, a.id, a.bank, a.active,
           ROUND(a.balance, 2) AS stored,
           ROUND(COALESCE((
             SELECT SUM(l.amount_in + l.trf_amount - l.amount_out - l.help_amount)
             FROM bank_ledger l
             WHERE l.company_id = a.company_id AND l.bank_account_id = a.id
           ), 0), 2) AS ledger_net
    FROM bank_accounts a
    WHERE ROUND(a.balance, 2) <> ROUND(COALESCE((
            SELECT SUM(l.amount_in + l.trf_amount - l.amount_out - l.help_amount)
            FROM bank_ledger l
            WHERE l.company_id = a.company_id AND l.bank_account_id = a.id
          ), 0), 2)
    ORDER BY a.company_id, a.id
  `),
  (r) =>
    `${r.company_id} 账户#${r.id} ${r.bank}${r.active ? " (使用中)" : ""}: ` +
    `余额 ${money(r.stored)} vs 流水净额 ${money(r.ledger_net)} | ` +
    `差额 ${money(Number(r.stored) - Number(r.ledger_net))}`
);

// ---------------------------------------------------------------------------
// 7. 重复手机号 + 空 customer_id 交易数
//    winLoss 等处有「customer_id 为空时按 mobile 回退 JOIN」的逻辑，
//    customers.mobile 无唯一约束 —— 两者同时成立才会造成金额按客户数倍增。
// ---------------------------------------------------------------------------
const emptyCustomerId = all(`
  SELECT COUNT(1) AS n FROM transactions
  WHERE TRIM(COALESCE(customer_id, '')) = ''
`);
const emptyCount =
  emptyCustomerId && emptyCustomerId.error
    ? "ERR"
    : Number(emptyCustomerId[0] ? emptyCustomerId[0].n : 0);

report(
  "7. 同公司内重复的手机号",
  `前提条件 —— customer_id 为空的交易：${emptyCount} 条。` +
    (emptyCount === 0
      ? "为 0，说明 mobile 回退 JOIN 当前不被触发，本项风险未激活。"
      : "大于 0，mobile 回退 JOIN 会被触发，重复手机号将导致 win_loss 等金额按客户数倍增。"),
  all(`
    SELECT company_id, mobile, COUNT(1) AS n, GROUP_CONCAT(id) AS customer_ids
    FROM customers
    WHERE TRIM(COALESCE(mobile, '')) <> ''
    GROUP BY company_id, mobile
    HAVING COUNT(1) > 1
    ORDER BY n DESC, company_id
  `),
  (r) => `${r.company_id} mobile=${r.mobile}: ${r.n} 个客户记录 (id: ${r.customer_ids})`
);

// ---------------------------------------------------------------------------
// 总结
// ---------------------------------------------------------------------------
console.log("");
console.log(line("#"));
console.log("总结（命中数）");
console.log(line("#"));
summary.forEach((item) => {
  const flag = item.hits === "ERR" ? "[!]" : item.hits > 0 ? "[x]" : "[ ]";
  console.log(`  ${flag} ${item.hits}\t${item.title}`);
});
console.log("");
console.log("  [ ] = 无命中   [x] = 有命中，需人工确认   [!] = 查询出错");
console.log("  本脚本只读，未对数据库做任何修改。");
console.log("");

db.close();
