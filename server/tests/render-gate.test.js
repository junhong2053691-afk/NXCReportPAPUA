// 支付渠道页每 5 秒的后台刷新：数据没变就不重绘。
//
// 2026-11-06 员工演练（4/4）：流水表约每 5 秒整表重绘，按钮在点下去之前被替换（点击落空）、
// 行内下拉位置跳。refreshSharedWorkspace 无条件地 renderTabs / renderSheet / renderDailyPanels，
// 哪怕数据一个字没变。规则：**只有后台轮询**按数据签名跳过重绘；员工自己触发的加载（保存、
// 切日期、切渠道）照常每次都画——保存后要把编辑行换回只读行，数据相同也不能跳。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRenderGate } = require("../../public/js/render-gate");

test("同一份数据第二次：不用重画", () => {
  const gate = createRenderGate();
  assert.equal(gate.changed("sheet", { rows: [{ id: 1, amount_in: 10 }] }), true);
  assert.equal(gate.changed("sheet", { rows: [{ id: 1, amount_in: 10 }] }), false);
});

test("任何一个值变了：要重画", () => {
  const gate = createRenderGate();
  gate.changed("sheet", { date: "2026-11-06", rows: [{ id: 1, amount_in: 10 }] });
  assert.equal(gate.changed("sheet", { date: "2026-11-06", rows: [{ id: 1, amount_in: 11 }] }), true);
  assert.equal(gate.changed("sheet", { date: "2026-11-05", rows: [{ id: 1, amount_in: 11 }] }), true);
});

test("不同的 key 各算各的", () => {
  const gate = createRenderGate();
  gate.changed("banks", [1]);
  assert.equal(gate.changed("report", [1]), true);
  assert.equal(gate.changed("banks", [1]), false);
});

test("remember 只记不判：前台画过之后，后台拿到同一份数据就跳过", () => {
  const gate = createRenderGate();
  gate.remember("sheet", { rows: [1] });
  assert.equal(gate.changed("sheet", { rows: [1] }), false);
});

test("页面接入：后台刷新走 background，前台加载不跳过", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../public/js/bank-ledger.js"), "utf8");
  const start = src.indexOf("function refreshSharedWorkspace(");
  const body = src.slice(start, src.indexOf("\n  }\n", start));
  assert.match(body, /loadBanks\(\{ background: true \}\)/);
  assert.match(body, /loadSheet\(\{ background: true \}\)/);
  assert.match(body, /loadDailyReport\(\{ background: true \}\)/);
  const page = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
  const gate = page.indexOf("/js/render-gate.js");
  assert.ok(gate > 0 && gate < page.indexOf("/js/bank-ledger.js?"), "render-gate.js 要在 bank-ledger.js 之前加载");
});
