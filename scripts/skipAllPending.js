#!/usr/bin/env node
/**
 * 批量把待审批平台单标成 skipped（一次性清空积压队列）
 *
 * 用途：`bank_tx_pending` 里积压了数千笔从未审批的平台单，队列本身成了噪音源
 * （侧边栏角标 + 报警声一直提醒）。本脚本把它们一次性标成 skipped，让队列归零。
 *
 * ⚠️ 这个操作实际上不可逆，跑之前必须明白三件事：
 *
 *   1. **skip 掉的钱永远不会进账本。** pending 单只有经 approvePendingTx 才写 bank_ledger。
 *      标成 skipped 就是放弃这笔流水记录 —— 跑之前请先确认这些钱不需要入账
 *      （用 tx_id 把 bank_tx_pending LEFT JOIN bank_ledger 可以查已录入的部分）。
 *   2. **今天以前的单会立刻永久定型。** bankApply.js 的 expireSkippedPendingTx 把
 *      tx_time 早于今天的 skipped 单转成 expired，而 restoreSkippedPendingTx 只认
 *      skipped。触发点是 pendingCounts()，也就是每 8 秒被轮询的
 *      /api/banks/pending-counts —— 所以 skip 之后几秒内就回不去了。
 *      只有**当天**的单还能从「已跳过」tab 恢复。
 *   3. **跑之前先备份。** 库是 WAL 模式，用 scripts/vacuumSnapshot.js 打快照，
 *      别直接拷 .db（会丢掉未 checkpoint 的 WAL）。
 *
 * 本脚本**不碰钱**：不经过 refreshBankBalance，不写 bank_ledger / bank_balance_log。
 * 跑完后 bank_accounts.balance 必须与跑之前逐一相等，不等就说明走错了路径，用备份回滚。
 *
 * 设计约束（改这个文件前必读）：
 *   1. **必须复用 bankApply.js 的 skipPendingTx**，不要自己写 UPDATE。它负责审计事件、
 *      decided_by 与公司隔离，绕过它就丢掉全部可追溯性 —— 这批操作日后唯一的解释
 *      就是那几千条 pending.skipped 审计记录里的 reason。
 *   2. **绝不在外层包 runAtomic。** CLAUDE.md 写明 bankApply.js 的 runAtomic
 *      **没有嵌套保护**，而 skipPendingTx 内部自带事务；外面再包一层，内层的 ROLLBACK
 *      会把外层已写入的一切一起回滚。所以这里逐笔独立调用，单笔失败不影响其他。
 *   3. **开工前先 snapshot 一份 tx_id 列表**，不要边查边改：同步 fast lane 每 6 秒还在
 *      往队列里插新单，边查边改会让「处理了多少」永远说不清。
 *   4. 收尾用 pendingCounts() 而不是 expireSkippedPendingTx() —— 后者没有导出，而前者
 *      内部就会调它（bankApply.js:839）。顺带把最终计数打出来。
 *      **这一步是有意放在脚本里的**：几千行 UPDATE + 几千条审计 insert 是一个大事务，
 *      而 better-sqlite3 是同步的。留给线上第一次轮询做，会把 HTTP 事件循环卡住几秒。
 *
 * 建议先停服务器再跑 —— 不是为了安全（WAL + busy_timeout 允许并发写），而是为了结果
 * 干净：同步不停就永远清不到 0。按端口精确杀 PID，别用 `Get-Process node | Stop-Process`
 * （那会连带杀掉正在跑的编辑器 / Claude Code 会话）。
 *
 * 用法：
 *   node scripts/skipAllPending.js                        # dry-run，只报数不写（默认）
 *   node scripts/skipAllPending.js --yes                  # 真正执行
 *   node scripts/skipAllPending.js --company=rolex66      # 限定公司（可逗号分隔 / 重复）
 *   node scripts/skipAllPending.js --today-only           # 只处理今天的单（当天可恢复）
 *   node scripts/skipAllPending.js --before-today         # 只处理今天以前的积压
 *   node scripts/skipAllPending.js --actor=admin          # 审计里记到谁名下
 *   node scripts/skipAllPending.js --reason="..."         # 覆盖默认的审计原因
 *   node scripts/skipAllPending.js --limit=100 --yes      # 先小批量试水
 *
 * 退出码：
 *   0  全部成功（或 dry-run 正常结束）
 *   2  有笔数失败（已处理的仍然生效，重跑即可续做）
 *   4  根本没跑起来（DB 打不开、--company 写错、没有可处理的公司）
 */

