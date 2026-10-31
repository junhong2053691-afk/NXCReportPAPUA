#!/usr/bin/env node
/**
 * 盘方 API 白名单自检（只读，直连盘方，不经过应用）
 *
 * 用途：改完盘方后台的 IP 白名单之后，在**启动服务之前**逐公司确认「白名单真的生效了」。
 *
 * 为什么必须在启动之前跑：白名单没通就启动服务，scheduler.js:81-95 会把该公司 × 该 lane
 * 退避 300s → 指数到 1800s。表现是「看着起来了在等」，其实它在睡觉 —— 你会白等半小时。
 * 所以本脚本的退出码就是那道闸门：**只有 0 才允许 systemctl start**。
 *
 * 设计约束（改这个文件前必读）：
 *   1. 只 require 两个项目模块，且都必须是**加载期与调用期都无副作用**的：
 *      ../server/lib/paths（只调 dbPath()）与 ../server/lib/dates（纯 Intl 格式化）。
 *      - 不能 require services/platform.js：它每个导出都经 platformCfg() → getDb() →
 *        db/init.js 的 migration，那是**写操作**。只读自检里跑 DDL 不可接受。
 *      - 不能调 paths.js 的 stateDir()：server/lib/paths.js:27 有 fs.mkdirSync。
 *   2. 本脚本不产生任何写入：只读方式开库，不碰 state 目录，不落日志文件。
 *   3. 判据与三处生产代码同源 —— services/platform.js:66-76（六个子串）、
 *      platform.js:138-148（成功/失败判据）、routes/companies.js:43-51（后台"测试连接"）。
 *      **四处同源，改一处要改四处。**（切换稳定后可抽 server/lib/platformProbe.js 收敛。）
 *   4. 绝不重试。理由见 platform.js:62-65：重试 ACCESS_DENIED 可能延长 IP 封禁；
 *      而且白名单自检要的就是第一手答案。
 *
 * 脱敏铁律（输出可以直接截图发群里，所以下面两条不能破）：
 *   - access_token 一律掩码，--json 输出同样只给掩码。
 *   - 拿回来的是**真实交易 / 用户行，含姓名与手机号**（Key 勾了 Show Member Mobile）。
 *     所以只打条数，**永不打印 response body 或任何行内容**；失败时 detail 只取平台的
 *     message 字段，不是整个 text。
 *     注意：**盘方会忽略 pageSize=1**，交易模块实测仍返回默认页（10 条）。也就是说
 *     一次全量自检会把 40 条含 PII 的行读进内存 —— 上面那条"只打条数"不是洁癖，是必要的。
 *   - 唯一会出现的敏感信息是**你自己的出口 IP**（这正是要拿去填白名单的值）。外发截图时
 *     心里有数即可，它不是凭证。
 *
 * 一个意外好用的信号：被拒时盘方会把**它看到的源 IP** 回显在消息里，形如
 * `Invalid Access IP [113.211.213.170]`。这比 ifconfig.me 权威 —— 有多出口 / CDN / IPv6
 * 时本地探测值与盘方实际看到的值可能不同，而**白名单要填的是盘方看到的那个**。所以本脚本
 * 把它单独提取出来，并与本地探测的出口 IP 比对。
 *
 * 用法：
 *   node scripts/check-api-access.js                      # 测全部公司
 *   node scripts/check-api-access.js --company=rolex66    # 只测一家（可重复/逗号分隔）
 *   node scripts/check-api-access.js --module=users       # 改测 /users/getAllUsers 模块权限
 *   node scripts/check-api-access.js --timeout=30000      # 单次请求超时，默认 15000ms
 *   node scripts/check-api-access.js --no-egress          # 跳过出口 IP 探测（不联外网）
 *   node scripts/check-api-access.js --json               # 机器可读输出
 *
 *   # VPS 上必须显式给 TRADER_DB —— paths.js:7 只认 TRADER_CONFIG/TRADER_DB/TRADER_STATE_DIR，
 *   # 忘了传就会去读代码目录里不存在的 server/db/trader.db。用 sudo -u trader 跑还顺带
 *   # 验证了服务用户对 0640 的库有读权限。
 *   sudo -u trader TRADER_DB=/var/lib/trader-dashboard/trader.db \
 *     node /opt/trader-dashboard/scripts/check-api-access.js
 *
 * 退出码：
 *   0  被测公司全部 OK        —— 唯一允许 systemctl start 的状态
 *   2  任一 DENIED            —— 白名单没生效 / 填错 / 凭证失效，别启动服务
 *   3  无 DENIED 但有 NET/API —— 可重试；先排 IPv6、DNS、防火墙
 *   4  根本没测起来           —— DB 打不开、表不存在、--company 写错、一家都没有
 *   优先级 4 > 2 > 3 > 0。
 */

