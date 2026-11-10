// 余额超上限的网页报警：当前公司有渠道余额 ≥ 报警阈值时，立刻响一遍并在右上角弹一张通知卡。
//
// 规则（2026-11-10 用户要求）：
//   - 全站都响，只管侧栏选中的当前公司。数据来自 app.js 每 8 秒的 /api/banks/pending-counts
//     （over_limit 字段，服务端 bankAlerts.overLimitAccounts，与 Telegram 报警同一口径），
//     本文件不另起轮询，只听 app.js 派发的 "bank-pending-counts" 事件。
//   - 节奏走 alarm.js 的 balance 预设：超标立刻响，没处理每 10 分钟再响，关掉通知静默 20 分钟。
//   - 余额涨过上次报警值就重响：signature 用服务端的 alertedBalance（alert_fired_balance，
//     只在涨过上次报警值时才变），同一桶钱来回动不重响；新渠道超标也算新问题。
//     **有渠道退出（钱转走了）不算新问题**：signature 原样保留，否则处理掉一户反而把剩下的又吵一遍
//     （balNextSignature）。退出的那户从基准里删掉，它以后再超标就是新问题。
//   - 通知卡只有一张（合并），只在报警「响」的阶段显示；关掉 = ack；没有超标户就自动消失。
//
// 纯逻辑（balSignature / balModel / createBalanceAlerts）不碰 DOM，Node 里可测
// （server/tests/balance-alerts.test.js）；DOM 渲染与启动在文件末尾的浏览器分支里。

const BAL_ALARM_PREFIX = "bank-balance-alarm";
const BAL_ALARM_SOUND = "/sounds/transfer-pending.mp3";
const BAL_MAX_ITEMS = 3;

