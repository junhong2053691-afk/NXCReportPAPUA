// 跨公司来单提醒的前端状态机（public/js/cross-company-alerts.js）。
// 每条断言对应 CONTEXT.md「跨公司来单提醒」里的一条决定，别为了让新行为通过就删。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  planAlerts,
  markSeen,
  createCrossCompanyAlerts,
  XCO_SEEN_KEY,
  XCO_MAX_VISIBLE,
  XCO_ALARM_PREFIX,
} = require("../../public/js/cross-company-alerts");

function fakeStorage() {
  const map = {};
  return {
    map,
    getItem: (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    setItem: (k, v) => { map[k] = String(v); },
    removeItem: (k) => { delete map[k]; },
  };
}

const COMPANIES = [
  { id: "aussiex6", name: "AussieX6" },
  { id: "rolex66", name: "Rolex66" },
  { id: "ezspin68", name: "EzSpin68" },
];

function row(id, companyId, extra = {}) {
  return { id, company_id: companyId, tx_type: "DEPOSIT", amount: 500, username: `u${id}`, ...extra };
}

// 服务端按 id 倒序给
function snap(rows, current = "aussiex6") {
  return { enabled: true, current, companies: COMPANIES, rows: rows.slice().sort((a, b) => b.id - a.id) };
}

function fakeAlarm(cid, log) {
  return {
    cid,
    update: (sig) => log.push(["update", cid, sig]),
    acknowledge: () => log.push(["ack", cid]),
    dispose: () => log.push(["dispose", cid]),
  };
}

function harness(storage = fakeStorage()) {
  const log = [];
  const renders = [];
  const navs = [];
  let next = snap([]);
  const c = createCrossCompanyAlerts({
    storage,
    fetchSnapshot: () => next,
    createAlarm: (cid) => fakeAlarm(cid, log),
    render: (plan) => renders.push(plan),
    navigate: (cid) => navs.push(cid),
  });
  return { c, log, renders, navs, storage, set: (s) => { next = s; } };
}

const cardIds = (plan) => plan.cards.map((x) => x.id);

test("当前公司的单不弹；别家一笔一条，最新在前；正文字段是 类型 / 金额 / username", () => {
  const plan = planAlerts(snap([row(1, "aussiex6"), row(2, "rolex66", { tx_type: "WITHDRAW", amount: 120.5, username: "bob" }), row(3, "ezspin68")]), {});
  assert.deepEqual(cardIds(plan), [3, 2]);
  assert.deepEqual(plan.cards[1], { id: 2, companyId: "rolex66", companyName: "Rolex66", type: "WITHDRAW", amount: 120.5, username: "bob" });
  assert.equal(plan.folded, null);
});

test("第一次（没有记录）积着的单要弹（Q8）", () => {
  const plan = planAlerts(snap([row(5, "rolex66"), row(6, "rolex66")]), {});
  assert.deepEqual(cardIds(plan), [6, 5]);
});

test(`最多 ${XCO_MAX_VISIBLE} 条最新的，其余折叠；折叠条按笔数排公司，点它去笔数最多的那家`, () => {
  const rows = [
    row(1, "ezspin68"), row(2, "rolex66"), row(3, "rolex66"), row(4, "rolex66"),
    row(5, "ezspin68"), row(6, "rolex66"), row(7, "rolex66"), row(8, "ezspin68"), row(9, "rolex66"),
  ];
  const plan = planAlerts(snap(rows), {});
  assert.deepEqual(cardIds(plan), [9, 8, 7, 6, 5]);
  assert.equal(plan.folded.count, 4);
  assert.deepEqual(plan.folded.companies, [{ id: "rolex66", name: "Rolex66", count: 3 }, { id: "ezspin68", name: "EzSpin68", count: 1 }]);
  assert.equal(plan.folded.targetCompanyId, "rolex66");
});

test("已看过按 id 逐笔记，不是水位线：关掉 50 号不吞掉还开着的 45 号", () => {
  const seen = markSeen({}, [{ id: 50, companyId: "rolex66" }]);
  const plan = planAlerts(snap([row(45, "rolex66"), row(50, "rolex66")]), seen);
  assert.deepEqual(cardIds(plan), [45]);
});

test("不再是 pending 的从已看过里剪掉，也就不再显示（Q12）", () => {
  const seen = { rolex66: [10, 11] };
  const plan = planAlerts(snap([row(11, "rolex66"), row(12, "rolex66")]), seen);
  assert.deepEqual(plan.seen.rolex66, [11]);
  assert.deepEqual(cardIds(plan), [12]);
});

test("停在某家时它当前全部 pending 记成已看过，切走后不再弹（Q18）", async () => {
  const h = harness();
  h.set(snap([row(1, "rolex66"), row(2, "rolex66")], "rolex66"));
  await h.c.poll();
  // 处理掉 1 笔后切回 aussiex6：剩下那笔不弹，之后进的新单照弹
  h.set(snap([row(2, "rolex66"), row(3, "rolex66")], "aussiex6"));
  const plan = await h.c.poll();
  assert.deepEqual(cardIds(plan), [3]);
});

test("刷新不重弹：已看过存在 storage，重建控制器后照样不弹", async () => {
  const storage = fakeStorage();
  const a = harness(storage);
  a.set(snap([row(7, "rolex66"), row(8, "rolex66")]));
  await a.c.poll();
  a.c.dismiss(8);
  const b = harness(storage); // 模拟刷新
  b.set(snap([row(7, "rolex66"), row(8, "rolex66")]));
  const plan = await b.c.poll();
  assert.deepEqual(cardIds(plan), [7], "关掉的 8 不回来，没关掉的 7 照样在（Q13）");
  assert.ok(JSON.parse(storage.map[XCO_SEEN_KEY]).rolex66.includes(8));
});

test("多标签页：别的页刚关掉的新单，本页用旧快照 rerender 时不能把它从已看过里裁掉写回", async () => {
  const storage = fakeStorage();
  const a = harness(storage);
  const b = harness(storage);
  a.set(snap([row(7, "rolex66")]));
  await a.c.poll(); // A 的快照里还没有 60
  b.set(snap([row(7, "rolex66"), row(60, "rolex66")]));
  await b.c.poll();
  b.c.dismiss(60); // B 关掉新单 → 写 storage → A 收到 storage 事件
  a.c.rerender();
  assert.ok(JSON.parse(storage.map[XCO_SEEN_KEY]).rolex66.includes(60), "60 仍是已看过");
  b.c.rerender(); // B 收到 A 的（假如有的）写入后重算
  assert.deepEqual(cardIds(b.renders.at(-1)), [7], "60 不回来");
});

test("关掉一条 = ack 那家报警，不碰别家（Q15）", async () => {
  const h = harness();
  h.set(snap([row(1, "rolex66"), row(2, "ezspin68")]));
  await h.c.poll();
  h.log.length = 0;
  h.c.dismiss(1);
  assert.deepEqual(h.log.filter((e) => e[0] === "ack"), [["ack", "rolex66"]]);
  assert.deepEqual(cardIds(h.renders.at(-1)), [2], "关掉后立刻重画，不等下一轮轮询");
});

test("点一条：记已看过、ack 那家、切过去", async () => {
  const h = harness();
  h.set(snap([row(1, "rolex66")]));
  await h.c.poll();
  h.c.open(1);
  assert.deepEqual(h.navs, ["rolex66"]);
  assert.ok(h.log.some((e) => e[0] === "ack" && e[1] === "rolex66"));
  assert.deepEqual(cardIds(h.c.plan()), []);
});

test("关掉折叠条：折进去的全部记已看过，并 ack 涉及的几家（Q20）", async () => {
  const h = harness();
  const rows = [1, 2, 3, 4, 5].map((id) => row(id, "rolex66")).concat([row(6, "ezspin68"), row(7, "rolex66"), row(8, "rolex66")]);
  // 最新 5 条：8 7 6 5 4；折叠：3 2 1（全是 rolex66）
  h.set(snap(rows));
  await h.c.poll();
  assert.equal(h.c.plan().folded.count, 3);
  h.log.length = 0;
  h.c.dismissFolded();
  assert.equal(h.c.plan().folded, null);
  assert.deepEqual(cardIds(h.c.plan()), [8, 7, 6, 5, 4]);
  assert.deepEqual(h.log.filter((e) => e[0] === "ack"), [["ack", "rolex66"]]);
});

test("点折叠条：只把目标那家折进去的记已看过，别家折叠的不吞", async () => {
  const h = harness();
  const rows = [row(1, "ezspin68"), row(2, "rolex66"), row(3, "rolex66")]
    .concat([4, 5, 6, 7, 8].map((id) => row(id, "aussiex6")))
    .concat([9, 10, 11, 12, 13].map((id) => row(id, "ezspin68")));
  // 当前 aussiex6；别家可见 13..9，折叠 3 2 1 → rolex66 2 笔、ezspin68 1 笔
  h.set(snap(rows));
  await h.c.poll();
  h.c.openFolded();
  assert.deepEqual(h.navs, ["rolex66"]);
  const seen = JSON.parse(h.storage.map[XCO_SEEN_KEY]);
  assert.deepEqual(seen.rolex66.sort(), [2, 3]);
  assert.ok(!seen.ezspin68.includes(1));
});

// 手机（≤700）上显示上限是 0：全部别家的单折进一条汇总条（.scratch/ui-responsive/decisions.md 增量 F）。
// 只改显示，已看过 / ack / 收起的规则与折叠条完全一样。
test("显示上限 0：没有单条卡片，全部折进汇总条，按笔数排公司，目标是笔数最多那家", () => {
  const rows = [row(1, "ezspin68"), row(2, "rolex66"), row(3, "rolex66"), row(4, "aussiex6")];
  const plan = planAlerts(snap(rows), {}, 0);
  assert.deepEqual(cardIds(plan), []);
  assert.equal(plan.folded.count, 3, "当前公司 aussiex6 的单照旧不算");
  assert.deepEqual(plan.folded.companies, [{ id: "rolex66", name: "Rolex66", count: 2 }, { id: "ezspin68", name: "EzSpin68", count: 1 }]);
  assert.equal(plan.folded.targetCompanyId, "rolex66");
  assert.equal(plan.folded.all, true, "渲染层靠它把标题从「还有 N 笔」换成「别家待审批 N」");
  assert.equal(planAlerts(snap(rows), {}).folded, null, "不传上限时仍是电脑上的 5 条");
});

test("显示上限由 deps.maxVisible 每轮现取：手机上关掉汇总条 = 全部记已看过、ack 涉及的每家", async () => {
  const log = [];
  let max = 0;
  const storage = fakeStorage();
  const c = createCrossCompanyAlerts({
    storage,
    fetchSnapshot: () => snap([row(1, "rolex66"), row(2, "ezspin68")]),
    createAlarm: (cid) => fakeAlarm(cid, log),
    render: () => {},
    navigate: () => {},
    maxVisible: () => max,
  });
  await c.poll();
  assert.deepEqual(cardIds(c.plan()), []);
  assert.equal(c.plan().folded.count, 2);
  max = XCO_MAX_VISIBLE; // 转成横屏 / 拉宽窗口：重算就回到一笔一条
  assert.deepEqual(cardIds(c.rerender()), [2, 1]);
  max = 0;
  c.rerender();
  log.length = 0;
  c.dismissFolded();
  assert.equal(c.plan().folded, null);
  assert.deepEqual(log.filter((e) => e[0] === "ack").map((e) => e[1]).sort(), ["ezspin68", "rolex66"]);
});

test("报警：每家别的公司一个；当前公司不建（它归 app.js 管）", async () => {
  const h = harness();
  h.set(snap([row(1, "rolex66")]));
  await h.c.poll();
  assert.deepEqual(h.c.alarms().sort(), ["ezspin68", "rolex66"]);
  assert.ok(h.log.some((e) => e[0] === "update" && e[1] === "rolex66" && e[2] === "pending"));
  assert.ok(h.log.some((e) => e[0] === "update" && e[1] === "ezspin68" && e[2] === ""));
  assert.ok(!h.log.some((e) => e[1] === "aussiex6"));
});

test("切到某家后它的后台报警只 dispose、不 update('')——否则清掉 app.js 共用的那个 key（Q14）", async () => {
  const h = harness();
  h.set(snap([row(1, "rolex66")], "aussiex6"));
  await h.c.poll();
  h.log.length = 0;
  h.set(snap([row(1, "rolex66")], "rolex66"));
  await h.c.poll();
  assert.ok(h.log.some((e) => e[0] === "dispose" && e[1] === "rolex66"));
  assert.ok(!h.log.some((e) => e[0] === "update" && e[1] === "rolex66"), "不能 update，update('') 会 clearState");
  assert.ok(h.log.some((e) => e[0] === "update" && e[1] === "aussiex6"), "切走的那家改由后台报警接手");
});

test("enabled=false（admin / 只授权一家）：什么都不显示，不建报警，也不改已看过", async () => {
  const storage = fakeStorage();
  storage.setItem(XCO_SEEN_KEY, JSON.stringify({ rolex66: [1] }));
  const h = harness(storage);
  h.set({ enabled: false, current: "aussiex6", companies: [], rows: [] });
  const plan = await h.c.poll();
  assert.deepEqual(plan.cards, []);
  assert.deepEqual(h.c.alarms(), []);
  assert.equal(storage.map[XCO_SEEN_KEY], JSON.stringify({ rolex66: [1] }));
});

test("与 app.js 当前公司报警共用 keyPrefix 和声音文件", () => {
  const app = fs.readFileSync(path.join(__dirname, "../../public/js/app.js"), "utf8");
  const xco = fs.readFileSync(path.join(__dirname, "../../public/js/cross-company-alerts.js"), "utf8");
  assert.match(app, new RegExp(`keyPrefix: "${XCO_ALARM_PREFIX}"`));
  const sound = app.match(/soundSrc: "([^"]+)",\s*keyPrefix: "bank-pending-alarm"/)[1];
  assert.match(xco, new RegExp(`XCO_ALARM_SOUND = "${sound.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"`));
});

test("公司名、金额、username 标 translate=no；脚本由 pageLayout 在 app.js 之后注入", () => {
  const xco = fs.readFileSync(path.join(__dirname, "../../public/js/cross-company-alerts.js"), "utf8");
  assert.match(xco, /title\.setAttribute\("translate", "no"\)/);
  assert.match(xco, /xcoDataSpan\(xcoFormatAmount\(card\.amount\)\)/);
  assert.match(xco, /xcoDataSpan\(card\.username\)/);
  const index = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
  const app = index.indexOf('<script src="/js/app.js?v=');
  const xcoTag = index.indexOf('<script src="/js/cross-company-alerts.js?v=');
  assert.ok(app > 0 && xcoTag > app, "要在 app.js 之后（依赖 api / showToast / removeAppToast）");
});
