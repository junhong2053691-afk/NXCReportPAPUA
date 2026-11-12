// 调钱弹窗组装提交数据（bank-ledger.js 的 buildTransferBody）。
//
// 两户互转（CONTEXT.md）：STATUS 选 bank trf 时，原来的 BANK 框就是「从」，另有「到」框；
// 提交时带 to_bank_account_id、C STATUS 一律清空（框被藏起来，但员工可能之前填过）。
// 其它 STATUS 不带「到」，照旧带 C STATUS。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function loadBuildTransferBody() {
  const src = fs.readFileSync(path.join(__dirname, "../../public/js/bank-ledger.js"), "utf8");
  const start = src.indexOf("function buildTransferBody(");
  assert.ok(start > 0, "bank-ledger.js 里要有 buildTransferBody");
  const fn = src.slice(start, src.indexOf("\n  }\n", start) + 4);
  return new Function(`${fn}; return buildTransferBody;`)();
}

const form = (extra = {}) => ({
  status: "bank trf", cStatus: "RX66", bankId: "3", toBankId: "7",
  entryTime: "2026-11-12 10:00:00", name: " Amy ", remark: " 挪钱 ", ...extra,
});
const out = { direction: "out", magnitudeText: "500" };

test("bank trf：带「从」「到」，C STATUS 清空", () => {
  const body = loadBuildTransferBody()(out, form());
  assert.deepEqual(body, {
    direction: "out", status: "bank trf", c_status: "", amount: "500",
    bank_account_id: 3, to_bank_account_id: 7,
    entry_time: "2026-11-12 10:00:00", name: "Amy", remark: "挪钱",
  });
});

test("其它 STATUS：不带「到」，照旧带 C STATUS", () => {
  const body = loadBuildTransferBody()(out, form({ status: "cash out" }));
  assert.equal(body.c_status, "RX66");
  assert.equal(body.bank_account_id, 3);
  assert.equal("to_bank_account_id" in body, false);
});

test("REDEP：不绑银行，即使员工先选过 BANK 也发 null", () => {
  const body = loadBuildTransferBody()(out, form({ status: "redeposit" }));
  assert.equal(body.status, "redeposit");
  assert.equal(body.bank_account_id, null);
  assert.equal("to_bank_account_id" in body, false);
});

test("没选 BANK 时 bank_account_id 是 null", () => {
  const body = loadBuildTransferBody()(out, form({ status: "cash out", bankId: "" }));
  assert.equal(body.bank_account_id, null);
});
