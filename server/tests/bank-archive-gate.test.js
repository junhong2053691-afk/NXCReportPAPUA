const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bankDatabase: database,
  addAccount,
  addLedger,
  addDeletedLedger,
  accountRow,
} = require("./bank-fixture");
const { archiveBlockReason } = require("../lib/bankLifecycle");
const { displayBalanceForAccount } = require("../lib/bankReport");
const { todayKey, shiftDateKey } = require("../lib/dates");

const TODAY = todayKey();
const YESTERDAY = shiftDateKey(TODAY, -1);
const TOMORROW = shiftDateKey(TODAY, 1);

test("余额为 0 的封禁户可以归档", () => {
  const db = database();
  const id = addAccount(db, { lifecycle_status: "banned", active: 0 });
  addLedger(db, id, 500, YESTERDAY);
  addLedger(db, id, 0, YESTERDAY, { amount_out: 500 });

  assert.equal(archiveBlockReason(db, accountRow(db, id)), null);
});

test("余额非 0 的封禁户被拦住，原因里带金额", () => {
  const db = database();
  const id = addAccount(db, { lifecycle_status: "banned", active: 0 });
  addLedger(db, id, 9966.64, YESTERDAY);

  const reason = archiveBlockReason(db, accountRow(db, id));
  assert.ok(reason, "有余额必须拦住");
  assert.match(reason, /9,966\.64/, "原因里要写清还剩多少");
});

test("负余额同样拦住（账没做平也是没清干净）", () => {
  const db = database();
  const id = addAccount(db, { lifecycle_status: "banned", active: 0 });
  addLedger(db, id, 0, YESTERDAY, { amount_out: 124.5 });

  const reason = archiveBlockReason(db, accountRow(db, id));
  assert.ok(reason, "负余额必须拦住");
  assert.match(reason, /-\$124\.50/);
});

// 这一组里最有价值的一条。闸门若误用 displayBalanceForAccount，只有它会红：
// reset_daily_balance = 1 的账户那个函数只算「当日净额」，今天没流水就返回 0。
test("每日归零账户：累计有钱但今日无流水，必须拦住", () => {
  const db = database();
  const id = addAccount(db, {
    lifecycle_status: "banned",
    active: 0,
    reset_daily_balance: 1,
  });
  addLedger(db, id, 5000, YESTERDAY);

  const account = accountRow(db, id);
  assert.equal(
    displayBalanceForAccount(db, account, TODAY),
    0,
    "前提：显示余额确实是 0（所以闸门不能用它）"
  );

  const reason = archiveBlockReason(db, account);
  assert.ok(reason, "累计 5000 躺在里面，绝不能放行");
  assert.match(reason, /5,000\.00/);
});

// displayBalanceForAccount 的另一个偏低场景：entry_time 上界把未来日期的流水挡在外面。
test("未来日期流水：显示余额为 0 但累计非 0，必须拦住", () => {
  const db = database();
  const id = addAccount(db, { lifecycle_status: "banned", active: 0 });
  addLedger(db, id, 800, TOMORROW);

  const account = accountRow(db, id);
  assert.equal(
    displayBalanceForAccount(db, account, TODAY),
    0,
    "前提：显示余额确实是 0（所以闸门不能用它）"
  );
  assert.ok(archiveBlockReason(db, account), "未来流水的钱也是钱");
});

test("余额为 0 但有可恢复的已删流水时拦住", () => {
  const db = database();
  const id = addAccount(db, { lifecycle_status: "banned", active: 0 });
  addDeletedLedger(db, id, 300, YESTERDAY);

  const reason = archiveBlockReason(db, accountRow(db, id));
  assert.ok(reason, "restore 一下余额就会复活");
  assert.match(reason, /1 条/);
});

test("必须先封禁才能归档；已归档的不能再归档", () => {
  const db = database();
  const operating = addAccount(db, { lifecycle_status: "active" });
  const archived = addAccount(db, { lifecycle_status: "archived", active: 0 });

  assert.match(archiveBlockReason(db, accountRow(db, operating)), /先封禁/);
  assert.match(archiveBlockReason(db, accountRow(db, archived)), /已归档/);
});

test("脏状态不能走归档路径（失败关闭后它是 archived，不是 banned）", () => {
  const db = database();
  const id = addAccount(db, { lifecycle_status: "garbage" });
  assert.ok(archiveBlockReason(db, accountRow(db, id)));
});
