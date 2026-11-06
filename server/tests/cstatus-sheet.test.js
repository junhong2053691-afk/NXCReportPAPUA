// 手机填 C STATUS 的底部抽屉（public/js/cstatus-sheet.js）。
//
// 2026-11-06：手机上编辑流水、调钱、待处理（调钱 / 拆分协助方）、封禁户转出的 C STATUS 原来是
// datalist 或贴框浮层——前者在 iPhone 上只是键盘上方一排建议，后者会被键盘顶走。改成点开底部抽屉。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { cstatusSheetRows } = require("../../public/js/cstatus-sheet");

const NAMES = ["EZ68", "PK7", "RX66"];
const kinds = (rows) => rows.map((r) => `${r.kind}:${r.value}`);

test("不搜：先「空白」，再全部选项；当前值打勾（不分大小写）", () => {
  const rows = cstatusSheetRows(NAMES, "", "pk7", { allowBlank: true, allowAdd: true });
  assert.deepEqual(kinds(rows), ["blank:", "name:EZ68", "name:PK7", "name:RX66"]);
  assert.deepEqual(rows.filter((r) => r.selected).map((r) => r.value), ["PK7"]);
  assert.equal(cstatusSheetRows(NAMES, "", "", { allowBlank: true })[0].selected, true, "空值时「空白」打勾");
});

test("搜索按片段过滤；搜不到完全一样的才给「+ 使用」", () => {
  assert.deepEqual(kinds(cstatusSheetRows(NAMES, "x6", "", { allowBlank: true, allowAdd: true })), ["name:RX66", "add:x6"]);
  assert.deepEqual(kinds(cstatusSheetRows(NAMES, "ez68", "", { allowAdd: true })), ["name:EZ68"], "大小写不同也算已有");
  assert.deepEqual(kinds(cstatusSheetRows(NAMES, "  NEW1 ", "", { allowAdd: true })), ["add:NEW1"]);
  assert.deepEqual(kinds(cstatusSheetRows(NAMES, "NEW1", "", {})), [], "不允许新增时只剩空列表");
});

test("选项里的空名字丢掉", () => {
  assert.deepEqual(kinds(cstatusSheetRows(["", null, " EZ68 "], "", "", {})), ["name:EZ68"]);
});

test("多家一起填：搜索框整串当一个「+ 使用」（服务端再按 , ; / | 拆）", () => {
  assert.deepEqual(kinds(cstatusSheetRows(NAMES, "EZ68, PK7", "", { allowAdd: true })), ["add:EZ68, PK7"]);
});

test("页面接入：五个输入框都带 data-cstatus-pick，脚本在 bank-accounts.js 之前", () => {
  const page = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
  assert.match(page, /id="trf-cstatus"[^>]*data-cstatus-pick/);
  assert.match(page, /id="drain-cstatus"[^>]*data-cstatus-pick/);
  const at = page.indexOf("/js/cstatus-sheet.js");
  assert.ok(at > 0 && at < page.indexOf("/js/bank-accounts.js?"));
  const src = fs.readFileSync(path.join(__dirname, "../../public/js/bank-accounts.js"), "utf8");
  assert.match(src, /class="pend-cstatus"[^>]*data-cstatus-pick/);
  assert.match(src, /class="pend-split-cstatus"[^>]*data-cstatus-pick/);
  assert.match(src, /f === "c_status"\) attrs \+= " data-cstatus-pick"/, "流水表格的 C STATUS");
  assert.match(src, /window\.openCstatusSheet\(inp, cStatusNames\(\)/, "流水表格在手机上走抽屉");
  assert.match(src, /window\.bindCstatusSheet\?\.\(cStatusNames\)/, "选项每次现取，且不含本公司");
});
