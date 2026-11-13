#!/usr/bin/env node
/**
 * 更正「审批时入账日期误选」的平台单流水（一次性修数据）
 *
 * 起因：2026-11-13 rolex66 17271440755，11-13 的单审批时日期被改成 10-13，于是 11-13 的流水、
 * 日报里都找不到这笔，看起来像漏单。服务端从此硬拦（pendingLedgerEntryTime 只准平台日期前一天起），
 * 本脚本只收拾护栏上线前已经落库的那些。规则与审计见 server/lib/pendingEntryDateFix.js。
 *
 * 找什么：bank_tx_pending 里 state='approved' 且 approved_entry_time 的日期早于「平台单日期前一天」，
 *         平台单日期 >= --since（默认 2026-11-12，生产库那天做过测试清场，更早的不碰）。
 * 改什么：只把日期部分换成平台单日期，时分秒不动；同公司同 tx_id 的 bank_ledger 里日期同样越界的
 *         行一起改，每行写 ledger.updated 审计；涉及户口重算余额（不发 Telegram 报警）。
 *
 * ⚠️ 跑之前：
 *   1. 先 dry-run 看清单，给负责人确认。
 *   2. 加 --yes 之前先 node scripts/vacuumSnapshot.js <库> <备份路径>（库是 WAL，别直接拷 .db）。
 *
 * 用法：
 *   node scripts/fix-pending-entry-date.js                     # dry-run（默认），只列清单
 *   node scripts/fix-pending-entry-date.js --yes               # 真正更正
 *   node scripts/fix-pending-entry-date.js --tx=17271440755    # 只处理这一单
 *   node scripts/fix-pending-entry-date.js --company=rolex66   # 只处理这家
 *   node scripts/fix-pending-entry-date.js --since=2026-11-12  # 平台单日期下限
 *   node scripts/fix-pending-entry-date.js --actor=admin       # 审计里记到谁名下
 *
 * 退出码：0 正常（含 dry-run / 没有要改的）；4 没跑起来（参数错、库打不开）。
 */

const { getDb, DB_PATH } = require("../server/db/init");
const { legacyActor, systemActor } = require("../server/lib/auditLog");
const { DEFAULT_SINCE, findMisdatedApprovals, fixMisdatedApprovals } = require("../server/lib/pendingEntryDateFix");

function fail(msg) {
  console.error("[fix-pending-entry-date] " + msg);
  process.exit(4);
}

function parseArgs(argv) {
  const out = { apply: false, txId: "", companyId: "", since: DEFAULT_SINCE, actor: "" };
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) fail("无法识别的参数：" + arg);
    const [, key, value = ""] = m;
    if (key === "yes") out.apply = true;
    else if (key === "tx") out.txId = value.trim();
    else if (key === "company") out.companyId = value.trim();
    else if (key === "since") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("--since 要写成 YYYY-MM-DD");
      out.since = value;
    } else if (key === "actor") out.actor = value.trim();
    else fail("无法识别的参数：" + arg);
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let db;
  try {
    db = getDb();
  } catch (err) {
    fail("打不开数据库：" + (err && err.message ? err.message : String(err)));
  }
  const items = findMisdatedApprovals(db, opts);
  console.log("");
  console.log("更正审批入账日期" + (opts.apply ? "（真实执行）" : "（DRY-RUN，不写库）"));
  console.log("  数据库 : " + DB_PATH);
  console.log("  范围   : 平台单日期 >= " + opts.since + (opts.companyId ? "，公司 " + opts.companyId : "") + (opts.txId ? "，单号 " + opts.txId : ""));
  console.log("-".repeat(96));
  console.log("公司".padEnd(12) + "单号".padEnd(14) + "类型".padEnd(10) + "金额".padStart(10) + "  平台单时间           入账时间（现）        审批人   流水行");
  for (const { pending, ledger } of items) {
    console.log(
      String(pending.company_id).padEnd(12) + String(pending.tx_id).padEnd(14) + String(pending.tx_type).padEnd(10) +
      Number(pending.amount || 0).toFixed(2).padStart(10) + "  " + pending.tx_time + "  " + pending.approved_entry_time +
      "  " + String(pending.approved_by || pending.decided_by || "").padEnd(8) + " " + ledger.map((l) => "#" + l.id).join(",")
    );
  }
  console.log("-".repeat(96));
  console.log("共 " + items.length + " 单、" + items.reduce((n, it) => n + it.ledger.length, 0) + " 行流水");
  if (!items.length) return 0;
  if (!opts.apply) {
    console.log("DRY-RUN 结束，一行都没有写。确认无误后先 vacuumSnapshot，再加 --yes。");
    return 0;
  }
  const actor = opts.actor ? legacyActor(db, opts.actor) : systemActor("入账日期更正脚本");
  const result = fixMisdatedApprovals(db, items, actor);
  console.log("已更正：" + result.pendingFixed + " 单、" + result.ledgerFixed + " 行流水；重算余额的户口：" + (result.banks.join(", ") || "无"));
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error("[fix-pending-entry-date] 未预期的错误：" + (err && err.stack ? err.stack : String(err)));
  process.exitCode = 4;
}
