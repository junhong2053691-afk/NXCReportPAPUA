const { getDb } = require("../db/init");
const { fetchAllPages, loadCfg, apiCall, isAccessDenied } = require("./platform");
const { computeDashboard, saveDailyStats } = require("./stats");
const { todayKey, dateKeyFromIso, shiftDateKey, formatSydneyDateTime } = require("../lib/dates");
const { refreshCustomerWinLoss } = require("../lib/winLoss");
const { promoFromTransaction } = require("../lib/promoName");
const { cleanDisplayName, cleanLedgerName } = require("../lib/displayName");

const { syncStatePath } = require("../lib/paths");
const { updateSyncStatus } = require("../lib/companies");
const { invalidateSegmentCounts } = require("../lib/segmentCountCache");
const {
  LEDGER_FIELDS,
  TRANSACTION_AUDIT_FIELDS,
  appendAuditEvent,
  diffFields,
  ledgerRefs,
  pickFields,
  platformActor,
  runAtomic,
  systemActor,
} = require("../lib/auditLog");

function getReferrer(u) {
  const keys = [
    "referrer", "referer", "referrerName", "refererName",
    "agent", "agentName", "ref", "reference", "registerReferrer",
  ];
  for (const k of keys) {
    const v = u[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  if (u.bank && typeof u.bank === "object") {
    for (const k of ["referrer", "referer", "agent", "agentName"]) {
      const v = u.bank[k];
      if (v != null && String(v).trim()) return String(v).trim();
    }
  }
  return "";
}

function parseBank(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return {};
    }
  }
  return {};
}

function mapCustomer(u) {
  const bank = parseBank(u.bank);
  const dep_total = Number(u.lifetimeDeposit || u.depTotal || 0);
  const wd_total = Math.abs(Number(u.wdTotal || u.withdrawTotal || 0));
  const apiWl = Number(u.winLoss || u.win_loss || u.companyWinLoss || 0);
  return {
    id: String(u.id || u.userId || u.memberId || ""),
    username: u.username || "",
    name: cleanDisplayName(u.name || ""),
    mobile: u.mobile || u.phone || "",
    bank_account: bank.accountNumber || bank.bankAccount || u.bankAccount || "",
    bank_name: bank.bankName || bank.bank || u.bankName || "",
    referrer: u.referrerName || u.referrerCode || getReferrer(u),
    top_referrer: u.topReferrerName || u.topReferrerCode || u.topReferrer || u.topReferer || "",
    dep_count: Number(u.depCount || u.depositCount || 0),
    dep_total,
    wd_count: Number(u.wdCount || u.withdrawCount || 0),
    wd_total,
    win_loss: apiWl !== 0 ? apiWl : dep_total - wd_total,
    last_deposit: u.lastDepDateTime || u.lastDeposit || "",
    last_login: u.visitedDateTime || u.lastLogin || "",
    register_date: u.createdDateTime || u.registerDate || "",
    register_date_key: dateKeyFromIso(u.createdDateTime || u.registerDate || ""),
    last_login_date: dateKeyFromIso(u.visitedDateTime || u.lastLogin || ""),
    synced_at: new Date().toISOString(),
  };
}

const SYNC_TX_TYPES = new Set(["DEPOSIT", "WITHDRAW", "BONUS", "MANUAL", "COMMISSION"]);

function attachmentUrlFromTransaction(t, details = {}) {
  const candidates = [
    t.attachment,
    t.attachmentUrl,
    t.attachmentURL,
    t.slip,
    t.slipUrl,
    t.receipt,
    t.receiptUrl,
    details.attachment,
    details.attachmentUrl,
    details.slip,
  ];
  for (const raw of candidates) {
    if (raw == null || raw === "") continue;
    if (Array.isArray(raw)) {
      const first = String(raw[0] || "").trim();
      if (first) return first;
      continue;
    }
    if (typeof raw === "object") {
      const url = String(raw.url || raw.href || "").trim();
      if (url) return url;
      continue;
    }
    const text = String(raw).trim();
    if (text) return text;
  }
  return "";
}

function normalizeTxType(raw) {
  const type = String(raw || "").toUpperCase();
  if (type.includes("WITHDRAW") || type === "WITHDRAW") return "WITHDRAW";
  if (type.includes("DEPOSIT")) return "DEPOSIT";
  if (SYNC_TX_TYPES.has(type)) return type;
  return null;
}

function mapTransaction(t) {
  const type = normalizeTxType(t.type || t.transactionType || t.txType);
  if (!type) return null;
  const bank = t.bank && typeof t.bank === "object" ? t.bank : {};
  const user = t.user && typeof t.user === "object" ? t.user : {};
  let details = {};
  if (t.details && typeof t.details === "string") {
    try {
      details = JSON.parse(t.details);
    } catch (_) {}
  }
  const promo = promoFromTransaction(t, details);
  return {
    id: String(t.id || t.transactionId || t.txId || ""),
    type,
    customer_id: String(user.id || t.userId || t.customerId || t.memberId || ""),
    username: user.username || t.username || "",
    name: user.name || t.name || t.customerName || "",
    mobile: user.mobile || t.mobile || "",
    amount: Math.abs(Number(t.cash || t.amount || details.amount || 0)),
    bank_name: details.bank || t.bankName || bank.bankName || bank.bank || "",
    bank_account_name: bank.accountName || t.bankAccountName || "",
    bank_account_number: bank.accountNumber || t.bankAccountNumber || "",
    bank_bsb: bank.bsb || t.bankBSB || "",
    payid: bank.payId || t.payId || t.payid || "",
    method: details.method || t.method || t.paymentMethod || "",
    status: t.status || "",
    attachment_url: attachmentUrlFromTransaction(t, details),
    created_at: t.createdDateTime || t.createdAt || "",
    created_date: dateKeyFromIso(t.createdDateTime || t.createdAt || ""),
    processed_at: t.processedDateTime || t.processedAt || "",
    completed_at: t.endDateTime || t.completedDateTime || t.completedAt || "",
    operator: t.operator || t.processedBy || t.agent || "",
    remark: t.remark || "",
    promo_id: promo.promo_id,
    promo_name: promo.promo_name,
    synced_at: new Date().toISOString(),
  };
}

