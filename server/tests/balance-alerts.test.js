// 余额超上限网页报警的前端状态机（public/js/balance-alerts.js）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { balSignature, balModel, createBalanceAlerts, BAL_MAX_ITEMS } = require("../../public/js/balance-alerts");
const { createEscalatingAlarm, REPEAT_MS, SNOOZE_MS } = require("../../public/js/alarm");

function fakeStorage() {
  const map = {};
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    setItem: (k, v) => { map[k] = String(v); },
    removeItem: (k) => { delete map[k]; },
  };
}

function harness() {
  const plays = [];
  const clock = { t: 1000000 };
  const views = [];
  const navigations = [];
  const storage = fakeStorage();
  const audio = { loop: false, muted: false, currentTime: 0, play: () => plays.push(1), pause: () => {} };
  const ctl = createBalanceAlerts({
    createAlarm: (onStageChange) => createEscalatingAlarm({
      preset: "balance",
      keyPrefix: "bank-balance-alarm",
      scope: "alpha",
      storage,
      createAudio: () => audio,
      now: () => clock.t,
      onStageChange,
      autoTick: false,
      autoUnlock: false,
    }),
    render: (v) => views.push(v),
    navigate: () => navigations.push(1),
  });
  return { ctl, plays, clock, views, navigations, last: () => views[views.length - 1] };
}

const row = (id, balance, alertedBalance, extra = {}) => ({ id, label: "CBA " + id, balance, threshold: 1000, alertedBalance, ...extra });

test("signature：按 id 排序、用 alertedBalance，空集合是空串", () => {
  assert.equal(balSignature([]), "");
  assert.equal(balSignature(null), "");
  assert.equal(balSignature([row(7, 1500, 2000), row(3, 1200, 1200.5)]), "3:120050|7:200000");
  // 余额来回动但基准不变：signature 不变。
  assert.equal(balSignature([row(7, 1800, 2000)]), balSignature([row(7, 1500, 2000)]));
  // 没有 alertedBalance 时退回 balance。
  assert.equal(balSignature([{ id: 1, balance: 1100 }]), "1:110000");
});

test("通知卡最多列 3 户，其余计数", () => {
  const rows = [1, 2, 3, 4, 5].map((i) => row(i, 1000 + i, 1000 + i));
  const m = balModel(rows);
  assert.equal(BAL_MAX_ITEMS, 3);
  assert.deepEqual(m.items.map((x) => x.id), [1, 2, 3]);
  assert.equal(m.more, 2);
  assert.equal(balModel([row(1, 1, 1)]).more, 0);
});

test("超标立刻响并弹卡；同一份数据重复到达不再响", () => {
  const h = harness();
  h.ctl.apply({ over_limit: [row(1, 1500, 1500)] });
  assert.equal(h.plays.length, 1, "立刻响");
  assert.equal(h.last().visible, true);
  assert.equal(h.last().model.items[0].label, "CBA 1");

  h.clock.t += 8000;
  h.ctl.apply({ over_limit: [row(1, 1500, 1500)] });
  assert.equal(h.plays.length, 1);
});

test("没处理每 10 分钟再响；关掉通知静默 20 分钟并收起卡片", () => {
  const h = harness();
  h.ctl.apply({ over_limit: [row(1, 1500, 1500)] });
  h.clock.t += REPEAT_MS;
  h.ctl.alarm.tick();
  assert.equal(h.plays.length, 2);

  h.ctl.dismiss();
  assert.equal(h.last().visible, false, "关掉 = ack，卡片收起");
  h.clock.t += SNOOZE_MS - 1000;
  h.ctl.apply({ over_limit: [row(1, 1500, 1500)] });
  assert.equal(h.plays.length, 2, "静默期内不响");
  assert.equal(h.last().visible, false);

  h.clock.t += 1000;
  h.ctl.apply({ over_limit: [row(1, 1500, 1500)] });
  assert.equal(h.plays.length, 3, "静默到期仍超标，再响");
  assert.equal(h.last().visible, true);
});

