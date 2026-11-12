"use strict";

const { refreshBankBalance, bankBranchOf, balanceFromLedger } = require("./bankReport");
const { SQL_OPERATING, isBanned } = require("./bankLifecycle");
const { formatWallClock, todayKey, localMidnightUtc } = require("./dates");
const { cleanLedgerName } = require("./displayName");
const { isDemoTenant } = require("./readConfig");
const {
  LEDGER_FIELDS,
  PENDING_FIELDS,
  appendAuditEvent,
  ledgerRefs,
  pendingRefs,
  pickFields,
  runAtomic,
  systemActor,
} = require("./auditLog");

const ACCOUNT_KINDS = ["payment_gateway", "ghost", "nominee"];
const C_STATUS_DEFAULTS = [
  { name: "EZ68", target: "ezspin68" },
  { name: "PK7", target: "pokies7bet" },
  { name: "RX66", target: "rolex66" },
  { name: "AuX6", target: "aussiex6" },
  { name: "LH", target: "" },
];

const IN_STATUSES = new Set(["deposit", "cash in", "new", "bank transfer", "unclaim", "redeposit", "amopay", "test in"]);
const OUT_STATUSES = new Set(["withdraw", "wrong", "cash out", "give back", "expenses", "exchange", "bank trf", "test out"]);
const PLATFORM_LEDGER_STATUSES = new Set(["deposit", "withdraw", "cash in"]);

function nowSql() {
  return formatWallClock();
}

function normalizeSqlDateTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  // 只有**结尾**带 Z 或带偏移才算「带时区的瞬间」，才交给 formatWallClock 去换算。
  //
  // ⚠️ 这个判定以前写成 /[TzZ]|.../，把 ISO 的**分隔符 T** 和时区标记 Z 混进了同一个
  // 字符类，于是 "2026-09-15T23:50" 这种裸时间串也被送进 Date.parse——而 ES 规范
  // 规定不带偏移的日期时间串按**进程本地时区**解析，不是按配置时区。结果同一个输入
  // 在不同实例上会被静默平移「进程 TZ 与配置 TZ 之差」那么多小时（马来实例留着
  // TZ=Australia/Sydney 就是 2 小时）。裸时间串必须走下面「原样当墙上时间」那条路。
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) return formatWallClock(raw);
  const text = raw.replace("T", " ");
  const m = text.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2}(?::\d{2})?)/);
  if (!m) return "";
  const [year, month, day] = m[1].split("-").map(Number);
  const dateCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    dateCheck.getUTCFullYear() !== year
    || dateCheck.getUTCMonth() + 1 !== month
    || dateCheck.getUTCDate() !== day
  ) return "";
  const parts = m[2].split(":");
  const hh = String(Math.min(23, Math.max(0, Number(parts[0]) || 0))).padStart(2, "0");
  const mm = String(Math.min(59, Math.max(0, Number(parts[1]) || 0))).padStart(2, "0");
  const ss = String(Math.min(59, Math.max(0, Number(parts[2]) || 0))).padStart(2, "0");
  return `${m[1]} ${hh}:${mm}:${ss}`;
}

// 浏览器时钟可能比服务器快一点，「当前时间」差几分钟不算未来。
const FUTURE_ENTRY_SLACK_MS = 5 * 60 * 1000;

// 默认记平台单的日期与时间（Excel 按平台单那天算，2026-11-06 与用户确认）。
// 员工改过的时间**不能晚于现在**：演练里只把日期改成今天、时间留着平台的 16:55，而当时
// 才 14:30，于是落成一笔「未来流水」。前端改日期时会把时间跳到现在，这里是最后一道闸，
// 拒绝而不是静默改写。平台自己的 tx_time 不受这条限制（那是平台的时钟，不是人填的）。
function pendingLedgerEntryTime(pending, requested, nowMs = Date.now()) {
  const txTime = normalizeSqlDateTime(pending?.tx_time) || nowSql();
  const reqTime = normalizeSqlDateTime(requested);
  if (String(requested || "").trim() && !reqTime) {
    throw Object.assign(new Error("入账日期或时间无效"), { status: 400 });
  }
  if (reqTime && reqTime > formatWallClock(new Date(nowMs + FUTURE_ENTRY_SLACK_MS).toISOString())) {
    throw Object.assign(new Error("入账时间不能晚于现在"), { status: 400 });
  }
  // Keep the platform timestamp in pending.tx_time. The separately stored
  // approval timestamp is intentionally editable and remains auditable.
  return reqTime || txTime;
}

function money(n) {
  const v = Number(n || 0);
  return Number.isFinite(v) ? Math.abs(v) : 0;
}

function auditActorValue(actor) {
  if (actor && typeof actor === "object") return actor;
  const username = String(actor || "").trim();
  return {
    type: username ? "unknown" : "unknown",
    userId: null,
    username,
    name: "",
    role: "",
  };
}

function actorUsername(actor) {
  if (actor && typeof actor === "object") return String(actor.username || actor.name || "");
  return String(actor || "");
}

function bankAccLabel(bank) {
  if (!bank) return "";
  const head = (bankBranchOf(bank) || "Bank").slice(0, 40);
  const sub = String(bank.account_name || bank.payid || "").trim().slice(0, 40);
  return sub ? `${head} (${sub})` : head;
}

function mapAmountFields(direction, status, amount) {
  const amt = money(amount);
  const st = String(status || "").toLowerCase().trim();
  const dir = String(direction || "").toLowerCase() === "out" ? "out" : "in";
  const fields = {
    status: st,
    amount_in: 0,
    amount_out: 0,
    help_amount: 0,
    trf_amount: 0,
  };
  if (dir === "in") {
    if (st === "bank transfer") fields.trf_amount = amt;
    else fields.amount_in = amt;
    if (!st) fields.status = "deposit";
  } else {
    if (st === "bank trf") fields.help_amount = amt;
    else fields.amount_out = amt;
    if (!st) fields.status = "withdraw";
  }
  return fields;
}

// 「别家替我付客户提现」的落列：withdraw + help_amount。审批的「调钱」与「拆分调钱」协助部分
// 共用这一份——两处各写一遍，就是它们曾经一个落 trf_amount、一个落 amount_in 的原因。
function helpWithdrawFields(amount) {
  return { status: "withdraw", amount_in: 0, amount_out: 0, help_amount: money(amount), trf_amount: 0 };
}

