// 待处理平台单的搜索 / 类型筛选（public/js/pending-filter.js）与分批渲染。
//
// 2026-11-06 员工演练：待处理 400+ 行一次全部渲染，每行一个 9 项银行下拉，没有搜索、筛选、
// 分页；要找一笔单只能整页滚。现在：按 TRANS ID / 用户 / 姓名 / 金额搜，按 DEPOSIT /
// WITHDRAW 筛，先画 50 行，「显示更多」往后追加（不重画已有的行，填了一半的不丢）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { filterPendingRows, PENDING_PAGE_SIZE } = require("../../public/js/pending-filter");

const rows = [
  { tx_id: "17165863553", tx_type: "DEPOSIT", amount: 100, username: "amy88", name: "Amy Lee", tx_time: "2026-10-02 10:00:00" },
  { tx_id: "17165871970", tx_type: "DEPOSIT", amount: 1250.5, username: "bob", name: "Bob Tan", tx_time: "2026-10-02 11:00:00" },
  { tx_id: "17173884537", tx_type: "WITHDRAW", amount: 500.89, username: "carl", name: "Carl Wu", tx_time: "2026-10-05 09:00:00" },
];
const ids = (list) => list.map((r) => r.tx_id);

test("不填条件：原样返回，顺序不变", () => {
  assert.deepEqual(ids(filterPendingRows(rows, {})), ids(rows));
});

test("按 TRANS ID 片段、用户名、姓名搜（不分大小写）", () => {
  assert.deepEqual(ids(filterPendingRows(rows, { q: "884537" })), ["17173884537"]);
  assert.deepEqual(ids(filterPendingRows(rows, { q: "AMY88" })), ["17165863553"]);
  assert.deepEqual(ids(filterPendingRows(rows, { q: "bob tan" })), ["17165871970"]);
});

test("按金额搜：500.89、1250.5、带千分位的 1,250.50 都能找到", () => {
  assert.deepEqual(ids(filterPendingRows(rows, { q: "500.89" })), ["17173884537"]);
  assert.deepEqual(ids(filterPendingRows(rows, { q: "1250.5" })), ["17165871970"]);
  assert.deepEqual(ids(filterPendingRows(rows, { q: "1,250.50" })), ["17165871970"]);
});

test("按类型筛，可与搜索叠加", () => {
  assert.deepEqual(ids(filterPendingRows(rows, { type: "WITHDRAW" })), ["17173884537"]);
  assert.deepEqual(ids(filterPendingRows(rows, { type: "DEPOSIT", q: "carl" })), []);
});

test("一批 50 行", () => {
  assert.equal(PENDING_PAGE_SIZE, 50);
});

test("页面接入：工具栏、显示更多、追加渲染", () => {
  const page = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
  assert.match(page, /id="pending-search"/);
  assert.match(page, /id="pending-type"/);
  assert.match(page, /id="pending-more-btn"/);
  const guard = page.indexOf("/js/pending-filter.js");
  assert.ok(guard > 0 && guard < page.indexOf("/js/bank-ledger.js?"));
  const src = fs.readFileSync(path.join(__dirname, "../../public/js/bank-ledger.js"), "utf8");
  assert.match(src, /window\.filterPendingRows\(/);
  assert.match(src, /insertAdjacentHTML\("beforeend"/, "显示更多要追加，不能整表重画");
});
