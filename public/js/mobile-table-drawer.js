// 手机（≤700）宽表 → 卡片 + 底部抽屉。
//
// 报表页的表格 8–18 列，360 宽的手机上原来只能左右滑。现在每行收成一张小卡片，只露出
// 规格里点名的几列；点卡片从底部拉起抽屉，按「表头：值」竖着列出这一行的全部字段。
// 决定见 .scratch/ui-responsive/decisions.md「增量决定 · 宽表抽屉」。
//
// 用法：在 server/index.js 的 <table> 上写 data-m="lead:1 title:2 metric:6,14 meta:3 native:tr[data-month]"
//   lead    卡片左侧的小号列（排名）          title   卡片标题（姓名 / 日期 / 动作）
//   meta    标题下一行的灰色小字，用 · 隔开    metric  一行一个「表头 ……… 值」
//   列号从 1 起、按表头的列算（行里有 colspan 会自动对齐），负数从末尾数。
//   native  行本身有动作的表（点进月份、开推荐人抽屉）：命中这个选择器的行点了照旧走原动作。
//
// 几条约束：
//   - 页面脚本的渲染一行不改：只在 td 上加 data-m / data-m-label 两个属性（MutationObserver
//     跟着重渲染补），卡片样式全在 style.css。属性变化不触发 childList，不会自激。
//   - 抽屉内容是点开那一刻的克隆。克隆里的链接 / 按钮点了会转发给原表格里对应的那个元素
//     （顾客详情、操作历史详情都是挂在表格上的委托事件，克隆收不到）。
//   - td 上的 translate="no" 跟着带进抽屉：租户数据不能被 i18n 引擎翻译。切语言时直接关抽屉
//     （克隆的是当时语言的文字，引擎「永远从中文原文翻译」认不出它）。

const MTD_QUERY = "(max-width: 700px)";
const MTD_ROLES = ["title", "metric", "meta", "lead"]; // 一格只拿一个角色，按这个优先级
const MTD_INTERACTIVE = "a[href], button, .customer-link, [data-ref-type], [data-event-id]";

function mtdParseSpec(str) {
  const spec = { lead: [], title: [], meta: [], metric: [], native: "" };
  String(str || "").trim().split(/\s+/).forEach(function (part) {
    const i = part.indexOf(":");
    if (i <= 0) return;
    const key = part.slice(0, i);
    const val = part.slice(i + 1);
    if (key === "native") { spec.native = val; return; }
    if (!Object.prototype.hasOwnProperty.call(spec, key)) return;
    spec[key] = val.split(",").map(Number).filter(function (n) { return Number.isInteger(n) && n !== 0; });
  });
  return spec;
}

/** 表头（可多层、带 rowspan / colspan）→ 每一列的名字。rows: [[{ text, colspan, rowspan }]] */
function mtdHeaderLabels(rows) {
  const grid = [];
  (rows || []).forEach(function (cells, r) {
    grid[r] = grid[r] || [];
    let c = 0;
    cells.forEach(function (cell) {
      while (grid[r][c]) c += 1;
      const cs = Math.max(1, Number(cell.colspan) || 1);
      const rs = Math.max(1, Number(cell.rowspan) || 1);
      for (let dr = 0; dr < rs; dr += 1) {
        grid[r + dr] = grid[r + dr] || [];
        for (let dc = 0; dc < cs; dc += 1) grid[r + dr][c + dc] = cell;
      }
      c += cs;
    });
  });
  const width = grid.reduce(function (w, row) { return Math.max(w, row.length); }, 0);
  const labels = [];
  for (let c = 0; c < width; c += 1) {
    const parts = [];
    grid.forEach(function (row) {
      const cell = row[c];
      if (cell && parts[parts.length - 1] !== cell) parts.push(cell);
    });
    labels.push(parts.map(function (p) { return String(p.text || "").trim(); }).filter(Boolean).join(" · "));
  }
  return labels;
}

/** 一行各格的 colspan → 各格起始列号（0 起）。 */
function mtdCellColumns(spans) {
  const out = [];
  let c = 0;
  (spans || []).forEach(function (s) { out.push(c); c += Math.max(1, Number(s) || 1); });
  return out;
}