const dns = require("dns");
const https = require("https");
const { URL } = require("url");
const { dbPath } = require("../server/lib/paths");
const { formatSydneyDateTime } = require("../server/lib/dates");

const TX_MODULE = "/transactions/getAllTransactions";
const USERS_MODULE = "/users/getAllUsers";
const DEFAULT_TIMEOUT_MS = 15000;
const EGRESS_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const out = { ids: [], timeoutMs: DEFAULT_TIMEOUT_MS, module: "tx", json: false, egress: true };
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) {
      fail("无法识别的参数：" + arg + "（用法见文件头注释）");
    }
    const [, key, value] = m;
    if (key === "company" || key === "companies") {
      for (const id of String(value || "").split(",")) {
        const trimmed = id.trim();
        if (trimmed) out.ids.push(trimmed);
      }
    } else if (key === "timeout") {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) fail("--timeout 必须是正整数毫秒");
      out.timeoutMs = n;
    } else if (key === "module") {
      const v = String(value || "").toLowerCase();
      if (v !== "tx" && v !== "users") fail("--module 只接受 tx 或 users");
      out.module = v;
    } else if (key === "json") {
      out.json = true;
    } else if (key === "no-egress") {
      out.egress = false;
    } else if (key === "help") {
      console.log(require("fs").readFileSync(__filename, "utf8").split("*/")[0]);
      process.exit(0);
    } else {
      fail("无法识别的参数：" + arg);
    }
  }
  return out;
}

function fail(msg) {
  console.error("[check-api-access] " + msg);
  process.exit(4);
}

// ---------------------------------------------------------------- 数据库（只读）

// 两种驱动的参数名不同（better-sqlite3: readonly / node:sqlite: readOnly），
// 都尝试一遍，任一可用即可。与 scripts/audit-data-integrity.js:22-31 同源。
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

// 故意不按 enabled 过滤：切换期很可能有人把某家设成 0，而"这家白名单通不通"
// 与"这家现在开不开"是两个问题。enabled=0 只在输出里标注。
function loadCompanies(db, ids) {
  const rows = db
    .prepare(
      "SELECT id, name, api_url, access_id, access_token, enabled FROM companies ORDER BY sort_order ASC, id ASC"
    )
    .all();
  if (!ids.length) return rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const picked = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      fail("公司不存在：" + id + "（库里有：" + rows.map((r) => r.id).join(", ") + "）");
    }
    picked.push(row);
  }
  return picked;
}

function maskToken(token) {
  const s = String(token || "");
  if (!s) return "—";
  if (s.length < 12) return "****";
  return s.slice(0, 4) + "…" + s.slice(-4);
}

// ---------------------------------------------------------------- 出口 IP 与 DNS

// 只为了把"我现在的出口 IP"打出来，好跟盘方后台的 IP Address 逐字比对。
// 不发送任何本地数据，响应体只当作一个 IP 字符串。DEPLOY.md 用的也是 ifconfig.me。
function egressIp(family, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.get(
      { hostname: "ifconfig.me", path: "/ip", family, timeout: timeoutMs, agent: false },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (body.length < 100) body += chunk;
        });
        res.on("end", () => {
          const ip = body.trim();
          resolve(/^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : null);
        });
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

