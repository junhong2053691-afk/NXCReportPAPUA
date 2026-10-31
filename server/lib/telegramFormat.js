// Telegram 消息排版工具。纯函数、零依赖，唯一的一份。
//
// 为什么要有这个模块：Telegram 正文用的是比例字体，靠空格「假对齐」在手机上一定歪。
// 唯一能真正对齐的办法是 HTML parse_mode 的 <pre> 等宽块，而一旦进了等宽块，补白就
// 必须按**显示宽度**算而不是 String.length —— 中文一个字占两格。
//
// 三条约定，调用方必须遵守：
//   1. 渲染过程中一路用**原文**（不转义），只在 pre() / esc() 这两个出口做转义。
//      反过来先转义再补白会把 `&amp;` 当 5 格宽，中文和 & 一混就全歪。
//   2. <pre> 内部的 emoji 只准放在**行尾**。emoji 的等宽宽度各平台不一致，放中间会
//      把后面的列顶歪；放行尾后面没有内容，不影响任何对齐。
//   3. 每个消息块必须自带成对闭合的 <pre>。telegram.chunkMessage 在块装不下时会按行
//      切，切在 <pre> 中间 Telegram 直接返回 400，整条消息发不出去。

// 手机上 <pre> 不横向滚动的安全宽度。超过这个宽度 Telegram 会给 pre 块加横向滚动，
// 虽然仍然对齐但要划一下才看得全，所以窄表一律钳到这里。
const TABLE_MAX_WIDTH = 34;

// 零宽：组合符、变体选择符（⚠️ 的 U+FE0F）、方向标记。算 1 格会把带 emoji 的行顶歪。
const ZERO_WIDTH = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
];

// 双宽：East Asian Wide / Fullwidth，外加 emoji 面。JS 的正则不支持
// \p{East_Asian_Width}，只能自己列区间。
const WIDE = [
  [0x1100, 0x115f], // Hangul Jamo 初声
  [0x2e80, 0x303e], // CJK 部首、康熙、CJK 标点（含【】〔〕、，。）
  [0x3041, 0x33ff], // 平假名 … CJK 兼容
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 基本区
  [0xa000, 0xa4cf], // 彝文
  [0xa960, 0xa97f], // Hangul Jamo 扩展 A
  [0xac00, 0xd7a3], // 韩文音节
  [0xf900, 0xfaff], // CJK 兼容表意
  [0xfe10, 0xfe19], // 竖排形式
  [0xfe30, 0xfe6f], // CJK 兼容形式、小写变体
  [0xff00, 0xff60], // 全角形式
  [0xffe0, 0xffe6], // 全角符号
  [0x1f300, 0x1f64f], // emoji（符号与象形、表情）
  [0x1f680, 0x1f6ff], // emoji（交通与地图）
  [0x1f900, 0x1f9ff], // emoji（补充象形）
  [0x20000, 0x3fffd], // CJK 扩展 B 及以后
];

function inRanges(cp, ranges) {
  for (const [lo, hi] of ranges) {
    if (cp >= lo && cp <= hi) return true;
    if (cp < lo) return false; // 区间表有序，早退
  }
  return false;
}

function charWidth(cp) {
  if (cp < 0x20) return 0; // 控制字符（含 \n，调用方按行处理，不该走到这里）
  if (cp < 0x7f) return 1; // ASCII 快路径
  if (inRanges(cp, ZERO_WIDTH)) return 0;
  return inRanges(cp, WIDE) ? 2 : 1;
}

/** 等宽字体下占几格。中文 2 格，变体选择符 0 格。 */
function displayWidth(text) {
  let w = 0;
  for (const ch of String(text == null ? "" : text)) w += charWidth(ch.codePointAt(0));
  return w;
}

