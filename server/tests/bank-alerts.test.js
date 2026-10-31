const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bankDatabase: database,
  addAccount,
  addLedger: addLedgerRow,
  outbox,
  addSentMessage,
  accountRow,
} = require("./bank-fixture");
const { evaluateBalanceAlert } = require("../lib/bankAlerts");
const { stripHtml } = require("../lib/telegramFormat");
const {
  computeBankDailyReport,
  displayBalanceForAccount,
  refreshBankBalance,
} = require("../lib/bankReport");
const { runAtomic } = require("../lib/auditLog");
const { todayKey, shiftDateKey } = require("../lib/dates");

const TODAY = todayKey();
const YESTERDAY = shiftDateKey(TODAY, -1);
const TOMORROW = shiftDateKey(TODAY, 1);

function addLedger(db, bankAccountId, amountIn, dateKey = TODAY, extra = {}) {
  return addLedgerRow(db, bankAccountId, amountIn, dateKey, extra);
}

test("超标后每创新高再报一次；同一桶钱来回动不重复报；跌回后复位并可再次触发", () => {
  const db = database();
  const id = addAccount(db, { alert_threshold: 5000 });
  const alerts = () => outbox(db).filter((r) => r.kind === "alert").length;

  addLedger(db, id, 4999.99);
  refreshBankBalance(db, id);
  assert.equal(alerts(), 0, "未达阈值不应报警");
  assert.equal(accountRow(db, id).alert_fired_at, "");

  addLedger(db, id, 0.01);
  refreshBankBalance(db, id);
  assert.equal(alerts(), 1, "恰好达到阈值应报警一次");
  assert.notEqual(accountRow(db, id).alert_fired_at, "");
  assert.equal(accountRow(db, id).alert_fired_balance, 5000, "基准应记成本次报警时的余额");

  addLedger(db, id, 3000);
  refreshBankBalance(db, id);
  assert.equal(alerts(), 2, "超标期间再涨一次就该再报一次");
  assert.equal(accountRow(db, id).alert_fired_balance, 8000, "基准跟着抬高");

  // 转走一部分：仍然超标，但低于上次报警时的余额。同一桶钱来回动不是新信息。
  addLedger(db, id, 0, TODAY, { amount_out: 1000 });
  refreshBankBalance(db, id);
  assert.equal(alerts(), 2, "部分转走后仍超标，但没创新高，不该再报");

  addLedger(db, id, 500);
  refreshBankBalance(db, id);
  assert.equal(alerts(), 2, "7500 还没超过上次报警的 8000，不该再报");
  assert.equal(accountRow(db, id).alert_fired_balance, 8000, "没报就不该动基准");

  addLedger(db, id, 1000);
  refreshBankBalance(db, id);
  assert.equal(alerts(), 3, "涨到 8500 创出新高，应再报");

  addLedger(db, id, 0, TODAY, { amount_out: 8000 });
  refreshBankBalance(db, id);
  assert.equal(alerts(), 3, "跌回阈值下应静默复位，不发消息");
  const reset = accountRow(db, id);
  assert.equal(reset.alert_fired_at, "", "复位后标记应清空");
  assert.equal(reset.alert_fired_date, "");
  assert.equal(reset.alert_fired_balance, 0, "三列必须一起清，不能留下自相矛盾的中间态");

  addLedger(db, id, 6000);
  refreshBankBalance(db, id);
  assert.equal(alerts(), 4, "复位后再次跨越应重新报警");

  db.close();
});

test("每日归零账户跨日后应重新报警，而不是被昨天的标记吞掉", () => {
  const db = database();
  const id = addAccount(db, { alert_threshold: 5000, reset_daily_balance: 1 });

  // 昨天已经触发过一次，标记停在昨天。
  addLedger(db, id, 9000, YESTERDAY);
  db.prepare(
    "UPDATE bank_accounts SET alert_fired_at = datetime('now'), alert_fired_date = ? WHERE id = ?"
  ).run(YESTERDAY, id);

  // 今天第一笔流水就顶过阈值。当日净额重新从 0 起算，所以必须重新报警。
  addLedger(db, id, 6000, TODAY);
  refreshBankBalance(db, id);

  assert.equal(outbox(db).length, 1, "跨日后应重新报警");
  assert.equal(accountRow(db, id).alert_fired_date, TODAY);
  db.close();
});