// A+AAAA 同时存在且解析顺序是 verbatim → undici 可能挑 IPv6 出口，而白名单往往只有
// IPv4（DEPLOY.md:87-90）。这是"时通时不通"最隐蔽的一种成因，所以单列一栏。
async function dnsFacts(apiUrl) {
  let host;
  try {
    host = new URL(apiUrl).hostname;
  } catch {
    return { host: null, v4: 0, v6: 0, order: null, label: "—" };
  }
  let order = null;
  try {
    order = dns.getDefaultResultOrder ? dns.getDefaultResultOrder() : null;
  } catch {
    order = null;
  }
  let addrs = [];
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch {
    return { host, v4: 0, v6: 0, order, label: "解析失败" };
  }
  const v4 = addrs.filter((a) => a.family === 4).length;
  const v6 = addrs.filter((a) => a.family === 6).length;
  let label = v4 && v6 ? "A+AAAA" : v6 ? "AAAA" : v4 ? "A" : "无记录";
  if (v6 && order) label += "(" + (order === "verbatim" ? "v" : "4f") + ")";
  return { host, v4, v6, order, label };
}

// ---------------------------------------------------------------- 探测

// 与 services/platform.js:66-76 逐字同源。命中即 ACCESS_DENIED，不重试。
function isAccessDenied(msg) {
  const s = String(msg || "").toLowerCase();
  return (
    s.includes("invalid access") ||
    s.includes("access denied") ||
    s.includes("unauthorized") ||
    s.includes("forbidden") ||
    s.includes("invalid token") ||
    s.includes("invalid credential")
  );
}

// 盘方被拒消息里会回显它看到的源 IP：`Invalid Access IP [113.211.213.170]`。
// 这是填白名单时最权威的依据 —— 比本地探测的出口 IP 可信，因为中间任何一跳 NAT/代理
// 都可能让两者不同。只认真正的 IP 字面量，避免把别的方括号内容误当 IP。
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function platformSeenIp(message) {
  const matches = String(message || "").match(/\[([^\]]{3,45})\]/g) || [];
  for (const raw of matches) {
    const inner = raw.slice(1, -1).trim();
    if (IPV4_RE.test(inner) && inner.split(".").every((o) => Number(o) <= 255)) return inner;
    if (inner.includes(":") && /^[0-9a-fA-F:.]+$/.test(inner)) return inner;
  }
  return null;
}

// 与 services/platform.js:138-144 及 routes/companies.js:43-51 同源的失败消息提取。
function errorMessageOf(json) {
  return (
    (json.data && (json.data.message || json.data.msg)) ||
    json.message ||
    json.msg ||
    json.status ||
    "API error"
  );
}

// 盘方对交易查询有 **31 天窗口上限**（与 config.json 的 transactionChunkDays: 31 对应，
// sync.js 就是按 31 天分块拉的）。超限会回 "Start and end date cannot be more than 31 days."
// —— 那是业务错误，不是白名单问题，会把自检结果搅浑。所以这里只问最近 1 天：
// 窗口越小越便宜，而我们要的只是"这个出口 IP 能不能通过鉴权"。
//
// ⚠ routes/companies.js:34-35 的「测试连接」按钮用的是 sDate=2020-01-01 / eDate=2030-01-01，
// 正好超限 —— 那个按钮现在永远返回这条错误，不会返回"连接成功"。别照抄它。
// 用 lib/dates.js 的 formatSydneyDateTime，与生产发给盘方的日期同一套时区语义
// （Australia/Sydney），不另造一份本地时区的格式化。
function recentWindow() {
  return {
    sDate: formatSydneyDateTime(new Date(Date.now() - 24 * 3600 * 1000).toISOString()),
    eDate: formatSydneyDateTime(new Date().toISOString()),
  };
}

