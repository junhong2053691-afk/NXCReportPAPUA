// 跨公司来单提醒：operator 停在 A 公司时，B 公司进了平台待审批单，右上角滑下一条通知。
//
// 规则全部来自 2026-11-09 的需求访谈（CONTEXT.md「跨公司来单提醒」），改之前先看那里：
//   - 只对 operator、且授权了 ≥2 家公司时开（服务端 crossCompanyPending 判定，enabled=false 就停）。
//   - 一笔一条，标题公司名、正文「充值 500.00 · user123」；当前公司的单不弹（它有接单区和报警）。
//   - 最多 MAX_VISIBLE 条（最新的），其余折成「还有 N 笔」；点折叠条切去笔数最多的那家。
//     手机（≤700）上限是 0：全部折进一条「别家待审批 N」，贴底栏上方（style.css）。
//     规则与折叠条完全一样，只是显示上限不同（.scratch/ui-responsive/decisions.md 增量 F）。
//   - 不自动消失。收起只有三种：点它 / 关掉它；那笔不再是 pending；关掉折叠条（全收）。
//   - 「已看过」是**每家公司一组 id**（不是一个水位线：关掉 50 号不能吞掉还开着的 45 号），
//     存 localStorage，多标签页共享。只在两种情况记：点或关掉通知；停在某家时它当前全部 pending。
//   - 每家公司一个 escalating alarm，与 app.js 的当前公司报警**共用同一个 key**
//     （bank-pending-alarm:<公司>），所以切公司不重置静默期。点开 / 关掉某家任意一条 = ack 那家。
//
// 纯逻辑（planAlerts / markSeen / createCrossCompanyAlerts）不碰 DOM，Node 里可测
// （server/tests/cross-company-alerts.test.js）；DOM 渲染与启动在文件末尾的浏览器分支里。

const XCO_SEEN_KEY = "cross-company-seen";
const XCO_MAX_VISIBLE = 5;
// 与 style.css 的手机断点一致。
const XCO_MOBILE_QUERY = "(max-width: 700px)";
const XCO_POLL_MS = 8000;
// 必须与 app.js getPlatformPendingAlarm 的 keyPrefix / soundSrc / preset 一致：共用时间线（Q14）。
const XCO_ALARM_PREFIX = "bank-pending-alarm";
const XCO_ALARM_SOUND = "/sounds/platform-pending.mp3";
const XCO_ALARM_PRESET = "pending";