test("每日归零账户跨日第一笔低于昨天的报警点，仍要报警", () => {
  const db = database();
  const id = addAccount(db, { alert_threshold: 5000, reset_daily_balance: 1 });

  // 昨天在 9000 报过。如果「创新高才再报」那条判定脱离 isFired 直接比 alert_fired_balance，
  // 今天这笔 6000（超阈值但低于 9000）就会被昨天的残值吞掉。这条用例守着那个写法。
  addLedger(db, id, 9000, YESTERDAY);
  db.prepare(
    `UPDATE bank_accounts
     SET alert_fired_at = datetime('now'), alert_fired_date = ?, alert_fired_balance = 9000
     WHERE id = ?`
  ).run(YESTERDAY, id);

  addLedger(db, id, 6000, TODAY);
  refreshBankBalance(db, id);

  assert.equal(outbox(db).length, 1, "跨日后当日净额重新起算，残留的高点不该吞掉今天的报警");
  const row = accountRow(db, id);
  assert.equal(row.alert_fired_date, TODAY);
  assert.equal(row.alert_fired_balance, 6000, "基准应被今天这次报警覆盖");
  db.close();
});

test("每日归零账户只看当日净额，昨天的钱不触发今天的报警", () => {
  const db = database();
  const id = addAccount(db, { alert_threshold: 5000, reset_daily_balance: 1 });

  addLedger(db, id, 9000, YESTERDAY);
  refreshBankBalance(db, id);
  assert.equal(outbox(db).length, 0, "昨天的流水不计入今天的当日净额");

  addLedger(db, id, 5000, TODAY);
  refreshBankBalance(db, id);
  assert.equal(outbox(db).length, 1, "今天的流水达到阈值才报警");
  db.close();
});

test("未来日期的流水不计入报警余额（与页面口径一致）", () => {
  const db = database();
  const id = addAccount(db, { alert_threshold: 5000 });

  addLedger(db, id, 9000, TOMORROW);
  refreshBankBalance(db, id);
  assert.equal(outbox(db).length, 0, "未来流水不应触发报警");
  // bank_accounts.balance 那一列是无时间上界的，会包含未来流水——正是不能拿它当依据的原因。
  assert.equal(accountRow(db, id).balance, 9000);
  assert.equal(displayBalanceForAccount(db, accountRow(db, id), TODAY), 0);
  db.close();
});

test("报警余额与页面日报显示的余额逐账户一致", () => {
  const db = database();
  const cumulative = addAccount(db, { alert_threshold: 0 });
  const daily = addAccount(db, { alert_threshold: 0, reset_daily_balance: 1 });
  const empty = addAccount(db, { alert_threshold: 0 });

  addLedger(db, cumulative, 1200, YESTERDAY);
  addLedger(db, cumulative, 800, TODAY);
  addLedger(db, daily, 4000, YESTERDAY);
  addLedger(db, daily, 250.5, TODAY);
  addLedger(db, daily, 0, TODAY, { amount_out: 50.5 });

  const report = computeBankDailyReport(db, "alpha", { date: TODAY });
  for (const bankRow of report.bankRows) {
    const account = accountRow(db, bankRow.id);
    assert.equal(
      displayBalanceForAccount(db, account, TODAY),
      bankRow.balance,
      `账户 ${bankRow.id} 的报警余额与日报余额不一致`
    );
  }
  assert.equal(displayBalanceForAccount(db, accountRow(db, empty), TODAY), 0);
  db.close();
});