// Keep manual IN/OUT status validation in sync with the dropdown options.
// 没有 bank transfer：它只作为两户互转的另一半由系统写（CONTEXT.md「两户互转」）。
// redeposit 两个方向都有，且永远不绑银行（CONTEXT.md「REDEP」）。
const TRANSFER_IN_STATUSES = new Set(["deposit", "cash in", "new", "unclaim", "redeposit", "amopay", "test in"]);
const TRANSFER_OUT_STATUSES = new Set(["withdraw", "wrong", "cash out", "give back", "expenses", "exchange", "bank trf", "redeposit", "test out"]);

function assertTransferStatus(direction, status) {
  const dir = String(direction || "").toLowerCase() === "in" ? "in" : "out";
  const st = String(status || "").toLowerCase().trim();
  const allowed = dir === "in" ? TRANSFER_IN_STATUSES : TRANSFER_OUT_STATUSES;
  if (!allowed.has(st)) {
    throw Object.assign(new Error(`${dir === "in" ? "IN" : "OUT"} 调钱状态无效`), { status: 400 });
  }
  return st;
}

function ensureCStatusOptions(db, companyId) {
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM bank_c_status_options WHERE company_id = ?")
    .get(companyId).n;
  if (count > 0) return;
  if (isDemoTenant()) return;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO bank_c_status_options (company_id, name, target_company_id, sort_order)
     VALUES (?, ?, ?, ?)`
  );
  C_STATUS_DEFAULTS.forEach((o, i) => {
    const target = o.target && o.target !== companyId ? o.target : "";
    ins.run(companyId, o.name, target, i + 1);
  });
}

// 「本公司的名字」：任何公司（含自己）把 target_company_id 指向本公司的 C STATUS 名，即别家
// 怎么叫我。C STATUS 记的是与对方公司的往来，填自己没有对手、对不了平，只会在 C STATUS 表里
// 多一行永远不归零的数（2026-11-06 员工演练：AuX6→aussiex6 自指项、救封禁户时填 EZ68）。
// 返回小写名集合；纯外部往来方（如 LH，没有关联公司）不在其中。
function selfCStatusNames(db, companyId) {
  const rows = db
    .prepare("SELECT DISTINCT name FROM bank_c_status_options WHERE target_company_id = ? AND name <> ''")
    .all(String(companyId || ""));
  return new Set(rows.map((r) => String(r.name).trim().toLowerCase()).filter(Boolean));
}

function assertNotSelfCStatus(db, companyId, value) {
  const self = selfCStatusNames(db, companyId);
  if (!self.size) return;
  const hit = splitCStatusNames(value).find((name) => self.has(name.toLowerCase()));
  if (hit) {
    throw Object.assign(new Error(`C STATUS「${hit}」是本公司，不能填本公司`), { status: 400 });
  }
}

function listCStatusOptions(db, companyId) {
  ensureCStatusOptions(db, companyId);
  const self = selfCStatusNames(db, companyId);
  // is_self：录入用的下拉要藏掉；管理页仍要列出来，库里已有的自指项才删得掉。
  return db
    .prepare(
      `SELECT name, target_company_id, reconcile_required, sort_order FROM bank_c_status_options
       WHERE company_id = ? ORDER BY sort_order ASC, name ASC`
    )
    .all(companyId)
    .map((o) => ({ ...o, is_self: self.has(String(o.name).trim().toLowerCase()) ? 1 : 0 }));
}

function upsertCStatusOption(db, companyId, name, targetCompanyId, reconcileRequired) {
  const n = String(name || "").trim();
  if (!n) return null;
  if (targetCompanyId != null && String(targetCompanyId).trim() === String(companyId)) {
    throw Object.assign(new Error("C STATUS 不能关联本公司"), { status: 400 });
  }
  ensureCStatusOptions(db, companyId);
  const existing = db
    .prepare("SELECT * FROM bank_c_status_options WHERE company_id = ? AND name = ?")
    .get(companyId, n);
  if (existing) {
    if (targetCompanyId != null) {
      db.prepare(
        "UPDATE bank_c_status_options SET target_company_id = ? WHERE company_id = ? AND name = ?"
      ).run(String(targetCompanyId), companyId, n);
    }
    if (reconcileRequired != null) {
      db.prepare(
        "UPDATE bank_c_status_options SET reconcile_required = ? WHERE company_id = ? AND name = ?"
      ).run(Number(reconcileRequired) ? 1 : 0, companyId, n);
    }
    return db
      .prepare("SELECT * FROM bank_c_status_options WHERE company_id = ? AND name = ?")
      .get(companyId, n);
  }
  const max = db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM bank_c_status_options WHERE company_id = ?")
    .get(companyId).m;
  db.prepare(
    `INSERT INTO bank_c_status_options (company_id, name, target_company_id, reconcile_required, sort_order)
     VALUES (?, ?, ?, ?, ?)`
  ).run(companyId, n, targetCompanyId == null ? "" : String(targetCompanyId), Number(reconcileRequired) ? 1 : 0, max + 1);
  return db
    .prepare("SELECT * FROM bank_c_status_options WHERE company_id = ? AND name = ?")
    .get(companyId, n);
}

function splitCStatusNames(value) {
  return String(value || "")
    .split(/[,\n;\/|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function linkedCompanyForCStatus(db, companyId, value) {
  for (const name of splitCStatusNames(value)) {
    const row = db
      .prepare(
        `SELECT target_company_id FROM bank_c_status_options
         WHERE company_id = ? AND name = ? AND target_company_id <> ?
         LIMIT 1`
      )
      .get(companyId, name, companyId);
    const target = String(row?.target_company_id || "").trim();
    if (target) return target;
  }
  return "";
}

function upsertCStatusOptions(db, companyId, value, targetCompanyId) {
  const names = splitCStatusNames(value);
  if (!names.length) return null;
  let last = null;
  names.forEach((name) => {
    last = upsertCStatusOption(db, companyId, name, targetCompanyId);
  });
  return last;
}

function logAccountEvent(db, { companyId, bankAccountId, event, note, user }) {
  db.prepare(
    `INSERT INTO bank_account_events (company_id, bank_account_id, event, note, actor)
     VALUES (?, ?, ?, ?, ?)`
  ).run(companyId, bankAccountId, event, String(note || ""), String(user || ""));
}

function insertLedger(db, row) {
  const result = db
    .prepare(
      `INSERT INTO bank_ledger
        (bank_account_id, company_id, entry_time, tx_id, status, amount_in, amount_out,
         help_amount, trf_amount, bank_acc, username, name, c_status, other_info, remark,
         auto_generated, transfer_group_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number(row.bank_account_id || 0),
      row.company_id,
      row.entry_time || nowSql(),
      String(row.tx_id || ""),
      String(row.status || "deposit"),
      money(row.amount_in),
      money(row.amount_out),
      money(row.help_amount),
      money(row.trf_amount),
      String(row.bank_acc || ""),
      String(row.username || ""),
      row.auto_generated ? cleanLedgerName(row.name) : String(row.name || ""),
      String(row.c_status || ""),
      String(row.other_info || ""),
      String(row.remark || ""),
      row.auto_generated ? 1 : 0,
      String(row.transfer_group_id || "")
    );
  const id = result.lastInsertRowid;
  if (row.bank_account_id) refreshBankBalance(db, Number(row.bank_account_id));
  return db.prepare("SELECT * FROM bank_ledger WHERE id = ?").get(id);
}

