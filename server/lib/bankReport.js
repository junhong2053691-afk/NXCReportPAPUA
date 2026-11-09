const { todayKey } = require("./dates");
const { isDemoTenant } = require("./readConfig");
// bankLifecycle 顶层不 require 任何本项目模块（它对 bankReport 的依赖是惰性的），
// 所以这里顶层 require 不会形成循环。
const { isCountedInTotals } = require("./bankLifecycle");
// blockedExpense 不 require 本模块，顶层引用无环。
const { blockedExpenseByDay } = require("./blockedExpense");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const STATUS_LABELS = {
  deposit: "DEPOSIT",
  withdraw: "WITHDRAW",
  wrong: "WRONG",
  "cash in": "CASH IN",
  "cash out": "CASH OUT",
  "give back": "GIVE BACK",
  expenses: "EXPENSES",
  exchange: "EXCHANGE",
  new: "NEW",
  "bank transfer": "BANK TRANSFER",
  "bank trf": "BANK TRF",
  unclaim: "UNCLAIM",
  redeposit: "REDEPOSIT",
  amopay: "AMOPAY",
  "test in": "TEST IN",
  "test out": "TEST OUT",
};

// 日报 REPORT 的 DEPOSIT。不含 unclaim：UNCLAIM 在下面单列，含进来就算了两遍
// （运营 Excel 口径，2026-11-06 确认；测试 daily-report-status.test.js）。
const DEPOSIT_STATUSES = new Set(["deposit", "new"]);
const TOTAL_OUTFLOW_STATUSES = new Set([
  "withdraw",
  "wrong",
  "cash out",
  "expenses",
  "exchange",
  "bank trf",
  "test out",
]);

const C_STATUS_DEFAULTS = ["EZ68", "PK7", "RX66", "AuX6", "LH"];

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

// 余额净额表达式。computeBankDailyReport 的余额分组查询、下面两个单账户查询都引用
// 它，避免三处算法各自漂移。
const NET_EXPR = "COALESCE(SUM(amount_in + trf_amount - ABS(amount_out) - ABS(help_amount)), 0)";

function balanceFromLedger(db, bankAccountId) {
  if (!bankAccountId) return 0;
  const row = db.prepare(`
    SELECT ${NET_EXPR} AS n
    FROM bank_ledger WHERE bank_account_id = ?
  `).get(bankAccountId);
  return money(row?.n);
}

// 截至某个时刻的累计净额。注意与 balanceFromLedger 的差别：这里有 entry_time 上界，
// 和 computeBankDailyReport（:181）一致，所以未来日期的流水不计入。bank_accounts.balance
// 那一列走的是无上界的 balanceFromLedger，两者在存在未来流水时并不相等——报警必须用
// 这个有上界的版本，否则报出来的数和页面上显示的对不上。
function accountBalanceAsOf(db, bankAccountId, endTime) {
  if (!bankAccountId) return 0;
  const row = db.prepare(`
    SELECT ${NET_EXPR} AS n
    FROM bank_ledger WHERE bank_account_id = ? AND entry_time <= ?
  `).get(bankAccountId, endTime);
  return money(row?.n);
}

// 单日净额，对应 computeBankDailyReport 里逐行累加的 day_net（:226-229）。
function accountDayNet(db, bankAccountId, dateKey) {
  if (!bankAccountId) return 0;
  const row = db.prepare(`
    SELECT ${NET_EXPR} AS n
    FROM bank_ledger
    WHERE bank_account_id = ? AND entry_time >= ? AND entry_time <= ?
  `).get(bankAccountId, `${dateKey} 00:00:00`, `${dateKey} 23:59:59`);
  return money(row?.n);
}

// 页面上显示的那个余额——勾了「每天归零分开算」的账户显示当日净额，其余显示累计
// （computeBankDailyReport:276-278 的规则）。报警只允许用这个数。
function displayBalanceForAccount(db, account, dateKey) {
  if (!account) return 0;
  const day = dateKey || todayKey();
  return account.reset_daily_balance
    ? accountDayNet(db, account.id, day)
    : accountBalanceAsOf(db, account.id, `${day} 23:59:59`);
}