// 最小请求：与 routes/companies.js:27-35 同形，**但加了 AbortController 超时**
// （那个现有实现的 fetch 没有 signal，盘方边缘挂住时请求会一直悬着）
// **且日期窗口收到 31 天以内**（见 recentWindow 上方注释）。
function buildForm(row, moduleKind) {
  const form = new FormData();
  if (moduleKind === "users") {
    form.append("module", USERS_MODULE);
  } else {
    form.append("module", TX_MODULE);
  }
  form.append("accessId", String(row.access_id || "").trim());
  form.append("accessToken", String(row.access_token || "").trim());
  form.append("pageIndex", "0");
  form.append("pageSize", "1");
  if (moduleKind !== "users") {
    const { sDate, eDate } = recentWindow();
    form.append("type", "DEPOSIT");
    form.append("sDate", sDate);
    form.append("eDate", eDate);
  }
  return form;
}

// 只数条数，绝不返回行内容 —— 这些行含真实姓名与手机号。
function sampleCount(data, moduleKind) {
  if (!data || typeof data !== "object") return 0;
  const rows = moduleKind === "users" ? data.users || data.members : data.transactions;
  return Array.isArray(rows) ? rows.length : 0;
}

async function probe(row, opts) {
  const apiUrl = String(row.api_url || "").trim();
  const accessId = String(row.access_id || "").trim();
  const accessToken = String(row.access_token || "").trim();
  if (!apiUrl || !accessId || !accessToken) {
    return { status: "SKIP", ms: 0, detail: "凭证不全（api_url / accessId / accessToken 有空缺）" };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let text;
  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      body: buildForm(row, opts.module),
      signal: controller.signal,
      // 一次性探测，不需要连接复用。更重要的是：留着 keep-alive socket 会让
      // 进程退出时 libuv 在 Windows 上断言失败（src\win\async.c:76），退出码被
      // 0xC0000409 覆盖 —— 而本脚本的全部价值就在退出码上。见文件末尾 finish()。
      headers: { connection: "close" },
    });
    // platform.js 只在 >=500 时当网络错误；4xx 也照样读 body，因为盘方是
    // HTTP 200 + status!=SUCCESS 的风格，真出 4xx 时 body 里的消息才是线索。
    text = await res.text();
    if (!res.ok && res.status >= 500) {
      return { status: "NET", ms: Date.now() - started, detail: "HTTP " + res.status };
    }
  } catch (err) {
    const ms = Date.now() - started;
    if (err && err.name === "AbortError") {
      return { status: "NET", ms, detail: "timeout after " + opts.timeoutMs + "ms" };
    }
    const cause = (err && (err.cause?.code || err.cause?.message)) || "";
    const detail = [err && err.message ? err.message : String(err), cause].filter(Boolean).join(" / ");
    return { status: "NET", ms, detail };
  } finally {
    clearTimeout(timer);
  }

  const ms = Date.now() - started;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // 不打 body：可能是盘方的错误页，也可能夹带数据。只说长度。
    return { status: "BADJSON", ms, detail: "返回非 JSON（" + text.length + " 字节），检查 api_url" };
  }
  if (json.status !== "SUCCESS") {
    const msg = errorMessageOf(json);
    const seenIp = platformSeenIp(msg);
    if (isAccessDenied(msg)) return { status: "DENIED", ms, detail: String(msg), seenIp };
    return { status: "API", ms, detail: String(msg), seenIp };
  }
  return { status: "OK", ms, detail: "样本 " + sampleCount(json.data || json, opts.module) + " 条" };
}

// ---------------------------------------------------------------- 输出

const STATUS_NOTE = {
  OK: "通",
  DENIED: "白名单未生效 / 凭证失效",
  NET: "网络层失败（不是白名单问题）",
  API: "业务错误（凭证对，但模块权限或参数有问题）",
  BADJSON: "返回非 JSON",
  SKIP: "未测（凭证不全）",
};