function markBalanceLog(db, bankAccountId, txId, amount) {
  if (!txId) return;
  db.prepare(
    "INSERT OR IGNORE INTO bank_balance_log (bank_account_id, tx_id, amount) VALUES (?, ?, ?)"
  ).run(Number(bankAccountId || 0), String(txId), money(amount));
}

function enqueuePendingTx(db, companyId, mappedTxs) {
  if (!mappedTxs?.length) return 0;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO bank_tx_pending
      (company_id, tx_id, tx_type, amount, username, name, tx_time, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
  );
  let n = 0;
  for (const t of mappedTxs) {
    if (!t?.id) continue;
    const typ = String(t.type || "").toUpperCase();
    if (typ !== "DEPOSIT" && typ !== "WITHDRAW") continue;
    const logged = db.prepare("SELECT 1 FROM bank_balance_log WHERE tx_id = ?").get(t.id);
    if (logged) continue;
    const txTime = normalizeSqlDateTime(t.created_at) || nowSql();
    const info = ins.run(
      companyId,
      t.id,
      typ,
      money(t.amount),
      t.username || "",
      cleanLedgerName(t.name),
      txTime
    );
    if (info.changes) n += 1;
  }
  return n;
}

function listPendingTx(db, companyId) {
  return db
    .prepare(
      `SELECT * FROM bank_tx_pending
       WHERE company_id = ? AND state = 'pending'
       ORDER BY tx_time ASC, id ASC`
    )
    .all(companyId);
}

// 跳过的单按**跳过的那一天**（实例时区）过期：当天跳过的当天都能在「已跳过」恢复，过了
// 本地午夜才转 expired。以前按平台单日期 tx_time 判定，于是任何往日的单一跳过就满足
// 「早于今天」，几秒内（pendingCounts 每 8 秒轮询）就永久定型——2026-11-06 员工演练里
// 4 家公司都这样丢过单，而 toast 还写着「可在 Skipped tab 恢复」。
// decided_at 是 datetime('now') 写的 UTC，必须用 localMidnightUtc 换算日界；没有 decided_at
// 的历史行退回按 tx_time 判定。两个条件只在这里定义一次，过期、列表、计数共用。
const SKIPPED_EXPIRED_SQL = `state = 'skipped' AND (
  (COALESCE(decided_at, '') <> '' AND decided_at < ?)
  OR (COALESCE(decided_at, '') = '' AND substr(tx_time, 1, 10) < ?)
)`;
const SKIPPED_CURRENT_SQL = `state = 'skipped' AND (
  (COALESCE(decided_at, '') <> '' AND decided_at >= ?)
  OR (COALESCE(decided_at, '') = '' AND substr(tx_time, 1, 10) = ?)
)`;
const skippedDayParams = (dateKey) => [localMidnightUtc(dateKey), dateKey];

function expireSkippedPendingTx(db, companyId, dateKey) {
  const rows = db.prepare(
    `SELECT * FROM bank_tx_pending WHERE company_id = ? AND ${SKIPPED_EXPIRED_SQL}`
  ).all(companyId, ...skippedDayParams(dateKey));
  if (!rows.length) return 0;
  return runAtomic(db, () => {
    const update = db.prepare(
      `UPDATE bank_tx_pending SET state='expired', decided_at=COALESCE(decided_at, datetime('now'))
       WHERE id=? AND company_id=? AND state='skipped'`
    );
    for (const row of rows) {
      const result = update.run(row.id, companyId);
      if (!result.changes) continue;
      const saved = db.prepare("SELECT * FROM bank_tx_pending WHERE id=?").get(row.id);
      appendAuditEvent(db, {
        companyId,
        action: "pending.expired",
        source: "system",
        actor: systemActor("\u8df3\u8fc7\u5355\u8fc7\u671f\u4efb\u52a1"),
        summary: `Skipped 平台单 ${row.tx_id} 已自动过期`,
        before: pickFields(row, PENDING_FIELDS),
        after: pickFields(saved, PENDING_FIELDS),
        metadata: { automatic: true, trigger: "day_rollover" },
        refs: pendingRefs(saved),
        dedupeKey: `system:pending_expired:${row.id}`,
      });
    }
    return rows.length;
  });
}

function listSkippedPendingTx(db, companyId, limit = 100, dateKey = todayKey()) {
  expireSkippedPendingTx(db, companyId, dateKey);
  return db
    .prepare(
      `SELECT * FROM bank_tx_pending
       WHERE company_id = ? AND ${SKIPPED_CURRENT_SQL}
       ORDER BY decided_at DESC, id DESC
       LIMIT ?`
    )
    .all(companyId, ...skippedDayParams(dateKey), Math.min(300, Math.max(1, Number(limit || 100))));
}

