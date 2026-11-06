// 封禁户「下载」改成给银行申诉用的导出（2026-11-06 与用户确认用途）。
//
// 员工演练：按钮叫「下载 Excel」实为 CSV，只有最近 10 笔入账 + 10 笔出账，没有户口抬头、
// 没有日期范围，还混着内部调钱行——拿去银行申诉不够用。
// 现在：这个户口**全部客户入账**（deposit / new / amopay / unclaim，amount_in > 0），排除内部
// 调钱（BANK TRANSFER、CASH IN、带 transfer_group_id 的行），带户口抬头、期间、笔数、合计。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { appealDeposits } = require("../lib/appealExport");
const { buildAppealCsv } = require("../../public/js/appeal-csv");
const { bankDatabase, addAccount, addLedger } = require("./bank-fixture");

function setup() {
  const db = bankDatabase();
  const acc = addAccount(db, { account_name: "SAHMARA KIRBY", lifecycle_status: "banned", active: 0 });
  addLedger(db, acc, 100, "2026-10-02", { status: "deposit", tx_id: "T1", username: "amy" });
  addLedger(db, acc, 50, "2026-10-01", { status: "new", tx_id: "T0", username: "bob" });
  addLedger(db, acc, 30, "2026-10-03", { status: "unclaim" });
  addLedger(db, acc, 0, "2026-10-03", { status: "bank transfer", trf_amount: 2140, c_status: "LH" });
  addLedger(db, acc, 500, "2026-10-04", { status: "cash in", c_status: "RX66" });
  addLedger(db, acc, 0, "2026-10-04", { status: "withdraw", amount_out: 80 });
  db.prepare("UPDATE bank_ledger SET transfer_group_id = 'g1' WHERE tx_id = '' AND status = 'unclaim'").run();
  addLedger(db, acc, 70, "2026-10-05", { status: "deposit", tx_id: "T2" });
  return { db, acc };
}

test("只取客户入账，按时间正序；内部调钱、出账、带调钱组号的都不要", () => {
  const { db, acc } = setup();
  const rows = appealDeposits(db, "alpha", acc);
  assert.deepEqual(rows.map((r) => r.tx_id), ["T0", "T1", "T2"]);
});

test("公司隔离：别家拿不到我的户口", () => {
  const { db, acc } = setup();
  assert.equal(appealDeposits(db, "beta", acc), null);
});

test("CSV：户口抬头、期间、笔数、合计，然后明细", () => {
  const bank = { bank_branch: "8. Ubank SAHMARA", account_name: "SAHMARA KIRBY", bsb: "082-001", account_number: "9876 5432", payid: "" };
  const rows = [
    { entry_time: "2026-10-01 10:00:00", amount_in: 50, tx_id: "T0", username: "bob", name: "Bob Tan", status: "new" },
    { entry_time: "2026-10-02 11:30:00", amount_in: 1250.5, tx_id: "T1", username: "amy", name: "Amy, Lee", status: "deposit" },
  ];
  const csv = buildAppealCsv(bank, rows);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "Account,8. Ubank SAHMARA");
  assert.ok(lines.includes("Account name,SAHMARA KIRBY"));
  assert.ok(lines.includes("BSB,082-001"));
  assert.ok(lines.includes("Account number,9876 5432"));
  assert.ok(lines.includes("Period,2026-10-01 to 2026-10-02"));
  assert.ok(lines.includes("Deposits,2"));
  assert.ok(lines.includes("Total,1300.50"));
  const head = lines.indexOf("DATE,TIME,AMOUNT,TRANS ID,USERNAME,NAME,STATUS");
  assert.ok(head > 0);
  assert.equal(lines[head + 1], "2026-10-01,10:00,50.00,T0,bob,Bob Tan,NEW");
  assert.equal(lines[head + 2], '2026-10-02,11:30,1250.50,T1,amy,"Amy, Lee",DEPOSIT');
});

test("CSV 防公式注入：以 = + - @ 开头的文本前面加单引号", () => {
  const csv = buildAppealCsv({ bank_branch: "X" }, [
    { entry_time: "2026-10-01 10:00:00", amount_in: 5, tx_id: "T", username: "=HYPERLINK(1)", name: "+cmd", status: "deposit" },
  ]);
  assert.match(csv, /,'=HYPERLINK\(1\),'\+cmd,/);
});

test("没有入账：照样有抬头，期间写 -，合计 0.00", () => {
  const csv = buildAppealCsv({ bank_branch: "X" }, []);
  assert.match(csv, /Period,-/);
  assert.match(csv, /Deposits,0/);
  assert.match(csv, /Total,0\.00/);
});

test("页面接入：按钮叫「下载申诉记录 (CSV)」，走新接口；路由只认 req.companyId", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../public/js/bank-accounts.js"), "utf8");
  assert.doesNotMatch(src, /下载 Excel/);
  assert.match(src, /下载申诉记录 \(CSV\)/);
  assert.match(src, /\/api\/banks\/\$\{[^}]+\}\/appeal-deposits/);
  assert.match(src, /window\.buildAppealCsv\(/);
  const routes = fs.readFileSync(path.join(__dirname, "../routes/banks.js"), "utf8");
  assert.match(routes, /router\.get\("\/:id\/appeal-deposits"[\s\S]{0,200}appealDeposits\(getDb\(\), companyId\(req\)/);
  const page = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
  const at = page.indexOf("/js/appeal-csv.js");
  assert.ok(at > 0 && at < page.indexOf("/js/bank-accounts.js?"));
});
