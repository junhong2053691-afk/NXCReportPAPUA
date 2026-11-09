// 实时收款银行（lib/bankLiveReceiving.js + PUT /api/banks/live-receiving）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { bankDatabase, addAccount, accountRow } = require("./bank-fixture");
const { setLiveReceiving, currentLiveIds, MAX_LIVE_RECEIVING } = require("../lib/bankLiveReceiving");

function setup() {
  const db = bankDatabase();
  const ids = [1, 2, 3, 4].map((n) => addAccount(db, { bank_branch: `Bank ${n}`, sort_order: n }));
  return { db, ids };
}

test("整组替换：勾谁就是谁，其余全部清掉", () => {
  const { db, ids } = setup();
  assert.deepEqual(setLiveReceiving(db, "alpha", [ids[0], ids[1]]).after, [ids[0], ids[1]]);
  const r = setLiveReceiving(db, "alpha", [ids[2]]);
  assert.deepEqual(r.before, [ids[0], ids[1]]);
  assert.deepEqual(r.after, [ids[2]]);
  assert.deepEqual(setLiveReceiving(db, "alpha", []).after, []);
});

test(`最多 ${MAX_LIVE_RECEIVING} 个，第 4 个整组拒绝且不改动现状`, () => {
  const { db, ids } = setup();
  setLiveReceiving(db, "alpha", [ids[0]]);
  assert.throws(() => setLiveReceiving(db, "alpha", ids), (e) => e.status === 400 && /最多 3 个/.test(e.message));
  assert.deepEqual(currentLiveIds(db, "alpha"), [ids[0]]);
  // 重复 id 去重后算一个
  assert.deepEqual(setLiveReceiving(db, "alpha", [ids[1], ids[1], ids[2], ids[3]]).after, [ids[1], ids[2], ids[3]]);
});

test("只能选本公司、运营中的户；遗留 active = 0 的运营中户照样能选（「使用中」已取消）", () => {
  const { db, ids } = setup();
  const other = addAccount(db, { company_id: "beta", bank_branch: "Other Co" });
  const banned = addAccount(db, { lifecycle_status: "banned", active: 0 });
  const archived = addAccount(db, { lifecycle_status: "archived", active: 0 });
  const idle = addAccount(db, { active: 0 });
  for (const bad of [other, banned, archived, 99999]) {
    assert.throws(() => setLiveReceiving(db, "alpha", [ids[0], bad]), (e) => e.status === 400, `id ${bad} 应被拒`);
  }
  assert.deepEqual(currentLiveIds(db, "alpha"), []);
  assert.deepEqual(setLiveReceiving(db, "alpha", [idle]).after, [idle]);
  setLiveReceiving(db, "alpha", []);
  assert.throws(() => setLiveReceiving(db, "alpha", "1,2"), (e) => e.status === 400, "不是数组");
  assert.throws(() => setLiveReceiving(db, "alpha", [0]), (e) => e.status === 400);
});

test("公司隔离：改 alpha 不碰 beta 的实时收款", () => {
  const { db, ids } = setup();
  const b = addAccount(db, { company_id: "beta", bank_branch: "Beta Bank" });
  setLiveReceiving(db, "beta", [b]);
  setLiveReceiving(db, "alpha", [ids[0]]);
  setLiveReceiving(db, "alpha", []);
  assert.equal(accountRow(db, b).live_receiving, 1);
});

test("路由接线：专用端点在 PUT /:id 之前、只认 req.companyId、写审计；不进 PUT 白名单；封禁 / 归档清零", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../routes/banks.js"), "utf8");
  const live = routes.indexOf('router.put("/live-receiving"');
  assert.ok(live > 0 && live < routes.indexOf('router.put("/:id"'), "必须注册在 /:id 之前");
  const handler = routes.slice(live, routes.indexOf('router.put("/:id"'));
  assert.match(handler, /const cid = companyId\(req\);/);
  assert.match(handler, /runAtomic\(db, \(\) => \{\s*const changed = setLiveReceiving\(db, cid,/);
  assert.match(handler, /action: "bank_account\.live_receiving"/);
  const allowed = routes.slice(routes.indexOf("const allowed = ["), routes.indexOf("];", routes.indexOf("const allowed = [")));
  assert.doesNotMatch(allowed, /live_receiving/, "不能经 PUT /:id 逐户开关（并发会超过 3 个）");
  assert.match(routes, /if \(lifecycleOp && lifecycleOp\.status !== LIFECYCLE\.ACTIVE\) \{\s*sets\.push\("live_receiving = 0"\);/);
  // 「使用中」取消后 active 不再可写：旧标签页发 {active:0} 不能顺手清掉实时收款。
  assert.doesNotMatch(allowed, /"active"/, "active 不该再在 PUT 白名单里");
  // GET /api/banks 要带出来，前端才知道勾了谁
  assert.match(routes, /live_receiving: r\.live_receiving \? 1 : 0/);
});

// 把 bank-ledger.js 里的 depositBankOptionsHtml 抠出来，配上桩跑真实行为。
function loadDepositBankOptionsHtml(live) {
  const src = fs.readFileSync(path.join(__dirname, "../../public/js/bank-ledger.js"), "utf8");
  const start = src.indexOf("function depositBankOptionsHtml(");
  const fn = src.slice(start, src.indexOf("\n  }\n", start) + 4);
  const { bankSelectOptionsHtml } = require("../../public/js/ledger-bank-pick.js");
  return new Function("window", "liveBanks", "pendingBankOptionsHtml", "tabLabel", "OTHER_BANKS",
    `${fn}; return depositBankOptionsHtml;`)(
    { bankSelectOptionsHtml },
    () => live,
    () => "FULL_LIST",
    (b) => b.label,
    "__other__"
  );
}

test("前端：充值单只列实时收款银行，留「其他渠道…」退路；提现不受影响", () => {
  const banks = [{ id: 11, label: "Alpha" }, { id: 12, label: "Beta" }];
  const html = loadDepositBankOptionsHtml(banks)();
  assert.match(html, /value="11"/);
  assert.match(html, /value="12"/);
  assert.match(html, /<option value="__other__">其他渠道…<\/option>$/, "要有「其他渠道…」");
  assert.equal(loadDepositBankOptionsHtml([])(), "FULL_LIST", "一个没勾就是完整列表");
  // 提现行的本户 BANK 仍走完整列表
  const src = fs.readFileSync(path.join(__dirname, "../../public/js/bank-ledger.js"), "utf8");
  assert.match(src, /isWd\s*\?\s*`<select class="pend-bank">\$\{pendingBankOptionsHtml\(\)\}<\/select>/);
});

test("前端：恰好勾 1 户时预选它；勾 2～3 户不预选", () => {
  const one = loadDepositBankOptionsHtml([{ id: 11, label: "Alpha" }])();
  assert.match(one, /value="11" translate="no" selected/);
  assert.equal((one.match(/selected/g) || []).length, 1);

  const two = loadDepositBankOptionsHtml([{ id: 11, label: "Alpha" }, { id: 12, label: "Beta" }])();
  assert.doesNotMatch(two, /selected/, "2 户不预选");
  const three = loadDepositBankOptionsHtml([{ id: 11, label: "A" }, { id: 12, label: "B" }, { id: 13, label: "C" }])();
  assert.doesNotMatch(three, /selected/, "3 户不预选");
});