function upsertCustomers(db, rows, opts = {}) {
  const profileOnly = Boolean(opts.profileOnly);
  const moneySet = profileOnly
    ? ""
    : `dep_total=excluded.dep_total,
      dep_count=CASE WHEN excluded.dep_count > 0 THEN excluded.dep_count ELSE customers.dep_count END,
      wd_count=CASE WHEN excluded.wd_count > 0 THEN excluded.wd_count ELSE customers.wd_count END,
      wd_total=CASE WHEN excluded.wd_total > 0 THEN excluded.wd_total ELSE customers.wd_total END,
      win_loss=excluded.win_loss,`;
  const stmt = db.prepare(
    `INSERT INTO customers (
      company_id, id, username, name, mobile, bank_account, bank_name, referrer, top_referrer,
      dep_count, dep_total, wd_count, wd_total, win_loss,
      last_deposit, last_login, register_date, register_date_key, last_login_date, synced_at
    ) VALUES (
      @company_id, @id, @username, @name, @mobile, @bank_account, @bank_name, @referrer, @top_referrer,
      @dep_count, @dep_total, @wd_count, @wd_total, @win_loss,
      @last_deposit, @last_login, @register_date, @register_date_key, @last_login_date, @synced_at
    )
    ON CONFLICT(company_id, id) DO UPDATE SET
      username=excluded.username, name=excluded.name, mobile=excluded.mobile,
      bank_account=excluded.bank_account, bank_name=excluded.bank_name,
      referrer=excluded.referrer, top_referrer=excluded.top_referrer,
      ${moneySet}
      last_deposit=CASE WHEN excluded.last_deposit != '' THEN excluded.last_deposit ELSE customers.last_deposit END,
      last_login=excluded.last_login,
      register_date=excluded.register_date, register_date_key=excluded.register_date_key,
      last_login_date=excluded.last_login_date, synced_at=excluded.synced_at`
  );
  for (const row of rows) {
    if (!row.id) continue;
    stmt.run(row);
  }
  return rows.filter((r) => r.id).length;
}

function upsertTransactions(db, rows) {
  const valid = rows.filter((r) => r.id);
  if (!valid.length) return 0;
  const findExisting = db.prepare("SELECT * FROM transactions WHERE company_id = ? AND id = ?");
  const findSaved = db.prepare("SELECT * FROM transactions WHERE company_id = ? AND id = ?");
  const stmt = db.prepare(
    `INSERT INTO transactions (
      company_id, id, type, customer_id, username, name, mobile, amount,
      bank_name, bank_account_name, bank_account_number, bank_bsb, payid,
      method, status, attachment_url, created_at, created_date, processed_at, completed_at,
      operator, remark, promo_id, promo_name, synced_at
    ) VALUES (
      @company_id, @id, @type, @customer_id, @username, @name, @mobile, @amount,
      @bank_name, @bank_account_name, @bank_account_number, @bank_bsb, @payid,
      @method, @status, @attachment_url, @created_at, @created_date, @processed_at, @completed_at,
      @operator, @remark, @promo_id, @promo_name, @synced_at
    )
    ON CONFLICT(company_id, id) DO UPDATE SET
      type=excluded.type, customer_id=excluded.customer_id, username=excluded.username,
      name=excluded.name, mobile=excluded.mobile, amount=excluded.amount,
      bank_name=excluded.bank_name, bank_account_name=excluded.bank_account_name,
      bank_account_number=excluded.bank_account_number, bank_bsb=excluded.bank_bsb,
      payid=excluded.payid, method=excluded.method, status=excluded.status,
      attachment_url=CASE
        WHEN TRIM(COALESCE(excluded.attachment_url, '')) != '' THEN excluded.attachment_url
        ELSE transactions.attachment_url
      END,
      created_at=excluded.created_at,
      created_date=excluded.created_date, processed_at=excluded.processed_at,
      completed_at=excluded.completed_at, operator=excluded.operator, remark=excluded.remark,
      promo_id=CASE WHEN excluded.promo_id != '' THEN excluded.promo_id ELSE transactions.promo_id END,
      promo_name=CASE WHEN excluded.promo_name != '' THEN excluded.promo_name ELSE transactions.promo_name END,
      synced_at=excluded.synced_at`
  );
  runAtomic(db, () => {
    for (const row of valid) {
      const existing = findExisting.get(row.company_id, row.id);
      stmt.run(row);
      const saved = findSaved.get(row.company_id, row.id);
      if (!existing) {
        appendAuditEvent(db, {
          companyId: row.company_id,
          action: "platform_transaction.synced",
          source: "platform",
          actor: platformActor(),
          summary: `平台交易 ${row.id} 首次同步`,
          after: pickFields(saved, TRANSACTION_AUDIT_FIELDS),
          refs: [{ type: "transaction", id: row.id }],
          dedupeKey: `platform_transaction:synced:${row.id}`,
        });
        continue;
      }
      const changes = diffFields(existing, saved, TRANSACTION_AUDIT_FIELDS);
      if (!changes.changed.length) continue;
      appendAuditEvent(db, {
        companyId: row.company_id,
        action: "platform_transaction.changed",
        source: "platform",
        actor: platformActor(),
        summary: `平台交易 ${row.id} 更新了 ${changes.changed.join(", ")}`,
        before: changes.before,
        after: changes.after,
        metadata: { changed_fields: changes.changed },
        refs: [{ type: "transaction", id: row.id }],
      });
    }
  });
  return valid.length;
}

async function syncUserTailPages(db, companyId, tailPages, cfg) {
  const probe = await fetchAllPages(
    "/users/getAllUsers",
    {},
    (data) => data.users || data.list || [],
    { companyId, maxPages: 1, startPage: 0, returnMeta: true }
  );
  const totalPage = Number(probe.totalPage || 1);
  const n = Math.max(1, Number(tailPages || 3));
  const startPage = Math.max(0, totalPage - n);
  return syncUsers(db, companyId, { maxPages: n, startPage });
}

function pruneStaleCustomers(db, companyId, apiIds) {
  const keep = apiIds instanceof Set ? apiIds : new Set(apiIds);
  const staleIds = db
    .prepare("SELECT id FROM customers WHERE company_id = ?")
    .all(companyId)
    .map((r) => r.id)
    .filter((id) => id && !keep.has(id));
  if (!staleIds.length) return { removed: 0, ids: [] };
  const delStmt = (n) =>
    db.prepare(
      "DELETE FROM customers WHERE company_id = ? AND id IN (" + Array(n).fill("?").join(",") + ")"
    );
  for (let i = 0; i < staleIds.length; i += 400) {
    const chunk = staleIds.slice(i, i + 400);
    delStmt(chunk.length).run(companyId, ...chunk);
  }
  console.log("[sync]", companyId, "pruned stale customers:", staleIds.length);
  return { removed: staleIds.length, ids: staleIds.slice(0, 20) };
}

