// 点弹窗外的遮罩要不要关弹窗（public/js/modal-guard.js）。
//
// 2026-11-06 员工演练：600–768 高的屏幕上弹窗比屏幕高，「保存」按钮压在底边，点偏一点就落在
// 遮罩上 → 弹窗静默关闭、填的内容全丢、没有任何提示（Pokies7Bet 5 次；EzSpin68 另有 3 次
// 「点了保存弹窗关了但没提交」）。规则：员工动过表单就不让遮罩关它，必须点「取消」/「×」。
// 布局那一半（按钮条吸底）在 style.css，这里守行为那一半。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { backdropDismissDecision } = require("../../public/js/modal-guard");

const base = { startedOnBackdrop: true, endedOnBackdrop: true, isTop: true, dirty: false };

test("没动过表单：点遮罩照旧关闭", () => {
  assert.equal(backdropDismissDecision(base), "dismiss");
});

test("动过表单：点遮罩不关，提示去点取消", () => {
  assert.equal(backdropDismissDecision({ ...base, dirty: true }), "keep");
});

test("按下在弹窗里、松开在遮罩上（拖选文字、点偏保存按钮）：什么都不做", () => {
  assert.equal(backdropDismissDecision({ ...base, startedOnBackdrop: false }), "ignore");
  assert.equal(backdropDismissDecision({ ...base, endedOnBackdrop: false }), "ignore");
});

test("不是最上层弹窗：什么都不做", () => {
  assert.equal(backdropDismissDecision({ ...base, isTop: false }), "ignore");
});

test("提示文案进了中英两份字典", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../public/js/modal-guard.js"), "utf8");
  const msg = src.match(/KEEP_MESSAGE = "([^"]+)"/)[1];
  const { I18N } = require("../../public/js/i18n");
  assert.equal(I18N.zh[msg], msg);
  assert.ok(I18N.en[msg] && I18N.en[msg] !== msg);
});

test("modal-guard.js 在 app.js 之前注入", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
  const guard = html.indexOf("/js/modal-guard.js");
  assert.ok(guard > 0, "页面要加载 modal-guard.js");
  assert.ok(guard < html.indexOf("/js/app.js?"), "必须在 app.js 之前");
});