/** 规格 + 一行各格的 colspan → 各格角色（或 null）。 */
function mtdAssignRoles(spec, spans) {
  const starts = mtdCellColumns(spans);
  const width = starts.length ? starts[starts.length - 1] + Math.max(1, Number(spans[spans.length - 1]) || 1) : 0;
  const roles = spans.map(function () { return null; });
  const cellAt = function (col) {
    for (let i = 0; i < starts.length; i += 1) {
      const end = starts[i] + Math.max(1, Number(spans[i]) || 1);
      if (col >= starts[i] && col < end) return i;
    }
    return -1;
  };
  MTD_ROLES.forEach(function (role) {
    (spec[role] || []).forEach(function (n) {
      const col = n > 0 ? n - 1 : width + n;
      const i = cellAt(col);
      if (i >= 0 && !roles[i]) roles[i] = role;
    });
  });
  return roles;
}

// ── 浏览器 ──────────────────────────────────────────────────────────────

function mtdTableLabels(table) {
  const rows = Array.from(table.tHead ? table.tHead.rows : []).map(function (tr) {
    return Array.from(tr.cells).map(function (th) {
      return { text: th.textContent, colspan: th.colSpan, rowspan: th.rowSpan };
    });
  });
  return mtdHeaderLabels(rows);
}

function mtdBodyRows(table) {
  const out = [];
  Array.from(table.tBodies).concat(table.tFoot ? [table.tFoot] : []).forEach(function (sec) {
    Array.from(sec.rows).forEach(function (tr) { out.push(tr); });
  });
  return out;
}