async function probeApiUserTotal(companyId, cfg) {
  const pageSize = Number(cfg.pageSize || 200);
  const p0 = await apiCall("/users/getAllUsers", { pageIndex: 0, pageSize }, 1, companyId);
  const totalPage = Number(p0.totalPage || p0.totalPages || 1);
  const plast = await apiCall(
    "/users/getAllUsers",
    { pageIndex: Math.max(0, totalPage - 1), pageSize },
    1,
    companyId
  );
  const lastCount = (plast.users || plast.list || []).length;
  return { total: (totalPage - 1) * pageSize + lastCount, totalPage };
}

async function reconcileUsersWithApi(db, companyId, cfg, opts = {}) {
  const dbCount = db.prepare("SELECT COUNT(*) AS n FROM customers WHERE company_id = ?").get(companyId).n;
  const probe = await probeApiUserTotal(companyId, cfg);
  const forceInterval = Number(cfg.userPruneIntervalSeconds || 3600);
  const force = Boolean(opts.force) || shouldRunInterval(opts.lastFullUserReconcileAt, forceInterval);
  const countMismatch = dbCount !== probe.total;
  // Quick tick: never block dashboard sync on hourly full user import (can be 300+ pages).
  if (opts.quick && force && !countMismatch && !opts.force) {
    console.log("[sync]", companyId, "defer scheduled full reconcile (quick tick)");
    return { skipped: true, deferred: true, dbCount, apiTotal: probe.total, removed: 0, saved: 0, probe };
  }
  if (!force && !countMismatch) {
    return { skipped: true, dbCount, apiTotal: probe.total, removed: 0, saved: 0, probe };
  }
  const reason = force && !countMismatch ? "scheduled full reconcile" : "count mismatch DB " + dbCount + " vs probe " + probe.total;
  console.log("[sync]", companyId, reason, "- full reconcile from getAllUsers");
  const result = { ...(await syncAllUsersFromApi(db, companyId, cfg)), reconciled: true, forced: force };
  return result;
}

async function syncAllUsersFromApi(db, companyId, cfg) {
  const fetched = await fetchAllPages(
    "/users/getAllUsers",
    {},
    (data) => data.users || data.list || [],
    {
      companyId,
      maxPages: Number(cfg.maxPages || 500),
      delayMs: Number(cfg.quickRequestDelayMs ?? 40),
      returnMeta: true,
    }
  );
  const users = fetched.rows || [];
  const mapped = users
    .map((u) => ({ ...mapCustomer(u), company_id: companyId }))
    .filter((r) => r.id);
  const saved = upsertCustomers(db, mapped, { profileOnly: false });
  const apiIds = new Set(mapped.map((r) => r.id));
  const pruned = pruneStaleCustomers(db, companyId, apiIds);
  return { saved, apiTotal: apiIds.size, ...pruned };
}

async function syncUsers(db, companyId, opts = {}) {
  const fetchOpts = { companyId, returnMeta: true };
  if (opts.maxPages != null) fetchOpts.maxPages = opts.maxPages;
  if (opts.startPage != null) fetchOpts.startPage = opts.startPage;
  // 金额字段始终来自 getAllUsers API，分页同步不得清零或跳过更新
  const profileOnly = Boolean(opts.profileOnly);
  const fetched = await fetchAllPages(
    "/users/getAllUsers",
    {},
    (data) => data.users || data.list || [],
    fetchOpts
  );
  const users = fetched.rows || fetched;
  const mapped = users.map((u) => {
    const row = { ...mapCustomer(u), company_id: companyId };
    if (profileOnly) {
      row.dep_count = 0;
      row.dep_total = 0;
      row.wd_count = 0;
      row.wd_total = 0;
      row.win_loss = 0;
    }
    return row;
  });
  const saved = upsertCustomers(db, mapped, { profileOnly });
  return {
    saved,
    startPage: fetched.startPage ?? opts.startPage ?? 0,
    pagesFetched: fetched.pagesFetched ?? 0,
    totalPages: fetched.totalPage ?? 0,
  };
}

function transactionFetchOpts(cfg) {
  return { maxPages: Number(cfg.transactionMaxPages || cfg.maxPages || 500) };
}

const QUICK_TX_TYPES = ["DEPOSIT", "WITHDRAW", "BONUS", "MANUAL", "COMMISSION"];

async function fetchTransactionsInRange(startKey, endKey, cfg, opts = {}) {
  const extra = {
    sDate: opts.sDate || startKey + " 00:00:00",
    eDate: opts.eDate || endKey + " 23:59:59",
  };
  if (opts.type) extra.type = opts.type;
  if (cfg.syncFullTransactions) extra.mode = "full";
  const fetchOpts = { ...transactionFetchOpts(cfg) };
  if (opts.delayMs != null) fetchOpts.delayMs = opts.delayMs;
  if (opts.maxPages != null) fetchOpts.maxPages = opts.maxPages;
  if (opts.companyId) fetchOpts.companyId = opts.companyId;
  if (opts.returnMeta) fetchOpts.returnMeta = true;
  return fetchAllPages(
    "/transactions/getAllTransactions",
    extra,
    (data) => data.transactions || data.list || data.records || [],
    fetchOpts
  );
}

function quickTransactionWindow() {
  const today = todayKey();
  // Always pull the full Sydney calendar day. Incremental watermarks miss earlier
  // deposits when the latest row is a later bonus/activity transaction.
  return {
    startKey: today,
    endKey: today,
    sDate: today + " 00:00:00",
    eDate: today + " 23:59:59",
    incremental: false,
    fullDay: true,
  };
}

