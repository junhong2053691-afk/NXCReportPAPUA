// 后台轮询「数据没变就不重绘」的闸门——纯函数，DOM 留在 bank-accounts.js。
//
// 2026-11-06 员工演练（4/4）：支付渠道页每 5 秒无条件整表重绘，按钮在点下去之前就被替换
// （点击落空）、行内下拉位置跳。现在后台刷新拿到数据先算签名，和上次画的一样就不画。
//
// ⚠️ 只给**后台轮询**用。员工自己触发的加载（保存、切日期、切渠道）一律照画：保存后要把
// 编辑行换回只读行，数据一模一样也必须重画。前台画完调 remember，后台下一轮才不会白画一次。
function createRenderGate() {
  const last = new Map();
  const sigOf = (data) => {
    try { return JSON.stringify(data); } catch (_) { return String(Math.random()); }
  };
  return {
    // 与上次记下的不同 → 记下并返回 true（该画）；相同 → false（跳过）。
    changed(key, data) {
      const sig = sigOf(data);
      if (last.get(key) === sig) return false;
      last.set(key, sig);
      return true;
    },
    remember(key, data) {
      last.set(key, sigOf(data));
    },
  };
}

if (typeof window !== "undefined") window.createRenderGate = createRenderGate;
if (typeof module !== "undefined" && module.exports) module.exports = { createRenderGate };