/** 按显示宽度截断，超了尾部换成 …（1 格）。按 code point 走，不会切开代理对。 */
function truncateToWidth(text, maxWidth) {
  const s = String(text == null ? "" : text);
  const limit = Math.max(1, Number(maxWidth) || 0);
  if (displayWidth(s) <= limit) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > limit - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

function padEndWidth(text, width) {
  const s = String(text == null ? "" : text);
  return s + " ".repeat(Math.max(0, width - displayWidth(s)));
}

function padStartWidth(text, width) {
  const s = String(text == null ? "" : text);
  return " ".repeat(Math.max(0, width - displayWidth(s))) + s;
}

/** 分隔线。─（U+2500）在等宽字体里是 1 格。 */
function divider(width) {
  return "─".repeat(Math.max(1, Number(width) || 1));
}

// Telegram HTML 模式只要求转义这三个字符。相比 Markdown 需要躲 `_ * [` ~ 等一长串、
// 且转义规则随 v1/v2 变化，这是能选的最小攻击面。
function escapeHtml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 去掉标签并反转义，退回纯文本。
 *
 * 用途只有一个：sendMessage 在 Telegram 报 "can't parse entities" 时降级重发。
 * 报警消息掉一条就等于那个账户被永久静音（alert_fired_at 已置位），所以不能只靠
 * 「我们转义对了」这个假设。
 */
function stripHtml(text) {
  return String(text == null ? "" : text)
    .replace(/<\/?(?:pre|code|b|i|u|s|a)(?:\s[^>]*)?>/gi, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** 把若干**原文**行包成一个等宽块，顺便转义。 */
function pre(lines) {
  const body = (Array.isArray(lines) ? lines : [lines]).join("\n");
  return "<pre>" + escapeHtml(body) + "</pre>";
}

/**
 * 渲染一张等宽表。
 *
 * @param {Array} rows  每行是下面三种之一：
 *   - `{ raw: "运营中" }`      原样输出，不参与列宽计算（分组标题、说明行）
 *   - `{ divider: true }`      输出一整行分隔线，宽度等于表宽
 *   - `{ 列key: 值, flag?: "⚠️" }`  数据行；flag 拼在行尾，**不占宽度预算**
 * @param {Array} columns  `[{ key, align: "left"|"right", min?, max? }]`
 *                         列宽取该列最长值，left 列在总宽超限时优先被压缩。
 * @param {object} opts    `{ gap = 2, maxWidth = TABLE_MAX_WIDTH }`
 * @returns {{ lines: string[], width: number }}
 */
function renderTable(rows, columns, opts = {}) {
  const gap = opts.gap === undefined ? 2 : Number(opts.gap);
  const maxWidth = Number(opts.maxWidth || TABLE_MAX_WIDTH);
  const dataRows = rows.filter((r) => r && r.raw === undefined && !r.divider);

  const widths = columns.map((col) => {
    let w = 0;
    for (const row of dataRows) w = Math.max(w, displayWidth(row[col.key]));
    if (col.max) w = Math.min(w, col.max);
    if (col.min) w = Math.max(w, col.min);
    return w;
  });

  // 总宽超限：从左往右压缩 left 列（渠道名可以截断，金额绝不能）。
  const gaps = gap * Math.max(0, columns.length - 1);
  let over = widths.reduce((s, w) => s + w, 0) + gaps - maxWidth;
  for (let i = 0; over > 0 && i < columns.length; i++) {
    if (columns[i].align === "right") continue;
    const floor = columns[i].min || 6;
    const cut = Math.min(over, Math.max(0, widths[i] - floor));
    widths[i] -= cut;
    over -= cut;
  }

  const width = widths.reduce((s, w) => s + w, 0) + gaps;
  const pad = " ".repeat(gap);
  const lines = [];
  for (const row of rows) {
    if (!row) continue;
    if (row.raw !== undefined) {
      lines.push(String(row.raw));
      continue;
    }
    if (row.divider) {
      lines.push(divider(width));
      continue;
    }
    const cells = columns.map((col, i) => {
      const text = truncateToWidth(row[col.key] == null ? "" : row[col.key], widths[i]);
      return col.align === "right" ? padStartWidth(text, widths[i]) : padEndWidth(text, widths[i]);
    });
    // 行尾不留补白：空的末列会拖出一串看不见的空格，复制出去很脏。
    const flag = row.flag ? " " + row.flag : "";
    lines.push(cells.join(pad).replace(/ +$/, "") + flag);
  }
  return { lines, width };
}

module.exports = {
  TABLE_MAX_WIDTH,
  displayWidth,
  truncateToWidth,
  padEndWidth,
  padStartWidth,
  divider,
  escapeHtml,
  stripHtml,
  pre,
  renderTable,
};