// 值没变就不写，免得每次重渲染都产生一串属性变更
function mtdSetAttr(el, name, value) {
  if (value == null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

function mtdDecorate(table) {
  const spec = mtdParseSpec(table.getAttribute("data-m"));
  const labels = mtdTableLabels(table);
  const width = labels.length;
  mtdBodyRows(table).forEach(function (tr) {
    const cells = Array.from(tr.cells);
    // 一格横跨整行：空状态 / 加载中 / 「显示更多」——不是数据行，不做卡片、不能点
    if (cells.length === 1 && (cells[0].colSpan >= width || width <= 1)) {
      if (tr.getAttribute("data-m-row") !== "note") tr.setAttribute("data-m-row", "note");
      return;
    }
    if (tr.hasAttribute("data-m-row")) tr.removeAttribute("data-m-row");
    const spans = cells.map(function (td) { return td.colSpan; });
    const roles = mtdAssignRoles(spec, spans);
    const starts = mtdCellColumns(spans);
    const rowWidth = spans.reduce(function (s, n) { return s + Math.max(1, n); }, 0);
    cells.forEach(function (td, i) {
      const role = roles[i];
      mtdSetAttr(td, "data-m", role);
      mtdSetAttr(td, "data-m-label", role === "metric" ? labels[starts[i]] || "" : null);
      // 卡片里按规格写的先后排，不按表格列序；meta 之间的「·」只加在第二个起
      let idx = -1;
      if (role) {
        const end = starts[i] + Math.max(1, td.colSpan);
        idx = spec[role].findIndex(function (n) {
          const col = n > 0 ? n - 1 : rowWidth + n;
          return col >= starts[i] && col < end;
        });
      }
      mtdSetAttr(td, "data-m-o", role ? String(Math.max(0, idx)) : null);
      mtdSetAttr(td, "data-m-sep", role === "meta" && idx > 0 ? "1" : null);
    });
  });
}

function mtdSetupTables() {
  const tables = Array.from(document.querySelectorAll("table[data-m]"));
  tables.forEach(function (table) {
    mtdDecorate(table);
    let queued = false;
    const observer = new MutationObserver(function () {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(function () { queued = false; mtdDecorate(table); });
    });
    observer.observe(table, { childList: true, subtree: true });
  });
  // 表头文字跟着语言变，metric 的标签要重算
  window.addEventListener("language-changed", function () { tables.forEach(mtdDecorate); });
  return tables;
}

function mtdCreateSheet() {
  const layer = document.createElement("div");
  layer.className = "m-sheet-layer";
  layer.hidden = true;
  layer.innerHTML =
    '<button type="button" class="m-sheet-backdrop" tabindex="-1" aria-label="关闭"></button>' +
    '<section class="m-sheet" role="dialog" aria-modal="true" aria-labelledby="m-sheet-title">' +
    '<header class="m-sheet-head"><span class="m-sheet-grip" aria-hidden="true"></span>' +
    '<h2 class="m-sheet-title" id="m-sheet-title"></h2>' +
    '<button type="button" class="m-sheet-close icon-btn" aria-label="关闭">×</button></header>' +
    '<dl class="m-sheet-body"></dl></section>';
  document.body.appendChild(layer);
  return layer;
}

function startMobileTableDrawer() {
  if (!document.querySelector("table[data-m]")) return;
  const mq = typeof window.matchMedia === "function" ? window.matchMedia(MTD_QUERY) : null;
  mtdSetupTables();
  const layer = mtdCreateSheet();
  const titleEl = layer.querySelector(".m-sheet-title");
  const bodyEl = layer.querySelector(".m-sheet-body");
  let forward = new WeakMap(); // 克隆里的可点元素 → 原表格里的那个
  let lastFocus = null;

  function cloneInto(target, td) {
    Array.from(td.childNodes).forEach(function (n) { target.appendChild(n.cloneNode(true)); });
    if (td.getAttribute("translate") === "no") target.setAttribute("translate", "no");
    target.querySelectorAll("[id]").forEach(function (el) { el.removeAttribute("id"); });
    const originals = td.querySelectorAll(MTD_INTERACTIVE);
    target.querySelectorAll(MTD_INTERACTIVE).forEach(function (el, i) { if (originals[i]) forward.set(el, originals[i]); });
    if (!target.textContent.trim() && !target.querySelector("img, svg")) target.textContent = "—";
  }

  function open(table, tr) {
    forward = new WeakMap();
    titleEl.textContent = "";
    titleEl.removeAttribute("translate");
    bodyEl.textContent = "";
    const labels = mtdTableLabels(table);
    const cells = Array.from(tr.cells);
    const starts = mtdCellColumns(cells.map(function (td) { return td.colSpan; }));
    const titleCell = cells.find(function (td) { return td.getAttribute("data-m") === "title"; }) || cells[0];
    if (titleCell) cloneInto(titleEl, titleCell);
    cells.forEach(function (td, i) {
      if (td === titleCell) return;
      const row = document.createElement("div");
      row.className = "m-sheet-row";
      const dt = document.createElement("dt");
      dt.textContent = labels[starts[i]] || "";
      const dd = document.createElement("dd");
      cloneInto(dd, td);
      row.append(dt, dd);
      bodyEl.appendChild(row);
    });
    lastFocus = document.activeElement;
    layer.hidden = false;
    document.body.classList.add("m-sheet-open");
    bodyEl.scrollTop = 0;
    const closeBtn = layer.querySelector(".m-sheet-close");
    if (closeBtn) closeBtn.focus({ preventScroll: true });
  }

  function close() {
    if (layer.hidden) return;
    layer.hidden = true;
    document.body.classList.remove("m-sheet-open");
    bodyEl.textContent = "";
    if (lastFocus && typeof lastFocus.focus === "function" && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
    lastFocus = null;
  }

  document.addEventListener("click", function (e) {
    if (!mq || !mq.matches || e.defaultPrevented) return;
    if (!(e.target instanceof Element)) return;
    const tr = e.target.closest("table[data-m] > tbody > tr, table[data-m] > tfoot > tr");
    if (!tr || tr.getAttribute("data-m-row") === "note") return;
    if (e.target.closest(MTD_INTERACTIVE + ", input, select, textarea, label")) return; // 格子里自己的链接 / 按钮照旧
    const table = tr.closest("table");
    const spec = mtdParseSpec(table.getAttribute("data-m"));
    if (spec.native && tr.matches(spec.native)) return; // 行本身有动作
    open(table, tr);
  });

  layer.addEventListener("click", function (e) {
    if (e.target.closest(".m-sheet-backdrop, .m-sheet-close")) { close(); return; }
    const el = e.target.closest(MTD_INTERACTIVE);
    if (!el || !bodyEl.contains(el) && !titleEl.contains(el)) return;
    const original = forward.get(el);
    e.preventDefault();
    close();
    if (original && original.isConnected) original.click();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !layer.hidden) { e.preventDefault(); close(); }
  });
  window.addEventListener("language-changed", close);
  if (mq && typeof mq.addEventListener === "function") {
    mq.addEventListener("change", function () { if (!mq.matches) close(); });
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startMobileTableDrawer);
  else startMobileTableDrawer();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parseSpec: mtdParseSpec,
    headerLabels: mtdHeaderLabels,
    cellColumns: mtdCellColumns,
    assignRoles: mtdAssignRoles,
  };
}