const { getDb } = require("../server/db/init");
const { legacyActor } = require("../server/lib/auditLog");
const { skipPendingTx, listPendingTx, pendingCounts } = require("../server/lib/bankApply");
const { todayKey } = require("../server/lib/dates");

const DEFAULT_REASON = "批量清空历史积压待审批单（经确认这些流水不入账本）";
const PROGRESS_EVERY = 500;

// ---------------------------------------------------------------- 参数

function fail(msg) {
  console.error("[skipAllPending] " + msg);
  process.exit(4);
}

function parseArgs(argv) {
  const out = { ids: [], apply: false, actor: "", reason: DEFAULT_REASON, scope: "all", limit: 0 };
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(arg);
    if (!m) fail("无法识别的参数：" + arg + "（用法见文件头注释）");
    const [, key, value] = m;
    if (key === "company" || key === "companies") {
      for (const id of String(value || "").split(",")) {
        const trimmed = id.trim();
        if (trimmed) out.ids.push(trimmed);
      }
    } else if (key === "yes") {
      out.apply = true;
    } else if (key === "actor") {
      out.actor = String(value || "").trim();
    } else if (key === "reason") {
      const v = String(value || "").trim();
      if (!v) fail("--reason 不能为空：这是日后唯一的解释");
      out.reason = v;
    } else if (key === "today-only") {
      out.scope = "today";
    } else if (key === "before-today") {
      out.scope = "before";
    } else if (key === "limit") {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) fail("--limit 必须是正整数");
      out.limit = n;
    } else if (key === "help") {
      console.log(require("fs").readFileSync(__filename, "utf8").split("*/")[0]);
      process.exit(0);
    } else {
      fail("无法识别的参数：" + arg);
    }
  }
  return out;
}

// 默认拿 config.json 的 admin 作为审计上的操作人。读不到就留空，
// legacyActor 会退化成 type:"unknown" —— 审计仍然成立，只是记不到具体人。
function defaultActorUsername() {
  try {
    const { configPath } = require("../server/lib/paths");
    const cfg = JSON.parse(require("fs").readFileSync(configPath(), "utf8"));
    return String((cfg.admin && cfg.admin.username) || "").trim();
  } catch (_) {
    return "";
  }
}

// ---------------------------------------------------------------- 主流程

function companiesToProcess(db, ids) {
  const rows = db.prepare("SELECT id FROM companies ORDER BY sort_order ASC, id ASC").all();
  const known = rows.map((r) => r.id);
  // 队列里可能有已经从 companies 表删掉的公司留下的单，那些也要能清。
  const orphans = db
    .prepare("SELECT DISTINCT company_id AS id FROM bank_tx_pending WHERE state='pending' AND company_id NOT IN (SELECT id FROM companies)")
    .all()
    .map((r) => r.id);
  const all = [...known, ...orphans];
  if (!ids.length) return all;
  const picked = [];
  for (const id of ids) {
    if (!all.includes(id)) fail("公司不存在或队列里没有它的单：" + id + "（可选：" + all.join(", ") + "）");
    picked.push(id);
  }
  return picked;
}

