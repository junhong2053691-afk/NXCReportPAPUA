// 员工演练点名的 i18n 漏翻（2026-11-06）：
//   - 中文模式下「已跳过」空页是英文「No skipped platform orders」、按钮是「Restore」
//   - 渠道栏的状态标是英文「Active / Inactive」，提示也是英文
//   - 快捷键提示 <kbd>Enter</kbd> 在中文模式被反向字典翻成「请输入」（「请输入×2 保存」）
//   - 渠道操作历史显示原始事件码与类型码（banned / created … nominee）
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { accountEventLabel, accountKindLabel } = require("../../public/js/display-format");
const { I18N } = require("../../public/js/i18n");

const src = fs.readFileSync(path.join(__dirname, "../../public/js/bank-accounts.js"), "utf8");
const page = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");

test("操作历史的事件码与类型码转成中文，且都在中英字典里", () => {
  const events = { created: "新建", updated: "修改", banned: "封禁", unbanned: "解封", archived: "归档", unarchived: "取消归档" };
  for (const [code, zh] of Object.entries(events)) {
    assert.equal(accountEventLabel(code), zh);
    assert.ok(I18N.zh[zh] !== undefined && I18N.en[zh], `${zh} 要进字典`);
  }
  assert.equal(accountEventLabel("something_new"), "something_new", "认不出的原样显示");
  assert.equal(accountKindLabel("nominee"), "人头");
  assert.equal(accountKindLabel("ghost"), "幽灵");
  assert.equal(accountKindLabel("payment_gateway"), "PaymentGateway");
  assert.equal(accountKindLabel(""), "");
});

test("页面不再写死英文：已跳过空页、恢复按钮、渠道状态标", () => {
  assert.doesNotMatch(src, /No skipped platform orders/);
  assert.doesNotMatch(src, />Restore<\/button>/);
  assert.doesNotMatch(src, />Active<\/span>/);
  assert.doesNotMatch(src, />Inactive<\/span>/);
  assert.match(src, /accountEventLabel\(e\.event\)/);
});

test("快捷键名标 translate=no，不被反向字典翻成「请输入」", () => {
  const hint = page.slice(page.indexOf('class="sheet-grid-hint"'), page.indexOf("</span></div>", page.indexOf('class="sheet-grid-hint"')));
  assert.ok(hint.length > 0);
  assert.doesNotMatch(hint, /<kbd>/, "每个 <kbd> 都要带 translate=\"no\"");
});