// 按**显示宽度**补齐：中文列名在终端占 2 格，但 String.length 只算 1，
// 直接用 padEnd 会让表头比数据行整体右移。
function displayWidth(text) {
  let w = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    const wide =
      c >= 0x1100 &&
      (c <= 0x115f ||
        (c >= 0x2e80 && c <= 0xa4cf) ||
        (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe30 && c <= 0xfe6f) ||
        (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6));
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(text, width) {
  const s = String(text);
  const w = displayWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

function renderTable(results, meta) {
  const bar = "=".repeat(78);
  console.log("");
  console.log("#".repeat(78));
  console.log("盘方 API 白名单自检（只读；直连盘方，不经过应用）");
  console.log("  数据库 : " + meta.dbFile + "   驱动: " + meta.driver);
  console.log("  时间   : " + new Date().toISOString());
  if (meta.egress) {
    console.log("  出口IP : IPv4 " + (meta.egress.v4 || "探测失败"));
    console.log("           IPv6 " + (meta.egress.v6 || "无 / 探测失败"));
  } else {
    console.log("  出口IP : 已跳过（--no-egress）");
  }
  console.log(
    "  超时   : " + meta.timeoutMs + "ms    模块: " + (meta.module === "users" ? USERS_MODULE : TX_MODULE)
  );
  console.log(bar);
  console.log(
    pad("公司", 14) + pad("accessId", 10) + pad("token", 12) + pad("DNS", 12) + pad("结果", 9) + pad("耗时", 9) + "详情"
  );
  console.log("-".repeat(78));
  for (const r of results) {
    console.log(
      pad(r.id + (r.enabled ? "" : "*"), 14) +
        pad(r.accessId || "—", 10) +
        pad(r.token, 12) +
        pad(r.dns, 12) +
        pad(r.status, 9) +
        pad(r.ms ? r.ms + "ms" : "—", 9) +
        r.detail
    );
  }
  console.log(bar);

  if (results.some((r) => !r.enabled)) {
    console.log("* = companies.enabled = 0（本脚本不按 enabled 过滤：白名单通不通与开不开是两回事）");
  }

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log(
    "汇总   : " +
      Object.keys(STATUS_NOTE)
        .filter((k) => counts[k])
        .map((k) => k + " " + counts[k])
        .join(" / ")
  );

  // 盘方回显的源 IP 优先于本地探测值 —— 见文件头注释。
  const seen = [...new Set(results.map((r) => r.seenIp).filter(Boolean))];
  console.log("");
  if (seen.length === 1) {
    console.log("★ 盘方看到的源 IP : " + seen[0] + "　←── 这就是要填进白名单的值");
    if (meta.egress && meta.egress.v4 && meta.egress.v4 !== seen[0]) {
      console.log(
        "  ⚠ 与本地探测的出口 IP（" +
          meta.egress.v4 +
          "）不一致 —— 中间有 NAT/代理/多出口。**以盘方看到的为准。**"
      );
    }
  } else if (seen.length > 1) {
    console.log("⚠ 四家盘方看到的源 IP 不一致：" + seen.join(" / "));
    console.log(
      "  说明本机有多个出口（分流规则、多网卡、VPN 部分接管）。白名单是按单一源 IP 授权的，\n" +
        "  这种状态下无论填哪个都会时通时不通 —— 先把出口收敛成一个再切。"
    );
  } else if (meta.egress && meta.egress.v4) {
    // 全 OK 时盘方不回显 IP，只能用本地探测值。
    console.log("逐字比对：四家盘方后台的 IP Address 应等于本地出口 " + meta.egress.v4);
    console.log("  （本次没有被拒记录，所以拿不到盘方回显的源 IP；被拒时它会直接告诉你。）");
  }
  if (meta.egress && meta.egress.v6 && results.some((r) => /A\+AAAA\(v\)/.test(r.dns))) {
    console.log(
      "⚠ 本机有 IPv6 出口，且盘方域名 A/AAAA 齐备、解析顺序为 verbatim —— undici 可能走\n" +
        "  IPv6 出口，而白名单往往只有 IPv4（DEPLOY.md:87-90）。若出现时通时不通，给 Node\n" +
        "  加 --dns-result-order=ipv4first，或关掉 IPv6 出口。"
    );
  }

  const code = exitCodeOf(results);
  console.log("");
  console.log("退出码 : " + code + "  —— " + EXIT_NOTE[code]);
  for (const k of ["DENIED", "NET", "API", "BADJSON"]) {
    if (counts[k]) console.log("  " + k + " = " + STATUS_NOTE[k]);
  }
}

const EXIT_NOTE = {
  0: "全部通过，允许 systemctl start",
  2: "有公司被拒绝，【不要启动服务】——先把白名单改对（DEPLOY.md 2.3）",
  3: "网络/业务层失败，不是白名单；可重试，先排 IPv6、DNS、防火墙",
  4: "没测起来（环境或参数错）",
};

function exitCodeOf(results) {
  if (!results.length) return 4;
  if (results.every((r) => r.status === "SKIP")) return 4;
  if (results.some((r) => r.status === "DENIED")) return 2;
  if (results.some((r) => r.status !== "OK" && r.status !== "SKIP")) return 3;
  if (results.some((r) => r.status === "SKIP")) return 3;
  return 0;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbFile = dbPath();

  let db;
  let driver;
  try {
    ({ db, driver } = openReadonly(dbFile));
  } catch (err) {
    fail(
      "打不开数据库：" +
        dbFile +
        "\n  " +
        (err && err.message ? err.message : String(err)) +
        "\n  VPS 上要显式给 TRADER_DB=/var/lib/trader-dashboard/trader.db"
    );
  }

  let rows;
  try {
    rows = loadCompanies(db, opts.ids);
  } catch (err) {
    fail("读 companies 表失败：" + (err && err.message ? err.message : String(err)));
  }
  if (!rows.length) fail("companies 表里没有任何公司");

  const egress = opts.egress
    ? {
        v4: await egressIp(4, EGRESS_TIMEOUT_MS),
        v6: await egressIp(6, EGRESS_TIMEOUT_MS),
      }
    : null;

  // 串行：四家共用盘方 edge，并发探测会让 NET 类失败更难归因，而且总耗时本来就只有几秒。
  const results = [];
  for (const row of rows) {
    const dnsInfo = await dnsFacts(row.api_url);
    const outcome = await probe(row, opts);
    results.push({
      id: row.id,
      name: row.name,
      enabled: Number(row.enabled) === 1,
      accessId: String(row.access_id || "").trim(),
      token: maskToken(row.access_token),
      dns: dnsInfo.label,
      host: dnsInfo.host,
      ...outcome,
    });
  }

  const meta = { dbFile, driver, timeoutMs: opts.timeoutMs, module: opts.module, egress };
  if (opts.json) {
    console.log(JSON.stringify({ meta, results, exitCode: exitCodeOf(results) }, null, 2));
  } else {
    renderTable(results, meta);
  }
  finish(exitCodeOf(results), db);
}

// 退出码是本脚本对调用方的唯一契约（0 才允许 systemctl start），所以退出方式不能马虎：
// **不用 process.exit()**。强杀事件循环时 undici 尚未关闭的 socket 会让 libuv 在 Windows 上
// 断言失败（Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76），
// 进程以 0xC0000409 收场，把真正的退出码冲掉 —— 闸门就成了假的。
// 改为设 process.exitCode 并主动释放资源，让事件循环自然排空。
// 配合每个请求的 `connection: close`，正常情况下进程立即退出。
function finish(code, db) {
  process.exitCode = code;
  if (db) {
    try {
      db.close();
    } catch {
      /* 只读句柄，关不掉也不影响退出码 */
    }
  }
}

main().catch((err) => {
  console.error("[check-api-access] 未预期的错误：" + (err && err.stack ? err.stack : String(err)));
  process.exitCode = 4;
});