test("阈值 0 / 负数 / 封禁 / 归档账户永不报警；active=0 的账户照常报警", () => {
  const db = database();
  const zero = addAccount(db, { alert_threshold: 0 });
  const negative = addAccount(db, { alert_threshold: -100 });
  const banned = addAccount(db, { alert_threshold: 1000, lifecycle_status: "banned" });
  const archived = addAccount(db, { alert_threshold: 1000, lifecycle_status: "archived", active: 0 });
  const inactive = addAccount(db, { alert_threshold: 1000, active: 0 });

  for (const id of [zero, negative, banned, archived, inactive]) {
    addLedger(db, id, 9000);
    refreshBankBalance(db, id);
  }

  const rows = outbox(db);
  assert.equal(rows.length, 1, "只有 active=0 那个账户应该报警");
  assert.equal(rows[0].bank_account_id, inactive);
  db.close();
});

test("阈值被清零时复位残留的已报警标记", () => {
  const db = database();
  const id = addAccount(db, { alert_threshold: 1000 });
  addLedger(db, id, 5000);
  refreshBankBalance(db, id);
  assert.notEqual(accountRow(db, id).alert_fired_at, "");

  db.prepare("UPDATE bank_accounts SET alert_threshold = 0 WHERE id = ?").run(id);
  evaluateBalanceAlert(db, id);
  const row = accountRow(db, id);
  assert.equal(row.alert_fired_at, "", "停用阈值应复位状态");
  assert.equal(row.alert_fired_balance, 0, "三列一起清");
  db.close();
});

test("alert:false 不写 outbox（修数据脚本用）", () => {
  const db = database();
  const id = addAccount(db, { alert_threshold: 1000 });
  addLedger(db, id, 5000);
  refreshBankBalance(db, id, { alert: false });
  assert.equal(outbox(db).length, 0);
  assert.equal(accountRow(db, id).alert_fired_at, "");
  db.close();
});

test("事务回滚时 outbox 行与已报警标记一并回滚", () => {
  const db = database();
  const id = addAccount(db, { alert_threshold: 1000 });

  assert.throws(() =>
    runAtomic(db, () => {
      addLedger(db, id, 5000);
      refreshBankBalance(db, id);
      assert.equal(outbox(db).length, 1, "事务内应已入队");
      throw new Error("boom");
    })
  );

  assert.equal(outbox(db).length, 0, "回滚后 outbox 不应留下行");
  assert.equal(accountRow(db, id).alert_fired_at, "", "回滚后不应留下已报警标记");
  db.close();
});

// ------------------------------------------------------------------ 复位时的撤回
//
// 钱转走之后那条 ⚠️ 已经不成立了，留在聊天里只会误导人。撤回和报警一样**只排队不发包**：
// 这段代码运行在调用方的事务里。

/** 预置「已经发出去、还挂在聊天里」的报警消息。 */
function seedSent(db, bankAccountId, count = 2) {
  for (let i = 0; i < count; i++) {
    addSentMessage(db, { bank_account_id: bankAccountId, message_id: 100 + i });
  }
}

const retracts = (db) => outbox(db).filter((r) => r.kind === "retract");

test("跌回阈值下时为这一轮已发出的消息排一条撤回任务", () => {
  const db = database();
  const id = addAccount(db, { alert_threshold: 1000 });
  addLedger(db, id, 5000);
  refreshBankBalance(db, id);
  seedSent(db, id);

  addLedger(db, id, 0, TODAY, { amount_out: 4500 });
  refreshBankBalance(db, id);

  const rows = retracts(db);
  assert.equal(rows.length, 1, "复位应排一条撤回任务");
  assert.equal(rows[0].bank_account_id, id);
  assert.equal(rows[0].parse_mode, "", "撤回后留下的那一行是纯文本，不走 HTML");
  assert.match(rows[0].text, /✅ 已处理/);
  assert.match(rows[0].text, /CBA Sydney/, "要说清是哪个渠道");
  db.close();
});

