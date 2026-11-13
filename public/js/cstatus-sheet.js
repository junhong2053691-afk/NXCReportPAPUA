// 填 C STATUS 的选择器。手机（≤700）：底部抽屉（带搜索、可「+ 使用」新名字）。
// 电脑（2026-11-13 起）：调钱 / 审批 / 转出 / 拆分协助方是只读输入框 + 点开的完整下拉（像 BANK 下拉，
// 没有搜索、不能新增）；流水表格那格（data-f）仍是 bank-ledger.js 自己的贴框浮层。
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

// 电脑上的 C STATUS 下拉（2026-11-13，用户要「像选 BANK 那样」）：点开就是完整列表，没有搜索、没有「+ 使用」，
// 新名字先去设置里加。当前值不在选项里（老数据、待处理调钱以前填的多家）时留成一项 current，
// 否则打开再关掉也没事，但用户会以为值丢了。
function cstatusDropdownRows(names, current) {
  const list = (Array.isArray(names) ? names : []).map((n) => String(n == null ? "" : n).trim()).filter(Boolean);
  const cur = String(current || "").trim();
  const curL = cur.toLowerCase();
  const rows = [{ kind: "blank", value: "", selected: !cur }];
  if (cur && !list.some((n) => n.toLowerCase() === curL)) rows.push({ kind: "current", value: cur, selected: true });
  list.forEach((n) => rows.push({ kind: "name", value: n, selected: !!cur && n.toLowerCase() === curL }));
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

    // 手机：不弹键盘、不弹 datalist。电脑（不含流水表格那格 data-f）：只读 + 摘掉 datalist，点开走下拉。
    // 跨断点时原样还回去。pointerdown / focusin 先于这一次点击和打字，在这里改才赶得上。
    function stashList(input) {
      if (input.hasAttribute("list")) {
        input.dataset.cstatusList = input.getAttribute("list");
        input.removeAttribute("list");
      }
    }
    function prepareCstatusInput(input) {
      if (!input) return;
      const desktopPick = !MQ.matches && !input.hasAttribute("data-f");
      if (MQ.matches) {
        stashList(input);
        input.setAttribute("inputmode", "none");
        input.dataset.cstatusMobile = "1";
      } else if (input.dataset.cstatusMobile) {
        if (input.dataset.cstatusList && !desktopPick) input.setAttribute("list", input.dataset.cstatusList);
        input.removeAttribute("inputmode");
        delete input.dataset.cstatusMobile;
      }
      if (desktopPick) {
        stashList(input);
        input.readOnly = true;
        input.dataset.cstatusDesktop = "1";
      } else if (input.dataset.cstatusDesktop) {
        input.readOnly = false;
        delete input.dataset.cstatusDesktop;
      }
    }

    // ── 电脑下拉 ── 挂在 body 上、position: fixed（.grid-picker），不放进 .modal：
    // .modal 带 transform，会成为 fixed 的 containing block（见 style.css .ac-dropdown 那段注释）。
    let dd = null; // { input, index }
    function dropdownEl() {
      let el = document.getElementById("cstatus-dropdown");
      if (el) return el;
      el = document.createElement("ul");
      el.id = "cstatus-dropdown";
      el.className = "ac-dropdown grid-picker cstatus-dropdown";
      el.setAttribute("role", "listbox");
      el.setAttribute("aria-label", "C STATUS");
      el.setAttribute("translate", "no");
      document.body.appendChild(el);
      // mousedown + preventDefault：焦点留在输入框，不先触发 blur。
      el.addEventListener("mousedown", (e) => {
        const li = e.target.closest(".ac-item");
        if (!li) return;
        e.preventDefault();
        if (!dd) return;
        dd.index = Array.from(el.querySelectorAll(".ac-item")).indexOf(li);
        confirmDropdown();
      });
      return el;
    }
    function placeDropdown(el, input) {
      const rect = input.getBoundingClientRect();
      el.style.left = `${Math.max(4, rect.left)}px`;
      el.style.width = `${Math.max(rect.width, 180)}px`; // 与输入框同宽，像原生 <select>
      // 按实际高度贴住输入框（列表短时不留空隙）；下面放不下且上面更宽才往上开。
      const h = el.offsetHeight || 240;
      const below = window.innerHeight - rect.bottom;
      if (below < h + 8 && rect.top > below) el.style.top = `${Math.max(4, rect.top - h - 2)}px`;
      else el.style.top = `${rect.bottom + 2}px`;
    }
    function highlight(i) {
      const el = document.getElementById("cstatus-dropdown");
      const items = el ? Array.from(el.querySelectorAll(".ac-item")) : [];
      if (!items.length || !dd) return;
      dd.index = Math.max(0, Math.min(i, items.length - 1));
      items.forEach((li, k) => {
        li.classList.toggle("active", k === dd.index);
        li.setAttribute("aria-selected", k === dd.index ? "true" : "false");
      });
      items[dd.index].scrollIntoView({ block: "nearest" });
    }
    function isDropdownOpen() {
      return !!dd;
    }
    function closeDropdown() {
      const el = document.getElementById("cstatus-dropdown");
      if (el) el.style.display = "none";
      if (dd) dd.input.setAttribute("aria-expanded", "false");
      dd = null;
    }
    function openDropdown(input, names) {
      const el = dropdownEl();
      const rows = cstatusDropdownRows(names, input.value);
      el.innerHTML = rows.map((r) => {
        const label = r.kind === "blank" ? `<span>${esc(BLANK_LABEL)}</span>` : `<span translate="no">${esc(r.value)}</span>`;
        return `<li class="ac-item cstatus-dd-item is-${r.kind}" role="option" data-kind="${r.kind}" data-value="${esc(r.value)}">${label}</li>`;
      }).join("");
      dd = { input, index: 0 };
      input.setAttribute("aria-expanded", "true");
      el.style.display = "block"; // 先显示再定位：placeDropdown 要读实际高度
      placeDropdown(el, input);
      const sel = rows.findIndex((r) => r.selected);
      highlight(sel < 0 ? 0 : sel);
    }
    function confirmDropdown() {
      const el = document.getElementById("cstatus-dropdown");
      const li = el?.querySelectorAll(".ac-item")[dd?.index ?? -1];
      const input = dd?.input;
      closeDropdown();
      if (!li || !input) return;
      const next = li.dataset.kind === "blank" ? "" : String(li.dataset.value || "").trim();
      if (next === input.value) return;
      input.value = next;
      // 调用方靠 input 事件重算（拆分协助方的合计、审批按钮可不可点），与手机抽屉的 pick() 一样。
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // getNames() 每次打开时现取（选项会在页面上被新增）。流水表格的输入框（带 data-f）
    // 由 bank-accounts.js 的 openFieldPicker 自己打开，这里只替它摘键盘。
    function bindCstatusSheet(getNames) {
      const pickInput = (t) => t?.closest?.("input[data-cstatus-pick]");
      document.addEventListener("pointerdown", (e) => {
        const input = pickInput(e.target);
        if (input) prepareCstatusInput(input);
        // 点在下拉和当前输入框以外 = 收起。
        if (dd && input !== dd.input && !e.target.closest?.("#cstatus-dropdown")) closeDropdown();
      }, true);
      // Tab 进来也要先变只读，否则 datalist 照样在打字时弹出来。
      document.addEventListener("focusin", (e) => {
        const input = pickInput(e.target);
        if (input) prepareCstatusInput(input);
      }, true);
      document.addEventListener("focusout", (e) => {
        if (dd && e.target === dd.input) closeDropdown();
      }, true);
      document.addEventListener("click", (e) => {
        const input = pickInput(e.target);
        if (!input || input.hasAttribute("data-f") || input.disabled) return;
        prepareCstatusInput(input);
        if (MQ.matches) {
          openCstatusSheet(input, getNames(), { allowBlank: true, allowAdd: true });
          return;
        }
        if (dd && dd.input === input) closeDropdown();
        else openDropdown(input, getNames());
      });
      // 键盘与 <select> 一致：↓ / Enter / 空格 打开，↑↓ 移动，Enter 选中，Esc 收起。
      // 挂在 window 的 capture 上并 stopPropagation：Esc 只收下拉，不能让 app.js 顺手把整个弹窗关掉。
      // 必须是 window 不是 document：app.js 的弹窗键盘处理也是 document capture、先注册、还会
      // stopImmediatePropagation，同一层上它永远先跑（实测 Esc 直接关掉了调钱弹窗）。
      window.addEventListener("keydown", (e) => {
        const input = pickInput(e.target);
        if (!input || input.hasAttribute("data-f") || MQ.matches || e.isComposing) return;
        if (!dd || dd.input !== input) {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            prepareCstatusInput(input);
            openDropdown(input, getNames());
          }
          return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") highlight(dd.index + (e.key === "ArrowDown" ? 1 : -1));
        else if (e.key === "Enter" || e.key === " ") confirmDropdown();
        else if (e.key === "Escape") closeDropdown();
        else if (e.key === "Tab") { closeDropdown(); return; }
        else return;
        e.preventDefault();
        e.stopPropagation();
      }, true);
      // 下拉是 fixed + 视口坐标：页面 / 弹窗滚动时跟着输入框走，输入框没了或滚出视口就收起。
      window.addEventListener("scroll", () => {
        if (!dd) return;
        const r = dd.input.getBoundingClientRect();
        if (!dd.input.isConnected || r.bottom < 0 || r.top > window.innerHeight) closeDropdown();
        else placeDropdown(dropdownEl(), dd.input);
      }, true);
      window.addEventListener("resize", closeDropdown);
    }

    window.cstatusSheetRows = cstatusSheetRows;
    window.cstatusDropdownRows = cstatusDropdownRows;
    window.isCstatusDropdownOpen = isDropdownOpen;
    window.openCstatusSheet = openCstatusSheet;
    window.bindCstatusSheet = bindCstatusSheet;
    window.isCstatusSheetMobile = () => MQ.matches;
  })();
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { cstatusSheetRows, cstatusDropdownRows };
}