async function syncTransactions(db, opts = {}) {
  const cfg = loadCfg();
  const today = todayKey();
  const backfill = Boolean(opts.backfill);
  const quick = Boolean(opts.quick);
  const chunkDays = Math.min(31, Math.max(1, Number(cfg.transactionChunkDays || 31)));
  const raw = [];
  let truncation = null;

  if (quick && !backfill) {
    const win = quickTransactionWindow();
    opts._fullDay = win.fullDay;
    const maxPages = Number(cfg.transactionQuickMaxPages || 50);
    // Fast lane syncs only the latency-critical money types (deposits/withdrawals);
    // the slow lane passes all types for full accuracy.
    const types = Array.isArray(opts.txTypes) && opts.txTypes.length ? opts.txTypes : QUICK_TX_TYPES;
    console.log("[sync]", opts.companyId, "transactions full-day by-type", win.sDate, "to", win.endKey, "[" + types.join(",") + "]");
    truncation = {};
    for (const type of types) {
      const res = await fetchTransactionsInRange(win.startKey, win.endKey, cfg, {
        sDate: win.sDate,
        eDate: win.eDate,
        type,
        delayMs: opts.delayMs,
        maxPages,
        companyId: opts.companyId,
        returnMeta: true,
      });
      const chunk = res.rows || [];
      const totalPage = Number(res.totalPage || 1);
      // The API reports more pages than our per-tick cap allows — today's rows for this
      // type were only partially pulled. The slow-lane integrity pass will still reconcile,
      // but flag it loudly so silent under-counting can't happen unnoticed.
      const hit = totalPage > maxPages;
      truncation[type] = { hit, totalPage, maxPages };
      if (hit) {
        console.warn("[sync]", opts.companyId, "TRUNCATED", type, "today: totalPage", totalPage, ">", maxPages, "— possible missing rows");
      }
      console.log("[sync]", type, "today:", chunk.length);
      raw.push(...chunk);
    }
  } else {
    const totalDays = Math.max(
      1,
      Number(
        opts.days ??
          (backfill
            ? cfg.transactionBackfillDays || cfg.transactionSyncDays || 365
            : cfg.transactionRecentDays || cfg.transactionSyncDays || 7)
      )
    );
    let end = today;
    let remaining = totalDays;
    while (remaining > 0) {
      const span = Math.min(chunkDays, remaining);
      const start = shiftDateKey(end, -(span - 1));
      console.log("[sync] transactions chunk", start, "to", end, backfill ? "(backfill)" : "(recent)");
      try {
        const chunk = await fetchTransactionsInRange(start, end, cfg, { delayMs: opts.delayMs, companyId: opts.companyId });
        raw.push(...chunk);
      } catch (e) {
        console.warn("[sync] chunk failed", start, end, e.message);
        if (!backfill) throw e;
      }
      remaining -= span;
      end = shiftDateKey(start, -1);
    }
  }

  const companyId = opts.companyId;
  const mapped = raw
    .map(mapTransaction)
    .filter((t) => t && t.id)
    .map((t) => ({ ...t, company_id: companyId }));
  if (raw.length && mapped.length < raw.length) {
    console.log("[sync] skipped", raw.length - mapped.length, "unsupported transaction types");
  }
  const saved = upsertTransactions(db, mapped);
  try {
    const { enqueuePendingTx } = require("../lib/bankApply");
    enqueuePendingTx(db, companyId, mapped);
  } catch (e) {
    console.warn("[bank] enqueue pending:", e.message);
  }
  return {
    saved,
    customerIds: [...new Set(mapped.map((t) => t.customer_id).filter(Boolean))],
    fullDay: Boolean(opts._fullDay),
    truncation,
  };
}

function applyDepositsToBank(db, companyId, mappedTxs) {
  const activeBank = db
    .prepare("SELECT id FROM bank_accounts WHERE company_id = ? AND active = 1 ORDER BY id LIMIT 1")
    .get(companyId);
  if (!activeBank) return;

  const deposits = mappedTxs.filter(
    (t) =>
      t.type === "DEPOSIT" &&
      String(t.method || "").toLowerCase() !== "redeposit"
  );
  if (!deposits.length) return;

  // Check which tx_ids haven't been applied yet
  const ids = deposits.map((t) => t.id);
  const placeholders = ids.map(() => "?").join(",");
  const existingSet = new Set(
    db
      .prepare(`SELECT tx_id FROM bank_balance_log WHERE tx_id IN (${placeholders})`)
      .all(...ids)
      .map((r) => r.tx_id)
  );

  const newDeposits = deposits.filter((t) => !existingSet.has(t.id));
  if (!newDeposits.length) return;

  const total = newDeposits.reduce((sum, t) => sum + Number(t.amount || 0), 0);
  if (total <= 0) return;

  const logStmt = db.prepare(
    "INSERT OR IGNORE INTO bank_balance_log (bank_account_id, tx_id, amount) VALUES (?, ?, ?)"
  );
  // Also insert ledger entries for each new deposit
  const ledgerStmt = db.prepare(`
    INSERT OR IGNORE INTO bank_ledger
      (bank_account_id, company_id, entry_time, tx_id, status, amount_in, amount_out, username, name, auto_generated)
    VALUES (?, ?, ?, ?, 'deposit', ?, 0, ?, ?, 1)
  `);
  runAtomic(db, () => {
    db.prepare(
      "UPDATE bank_accounts SET balance = balance + ?, updated_at = datetime('now') WHERE id = ?"
    ).run(total, activeBank.id);
    for (const t of newDeposits) {
      logStmt.run(activeBank.id, t.id, Number(t.amount || 0));
      const entryTime = formatSydneyDateTime(t.created_at || new Date().toISOString());
      const inserted = ledgerStmt.run(
        activeBank.id,
        companyId,
        entryTime,
        t.id,
        Number(t.amount || 0),
        t.username || "",
        cleanLedgerName(t.name)
      );
      const ledger = db.prepare("SELECT * FROM bank_ledger WHERE id = ?").get(inserted.lastInsertRowid);
      appendAuditEvent(db, {
        companyId,
        action: "ledger.created",
        source: "system",
        actor: systemActor("Automatic deposit sync"),
        summary: `系统为平台充值 ${t.id} 自动创建流水`,
        after: pickFields(ledger, LEDGER_FIELDS),
        metadata: { automatic: true, trigger: "deposit_sync" },
        refs: ledgerRefs(ledger),
        dedupeKey: `system:auto_deposit_ledger:${t.id}`,
      });
    }
  });
  console.log(
    `[bank] ${companyId} +$${total.toFixed(2)} to bank #${activeBank.id} from ${newDeposits.length} new deposit(s)`
  );
}

function readSyncState(companyId) {
  const fs = require("fs");
  try {
    return JSON.parse(fs.readFileSync(syncStatePath(companyId), "utf8").replace(/^\uFEFF/, ""));
  } catch (_) {
    return {};
  }
}

