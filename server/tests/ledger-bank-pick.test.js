// 流水表保存时 BANK ACC 怎么定。2026-11-06 员工演练：编辑一行「不绑户口」的开销，只改了 OTHER，
// 保存后被绑到下拉第一个户口、余额被扣（rowBankId 空值兜底 usableBanks()[0]）。
// 同一个兜底也会把封禁户的历史行改绑到别的户口——封禁户不在 usableBanks 里，标签永远匹配不上。
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveRowBank, matchBankByLabel } = require("../../public/js/ledger-bank-pick");

const base = { cleared: false, matchedId: null, datasetBankId: 0, datasetLabel: "", activeBankId: 7, firstUsableId: 1 };

test("编辑不绑户口的行、BANK ACC 没动：保留原样（不发 bank_account_id），绝不绑到第一个户口", () => {
  const r = resolveRowBank({ ...base, isExisting: true, text: "", origText: "" });
  assert.deepEqual(r, { mode: "keep" });
});

test("编辑封禁户的历史行、BANK ACC 没动：保留原绑定，不改绑到运营中的户口", () => {
  const r = resolveRowBank({ ...base, isExisting: true, text: "Ubank KRISTY (KRISTY)", origText: "Ubank KRISTY (KRISTY)", datasetBankId: 20 });
  assert.deepEqual(r, { mode: "keep" });
});

test("编辑封禁户的历史行：显示成「1. …」被序号误匹配到第一个运营户，也必须 keep（验证时真实踩到）", () => {
  // 封禁户不在 usableBanks 里，bankAccDisplay 用序号 0 显示成「1. TEST BANK (…)」，
  // 旧的序号前缀匹配把它解析成运营列表第 1 个户口。没改动就不该进匹配。
  const r = resolveRowBank({ ...base, isExisting: true, text: "1. TEST BANK (TEST-RX66-3)", origText: "1. TEST BANK (TEST-RX66-3)", matchedId: 24, datasetBankId: 61 });
  assert.deepEqual(r, { mode: "keep" });
});

test("编辑已有行：从下拉选了别的户口 → 改绑", () => {
  const r = resolveRowBank({ ...base, isExisting: true, text: "2. NAB X", origText: "", matchedId: 3 });
  assert.deepEqual(r, { mode: "set", id: 3 });
});

test("编辑已有行：选「— 空白 —」或手动删光文本 → 解绑", () => {
  assert.deepEqual(resolveRowBank({ ...base, isExisting: true, cleared: true, text: "", origText: "1. NAB" }), { mode: "set", id: 0 });
  assert.deepEqual(resolveRowBank({ ...base, isExisting: true, text: "", origText: "1. NAB", datasetBankId: 5 }), { mode: "set", id: 0 });
});

test("编辑已有行：打了认不出的户口名 → 报错，不静默兜底", () => {
  const r = resolveRowBank({ ...base, isExisting: true, text: "随便打的", origText: "1. NAB" });
  assert.equal(r.mode, "invalid");
});

test("编辑已有行：data-bank-id 对应的标签与文本一致（下拉序号重排后）→ 用 data-bank-id", () => {
  const r = resolveRowBank({ ...base, isExisting: true, text: "3. NAB", origText: "1. NAB", datasetBankId: 5, datasetLabel: "3. nab" });
  assert.deepEqual(r, { mode: "set", id: 5 });
});

const OPTIONS = [
  { id: 24, label: "1. 1. NAB Poili (Poilin Binti)", aliases: ["1. NAB Poilin", "Poilin Binti"] },
  { id: 26, label: "2. 3. ING Trevi (Trevis Uru)", aliases: ["3. ING Trevis", "Trevis Uru"] },
  { id: 25, label: "3. 2. ING john (John)", aliases: ["2. ING john", "John"] },
];

test("标签匹配：只打序号 → 按下拉位置选（键盘快速录入）", () => {
  assert.equal(matchBankByLabel("2", OPTIONS), 26);
  assert.equal(matchBankByLabel("3.", OPTIONS), 25);
});

test("标签匹配：完整下拉标签 → 选中该户口", () => {
  assert.equal(matchBankByLabel("2. 3. ing trevi (trevis uru)", OPTIONS), 26);
});

test("标签匹配：序号开头但其余对不上，不能按序号硬选（封禁户「1. TEST BANK」曾被解析成 NAB）", () => {
  assert.equal(matchBankByLabel("1. TEST BANK (TEST-RX66-3)", OPTIONS), null);
});

test("标签匹配：户名自带编号「2. ING john」→ 按别名选到 ING john，而不是下拉第 2 个", () => {
  assert.equal(matchBankByLabel("2. ING john", OPTIONS), 25);
});

test("标签匹配：空文本 / 序号越界 → null", () => {
  assert.equal(matchBankByLabel("", OPTIONS), null);
  assert.equal(matchBankByLabel("9", OPTIONS), null);
});

test("新增行保持原行为：空文本用当前筛选户口，再退回第一个户口", () => {
  assert.deepEqual(resolveRowBank({ ...base, isExisting: false, text: "", origText: "" }), { mode: "set", id: 7 });
  assert.deepEqual(resolveRowBank({ ...base, isExisting: false, text: "", origText: "", activeBankId: null }), { mode: "set", id: 1 });
});
