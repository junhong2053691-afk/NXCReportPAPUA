// 手机宽表 → 卡片 + 底部抽屉（public/js/mobile-table-drawer.js）的纯逻辑。
// 决定见 .scratch/ui-responsive/decisions.md「增量决定 · 宽表抽屉」。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { parseSpec, headerLabels, cellColumns, assignRoles } = require("../../public/js/mobile-table-drawer");

test("data-m 规格：lead / title / meta / metric 是列号（从 1 起，负数从末尾数），native 是选择器", () => {
  assert.deepEqual(parseSpec("lead:1 title:2 metric:6,14 meta:2 native:tr[data-month]"), {
    lead: [1], title: [2], meta: [2], metric: [6, 14], native: "tr[data-month]",
  });
  assert.deepEqual(parseSpec("title:1 metric:-1"), { lead: [], title: [1], meta: [], metric: [-1], native: "" });
  assert.deepEqual(parseSpec(""), { lead: [], title: [], meta: [], metric: [], native: "" });
  assert.deepEqual(parseSpec("bogus:3 title:x"), { lead: [], title: [], meta: [], metric: [], native: "" }, "认不得的键和非数字一律丢掉");
});

test("两层表头：rowspan 的格子只算一次，分组标题与子标题用 · 连起来", () => {
  // 顾客列表的样子：姓名、手机跨两行；Bonus 下面分「笔数 / 总额」
  const rows = [
    [{ text: "姓名", rowspan: 2 }, { text: "手机", rowspan: 2 }, { text: "Bonus", colspan: 2 }, { text: "推荐人", rowspan: 2 }],
    [{ text: "笔数" }, { text: "总额" }],
  ];
  assert.deepEqual(headerLabels(rows), ["姓名", "手机", "Bonus · 笔数", "Bonus · 总额", "推荐人"]);
});

test("单层表头原样返回；空表头给空串", () => {
  assert.deepEqual(headerLabels([[{ text: " 排名 " }, { text: "推荐人" }]]), ["排名", "推荐人"]);
  assert.deepEqual(headerLabels([]), []);
});

test("行里的 colspan 让列号后移：合计行「合计」占两列，后面的格子对回原来的列", () => {
  assert.deepEqual(cellColumns([1, 1, 1]), [0, 1, 2]);
  assert.deepEqual(cellColumns([2, 1, 1]), [0, 2, 3]);
});

test("按列分配角色：title 优先于 metric / meta / lead；同一格只拿一个角色；负数列号从末尾数", () => {
  const spec = parseSpec("lead:1 title:2 metric:4,-1 meta:3");
  // 普通行：5 列
  assert.deepEqual(assignRoles(spec, [1, 1, 1, 1, 1]), ["lead", "title", "meta", "metric", "metric"]);
  // 合计行：第一格跨 # 与名字两列 → 拿 title，不拿 lead
  assert.deepEqual(assignRoles(spec, [2, 1, 1, 1]), ["title", "meta", "metric", "metric"]);
  // 没写进规格的列不给角色（手机卡片上隐藏，抽屉里照样列出）
  assert.deepEqual(assignRoles(parseSpec("title:1"), [1, 1]), ["title", null]);
});

test("脚本由 pageLayout 注入每一页，排在 app.js 之后", () => {
  const index = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const app = index.indexOf('<script src="/js/app.js?v=');
  const mtd = index.indexOf('<script src="/js/mobile-table-drawer.js?v=');
  assert.ok(app > 0 && mtd > app);
});

test("13 张宽表都挂了 data-m（手机上不再左右滑）", () => {
  // 总览 / 历史日报排行、实时交易、顾客列表、充值榜、推荐人榜、推荐人明细、活动领取、回流报表、
  // 月报、往来账、TOP REFERRAL、操作历史
  const index = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const count = (index.match(/<table[^>]*\sdata-m="/g) || []).length;
  assert.equal(count, 13);
});