function writeSyncState(companyId, ok, message, counts, extra = {}) {
  const fs = require("fs");
  const prev = readSyncState(companyId);
  const state = {
    ...prev,
    ok,
    message,
    accessDenied: extra.accessDenied ?? false,
    at: new Date().toISOString(),
    users: counts.users,
    transactions: counts.transactions,
    mode: extra.mode || prev.mode || "quick",
    lastUserSyncAt: extra.lastUserSyncAt || prev.lastUserSyncAt || null,
    lastTailAt: extra.lastTailAt || prev.lastTailAt || null,
    lastTxSyncedAt: extra.lastTxSyncedAt || prev.lastTxSyncedAt || null,
    lastFullDayTxSyncAt: extra.lastFullDayTxSyncAt ?? prev.lastFullDayTxSyncAt ?? null,
    lastIntegrityAt: extra.lastIntegrityAt ?? prev.lastIntegrityAt ?? null,
    lastYesterdayIntegrityAt: extra.lastYesterdayIntegrityAt ?? prev.lastYesterdayIntegrityAt ?? null,
    lastIntegrityOk: extra.lastIntegrityOk ?? prev.lastIntegrityOk ?? true,
    integrityFailStreak: extra.integrityFailStreak ?? prev.integrityFailStreak ?? 0,
    integrityMismatches: extra.integrityMismatches ?? prev.integrityMismatches ?? [],
    lastRepairAt: extra.lastRepairAt ?? prev.lastRepairAt ?? null,
    lastEnrichAt: extra.lastEnrichAt || prev.lastEnrichAt || null,
    lastPruneAt: extra.lastPruneAt || prev.lastPruneAt || null,
    lastFullUserReconcileAt: extra.lastFullUserReconcileAt ?? prev.lastFullUserReconcileAt ?? null,
    apiUserTotal: extra.apiUserTotal ?? prev.apiUserTotal ?? null,
    recentDaysDone: extra.recentDaysDone ?? prev.recentDaysDone ?? false,
    userNextPage: extra.userNextPage ?? prev.userNextPage ?? 0,
    userImportComplete: extra.userImportComplete ?? prev.userImportComplete ?? false,
    userTotalPages: extra.userTotalPages ?? prev.userTotalPages ?? 0,
    idAudit: extra.idAudit ?? prev.idAudit ?? null,
    truncation: extra.truncation ?? prev.truncation ?? null,
    durationMs: extra.durationMs ?? null,
  };
  fs.writeFileSync(syncStatePath(companyId), JSON.stringify(state, null, 2), "utf8");
}

function shouldRunInterval(lastAt, intervalSeconds) {
  if (!lastAt) return true;
  const sec = Number(intervalSeconds || 0);
  if (sec <= 0) return true;
  return Date.now() - Date.parse(lastAt) >= sec * 1000;
}

function ensureCustomersFromTransactions(db, companyId) {
  // Disabled: transaction stubs are not API users and become ghost records.
  // Customers must come from getAllUsers only; reconcile prunes stale rows.
  return 0;
}

function enrichCustomersFromTransactions(db, companyId) {
  ensureCustomersFromTransactions(db, companyId);
  const depRows = db
    .prepare(
      `SELECT COALESCE(NULLIF(t.customer_id, ''), c.id) AS customer_id,
              COUNT(*) AS dep_count,
              COALESCE(SUM(t.amount), 0) AS dep_sum,
              MAX(t.created_at) AS last_deposit
       FROM transactions t
       LEFT JOIN customers c ON c.company_id = t.company_id
         AND (t.customer_id IS NULL OR t.customer_id = '')
         AND t.mobile IS NOT NULL AND t.mobile != ''
         AND c.mobile = t.mobile
       WHERE t.company_id = @company_id AND t.type = 'DEPOSIT'
         AND COALESCE(NULLIF(t.customer_id, ''), c.id) IS NOT NULL
         AND COALESCE(NULLIF(t.customer_id, ''), c.id) != ''
       GROUP BY COALESCE(NULLIF(t.customer_id, ''), c.id)`
    )
    .all({ company_id: companyId });
  const wdRows = db
    .prepare(
      `SELECT COALESCE(NULLIF(t.customer_id, ''), c.id) AS customer_id,
              COUNT(*) AS wd_count,
              COALESCE(SUM(t.amount), 0) AS wd_sum
       FROM transactions t
       LEFT JOIN customers c ON c.company_id = t.company_id
         AND (t.customer_id IS NULL OR t.customer_id = '')
         AND t.mobile IS NOT NULL AND t.mobile != ''
         AND c.mobile = t.mobile
       WHERE t.company_id = @company_id AND t.type = 'WITHDRAW'
         AND COALESCE(NULLIF(t.customer_id, ''), c.id) IS NOT NULL
         AND COALESCE(NULLIF(t.customer_id, ''), c.id) != ''
       GROUP BY COALESCE(NULLIF(t.customer_id, ''), c.id)`
    )
    .all({ company_id: companyId });

  const updDep = db.prepare(
    `UPDATE customers SET
      dep_count = CASE WHEN @dep_count > 0 THEN @dep_count ELSE dep_count END,
      dep_total = CASE WHEN @dep_sum > 0 THEN @dep_sum ELSE dep_total END,
      last_deposit = CASE WHEN @last_deposit != '' THEN @last_deposit ELSE last_deposit END
     WHERE company_id = @company_id AND id = @customer_id`
  );
  const updWd = db.prepare(
    `UPDATE customers SET
      wd_count = @wd_count,
      wd_total = @wd_sum
     WHERE company_id = @company_id AND id = @customer_id`
  );

  const touched = new Set();
  for (const row of depRows) {
    updDep.run({
      company_id: companyId,
      customer_id: row.customer_id,
      dep_count: row.dep_count,
      dep_sum: row.dep_sum,
      last_deposit: row.last_deposit || "",
    });
    touched.add(row.customer_id);
  }
  for (const row of wdRows) {
    updWd.run({
      company_id: companyId,
      customer_id: row.customer_id,
      wd_count: row.wd_count,
      wd_sum: row.wd_sum,
    });
    touched.add(row.customer_id);
  }
  for (const id of touched) refreshCustomerWinLoss(db, companyId, id);
  console.log("[sync]", companyId, "enriched customers:", depRows.length, "dep,", wdRows.length, "wd");
}

