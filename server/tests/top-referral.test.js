// TOP REFERRAL（MONTHLY REPORT › TOP REFERRAL）口径。每条定义见仓库根目录 CONTEXT.md「推荐人月报」一节。
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { computeTopReferral, computeReferrerDetail } = require("../lib/topReferral");

function referralDatabase() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE customers (
      company_id TEXT NOT NULL, id TEXT NOT NULL,
      username TEXT DEFAULT '', name TEXT DEFAULT '', mobile TEXT DEFAULT '', referrer TEXT DEFAULT '',
      register_date_key TEXT DEFAULT '',
      PRIMARY KEY (company_id, id)
    );
    CREATE TABLE transactions (
      company_id TEXT NOT NULL, id TEXT NOT NULL,
      type TEXT DEFAULT '', customer_id TEXT DEFAULT '',
      username TEXT DEFAULT '', name TEXT DEFAULT '', mobile TEXT DEFAULT '',
      amount REAL DEFAULT 0, status TEXT DEFAULT 'COMPLETED',
      created_at TEXT DEFAULT '', created_date TEXT DEFAULT '',
      PRIMARY KEY (company_id, id)
    );
  `);
  return db;
}

let seq = 0;

/** 一个下线客户。opts.company 默认 alpha。 */
function addCustomer(db, referrer, registerDate, opts = {}) {
  const id = opts.id || `c${++seq}`;
  db.prepare(
    "INSERT INTO customers (company_id, id, username, name, mobile, referrer, register_date_key) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(opts.company || "alpha", id, opts.username || `user${seq}`, opts.name || `Name ${seq}`, opts.mobile || "", referrer, registerDate);
  return id;
}

/** 一笔平台交易。time 是 "YYYY-MM-DD HH:MM"，created_date 取前 10 位。 */
function addTx(db, customerId, type, amount, time, opts = {}) {
  db.prepare(
    `INSERT INTO transactions (company_id, id, type, customer_id, username, name, mobile, amount, created_at, created_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.company || "alpha", `t${++seq}`, type, customerId, opts.username || "", opts.name || "", opts.mobile || "",
    amount, opts.createdAt ?? time, time.slice(0, 10)
  );
}

const NOV = { month: "2026-11", today: "2026-11-20" };

function row(report, referrer) {
  const r = report.rows.find((x) => x.referrer === referrer);
  assert.ok(r, `排行里没有 ${referrer}：${report.rows.map((x) => x.referrer).join(",")}`);
  return r;
}

test("NEW MEMBER = 本期注册的下线人数；默认按它从高到低排名；没有推荐人的归自然流量，不给名次", () => {
  const db = referralDatabase();
  addCustomer(db, "PK7", "2026-11-02");
  addCustomer(db, "EZ68", "2026-11-03");
  addCustomer(db, "EZ68", "2026-11-30");
  addCustomer(db, "EZ68", "2026-10-31"); // 上个月注册，不算
  addCustomer(db, "  PK7 ", "2026-11-05"); // 首尾空格与 PK7 是同一个推荐人
  addCustomer(db, "", "2026-11-05");
  addCustomer(db, null, "2026-11-06");
  addCustomer(db, "", "2026-11-07");

  const report = computeTopReferral(db, "alpha", NOV);
  assert.deepEqual(
    report.rows.map((r) => [r.rank, r.referrer, r.newMember]),
    [
      [1, "EZ68", 2],
      [2, "PK7", 2],
    ]
  );
  assert.equal(report.organic.newMember, 3);
  assert.equal(report.total.newMember, 7);
});

/** EZ68 名下四个下线，覆盖首充在本期 / 首充在上期 / 首充在月末最后一天三种情况。 */
function depositScenario() {
  const db = referralDatabase();
  const a = addCustomer(db, "EZ68", "2026-10-20");
  addTx(db, a, "DEPOSIT", 30, "2026-11-03 14:00"); // 先插入但时间晚：首笔看时间，不看插入顺序
  addTx(db, a, "DEPOSIT", 50, "2026-11-03 10:00");
  addTx(db, a, "DEPOSIT", 100, "2026-11-10 09:00");
  const b = addCustomer(db, "EZ68", "2026-11-05");
  addTx(db, b, "DEPOSIT", 20, "2026-11-05 09:00");
  addTx(db, b, "DEPOSIT", 15, "2026-11-05 22:00");
  const c = addCustomer(db, "EZ68", "2026-09-01");
  addTx(db, c, "DEPOSIT", 500, "2026-10-15 12:00"); // 首充在上个月
  addTx(db, c, "DEPOSIT", 40, "2026-11-12 12:00");
  addTx(db, c, "DEPOSIT", 60, "2026-11-13 12:00");
  const d = addCustomer(db, "EZ68", "2026-10-01");
  addTx(db, d, "DEPOSIT", 10, "2026-11-30 23:00");
  addTx(db, d, "DEPOSIT", 99, "2026-12-01 00:10"); // 下个月，不算
  return { db, ids: { a, b, c, d } };
}