function approvePendingTx(db, companyId, txId, body, actor) {
  const pending = db
    .prepare("SELECT * FROM bank_tx_pending WHERE company_id = ? AND tx_id = ? AND state = 'pending'")
    .get(companyId, txId);
  if (!pending) throw Object.assign(new Error("Pending not found"), { status: 404 });

  const mode = String(body.mode || "bank");
  const remark = String(body.remark || "").trim();
  const approvedBy = actorUsername(actor);
  const entryTime = pendingLedgerEntryTime(pending, body.entry_time);

  let splitRows = null;
  let splitSelfAmount = 0;
  let splitSelfBankId = 0;
  let splitSelfBank = null;
  if (mode === "help_split") {
    if (pending.tx_type !== "WITHDRAW") {
      throw Object.assign(new Error("只有 withdraw 平台单可以拆分调钱"), { status: 400 });
    }
    const pendingTotalCents = Math.round(money(pending.amount) * 100);
    splitSelfAmount = money(body.self_amount);
    if (Math.round(splitSelfAmount * 100) > pendingTotalCents) {
      throw Object.assign(new Error(`本户自付不能超过平台单金额 ${money(pending.amount).toFixed(2)}`), { status: 400 });
    }
    if (!Array.isArray(body.splits) || body.splits.length < 1 || body.splits.length > 50) {
      throw Object.assign(new Error("请至少添加 1 个协助方"), { status: 400 });
    }
    const seen = new Set();
    splitRows = body.splits.map((row) => {
      const cStatus = String(row?.c_status || "").trim();
      const amount = money(row?.amount);
      const key = cStatus.toLowerCase();
      if (!cStatus) throw Object.assign(new Error("每个协助方都要填写 C STATUS"), { status: 400 });
      if (!amount) throw Object.assign(new Error("每个协助金额必须大于 0"), { status: 400 });
      if (seen.has(key)) throw Object.assign(new Error("C STATUS 不能重复"), { status: 400 });
      assertNotSelfCStatus(db, companyId, cStatus);
      seen.add(key);
      return { c_status: cStatus, amount };
    });
    const allocationCount = (splitSelfAmount > 0 ? 1 : 0) + splitRows.length;
    if (allocationCount < 2) {
      throw Object.assign(new Error("拆分至少需要 2 个分配项"), { status: 400 });
    }
    splitSelfBankId = Number(body.self_bank_account_id || 0);
    if (splitSelfAmount > 0) {
      if (!splitSelfBankId) {
        throw Object.assign(new Error("本户自付请填写银行账户"), { status: 400 });
      }
      splitSelfBank = db
        .prepare(`SELECT * FROM bank_accounts WHERE id = ? AND company_id = ? AND ${SQL_OPERATING}`)
        .get(splitSelfBankId, companyId);
      if (!splitSelfBank) {
        throw Object.assign(new Error("本户自付银行账户无效、已封禁或已归档"), { status: 400 });
      }
    } else {
      splitSelfBankId = 0;
    }
    const splitTotalCents = Math.round(splitSelfAmount * 100)
      + splitRows.reduce((sum, row) => sum + Math.round(row.amount * 100), 0);
    if (splitTotalCents !== pendingTotalCents) {
      throw Object.assign(
        new Error(`拆分金额必须等于平台单金额 ${money(pending.amount).toFixed(2)}`),
        { status: 400 }
      );
    }
  }

  const finishAudit = (ledgers, modeName, transferGroupId = "") => {
    const saved = db.prepare("SELECT * FROM bank_tx_pending WHERE id=?").get(pending.id);
    appendAuditEvent(db, {
      companyId,
      action: "pending.approved",
      source: "user",
      actor: auditActorValue(actor),
      summary: `审批平台单 ${pending.tx_id}（${modeName}）`,
      reason: String(body.reason || "").trim(),
      before: pickFields(pending, PENDING_FIELDS),
      after: pickFields(saved, PENDING_FIELDS),
      metadata: {
        approve_mode: modeName,
        transfer_group_id: transferGroupId,
        generated_ledger_ids: ledgers.map((row) => row.id),
      },
      refs: pendingRefs(saved, ledgers),
    });
  };

  return runAtomic(db, () => {
    if (mode === "help_split") {
      const splitGroupId = makeTransferGroupId();
      const splitParts = (splitSelfAmount > 0 ? 1 : 0) + splitRows.length;
      const ledgers = [];
      if (splitSelfAmount > 0) {
        ledgers.push(insertLedger(db, {
          bank_account_id: splitSelfBankId,
          company_id: companyId,
          entry_time: entryTime,
          tx_id: pending.tx_id,
          ...mapAmountFields("out", "withdraw", splitSelfAmount),
          bank_acc: bankAccLabel(splitSelfBank),
          username: pending.username,
          name: pending.name,
          other_info: `${pending.tx_type} ${money(pending.amount).toFixed(2)} split self ${splitSelfAmount.toFixed(2)}`,
          remark,
          auto_generated: 1,
          transfer_group_id: splitGroupId,
        }));
      }
      splitRows.forEach((row, index) => {
        upsertCStatusOptions(db, companyId, row.c_status, null);
        ledgers.push(insertLedger(db, {
          bank_account_id: 0,
          company_id: companyId,
          entry_time: entryTime,
          tx_id: pending.tx_id,
          // 协助方替我付客户 = withdraw + help_amount（C STATUS 记 IN，REPORT 的 WITHDRAW 含它），
          // 与单笔「调钱」同一个落法，口径见 bank-c-status.test.js。以前落在 amount_in，
          // 方向虽对，但「入账 IN」虚增、REPORT 把它算进 CASH IN、WITHDRAW 少算。
          ...helpWithdrawFields(row.amount),
          username: pending.username,
          name: pending.name,
          c_status: row.c_status,
          other_info: `${pending.tx_type} ${money(pending.amount).toFixed(2)} split ${index + 1 + (splitSelfAmount > 0 ? 1 : 0)}/${splitParts}`,
          remark,
          auto_generated: 1,
          transfer_group_id: splitGroupId,
        }));
      });
      markBalanceLog(db, splitSelfBankId, pending.tx_id, pending.amount);
      db.prepare(
        `UPDATE bank_tx_pending SET state='approved', bank_account_id=?, approve_mode='help_split',
          c_status=?, approved_entry_time=?, approved_at=datetime('now'), approved_by=?,
          decided_at=datetime('now'), decided_by=? WHERE id=?`
      ).run(
        splitSelfBankId,
        splitRows.map((row) => row.c_status).join(", "),
        entryTime,
        approvedBy,
        approvedBy,
        pending.id
      );
      finishAudit(ledgers, "help_split", splitGroupId);
      return {
        ledgers,
        pending,
        transfer_group_id: splitGroupId,
      };
    }

    if (mode === "redeposit") {
      const ledger = insertLedger(db, {
        bank_account_id: 0,
        company_id: companyId,
        entry_time: entryTime,
        tx_id: pending.tx_id,
        status: "redeposit",
        amount_in: 0,
        amount_out: 0,
        help_amount: 0,
        trf_amount: 0,
        username: pending.username,
        name: pending.name,
        other_info: `${pending.tx_type} ${money(pending.amount).toFixed(2)}`,
        remark: remark || "No cash movement",
        auto_generated: 1,
      });
      markBalanceLog(db, 0, pending.tx_id, 0);
      db.prepare(
        `UPDATE bank_tx_pending SET state='approved', bank_account_id=0, approve_mode='redeposit',
          approved_entry_time=?, approved_at=datetime('now'), approved_by=?,
          decided_at=datetime('now'), decided_by=? WHERE id=?`
      ).run(entryTime, approvedBy, approvedBy, pending.id);
      finishAudit([ledger], "redeposit");
      return { ledger, pending };
    }

    if (mode === "help") {
      if (pending.tx_type !== "WITHDRAW") {
        throw Object.assign(new Error("只有 withdraw 平台单可以调钱"), { status: 400 });
      }
      // 别家替我付这笔客户提现：我方记 withdraw + help_amount（C STATUS 记 IN = 我欠对方），
      // 协助方自己记 CASH OUT（OUT）。两边一 IN 一 OUT，相加为 0——和 4 家 Excel 的 C STATUS
      // 表一致。以前落成 cash in + trf_amount，C STATUS 记 OUT、和协助方同号，差额是 -2X、
      // 永远对不平（2026-11-06 员工演练）。
      const cStatus = String(body.c_status || "").trim();
      if (!cStatus) {
        throw Object.assign(new Error("调钱请填写 C STATUS"), { status: 400 });
      }
      assertNotSelfCStatus(db, companyId, cStatus);
      if (cStatus) upsertCStatusOptions(db, companyId, cStatus, null);
      const bankId = body.bank_account_id ? Number(body.bank_account_id) : 0;
      let bank = null;
      if (bankId) {
        bank = db
          .prepare(`SELECT * FROM bank_accounts WHERE id = ? AND company_id = ? AND ${SQL_OPERATING}`)
          .get(bankId, companyId);
        if (!bank) throw Object.assign(new Error("银行账户无效、已封禁或已归档"), { status: 400 });
      }
      const amounts = helpWithdrawFields(pending.amount);
      const ledger = insertLedger(db, {
        bank_account_id: bankId,
        company_id: companyId,
        entry_time: entryTime,
        tx_id: pending.tx_id,
        ...amounts,
        bank_acc: bank ? bankAccLabel(bank) : "",
        username: pending.username,
        name: pending.name,
        c_status: cStatus,
        remark,
        auto_generated: 1,
        transfer_group_id: "",
      });
      markBalanceLog(db, bankId || 0, pending.tx_id, pending.amount);
      db.prepare(
        `UPDATE bank_tx_pending SET state='approved', bank_account_id=?, approve_mode='help',
          c_status=?, approved_entry_time=?, approved_at=datetime('now'), approved_by=?,
          decided_at=datetime('now'), decided_by=? WHERE id=?`
      ).run(bankId, cStatus, entryTime, approvedBy, approvedBy, pending.id);
      finishAudit([ledger], "help");
      return { ledger, pending };
    }

    const bankId = Number(body.bank_account_id);
    if (!bankId) throw Object.assign(new Error("请选择银行账户"), { status: 400 });
    const bank = db
      .prepare(`SELECT * FROM bank_accounts WHERE id = ? AND company_id = ? AND ${SQL_OPERATING}`)
      .get(bankId, companyId);
    if (!bank) throw Object.assign(new Error("银行账户无效、已封禁或已归档"), { status: 400 });

    const isDep = pending.tx_type === "DEPOSIT";
    const ledger = insertLedger(db, {
      bank_account_id: bankId,
      company_id: companyId,
      entry_time: entryTime,
      tx_id: pending.tx_id,
      status: isDep ? "deposit" : "withdraw",
      amount_in: isDep ? money(pending.amount) : 0,
      amount_out: isDep ? 0 : money(pending.amount),
      bank_acc: bankAccLabel(bank),
      username: pending.username,
      name: pending.name,
      remark,
      auto_generated: 1,
    });
    markBalanceLog(db, bankId, pending.tx_id, pending.amount);
    db.prepare(
      `UPDATE bank_tx_pending SET state='approved', bank_account_id=?, approve_mode='bank',
        approved_entry_time=?, approved_at=datetime('now'), approved_by=?,
        decided_at=datetime('now'), decided_by=? WHERE id=?`
    ).run(bankId, entryTime, approvedBy, approvedBy, pending.id);
    finishAudit([ledger], "bank");
    return { ledger, pending };
  });
}