function enrichCustomersFromIds(db, customerIds, companyId) {
  if (!customerIds.length) return;
  const placeholders = customerIds.map(() => "?").join(",");
  const depRows = db
    .prepare(
      `SELECT COALESCE(NULLIF(t.customer_id, ''), c.id) AS customer_id,
              COUNT(*) AS dep_count,
              COALESCE(SUM(t.amount), 0) AS dep_sum,
              MAX(t.created_at) AS last_deposit
       FROM transactions t
       LEFT JOIN customers c ON c.company_id = t.company_id
         AND (t.customer_id IS NULL OR t.customer_id = '')
         AND t.mobile IS NOT NULL AND t.mobile != ''
         AND c.mobile = t.mobile
       WHERE t.company_id = ? AND t.type = 'DEPOSIT'
         AND COALESCE(NULLIF(t.customer_id, ''), c.id) IN (${placeholders})
       GROUP BY COALESCE(NULLIF(t.customer_id, ''), c.id)`
    )
    .all(companyId, ...customerIds);
  const wdRows = db
    .prepare(
      `SELECT COALESCE(NULLIF(t.customer_id, ''), c.id) AS customer_id,
              COUNT(*) AS wd_count,
              COALESCE(SUM(t.amount), 0) AS wd_sum
       FROM transactions t
       LEFT JOIN customers c ON c.company_id = t.company_id
         AND (t.customer_id IS NULL OR t.customer_id = '')
         AND t.mobile IS NOT NULL AND t.mobile != ''
         AND c.mobile = t.mobile
       WHERE t.company_id = ? AND t.type = 'WITHDRAW'
         AND COALESCE(NULLIF(t.customer_id, ''), c.id) IN (${placeholders})
       GROUP BY COALESCE(NULLIF(t.customer_id, ''), c.id)`
    )
    .all(companyId, ...customerIds);

  const updDep = db.prepare(
    `UPDATE customers SET
      dep_count = CASE WHEN @dep_count > 0 THEN @dep_count ELSE dep_count END,
      dep_total = CASE WHEN @dep_sum > 0 THEN @dep_sum ELSE dep_total END,
      last_deposit = CASE WHEN @last_deposit != '' THEN @last_deposit ELSE last_deposit END
     WHERE company_id = @company_id AND id = @customer_id`
  );
  const updWd = db.prepare(
    `UPDATE customers SET wd_count = @wd_count, wd_total = @wd_sum WHERE company_id = @company_id AND id = @customer_id`
  );
  const touched = new Set();
  for (const row of depRows) {
    updDep.run({
      company_id: companyId,
      customer_id: row.customer_id,
      dep_count: row.dep_count,
      dep_sum: row.dep_sum,
      last_deposit: row.last_deposit || "",
    });
    touched.add(row.customer_id);
  }
  for (const row of wdRows) {
    updWd.run({
      company_id: companyId,
      customer_id: row.customer_id,
      wd_count: row.wd_count,
      wd_sum: row.wd_sum,
    });
    touched.add(row.customer_id);
  }
  for (const id of touched) refreshCustomerWinLoss(db, companyId, id);
  if (depRows.length || wdRows.length) {
    console.log("[sync]", companyId, "enriched", customerIds.length, "customers (quick)");
  }
}

// Tracks whether each company is in an access-denied state and when it was last logged.
// We log: (1) the first time it goes denied, (2) every 10 minutes while still denied,
// (3) immediately when it recovers. This makes long outages impossible to miss.
const accessDeniedState = new Map();   // companyId -> boolean
const accessDeniedLoggedAt = new Map(); // companyId -> timestamp (ms)

