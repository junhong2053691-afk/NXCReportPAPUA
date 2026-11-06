// 新建渠道保存后，流水表的渠道筛选不能被悄悄换成新户。
//
// 2026-11-06 员工演练（4/4 家）：建完 TEST 户口后流水表自动只显示这个新户（「当天暂无流水」），
// KPI 入账/出账变 0；调钱弹窗又会预选「当前筛选的户口」，于是默认 BANK 也成了新户，
// 不注意就把调钱绑到刚建的空户口上。筛选只能由员工自己点渠道来改。
//
// saveBankModal 是 DOM 代码，这里按源码守：它的函数体里不许再给 activeBankId 赋值。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "../../public/js/bank-accounts.js"), "utf8");

function functionBody(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `找不到 ${name}`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} 没闭合`);
}

test("新建 / 编辑渠道保存后不改流水的渠道筛选", () => {
  assert.doesNotMatch(functionBody("saveBankModal"), /activeBankId\s*=(?!=)/);
});

test("调钱弹窗仍按员工自己选的筛选预选户口（不是新建时被动切过去的）", () => {
  assert.match(functionBody("openTransferModal"), /activeBankId !== ALL_BANKS/);
});