test("FIRST DEPOSIT = 首笔充值落在本期的人数与首笔那一单；FIRST DAY = 这些人首充当天的全部充值；REGULAR = 本期其余充值", () => {
  const { db } = depositScenario();
  const ez = row(computeTopReferral(db, "alpha", NOV), "EZ68");
  assert.equal(ez.firstDepCount, 3);
  assert.equal(ez.firstDepAmount, 80);
  assert.equal(ez.firstDayCount, 5);
  assert.equal(ez.firstDayAmount, 125);
  assert.equal(ez.regularCount, 3);
  assert.equal(ez.regular, 200);
  assert.equal(ez.depCount, 8);
  assert.equal(ez.dep, 325);
});

test("SAME DAY = 注册当天就首充、且那天在本期内的下线；金额是他们那一天的全部充值", () => {
  const { db } = depositScenario(); // 只有 b 是注册当天首充（11-05，两笔共 35）
  const e = addCustomer(db, "EZ68", "2026-10-31");
  addTx(db, e, "DEPOSIT", 70, "2026-10-31 20:00"); // 注册当天首充，但在上个月
  addTx(db, e, "DEPOSIT", 5, "2026-11-01 08:00");

  const ez = row(computeTopReferral(db, "alpha", NOV), "EZ68");
  assert.equal(ez.sameDayUsers, 1);
  assert.equal(ez.sameDayAmount, 35);
});

test("TOTAL WITHDRAW 照平台显示为负数；TOTAL NET = 充值 + 提现；只有提现的推荐人也上榜", () => {
  const { db, ids } = depositScenario();
  addTx(db, ids.a, "WITHDRAW", 120, "2026-11-15 10:00");
  addTx(db, ids.a, "WITHDRAW", 50, "2026-10-30 10:00"); // 上个月，不算
  addTx(db, ids.c, "WITHDRAW", 30.5, "2026-11-20 10:00");
  const f = addCustomer(db, "RX66", "2026-08-01");
  addTx(db, f, "WITHDRAW", 20, "2026-11-02 10:00");

  const report = computeTopReferral(db, "alpha", NOV);
  const ez = row(report, "EZ68");
  assert.equal(ez.wdCount, 2);
  assert.equal(ez.wd, -150.5);
  assert.equal(ez.net, 174.5);
  const rx = row(report, "RX66");
  assert.deepEqual([rx.newMember, rx.depCount, rx.wdCount, rx.wd, rx.net], [0, 0, 1, -20, -20]);
});

test("test 账号（username 或姓名含 test，不分大小写）的充值提现全部排除，与全站 WIN/LOSE 同口径；NEW MEMBER 照常计入", () => {
  const db = referralDatabase();
  const t1 = addCustomer(db, "PK7", "2026-11-02", { username: "pk7TEST01" });
  addTx(db, t1, "DEPOSIT", 100, "2026-11-02 10:00");
  addTx(db, t1, "WITHDRAW", 40, "2026-11-03 10:00");
  const t2 = addCustomer(db, "PK7", "2026-11-02", { name: "Test Account" });
  addTx(db, t2, "DEPOSIT", 200, "2026-11-02 10:00");
  const real = addCustomer(db, "PK7", "2026-11-02");
  addTx(db, real, "DEPOSIT", 50, "2026-11-02 11:00");

  const pk = row(computeTopReferral(db, "alpha", NOV), "PK7");
  assert.equal(pk.newMember, 3);
  assert.deepEqual([pk.firstDepCount, pk.firstDepAmount, pk.depCount, pk.dep], [1, 50, 1, 50]);
  assert.deepEqual([pk.wdCount, pk.wd, pk.net], [0, 0, 50]);
});