async function runSyncInner(opts = {}) {
  const companyId = opts.companyId;
  if (!companyId) throw new Error("runSync requires companyId");
  const started = Date.now();
  const cfg = loadCfg();
  const backfill = Boolean(opts.backfill);
  const full = Boolean(opts.full);
  const quick = !backfill && !full && opts.quick !== false;
  // lane: "fast" = today tx + tail users + stats (near real-time);
  //       "slow" = rotating full user import + reconcile/prune (heavy, low frequency).
  // Manual full/backfill runs behave like the heavy path (lane "slow").
  const lane = opts.lane || (quick ? "fast" : "slow");
  const state = readSyncState(companyId);
  const mode = backfill ? "backfill" : full ? "full" : quick ? (lane === "slow" ? "slow" : "fast") : "recent";
  console.log("[sync]", companyId, "start", new Date().toISOString(), "(" + mode + ")");
  const db = getDb();
  let users = 0;
  let transactions = 0;
  let customerIds = [];
  let lastUserSyncAt = state.lastUserSyncAt || null;
  let lastTailAt = state.lastTailAt || null;
  let lastEnrichAt = state.lastEnrichAt || null;
  let lastPruneAt = state.lastPruneAt || null;
  let lastFullUserReconcileAt = state.lastFullUserReconcileAt || null;
  let userNextPage = Number(state.userNextPage || 0);
  let userImportComplete = Boolean(state.userImportComplete);
  let userTotalPages = Number(state.userTotalPages || 0);
  const customerCount = db.prepare("SELECT COUNT(*) AS n FROM customers WHERE company_id = ?").get(companyId).n;
  if (quick && customerCount > 0 && !lastUserSyncAt) {
    lastUserSyncAt = new Date().toISOString();
  }

  try {
    const syncUsersNow =
      !opts.txOnly &&
      (full || backfill || shouldRunInterval(lastUserSyncAt, cfg.userSyncIntervalSeconds || 300));

    const runTailUserSync = async () => {
      if (!quick || opts.txOnly) return;
      const tailPages = Number(cfg.userTailPages ?? 3);
      try {
        const tail = await syncUserTailPages(db, companyId, tailPages, cfg);
        users += tail.saved;
        console.log(
          "[sync]",
          companyId,
          "tail users pages",
          tail.startPage + "-" + (tail.startPage + tail.pagesFetched - 1),
          "/",
          tail.totalPages,
          ":",
          tail.saved
        );
      } catch (e) {
        console.warn("[sync] tail users failed:", e.message);
      }
    };

    const runUserSync = async () => {
      if (!syncUsersNow) {
        if (quick) console.log("[sync] backfill users skipped (interval)");
        return;
      }
      try {
        const userMaxPages = quick
          ? Number(cfg.userQuickMaxPages ?? (customerCount === 0 ? 25 : 15))
          : undefined;
        const userStartPage = quick ? userNextPage : 0;
        const userResult = await syncUsers(db, companyId, {
          maxPages: userMaxPages,
          startPage: userStartPage,
        });
        users += userResult.saved;
        if (userResult.pagesFetched > 0 && userResult.totalPages > 0) {
          userTotalPages = userResult.totalPages;
          userNextPage = userStartPage + userResult.pagesFetched;
          if (userNextPage >= userTotalPages) {
            userImportComplete = true;
            userNextPage = 0;
            console.log("[sync]", companyId, "user import complete,", userTotalPages, "pages");
          } else {
            userImportComplete = false;
            console.log("[sync]", companyId, "user import progress", userNextPage, "/", userTotalPages, "pages");
          }
        }
        lastUserSyncAt = new Date().toISOString();
        console.log(
          "[sync]",
          companyId,
          "users saved:",
          users,
          userMaxPages ? "(pages " + userStartPage + "-" + (userStartPage + (userResult.pagesFetched || 1) - 1) + ")" : ""
        );
      } catch (userErr) {
        console.warn("[sync] users skipped:", userErr.message);
        if (!opts.txOnly && !quick) throw userErr;
      }
    };

    if (!quick) await runUserSync();

    const recentDays = Number(cfg.transactionRecentDays || 7);
    let recentDaysDone = Boolean(state.recentDaysDone);
    const txDays = db
      .prepare("SELECT COUNT(DISTINCT created_date) AS n FROM transactions WHERE company_id = ?")
      .get(companyId).n;
    let recentSaved = 0;
    const backfillMaxDays = Math.min(recentDays, Number(cfg.transactionBackfillMaxDaysQuick || 7));
    // One-time recent backfill only runs on the slow lane so it never blocks today's fast updates.
    if (lane === "slow" && !backfill && !full && txDays < backfillMaxDays && !recentDaysDone) {
      console.log("[sync]", companyId, "recent-days backfill", backfillMaxDays, "days (have", txDays, "dates)");
      const recent = await syncTransactions(db, {
        quick: false,
        companyId,
        days: backfillMaxDays,
        delayMs: Number(cfg.quickRequestDelayMs ?? 40),
      });
      recentSaved = recent.saved;
      recentDaysDone = true;
    }

    // Routine tx sync pulls only the latency-critical money types (deposits/withdrawals).
    // Bonus/manual/commission are kept accurate by the slow-lane integrity pass (which
    // verifies + repairs every type), avoiding a redundant full re-fetch every cycle.
    const fastTxTypes = Array.isArray(cfg.fastLaneTxTypes) && cfg.fastLaneTxTypes.length
      ? cfg.fastLaneTxTypes
      : ["DEPOSIT", "WITHDRAW"];
    const txResult = await syncTransactions(db, {
      backfill,
      quick,
      state,
      companyId,
      txTypes: quick ? fastTxTypes : undefined,
      days: full ? cfg.transactionRecentDays : undefined,
      delayMs: quick ? Number(cfg.quickRequestDelayMs ?? 40) : undefined,
    });
    transactions = txResult.saved + recentSaved;
    customerIds = txResult.customerIds;
    console.log("[sync] transactions saved:", transactions);

    if (quick) {
      // Tail users (newest registrations) every tick on the slow lane; on the fast lane
      // only periodically, so most fast ticks stay pure deposit/withdraw (~1-2s).
      // New depositors already get a customer record from their deposit transaction.
      const tailDue =
        lane === "slow" ||
        shouldRunInterval(state.lastTailAt, cfg.userTailIntervalSeconds || 30);
      if (tailDue) {
        await runTailUserSync();
        lastTailAt = new Date().toISOString();
      }
      // Heavy rotating full-corpus import only on the slow lane.
      if (lane === "slow") await runUserSync();
    }

    let integrityOk = true;
    let integrityMismatches = [];
    let idAudit = state.idAudit || null;
    let lastRepairAt = state.lastRepairAt || null;
    let integrityChecked = false;
    let integrityFailStreak = Number(state.integrityFailStreak || 0);
    let lastYesterdayIntegrityAt = state.lastYesterdayIntegrityAt || null;

    // Startup fast-recovery: if today's transactions are completely absent in the DB but
    // yesterday has data (normal business day), run integrity immediately on the fast lane
    // to pull today's data without waiting for the slow-lane integrity cycle. This fixes
    // the "every restart shows 0" problem caused by access-denied outages overnight.
    const todayTxCount = db.prepare(
      "SELECT COUNT(*) AS n FROM transactions WHERE company_id = ? AND created_date = ?"
    ).get(companyId, todayKey()).n;
    const yesterdayTxCount = db.prepare(
      "SELECT COUNT(*) AS n FROM transactions WHERE company_id = ? AND created_date = ?"
    ).get(companyId, shiftDateKey(todayKey(), -1)).n;
    const needsStartupRecovery =
      quick &&
      lane === "fast" &&
      todayTxCount === 0 &&
      yesterdayTxCount > 0 &&
      !state.lastIntegrityAt;  // only on the very first tick (no prior integrity run)

    // Integrity verification covers all types and is heavy — slow lane only,
    // except for the startup fast-recovery case above.
    if (needsStartupRecovery || (quick && lane === "slow" && shouldRunInterval(state.lastIntegrityAt, cfg.syncIntegrityIntervalSeconds || 60))) {
      integrityChecked = true;
      const { verifyAndRepairDays, auditRecentById } = require("../lib/syncIntegrity");
      // Today every cycle; yesterday (static once closed) only every few minutes.
      const checkYesterday = shouldRunInterval(
        lastYesterdayIntegrityAt,
        cfg.yesterdayIntegrityIntervalSeconds || 600
      );
      const dates = checkYesterday ? [todayKey(), shiftDateKey(todayKey(), -1)] : [todayKey()];
      if (checkYesterday) lastYesterdayIntegrityAt = new Date().toISOString();
      const integrity = await verifyAndRepairDays(
        db,
        { mapTransaction, upsertTransactions, fetchTransactionsInRange },
        { delayMs: Number(cfg.quickRequestDelayMs ?? 40), companyId, dates }
      );
      integrityMismatches = integrity.mismatches || [];
      if (integrity.repaired > 0) {
        transactions += integrity.repaired;
        customerIds = [...new Set([...customerIds, ...(integrity.customerIds || [])])];
        lastRepairAt = new Date().toISOString();
        console.log("[sync] integrity repair saved:", integrity.repaired);
      }
      // The alarm only considers money types (deposits/withdrawals) — those must reconcile
      // exactly. Bonus/manual/commission are high-volume and constantly drift by ±1 from
      // live activity landing mid-scan; they are still auto-repaired, just not alarmed.
      // Even money types get a streak tolerance for transient mid-check drift.
      const moneyMismatch = integrityMismatches.some(
        (m) => m.type === "DEPOSIT" || m.type === "WITHDRAW"
      );
      if (!moneyMismatch) {
        integrityFailStreak = 0;
        integrityOk = true;
      } else {
        integrityFailStreak += 1;
        integrityOk = integrityFailStreak < Number(cfg.integrityFailThreshold || 3);
        console.warn("[sync]", companyId, "money integrity diff (streak", integrityFailStreak + "):", JSON.stringify(integrityMismatches.filter((m) => m.type === "DEPOSIT" || m.type === "WITHDRAW")));
      }

      // Read-only per-ID reconciliation (money types) — surfaces exactly which rows
      // differ after the count/total repair above has already run. Detection only.
      try {
        idAudit = await auditRecentById(db, companyId, { dates });
      } catch (auditErr) {
        console.warn("[sync]", companyId, "id-audit skipped:", auditErr.message);
      }
    }

    // 先更新今日统计与同步状态，避免全量用户同步阻塞首页数据
    const stats = computeDashboard(db, todayKey(), companyId);
    saveDailyStats(db, stats, companyId);
    invalidateSegmentCounts(companyId);
    const durationMs = Date.now() - started;
    const sec = (durationMs / 1000).toFixed(1);
    const msg = "OK in " + sec + "s (" + mode + ")";
    updateSyncStatus(db, companyId, true, msg);

    let apiUserTotal = state.apiUserTotal || null;
    // Heavy full reconcile/prune only on the slow lane (or explicit full/backfill).
    if (lane === "slow") {
      try {
        const pr = await reconcileUsersWithApi(db, companyId, cfg, {
          lastFullUserReconcileAt,
          quick,
        });
        if (!pr.skipped) {
          lastPruneAt = new Date().toISOString();
          lastFullUserReconcileAt = new Date().toISOString();
          users += pr.saved || 0;
          apiUserTotal = pr.apiTotal;
          console.log("[sync]", companyId, "reconciled API users:", pr.apiTotal, "pruned:", pr.removed);
        } else {
          apiUserTotal = pr.apiTotal != null ? pr.apiTotal : state.apiUserTotal;
        }
      } catch (e) {
        console.warn("[sync] user reconcile skipped:", e.message);
      }
    }
    writeSyncState(companyId, true, msg, { users, transactions }, {
      mode,
      lastUserSyncAt,
      lastTailAt,
      lastTxSyncedAt: new Date().toISOString(),
      lastFullDayTxSyncAt:
        quick && txResult.fullDay ? new Date().toISOString() : state.lastFullDayTxSyncAt || null,
      truncation: txResult.truncation ?? state.truncation ?? null,
      lastIntegrityAt: integrityChecked ? new Date().toISOString() : state.lastIntegrityAt || null,
      lastYesterdayIntegrityAt,
      lastIntegrityOk: integrityChecked ? integrityOk : state.lastIntegrityOk ?? true,
      integrityFailStreak: integrityChecked ? integrityFailStreak : state.integrityFailStreak || 0,
      integrityMismatches: integrityChecked ? integrityMismatches : state.integrityMismatches || [],
      idAudit,
      lastRepairAt,
      lastEnrichAt,
      lastPruneAt,
      lastFullUserReconcileAt,
      apiUserTotal,
      recentDaysDone,
      durationMs,
    });
    if (accessDeniedState.get(companyId)) {
      accessDeniedState.set(companyId, false);
      console.log("[sync]", companyId, "ACCESS RESTORED — API access is back, syncing normally");
    }
    console.log("[sync]", companyId, "done", msg);
    return { ok: true, companyId, users, transactions, message: msg, mode, durationMs };
  } catch (e) {
    const rawMsg = e.message || String(e);
    const denied = e.code === "ACCESS_DENIED" || isAccessDenied(rawMsg);
    // Access-denied is an EXTERNAL condition (IP/credential), not a code/data bug. We keep
    // all existing data untouched (no writes happened past the failing fetch), do NOT touch
    // integrity flags, and surface a precise, actionable status so it's never mistaken for a
    // program failure. Existing good data keeps serving until access is restored.
    const msg = denied
      ? "API \u62d2\u7edd\u8bbf\u95ee\uff1a\u8bf7\u68c0\u67e5 VPN/\u7f51\u7edc\u51fa\u53e3\u662f\u5426\u4e3a\u6388\u6743 IP\uff08\u51ed\u8bc1\u672a\u53d8\uff09"
      : rawMsg;
    updateSyncStatus(db, companyId, false, msg);
    const prevState = readSyncState(companyId);
    writeSyncState(companyId, false, msg, {
      users: prevState.users ?? users,
      transactions: prevState.transactions ?? transactions,
    }, {
      mode,
      lastUserSyncAt,
      lastEnrichAt,
      accessDenied: denied,
    });
    if (denied) {
      const wasDenied = accessDeniedState.get(companyId);
      const lastLogged = accessDeniedLoggedAt.get(companyId) || 0;
      const minutesSinceLog = (Date.now() - lastLogged) / 60000;
      // Log on first denial and every 10 minutes while still denied.
      if (!wasDenied || minutesSinceLog >= 10) {
        accessDeniedState.set(companyId, true);
        accessDeniedLoggedAt.set(companyId, Date.now());
        const duration = wasDenied ? ` (持续 ${Math.round(minutesSinceLog)} 分钟)` : "";
        console.error("[sync]", companyId, `ACCESS DENIED${duration} — 出口IP未授权，请检查 VPN/Surfshark 节点`);
      }
    } else {
      console.error("[sync] error:", msg);
    }
    throw e;
  }
}

// Serialize all sync work per company (fast + slow lanes queue, never overlap/corrupt state),
// while different companies run fully in parallel.
const companyChains = new Map();

function runSync(opts = {}) {
  const companyId = opts.companyId;
  if (!companyId) return Promise.reject(new Error("runSync requires companyId"));
  const prev = companyChains.get(companyId) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => runSyncInner(opts));
  // keep the chain alive even if this run rejects
  companyChains.set(companyId, run.catch(() => {}));
  return run;
}

module.exports = {
  syncUserTailPages,
  ensureCustomersFromTransactions,
  pruneStaleCustomers,
  probeApiUserTotal,
  reconcileUsersWithApi,
  syncAllUsersFromApi,
  runSync,
  syncUsers,
  syncTransactions,
  enrichCustomersFromTransactions,
  enrichCustomersFromIds,
  readSyncState,
  mapTransaction,
  upsertTransactions,
  fetchTransactionsInRange,
  quickTransactionWindow,
};