function inScope(row, scope, dateKey) {
  if (scope === "all") return true;
  const day = String(row.tx_time || "").slice(0, 10);
  return scope === "today" ? day === dateKey : day < dateKey;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dateKey = todayKey();

  let db;
  try {
    db = getDb();
  } catch (err) {
    fail("打不开数据库：" + (err && err.message ? err.message : String(err)));
  }

  const companies = companiesToProcess(db, opts.ids);
  if (!companies.length) fail("没有可处理的公司");

  const actorName = opts.actor || defaultActorUsername();
  const actor = legacyActor(db, actorName);

  // 约束 3：先 snapshot，再动手。同步每 6 秒还在插新单。
  const planned = [];
  for (const companyId of companies) {
    const rows = listPendingTx(db, companyId).filter((r) => inScope(r, opts.scope, dateKey));
    for (const row of rows) planned.push({ companyId, txId: row.tx_id, txType: row.tx_type, amount: row.amount, txTime: row.tx_time });
  }
  const targets = opts.limit ? planned.slice(0, opts.limit) : planned;

  const bar = "=".repeat(74);
  console.log("");
  console.log("#".repeat(74));
  console.log("批量 skip 待审批平台单" + (opts.apply ? "（真实执行）" : "（DRY-RUN，不写库）"));
  console.log("  数据库   : " + require("../server/db/init").DB_PATH);
  console.log("  今日     : " + dateKey + "（Australia/Sydney）");
  console.log("  范围     : " + { all: "全部", today: "仅今天", before: "仅今天以前" }[opts.scope]);
  console.log("  公司     : " + companies.join(", "));
  console.log("  操作人   : " + (actor.username || "（未知）") + "  type=" + actor.type);
  console.log("  审计原因 : " + opts.reason);
  if (opts.limit) console.log("  --limit  : 只处理前 " + opts.limit + " 笔");
  console.log(bar);

  // 按公司 × 类型摊开，让人跑之前看清自己在放弃什么。
  const summary = new Map();
  for (const t of targets) {
    const key = t.companyId + "|" + t.txType;
    const cur = summary.get(key) || { companyId: t.companyId, txType: t.txType, n: 0, total: 0, oldest: t.txTime, newest: t.txTime };
    cur.n += 1;
    cur.total += Number(t.amount || 0);
    if (t.txTime < cur.oldest) cur.oldest = t.txTime;
    if (t.txTime > cur.newest) cur.newest = t.txTime;
    summary.set(key, cur);
  }
  console.log("公司".padEnd(14) + "类型".padEnd(12) + "笔数".padStart(8) + "金额".padStart(16) + "   最早 → 最新");
  console.log("-".repeat(74));
  for (const s of [...summary.values()].sort((a, b) => a.companyId.localeCompare(b.companyId) || a.txType.localeCompare(b.txType))) {
    console.log(
      s.companyId.padEnd(12) + s.txType.padEnd(12) + String(s.n).padStart(8) + s.total.toFixed(2).padStart(16) +
      "   " + s.oldest.slice(0, 10) + " → " + s.newest.slice(0, 10)
    );
  }
  console.log("-".repeat(74));
  const grand = targets.reduce((sum, t) => sum + Number(t.amount || 0), 0);
  console.log("合计".padEnd(24) + String(targets.length).padStart(8) + grand.toFixed(2).padStart(16));
  console.log(bar);

  if (!targets.length) {
    console.log("队列里没有符合条件的 pending 单，无需处理。");
    return 0;
  }

  if (!opts.apply) {
    console.log("");
    console.log("DRY-RUN 结束，一行都没有写。确认上面的数字无误后，加 --yes 真正执行。");
    console.log("提醒：跑之前先 node scripts/vacuumSnapshot.js server/db/trader.db <备份路径>");
    return 0;
  }

  // 约束 2：逐笔独立调用，外面绝不包 runAtomic。
  let ok = 0;
  const failures = [];
  const t0 = Date.now();
  for (let i = 0; i < targets.length; i += 1) {
    const t = targets[i];
    try {
      skipPendingTx(db, t.companyId, t.txId, actor, opts.reason);
      ok += 1;
    } catch (err) {
      failures.push({ companyId: t.companyId, txId: t.txId, error: String((err && err.message) || err) });
    }
    if ((i + 1) % PROGRESS_EVERY === 0 || i + 1 === targets.length) {
      const pct = (((i + 1) / targets.length) * 100).toFixed(1);
      console.log(
        "  进度 " + String(i + 1).padStart(6) + " / " + targets.length +
        "  (" + pct + "%)  成功 " + ok + "  失败 " + failures.length +
        "  " + ((Date.now() - t0) / 1000).toFixed(1) + "s"
      );
    }
  }

  console.log(bar);
  console.log("处理完成：成功 " + ok + "，失败 " + failures.length + "，耗时 " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  if (failures.length) {
    console.log("失败明细（最多列 20 条）：");
    for (const f of failures.slice(0, 20)) console.log("  " + f.companyId + " / " + f.txId + " : " + f.error);
    if (failures.length > 20) console.log("  ... 另有 " + (failures.length - 20) + " 条");
  }

  // 约束 4：在这里把过期大事务做掉，别留给线上第一次轮询。
  console.log("");
  console.log("收尾：触发跳过单过期处理并复查计数（pendingCounts 内部会调 expireSkippedPendingTx）");
  for (const companyId of companies) {
    const counts = pendingCounts(db, companyId);
    console.log(
      "  " + companyId.padEnd(12) + " pending=" + String(counts.pending_tx).padStart(6) +
      "  今日skipped=" + String(counts.skipped_tx).padStart(6) + "  total=" + counts.total
    );
  }

  const states = db
    .prepare("SELECT state, COUNT(*) AS n FROM bank_tx_pending GROUP BY state ORDER BY state")
    .all();
  console.log("");
  console.log("bank_tx_pending 状态分布：" + states.map((s) => s.state + "=" + s.n).join("  "));
  console.log(bar);

  return failures.length ? 2 : 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error("[skipAllPending] 未预期的错误：" + (err && err.stack ? err.stack : String(err)));
  process.exitCode = 4;
}