function skipPendingTx(db, companyId, txId, actor, reason) {
  const pending = db
    .prepare("SELECT * FROM bank_tx_pending WHERE company_id = ? AND tx_id = ? AND state = 'pending'")
    .get(companyId, txId);
  if (!pending) throw Object.assign(new Error("Pending not found"), { status: 404 });
  return runAtomic(db, () => {
    db.prepare(
      `UPDATE bank_tx_pending SET state='skipped', decided_at=datetime('now'), decided_by=? WHERE id=?`
    ).run(actorUsername(actor), pending.id);
    const saved = db.prepare("SELECT * FROM bank_tx_pending WHERE id=?").get(pending.id);
    appendAuditEvent(db, {
      companyId,
      action: "pending.skipped",
      source: "user",
      actor: auditActorValue(actor),
      summary: `跳过平台单 ${pending.tx_id}`,
      reason,
      before: pickFields(pending, PENDING_FIELDS),
      after: pickFields(saved, PENDING_FIELDS),
      refs: pendingRefs(saved),
    });
    return saved;
  });
}

function restoreSkippedPendingTx(db, companyId, txId, actor, reason) {
  const skipped = db
    .prepare("SELECT * FROM bank_tx_pending WHERE company_id = ? AND tx_id = ? AND state = 'skipped'")
    .get(companyId, txId);
  if (!skipped) throw Object.assign(new Error("Skipped pending not found"), { status: 404 });
  return runAtomic(db, () => {
    db.prepare(
      `UPDATE bank_tx_pending
       SET state='pending', decided_at=NULL, decided_by='', bank_account_id=0, approve_mode='', c_status=''
       WHERE id=?`
    ).run(skipped.id);
    const saved = db.prepare("SELECT * FROM bank_tx_pending WHERE id = ?").get(skipped.id);
    appendAuditEvent(db, {
      companyId,
      action: "pending.restored",
      source: "user",
      actor: auditActorValue(actor),
      summary: `恢复平台单 ${skipped.tx_id} 到待处理`,
      reason,
      before: pickFields(skipped, PENDING_FIELDS),
      after: pickFields(saved, PENDING_FIELDS),
      refs: pendingRefs(saved),
    });
    return saved;
  });
}