test("交易缺 customer_id 时按手机号归到客户（与全站 WIN/LOSE 的 CUSTOMER_JOIN 同口径），首充与 test 判据都跟着走", () => {
  const db = referralDatabase();
  const a = addCustomer(db, "PK7", "2026-10-01", { mobile: "0400111222" });
  addTx(db, "", "DEPOSIT", 30, "2026-10-20 10:00", { mobile: "0400111222" }); // 首充在上个月，只能靠手机号认出来
  addTx(db, a, "DEPOSIT", 50, "2026-11-03 10:00");
  addTx(db, "", "WITHDRAW", 20, "2026-11-04 10:00", { mobile: "0400111222" });
  const t = addCustomer(db, "PK7", "2026-10-01", { mobile: "0400999888", username: "pk7test" });
  addTx(db, "", "DEPOSIT", 70, "2026-11-05 10:00", { mobile: "0400999888" }); // test 账号，靠手机号认出后排除

  const pk = row(computeTopReferral(db, "alpha", NOV), "PK7");
  assert.deepEqual([pk.firstDepCount, pk.depCount, pk.dep, pk.regular], [0, 1, 50, 50]);
  assert.deepEqual([pk.wdCount, pk.wd], [1, -20]);
});

test("首笔按日期键优先：created_at 缺失的单子不会因为空串排在最前而被当成首笔", () => {
  const db = referralDatabase();
  const a = addCustomer(db, "PK7", "2026-10-01");
  addTx(db, a, "DEPOSIT", 40, "2026-10-15 10:00");
  addTx(db, a, "DEPOSIT", 90, "2026-11-02 10:00", { createdAt: "" });

  const pk = row(computeTopReferral(db, "alpha", NOV), "PK7");
  assert.equal(pk.firstDepCount, 0);
  assert.equal(pk.regular, 90);
});

test("排序可选 NEW MEMBER / 首充人数 / TOTAL DEPOSIT / TOTAL NET，名次跟着排序重排；不认识的排序回退 NEW MEMBER", () => {
  const db = referralDatabase();
  for (let i = 0; i < 3; i++) addCustomer(db, "AAA", "2026-11-01");
  const b1 = addCustomer(db, "BBB", "2026-11-01");
  addTx(db, b1, "DEPOSIT", 10, "2026-11-01 10:00");
  const b2 = addCustomer(db, "BBB", "2026-10-01");
  addTx(db, b2, "DEPOSIT", 20, "2026-11-02 10:00");
  const c = addCustomer(db, "CCC", "2026-10-01");
  addTx(db, c, "DEPOSIT", 1, "2026-10-02 10:00");
  addTx(db, c, "DEPOSIT", 500, "2026-11-03 10:00");
  addTx(db, c, "WITHDRAW", 600, "2026-11-04 10:00");
  const d = addCustomer(db, "DDD", "2026-10-01");
  addTx(db, d, "DEPOSIT", 1, "2026-10-02 10:00");
  addTx(db, d, "DEPOSIT", 100, "2026-11-03 10:00");

  const order = (sort) => computeTopReferral(db, "alpha", { ...NOV, sort }).rows.map((r) => `${r.rank}${r.referrer}`);
  assert.deepEqual(order("newMember"), ["1AAA", "2BBB", "3CCC", "4DDD"]);
  assert.deepEqual(order("firstDep"), ["1BBB", "2AAA", "3CCC", "4DDD"]);
  assert.deepEqual(order("dep"), ["1CCC", "2DDD", "3BBB", "4AAA"]);
  assert.deepEqual(order("net"), ["1DDD", "2BBB", "3AAA", "4CCC"]);
  assert.deepEqual(order("bogus"), order("newMember"));
  assert.equal(computeTopReferral(db, "alpha", { ...NOV, sort: "bogus" }).sort, "newMember");
});

test("只读本公司：别家同 id 的客户与交易、别家的推荐人都不进来；搜索名单含本公司全部推荐人（本期没动静的也在），不含自然流量", () => {
  const db = referralDatabase();
  const mine = addCustomer(db, "PK7", "2026-11-02", { id: "shared" });
  addTx(db, mine, "DEPOSIT", 10, "2026-11-02 10:00");
  addCustomer(db, "quiet one", "2025-01-01"); // 本期没有动静
  addCustomer(db, "", "2025-01-01");
  addCustomer(db, "PK7", "2026-11-02", { id: "shared", company: "beta" });
  addTx(db, "shared", "DEPOSIT", 999, "2026-11-01 08:00", { company: "beta" });
  addCustomer(db, "BETA ONLY", "2026-11-03", { company: "beta" });

  const report = computeTopReferral(db, "alpha", NOV);
  assert.deepEqual(report.rows.map((r) => r.referrer), ["PK7"]);
  const pk = row(report, "PK7");
  assert.deepEqual([pk.newMember, pk.firstDepAmount, pk.dep], [1, 10, 10]);
  assert.deepEqual(report.referrers, ["PK7", "quiet one"]);
});

