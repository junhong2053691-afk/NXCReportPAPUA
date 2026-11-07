// 登录旋转验证码：点「登录」后弹窗，拖滑块把歪着的手指转到朝上。
//
// 角度只存在服务端：图在这里用 resvg（github.com/yisibl/resvg-js，WASM 版，无原生编译）
// 栅格化成 PNG 再发出去，前端拿到的是像素，不是带 rotate() 的 SVG——否则脚本读一下 DOM
// 就知道答案。手的图形是 lucide 的 pointer 图标（项目已在用，ISC 协议）。
//
// 题目存进程内 Map 而不是 session：session 是 saveUninitialized:false + SQLite 持久化，
// 匿名访客每取一张图就会往 sessions.db 写一行，可以被刷爆。应用本就单实例（见 DEPLOY.md 2.2），
// 重启清空只是让正在登录的人重新拖一次。
//
// 一次性：consume 无论对错都先删掉这道题，否则可以对同一张图逐个角度穷举。

const crypto = require("crypto");
const fs = require("fs");

const TTL_MS = 2 * 60 * 1000;
const MAX_ENTRIES = 10000;
const TOLERANCE_DEG = 12;
const IMAGE_PX = 400; // 前端按 200px 显示，2 倍图在高分屏上不糊
const ISSUE_WINDOW_MS = 60 * 1000;
const MAX_ISSUE_PER_IP = 20;

// lucide 1.65 的 pointer（食指朝上的手），viewBox 0 0 24 24。
const HAND_PATHS = [
  "M22 14a8 8 0 0 1-8 8",
  "M18 11v-1a2 2 0 0 0-2-2a2 2 0 0 0-2 2",
  "M14 10V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1",
  "M10 9.5V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v10",
  "M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15",
];

let resvgReady = null;
function loadResvg() {
  if (!resvgReady) {
    const resvg = require("@resvg/resvg-wasm");
    const wasm = fs.readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm"));
    resvgReady = resvg.initWasm(wasm).then(() => resvg);
  }
  return resvgReady;
}

function rand(min, max) {
  return min + crypto.randomInt(0, 1_000_000) / 1_000_000 * (max - min);
}

function buildSvg(angle) {
  const hue = Math.round(rand(0, 360));
  const noise = [];
  // 干扰：随机色块和曲线。它们本身不带方向信息，只是让「找出手的轮廓再算朝向」没那么省事。
  for (let i = 0; i < 7; i += 1) {
    const h = Math.round(rand(0, 360));
    noise.push(
      `<circle cx="${rand(0, 200).toFixed(1)}" cy="${rand(0, 200).toFixed(1)}" r="${rand(10, 38).toFixed(1)}" ` +
        `fill="hsl(${h},70%,72%)" fill-opacity="${rand(0.25, 0.5).toFixed(2)}"/>`
    );
  }
  for (let i = 0; i < 4; i += 1) {
    const p = () => `${rand(0, 200).toFixed(1)} ${rand(0, 200).toFixed(1)}`;
    noise.push(
      `<path d="M${p()} C${p()},${p()},${p()}" fill="none" stroke="hsl(${Math.round(rand(0, 360))},30%,45%)" ` +
        `stroke-opacity="0.45" stroke-width="${rand(1.5, 3.5).toFixed(1)}" stroke-linecap="round"/>`
    );
  }
  const hand = HAND_PATHS.map((d) => `<path d="${d}"/>`).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">` +
    `<defs><radialGradient id="bg" cx="50%" cy="45%" r="70%">` +
    `<stop offset="0" stop-color="hsl(${hue},60%,94%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},55%,80%)"/>` +
    `</radialGradient></defs>` +
    `<rect width="200" height="200" fill="url(#bg)"/>` +
    noise.join("") +
    `<g transform="translate(100 100) rotate(${angle}) scale(5) translate(-12 -12)" fill="none" ` +
    `stroke-linecap="round" stroke-linejoin="round">` +
    // 白色描边垫底当光晕，背景再花手也看得清。
    `<g stroke="#ffffff" stroke-width="3.6">${hand}</g>` +
    `<g stroke="#1f2937" stroke-width="2">${hand}</g>` +
    `</g></svg>`
  );
}

async function generate() {
  const { Resvg } = await loadResvg();
  // 30°–330°：太接近朝上的题等于白送。
  const angle = Math.round(rand(30, 330));
  const resvg = new Resvg(buildSvg(angle), { fitTo: { mode: "width", value: IMAGE_PX } });
  const rendered = resvg.render();
  const png = Buffer.from(rendered.asPng());
  rendered.free();
  resvg.free();
  return { angle, png };
}

/** 图片被转了 angle 度，用户再转 rotation 度之后离「朝上」差多少（0–180）。 */
function angleError(angle, rotation) {
  const d = (((angle + rotation) % 360) + 360) % 360;
  return Math.min(d, 360 - d);
}

// generate 可注入，测试才拿得到答案、也不用跑 WASM。
function createCaptchaStore(now = Date.now, make = generate) {
  const entries = new Map();
  const issues = new Map();

  function sweep() {
    const t = now();
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= t) entries.delete(id);
    }
    // 全是未过期的说明正在被刷：按插入顺序丢最旧的，宁可丢题也不能让 Map 无限长。
    while (entries.size >= MAX_ENTRIES) {
      entries.delete(entries.keys().next().value);
    }
  }

  /** 出图要栅格化，比校验贵得多：按 IP 限频，免得被刷图拖慢同一进程里的同步。 */
  function allowIssue(ip) {
    const key = String(ip || "");
    const t = now();
    const entry = issues.get(key);
    if (!entry || entry.resetAt <= t) {
      if (issues.size >= MAX_ENTRIES) {
        for (const [k, e] of issues) if (e.resetAt <= t) issues.delete(k);
        if (issues.size >= MAX_ENTRIES) issues.clear();
      }
      issues.set(key, { count: 1, resetAt: t + ISSUE_WINDOW_MS });
      return true;
    }
    if (entry.count >= MAX_ISSUE_PER_IP) return false;
    entry.count += 1;
    return true;
  }

  async function issue() {
    const { angle, png } = await make();
    if (entries.size >= MAX_ENTRIES) sweep();
    const id = crypto.randomBytes(16).toString("hex");
    entries.set(id, { angle, expiresAt: now() + TTL_MS });
    return { id, image: "data:image/png;base64," + Buffer.from(png).toString("base64") };
  }

  /** 校验并作废这道题。转到朝上 ±TOLERANCE_DEG 内返回 true。 */
  function consume(id, rotation) {
    const key = String(id || "");
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    if (entry.expiresAt <= now()) return false;
    const r = Number(rotation);
    if (!Number.isFinite(r) || r < 0 || r > 360) return false;
    return angleError(entry.angle, r) <= TOLERANCE_DEG;
  }

  return { issue, consume, allowIssue, size: () => entries.size };
}

module.exports = {
  createCaptchaStore,
  angleError,
  TTL_MS,
  MAX_ENTRIES,
  TOLERANCE_DEG,
  MAX_ISSUE_PER_IP,
};
