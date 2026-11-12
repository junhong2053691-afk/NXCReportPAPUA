const { todayKey, shiftDateKey } = require("./dates");
const { apiCall, loadCfg } = require("../services/platform");
const { testUsernameSql, TX_CUSTOMER_JOIN } = require("./winLoss");

const VERIFY_TYPES = ["DEPOSIT", "WITHDRAW", "BONUS", "MANUAL", "COMMISSION"];
const REPAIR_TYPES = ["DEPOSIT", "WITHDRAW", "BONUS", "MANUAL", "COMMISSION"];
const AMOUNT_TOLERANCE = 0.02;
// Per-transaction ID audit only covers money types — those must be exact to the cent.
const AUDIT_TYPES = ["DEPOSIT", "WITHDRAW"];
const AUDIT_SAMPLE_LIMIT = 20;

function isMoneyType(type) {
  return type === "DEPOSIT" || type === "WITHDRAW";
}

function dbStatsForDay(db, type, date, companyId) {
  const testFilter = isMoneyType(type) ? ` AND ${testUsernameSql("t", "c")}` : "";
  const join = isMoneyType(type) ? ` ${TX_CUSTOMER_JOIN}` : "";
  return db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(t.amount), 0) AS total
       FROM transactions t${join}
       WHERE t.company_id = ? AND t.type = ? AND t.created_date = ?${testFilter}`
    )
    .get(companyId, type, date);
}

function txTestSkip(type, t) {
  if (!isMoneyType(type)) return false;
  const user = t.user && typeof t.user === "object" ? t.user : {};
  const uname = String(user.username || t.username || "").toLowerCase();
  const nname = String(user.name || t.name || "").toLowerCase();
  return uname.includes("test") || nname.includes("test");
}

function customerTestSkip(db, companyId, customerId) {
  if (!customerId) return false;
  const row = db
    .prepare("SELECT username, name FROM customers WHERE company_id = ? AND id = ?")
    .get(companyId, String(customerId));
  if (!row) return false;
  const uname = String(row.username || "").toLowerCase();
  const nname = String(row.name || "").toLowerCase();
  return uname.includes("test") || nname.includes("test");
}

function shouldSkipTx(db, type, t, companyId) {
  if (!isMoneyType(type)) return false;
  if (txTestSkip(type, t)) return true;
  const user = t.user && typeof t.user === "object" ? t.user : {};
  const cid = String(user.id || t.userId || t.customerId || t.memberId || "");
  return customerTestSkip(db, companyId, cid);
}

async function apiStatsForDay(db, type, date, cfg, companyId) {
  const maxPages = Number(cfg.transactionMaxPages || cfg.maxPages || 500);
  let page = 0;
  let count = 0;
  let total = 0;
  while (page < maxPages) {
    const data = await apiCall(
      "/transactions/getAllTransactions",
      {
        type,
        sDate: date + " 00:00:00",
        eDate: date + " 23:59:59",
        pageIndex: page,
        pageSize: Number(cfg.pageSize || 200),
      },
      1,
      companyId
    );
    const rows = data.transactions || [];
    for (const t of rows) {
      if (shouldSkipTx(db, type, t, companyId)) continue;
      count++;
      total += Math.abs(Number(t.cash || t.amount || 0));
    }
    const tp = Number(data.totalPage || 1);
    if (page + 1 >= tp) break;
    page++;
  }
  return { count, total: Math.round(total * 100) / 100 };
}

function amountsClose(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= AMOUNT_TOLERANCE;
}

async function verifyDaySync(db, companyId, date) {
  const cfg = loadCfg();
  const mismatches = [];
  for (const type of VERIFY_TYPES) {
    const dbRow = dbStatsForDay(db, type, date, companyId);
    const apiRow = await apiStatsForDay(db, type, date, cfg, companyId);
    const countOk = dbRow.n === apiRow.count;
    const amountOk = amountsClose(dbRow.total, apiRow.total);
    if (!countOk || !amountOk) {
      mismatches.push({
        date,
        type,
        db: { count: dbRow.n, total: Math.round(dbRow.total * 100) / 100 },
        api: apiRow,
        countOk,
        amountOk,
      });
    }
  }
  return { date, ok: mismatches.length === 0, mismatches };
}

async function repairDayTypes(db, types, helpers, opts = {}) {
  const { mapTransaction, upsertTransactions, fetchTransactionsInRange } = helpers;
  const companyId = opts.companyId;
  const date = opts.date || todayKey();
  const cfg = loadCfg();
  const win = {
    startKey: date,
    endKey: date,
    sDate: date + " 00:00:00",
    eDate: date + " 23:59:59",
  };
  const maxPages = Number(cfg.transactionMaxPages || cfg.maxPages || 500);
  let saved = 0;
  const customerIds = new Set();

  for (const type of types) {
    const raw = await fetchTransactionsInRange(win.startKey, win.endKey, cfg, {
      sDate: win.sDate,
      eDate: win.eDate,
      type,
      delayMs: opts.delayMs,
      maxPages,
      companyId,
    });
    const mapped = raw
      .map(mapTransaction)
      .filter((t) => t && t.id)
      .map((t) => ({ ...t, company_id: companyId }));
    // 补进来的单要和快车道看到的一样进待审批队列，否则「实时交易」看得到、接单区永远看不到。
    // 典型是 23:55 下单、过午夜才完成的单：快车道只拉「今天」，它只能靠昨日对账补进来
    // （2026-11-13 ezspin68 17269528700）。只送**这次新插入**的行：已在库里的单当初就入过队，
    // 再送一遍会把被人删掉的待审批行（测试重置脚本）又翻出来。
    const known = new Set();
    if (isMoneyType(type)) {
      const findTx = db.prepare("SELECT 1 FROM transactions WHERE company_id = ? AND id = ?");
      for (const t of mapped) if (findTx.get(companyId, t.id)) known.add(t.id);
    }
    saved += upsertTransactions(db, mapped);
    const fresh = isMoneyType(type) ? mapped.filter((t) => !known.has(t.id)) : [];
    if (fresh.length) {
      try {
        const enqueue = helpers.enqueuePendingTx || require("./bankApply").enqueuePendingTx;
        const queued = enqueue(db, companyId, fresh);
        console.log("[sync-integrity] repaired", date, type, "queued for approval:", queued);
      } catch (e) {
        console.warn("[bank] enqueue pending (integrity repair):", e.message);
      }
    }
    for (const t of mapped) {
      if (t.customer_id) customerIds.add(t.customer_id);
    }
    console.log("[sync-integrity] repaired", date, type, "rows:", mapped.length);
  }

  return { saved, customerIds: [...customerIds] };
}

function txId(t) {
  return String(t.id || t.transactionId || t.txId || "");
}

function txAmount(t) {
  return Math.abs(Number(t.cash || t.amount || 0));
}

function dbIdMapForDay(db, type, date, companyId) {
  const testFilter = isMoneyType(type) ? ` AND ${testUsernameSql("t", "c")}` : "";
  const join = isMoneyType(type) ? ` ${TX_CUSTOMER_JOIN}` : "";
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.amount AS amount
       FROM transactions t${join}
       WHERE t.company_id = ? AND t.type = ? AND t.created_date = ?${testFilter}`
    )
    .all(companyId, type, date);
  const map = new Map();
  for (const r of rows) {
    if (!r.id) continue;
    map.set(String(r.id), Math.abs(Number(r.amount || 0)));
  }
  return map;
}