test("没有挂着的消息时不排空的撤回任务", () => {
  const db = database();
  const id = addAccount(db, { alert_threshold: 1000 });
  addLedger(db, id, 5000);
  refreshBankBalance(db, id);

  // 一条都没真的发出去（没配收件 chat 时就是这样），复位不该在 outbox 里堆空活。
  db.prepare("UPDATE bank_accounts SET alert_threshold = 0 WHERE id = ?").run(id);
  evaluateBalanceAlert(db, id);
  assert.equal(retracts(db).length, 0);
  db.close();
});

test("账户被封禁时同样撤回——报警已经不成立了", () => {
  const db = database();
  const id = addAccount(db, { alert_threshold: 1000 });
  addLedger(db, id, 5000);
  refreshBankBalance(db, id);
  seedSent(db, id, 1);

  db.prepare("UPDATE bank_accounts SET lifecycle_status = 'banned', active = 0 WHERE id = ?").run(id);
  evaluateBalanceAlert(db, id);

  assert.equal(accountRow(db, id).alert_fired_at, "");
  assert.equal(retracts(db).length, 1, "封禁户的余额改由每周待清理汇总盯着，那条 ⚠️ 该撤掉");
  db.close();
});

test("事务回滚时撤回任务一并回滚", () => {
  const db = database();
  const id = addAccount(db, { alert_threshold: 1000 });
  addLedger(db, id, 5000);
  refreshBankBalance(db, id);
  seedSent(db, id, 1);

  assert.throws(() =>
    runAtomic(db, () => {
      addLedger(db, id, 0, TODAY, { amount_out: 4500 });
      refreshBankBalance(db, id);
      assert.equal(retracts(db).length, 1, "事务内应已入队");
      throw new Error("boom");
    })
  );

  assert.equal(retracts(db).length, 0, "回滚后不该留下撤回任务");
  assert.notEqual(accountRow(db, id).alert_fired_at, "", "复位本身也要回滚");
  db.close();
});

test("整条复位路径一个 HTTP 请求都不发", () => {
  const db = database();
  const id = addAccount(db, { alert_threshold: 1000 });
  addLedger(db, id, 5000);
  refreshBankBalance(db, id);
  seedSent(db, id);

  // 这段代码跑在 runAtomic 事务里，在那里 await 一个 HTTP 请求会把整个事务卡住，
  // 后台点「审批」就会转圈。撤回只许往 telegram_outbox 写一行。
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("不许在事务内发包");
  };
  try {
    addLedger(db, id, 0, TODAY, { amount_out: 4500 });
    refreshBankBalance(db, id);
    assert.equal(retracts(db).length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
  db.close();
});

test("报警消息包含渠道、当前余额、阈值与口径", () => {
  const db = database();
  const id = addAccount(db, { alert_threshold: 5000, reset_daily_balance: 1 });
  addLedger(db, id, 7500.25);
  refreshBankBalance(db, id);

  const text = outbox(db)[0].text;
  assert.match(text, /余额报警/);
  assert.match(text, /CBA Sydney/);
  assert.match(text, /Test Holder/);
  assert.match(text, /6789/);
  assert.match(text, /7,500\.25/);
  assert.match(text, /5,000\.00/);
  assert.match(text, /当日净额/);
  db.close();
});

test("报警行自带 parse_mode，且 <pre> 成对闭合", () => {
  const db = database();
  const id = addAccount(db, { alert_threshold: 5000, bank_branch: "A & B <Bank>" });
  addLedger(db, id, 7500.25);
  refreshBankBalance(db, id);

  const row = outbox(db)[0];
  // 发送侧靠这一列决定用不用 HTML 模式：升级前积压的老行是 ''，照纯文本发。
  assert.equal(row.parse_mode, "HTML");
  assert.equal((row.text.match(/<\/pre>/g) || []).length, (row.text.match(/<pre>/g) || []).length);
  assert.match(row.text, /A &amp; B &lt;Bank&gt;/, "银行名必须转义，否则 Telegram 400");
  assert.ok(!row.text.includes("<Bank>"));
  // 降级成纯文本时读者看到的还是原文。
  assert.match(stripHtml(row.text), /A & B <Bank>/);
  db.close();
});