test("年视图 = 全年合计：日界是 1 月 1 日到 12 月 31 日；TOTAL 含自然流量，金额按分累加不出浮点残差", () => {
  const db = referralDatabase();
  const a = addCustomer(db, "PK7", "2025-12-31");
  addTx(db, a, "DEPOSIT", 0.1, "2025-12-31 23:00"); // 去年，不算；也让 a 的首充落在去年
  addTx(db, a, "DEPOSIT", 0.2, "2026-01-01 00:05");
  addTx(db, a, "DEPOSIT", 0.1, "2026-12-31 23:59");
  const b = addCustomer(db, "", "2026-03-15");
  addTx(db, b, "DEPOSIT", 0.2, "2026-03-15 10:00");
  addTx(db, b, "WITHDRAW", 0.1, "2026-06-01 10:00");

  const report = computeTopReferral(db, "alpha", { year: "2026", today: "2026-11-20" });
  assert.equal(report.view, "year");
  assert.equal(report.period, "2026");
  const pk = row(report, "PK7");
  assert.deepEqual([pk.newMember, pk.firstDepCount, pk.depCount, pk.dep], [0, 0, 2, 0.3]);
  assert.deepEqual([report.organic.newMember, report.organic.firstDepCount, report.organic.sameDayUsers], [1, 1, 1]);
  const t = report.total;
  assert.deepEqual([t.newMember, t.depCount, t.dep, t.wd, t.net], [1, 3, 0.5, -0.1, 0.4]);
});

test("抽屉：指标与排行里同一个推荐人逐格相等；下线名单只列本期有动静的人，按本期充值额从高到低", () => {
  const { db, ids } = depositScenario();
  addTx(db, ids.a, "WITHDRAW", 120, "2026-11-15 10:00");
  addTx(db, ids.c, "WITHDRAW", 30.5, "2026-11-20 10:00");
  addCustomer(db, "EZ68", "2026-06-01"); // 本期没动静，不进名单
  addCustomer(db, "PK7", "2026-11-02"); // 别的推荐人

  const detail = computeReferrerDetail(db, "alpha", { ...NOV, referrer: "EZ68" });
  const { rank, referrer, ...rankingMetrics } = row(computeTopReferral(db, "alpha", NOV), "EZ68");
  assert.equal(detail.referrer, "EZ68");
  assert.deepEqual(detail.metrics, rankingMetrics);
  assert.deepEqual(
    detail.downlines.map((d) => [d.id, d.registerDate, d.firstDepDate, d.firstDepAmount, d.dep, d.wd, d.net]),
    [
      [ids.a, "2026-10-20", "2026-11-03", 50, 180, -120, 60],
      [ids.c, "2026-09-01", "2026-10-15", 500, 100, -30.5, 69.5],
      [ids.b, "2026-11-05", "2026-11-05", 20, 35, 0, 35],
      [ids.d, "2026-10-01", "2026-11-30", 10, 10, 0, 10],
    ]
  );
  assert.equal(detail.downlines[0].username, "user" + ids.a.slice(1));
});

test("抽屉：自然流量用 __organic__ 打开；本期没动静或不存在的推荐人返回全 0 与空名单，不报错", () => {
  const db = referralDatabase();
  const o = addCustomer(db, "", "2026-11-02");
  addTx(db, o, "DEPOSIT", 25, "2026-11-02 10:00");
  addCustomer(db, "quiet one", "2025-01-01");

  const organic = computeReferrerDetail(db, "alpha", { ...NOV, referrer: "__organic__" });
  assert.equal(organic.organic, true);
  assert.deepEqual(organic.downlines.map((d) => d.id), [o]);
  assert.equal(organic.metrics.dep, 25);

  for (const name of ["quiet one", "nobody"]) {
    const quiet = computeReferrerDetail(db, "alpha", { ...NOV, referrer: name });
    assert.equal(quiet.metrics.newMember, 0);
    assert.equal(quiet.metrics.net, 0);
    assert.deepEqual(quiet.downlines, []);
  }
});