function balCents(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** 超标账户集合 → signature。空集合返回 ""（alarm.update("") 即解除）。 */
function balSignature(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(function (r) { return r && r.id != null; })
    .map(function (r) { return { id: Number(r.id), c: balCents(r.alertedBalance != null ? r.alertedBalance : r.balance) }; })
    .sort(function (a, b) { return a.id - b.id; })
    .map(function (r) { return r.id + ":" + r.c; })
    .join("|");
}

function balBaseline(rows) {
  const map = {};
  (Array.isArray(rows) ? rows : []).forEach(function (r) {
    if (r && r.id != null) map[Number(r.id)] = balCents(r.alertedBalance != null ? r.alertedBalance : r.balance);
  });
  return map;
}

/** balSignature 的反解：「3:120050|7:200000」→ { 3: 120050, 7: 200000 }。 */
function balBaselineFromSig(sig) {
  const map = {};
  String(sig || "").split("|").forEach(function (part) {
    const m = /^(\d+):(-?\d+)$/.exec(part);
    if (m) map[Number(m[1])] = Number(m[2]);
  });
  return map;
}

/**
 * 这一轮该交给 alarm 的 signature。prev = { sig, baseline }（上一轮的结果）。
 * 每户都在基准里且没涨过基准 → 沿用上一轮的 sig（只有户退出不算新问题），基准删掉退出的户；
 * 否则（新户 / 涨过基准）→ 新 sig、新基准。没有超标户 → ""。
 */
function balNextSignature(prev, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const now = balBaseline(list);
  const ids = Object.keys(now);
  if (!ids.length) return { sig: "", baseline: {} };
  const before = (prev && prev.baseline) || {};
  const prevSig = (prev && prev.sig) || "";
  const noNews = prevSig && ids.every(function (id) {
    return Object.prototype.hasOwnProperty.call(before, id) && now[id] <= before[id];
  });
  if (noNews) {
    const kept = {};
    ids.forEach(function (id) { kept[id] = before[id]; });
    return { sig: prevSig, baseline: kept };
  }
  return { sig: balSignature(list), baseline: now };
}

/** 通知卡要显示的内容：前 BAL_MAX_ITEMS 户，其余计数。 */
function balModel(rows, max) {
  const list = Array.isArray(rows) ? rows : [];
  const limit = max == null ? BAL_MAX_ITEMS : Math.max(0, Number(max) || 0);
  return {
    items: list.slice(0, limit).map(function (r) {
      return {
        id: Number(r.id),
        label: String(r.label || ""),
        balance: Number(r.balance || 0),
        threshold: Number(r.threshold || 0),
      };
    }),
    more: Math.max(0, list.length - limit),
  };
}

/**
 * 控制器。依赖注入：
 *   createAlarm (onStageChange) => escalating alarm（update / acknowledge / stage / stop）
 *   render      (view) => void   view = { visible, model }
 *   navigate    () => void       点卡片去交易页
 */
function createBalanceAlerts(deps) {
  let rows = [];
  let current = { sig: "", baseline: {} };
  let rendering = false;
  const alarm = deps.createAlarm(function () { draw(); });

  function draw() {
    // update() / acknowledge() 会回调 onStageChange 再进来，只画一次。
    if (rendering) return;
    rendering = true;
    try {
      const visible = rows.length > 0 && alarm.stage() === "loud";
      deps.render({ visible: visible, model: balModel(rows) });
    } finally {
      rendering = false;
    }
  }

  function apply(data) {
    rows = Array.isArray(data && data.over_limit) ? data.over_limit : [];
    // 刷新后内存里没有上一轮：拿 storage 里的 sig 接上，免得「刷新 + 刚好有户退出」被当成新问题。
    if (!current.sig && typeof alarm.storedSig === "function") {
      const stored = alarm.storedSig();
      if (stored) current = { sig: stored, baseline: balBaselineFromSig(stored) };
    }
    current = balNextSignature(current, rows);
    alarm.update(current.sig);
    draw();
  }

  function dismiss() {
    alarm.acknowledge();
    draw();
  }

  function open() {
    alarm.acknowledge();
    draw();
    deps.navigate();
  }

  // 切公司：停掉当前声音、收起卡片，等下一轮数据按新公司的时间线重新判定。
  function reset() {
    rows = [];
    current = { sig: "", baseline: {} };
    alarm.stop();
    deps.render({ visible: false, model: balModel([]) });
  }

  return { apply: apply, dismiss: dismiss, open: open, reset: reset, alarm: alarm, rows: function () { return rows; } };
}

// ── 浏览器：DOM 渲染与启动 ──────────────────────────────────────────────

function balFormatAmount(n) {
  // 数字格式不随界面语言走（与流水表、来单通知一致）。
  return Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function balEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = String(text);
  return el;
}

function balDataSpan(text) {
  const el = balEl("span", "", text);
  el.setAttribute("translate", "no"); // 租户数据：i18n 引擎与浏览器自动翻译都跳过
  return el;
}

function balBuildToast(handlers) {
  // 复用来单通知的样式（app-toast--order：手机上弹窗打开时藏起、接单浮层让位）。
  const toast = balEl("div", "app-toast app-toast--order app-toast--balance");
  toast.dataset.tone = "warning";
  toast.setAttribute("role", "status");
  const icon = balEl("span", "app-toast-icon");
  icon.setAttribute("aria-hidden", "true");
  if (typeof renderIcon === "function") icon.innerHTML = renderIcon("bell-ring", { size: 18 });
  const openBtn = balEl("button", "app-toast-copy app-toast-open");
  openBtn.type = "button";
  openBtn.addEventListener("click", handlers.open);
  const close = balEl("button", "app-toast-close icon-btn");
  close.type = "button";
  close.setAttribute("aria-label", "关闭通知");
  close.innerHTML = (typeof renderIcon === "function" ? renderIcon("x", { size: 17 }) : "") + '<span class="icon-fallback" aria-hidden="true">×</span>';
  close.addEventListener("click", function (e) { e.stopPropagation(); handlers.close(); });
  toast.append(icon, openBtn, close);
  return toast;
}

function balFill(toast, model) {
  const copy = toast.querySelector(".app-toast-open");
  const sig = JSON.stringify(model);
  if (copy.dataset.sig === sig) return;
  copy.dataset.sig = sig;
  copy.textContent = "";
  copy.append(balEl("strong", "", "余额超上限"));
  model.items.forEach(function (it) {
    const line = balEl("span", "app-toast-order-line");
    line.append(
      balDataSpan(it.label),
      document.createTextNode(" "),
      balDataSpan(balFormatAmount(it.balance)),
      document.createTextNode(" / "),
      balDataSpan(balFormatAmount(it.threshold))
    );
    copy.append(line);
  });
  // 多出来的户只写「+N」：与语言无关，不用插值短语规则。
  if (model.more > 0) copy.append(balDataSpan("+" + model.more));
}

function createBalRenderer(getController) {
  let node = null;
  return function render(view) {
    if (!view.visible) {
      if (node) {
        const old = node;
        node = null;
        if (typeof removeAppToast === "function") removeAppToast(old);
        else old.remove();
      }
      return;
    }
    const stack = typeof ensureGlobalFeedbackUi === "function" ? ensureGlobalFeedbackUi()?.toastStack : document.getElementById("app-toast-stack");
    if (!stack) return;
    const isNew = !node;
    if (isNew) {
      node = balBuildToast({
        open: function () { getController().open(); },
        close: function () { getController().dismiss(); },
      });
      // 放最上面；跨公司来单卡每轮会把自己排回它前面。
      stack.insertBefore(node, stack.firstChild);
    }
    balFill(node, view.model);
    if (isNew) {
      if (typeof renderIcons === "function") renderIcons(node);
      const el = node;
      window.requestAnimationFrame(function () { el.classList.add("is-visible"); });
    }
  };
}

function startBalanceAlerts() {
  if (typeof window.createEscalatingAlarm !== "function") return;
  let controller = null;
  controller = createBalanceAlerts({
    createAlarm: function (onStageChange) {
      return window.createEscalatingAlarm({
        preset: "balance",
        soundSrc: BAL_ALARM_SOUND,
        keyPrefix: BAL_ALARM_PREFIX,
        scope: function () { return (typeof activeCompanyId !== "undefined" && activeCompanyId) || "__current__"; },
        onStageChange: onStageChange,
      });
    },
    render: createBalRenderer(function () { return controller; }),
    navigate: function () {
      if (location.pathname !== "/bank-ledger.html") location.assign("/bank-ledger.html");
    },
  });
  window.addEventListener("bank-pending-counts", function (e) { controller.apply(e.detail || {}); });
  window.addEventListener("company-changed", function () { controller.reset(); });
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", startBalanceAlerts);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    balSignature: balSignature,
    balNextSignature: balNextSignature,
    balBaselineFromSig: balBaselineFromSig,
    balModel: balModel,
    createBalanceAlerts: createBalanceAlerts,
    BAL_ALARM_PREFIX: BAL_ALARM_PREFIX,
    BAL_MAX_ITEMS: BAL_MAX_ITEMS,
  };
}