async function apiIdMapForDay(db, type, date, cfg, companyId) {
  const maxPages = Number(cfg.transactionMaxPages || cfg.maxPages || 500);
  let page = 0;
  const map = new Map();
  while (page < maxPages) {
    const data = await apiCall(
      "/transactions/getAllTransactions",
      {
        type,
        sDate: date + " 00:00:00",
        eDate: date + " 23:59:59",
        pageIndex: page,
        pageSize: Number(cfg.pageSize || 200),
      },
      1,
      companyId
    );
    const rows = data.transactions || [];
    for (const t of rows) {
      if (shouldSkipTx(db, type, t, companyId)) continue;
      const id = txId(t);
      if (!id) continue;
      map.set(id, txAmount(t));
    }
    const tp = Number(data.totalPage || 1);
    if (page + 1 >= tp) break;
    page++;
  }
  return map;
}

// Read-only per-ID reconciliation for money types. Compares API vs DB transaction
// by transaction, surfacing exactly which rows differ (missing / extra / amount off).
// Does NOT mutate data — the existing count/total repair still handles corrections.
async function auditDayById(db, companyId, date) {
  const cfg = loadCfg();
  const types = [];
  for (const type of AUDIT_TYPES) {
    const dbMap = dbIdMapForDay(db, type, date, companyId);
    const apiMap = await apiIdMapForDay(db, type, date, cfg, companyId);
    const missing = [];
    const extra = [];
    const amountMismatch = [];
    for (const [id, apiAmt] of apiMap) {
      if (!dbMap.has(id)) {
        missing.push({ id, api: apiAmt });
      } else if (Math.abs(apiAmt - dbMap.get(id)) > AMOUNT_TOLERANCE) {
        amountMismatch.push({ id, api: apiAmt, db: dbMap.get(id) });
      }
    }
    for (const [id, dbAmt] of dbMap) {
      if (!apiMap.has(id)) extra.push({ id, db: dbAmt });
    }
    types.push({
      type,
      dbCount: dbMap.size,
      apiCount: apiMap.size,
      missingCount: missing.length,
      extraCount: extra.length,
      amountMismatchCount: amountMismatch.length,
      missing: missing.slice(0, AUDIT_SAMPLE_LIMIT),
      extra: extra.slice(0, AUDIT_SAMPLE_LIMIT),
      amountMismatch: amountMismatch.slice(0, AUDIT_SAMPLE_LIMIT),
    });
  }
  const ok = types.every(
    (t) => t.missingCount === 0 && t.extraCount === 0 && t.amountMismatchCount === 0
  );
  return { date, ok, types };
}

