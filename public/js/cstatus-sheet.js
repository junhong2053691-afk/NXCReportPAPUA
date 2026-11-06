// 手机上填 C STATUS 的底部抽屉选择（≤700）。桌面不走这里：流水表格仍是贴着输入框的下拉，
// 调钱 / 审批 / 转出仍是 datalist。
//
// 2026-11-06：手机上 datalist 只是键盘上方一排建议（iPhone）或一个小下拉（Android），表格那个
// 浮层又会被键盘顶走。改成：点输入框 → 底部弹出公司列表（带搜索），点一下就填进去。
//
// 接入点（都在 bank-accounts.js）：
//   · 编辑流水 C STATUS   → openFieldPicker 在手机上改调 openCstatusSheet
//   · 调钱 / 转出 / 待处理调钱 / 拆分协助方 → 输入框带 data-cstatus-pick，这里统一委托
//
// 输入框本身在手机上设 inputmode="none" 并摘掉 list：点了不弹键盘、不弹 datalist，
// 打字改到抽屉里的搜索框。抽屉关掉后 app.js 会把焦点还给输入框，没有键盘也就不跳。
// 待处理「调钱」那格可填多家（服务端按 , ; / | 拆）：在搜索框打「EZ68, PK7」点「+ 使用」。

// 抽屉里的一行：blank = 清空，name = 已有选项，add = 用搜索框里的字。
function cstatusSheetRows(names, query, current, opts) {
  const o = opts || {};
  const list = (Array.isArray(names) ? names : []).map((n) => String(n == null ? "" : n).trim()).filter(Boolean);
  const q = String(query || "").trim();
  const ql = q.toLowerCase();
  const cur = String(current || "").trim().toLowerCase();
  const rows = [];
  if (o.allowBlank && !q) rows.push({ kind: "blank", value: "", selected: !cur });
  list
    .filter((n) => !ql || n.toLowerCase().includes(ql))
    .forEach((n) => rows.push({ kind: "name", value: n, selected: !!cur && n.toLowerCase() === cur }));
  if (o.allowAdd && q && !list.some((n) => n.toLowerCase() === ql)) {
    rows.push({ kind: "add", value: q, selected: false });
  }
  return rows;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  (function () {
    const MQ = window.matchMedia ? window.matchMedia("(max-width: 700px)") : { matches: false };
    const BLANK_LABEL = "— 空白 —";
    let state = null; // { input, names, opts, onPick }

    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function ensureSheet() {
      let overlay = document.getElementById("cstatus-pick");
      if (overlay) return overlay;
      document.body.insertAdjacentHTML(
        "beforeend",
        '<div class="modal-overlay" id="cstatus-pick"><div class="modal cstatus-pick-sheet">' +
          "<h2>选择 C STATUS</h2>" +
          '<input type="search" class="cstatus-pick-search" id="cstatus-pick-search" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done" placeholder="搜索或输入新名称" aria-label="搜索或输入新名称">' +
          '<ul class="cstatus-pick-list" id="cstatus-pick-list" role="listbox" aria-label="C STATUS" tabindex="-1" data-modal-initial-focus></ul>' +
          '<div class="actions"><button type="button" class="btn btn-outline btn-sm" id="cstatus-pick-cancel">取消</button></div>' +
        "</div></div>"
      );
      overlay = document.getElementById("cstatus-pick");
      overlay.querySelector("#cstatus-pick-cancel").addEventListener("click", closeSheet);
      const search = overlay.querySelector("#cstatus-pick-search");
      search.addEventListener("input", render);
      search.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.isComposing) return;
        e.preventDefault();
        const first = overlay.querySelector(".cstatus-pick-item");
        if (first) first.click();
      });
      overlay.querySelector("#cstatus-pick-list").addEventListener("click", (e) => {
        const btn = e.target.closest(".cstatus-pick-item");
        if (!btn || !state) return;
        pick(btn.dataset.kind, btn.dataset.value || "");
      });
      return overlay;
    }

    function render() {
      const overlay = document.getElementById("cstatus-pick");
      if (!overlay || !state) return;
      const q = overlay.querySelector("#cstatus-pick-search").value;
      const rows = cstatusSheetRows(state.names, q, state.input.value, state.opts);
      const list = overlay.querySelector("#cstatus-pick-list");
      list.innerHTML = rows.length
        ? rows.map((r) => {
            const label = r.kind === "blank"
              ? `<span>${esc(BLANK_LABEL)}</span>`
              : r.kind === "add"
                ? `<span>+ 使用</span> <b translate="no">${esc(r.value)}</b>`
                : `<span translate="no">${esc(r.value)}</span>`;
            return `<li role="none"><button type="button" role="option" class="cstatus-pick-item is-${r.kind}${r.selected ? " is-selected" : ""}" aria-selected="${r.selected ? "true" : "false"}" data-kind="${r.kind}" data-value="${esc(r.value)}">${label}</button></li>`;
          }).join("")
        : '<li class="cstatus-pick-empty">没有匹配的 C STATUS</li>';
    }

    function closeSheet() {
      document.getElementById("cstatus-pick")?.classList.remove("show");
      state = null;
    }

    function pick(kind, value) {
      const s = state;
      const input = s.input;
      input.value = kind === "blank" ? "" : String(value || "").trim();
      // 调用方靠 input 事件重算（拆分协助方的合计、审批按钮可不可点）。
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      closeSheet();
      if (typeof s.onPick === "function") s.onPick(input.value, kind);
    }

    // opts: { allowBlank, allowAdd }；onPick(value, kind) 在写回输入框之后调用。
    function openCstatusSheet(input, names, opts, onPick) {
      if (!input) return;
      const overlay = ensureSheet();
      state = { input, names: names || [], opts: opts || {}, onPick };
      overlay.querySelector("#cstatus-pick-search").value = "";
      render();
      overlay.classList.add("show");
      const selected = overlay.querySelector(".cstatus-pick-item.is-selected");
      if (selected) selected.scrollIntoView({ block: "nearest" });
    }

    // 手机：不弹键盘、不弹 datalist；回到桌面宽度时原样还回去。pointerdown 先于 focus，
    // 在这里改才赶得上这一次点击。
    function prepareCstatusInput(input) {
      if (!input) return;
      if (MQ.matches) {
        if (input.hasAttribute("list")) {
          input.dataset.cstatusList = input.getAttribute("list");
          input.removeAttribute("list");
        }
        input.setAttribute("inputmode", "none");
        input.dataset.cstatusMobile = "1";
      } else if (input.dataset.cstatusMobile) {
        if (input.dataset.cstatusList) input.setAttribute("list", input.dataset.cstatusList);
        input.removeAttribute("inputmode");
        delete input.dataset.cstatusMobile;
      }
    }

    // getNames() 每次打开时现取（选项会在页面上被新增）。流水表格的输入框（带 data-f）
    // 由 bank-accounts.js 的 openFieldPicker 自己打开，这里只替它摘键盘。
    function bindCstatusSheet(getNames) {
      document.addEventListener("pointerdown", (e) => {
        const input = e.target.closest?.("input[data-cstatus-pick]");
        if (input) prepareCstatusInput(input);
      }, true);
      document.addEventListener("click", (e) => {
        const input = e.target.closest?.("input[data-cstatus-pick]");
        if (!input || input.hasAttribute("data-f") || !MQ.matches) return;
        prepareCstatusInput(input);
        openCstatusSheet(input, getNames(), { allowBlank: true, allowAdd: true });
      });
    }

    window.cstatusSheetRows = cstatusSheetRows;
    window.openCstatusSheet = openCstatusSheet;
    window.bindCstatusSheet = bindCstatusSheet;
    window.isCstatusSheetMobile = () => MQ.matches;
  })();
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { cstatusSheetRows };
}
