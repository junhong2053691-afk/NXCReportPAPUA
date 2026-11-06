// 点弹窗外的遮罩要不要关弹窗——纯函数，DOM 与事件留在 app.js 的 registerModalOverlay。
//
// 返回：
//   "dismiss"  关（走 requestModalDismiss，等同点「取消」）
//   "keep"     不关，提示 KEEP_MESSAGE：员工动过表单，关了就把填的内容全丢了
//   "ignore"   这次点击与遮罩无关，什么都不做
//
// 2026-11-06 员工演练：600–768 高的屏幕上「保存」按钮压在弹窗底边，点偏一点就落在遮罩上，
// 弹窗静默关闭、内容全丢、没有任何提示（Pokies7Bet 5 次）。「动过」只认用户真实的
// input/change 事件（isTrusted），脚本回填的值不算——所以打开时预填好的弹窗照样一点就关。
const KEEP_MESSAGE = "有未保存的内容，请点「取消」关闭";

function backdropDismissDecision(state) {
  const s = state || {};
  if (!s.startedOnBackdrop || !s.endedOnBackdrop || !s.isTop) return "ignore";
  return s.dirty ? "keep" : "dismiss";
}

if (typeof window !== "undefined") {
  window.modalBackdropDecision = backdropDismissDecision;
  window.MODAL_KEEP_MESSAGE = KEEP_MESSAGE;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { backdropDismissDecision, KEEP_MESSAGE };
}
