// C STATUS 不能填本公司。
//
// C STATUS 记的是「我方与对方公司之间的往来」，填自己既没有对手也对不了平，只会在 C STATUS 表
// 里多出一行永远不归零的数。2026-11-06 员工演练：aussiex6 的 C STATUS 选项里甚至有
// 「AuX6 → aussiex6」这种自指项；EzSpin68 救封禁户余额时 C STATUS 只能填 EZ68（本公司）；
// 拆分调钱的协助方输入框 placeholder 写的「例如 EZ」在 EzSpin68 自己页面上就是在教人填自己。
//
// 「本公司的名字」= 任何公司（含自己）把 target_company_id 指向本公司的那些 C STATUS 名
// （别家怎么叫我）。纯外部往来方（如 LH）没有关联公司，不受影响。
const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureAuditSchema } = require("../lib/auditLog");
const {
  selfCStatusNames, assertNotSelfCStatus, upsertCStatusOption, submitTransfer, listCStatusOptions,
} = require("../lib/bankApply");
const { bankDatabase, addCompany, addAccount, addCStatusOption } = require("./bank-fixture");

const actor = { type: "user", userId: 1, username: "ops", name: "Ops", role: "operator" };

function setup() {
  const db = bankDatabase();
  ensureAuditSchema(db);
  addCompany(db, { id: "alpha", name: "EzSpin68" });
  addCompany(db, { id: "beta", name: "Rolex66" });
  addCStatusOption(db, "alpha", "RX66", "beta");
  addCStatusOption(db, "alpha", "LH", "");
  addCStatusOption(db, "beta", "EZ68", "alpha");
  return db;
}

test("别家怎么叫我，那个名字在我这里就是本公司", () => {
  const db = setup();
  assert.deepEqual([...selfCStatusNames(db, "alpha")], ["ez68"]);
  assert.deepEqual([...selfCStatusNames(db, "beta")], ["rx66"]);
});

test("填本公司的名字（大小写、空白、多值都算）拒绝；对方和外部往来方照常", () => {
  const db = setup();
  for (const v of ["EZ68", " ez68 ", "RX66 / EZ68"]) {
    assert.throws(() => assertNotSelfCStatus(db, "alpha", v), (e) => e.status === 400 && /本公司/.test(e.message), v);
  }
  assert.doesNotThrow(() => assertNotSelfCStatus(db, "alpha", "RX66"));
  assert.doesNotThrow(() => assertNotSelfCStatus(db, "alpha", "LH"));
  assert.doesNotThrow(() => assertNotSelfCStatus(db, "alpha", ""));
});

test("C STATUS 选项不能关联本公司", () => {
  const db = setup();
  assert.throws(() => upsertCStatusOption(db, "alpha", "AuX", "alpha"), (e) => e.status === 400);
  assert.doesNotThrow(() => upsertCStatusOption(db, "alpha", "AuX", "beta"));
});

test("调钱填本公司 C STATUS：拒绝，不落流水", () => {
  const db = setup();
  const acc = addAccount(db);
  assert.throws(
    () => submitTransfer(db, "alpha", { direction: "out", status: "bank trf", amount: 10, bank_account_id: acc, c_status: "EZ68" }, actor),
    (e) => e.status === 400
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM bank_ledger").get().n, 0);
});

test("选项列表把本公司的名字标成 is_self（录入下拉藏掉，管理页仍能看到并删除）", () => {
  const db = setup();
  addCStatusOption(db, "alpha", "EZ68", "alpha");
  const opts = Object.fromEntries(listCStatusOptions(db, "alpha").map((o) => [o.name, o.is_self]));
  assert.deepEqual(opts, { RX66: 0, LH: 0, EZ68: 1 });
  const page = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../public/js/bank-accounts.js"), "utf8");
  assert.match(page, /function cStatusNames\(\)[\s\S]{0,300}is_self/, "录入用的 datalist 要过滤 is_self");
});

test("页面接入：手工流水新增 / 改 C STATUS 时校验；拆分协助方 placeholder 不再写「例如 EZ」", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const routes = fs.readFileSync(path.join(__dirname, "../routes/banks.js"), "utf8");
  assert.ok((routes.match(/assertNotSelfCStatus\(/g) || []).length >= 2, "POST 与 PUT /ledger 都要校验");
  const page = fs.readFileSync(path.join(__dirname, "../../public/js/bank-accounts.js"), "utf8");
  assert.doesNotMatch(page, /placeholder="例如 EZ"/);
});