function refreshBankBalance(db, bankAccountId, opts = {}) {
  if (!bankAccountId) return 0;
  const n = balanceFromLedger(db, bankAccountId);
  db.prepare(
    "UPDATE bank_accounts SET balance = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(n, bankAccountId);
  // 这是全项目唯一的余额写入路径，所有审批 / 流水增删改都汇到这里，所以报警判定挂在
  // 这里就不可能漏。判定是纯 DB 操作（写 telegram_outbox），不发 HTTP——它运行在调用方
  // 的事务内部，发网络请求会把审批事务一起卡住。
  // 惰性 require 断开 bankAlerts -> bankReport 的循环依赖。
  if (opts.alert !== false) {
    try {
      require("./bankAlerts").evaluateBalanceAlert(db, bankAccountId);
    } catch (e) {
      // 报警判定出任何问题都不能让审批 / 流水写入失败。
      console.warn("[alert] evaluate:", e.message);
    }
  }
  return n;
}

function refreshAllBankBalances(db, companyId = null) {
  const rows = companyId
    ? db.prepare("SELECT id FROM bank_accounts WHERE company_id = ?").all(companyId)
    : db.prepare("SELECT id FROM bank_accounts").all();
  let changed = 0;
  for (const row of rows) {
    const before = db.prepare("SELECT balance FROM bank_accounts WHERE id = ?").get(row.id);
    // 修数据不该触发几十条报警。
    const next = refreshBankBalance(db, row.id, { alert: false });
    if (Math.round((Number(before?.balance || 0) - next) * 100) !== 0) changed++;
  }
  return { checked: rows.length, changed };
}

function outAbs(row) {
  return Math.abs(money(row.amount_out));
}

function bankBranchOf(row) {
  if (!row) return "";
  const bb = String(row.bank_branch || "").trim();
  if (bb) return bb;
  const bank = String(row.bank || "").trim();
  const branch = String(row.branch || "").trim();
  return branch ? `${bank} ${branch}`.trim() : bank;
}

function emptyBankStats(account) {
  return {
    id: account.id,
    bank_branch: bankBranchOf(account),
    account_name: account.account_name,
    bsb: account.bsb,
    account_number: account.account_number,
    payid: account.payid,
    active: account.active,
    lifecycle_status: account.lifecycle_status || "active",
    account_kind: account.account_kind || "nominee",
    reset_daily_balance: account.reset_daily_balance ? 1 : 0,
    balance: money(account.balance),
    tx_count: 0,
    deposit_count: 0,
    day_in: 0,
    day_out: 0,
    day_net: 0,
    total_outflow: 0,
  };
}

function addReport(report, key, amount, countDelta = 0) {
  if (!report[key]) report[key] = { key, label: STATUS_LABELS[key] || key.toUpperCase(), amount: 0, count: 0 };
  report[key].amount += amount;
  report[key].count += countDelta;
}

function parseDate(date) {
  const value = String(date || "").trim();
  return DATE_RE.test(value) ? value : todayKey();
}

// C STATUS 表记的是「我方相对这家对方公司的净收支」，不是资金流向。走我方银行账户的
// 钱按实际方向记（IN 列 → IN，OUT 列 → OUT）；HELP TRF 那一列走的是对方账户，方向相反：
// 对方替我付出（help）＝我欠对方 → 记 IN，对方替我收款（trf）＝对方欠我 → 记 OUT。
// 所以这里 help/trf 与 NET_EXPR（银行余额，纯资金流向）是**对调**的，不是笔误。
// 双方都按同一口径翻转，reconcileAlerts 的 current.total + counterparty.total = 0 不受影响。
// BANK ACC 填不填只决定余额，不改变这里的方向。
function cStatusTotalsForCompany(db, companyId, date) {
  const start = `${date} 00:00:00`;
  const end = `${date} 23:59:59`;
  const rows = db
    .prepare(`
      SELECT c_status,
        COALESCE(SUM(amount_in + ABS(help_amount)), 0) AS amount_in,
        COALESCE(SUM(ABS(amount_out) + ABS(trf_amount)), 0) AS amount_out
      FROM bank_ledger
      WHERE company_id = ? AND entry_time >= ? AND entry_time <= ? AND c_status <> ''
      GROUP BY c_status
    `)
    .all(companyId, start, end);
  const map = new Map();
  for (const row of rows) {
    const name = String(row.c_status || "").trim();
    const inAmount = money(row.amount_in);
    const outAmount = -Math.abs(money(row.amount_out));
    map.set(name, { name, in: inAmount, out: outAmount, total: inAmount + outAmount });
  }
  return map;
}

function counterpartTotalForRule(db, sourceCompanyId, rule, date) {
  const targetCompanyId = String(rule?.target_company_id || "").trim();
  if (!targetCompanyId || targetCompanyId === sourceCompanyId) return 0;

  const targetTotals = cStatusTotalsForCompany(db, targetCompanyId, date);
  let names = [];
  try {
    names = db
      .prepare(
        `SELECT name FROM bank_c_status_options
         WHERE company_id = ? AND target_company_id = ?
         ORDER BY sort_order ASC, name ASC`
      )
      .all(targetCompanyId, sourceCompanyId)
      .map((r) => String(r.name || "").trim())
      .filter(Boolean);
  } catch (_) {}

  return names.reduce((sum, name) => sum + money(targetTotals.get(name)?.total), 0);
}

function computeBankDailyReport(db, companyId, opts = {}) {
  const date = parseDate(opts.date);
  const start = `${date} 00:00:00`;
  const end = `${date} 23:59:59`;

  const accounts = db
    .prepare("SELECT * FROM bank_accounts WHERE company_id = ? ORDER BY sort_order ASC, id ASC")
    .all(companyId);
  const balanceRows = db
    .prepare(`
      SELECT bank_account_id, ${NET_EXPR} AS balance
      FROM bank_ledger
      WHERE company_id = ? AND entry_time <= ?
      GROUP BY bank_account_id
    `)
    .all(companyId, end);
  const balanceMap = new Map(balanceRows.map((row) => [Number(row.bank_account_id), money(row.balance)]));
  const bankMap = new Map(accounts.map((account) => {
    const stats = emptyBankStats(account);
    stats.balance = balanceMap.get(Number(account.id)) || 0;
    return [account.id, stats];
  }));

  const rows = db
    .prepare(`
      SELECT l.*, b.bank_branch, b.bank, b.branch, b.account_name, b.account_number, b.bsb
      FROM bank_ledger l
      LEFT JOIN bank_accounts b ON l.bank_account_id = b.id
      WHERE l.company_id = ? AND l.entry_time >= ? AND l.entry_time <= ?
      ORDER BY l.entry_time ASC, l.id ASC
    `)
    .all(companyId, start, end);

  const report = {};
  const companyMap = new Map();
  const userSet = new Set();
  let transactionCount = 0;
  let depCount = 0;
  let wdCount = 0;
  let newReg = 0;
  let unclaimAmount = 0;
  let totalIn = 0;
  let totalOut = 0;

  for (const row of rows) {
    const status = normalizeStatus(row.status);
    const amountIn = money(row.amount_in);
    const amountOut = outAbs(row);
    const helpAmount = Math.abs(money(row.help_amount));
    const trfAmount = Math.abs(money(row.trf_amount));
    totalIn += amountIn + trfAmount;
    totalOut += amountOut + helpAmount;

    const bank = bankMap.get(row.bank_account_id);
    if (bank) {
      bank.tx_count += 1;
      if ((status === "deposit" || status === "amopay") && amountIn > 0) bank.deposit_count += 1;
      bank.day_in += amountIn + trfAmount;
      bank.day_out += amountOut + helpAmount;
      bank.day_net += amountIn + trfAmount - amountOut - helpAmount;
      if (TOTAL_OUTFLOW_STATUSES.has(status)) bank.total_outflow -= amountOut + helpAmount;
    }

    if (row.username) {
      transactionCount += 1;
      userSet.add(String(row.username).trim());
    }

    // HELP TRF 列的钱同样是这笔流水的金额，只是没走我方银行账户，STATUS 汇总照常计入
    // （Excel 的 WITHDRAW 合计含 HELP TRF 那几笔）。前端 splitHelpTrf 按 status 决定它
    // 落在 help_amount（出账类 status）还是 trf_amount（入账类），所以按方向各取一个，
    // 另一个在该 status 下恒为 0。
    const inTotal = amountIn + trfAmount;
    const outTotal = amountOut + helpAmount;

    if (DEPOSIT_STATUSES.has(status)) addReport(report, "deposit", inTotal, inTotal > 0 ? 1 : 0);
    if (status === "withdraw") {
      addReport(report, "withdraw", -outTotal, outTotal > 0 ? 1 : 0);
      // Split withdraw helper rows are displayed as WITHDRAW but remain IN
      // movements. Keep the existing CASH IN report totals unchanged.
      if (amountIn > 0) addReport(report, "cash in", amountIn, 1);
    }
    if (status === "wrong") addReport(report, "wrong", -outTotal, outTotal > 0 ? 1 : 0);
    if (status === "cash in") addReport(report, "cash in", inTotal, inTotal > 0 ? 1 : 0);
    if (status === "cash out") addReport(report, "cash out", -outTotal, outTotal > 0 ? 1 : 0);
    if (status === "give back") addReport(report, "give back", -outTotal, outTotal > 0 ? 1 : 0);
    // EXCHANGE 刻意是正数（Excel 记换钱总额），REDEP 刻意只记笔数——都是运营口径，别改平。
    if (status === "expenses") addReport(report, "expenses", -outTotal, outTotal > 0 ? 1 : 0);
    if (status === "exchange") addReport(report, "exchange", inTotal + outTotal, 1);
    if (status === "redeposit") addReport(report, "redeposit", 0, 1);
    if (status === "test in") addReport(report, "test in", inTotal, inTotal > 0 ? 1 : 0);
    if (status === "test out") addReport(report, "test out", -outTotal, outTotal > 0 ? 1 : 0);

    if (status === "deposit" || status === "amopay") depCount += inTotal > 0 ? 1 : 0;
    if (status === "withdraw") wdCount += outTotal > 0 ? 1 : 0;
    if (status === "new") newReg += 1;
    if (status === "unclaim") unclaimAmount += inTotal;

    const company = String(row.c_status || "").trim();
    if (company) {
      if (!companyMap.has(company)) {
        companyMap.set(company, { name: company, in: 0, out: 0, total: 0 });
      }
      const item = companyMap.get(company);
      // help/trf 在这里与 NET_EXPR 对调，理由见 cStatusTotalsForCompany 的注释。
      // 这两处必须同口径：一个喂页面的 companyRows，一个喂跨公司对平。
      item.in += amountIn + helpAmount;
      item.out -= amountOut + trfAmount;
      item.total = item.in + item.out;
    }
  }

  // 封禁户余额计入 EXPENSES（口径见 blockedExpense.js / CONTEXT.md）。只加金额、**不加笔数**：
  // 笔数是「expenses 流水几笔」，对的是 Excel，卡住的钱不是一笔流水。
  // 解封 / 转出余额那天它是负的，EXPENSES 可能因此变成正数，这是对的。
  const blockedExpense = (blockedExpenseByDay(db, companyId, date, date).get(date) || 0) / 100;
  if (blockedExpense !== 0) addReport(report, "expenses", -blockedExpense, 0);

  // Daily-reset accounts start from zero for each report date. Their displayed
  // balance is the net movement of the selected day, while regular accounts
  // keep the cumulative balance calculated above.
  for (const bank of bankMap.values()) {
    if (bank.reset_daily_balance) bank.balance = money(bank.day_net);
  }

  const reportPairs = [
    { leftLabel: "DEPOSIT", leftValue: report.deposit?.amount || 0, rightLabel: "TRANSACTION", rightValue: transactionCount, rightIsMetric: true },
    { leftLabel: "WITHDRAW", leftValue: report.withdraw?.amount || 0, rightLabel: "DEP COUNT", rightValue: depCount, rightIsMetric: true },
    { leftLabel: "WRONG", leftValue: report.wrong?.amount || 0, rightLabel: "W/D COUNT", rightValue: wdCount, rightIsMetric: true },
    { leftLabel: "CASH IN", leftValue: report["cash in"]?.amount || 0, rightLabel: "UNIQUE CUST", rightValue: userSet.size, rightIsMetric: true },
    { leftLabel: "CASH OUT", leftValue: report["cash out"]?.amount || 0, rightLabel: "NEW REG", rightValue: newReg, rightIsMetric: true },
    { leftLabel: "GIVE BACK", leftValue: report["give back"]?.amount || 0, rightLabel: "UNCLAIM", rightValue: unclaimAmount, rightIsMetric: false },
    { leftLabel: "EXPENSES", leftValue: report.expenses?.amount || 0, leftBlocked: blockedExpense, rightLabel: "TEST IN", rightValue: report["test in"]?.amount || 0, rightIsMetric: false },
    { leftLabel: "EXCHANGE", leftValue: report.exchange?.amount || 0, rightLabel: "REDEP", rightValue: report.redeposit?.count || 0, rightIsMetric: true },
    { leftLabel: "TEST OUT", leftValue: report["test out"]?.amount || 0, rightLabel: "", rightValue: 0, rightIsMetric: true },
  ];

  const reportRows = [
    report.deposit || { key: "deposit", label: "DEPOSIT", amount: 0, count: 0 },
    report.withdraw || { key: "withdraw", label: "WITHDRAW", amount: 0, count: 0 },
    report.wrong || { key: "wrong", label: "WRONG", amount: 0, count: 0 },
    report["cash in"] || { key: "cash in", label: "CASH IN", amount: 0, count: 0 },
    report["cash out"] || { key: "cash out", label: "CASH OUT", amount: 0, count: 0 },
    report["give back"] || { key: "give back", label: "GIVE BACK", amount: 0, count: 0 },
    { ...(report.expenses || { key: "expenses", label: "EXPENSES", amount: 0, count: 0 }), blocked: blockedExpense },
    report.exchange || { key: "exchange", label: "EXCHANGE", amount: 0, count: 0 },
    report.redeposit || { key: "redeposit", label: "REDEPOSIT", amount: 0, count: 0, isMetric: true },
    report["test in"] || { key: "test in", label: "TEST IN", amount: 0, count: 0 },
    report["test out"] || { key: "test out", label: "TEST OUT", amount: 0, count: 0 },
    { key: "transaction", label: "TRANSACTION", amount: transactionCount, count: transactionCount, isMetric: true },
    { key: "dep_count", label: "DEP COUNT", amount: depCount, count: depCount, isMetric: true },
    { key: "wd_count", label: "W/D COUNT", amount: wdCount, count: wdCount, isMetric: true },
    { key: "unique_cust", label: "UNIQUE CUST", amount: userSet.size, count: userSet.size, isMetric: true },
    { key: "new_reg", label: "NEW REG", amount: newReg, count: newReg, isMetric: true },
    { key: "unclaim", label: "UNCLAIM", amount: unclaimAmount, count: unclaimAmount > 0 ? 1 : 0 },
  ];

  let cStatusNames = [];
  let cStatusRules = [];
  try {
    cStatusRules = db
      .prepare(
        `SELECT o.name, o.target_company_id, o.reconcile_required, c.name AS target_company_name
         FROM bank_c_status_options o
         LEFT JOIN companies c ON c.id = o.target_company_id
         WHERE o.company_id = ? ORDER BY o.sort_order ASC, o.name ASC`
      )
      .all(companyId);
    cStatusNames = cStatusRules.map((r) => r.name);
  } catch (_) {}
  if (!cStatusNames.length && !isDemoTenant()) cStatusNames = C_STATUS_DEFAULTS.slice();
  const seen = new Set(cStatusNames);
  for (const name of companyMap.keys()) {
    if (!seen.has(name)) {
      cStatusNames.push(name);
      seen.add(name);
    }
  }

  const companyRows = cStatusNames.map((name) => companyMap.get(name) || { name, in: 0, out: 0, total: 0 });
  const sourceCompany = (() => {
    try {
      return db.prepare("SELECT name FROM companies WHERE id = ?").get(companyId)?.name || companyId;
    } catch (_) {
      return companyId;
    }
  })();
  // A configured external company link is the source of truth for patrol.
  // Aggregate both sides of each company pair so different C STATUS names
  // (for example EZ68 on one side and AuX6 on the other) can still settle.
  const pairKey = (left, right) => [String(left || ""), String(right || "")].sort().join(":");
  const pairGroups = new Map();
  const ensurePair = (otherId, otherName) => {
    const key = pairKey(companyId, otherId);
    if (!pairGroups.has(key)) {
      pairGroups.set(key, {
        otherId,
        otherName: otherName || otherId,
        currentNames: [],
        counterpartyNames: [],
        required: false,
      });
    }
    const group = pairGroups.get(key);
    if (otherName) group.otherName = otherName;
    return group;
  };

  for (const rule of cStatusRules) {
    const targetId = String(rule.target_company_id || "").trim();
    if (!targetId || targetId === companyId) continue;
    const group = ensurePair(targetId, rule.target_company_name || targetId);
    group.currentNames.push(rule.name);
    if (Number(rule.reconcile_required)) group.required = true;
  }

  try {
    const inboundRules = db
      .prepare(`
        SELECT o.company_id, o.name, o.reconcile_required, c.name AS company_name
        FROM bank_c_status_options o
        LEFT JOIN companies c ON c.id = o.company_id
        WHERE o.target_company_id = ? AND o.company_id <> ?
        ORDER BY o.company_id, o.sort_order ASC, o.name ASC
      `)
      .all(companyId, companyId);
    for (const rule of inboundRules) {
      const group = ensurePair(rule.company_id, rule.company_name || rule.company_id);
      group.counterpartyNames.push(rule.name);
      if (Number(rule.reconcile_required)) group.required = true;
    }
  } catch (_) {}

  const totalsCache = new Map([[companyId, companyMap]]);
  const totalsFor = (cid) => {
    if (!totalsCache.has(cid)) totalsCache.set(cid, cStatusTotalsForCompany(db, cid, date));
    return totalsCache.get(cid);
  };
  const sumNames = (cid, names) => {
    const totals = totalsFor(cid);
    const result = { in: 0, out: 0, total: 0 };
    for (const name of [...new Set(names)].filter(Boolean)) {
      const row = totals.get(name);
      if (!row) continue;
      // Keep the sign: outflow and total are signed values. `money()` is
      // display-oriented and normalizes values to absolute amounts.
      result.in += Number(row.in || 0);
      result.out += Number(row.out || 0);
      result.total += Number(row.total || 0);
    }
    return result;
  };

  const reconcileAlerts = [];
  for (const group of pairGroups.values()) {
    // 「需要对平」是**配对**的属性，不是单边的：任一侧勾了就两边都巡检。只看本方的
    // flag 会让勾了的那家报警、没勾的那家页面上什么都没有，对面的操作手永远不知道
    // 该补账——而差额恰恰只有对面能补。所以这里是 OR，不是 AND，也不是只读本方。
    if (!group.required) continue;
    const current = sumNames(companyId, group.currentNames);
    const counterparty = sumNames(group.otherId, group.counterpartyNames);
    const difference = current.total + counterparty.total;
    if (Math.round(difference * 100) === 0) continue;
    const names = [...new Set([...group.currentNames, ...group.counterpartyNames])].filter(Boolean);
    reconcileAlerts.push({
      name: names.join(" / "),
      // name 拼的是两边的叫法（本方 EZ68 / 对方叫我方 PK7），本方流水里只有本方那个名字。
      // 「查看流水」必须只拿它去搜，整串去搜一行都搜不到（员工演练发现）。
      local_names: [...new Set(group.currentNames)].filter(Boolean),
      in: current.in,
      out: current.out,
      total: current.total,
      counterparty_total: counterparty.total,
      difference,
      source_company_id: companyId,
      source_company_name: sourceCompany,
      target_company_id: group.otherId,
      target_company_name: group.otherName,
      display_name: `${sourceCompany} -> ${group.otherName} / ${names.join(" / ")}`,
    });
  }

  return {
    date,
    totals: {
      total_in: totalIn,
      total_out: totalOut,
      win_loss: (report.deposit?.amount || 0) + (report.withdraw?.amount || 0),
      ledger_rows: rows.length,
      // EXPENSES 里属于封禁户余额的那一份，正数 = 开销（REPORT 里显示为负）。
      blocked_expense: blockedExpense,
      // 汇总口径的唯一真源：只有运营中的非 PG 账户进合计。封禁与归档的钱不算自有
      // 余额，PG 里的钱不是自有资金。前端 isBalanceExcluded 是这条规则的镜像。
      total_balance: [...bankMap.values()].reduce((s, b) => {
        if (!isCountedInTotals(b)) return s;
        return s + money(b.balance);
      }, 0),
    },
    metrics: {
      transaction_count: transactionCount,
      dep_count: depCount,
      wd_count: wdCount,
      unique_customer: userSet.size,
      new_reg: newReg,
      unclaim_amount: unclaimAmount,
    },
    bankRows: [...bankMap.values()],
    reportRows,
    reportPairs,
    companyRows,
    reconcileAlerts,
  };
}

module.exports = {
  computeBankDailyReport,
  balanceFromLedger,
  accountBalanceAsOf,
  accountDayNet,
  displayBalanceForAccount,
  refreshBankBalance,
  refreshAllBankBalances,
  bankBranchOf,
  C_STATUS_DEFAULTS,
};

