// 封禁 / 解封 / 归档 / 删除流水 / 恢复流水的确认框要写清楚「动的是哪一个」。
//
// 2026-11-06 员工演练：确认框只写「账单流水 #1848」「封禁支付渠道」，看不出是哪个户口、
// 哪笔钱、哪个单号；同名户口（三个都叫 TEST BANK）更是只能靠记忆。解封还完全没有确认。
// public/js/operation-target.js 负责把这一行拼出来；它是租户数据，页面上标 translate="no"。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ledgerTargetDetail, bankTargetDetail } = require("../../public/js/operation-target");

test("流水：时间、状态、金额、TRANS ID、客户、户口都在", () => {
  const text = ledgerTargetDetail(
    { entry_time: "2026-11-06 14:10:33", status: "deposit", amount_in: 1250, tx_id: "17165863553", username: "amy" },
    { statusLabel: "DEPOSIT", name: "Amy Lee", bankLabel: "7. Ubank MAT (MATTHEW FORRES)" }
  );
  assert.equal(text, "2026-11-06 14:10 · DEPOSIT · IN 1,250.00 · TRANS ID 17165863553 · amy / Amy Lee · 7. Ubank MAT (MATTHEW FORRES)");
});

test("流水：出账显示负号，HELP TRF 计入金额；不绑户口就不写户口", () => {
  const text = ledgerTargetDetail(
    { entry_time: "2026-11-06 09:00:00", status: "withdraw", amount_out: 0, help_amount: 40 },
    { statusLabel: "WITHDRAW" }
  );
  assert.equal(text, "2026-11-06 09:00 · WITHDRAW · OUT -40.00");
});

test("流水：数据库里出账存正数或负数都显示成 OUT -x", () => {
  assert.match(ledgerTargetDetail({ status: "wrong", amount_out: 150 }, {}), /OUT -150\.00/);
  assert.match(ledgerTargetDetail({ status: "wrong", amount_out: -150 }, {}), /OUT -150\.00/);
});

test("渠道：户口标签、户名、BSB、账号、余额；余额 0 不写成 -0.00", () => {
  const text = bankTargetDetail(
    { account_name: "MATTHEW FORREST", bsb: "062-000", account_number: "1234 5678" },
    { label: "7. Ubank MATTHEW", balance: -0.001 }
  );
  assert.equal(text, "7. Ubank MATTHEW · MATTHEW FORREST · BSB 062-000 · ACC 1234 5678 · BAL 0.00");
});

test("渠道：同名户口靠户名和账号区分", () => {
  const a = bankTargetDetail({ account_name: "TEST-PK7-1", account_number: "111" }, { label: "TEST BANK", balance: 0 });
  const b = bankTargetDetail({ account_name: "TEST-PK7-2", account_number: "222" }, { label: "TEST BANK", balance: 0 });
  assert.notEqual(a, b);
});

test("页面接入：删除/恢复/封禁/解封/归档都带明细，明细不翻译", () => {
  const src = ["bank-ledger.js", "bank-channels.js", "bank-common.js"].map((f) => fs.readFileSync(path.join(__dirname, "../../public/js", f), "utf8")).join("\n");
  assert.match(src, /window\.ledgerTargetDetail\(/);
  assert.match(src, /window\.bankTargetDetail\(/);
  assert.match(src, /target: `账单流水 #\$\{id\}`,\s*detail: ledgerTargetFor\(/, "删除流水要带明细");
  assert.match(src, /target: `已删除流水 #\$\{id\}`,\s*detail: ledgerTargetFor\(/, "恢复流水要带明细");
  for (const btn of ["ban", "unban", "archive"]) {
    assert.match(src, new RegExp(`target: bankTargetFor\\(${btn}\\.dataset\\.id\\)`), `${btn} 要带户口明细`);
  }
  assert.match(src, /bkd-unban-btn[\s\S]{0,400}showConfirmDialog/, "解封要先确认");
  const app = fs.readFileSync(path.join(__dirname, "../../public/js/app.js"), "utf8");
  assert.match(app, /id="app-dialog-target"[^>]*translate="no"/);
  const page = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
  assert.match(page, /id="reason-modal-detail"[^>]*translate="no"|translate="no"[^>]*id="reason-modal-detail"/);
  assert.ok(page.indexOf("/js/operation-target.js") > 0 && page.indexOf("/js/operation-target.js") < page.indexOf("/js/bank-ledger.js?"));
});