function xcoReadSeen(storage) {
  try {
    const raw = storage.getItem(XCO_SEEN_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function xcoWriteSeen(storage, seen) {
  try {
    storage.setItem(XCO_SEEN_KEY, JSON.stringify(seen));
  } catch (_) {}
}

/**
 * 由服务端快照和已看过集合算出这一轮该显示什么。纯函数。
 * 返回的 seen 已经剪掉不再 pending 的 id，并把当前公司的全部 pending 记成已看过（Q18）。
 * maxVisible 不传就是 XCO_MAX_VISIBLE；0 = 全部折叠（手机）。
 */
function xcoPlanAlerts(snapshot, seen, maxVisible) {
  const prev = seen && typeof seen === "object" ? seen : {};
  if (!snapshot || !snapshot.enabled) {
    return { enabled: false, seen: prev, cards: [], folded: null, pendingByCompany: {} };
  }
  const current = String(snapshot.current || "");
  const names = {};
  (snapshot.companies || []).forEach(function (c) { names[c.id] = c.name || c.id; });

  const liveByCompany = {};
  const rows = (snapshot.rows || []).filter(function (r) { return Object.prototype.hasOwnProperty.call(names, r.company_id); });
  rows.forEach(function (r) {
    (liveByCompany[r.company_id] = liveByCompany[r.company_id] || []).push(Number(r.id));
  });

  const nextSeen = {};
  const pendingByCompany = {};
  Object.keys(names).forEach(function (cid) {
    const live = liveByCompany[cid] || [];
    pendingByCompany[cid] = live.length;
    if (cid === current) {
      nextSeen[cid] = live.slice().sort(function (a, b) { return a - b; });
      return;
    }
    const liveSet = new Set(live);
    nextSeen[cid] = (Array.isArray(prev[cid]) ? prev[cid] : [])
      .map(Number)
      .filter(function (id) { return liveSet.has(id); });
  });

  const unseen = rows
    .filter(function (r) { return r.company_id !== current && nextSeen[r.company_id].indexOf(Number(r.id)) === -1; })
    .sort(function (a, b) { return Number(b.id) - Number(a.id); })
    .map(function (r) {
      return {
        id: Number(r.id),
        companyId: r.company_id,
        companyName: names[r.company_id],
        type: String(r.tx_type || "").toUpperCase() === "WITHDRAW" ? "WITHDRAW" : "DEPOSIT",
        // 付了一部分的单（CONTEXT.md「拆分调钱」）显示还差多少。
        amount: Number(r.remaining_amount != null ? r.remaining_amount : r.amount || 0),
        username: String(r.username || ""),
      };
    });

  const max = maxVisible == null ? XCO_MAX_VISIBLE : Math.max(0, Number(maxVisible) || 0);
  const cards = unseen.slice(0, max);
  const rest = unseen.slice(max);
  let folded = null;
  if (rest.length) {
    const counts = {};
    const order = [];
    rest.forEach(function (c) {
      if (!counts[c.companyId]) { counts[c.companyId] = 0; order.push(c.companyId); }
      counts[c.companyId] += 1;
    });
    const companies = order
      .map(function (cid) { return { id: cid, name: names[cid], count: counts[cid] }; })
      .sort(function (a, b) { return b.count - a.count; }); // 稳定排序：同数时保持「最新单所在」在前
    folded = {
      all: cards.length === 0, // 一条单卡都没有：标题写「别家待审批 N」而不是「还有 N 笔」
      count: rest.length,
      items: rest.map(function (c) { return { id: c.id, companyId: c.companyId }; }),
      companies: companies,
      targetCompanyId: companies[0].id,
    };
  }
  return { enabled: true, current: current, seen: nextSeen, cards: cards, folded: folded, pendingByCompany: pendingByCompany };
}

/** 把若干 { id, companyId } 记成已看过，返回新对象。 */
function xcoMarkSeen(seen, items) {
  const next = {};
  Object.keys(seen || {}).forEach(function (cid) { next[cid] = (seen[cid] || []).slice(); });
  (items || []).forEach(function (it) {
    const list = next[it.companyId] || (next[it.companyId] = []);
    if (list.indexOf(Number(it.id)) === -1) list.push(Number(it.id));
  });
  return next;
}

/**
 * 控制器。依赖全部注入，方便测试：
 *   storage        localStorage 形状
 *   fetchSnapshot  () => Promise<snapshot>
 *   createAlarm    (companyId) => escalating alarm（update / acknowledge / dispose）
 *   render         (plan) => void
 *   navigate       (companyId) => void   点通知后切公司并去接单区
 *   maxVisible     () => number          可选，每轮现取（手机 0，电脑 XCO_MAX_VISIBLE）
 */
function createCrossCompanyAlerts(deps) {
  const storage = deps.storage;
  const alarms = {};
  let lastSnapshot = null;
  let lastPlan = null;

  function syncAlarms(plan) {
    const wanted = {};
    if (plan.enabled) {
      Object.keys(plan.pendingByCompany).forEach(function (cid) {
        if (cid !== plan.current) wanted[cid] = true;
      });
    }
    // 不再需要的（变成当前公司 / 撤权 / 功能关掉）只 dispose，**绝不 update("")**：
    // 那会 clearState，把 app.js 当前公司报警正在用的同一个 key 清掉，静默期被重置。
    Object.keys(alarms).forEach(function (cid) {
      if (!wanted[cid]) {
        alarms[cid].dispose();
        delete alarms[cid];
      }
    });
    Object.keys(wanted).forEach(function (cid) {
      if (!alarms[cid]) alarms[cid] = deps.createAlarm(cid);
      // signature 不含笔数，与 app.js 一致：清掉 2 笔剩 1 笔不重置静默期，0→1 才重置。
      alarms[cid].update(plan.pendingByCompany[cid] > 0 ? "pending" : "");
    });
  }

  // persist=false：只重画，不把裁剪后的已看过写回 storage。
  function apply(snapshot, persist) {
    lastSnapshot = snapshot;
    const max = typeof deps.maxVisible === "function" ? deps.maxVisible() : undefined;
    const plan = xcoPlanAlerts(snapshot, xcoReadSeen(storage), max);
    if (plan.enabled && persist !== false) xcoWriteSeen(storage, plan.seen);
    syncAlarms(plan);
    lastPlan = plan;
    deps.render(plan);
    return plan;
  }

  // 别的标签页关掉了通知（storage 事件），或刚刚本页关掉：用上一份快照重算，不等下一轮轮询。
  // **绝不写回**：上一份快照最多旧 8 秒，别的标签页刚关掉的新单不在里面，按它裁剪再写回
  // 会把那笔从已看过里删掉，那页随即又弹出来。写回只在拿到新快照的 poll 里做；
  // 本页关通知时 dismissItems 已先写过。
  function rerender() {
    return lastSnapshot ? apply(lastSnapshot, false) : null;
  }

  function acknowledge(companyIds) {
    companyIds.forEach(function (cid) {
      if (alarms[cid]) alarms[cid].acknowledge();
    });
  }

  function dismissItems(items) {
    xcoWriteSeen(storage, xcoMarkSeen(xcoReadSeen(storage), items));
    const cids = [];
    items.forEach(function (it) { if (cids.indexOf(it.companyId) === -1) cids.push(it.companyId); });
    acknowledge(cids);
    rerender();
  }

  function dismiss(id) {
    const card = lastPlan && lastPlan.cards.find(function (c) { return c.id === Number(id); });
    if (card) dismissItems([{ id: card.id, companyId: card.companyId }]);
  }

  function dismissFolded() {
    if (lastPlan && lastPlan.folded) dismissItems(lastPlan.folded.items);
  }

  function open(id) {
    const card = lastPlan && lastPlan.cards.find(function (c) { return c.id === Number(id); });
    if (!card) return;
    dismissItems([{ id: card.id, companyId: card.companyId }]);
    deps.navigate(card.companyId);
  }

  function openFolded() {
    const folded = lastPlan && lastPlan.folded;
    if (!folded) return;
    const target = folded.targetCompanyId;
    // 只把要去的那家折进去的记成已看过：到了那家它全部 pending 本来就会被记上（Q18），
    // 别家折叠的单在那边还没人看过，不能顺手吞掉。
    dismissItems(folded.items.filter(function (it) { return it.companyId === target; }));
    deps.navigate(target);
  }

  function poll() {
    return Promise.resolve()
      .then(deps.fetchSnapshot)
      .then(function (snapshot) { return apply(snapshot, true); });
  }

  return {
    poll: poll,
    apply: apply,
    rerender: rerender,
    dismiss: dismiss,
    dismissFolded: dismissFolded,
    open: open,
    openFolded: openFolded,
    alarms: function () { return Object.keys(alarms); },
    plan: function () { return lastPlan; },
  };
}

// ── 浏览器：DOM 渲染与启动 ──────────────────────────────────────────────

function xcoFormatAmount(n) {
  // 数字格式不随界面语言走（与流水表一致），所以不用 dateLocale()。
  return Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function xcoEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = String(text);
  return el;
}

function xcoDataSpan(text) {
  const el = xcoEl("span", "", text);
  el.setAttribute("translate", "no"); // 租户数据：i18n 引擎与浏览器自动翻译都跳过
  return el;
}

function xcoBuildToast(key, handlers) {
  const toast = xcoEl("div", "app-toast app-toast--order");
  toast.dataset.tone = "warning";
  toast.dataset.xcoKey = key;
  toast.setAttribute("role", "status");
  const icon = xcoEl("span", "app-toast-icon");
  icon.setAttribute("aria-hidden", "true");
  if (typeof renderIcon === "function") icon.innerHTML = renderIcon("bell-ring", { size: 18 });
  const openBtn = xcoEl("button", "app-toast-copy app-toast-open");
  openBtn.type = "button";
  openBtn.addEventListener("click", handlers.open);
  const close = xcoEl("button", "app-toast-close icon-btn");
  close.type = "button";
  close.setAttribute("aria-label", "关闭通知");
  close.innerHTML = (typeof renderIcon === "function" ? renderIcon("x", { size: 17 }) : "") + '<span class="icon-fallback" aria-hidden="true">×</span>';
  close.addEventListener("click", function (e) { e.stopPropagation(); handlers.close(); });
  toast.append(icon, openBtn, close);
  return toast;
}

function xcoFillCard(toast, card) {
  const copy = toast.querySelector(".app-toast-open");
  const sig = [card.companyName, card.type, card.amount, card.username].join("|");
  if (copy.dataset.sig === sig) return;
  copy.dataset.sig = sig;
  copy.textContent = "";
  const title = xcoEl("strong", "", card.companyName);
  title.setAttribute("translate", "no");
  const body = xcoEl("span", "app-toast-order-line");
  // 拆成独立文本节点：「充值 / 提现」走字典，金额与 username 是数据不翻译。
  body.append(
    xcoEl("span", "", card.type === "WITHDRAW" ? "提现" : "充值"),
    document.createTextNode(" "),
    xcoDataSpan(xcoFormatAmount(card.amount))
  );
  if (card.username) body.append(document.createTextNode(" · "), xcoDataSpan(card.username));
  copy.append(title, body);
}

function xcoFillFolded(toast, folded) {
  const copy = toast.querySelector(".app-toast-open");
  const sig = (folded.all ? "all|" : "") + folded.count + "|" + folded.companies.map(function (c) { return c.id + ":" + c.count; }).join(",");
  if (copy.dataset.sig === sig) return;
  copy.dataset.sig = sig;
  copy.textContent = "";
  // 手机汇总条：「别家待审批」与笔数分成两个节点，前者走字典、后者是数字，不需要插值短语规则。
  const title = folded.all
    ? xcoEl("strong", "")
    : xcoEl("strong", "", "还有 " + folded.count + " 笔");
  if (folded.all) title.append(xcoEl("span", "", "别家待审批"), document.createTextNode(" "), xcoDataSpan(folded.count));
  copy.append(
    title,
    xcoDataSpan(folded.companies.map(function (c) { return c.name + " " + c.count; }).join(" · "))
  );
}

function xcoRemoveToast(toast) {
  if (typeof removeAppToast === "function") removeAppToast(toast);
  else toast.remove();
}

function createXcoRenderer(getController) {
  const nodes = new Map(); // key -> element

  return function render(plan) {
    const stack = typeof ensureGlobalFeedbackUi === "function" ? ensureGlobalFeedbackUi()?.toastStack : document.getElementById("app-toast-stack");
    if (!stack) return;
    const wanted = plan.cards.map(function (c) { return { key: "tx:" + c.id, card: c }; });
    if (plan.folded) wanted.push({ key: "fold", folded: plan.folded });
    const wantedKeys = new Set(wanted.map(function (w) { return w.key; }));

    nodes.forEach(function (el, key) {
      if (!wantedKeys.has(key)) {
        nodes.delete(key);
        xcoRemoveToast(el);
      }
    });

    wanted.forEach(function (w, index) {
      let el = nodes.get(w.key);
      const isNew = !el;
      if (isNew) {
        el = w.folded
          ? xcoBuildToast(w.key, {
              open: function () { getController().openFolded(); },
              close: function () { getController().dismissFolded(); },
            })
          : xcoBuildToast(w.key, {
              open: function () { getController().open(w.card.id); },
              close: function () { getController().dismiss(w.card.id); },
            });
        nodes.set(w.key, el);
      }
      if (w.folded) xcoFillFolded(el, w.folded);
      else xcoFillCard(el, w.card);
      // 来单通知固定排在普通 toast 之前，最新的在最上面；折叠条在它们最后。
      const ref = stack.children[index] || null;
      if (ref !== el) stack.insertBefore(el, ref);
      if (isNew) {
        if (typeof renderIcons === "function") renderIcons(el);
        // 翻译不用手动调：app.js setupLanguage 起的 observer 会处理新插入的节点。
        window.requestAnimationFrame(function () { el.classList.add("is-visible"); });
      }
    });
  };
}

function xcoNavigate(companyId) {
  const go = function () {
    const target = "/bank-ledger.html#pending";
    // 已经在当日流水页时只改 hash 不会重载；切了公司必须整页重载，让所有面板换成新公司。
    if (location.pathname === "/bank-ledger.html") {
      try { history.replaceState(null, "", target); } catch (_) {}
      location.reload();
    } else {
      location.assign(target);
    }
  };
  // 本标签页切过去（sessionStorage），POST 顺带更新新标签页默认值；别的标签页不受影响。
  api("/api/companies/active", { method: "POST", body: JSON.stringify({ id: companyId }) })
    .then(function () {
      if (typeof setTabCompanyId === "function") setTabCompanyId(companyId);
      go();
    })
    .catch(function (e) {
      if (typeof showToast === "function") showToast((e && e.message) || "切换公司失败", { tone: "error", title: "切换公司失败" });
    });
}

function startCrossCompanyAlerts() {
  if (typeof api !== "function" || typeof window.createEscalatingAlarm !== "function") return;
  let storage = null;
  try { storage = window.localStorage; } catch (_) {}
  if (!storage) return;

  let controller = null;
  let timer = null;
  const mobile = typeof window.matchMedia === "function" ? window.matchMedia(XCO_MOBILE_QUERY) : null;
  controller = createCrossCompanyAlerts({
    storage: storage,
    fetchSnapshot: function () { return api("/api/banks/pending-tx/all-companies", { bg: true }); },
    createAlarm: function (companyId) {
      return window.createEscalatingAlarm({
        preset: XCO_ALARM_PRESET,
        soundSrc: XCO_ALARM_SOUND,
        keyPrefix: XCO_ALARM_PREFIX,
        scope: companyId,
      });
    },
    render: createXcoRenderer(function () { return controller; }),
    navigate: xcoNavigate,
    maxVisible: function () { return mobile && mobile.matches ? 0 : XCO_MAX_VISIBLE; },
  });
  // 转屏 / 拉宽窗口跨过断点：用上一份快照重算，不等下一轮轮询。
  if (mobile && typeof mobile.addEventListener === "function") {
    mobile.addEventListener("change", function () { controller.rerender(); });
  }

  const poll = function () {
    controller.poll().then(function (plan) {
      // admin / 只授权一家：服务端说 enabled=false 就彻底停，不再每 8 秒白打一次。
      if (plan && !plan.enabled && timer) {
        clearInterval(timer);
        timer = null;
      }
    }).catch(function () {});
  };
  poll();
  timer = setInterval(poll, XCO_POLL_MS);
  window.addEventListener("company-changed", poll);
  window.addEventListener("storage", function (e) {
    if (e.key === XCO_SEEN_KEY) controller.rerender();
  });
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", startCrossCompanyAlerts);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    planAlerts: xcoPlanAlerts,
    markSeen: xcoMarkSeen,
    createCrossCompanyAlerts: createCrossCompanyAlerts,
    XCO_SEEN_KEY: XCO_SEEN_KEY,
    XCO_MAX_VISIBLE: XCO_MAX_VISIBLE,
    XCO_ALARM_PREFIX: XCO_ALARM_PREFIX,
    XCO_ALARM_PRESET: XCO_ALARM_PRESET,
  };
}
