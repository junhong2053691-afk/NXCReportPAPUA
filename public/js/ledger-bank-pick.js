// 流水表保存时 BANK ACC 怎么定——纯函数，DOM 读取留在 bank-accounts.js 的 rowBankId。
//
// 返回：
//   { mode: "keep" }        编辑已有行且 BANK ACC 没动：请求里不带 bank_account_id，服务端原样保留
//   { mode: "set", id }     绑到 id（0 = 解绑）
//   { mode: "invalid" }     打了认不出的户口名：让员工从下拉选，绝不静默兜底
//
// ⚠️ 已有行**永远不能**走「当前筛选户口 / 第一个运营户口」兜底。2026-11-06 员工演练：编辑一行
// 不绑户口的开销、只改 OTHER，保存后被绑到第一个户口、余额被扣；封禁户的历史行也一样——
// 封禁户不在 usableBanks() 里，标签匹配不上，于是被改绑到某个运营户口。那个兜底只属于新增行。
function resolveRowBank(input) {
  const o = input || {};
  const text = String(o.text || "").trim();
  if (o.cleared) return { mode: "set", id: 0 };

  if (o.isExisting) {
    // 「没动」必须排在任何标签匹配之前：封禁户的行显示成「1. TEST BANK (…)」，序号前缀
    // 曾被匹配成运营列表第 1 个户口，验证修复时就这样把 #1875 改绑走了。
    if (text === String(o.origText || "").trim()) return { mode: "keep" };
    if (o.matchedId) return { mode: "set", id: Number(o.matchedId) };
    if (!text) return { mode: "set", id: 0 };
    const label = String(o.datasetLabel || "");
    if (o.datasetBankId && label && label.toUpperCase() === text.toUpperCase()) {
      return { mode: "set", id: Number(o.datasetBankId) };
    }
    return { mode: "invalid" };
  }

  if (o.matchedId) return { mode: "set", id: Number(o.matchedId) };
  const label = String(o.datasetLabel || "");
  if (o.datasetBankId && (!text || label.toUpperCase() === text.toUpperCase())) {
    return { mode: "set", id: Number(o.datasetBankId) };
  }
  if (!text && o.activeBankId) return { mode: "set", id: Number(o.activeBankId) };
  return { mode: "set", id: o.firstUsableId != null ? Number(o.firstUsableId) : null };
}

// 把员工在 BANK ACC 格里的文本解析成户口 id。options 按下拉顺序：[{ id, label, aliases }]。
// 只打序号（"3" / "3."）→ 按下拉位置选，这是键盘快速录入；序号后面还有字，就必须整段等于
// 那个位置的标签，否则按标签 / 别名找。以前是「看到序号就取那个位置」，于是封禁户的
// 「1. TEST BANK (…)」被解析成运营列表第 1 个户口，户名自带编号的「2. ING john」被解析成
// 下拉第 2 个户口——两者都会把流水静默绑到别的户口上。
function matchBankByLabel(text, options) {
  const t = String(text || "").trim();
  const list = Array.isArray(options) ? options : [];
  if (!t) return null;
  const upper = t.toUpperCase();
  const num = t.match(/^(\d+)(?:\.\s*|\s+|$)(.*)$/);
  if (num) {
    const opt = list[Number(num[1]) - 1];
    const rest = String(num[2] || "").trim();
    if (opt && (!rest || String(opt.label || "").toUpperCase() === upper)) return opt.id;
  }
  const hit = list.find(
    (opt) =>
      String(opt.label || "").toUpperCase() === upper
      || (opt.aliases || []).some((a) => String(a || "").trim() && String(a).trim().toUpperCase() === upper)
  );
  return hit ? hit.id : null;
}

if (typeof window !== "undefined") {
  window.resolveRowBank = resolveRowBank;
  window.matchBankByLabel = matchBankByLabel;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { resolveRowBank, matchBankByLabel };
}
