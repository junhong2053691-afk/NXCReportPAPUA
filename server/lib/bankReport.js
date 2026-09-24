const { todayKey } = require("./dates");
const { isDemoTenant } = require("./readConfig");

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

const DEPOSIT_STATUSES = new Set(["deposit", "new", "unclaim"]);
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

function balanceFromLedger(db, bankAccountId) {
  if (!bankAccountId) return 0;
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_in + trf_amount - ABS(amount_out) - ABS(help_amount)), 0) AS n
    FROM bank_ledger WHERE bank_account_id = ?
  `).get(bankAccountId);
  return money(row?.n);
}

function refreshBankBalance(db, bankAccountId) {
  if (!bankAccountId) return 0;
  const n = balanceFromLedger(db, bankAccountId);
  db.prepare(
    "UPDATE bank_accounts SET balance = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(n, bankAccountId);
  return n;
}

function refreshAllBankBalances(db, companyId = null) {
  const rows = companyId
    ? db.prepare("SELECT id FROM bank_accounts WHERE company_id = ?").all(companyId)
    : db.prepare("SELECT id FROM bank_accounts").all();
  let changed = 0;
  for (const row of rows) {
    const before = db.prepare("SELECT balance FROM bank_accounts WHERE id = ?").get(row.id);
    const next = refreshBankBalance(db, row.id);
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

function cStatusTotalsForCompany(db, companyId, date) {
  const start = `${date} 00:00:00`;
  const end = `${date} 23:59:59`;
  const rows = db
    .prepare(`
      SELECT c_status,
        COALESCE(SUM(amount_in + trf_amount), 0) AS amount_in,
        COALESCE(SUM(ABS(amount_out) + ABS(help_amount)), 0) AS amount_out
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
      SELECT bank_account_id,
        COALESCE(SUM(amount_in + trf_amount - ABS(amount_out) - ABS(help_amount)), 0) AS balance
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

    if (DEPOSIT_STATUSES.has(status)) addReport(report, "deposit", amountIn, amountIn > 0 ? 1 : 0);
    if (status === "withdraw") {
      addReport(report, "withdraw", -amountOut, amountOut > 0 ? 1 : 0);
      // Split withdraw helper rows are displayed as WITHDRAW but remain IN
      // movements. Keep the existing CASH IN report totals unchanged.
      if (amountIn > 0) addReport(report, "cash in", amountIn, 1);
    }
    if (status === "wrong") addReport(report, "wrong", -amountOut, amountOut > 0 ? 1 : 0);
    if (status === "cash in") {
      const cashInTotal = amountIn + trfAmount;
      addReport(report, "cash in", cashInTotal, cashInTotal > 0 ? 1 : 0);
    }
    if (status === "cash out") addReport(report, "cash out", -amountOut, amountOut > 0 ? 1 : 0);
    if (status === "expenses") addReport(report, "expenses", -amountOut, amountOut > 0 ? 1 : 0);
    if (status === "exchange") addReport(report, "exchange", amountIn + amountOut, 1);
    if (status === "redeposit") addReport(report, "redeposit", 0, 1);
    if (status === "test in") addReport(report, "test in", amountIn, amountIn > 0 ? 1 : 0);
    if (status === "test out") addReport(report, "test out", -amountOut, amountOut > 0 ? 1 : 0);

    if (status === "deposit" || status === "amopay") depCount += amountIn > 0 ? 1 : 0;
    if (status === "withdraw") wdCount += amountOut > 0 ? 1 : 0;
    if (status === "new") newReg += 1;
    if (status === "unclaim") unclaimAmount += amountIn;

    const company = String(row.c_status || "").trim();
    if (company) {
      if (!companyMap.has(company)) {
        companyMap.set(company, { name: company, in: 0, out: 0, total: 0 });
      }
      const item = companyMap.get(company);
      item.in += amountIn + trfAmount;
      item.out -= amountOut + helpAmount;
      item.total = item.in + item.out;
    }
  }

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
    { leftLabel: "EXPENSES", leftValue: report.expenses?.amount || 0, rightLabel: "UNCLAIM", rightValue: unclaimAmount, rightIsMetric: false },
    { leftLabel: "EXCHANGE", leftValue: report.exchange?.amount || 0, rightLabel: "TEST IN", rightValue: report["test in"]?.amount || 0, rightIsMetric: false },
    { leftLabel: "TEST OUT", leftValue: report["test out"]?.amount || 0, rightLabel: "REDEP", rightValue: report.redeposit?.count || 0, rightIsMetric: true },
  ];

  const reportRows = [
    report.deposit || { key: "deposit", label: "DEPOSIT", amount: 0, count: 0 },
    report.withdraw || { key: "withdraw", label: "WITHDRAW", amount: 0, count: 0 },
    report.wrong || { key: "wrong", label: "WRONG", amount: 0, count: 0 },
    report["cash in"] || { key: "cash in", label: "CASH IN", amount: 0, count: 0 },
    report["cash out"] || { key: "cash out", label: "CASH OUT", amount: 0, count: 0 },
    report.expenses || { key: "expenses", label: "EXPENSES", amount: 0, count: 0 },
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
      });
    }
    const group = pairGroups.get(key);
    if (otherName) group.otherName = otherName;
    return group;
  };

  for (const rule of cStatusRules) {
    const targetId = String(rule.target_company_id || "").trim();
    if (!targetId || targetId === companyId) continue;
    ensurePair(targetId, rule.target_company_name || targetId).currentNames.push(rule.name);
  }

  try {
    const inboundRules = db
      .prepare(`
        SELECT o.company_id, o.name, c.name AS company_name
        FROM bank_c_status_options o
        LEFT JOIN companies c ON c.id = o.company_id
        WHERE o.target_company_id = ? AND o.company_id <> ?
        ORDER BY o.company_id, o.sort_order ASC, o.name ASC
      `)
      .all(companyId, companyId);
    for (const rule of inboundRules) {
      ensurePair(rule.company_id, rule.company_name || rule.company_id).counterpartyNames.push(rule.name);
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
    const current = sumNames(companyId, group.currentNames);
    const counterparty = sumNames(group.otherId, group.counterpartyNames);
    const difference = current.total + counterparty.total;
    if (Math.round(difference * 100) === 0) continue;
    const names = [...new Set([...group.currentNames, ...group.counterpartyNames])].filter(Boolean);
    reconcileAlerts.push({
      name: names.join(" / "),
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
      total_balance: [...bankMap.values()].reduce((s, b) => {
        if (b.lifecycle_status === "banned") return s;
        if (b.account_kind === "payment_gateway") return s;
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

module.exports = { computeBankDailyReport, balanceFromLedger, refreshBankBalance, refreshAllBankBalances, bankBranchOf };

