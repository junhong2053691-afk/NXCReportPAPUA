// 拆分调钱弹窗「一批」的前端校验（public/js/split-allocation.js），规则与后端 help_split 同口径，
// 见 CONTEXT.md「拆分调钱」。后端另有 split-partial.test.js 守着真正的落账。
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeSplitAllocation } = require("../../public/js/split-allocation");

const run = (o) => computeSplitAllocation({ remaining: 1000, balances: { 1: 1000, 2: 100 }, ...o });

test("全部自家户口付满：valid，不是分批，提交 self_rows", () => {
  const s = run({ selfRows: [{ bank_account_id: "1", amount: "600" }, { bank_account_id: "2", amount: "400" }] });
  assert.equal(s.valid, true);
  assert.equal(s.partial, false);
  assert.equal(s.error, "");
  assert.deepEqual(s.body, { self_rows: [{ bank_account_id: 1, amount: 600 }, { bank_account_id: 2, amount: 400 }], splits: [] });
});

test("少于还差就是分批付：valid + 提示付完还差多少", () => {
  const s = run({ selfRows: [{ bank_account_id: "1", amount: "100" }, { bank_account_id: "2", amount: "100" }] });
  assert.equal(s.valid, true);
  assert.equal(s.partial, true);
  assert.equal(s.info, "付完这批还差 800.00");
});

test("超过还差：不能提交", () => {
  const s = run({ selfRows: [{ bank_account_id: "1", amount: "1000.01" }] });
  assert.equal(s.valid, false);
  assert.equal(s.error, "超出 0.01");
});

test("空白行忽略；一行都没有不能提交", () => {
  const s = run({ selfRows: [{ bank_account_id: "", amount: "" }], helperRows: [{ c_status: "", amount: "" }] });
  assert.equal(s.valid, false);
  assert.equal(s.error, "请至少填写 1 个自付户口或协助方");
  assert.equal(s.selfView[0].blank, true);
});

test("半填的行挡住提交：有户口没金额、有金额没户口、协助方缺 C STATUS", () => {
  assert.equal(run({ selfRows: [{ bank_account_id: "1", amount: "" }] }).error, "请填写每个自付户口和金额");
  assert.equal(run({ selfRows: [{ bank_account_id: "", amount: "50" }] }).error, "请填写每个自付户口和金额");
  assert.equal(run({ helperRows: [{ c_status: "", amount: "50" }] }).error, "请填写每个协助方和金额");
});

test("一批最多 10 个不同户口；同一户口多行只算一个", () => {
  const eleven = Array.from({ length: 11 }, (_, i) => ({ bank_account_id: String(i + 1), amount: "10" }));
  assert.equal(run({ selfRows: eleven }).error, "一次最多 10 个不同的自付户口");
  const sameTwice = [...eleven.slice(0, 10), { bank_account_id: "1", amount: "10" }];
  assert.equal(run({ selfRows: sameTwice }).valid, true);
});

test("余额 · 付后：同户口逐行累减，付后 < 0 标红但照样可以提交（余额不拦）", () => {
  const s = run({
    selfRows: [
      { bank_account_id: "2", amount: "60" },
      { bank_account_id: "2", amount: "60" },
      { bank_account_id: "1", amount: "100" },
    ],
  });
  assert.deepEqual(s.selfView.map((v) => [v.balance, v.after, v.negative]), [
    [100, 40, false],
    [100, -20, true],
    [1000, 900, false],
  ]);
  assert.equal(s.valid, true);
});

test("自付与协助方混着填；金额带千分位逗号也认", () => {
  const s = run({
    selfRows: [{ bank_account_id: "1", amount: "700" }],
    helperRows: [{ c_status: "RX66", amount: "300" }],
  });
  assert.deepEqual(s.body.splits, [{ c_status: "RX66", amount: 300 }]);
  assert.equal(s.partial, false);
  assert.equal(computeSplitAllocation({ remaining: 1500, selfRows: [{ bank_account_id: "1", amount: "1,500" }] }).valid, true);
});