function deleteSkippedPendingTx(db, companyId, txId, actor, reason) {
  const skipped = db
    .prepare("SELECT * FROM bank_tx_pending WHERE company_id = ? AND tx_id = ? AND state = 'skipped'")
    .get(companyId, txId);
  if (!skipped) throw Object.assign(new Error("Skipped pending not found"), { status: 404 });
  return runAtomic(db, () => {
    db.prepare(
      `UPDATE bank_tx_pending
       SET state='deleted', decided_at=datetime('now'), decided_by=?
       WHERE id=? AND company_id=? AND state='skipped'`
    ).run(actorUsername(actor), skipped.id, companyId);
    const saved = db.prepare("SELECT * FROM bank_tx_pending WHERE id=?").get(skipped.id);
    appendAuditEvent(db, {
      companyId,
      action: "pending.deleted",
      source: "user",
      actor: auditActorValue(actor),
      summary: `删除已跳过平台单 ${skipped.tx_id}`,
      reason,
      before: pickFields(skipped, PENDING_FIELDS),
      after: pickFields(saved, PENDING_FIELDS),
      refs: pendingRefs(saved),
    });
    return saved;
  });
}

function platformTxTypeForLedger(db, row) {
  if (!row?.auto_generated || !String(row.tx_id || "").trim()) return "";
  const status = String(row.status || "").trim().toLowerCase();
  if (!PLATFORM_LEDGER_STATUSES.has(status)) return "";

  const pending = db
    .prepare("SELECT tx_type FROM bank_tx_pending WHERE company_id = ? AND tx_id = ?")
    .get(row.company_id, row.tx_id);
  const pendingType = String(pending?.tx_type || "").toUpperCase();
  if (pendingType === "DEPOSIT" || pendingType === "WITHDRAW") return pendingType;

  const transaction = db
    .prepare("SELECT type FROM transactions WHERE company_id = ? AND id = ?")
    .get(row.company_id, row.tx_id);
  const transactionType = String(transaction?.type || "").toUpperCase();
  return transactionType === "DEPOSIT" || transactionType === "WITHDRAW" ? transactionType : "";
}

// 同一平台单（tx_id）在账上还剩哪一行。排除：刚插回的那一行本身、同一拆分组的兄弟行
// （help_split 一笔单本来就是多行同 tx_id）。
function otherLedgerForTx(db, companyId, txId, opts = {}) {
  const tx = String(txId || "").trim();
  if (!tx) return null;
  const groupId = String(opts.excludeGroupId || "").trim();
  return db
    .prepare(
      `SELECT * FROM bank_ledger
       WHERE company_id = ? AND tx_id = ? AND id <> ?
         AND (? = '' OR COALESCE(transfer_group_id, '') <> ?)
       ORDER BY id ASC LIMIT 1`
    )
    .get(companyId, tx, Number(opts.excludeLedgerId || 0), groupId, groupId) || null;
}

// 「最近删除 → 恢复」前的闸门：这笔平台单删掉之后已经被重新审批入账，再把旧行塞回去
// 就是同一 tx_id 记两次（演练里 4 家公司都复现了）。返回挡路的那一行，没有冲突返回 null。
function restoreConflictForDeleted(db, deleted) {
  if (!deleted) return null;
  return otherLedgerForTx(db, deleted.company_id, deleted.tx_id, {
    excludeGroupId: deleted.transfer_group_id,
  });
}

// 两户互转（CONTEXT.md）的一对：人工录入（auto_generated = 0）、同组、status 是 bank trf / bank transfer。
// 审批生成的组（auto_generated = 1）照旧整组删。带组号的单条老 bank trf（11-12 前的跨公司调钱）
// 组里只有它自己，所以还是只删它。
const INTERNAL_PAIR_SQL = "auto_generated = 0 AND LOWER(TRIM(status)) IN ('bank trf', 'bank transfer')";
function isInternalPairRow(row) {
  const st = String(row?.status || "").trim().toLowerCase();
  return Boolean(row?.transfer_group_id) && !Number(row.auto_generated)
    && (st === "bank trf" || st === "bank transfer");
}

// 删除一条流水时要一起删的行（含它自己）。
function ledgerRowsToDelete(db, companyId, row) {
  if (Number(row.auto_generated) && row.transfer_group_id) {
    return db
      .prepare(
        `SELECT * FROM bank_ledger
         WHERE company_id = ? AND transfer_group_id = ? AND auto_generated = 1
         ORDER BY id ASC`
      )
      .all(companyId, row.transfer_group_id);
  }
  if (isInternalPairRow(row)) {
    return db
      .prepare(
        `SELECT * FROM bank_ledger
         WHERE company_id = ? AND transfer_group_id = ? AND ${INTERNAL_PAIR_SQL}
         ORDER BY id ASC`
      )
      .all(companyId, row.transfer_group_id);
  }
  return [row];
}

// 从最近删除恢复一条时要一起恢复的已删行（含它自己）。只有两户互转成对恢复；
// 审批组仍是一行一行恢复（那条路有平台单打回 / 冲突闸门，另有规则）。
function deletedRowsToRestore(db, companyId, deleted) {
  if (!isInternalPairRow(deleted)) return [deleted];
  return db
    .prepare(
      `SELECT * FROM bank_ledger_deleted
       WHERE company_id = ? AND transfer_group_id = ? AND ${INTERNAL_PAIR_SQL}
       ORDER BY id ASC`
    )
    .all(companyId, deleted.transfer_group_id);
}

