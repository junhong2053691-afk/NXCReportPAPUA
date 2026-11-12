// 交易记录页「选了 cash out 一会儿又跳回 ALL、表格乱跳」（2026-11-12 员工对账反馈）。
//
// 根因：同步每轮 fast lane 都改 sync-status 的 at，startSyncWatcher 若接 reloadAll 就是每 8 秒整页重载，
// populateStatusFilter 重建 STATUS 下拉时把选中值清掉。这里守住三条：
//   1. sync watcher 走后台刷新，不是 reloadAll；
//   2. populateStatusFilter 重建后保留选中值（值消失了才回 ALL）；
//   3. 接单区 BANK 下拉正被操作（聚焦）时不被重写。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "../../public/js/bank-ledger.js"), "utf8");

function extract(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start > 0, `bank-ledger.js 里要有 ${name}`);
  return SRC.slice(start, SRC.indexOf("\n  }\n", start) + 4);
}

// 最小假 select：innerHTML 解析出 option 值，value 只能设成存在的选项（与浏览器一致，否则变空）。
function fakeSelect() {
  let html = "";
  let values = [];
  let value = "";
  return {
    setAttribute() {},
    get innerHTML() { return html; },
    set innerHTML(v) {
      html = v;
      values = [...v.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
      value = values[0] ?? "";
    },
    get value() { return value; },
    set value(v) { value = values.includes(v) ? v : ""; },
    writes: 0,
  };
}

function loadPopulateStatusFilter(sel, statuses) {
  const document = { getElementById: (id) => (id === "sheet-status-filter" ? sel : null) };
  const BC = { statusList: () => statuses.map((s) => ({ value: s, label: s.toUpperCase() })) };
  const esc = (s) => String(s);
  return new Function("document", "BC", "esc", `${extract("populateStatusFilter")}; return populateStatusFilter;`)(document, BC, esc);
}

test("sync watcher 走后台刷新，不是整页 reloadAll", () => {
  const m = SRC.match(/startSyncWatcher\(([^\n]*)\);/);
  assert.ok(m, "要有 startSyncWatcher 调用");
  assert.doesNotMatch(m[1], /reloadAll/);
  assert.match(m[1], /refreshSharedWorkspace/);
});

test("populateStatusFilter 重建后保留选中的 cash out", () => {
  const sel = fakeSelect();
  const populate = loadPopulateStatusFilter(sel, ["deposit", "cash out", "withdraw"]);
  populate();
  sel.value = "cash out";
  populate();
  assert.equal(sel.value, "cash out");
});

test("选中的 STATUS 已不在列表里时回 ALL", () => {
  const sel = fakeSelect();
  let statuses = ["deposit", "cash out"];
  const document = { getElementById: (id) => (id === "sheet-status-filter" ? sel : null) };
  const BC = { statusList: () => statuses.map((s) => ({ value: s, label: s })) };
  const populate = new Function("document", "BC", "esc", `${extract("populateStatusFilter")}; return populateStatusFilter;`)(document, BC, String);
  populate();
  sel.value = "cash out";
  statuses = ["deposit"];
  populate();
  assert.equal(sel.value, "");
});

test("refreshDepositBankSelects 不碰正在操作的下拉，选项没变也不写", () => {
  const mk = (html) => {
    let h = html;
    const s = { writes: 0 };
    Object.defineProperty(s, "innerHTML", { get: () => h, set: (v) => { h = v; s.writes += 1; } });
    return s;
  };
  const focused = mk("<option>old</option>");
  const idle = mk("<option>old</option>");
  const same = mk("<option>new</option>");
  const document = {
    activeElement: focused,
    querySelectorAll: () => [focused, idle, same],
  };
  const fn = new Function("document", "depositBankOptionsHtml",
    `${extract("refreshDepositBankSelects")}; return refreshDepositBankSelects;`)(document, () => "<option>new</option>");
  fn();
  assert.equal(focused.writes, 0, "聚焦中的下拉不能被换掉");
  assert.equal(idle.writes, 1);
  assert.equal(idle.innerHTML, "<option>new</option>");
  assert.equal(same.writes, 0, "选项一样不重写");
});