test("ack 之后余额涨过上次报警值：跳过静默立刻重响；只是来回动则不响", () => {
  const h = harness();
  h.ctl.apply({ over_limit: [row(1, 1500, 1500)] });
  h.ctl.dismiss();

  h.clock.t += 60000;
  h.ctl.apply({ over_limit: [row(1, 1400, 1500)] });
  assert.equal(h.plays.length, 1, "回落但基准没变，不响");

  h.clock.t += 60000;
  h.ctl.apply({ over_limit: [row(1, 1700, 1700)] });
  assert.equal(h.plays.length, 2, "涨过上次报警值，重响");
  assert.equal(h.last().visible, true);
});

test("新渠道超标也立刻响；全部回落后卡片消失", () => {
  const h = harness();
  h.ctl.apply({ over_limit: [row(1, 1500, 1500)] });
  h.ctl.dismiss();
  h.ctl.apply({ over_limit: [row(1, 1500, 1500), row(2, 1200, 1200)] });
  assert.equal(h.plays.length, 2);
  assert.equal(h.last().model.items.length, 2);

  h.ctl.apply({ over_limit: [] });
  assert.equal(h.last().visible, false);
  h.ctl.apply({});
  assert.equal(h.last().visible, false, "旧服务端没有 over_limit 字段也不炸");
});

test("balNextSignature：只有户退出 / 回落沿用上一轮 sig；新户或涨过基准才换", () => {
  const { balNextSignature, balBaselineFromSig } = require("../../public/js/balance-alerts");
  const first = balNextSignature(null, [row(1, 1500, 1500), row(2, 1200, 1200)]);
  assert.equal(first.sig, "1:150000|2:120000");

  const dropped = balNextSignature(first, [row(1, 1400, 1500)]);
  assert.equal(dropped.sig, first.sig, "2 号户的钱转走了：不是新问题");
  assert.deepEqual(dropped.baseline, { 1: 150000 }, "退出的户从基准里删掉");

  const back = balNextSignature(dropped, [row(1, 1400, 1500), row(2, 1100, 1100)]);
  assert.notEqual(back.sig, first.sig, "退出过的户再超标就是新问题，哪怕金额更低");

  const rose = balNextSignature(dropped, [row(1, 1600, 1600)]);
  assert.equal(rose.sig, "1:160000");

  assert.deepEqual(balNextSignature(first, []), { sig: "", baseline: {} });
  assert.deepEqual(balBaselineFromSig("3:120050|7:200000"), { 3: 120050, 7: 200000 });
});

test("ack 之后有一户的钱转走、其余照旧：不重响，卡片也不冒出来", () => {
  const h = harness();
  h.ctl.apply({ over_limit: [row(1, 1500, 1500), row(2, 1200, 1200)] });
  h.ctl.dismiss();
  h.clock.t += 60000;
  h.ctl.apply({ over_limit: [row(1, 1500, 1500)] });
  assert.equal(h.plays.length, 1);
  assert.equal(h.last().visible, false);
});

test("点卡片 = ack 并跳交易页", () => {
  const h = harness();
  h.ctl.apply({ over_limit: [row(1, 1500, 1500)] });
  h.ctl.open();
  assert.equal(h.navigations.length, 1);
  assert.equal(h.last().visible, false);
});

test("页面注入：balance-alerts.js 在 app.js 之后、带版本号", () => {
  const index = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
  const appTag = index.indexOf('<script src="/js/app.js?v=');
  const balTag = index.indexOf('<script src="/js/balance-alerts.js?v=');
  assert.ok(balTag > 0, "必须注入 balance-alerts.js");
  assert.ok(balTag > appTag, "它听 app.js 派发的 bank-pending-counts 事件，必须在 app.js 之后");
  const src = fs.readFileSync(path.join(__dirname, "../../public/js/balance-alerts.js"), "utf8");
  assert.ok(src.includes('preset: "balance"'));
});
