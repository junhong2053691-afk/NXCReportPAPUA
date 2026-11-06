// 审批平台单时的银行下拉（本户 / 拆分自付）。
//
// 2026-11-06 员工演练：下拉把「上一笔用过的户口」顶到第一位、每审一笔重排一次，于是误点一次，
// 那个错的户口下一笔就排第一，连环误点；位置序号又叠在户口名自带的编号前面（「1. 7. Ubank MAT」），
// 两个数字对不上。与用户确认：**固定顺序，不重排**，标签不加位置序号。
const test = require("node:test");
const assert = require("node:assert/strict");
const { bankSelectOptionsHtml } = require("../../public/js/ledger-bank-pick");

const banks = [
  { id: 31, label: "1. Ubank JASON (JASON LANGTRY)" },
  { id: 37, label: "7. Ubank MATTHEW (MATTHEW FORREST)" },
  { id: 40, label: "9. Ubank KYLIE (KYLIE ORDON)" },
];
const labelOf = (b) => b.label;
const values = (html) => [...html.matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
const texts = (html) => [...html.matchAll(/>([^<]*)<\/option>/g)].map((m) => m[1]);

test("按户口列表原顺序输出，首项是空选项「—」", () => {
  const html = bankSelectOptionsHtml(banks, labelOf);
  assert.deepEqual(values(html), ["", "31", "37", "40"]);
  assert.equal(texts(html)[0], "—");
});

test("标签不加位置序号：户口名自带的编号原样保留，不会变成「2. 7. Ubank …」", () => {
  const html = bankSelectOptionsHtml(banks, labelOf);
  assert.deepEqual(texts(html).slice(1), banks.map((b) => b.label));
});

test("selected 只标给定的那个户口；不给就不预选（不默认上一笔用的）", () => {
  assert.doesNotMatch(bankSelectOptionsHtml(banks, labelOf), /selected/);
  const html = bankSelectOptionsHtml(banks, labelOf, 37);
  assert.match(html, /value="37" translate="no" selected/);
  assert.equal((html.match(/selected/g) || []).length, 1);
});

test("户口名转义，标记 translate=no（租户数据不进翻译）", () => {
  const html = bankSelectOptionsHtml([{ id: 1, label: 'A&B <x> "q"' }], labelOf);
  assert.match(html, /translate="no">A&amp;B &lt;x&gt; &quot;q&quot;<\/option>/);
});