async function auditRecentById(db, companyId, opts = {}) {
  const today = todayKey();
  const dates = opts.dates || [today, shiftDateKey(today, -1)];
  const days = [];
  let ok = true;
  for (const date of dates) {
    const report = await auditDayById(db, companyId, date);
    if (!report.ok) {
      ok = false;
      const off = report.types.filter(
        (t) => t.missingCount || t.extraCount || t.amountMismatchCount
      );
      console.warn("[id-audit]", companyId, date, "diff:", JSON.stringify(off));
    }
    days.push(report);
  }
  return { at: new Date().toISOString(), ok, days };
}

async function verifyTodaySync(db, companyId) {
  return verifyDaySync(db, companyId, todayKey());
}

async function verifyAndRepairToday(db, helpers, opts = {}) {
  return verifyAndRepairDays(db, helpers, { ...opts, dates: [todayKey()] });
}

async function verifyAndRepairDays(db, helpers, opts = {}) {
  const companyId = opts.companyId;
  const dates = opts.dates || [todayKey()];
  let totalRepaired = 0;
  const allCustomerIds = new Set();
  const allMismatches = [];
  let allOk = true;

  for (const date of dates) {
    const check = await verifyDaySync(db, companyId, date);
    if (check.ok) continue;
    allOk = false;
    allMismatches.push(...check.mismatches);

    // Money types (DEPOSIT/WITHDRAW) must always be exact — log them.
    // Non-money types (BONUS/MANUAL/COMMISSION) grow throughout the day as the platform
    // adds new entries; the DB is always slightly behind the API. Only log if the gap is
    // large (>5 records) or if DB is unexpectedly GREATER than API (deletions are unusual).
    const moneyMismatches = check.mismatches.filter((m) => isMoneyType(m.type));
    const nonMoneyLarge = check.mismatches.filter(
      (m) => !isMoneyType(m.type) && (
        (m.db && m.api && m.db.count > m.api.count) ||  // DB > API = unusual
        (m.db && m.api && m.api.count - m.db.count > 5)  // gap > 5 = worth noting
      )
    );
    if (moneyMismatches.length) {
      console.warn("[sync-integrity]", companyId, date, "mismatch:", JSON.stringify(moneyMismatches));
    }
    if (nonMoneyLarge.length) {
      console.warn("[sync-integrity]", companyId, date, "non-money gap:", JSON.stringify(nonMoneyLarge));
    }

    const types = [...new Set(check.mismatches.map((m) => m.type))];
    const repair = await repairDayTypes(db, types, helpers, { ...opts, date });
    totalRepaired += repair.saved;
    for (const id of repair.customerIds || []) allCustomerIds.add(id);
  }

  const recheckMismatches = [];
  for (const date of dates) {
    const recheck = await verifyDaySync(db, companyId, date);
    if (!recheck.ok) {
      allOk = false;
      recheckMismatches.push(...recheck.mismatches);
      // After repair, only re-warn if money types still don't match.
      const moneyStillOff = recheck.mismatches.filter((m) => isMoneyType(m.type));
      if (moneyStillOff.length) {
        console.error("[sync-integrity] still mismatched after repair:", date, JSON.stringify(moneyStillOff));
      }
    }
  }

  return {
    today: todayKey(),
    ok: allOk,
    mismatches: recheckMismatches.length ? recheckMismatches : allMismatches,
    repaired: totalRepaired,
    customerIds: [...allCustomerIds],
    repairedDates: dates,
  };
}

async function verifyAndRepairRecent(db, helpers, opts = {}) {
  const today = todayKey();
  const yesterday = shiftDateKey(today, -1);
  return verifyAndRepairDays(db, helpers, { ...opts, dates: [today, yesterday] });
}

module.exports = {
  VERIFY_TYPES,
  REPAIR_TYPES,
  verifyTodaySync,
  verifyDaySync,
  verifyAndRepairToday,
  verifyAndRepairDays,
  verifyAndRepairRecent,
  repairDayTypes,
  auditDayById,
  auditRecentById,
};
