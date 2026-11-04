#!/usr/bin/env node
/**
 * 上线切换：人工流水归零（一次性）
 *
 * 用途：整库搬到 VPS 时，客户 / 交易 / 渠道 / 账号 / 公司 / 审计全部保留，但人工流水从零
 * 开始记。逻辑在 server/lib/ledgerCutover.js，这里只做参数、打印和闸门。
 *
 *   清：bank_ledger、bank_ledger_deleted（回收站）
 *   作废：bank_tx_pending 的 pending / skipped → expired（不删，否则同步会重新入队）
 *   余额：全部渠道重算，归 0
 *   报警：已置位的账户复位，并排撤回任务把聊天里旧的 ⚠️ 撤掉
 *   留：bank_balance_log —— 历史充提不会再进待审批队列
 *
 * ⚠️ 不可逆。跑之前必须：
 *   1. **停服务**（systemctl stop trader-dashboard / 本机按端口杀 PID）。同步开着的话
 *      fast lane 每 6 秒还在往队列插新单，结果说不清。
 *   2. **先打快照**，那是唯一退路：
 *        node scripts/vacuumSnapshot.js <库路径> <快照路径>
 *      库是 WAL，别直接拷 .db。
 *
 * 用法：
 *   node scripts/reset-ledger-for-cutover.js                    # dry-run（默认），只报数
 *   node scripts/reset-ledger-for-cutover.js --yes              # 真正执行
 *   node scripts/reset-ledger-for-cutover.js --yes --actor=admin --reason="..."
 *
 *   VPS 上必须显式给库路径：
 *   sudo -u trader TRADER_DB=/var/lib/trader-dashboard/trader.db \
 *     TRADER_CONFIG=/etc/trader-dashboard/config.json \
 *     node /opt/trader-dashboard/scripts/reset-ledger-for-cutover.js
 *
 * 退出码：0 正常（含 dry-run） / 2 执行后复查仍有未归零项 / 4 没跑起来（参数错、DB 打不开）
 */

const { getDb } = require("../server/db/init");
const { legacyActor } = require("../server/lib/auditLog");
const { planLedgerReset, applyLedgerReset } = require("../server/lib/ledgerCutover");

const DEFAULT_REASON = "VPS 上线切换：人工流水从零开始";

function fail(msg) {
  console.error("[reset-ledger] " + msg);
  process.exit(4);
}

function parseArgs(argv) {
  const out = { apply: false, actor: "", reason: DEFAULT_REASON };
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(arg);
    if (!m) fail("无法识别的参数：" + arg + "（用法见文件头注释）");
    const [, key, value] = m;
    if (key === "yes") out.apply = true;
    else if (key === "actor") out.actor = String(value || "").trim();
    else if (key === "reason") {
      const v = String(value || "").trim();
      if (!v) fail("--reason 不能为空");
      out.reason = v;
    } else if (key === "help") {
      console.log(require("fs").readFileSync(__filename, "utf8").split("*/")[0]);
      process.exit(0);
    } else fail("无法识别的参数：" + arg);
  }
  return out;
}

// 同 skipAllPending.js：默认记到 config.json 的 admin 名下，读不到就是 unknown。
function defaultActorUsername() {
  try {
    const { configPath } = require("../server/lib/paths");
    const cfg = JSON.parse(require("fs").readFileSync(configPath(), "utf8"));
    return String((cfg.admin && cfg.admin.username) || "").trim();
  } catch (_) {
    return "";
  }
}

function printPlan(rows) {
  const head =
    "公司".padEnd(14) + "流水".padStart(8) + "回收站".padStart(8) + "作废待审批".padStart(10) +
    "渠道".padStart(6) + "非零余额".padStart(8) + "余额合计".padStart(14) + "报警中".padStart(6);
  console.log(head);
  console.log("-".repeat(80));
  const sum = { ledger: 0, ledgerDeleted: 0, pendingVoided: 0, accounts: 0, nonZeroBalances: 0, balanceTotal: 0, alertsFired: 0 };
  for (const r of rows) {
    for (const k of Object.keys(sum)) sum[k] += Number(r[k] || 0);
    console.log(
      (r.companyId || "(空)").padEnd(14) + String(r.ledger).padStart(8) + String(r.ledgerDeleted).padStart(8) +
      String(r.pendingVoided).padStart(12) + String(r.accounts).padStart(8) + String(r.nonZeroBalances).padStart(10) +
      r.balanceTotal.toFixed(2).padStart(14) + String(r.alertsFired).padStart(8)
    );
  }
  console.log("-".repeat(80));
  console.log(
    "合计".padEnd(14) + String(sum.ledger).padStart(8) + String(sum.ledgerDeleted).padStart(8) +
    String(sum.pendingVoided).padStart(12) + String(sum.accounts).padStart(8) + String(sum.nonZeroBalances).padStart(10) +
    sum.balanceTotal.toFixed(2).padStart(14) + String(sum.alertsFired).padStart(8)
  );
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let db;
  try {
    db = getDb();
  } catch (err) {
    fail("打不开数据库：" + (err && err.message ? err.message : String(err)));
  }
  const actor = legacyActor(db, opts.actor || defaultActorUsername());

  const bar = "=".repeat(80);
  console.log("");
  console.log("人工流水归零" + (opts.apply ? "（真实执行）" : "（DRY-RUN，不写库）"));
  console.log("  数据库   : " + require("../server/db/init").DB_PATH);
  console.log("  操作人   : " + (actor.username || "（未知）") + "  type=" + actor.type);
  console.log("  审计原因 : " + opts.reason);
  console.log(bar);
  printPlan(planLedgerReset(db));
  console.log(bar);

  if (!opts.apply) {
    console.log("DRY-RUN 结束，一行都没有写。确认数字无误、服务已停、快照已打之后，加 --yes 执行。");
    return 0;
  }

  const t0 = Date.now();
  const result = applyLedgerReset(db, actor, opts.reason);
  console.log("执行完成，耗时 " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  console.log("  余额重算：检查 " + result.balances.checked + " 个渠道，变动 " + result.balances.changed + " 个");
  console.log("  报警复位：" + result.alertsCleared + " 个渠道（有已发消息的会排撤回任务，服务启动后由 bot 撤回）");

  const after = planLedgerReset(db);
  const left = after.reduce((n, r) => n + r.ledger + r.ledgerDeleted + r.pendingVoided + r.nonZeroBalances, 0);
  console.log("");
  console.log("复查：" + (left === 0 ? "流水 / 回收站 / 待审批 / 余额全部归零 ✓" : "还有 " + left + " 项未归零，用快照回滚后排查"));
  const states = db.prepare("SELECT state, COUNT(*) AS n FROM bank_tx_pending GROUP BY state ORDER BY state").all();
  console.log("bank_tx_pending 状态分布：" + states.map((s) => s.state + "=" + s.n).join("  "));
  console.log(bar);
  return left === 0 ? 0 : 2;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error("[reset-ledger] 未预期的错误：" + (err && err.stack ? err.stack : String(err)));
  process.exitCode = 4;
}