// opts.excludeLedgerId / excludeGroupId 只给恢复路径用：那时被恢复的行已经插回去了，
// 它自己和同组兄弟不算「还在账上的别的行」。
function reopenPendingForLedger(db, row, opts = {}) {
  const txType = platformTxTypeForLedger(db, row);
  if (!txType) return false;

  // 删掉的是重复行、同一平台单还有别的流水在账上：这笔单并没有「没入账」，打回待处理
  // 就能被审第三次，删掉 bank_balance_log 还会让同步侧的防重锁失效。
  if (otherLedgerForTx(db, row.company_id, row.tx_id, opts)) return false;

  // The balance log is the sync-side de-duplication key. Remove it before
  // re-approval so the order can be applied to a different bank if needed.
  db.prepare("DELETE FROM bank_balance_log WHERE tx_id = ?").run(row.tx_id);

  const pending = db
    .prepare("SELECT id FROM bank_tx_pending WHERE company_id = ? AND tx_id = ?")
    .get(row.company_id, row.tx_id);
  if (pending) {
    db.prepare(
      `UPDATE bank_tx_pending
       SET state='pending', bank_account_id=0, approve_mode='', c_status='',
           decided_at=NULL, decided_by=''
       WHERE company_id=? AND tx_id=?`
    ).run(row.company_id, row.tx_id);
    return true;
  }

  const transaction = db
    .prepare(
      `SELECT id, type, amount, username, name, created_at
       FROM transactions WHERE company_id = ? AND id = ?`
    )
    .get(row.company_id, row.tx_id);
  if (!transaction || String(transaction.type || "").toUpperCase() !== txType) return false;
  db.prepare(
    `INSERT OR IGNORE INTO bank_tx_pending
      (company_id, tx_id, tx_type, amount, username, name, tx_time, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).run(
    row.company_id,
    transaction.id,
    txType,
    money(transaction.amount || row.amount_in || row.amount_out),
    transaction.username || row.username || "",
    cleanLedgerName(transaction.name || row.name),
    normalizeSqlDateTime(transaction.created_at) || row.entry_time || nowSql()
  );
  return true;
}

function makeTransferGroupId() {
  return `trf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 两户互转（CONTEXT.md）写账的唯一一份：「从」户 bank trf 出 + 「到」户 bank transfer 入，金额相同、
// C STATUS 空、同一组。调钱弹窗和「转出封禁户余额 → 本公司户口」共用。调用方在事务里调用、自己写审计，
// 审计 refs 用 internalPairRefs，两条都登记（交易记录页 OPERATOR 列靠它找人）。
function insertInternalTransferPair(db, companyId, { from, to, amount, entryTime, name = "", remark = "" }) {
  const groupId = makeTransferGroupId();
  const common = { company_id: companyId, entry_time: entryTime, name, c_status: "", remark, auto_generated: 0, transfer_group_id: groupId };
  const out = insertLedger(db, {
    ...common,
    bank_account_id: from.id,
    ...mapAmountFields("out", "bank trf", amount),
    bank_acc: bankAccLabel(from),
  });
  const inbound = insertLedger(db, {
    ...common,
    bank_account_id: to.id,
    ...mapAmountFields("in", "bank transfer", amount),
    bank_acc: bankAccLabel(to),
  });
  return { out, inbound, groupId };
}
function internalPairRefs(pair) {
  return [...ledgerRefs(pair.out), ...ledgerRefs(pair.inbound)];
}

function submitTransfer(db, fromCompanyId, body, actor) {
  const toCompanyId = String(body.to_company_id || "").trim();
  const submittedCStatus = String(body.c_status || "").trim();
  const direction = String(body.direction || "out").toLowerCase() === "in" ? "in" : "out";
  const status = assertTransferStatus(direction, String(body.status || (direction === "out" ? "cash out" : "cash in")));
  const amountText = String(body.amount ?? "").replace(/,/g, "").trim();
  const amountNumber = Number(amountText);
  const amount = Number.isFinite(amountNumber) ? Math.abs(amountNumber) : 0;
  const remark = String(body.remark || "").trim();
  const name = String(body.name || "").trim();
  const entryTime = normalizeSqlDateTime(body.entry_time) || nowSql();
  const isTestStatus = status === "test in" || status === "test out";

  if (!amount) throw Object.assign(new Error("金额无效"), { status: 400 });
  assertNotSelfCStatus(db, fromCompanyId, submittedCStatus);

  // REDEP 不绑银行、不动余额，与审批 / 手录 / 编辑一致（CONTEXT.md「REDEP」）：前端藏了 BANK 框，
  // 员工先选过的户口这里也一并忽略。
  const bankId = status !== "redeposit" && body.bank_account_id ? Number(body.bank_account_id) : 0;
  let bank = null;
  if (bankId) {
    bank = db
      .prepare(`SELECT * FROM bank_accounts WHERE id = ? AND company_id = ? AND ${SQL_OPERATING}`)
      .get(bankId, fromCompanyId);
    if (!bank) throw Object.assign(new Error("银行账户无效、已封禁或已归档"), { status: 400 });
  }
  if (isTestStatus && !bankId) {
    throw Object.assign(new Error("test in/out 请选择本司银行"), { status: 400 });
  }

  // 两户互转（CONTEXT.md）：bank trf 只表示本公司自己两户之间挪钱，一次写两条。
  // 校验必须在下面存 C STATUS 选项之前——那一步不在事务里，拒绝了也会留下新选项。
  const toBankId = Number(body.to_bank_account_id || 0);
  let toBank = null;
  if (status === "bank trf") {
    if (submittedCStatus || toCompanyId) {
      throw Object.assign(new Error("BANK TRF 是本公司两户互转，不填 C STATUS"), { status: 400 });
    }
    if (!bank) throw Object.assign(new Error("请选择转出的户口（从）"), { status: 400 });
    toBank = toBankId
      ? db
        .prepare(`SELECT * FROM bank_accounts WHERE id = ? AND company_id = ? AND ${SQL_OPERATING}`)
        .get(toBankId, fromCompanyId)
      : null;
    if (!toBank || toBank.id === bank.id) {
      throw Object.assign(new Error("请选择本公司另一个运营中的收款户口（到）"), { status: 400 });
    }
  }

  // Prefer the existing C STATUS association. The form does not need to repeat it.
  let targetCompany = toCompanyId || linkedCompanyForCStatus(db, fromCompanyId, submittedCStatus);
  if (targetCompany && targetCompany === fromCompanyId) {
    throw Object.assign(new Error("不能调给本公司"), { status: 400 });
  }
  const cStatus = submittedCStatus;
  if (cStatus) {
    upsertCStatusOptions(db, fromCompanyId, cStatus, targetCompany || null);
  }

  const groupId = makeTransferGroupId();
  const amounts = mapAmountFields(direction, status, amount);

  return runAtomic(db, () => {
    if (toBank) {
      const pair = insertInternalTransferPair(db, fromCompanyId, { from: bank, to: toBank, amount, entryTime, name, remark });
      appendAuditEvent(db, {
        companyId: fromCompanyId,
        action: "transfer.created",
        source: "user",
        actor: auditActorValue(actor),
        summary: `两户互转 #${pair.out.id} → #${pair.inbound.id}`,
        reason: String(body.reason || "").trim(),
        after: pickFields(pair.out, LEDGER_FIELDS),
        metadata: { direction, internal: true, from_bank_account_id: bank.id, to_bank_account_id: toBank.id },
        refs: internalPairRefs(pair),
      });
      return { ledger: pair.out, inbound: pair.inbound, transfer_group_id: pair.groupId, counterparty_required: false };
    }

    const ledger = insertLedger(db, {
      bank_account_id: bankId,
      company_id: fromCompanyId,
      entry_time: entryTime,
      ...amounts,
      bank_acc: bank ? bankAccLabel(bank) : "",
      name,
      c_status: cStatus,
      remark,
      auto_generated: 0,
      transfer_group_id: groupId,
    });

    appendAuditEvent(db, {
      companyId: fromCompanyId,
      action: "transfer.created",
      source: "user",
      actor: auditActorValue(actor),
      summary: `创建调钱流水 #${ledger.id}`,
      reason: String(body.reason || "").trim(),
      after: pickFields(ledger, LEDGER_FIELDS),
      metadata: { direction, target_company_id: targetCompany || "", counterparty_required: Boolean(targetCompany) },
      refs: ledgerRefs(ledger),
    });

    return {
      ledger,
      transfer_group_id: groupId,
      counterparty_required: Boolean(targetCompany),
    };
  });
}

// 封禁户「转出余额」。所有记账入口都只认运营中的户口，以前员工只能「解封 → 记两笔 → 再封禁」，
// 解封期间户口又出现在审批下拉里（2026-11-06 员工演练）。记法与用户确认（Excel）：
//   转到本公司另一个户口：封禁户 BANK TRF 出 + 收款户 BANK TRANSFER 入，金额相同，C STATUS 留空
//   转给别家公司：      封禁户 CASH OUT 出，C STATUS 填对方（对方自己记入账）
// 转到本公司户口就是调钱弹窗的「两户互转」，落列完全一样（mapAmountFields）。转给别家
// 2026-11-12 前记 BANK TRF，之后 bank trf 只表示本公司两户互转（CONTEXT.md）。
// 户口不解封；钱能拿回、户口还要用的照旧走「解封」。
function drainBannedAccount(db, companyId, bankId, body, actor) {
  const from = db
    .prepare("SELECT * FROM bank_accounts WHERE id = ? AND company_id = ?")
    .get(Number(bankId || 0), companyId);
  if (!from || !isBanned(from)) {
    throw Object.assign(new Error("只有封禁中的户口可以转出余额"), { status: 400 });
  }
  const amountNumber = Number(String(body?.amount ?? "").replace(/,/g, "").trim());
  const amount = Number.isFinite(amountNumber) ? Math.round(amountNumber * 100) / 100 : 0;
  if (!(amount > 0)) throw Object.assign(new Error("金额无效"), { status: 400 });
  const balance = balanceFromLedger(db, from.id);
  if (Math.round(amount * 100) > Math.round(balance * 100)) {
    throw Object.assign(new Error(`转出金额不能超过户口余额 ${balance.toFixed(2)}`), { status: 400 });
  }

  const toBankId = Number(body?.to_bank_account_id || 0);
  const cStatus = String(body?.c_status || "").trim();
  if (Boolean(toBankId) === Boolean(cStatus)) {
    throw Object.assign(new Error("请选择本公司收款户口，或填写对方公司的 C STATUS（二选一）"), { status: 400 });
  }
  let to = null;
  let targetCompany = "";
  if (toBankId) {
    to = db
      .prepare(`SELECT * FROM bank_accounts WHERE id = ? AND company_id = ? AND ${SQL_OPERATING}`)
      .get(toBankId, companyId);
    if (!to || to.id === from.id) {
      throw Object.assign(new Error("收款户口无效、已封禁或已归档"), { status: 400 });
    }
  } else {
    try {
      assertNotSelfCStatus(db, companyId, cStatus);
    } catch (e) {
      throw Object.assign(new Error("不能转给本公司，请改选本公司收款户口"), { status: 400 });
    }
    targetCompany = linkedCompanyForCStatus(db, companyId, cStatus);
  }

  const entryTime = nowSql();
  const remark = String(body?.remark || "").trim();
  return runAtomic(db, () => {
    if (cStatus) upsertCStatusOptions(db, companyId, cStatus, targetCompany || null);
    // 转回本公司就是两户互转；转给别家记 cash out——bank trf 永远不带 C STATUS。
    const pair = to ? insertInternalTransferPair(db, companyId, { from, to, amount, entryTime, remark }) : null;
    const out = pair
      ? pair.out
      : insertLedger(db, {
        bank_account_id: from.id,
        company_id: companyId,
        entry_time: entryTime,
        ...mapAmountFields("out", "cash out", amount),
        bank_acc: bankAccLabel(from),
        c_status: cStatus,
        remark,
        transfer_group_id: makeTransferGroupId(),
      });
    const inbound = pair ? pair.inbound : null;
    const groupId = out.transfer_group_id;
    appendAuditEvent(db, {
      companyId,
      action: "transfer.created",
      source: "user",
      actor: auditActorValue(actor),
      summary: `封禁户转出余额 #${out.id}${inbound ? ` → #${inbound.id}` : ""}`,
      reason: remark,
      after: pickFields(out, LEDGER_FIELDS),
      metadata: {
        banned_drain: true,
        from_bank_account_id: from.id,
        to_bank_account_id: to ? to.id : 0,
        target_company_id: targetCompany || "",
        counterparty_required: Boolean(targetCompany),
      },
      refs: pair ? internalPairRefs(pair) : ledgerRefs(out),
    });
    return { ledger: out, inbound, transfer_group_id: groupId, counterparty_required: Boolean(targetCompany) };
  });
}

function pendingCounts(db, companyId) {
  const tx = db
    .prepare("SELECT COUNT(*) AS n FROM bank_tx_pending WHERE company_id = ? AND state = 'pending'")
    .get(companyId).n;
  const dateKey = todayKey();
  expireSkippedPendingTx(db, companyId, dateKey);
  const skipped = db
    .prepare(
      `SELECT COUNT(*) AS n FROM bank_tx_pending WHERE company_id = ? AND ${SKIPPED_CURRENT_SQL}`
    )
    .get(companyId, ...skippedDayParams(dateKey)).n;
  return {
    company_id: companyId,
    pending_tx: tx,
    skipped_tx: skipped,
    total: tx,
  };
}

module.exports = {
  ACCOUNT_KINDS,
  C_STATUS_DEFAULTS,
  IN_STATUSES,
  OUT_STATUSES,
  bankAccLabel,
  mapAmountFields,
  ensureCStatusOptions,
  listCStatusOptions,
  selfCStatusNames,
  assertNotSelfCStatus,
  upsertCStatusOption,
  upsertCStatusOptions,
  logAccountEvent,
  insertLedger,
  enqueuePendingTx,
  pendingLedgerEntryTime,
  listPendingTx,
  listSkippedPendingTx,
  approvePendingTx,
  skipPendingTx,
  restoreSkippedPendingTx,
  deleteSkippedPendingTx,
  submitTransfer,
  drainBannedAccount,
  pendingCounts,
  platformTxTypeForLedger,
  reopenPendingForLedger,
  restoreConflictForDeleted,
  ledgerRowsToDelete,
  deletedRowsToRestore,
  nowSql,
  normalizeSqlDateTime,
};
