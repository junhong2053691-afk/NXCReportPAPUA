(function () {
  "use strict";

  // 支付渠道页（/bank-channels.html）：全部渠道汇总、运营中 / 封禁中 / 已归档三个页签、
  // 渠道编辑、转出封禁户余额。2026-11 从 bank-accounts.js 拆出来；流水、审批、调钱在
  // bank-ledger.js。两页共用的格式化与口径在 bank-common.js。
  //
  // 渠道生命周期判定的唯一入口（镜像见 app.js 的 window.BankLifecycle，真源在
  // server/lib/bankLifecycle.js）。不要在本文件里再写 lifecycle_status 的字面量比较。
  const LC = window.BankLifecycle;
  const BC = window.BankCommon;
  const {
    tr, esc, ledgerNameText, fmt, fmtMetric, parseNum, statusLabel, statusClass,
    KIND_LABEL, bankBranchOf, tabLabel, isBalanceExcluded,
  } = BC;

  let bankRows = [];
  let cStatusOptions = [];
  let dailyReport = null;
  let editingBankId = null;
  let bankReorderBusy = false;
  let draggedBankId = null;
  // 三个页签的视图状态。每个页签各自记页码（切回来还在原处），搜索词跨页签共享。
  // BKD_PAGE_SIZE 把封禁 / 归档同时渲染的行数钉死；运营中不分页（要能整列拖拽排序）。
  let bkdTab = "operating";
  const bkdPage = { operating: 1, banned: 1, archived: 1 };
  let bkdQuery = "";
  const BKD_PAGE_SIZE = 20;
  // 每行详情 2026-11-09 起常驻展开（用户要求不折叠）。后台每 5 秒可能整块重画，详情 HTML 按
  // 渠道缓存、签名不变就直接复用，否则每次重画都要对每行再打 2 个请求。换公司时 detailGen++，
  // 迟到的旧响应一律丢掉。
  const bkdDetailCache = new Map(); // id -> { sig, html }
  let detailGen = 0;
  const DETAIL_CONCURRENCY = 3;
  let detailQueue = [];
  let detailActive = 0;
  // 正在拉的渠道 id。拉的途中页面被重画（首屏 loadBanks 与 loadDailyReport 各画一次），新节点
  // 又是 data-loaded="0"，不挡住就会对同一户重复请求；响应回来时按 id 写进当前那个节点。
  const detailInflight = new Set();

  let bankLoadRequest = 0;
  let reportLoadRequest = 0;
  let refreshInFlight = false;
  // 后台 5 秒轮询：数据没变就不重绘（规则见 render-gate.js）。
  const renderGate = window.createRenderGate();
  const isBackground = (opts) => Boolean(opts) && opts.background === true;
  function gateRender(key, opts, data) {
    if (isBackground(opts)) return renderGate.changed(key, data);
    renderGate.remember(key, data);
    return true;
  }

  function usableBanks() {
    return BC.usableBanks(bankRows);
  }
  function totalBalance() {
    return BC.totalBalance(bankRows, dailyReport);
  }
  function bankDisplayBalance(b) {
    return BC.bankDisplayBalance(b, dailyReport);
  }
  function cStatusNames() {
    return BC.cStatusNames(cStatusOptions);
  }

  function loadBanks(opts) {
    const request = ++bankLoadRequest;
    return api("/api/banks", { bg: true }).then((d) => {
      if (request !== bankLoadRequest) return;
      bankRows = d.rows || [];
      if (!gateRender("banks", opts, bankRows)) return;
      renderChannels();
    });
  }
  // 余额 / 笔数 / 流出的口径与当日流水页一致：取今天的日报，只用 bankRows 与 totals。
  function loadDailyReport(opts) {
    const request = ++reportLoadRequest;
    return api(`/api/banks/daily-report?date=${encodeURIComponent(todaySydney())}`, { bg: true })
      .then((d) => {
        if (request !== reportLoadRequest) return;
        dailyReport = d;
        if (!gateRender("report", opts, { bankRows: d.bankRows, totals: d.totals })) return;
        renderChannels();
      })
      .catch(() => {});
  }
  // 渠道详情里的流水要画状态标签（STATUS 是租户可改的），转出余额要 C STATUS 候选。
  function loadStatusOptions() {
    return BC.loadStatusOptions().catch(() => {});
  }
  function loadCStatus() {
    return api("/api/banks/c-status-options", { bg: true }).then((d) => {
      cStatusOptions = d.options || [];
      const dl = document.getElementById("cstatus-datalist");
      if (!dl) return;
      dl.setAttribute("translate", "no"); // bank_c_status_options.name is tenant data
      dl.innerHTML = cStatusNames().map((o) => `<option value="${esc(o)}">`).join("");
    }).catch(() => {});
  }

  function bankDirectoryStats(b) {
    const stats = (dailyReport?.bankRows || []).find((r) => r.id === b.id);
    return {
      txCount: Number(stats?.tx_count ?? 0),
      outflow: Math.abs(Number(stats?.total_outflow ?? b.total_outflow ?? 0)),
      displayBalance: bankDisplayBalance(b),
      excluded: isBalanceExcluded(b),
      isPG: String(b.account_kind || "nominee") === "payment_gateway",
      overAlert: BC.alertThresholdReached(b, dailyReport),
    };
  }
  function bankDirectoryStatusHtml(b, stats) {
    const alertFlag = stats.overAlert
      ? '<span class="bk-flag bk-flag-alert" title="余额已达报警阈值">⚠️</span>'
      : "";
    if (stats.isPG) {
      return '<span class="bk-flag bk-flag-pg" title="PaymentGateway 余额不计入合计">PG</span>' + alertFlag;
    }
    // 「使用中 / 未启用」2026-11-09 取消，换成只读的「实时收款」标（在当日流水的银行列表里勾）。
    return (Number(b.live_receiving) ? '<span class="bk-flag bk-flag-live">实时收款</span>' : "") + alertFlag;
  }
  // 「运营中」页签的一行。点行本身去当日流水（筛到这个渠道），操作按钮各管各的。
  function bankDirectoryRowHtml(b, index, draggable) {
    const stats = bankDirectoryStats(b);
    const bankLabel = bankBranchOf(b) || "未命名渠道";
    const accountName = String(b.account_name || "").trim();
    const nameHtml = accountName ? `<div class="bk-channel-sub"><span class="bk-name-label">NAME</span><span translate="no">${esc(accountName)}</span></div>` : "";
    const drag = draggable ? ' draggable="true"' : "";
    const handle = draggable
      ? `<button type="button" class="bk-order-handle" draggable="true" aria-label="Drag ${esc(bankLabel)} to reorder" title="Drag to reorder"><i data-lucide="grip-vertical"></i></button>`
      : "";
    return `<article class="bk-bank-row${stats.isPG ? " bk-bank-row-pg" : ""}" data-id="${b.id}" role="listitem" tabindex="0"${drag} title="${esc(tr("点击查看这个渠道的当日流水"))}">
<div class="bk-col-order">${handle}<span class="bk-row-no">${index + 1}</span></div>
<div class="bk-col-channel"><span class="bk-field-group-label bk-channel-label">BANK BRANCH</span><div class="bk-channel-name"><strong translate="no">${esc(bankLabel)}</strong>${bankDirectoryStatusHtml(b, stats)}</div>${nameHtml}<div class="bk-channel-meta"><span class="kind-tag kind-${esc(b.account_kind || "nominee")}">${esc(KIND_LABEL[b.account_kind] || b.account_kind || "人头")}</span></div></div>
<div class="bk-col-info"><span class="bk-field-group-label">银行资料</span>${BC.bankInfoHtml(b)}</div>
<div class="bk-col-balance"><div class="bk-metric-grid"><div class="bk-metric bk-metric-balance"><span>BALANCE</span><strong class="bk-row-balance${stats.excluded ? " bk-balance-excluded" : ""}">${fmt(stats.displayBalance)}</strong></div><div class="bk-metric"><span>COUNT</span><strong>${fmtMetric(stats.txCount)}</strong></div><div class="bk-metric bk-metric-outflow"><span>TOTAL OUTFLOW</span><strong>${fmt(stats.outflow)}</strong></div></div>${stats.excluded ? '<span class="bk-row-flow bk-excluded-note">不计入总余额</span>' : ""}</div>
<div class="bk-col-actions"><button type="button" class="bk-copy-btn" data-copy-bank-id="${b.id}" title="Copy complete bank information"><i data-lucide="copy"></i><span>Copy info</span></button><div class="bk-row-acts"><button type="button" class="btn btn-outline btn-xs bkd-edit-btn" data-id="${b.id}">${esc(tr("编辑"))}</button><button type="button" class="btn btn-outline btn-xs bkd-ban-btn" data-id="${b.id}">${esc(tr("封禁"))}</button></div></div>
</article>
<div class="bkd-item-body bk-row-body" id="bkd-body-${b.id}" ${bkdBodyAttrs(b)}</div>`;
  }

  function copyBankDirectoryInfo(bankId) {
    BC.copyBankInfo(bankRows.find((row) => row.id === Number(bankId)));
  }
  function persistBankDirectoryOrder(ordered) {
    if (bankReorderBusy) return;
    bankReorderBusy = true;
    const visibleIds = new Set(ordered.map((b) => b.id));
    bankRows = ordered.concat(bankRows.filter((b) => !visibleIds.has(b.id)));
    renderChannels();
    const requests = ordered.map((bank, index) => api(`/api/banks/${bank.id}`, {
      method: "PUT",
      body: JSON.stringify({ sort_order: index }),
      bg: true,
    }));
    Promise.all(requests)
      .then(() => loadBanks())
      .then(() => showToast("渠道顺序已保存", { tone: "success" }))
      .catch(() => {
        showToast("渠道顺序保存失败", { tone: "error" });
        return loadBanks().catch(() => {});
      })
      .finally(() => { bankReorderBusy = false; });
  }
  function moveBankDirectoryRow(bankId, targetIndex) {
    if (bankReorderBusy) return;
    const ordered = usableBanks().slice();
    const sourceIndex = ordered.findIndex((b) => b.id === Number(bankId));
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= ordered.length || sourceIndex === targetIndex) return;
    const [moved] = ordered.splice(sourceIndex, 1);
    ordered.splice(targetIndex, 0, moved);
    persistBankDirectoryOrder(ordered);
  }

  let bankModalLastFocus = null;
  function openBankModal(row) {
    bankModalLastFocus = document.activeElement;
    editingBankId = row ? row.id : null;
    document.getElementById("bank-modal-title").textContent = row ? "编辑支付渠道" : "新增支付渠道";
    document.getElementById("f-kind").value = row?.account_kind || "nominee";
    document.getElementById("f-bankbranch").value = bankBranchOf(row);
    document.getElementById("f-name").value = row?.account_name || "";
    document.getElementById("f-bsb").value = row?.bsb || "";
    document.getElementById("f-account").value = row?.account_number || "";
    document.getElementById("f-payid").value = row?.payid || "";
    document.getElementById("f-note").value = row?.note || "";
    // 0 表示未启用，显示为空而不是 "0"，和 placeholder「留空 = 不启用」对齐。
    const threshold = Number(row?.alert_threshold || 0);
    document.getElementById("f-alert-threshold").value = threshold > 0 ? String(threshold) : "";
    document.getElementById("f-reset-daily").checked = Boolean(row?.reset_daily_balance);
    document.getElementById("bank-modal-err").textContent = "";
    document.getElementById("bank-modal").classList.add("show");
    window.requestAnimationFrame(() => document.getElementById("f-bankbranch")?.focus());
  }
  // 关掉编辑弹窗后焦点回到原处（列表是页面本身，页签 / 页码 / 搜索词都还在）。
  // 保存后那一行会被重画，原来的按钮已经不在 DOM 里，就按选择器重新找。
  function restoreBankModalFocus(focusSelector) {
    window.requestAnimationFrame(() => {
      const el = (focusSelector && document.querySelector(focusSelector))
        || (bankModalLastFocus && document.contains(bankModalLastFocus) ? bankModalLastFocus : null)
        || document.querySelector(".bkd-tab.active");
      el?.focus();
      bankModalLastFocus = null;
    });
  }
  function closeBankModal() {
    document.getElementById("bank-modal").classList.remove("show");
    editingBankId = null;
    restoreBankModalFocus();
  }
  function saveBankModal() {
    const bank_branch = document.getElementById("f-bankbranch").value.trim();
    const account_name = document.getElementById("f-name").value.trim();
    const account_number = document.getElementById("f-account").value.trim();
    const payid = document.getElementById("f-payid").value.trim();
    if (!bank_branch && !account_name && !account_number && !payid) {
      document.getElementById("bank-modal-err").textContent = "请至少填写 BankBranch、NAME、ACCOUNT 或 PAYID 其中一项";
      return;
    }
    const thresholdRaw = document.getElementById("f-alert-threshold").value.replace(/,/g, "").trim();
    if (thresholdRaw && !(Number(thresholdRaw) >= 0)) {
      document.getElementById("bank-modal-err").textContent = "余额上限报警必须是不小于 0 的数字";
      return;
    }
    const body = {
      bank_branch, account_name,
      bsb: document.getElementById("f-bsb").value.trim(),
      account_number, payid,
      note: document.getElementById("f-note").value.trim(),
      account_kind: document.getElementById("f-kind").value,
      reset_daily_balance: document.getElementById("f-reset-daily").checked ? 1 : 0,
      alert_threshold: thresholdRaw ? Number(thresholdRaw) : 0,
    };
    const wasNew = !editingBankId;
    const url = editingBankId ? `/api/banks/${editingBankId}` : "/api/banks";
    const method = editingBankId ? "PUT" : "POST";
    api(url, { method, body: JSON.stringify(body) })
      .then((d) => {
        document.getElementById("bank-modal").classList.remove("show");
        editingBankId = null;
        // 刻意不切换流水的渠道筛选：以前新建后会筛到新户，流水显示「当天暂无流水」、KPI 变 0，
        // 调钱弹窗还会预选它，员工把调钱绑到了空户口上（员工演练 4/4）。筛选只由员工自己点。
        return loadBanks().then(loadDailyReport).then(() => {
          restoreBankModalFocus(wasNew ? "#add-bank-btn" : `.bkd-edit-btn[data-id="${d.row?.id || ""}"]`);
        });
      })
      .catch((e) => {
        document.getElementById("bank-modal-err").textContent = e.message || "保存失败，请重试";
      });
  }

  function bkdTxRow(r, dir) {
    const amt = dir === "in"
      ? Number(r.amount_in || 0) + Number(r.trf_amount || 0)
      : Number(r.amount_out || 0) + Number(r.help_amount || 0);
    const name = ledgerNameText(r.name);
    return `<tr>
      <td class="mono">${esc(String(r.entry_time || "").slice(0, 16))}</td>
      <td translate="no"><span class="status-chip ${statusClass(r.status)}">${esc(statusLabel(r.status))}</span></td>
      <td class="mono">${esc(r.tx_id || "")}</td>
      <td class="mono bkd-amt ${dir === "in" ? "bkd-in" : "bkd-out"}">${dir === "in" ? "+" : "-"}${fmt(amt)}</td>
      <td translate="no">${esc(r.username || "")}${name ? ` · ${esc(name)}` : ""}</td>
    </tr>`;
  }

  function bkdTxRowFull(r, dir) {
    const amt = dir === "in"
      ? Number(r.amount_in || 0) + Number(r.trf_amount || 0)
      : Number(r.amount_out || 0) + Number(r.help_amount || 0);
    const user = [r.username, ledgerNameText(r.name), r.c_status].filter(Boolean).join(" · ");
    return `<tr>
      <td class="mono">${esc(String(r.entry_time || "").slice(0, 16))}</td>
      <td translate="no"><span class="status-chip ${statusClass(r.status)}">${esc(statusLabel(r.status))}</span></td>
      <td class="mono">${esc(r.tx_id || "")}</td>
      <td class="mono bkd-amt ${dir === "in" ? "bkd-in" : "bkd-out"}">${dir === "in" ? "+" : "-"}${fmt(amt)}</td>
      <td class="bkd-user-full" translate="no">${esc(user || "-")}</td>
      <td class="bkd-remark-full" translate="no">${esc(r.remark || "")}</td>
    </tr>`;
  }

  // \u94f6\u884c\u7533\u8bc9\u7528\uff1a\u8fd9\u4e2a\u6237\u53e3\u5168\u90e8\u5ba2\u6237\u5165\u8d26 + \u6237\u53e3\u62ac\u5934\u4e0e\u5408\u8ba1\uff08\u670d\u52a1\u7aef appealExport.js\uff0cCSV \u89c1 appeal-csv.js\uff09\u3002
  // \u4ee5\u524d\u53ea\u5bfc\u6700\u8fd1 10 \u8fdb 10 \u51fa\u3001\u6df7\u7740\u5185\u90e8\u8c03\u94b1\uff0c\u62ff\u53bb\u7533\u8bc9\u4e0d\u591f\u7528\uff08\u5458\u5de5\u6f14\u7ec3\uff0c\u7528\u9014 2026-11-06 \u4e0e\u7528\u6237\u786e\u8ba4\uff09\u3002
  function downloadBkdCsv(bank) {
    return api(`/api/banks/${bank.id}/appeal-deposits`)
      .then((d) => {
        const csv = window.buildAppealCsv(bank, d.rows || [], { nameOf: ledgerNameText });
        const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const safeName = String(bankBranchOf(bank) || "bank").replace(/[\\/:*?"<>|]+/g, "_");
        a.download = `${safeName}-appeal-deposits.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      })
      .catch((e) => showToast(e.message || "\u4e0b\u8f7d\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5", { tone: "error" }));
  }

  // 值一侧全是租户数据（银行名、户名、BSB、账号、PayID、备注、金额），一律 translate="no"：
  // 否则中英切换会去动它们，也挡不住浏览器自带的自动翻译。标签一侧照常翻译。
  function bkdInfoPair(label, val, mono) {
    if (!val && val !== 0) return "";
    return `<div class="bkd-pair"><span class="bkd-pair-label">${esc(label)}</span><span class="bkd-pair-val${mono ? " mono" : ""}" translate="no">${esc(String(val))}</span></div>`;
  }

  // 详情缓存的签名：余额、笔数、资料与生命周期任何一项变了都要重拉（refreshBankBalance 会
  // 改 updated_at，所以记一笔流水也算变了）。
  function detailSig(b) {
    return [b.updated_at, b.tx_count, b.total_in, b.total_out, b.balance, bankDisplayBalance(b), b.lifecycle_status, b.live_receiving].join("|");
  }
  // 详情容器的属性 + 内容：缓存命中就直接给 HTML（data-loaded="1"），否则占位等队列去拉。
  function bkdBodyAttrs(b) {
    const hit = bkdDetailCache.get(b.id);
    if (hit && hit.sig === detailSig(b)) return `data-loaded="1">${hit.html}`;
    return `data-loaded="0"><div class="bkd-loading">${esc(tr("加载中..."))}</div>`;
  }
  function queueBkdDetails(rows) {
    detailQueue = rows.map((b) => b.id);
    pumpBkdDetails();
  }
  function pumpBkdDetails() {
    while (detailActive < DETAIL_CONCURRENCY && detailQueue.length) {
      const id = detailQueue.shift();
      const bodyEl = document.getElementById(`bkd-body-${id}`);
      if (!bodyEl || bodyEl.dataset.loaded !== "0" || detailInflight.has(id)) continue;
      detailActive += 1;
      detailInflight.add(id);
      loadBkdDetail(id, bodyEl).finally(() => {
        detailActive -= 1;
        detailInflight.delete(id);
        pumpBkdDetails();
      });
    }
  }

  function loadBkdDetail(bankId, bodyEl) {
    const b = bankRows.find((r) => r.id === bankId);
    if (!b) return Promise.resolve();
    bodyEl.dataset.loaded = "1";
    const gen = detailGen;
    const sig = detailSig(b);
    return Promise.all([
      api(`/api/banks/${bankId}/recent-transactions`, { bg: true }),
      api(`/api/banks/${bankId}/events`, { bg: true }),
    ]).then(([txData, evData]) => {
      if (gen !== detailGen) return;
      const recentIn = txData.recentIn || [];
      const recentOut = txData.recentOut || [];
      const events = evData.rows || [];

      const bannedEvent = events.find((e) => e.event === "banned");
      const bannedInfo = bannedEvent
        ? `<div class="bkd-ban-info">封禁于 <strong>${esc(window.sqlUtcToSydney(bannedEvent.created_at, { dateOnly: true }))}</strong>${bannedEvent.actor ? ` · ${esc(bannedEvent.actor)}` : ""}${bannedEvent.note ? ` · ${esc(bannedEvent.note)}` : ""}</div>`
        : "";

      const infoGrid = `<div class="bkd-info-grid">
        ${bannedInfo}
        ${bkdInfoPair("银行", bankBranchOf(b))}
        ${bkdInfoPair("户名", b.account_name)}
        ${bkdInfoPair("BSB", b.bsb, true)}
        ${bkdInfoPair("账号 ACC", b.account_number, true)}
        ${bkdInfoPair("PayID", b.payid)}
        ${bkdInfoPair("余额", fmt(bankDisplayBalance(b)))}
        ${bkdInfoPair("备注", b.note)}
        <div class="bkd-pair"><span class="bkd-pair-label">状态</span><span class="bkd-pair-val">${
          LC.isArchived(b)
            ? '<span class="bk-flag bk-flag-archived">已归档</span>'
            : LC.isBanned(b)
              ? '<span class="bk-flag bk-flag-banned">封禁中</span>'
              : '<span class="bk-flag bk-flag-active">运营中</span>'
        }</span></div>
      </div>`;

      const txSection = `<div class="bkd-tx-toolbar"><button type="button" class="btn btn-outline btn-xs bkd-download-btn" data-id="${b.id}" title="这个户口全部客户入账，带户名、BSB、账号与合计，给银行申诉用">下载申诉记录 (CSV)</button></div><div class="bkd-tx-wrap">
        <div class="bkd-tx-col">
          <div class="bkd-tx-title bkd-tx-in-title">最近 10 笔入账</div>
          ${recentIn.length
            ? `<table class="bkd-tx-table"><thead><tr><th>时间</th><th>STATUS</th><th>TRANS ID</th><th>IN</th><th>USER / NAME / C STATUS</th><th>REMARK</th></tr></thead><tbody>${recentIn.map((r) => bkdTxRowFull(r, "in")).join("")}</tbody></table>`
            : '<p class="bkd-empty">暂无入账记录</p>'}
        </div>
        <div class="bkd-tx-col">
          <div class="bkd-tx-title bkd-tx-out-title">最近 10 笔出账</div>
          ${recentOut.length
            ? `<table class="bkd-tx-table"><thead><tr><th>时间</th><th>STATUS</th><th>TRANS ID</th><th>OUT</th><th>USER / NAME / C STATUS</th><th>REMARK</th></tr></thead><tbody>${recentOut.map((r) => bkdTxRowFull(r, "out")).join("")}</tbody></table>`
            : '<p class="bkd-empty">暂无出账记录</p>'}
        </div>
      </div>`;

      // 事件码 / 类型码转中文（display-format.js）；操作人与封禁原因是租户数据，不翻译。
      const evList = events.slice(0, 10).map((e) => {
        const note = e.event === "created"
          ? ` · <span>${esc(window.accountKindLabel(e.note))}</span>`
          : (e.note ? ` · <span translate="no">${esc(e.note)}</span>` : "");
        return `<li><strong>${esc(window.accountEventLabel(e.event))}</strong><span class="bkd-ev-time"> ${esc(window.sqlUtcToSydney(e.created_at))}</span>${e.actor ? ` · <span translate="no">${esc(e.actor)}</span>` : ""}${note}</li>`;
      }).join("") || "<li>暂无记录</li>";
      const evSection = `<details class="bkd-events-wrap"><summary>操作历史</summary><ul class="bkd-events-list">${evList}</ul></details>`;

      const html = `<div class="bkd-detail">${infoGrid}${txSection}${evSection}</div>`;
      // 签名按「写入时」的数据取：拉的途中日报到了（余额显示口径变了）就记成未命中，下一轮重画再拉一次。
      const now = bankRows.find((r) => r.id === bankId);
      bkdDetailCache.set(bankId, { sig: now && detailSig(now) === sig ? sig : "", html });
      // 拉的这段时间里这一行可能已经被重画过：按 id 找当前那个节点写进去。
      const target = document.getElementById(`bkd-body-${bankId}`) || bodyEl;
      target.innerHTML = html;
      target.dataset.loaded = "1";
    }).catch(() => {
      if (gen !== detailGen) return;
      bodyEl.innerHTML = '<div class="bkd-empty">加载失败，请重试</div>';
    });
  }

  // 「账户里还剩多少钱」的权威口径：后端 enrichBankRow 塞进来的 balance，就是无上界的
  // balanceFromLedger。待清条和归档按钮的可用性都用它，两者永不打架。
  // 刻意不用 bankDisplayBalance()——那是页面显示口径，对每日归零账户只给当日净额，
  // 拿它判断「清干净了没有」会把累计还有钱的账户当成空的。
  function bankLedgerBalance(b) {
    return Number(b.balance || 0);
  }
  function isBkdCleared(b) {
    return Math.round(bankLedgerBalance(b) * 100) === 0;
  }

  function bkdPredicate(tab) {
    if (tab === "banned") return LC.isBanned;
    if (tab === "archived") return LC.isArchived;
    if (tab === "operating") return LC.isOperating;
    return null;
  }

  function bkdFiltered(tab) {
    // 封禁中页签选了某个月：换成「当月被封」口径（含已归档），见 renderMonthBar。
    const pred = tab === "banned" && bkdMonth !== MONTH_ALL
      ? bannedInMonth
      : (bkdPredicate(tab) || LC.isOperating);
    const q = bkdQuery.trim().toLowerCase();
    return bankRows.filter((b) => {
      if (!pred(b)) return false;
      if (!q) return true;
      return [bankBranchOf(b), b.account_name, b.account_number, b.payid, b.bsb, b.note]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }

  function buildBkdItem(b) {
    const status = LC.statusOf(b);
    const banned = status === "banned";
    const archived = status === "archived";
    const idx = usableBanks().findIndex((x) => x.id === b.id);
    const noTag = idx >= 0 ? `<span class="bk-no">${idx + 1}</span>` : "";
    const excludedNote = isBalanceExcluded(b)
      ? `<span class="bkd-excl-tag">${esc(tr("不计汇总"))}</span>`
      : "";
    const statusTag = archived
      ? `<span class="bk-flag bk-flag-archived">${esc(tr("已归档"))}</span>`
      : banned
        ? `<span class="bk-flag bk-flag-banned">${esc(tr("封禁中"))}</span>`
        : "";

    // 操作按钮按状态分化。已归档行不给编辑——UI 上也要让「归档即惰性」成立：要改资料先取消归档。
    let acts = "";
    if (archived) {
      acts = `<button type="button" class="btn btn-outline btn-xs bkd-unarchive-btn" data-id="${b.id}">${esc(tr("取消归档"))}</button>`;
    } else if (banned) {
      const archiveBtn = isBkdCleared(b)
        ? `<button type="button" class="btn btn-outline btn-xs bkd-archive-btn" data-id="${b.id}">${esc(tr("归档"))}</button>`
        : `<button type="button" class="btn btn-outline btn-xs bkd-archive-btn" data-id="${b.id}" disabled title="${esc(tr("尚余"))} ${esc(fmt(bankLedgerBalance(b)))} ${esc(tr("待清"))}">${esc(tr("归档"))}</button>`;
      acts =
        `<button type="button" class="btn btn-outline btn-xs bkd-edit-btn" data-id="${b.id}">${esc(tr("编辑"))}</button>`
        + `<button type="button" class="btn btn-outline btn-xs bkd-unban-btn" data-id="${b.id}">${esc(tr("解封"))}</button>`
        // 有钱才给「转出余额」：不用解封再封回去（员工演练发现）。
        + (bankLedgerBalance(b) > 0.004 ? `<button type="button" class="btn btn-outline btn-xs bkd-drain-btn" data-id="${b.id}">${esc(tr("转出余额"))}</button>` : "")
        + archiveBtn;
    } else {
      acts =
        `<button type="button" class="btn btn-outline btn-xs bkd-edit-btn" data-id="${b.id}">${esc(tr("编辑"))}</button>`
        + `<button type="button" class="btn btn-outline btn-xs bkd-ban-btn" data-id="${b.id}">${esc(tr("封禁"))}</button>`;
    }

    const cls = `bkd-item${banned ? " bkd-item-banned" : ""}${archived ? " bkd-item-archived" : ""}`;
    // 银行名与户名是租户数据，必须 translate="no"：否则中英切换会把
    // 「Public Bank Amy」改成「Public 银行 Amy」，顺带也挡住浏览器自带的自动翻译。
    return `<div class="${cls}" data-id="${b.id}">
  <div class="bkd-item-head">
    ${noTag}
    <span class="kind-tag kind-${esc(b.account_kind || "nominee")}">${esc(KIND_LABEL[b.account_kind] || b.account_kind || "人头")}</span>
    <span class="bkd-item-name" translate="no">${esc(bankBranchOf(b) || "Bank")}<span class="bkd-item-sub"> ${esc(b.account_name || "")}</span></span>
    ${statusTag}
    ${b.banned_at && (banned || archived) ? `<span class="bkd-ban-date"><span>${esc(tr("封禁于"))}</span> <span translate="no">${esc(window.sqlUtcToSydney(b.banned_at, { dateOnly: true }))}</span></span>` : ""}
    ${excludedNote}
    <span class="bkd-item-bal" translate="no">${fmt(bankDisplayBalance(b))}</span>
    <div class="bkd-item-acts">
      ${acts}
    </div>
  </div>
  <div class="bkd-item-body" id="bkd-body-${b.id}" ${bkdBodyAttrs(b)}</div>
</div>`;
  }

  // \u5e38\u9a7b\u5f85\u6e05\u6761\u3002\u53ea\u770b\u5c01\u7981\u4e2d\u7684\u8d26\u6237\uff1a\u5f52\u6863\u7684\u5df2\u88ab\u95f8\u95e8\u4fdd\u8bc1\u6e05\u96f6\uff0c\u8fd0\u8425\u4e2d\u7684\u672c\u6765\u5c31\u5728\u7528\u3002
  function renderBkdCleanupBar() {
    const bar = document.getElementById("bkd-cleanup-bar");
    if (!bar) return;
    const dirty = bankRows.filter((b) => LC.isBanned(b) && !isBkdCleared(b));
    const total = dirty.reduce((s, b) => s + bankLedgerBalance(b), 0);
    bar.classList.toggle("is-alert", dirty.length > 0);
    bar.classList.toggle("is-clean", dirty.length === 0);
    if (!dirty.length) {
      bar.innerHTML = `<span>${esc(tr("\u5c01\u7981\u4e2d\u65e0\u5f85\u6e05\u7406"))}</span>`;
      return;
    }
    // \u6570\u5b57\u5404\u81ea\u72ec\u7acb\u6210\u8282\u70b9\uff0c\u6587\u672c\u8282\u70b9\u91cc\u4e0d\u6df7\u53d8\u91cf\u2014\u2014i18n \u5f15\u64ce\u6309\u6574\u4e32\u67e5\u5b57\u5178\uff0c\u6df7\u4e86\u5c31\u5f97\u5199
    // phrase \u89c4\u5219\uff0c\u800c\u53cd\u5411\u89c4\u5219\u5f88\u5bb9\u6613\u8bef\u547d\u4e2d\u771f\u5b9e\u6570\u636e\u3002
    bar.innerHTML =
      `<span>${esc(tr("\u5c01\u7981\u4e2d\u5f85\u6e05\u7406"))}</span>`
      + `<strong translate="no">${dirty.length}</strong>`
      + `<span>${esc(tr("\u6237 \u00b7 \u5408\u8ba1"))}</span>`
      + `<strong translate="no">${esc(fmt(total))}</strong>`;
  }

  function renderBkdTabs() {
    const wrap = document.getElementById("bkd-tabs");
    if (!wrap) return;
    const counts = {
      operating: bankRows.filter(LC.isOperating).length,
      banned: bankRows.filter(LC.isBanned).length,
      archived: bankRows.filter(LC.isArchived).length,
    };
    wrap.querySelectorAll(".bkd-tab").forEach((btn) => {
      const tab = btn.dataset.tab;
      const on = tab === bkdTab;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
      btn.tabIndex = on ? 0 : -1;
      // \u8ba1\u6570\u662f\u300c\u8fd9\u4e2a\u72b6\u6001\u4e00\u5171\u51e0\u4e2a\u300d\uff0c\u4e0d\u53d7\u641c\u7d22\u5f71\u54cd\uff1b\u641c\u7d22\u547d\u4e2d\u6570\u7531\u5206\u9875\u5668\u8868\u8fbe\u3002
      // \u539f\u59cb\u6807\u7b7e\u5b58\u8fdb dataset\uff0c\u907f\u514d\u53cd\u590d\u8ffd\u52a0 (n) \u65f6\u628a\u4e0a\u4e00\u6b21\u7684\u62ec\u53f7\u4e5f\u5f53\u6210\u6807\u7b7e\u3002
      if (!btn.dataset.label) btn.dataset.label = btn.textContent.trim().replace(/\s*\(\d+\)$/, "");
      const n = counts[tab] || 0;
      btn.textContent = n > 0 ? `${btn.dataset.label} (${n})` : btn.dataset.label;
    });
  }

  function bkdEmptyText(tab) {
    if (tab === "banned") return bkdMonth === MONTH_ALL ? tr("\u6682\u65e0\u5c01\u7981\u6e20\u9053") : tr("\u5f53\u6708\u6ca1\u6709\u5c01\u7981\u7684\u6e20\u9053");
    if (tab === "archived") return tr("\u6682\u65e0\u5df2\u5f52\u6863\u6e20\u9053");
    return tr("\u6682\u65e0\u8fd0\u8425\u6e20\u9053");
  }

  function renderBkdPanel() {
    const panel = document.getElementById("bkd-panel");
    if (!panel) return;
    if (bkdTab === "operating") {
      const operating = renderOperatingPanel(panel);
      document.getElementById("bkd-pager")?.setAttribute("hidden", "");
      renderIcons(panel);
      queueBkdDetails(operating);
      return;
    }
    const rows = bkdFiltered(bkdTab);
    // \u9875\u7801\u94b3\u4f4d\u5fc5\u987b\u5728\u5207\u7247\u4e4b\u524d\uff1a\u5f52\u6863\u6389\u6700\u540e\u4e00\u9875\u6700\u540e\u4e00\u884c\u4e4b\u540e\u9875\u7801\u4f1a\u8d85\u754c\uff0c\u5426\u5219\u9762\u677f\u7a7a\u767d
    // \u800c\u5206\u9875\u5668\u8fd8\u505c\u5728\u7b2c 3 \u9875\u3002
    const pages = Math.max(1, Math.ceil(rows.length / BKD_PAGE_SIZE));
    const page = Math.min(Math.max(1, bkdPage[bkdTab] || 1), pages);
    bkdPage[bkdTab] = page;
    const slice = rows.slice((page - 1) * BKD_PAGE_SIZE, page * BKD_PAGE_SIZE);

    panel.innerHTML = slice.length
      ? slice.map(buildBkdItem).join("")
      : `<div class="bkd-empty">${esc(bkdQuery.trim() ? tr("\u6ca1\u6709\u5339\u914d\u7684\u6e20\u9053") : bkdEmptyText(bkdTab))}</div>`;

    // \u8d26\u6237\u5c11\u4e8e\u4e00\u9875\u65f6 renderClientPager \u81ea\u5df1\u9690\u85cf\uff0c\u6240\u4ee5\u73b0\u72b6\u4e0b\u96f6\u89c6\u89c9\u4ee3\u4ef7\uff0c\u89c4\u6a21\u957f\u4e0a\u53bb\u81ea\u52a8\u751f\u6548\u3002
    renderClientPager("bkd-pager", rows.length, page, BKD_PAGE_SIZE, (p) => {
      bkdPage[bkdTab] = p;
      renderBkdPanel();
      panel.scrollTop = 0;
    });
    renderIcons(panel);

    // 详情常驻：没缓存（或数据变了）的行排队拉，最多 DETAIL_CONCURRENCY 个并发。
    queueBkdDetails(slice);
  }

  function switchBkdTab(tab) {
    if (!bkdPredicate(tab)) return;
    bkdTab = tab;
    renderBkdTabs();
    renderMonthBar();
    renderBkdPanel();
    const panel = document.getElementById("bkd-panel");
    if (panel) panel.scrollTop = 0;
  }

  // \u4e09\u9875\u7b7e\u7684\u7ed3\u6784\u6027\u4f5c\u7528\uff1a\u540c\u4e00\u65f6\u523b\u53ea\u6e32\u67d3\u4e00\u4e2a\u9875\u7b7e\uff0c\u6240\u4ee5\u5c01\u7981\u7684\u6e20\u9053\u518d\u591a\u4e5f\u4e0d\u53ef\u80fd\u628a\u8fd0\u8425\u4e2d
  // \u7684\u6324\u51fa\u89c6\u91ce\u3002\u8fd9\u4e0d\u662f\u9760\u300c\u9ed8\u8ba4\u6298\u53e0\u300d\u7684\u81ea\u89c9\uff0c\u662f\u7269\u7406\u4e0a\u505a\u4e0d\u5230\u3002
  //
  // \u5c01\u7981 / \u89e3\u5c01 / \u5f52\u6863 / \u53d6\u6d88\u5f52\u6863 / \u52fe\u9009\u4f7f\u7528\u4e2d\u7edf\u4e00\u8d70\u8fd9\u91cc\uff1a\u5b58\u8fd8\u6eda\u52a8\u4f4d\u7f6e\u3001\u4fdd\u4f4f\u9875\u7b7e\uff0c
  // \u5e76\u628a\u7126\u70b9\u515c\u5e95\u5230\u5f53\u524d\u9875\u7b7e\u6309\u94ae\u2014\u2014\u5f52\u6863\u6210\u529f\u540e\u90a3\u4e00\u884c\u4f1a\u79bb\u5f00\u5f53\u524d\u9875\u7b7e\uff0cfocusSelector
  // \u67e5\u4e0d\u5230\uff0c\u7126\u70b9\u5c31\u4f1a\u6389\u5230 <body>\uff0c\u952e\u76d8\u64cd\u4f5c\u7684\u4eba\u4f1a\u4e22\u5931\u4f4d\u7f6e\u3002
  function bkdMutate(promise, focusSelector) {
    return promise
      .then(() => loadBanks())
      .then(() => {
        renderChannels();
        const el = focusSelector ? document.querySelector(focusSelector) : null;
        (el || document.querySelector(".bkd-tab.active"))?.focus();
      })
      .then(() => loadDailyReport())
      .catch((e) => {
        if (e && e.cancelled) return;
        showToast(e?.message || tr("\u64cd\u4f5c\u5931\u8d25"), { tone: "error" });
      });
  }

  function bankTargetFor(id) {
    const b = bankRows.find((x) => String(x.id) === String(id));
    if (!b) return "";
    return window.bankTargetDetail(b, { label: bankBranchOf(b), balance: bankLedgerBalance(b) });
  }

  function setupAC(inputId, dropId, field) {
    const inp = document.getElementById(inputId);
    if (!inp) return;
    inp.addEventListener("input", () => {
      api(`/api/banks/suggestions?field=${field}&q=${encodeURIComponent(inp.value.trim())}`, { bg: true })
        .then((d) => {
          const el = document.getElementById(dropId);
          if (!el) return;
          const items = d.suggestions || [];
          if (!items.length) { el.style.display = "none"; return; }
          // 定位策略交给 CSS，这里只配合：
          // 表格里的下拉是 position:fixed（.ac-sheet），要逃出 .sheet-table-wrap 的滚动
          // 容器，所以得写视口坐标；modal 里的是 absolute，靠 CSS 的 top/left 贴住
          // .ac-wrap。对后者绝不能写 inline 坐标 —— .modal 带 transform + backdrop-filter，
          // 会成为 containing block，视口坐标等于把 .modal 的位置再加一次（实测偏
          // 464×47px，下拉直接跑到 modal 外面，用户看不到任何补全建议）。
          const rect = inp.getBoundingClientRect();
          if (getComputedStyle(el).position === "fixed") {
            el.style.left = `${rect.left}px`;
            el.style.top = `${rect.bottom + 2}px`;
            el.style.width = `${Math.max(rect.width, 120)}px`;
          } else {
            el.style.left = "";
            el.style.top = "";
            el.style.width = "";
          }
          el.innerHTML = items.map((s) => `<li class="ac-item">${esc(s)}</li>`).join("");
          el.style.display = "block";
          el.querySelectorAll(".ac-item").forEach((li) => {
            li.addEventListener("mousedown", (e) => {
              e.preventDefault();
              inp.value = li.textContent;
              el.style.display = "none";
            });
          });
        });
    });
    inp.addEventListener("blur", () => {
      setTimeout(() => {
        const el = document.getElementById(dropId);
        if (el) el.style.display = "none";
      }, 150);
    });
  }

  // 封禁户「转出余额」：不解封，转到本公司运营中的户口（记两笔）或转给别家（C STATUS）。
  // 记法与校验在服务端 bankApply.drainBannedAccount。
  let drainBankId = 0;
  let drainSubmitting = false;
  function syncDrainMode() {
    const company = document.getElementById("drain-mode")?.value === "company";
    document.getElementById("drain-bank-group")?.toggleAttribute("hidden", company);
    document.getElementById("drain-cstatus-group")?.toggleAttribute("hidden", !company);
  }
  function openDrainModal(id) {
    const bank = bankRows.find((b) => String(b.id) === String(id));
    if (!bank) return;
    drainBankId = bank.id;
    const g = (key) => document.getElementById(key);
    const balance = bankLedgerBalance(bank);
    g("drain-target").textContent = bankTargetFor(bank.id);
    g("drain-mode").value = "bank";
    g("drain-bank").innerHTML = window.bankSelectOptionsHtml(usableBanks(), tabLabel);
    g("drain-cstatus").value = "";
    g("drain-amount").value = balance > 0 ? balance.toFixed(2) : "";
    g("drain-amount-hint").textContent = `BAL ${fmt(balance)}`;
    g("drain-remark").value = "";
    g("drain-err").textContent = "";
    syncDrainMode();
    g("drain-modal").classList.add("show");
  }
  function submitDrain() {
    if (drainSubmitting || !drainBankId) return;
    const g = (key) => document.getElementById(key);
    const err = g("drain-err");
    const company = g("drain-mode").value === "company";
    const body = { amount: parseNum(g("drain-amount").value), remark: g("drain-remark").value.trim() };
    if (company) body.c_status = g("drain-cstatus").value.trim();
    else body.to_bank_account_id = Number(g("drain-bank").value || 0);
    if (!(body.amount > 0)) { err.textContent = "请输入转出金额"; return; }
    if (!company && !body.to_bank_account_id) { err.textContent = "请选择收款户口"; return; }
    if (company && !body.c_status) { err.textContent = "请填写对方公司的 C STATUS"; return; }
    drainSubmitting = true;
    const submit = g("drain-submit");
    if (submit) submit.disabled = true;
    api(`/api/banks/${drainBankId}/drain`, { method: "POST", body: JSON.stringify(body) })
      .then(() => {
        g("drain-modal").classList.remove("show");
        showToast("已转出", { tone: "success" });
        return bkdMutate(Promise.resolve());
      })
      .catch((e) => { err.textContent = e.message || "转出失败，请重试"; })
      .finally(() => {
        drainSubmitting = false;
        if (submit) submit.disabled = false;
      });
  }

  // 「运营中」页签 = 原来流水页上的渠道目录（排序、余额、复制）+ 原渠道管理里的操作按钮。
  // 不分页：整列要能拖拽排序。搜索时停用拖拽——只拖一部分会把没显示的那些顺序打乱。
  function renderOperatingPanel(panel) {
    const rows = bkdFiltered("operating");
    const searching = Boolean(bkdQuery.trim());
    if (!rows.length) {
      panel.innerHTML = `<div class="bkd-empty">${esc(searching ? tr("没有匹配的渠道") : bkdEmptyText("operating"))}</div>`;
      return rows;
    }
    const order = usableBanks();
    panel.innerHTML = `<div class="bk-channel-list${searching ? " is-searching" : ""}" id="bk-channel-list" role="list" aria-label="Payment channel list"><div class="bk-channel-list-head" aria-hidden="true"><span class="bk-col-order">排序</span><span class="bk-col-channel">BANK BRANCH / NAME</span><span class="bk-col-info">BSB / ACCOUNT / PAYID</span><span class="bk-col-balance">BALANCE / COUNT / TOTAL OUTFLOW</span><span class="bk-col-actions">操作</span></div>${rows.map((b) => bankDirectoryRowHtml(b, order.findIndex((x) => x.id === b.id), !searching)).join("")}</div>`;
    return rows;
  }

  // 顶部汇总：总余额 + 运营中的渠道按类型数（人头 / 幽灵，有 PG 才显示 PG）。
  function renderChannelSummary() {
    const balance = document.getElementById("ch-total-balance");
    if (balance) balance.textContent = fmt(totalBalance());
    const counts = { nominee: 0, ghost: 0, payment_gateway: 0 };
    usableBanks().forEach((b) => {
      const kind = String(b.account_kind || "nominee");
      counts[kind in counts ? kind : "nominee"] += 1;
    });
    const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = String(n); };
    set("ch-count-nominee", counts.nominee);
    set("ch-count-ghost", counts.ghost);
    set("ch-count-pg", counts.payment_gateway);
    const pg = document.getElementById("ch-count-pg-wrap");
    if (pg) pg.hidden = counts.payment_gateway === 0;
  }

  // ---- 封禁中 · 按月查看 -------------------------------------------------------
  // 当月被封的全算：现在仍封禁中的 + 已归档的（归档的余额已清零，照样计户数）；已解封的
  // 不算。月份按最近一次封禁（banned_at，UTC）换成悉尼日期来分。「全部」= 现在所有封禁中的户，
  // 即这个页签原来的样子。合计 = 这些户里现在还剩的钱（bankLedgerBalance，与归档闸门同口径）。
  const MONTH_ALL = "all";
  let bkdMonth = currentMonth();
  function currentMonth() {
    return String(todaySydney()).slice(0, 7);
  }
  // "YYYY-MM" 往前推一个月；纯字符串运算，不经 Date（避开时区与月底日期溢出）。
  function prevMonth(m) {
    const [y, mo] = m.split("-").map(Number);
    return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
  }
  function monthsBack(from, n) {
    const out = [from];
    while (out.length < n) out.push(prevMonth(out[out.length - 1]));
    return out;
  }
  function bannedMonth(b) {
    return b.banned_at ? String(window.sqlUtcToSydney(b.banned_at, { dateOnly: true })).slice(0, 7) : "";
  }
  function bannedInMonth(b) {
    return (LC.isBanned(b) || LC.isArchived(b)) && bannedMonth(b) === bkdMonth;
  }
  function renderMonthBar() {
    const bar = document.getElementById("ch-month-bar");
    if (!bar) return;
    bar.hidden = bkdTab !== "banned";
    if (bar.hidden) return;
    const sel = document.getElementById("ch-month-select");
    if (sel) {
      // 每个月都能选：固定列最近 12 个月，有更早的封禁记录就一直列到那个月；每月后面带当月
      // 被封的户数，没有封禁的月份也照列（显示 0），一眼看出哪几个月封得多。
      const now = currentMonth();
      const perMonth = {};
      bankRows.forEach((b) => {
        const m = (LC.isBanned(b) || LC.isArchived(b)) ? bannedMonth(b) : "";
        if (m) perMonth[m] = (perMonth[m] || 0) + 1;
      });
      const list = monthsBack(now, 12);
      const oldest = Object.keys(perMonth).sort()[0];
      while (oldest && list[list.length - 1] > oldest) list.push(prevMonth(list[list.length - 1]));
      sel.innerHTML = list.map((m) => `<option value="${esc(m)}" translate="no">${esc(m)} (${perMonth[m] || 0})</option>`).join("")
        + `<option value="${MONTH_ALL}">全部封禁中</option>`;
      sel.value = bkdMonth;
      if (sel.value !== bkdMonth) { bkdMonth = now; sel.value = now; }
    }
    const rows = bkdFiltered("banned");
    const total = rows.reduce((s, b) => s + bankLedgerBalance(b), 0);
    const box = document.getElementById("ch-month-total");
    if (box) {
      // 数字各自独立成节点，文本节点里不混变量（i18n 引擎按整串查字典）。
      box.innerHTML = `<span>${esc(bkdMonth === MONTH_ALL ? tr("封禁中") : tr("当月封禁"))}</span>`
        + `<strong translate="no">${rows.length}</strong>`
        + `<span>${esc(tr("户 · 合计卡住"))}</span>`
        + `<strong class="ch-month-amount${Math.round(total * 100) ? " is-stuck" : ""}" translate="no">${esc(fmt(total))}</strong>`;
    }
  }

  function renderChannels() {
    // 拖拽进行中不重画：否则手里那一行会被换掉，drop 落不到任何地方。
    if (draggedBankId != null) return;
    renderChannelSummary();
    renderBkdCleanupBar();
    renderBkdTabs();
    renderMonthBar();
    renderBkdPanel();
  }

  function goToLedger(bankId) {
    location.href = `/bank-ledger.html?bank=${encodeURIComponent(bankId)}`;
  }

  function reloadAll() {
    return Promise.all([loadStatusOptions(), loadCStatus()])
      .then(() => Promise.all([loadBanks(), loadDailyReport()]));
  }

  function refreshChannels() {
    if (document.hidden || refreshInFlight || draggedBankId != null) return Promise.resolve();
    if (document.querySelector(".modal-overlay.show")) return Promise.resolve();
    refreshInFlight = true;
    return Promise.all([loadBanks({ background: true }), loadDailyReport({ background: true })])
      .catch(() => {})
      .finally(() => { refreshInFlight = false; });
  }

  document.addEventListener("DOMContentLoaded", () => {
    setupAC("f-bankbranch", "ac-bankbranch", "bank_branch");
    const bankDirectory = document.getElementById("bkd-panel");
    reloadAll();
    if (typeof bindCompanySwitch === "function") {
      bindCompanySwitch(() => {
        bkdDetailCache.clear();
        detailGen += 1;
        detailQueue = [];
        return reloadAll();
      });
    }
    window.addEventListener("language-changed", renderChannels);
    setInterval(refreshChannels, 5000);
    window.addEventListener("focus", refreshChannels);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshChannels();
    });
    // 手机：转出 / 别家公司的 C STATUS 输入框点开底部抽屉选（cstatus-sheet.js）。
    window.bindCstatusSheet?.(cStatusNames);

    // 点渠道行（按钮、复选框、展开的详情之外）→ 去当日流水，并筛到这个渠道。
    bankDirectory?.addEventListener("click", (e) => {
      const copyBankBtn = e.target.closest("[data-copy-bank-id]");
      if (copyBankBtn) {
        e.stopPropagation();
        copyBankDirectoryInfo(copyBankBtn.dataset.copyBankId);
        return;
      }
      if (e.target.closest("button, a, input, label, .bkd-item-body")) return;
      const row = e.target.closest(".bk-bank-row[data-id]");
      if (row) goToLedger(row.dataset.id);
    });
    bankDirectory?.addEventListener("keydown", (e) => {
      const row = e.target.closest(".bk-bank-row");
      if (!row || e.target !== row) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      goToLedger(row.dataset.id);
    });

    bankDirectory?.addEventListener("dragstart", (e) => {
      const row = e.target.closest(".bk-bank-row");
      if (!row || bankReorderBusy) return;
      draggedBankId = Number(row.dataset.id);
      row.classList.add("is-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(draggedBankId));
      }
    });
    bankDirectory?.addEventListener("dragover", (e) => {
      const row = e.target.closest(".bk-bank-row");
      if (!row || draggedBankId == null || Number(row.dataset.id) === draggedBankId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      bankDirectory.querySelectorAll(".bk-bank-row.is-drag-over").forEach((el) => el.classList.remove("is-drag-over"));
      row.classList.add("is-drag-over");
    });
    bankDirectory?.addEventListener("drop", (e) => {
      const row = e.target.closest(".bk-bank-row");
      if (!row || draggedBankId == null) return;
      e.preventDefault();
      const targetIndex = usableBanks().findIndex((b) => b.id === Number(row.dataset.id));
      moveBankDirectoryRow(draggedBankId, targetIndex);
      draggedBankId = null;
      bankDirectory.querySelectorAll(".bk-bank-row.is-drag-over, .bk-bank-row.is-dragging").forEach((el) => el.classList.remove("is-drag-over", "is-dragging"));
    });
    bankDirectory?.addEventListener("dragend", () => {
      draggedBankId = null;
      bankDirectory.querySelectorAll(".bk-bank-row.is-drag-over, .bk-bank-row.is-dragging").forEach((el) => el.classList.remove("is-drag-over", "is-dragging"));
    });

    document.getElementById("add-bank-btn")?.addEventListener("click", () => openBankModal(null));
    document.getElementById("bank-cancel-btn")?.addEventListener("click", closeBankModal);
    document.getElementById("bank-save-btn")?.addEventListener("click", saveBankModal);

    // 页签、下载申诉记录、编辑、封禁 / 解封 / 归档，整页一个委托（行会被后台刷新整块重画）。
    document.getElementById("bank-channels-page")?.addEventListener("click", async (e) => {
      const tabBtn = e.target.closest(".bkd-tab");
      if (tabBtn) {
        switchBkdTab(tabBtn.dataset.tab);
        return;
      }
      const download = e.target.closest(".bkd-download-btn[data-id]");
      if (download) {
        const bank = bankRows.find((b) => String(b.id) === download.dataset.id);
        if (bank) downloadBkdCsv(bank);
        return;
      }
      const edit = e.target.closest(".bkd-edit-btn");
      if (edit) {
        const row = bankRows.find((b) => String(b.id) === edit.dataset.id);
        if (row) openBankModal(row);
        return;
      }
      const ban = e.target.closest(".bkd-ban-btn");
      if (ban) {
        const note = await showPromptDialog({
          title: "\u5c01\u7981\u652f\u4ed8\u6e20\u9053",
          message: "\u5c01\u7981\u540e\u8be5\u6e20\u9053\u5c06\u4e0d\u518d\u53c2\u4e0e\u5f53\u524d\u8fd0\u8425\uff0c\u5e76\u8fdb\u5165\u300c\u5c01\u7981\u4e2d\u300d\u5f85\u6e05\u7406\u961f\u5217\u3002",
          target: bankTargetFor(ban.dataset.id),
          label: "\u5c01\u7981\u539f\u56e0\uff08\u53ef\u7559\u7a7a\uff09",
          maxLength: 500,
          confirmLabel: "\u786e\u8ba4\u5c01\u7981",
        });
        if (note == null) return;
        bkdMutate(
          api(`/api/banks/${ban.dataset.id}`, {
            method: "PUT",
            body: JSON.stringify({ ban: true, ban_note: note }),
          })
        );
        return;
      }
      const drain = e.target.closest(".bkd-drain-btn");
      if (drain) {
        openDrainModal(drain.dataset.id);
        return;
      }
      const unban = e.target.closest(".bkd-unban-btn");
      if (unban) {
        // 解封以前一点就生效：户口立刻回到审批和调钱的下拉里（员工演练里解封期间又被选中）。
        const ok = await showConfirmDialog({
          title: "解封支付渠道",
          message: "解封后该渠道回到运营中，会重新出现在审批和调钱的银行下拉里。",
          target: bankTargetFor(unban.dataset.id),
          confirmLabel: "确认解封",
          tone: "warning",
        });
        if (!ok) return;
        bkdMutate(
          api(`/api/banks/${unban.dataset.id}`, { method: "PUT", body: JSON.stringify({ unban: true }) })
        );
        return;
      }
      const archive = e.target.closest(".bkd-archive-btn");
      if (archive) {
        const note = await showPromptDialog({
          title: "\u5f52\u6863\u652f\u4ed8\u6e20\u9053",
          message: "\u5f52\u6863\u540e\u8be5\u6e20\u9053\u4e0d\u518d\u51fa\u73b0\u5728\u4efb\u4f55\u5217\u8868\u3001\u4e0b\u62c9\u4e0e Telegram \u63a8\u9001\u4e2d\uff0c\u5386\u53f2\u6d41\u6c34\u5168\u90e8\u4fdd\u7559\u3002\u968f\u65f6\u53ef\u5728\u300c\u5df2\u5f52\u6863\u300d\u9875\u7b7e\u53d6\u6d88\u5f52\u6863\u3002",
          target: bankTargetFor(archive.dataset.id),
          label: "\u5f52\u6863\u539f\u56e0\uff08\u53ef\u7559\u7a7a\uff09",
          maxLength: 500,
          confirmLabel: "\u786e\u8ba4\u5f52\u6863",
        });
        if (note == null) return;
        bkdMutate(
          api(`/api/banks/${archive.dataset.id}`, {
            method: "PUT",
            body: JSON.stringify({ archive: true, archive_note: note }),
          }).then(() => {
            // \u5f52\u6863\u6210\u529f\u540e\u90a3\u4e00\u884c\u79bb\u5f00\u5f53\u524d\u9875\u7b7e\uff0c\u4e0d\u8bf4\u4e00\u58f0\u4eba\u4f1a\u4ee5\u4e3a\u6e20\u9053\u88ab\u5220\u4e86\u3002
            showToast(tr("\u5df2\u5f52\u6863\uff0c\u53ef\u5728\u300c\u5df2\u5f52\u6863\u300d\u9875\u7b7e\u67e5\u770b"), { tone: "success" });
          })
        );
        return;
      }
      const unarchive = e.target.closest(".bkd-unarchive-btn");
      if (unarchive) {
        bkdMutate(
          api(`/api/banks/${unarchive.dataset.id}`, {
            method: "PUT",
            body: JSON.stringify({ unarchive: true }),
          }).then(() => {
            // \u53d6\u6d88\u5f52\u6863\u56de\u843d\u5230\u300c\u5c01\u7981\u4e2d\u300d\u800c\u4e0d\u662f\u76f4\u63a5\u590d\u6d3b\uff0c\u8981\u518d\u663e\u5f0f\u89e3\u5c01\u4e00\u6b21\u624d\u56de\u8fd0\u8425\u3002
            showToast(tr("\u5df2\u53d6\u6d88\u5f52\u6863\uff0c\u73b0\u5728\u5728\u300c\u5c01\u7981\u4e2d\u300d\u9875\u7b7e"), { tone: "success" });
          })
        );
        return;
      }
    });

    // \u641c\u7d22\u6846\u5728\u9762\u677f\u5916\u9762\uff0c\u6240\u4ee5\u4e0d\u4f1a\u88ab\u91cd\u6e32\u67d3\u51b2\u6389\u7126\u70b9\u3002\u4e0d\u52a0 debounce\uff1a\u8fc7\u6ee4\u7684\u662f\u5341\u51e0\u884c\u7684
    // \u6570\u7ec4\uff0c\u6e32\u67d3\u884c\u6570\u53c8\u88ab\u5206\u9875\u9489\u6b7b\u5728 20 \u4ee5\u5185\u3002
    document.getElementById("bkd-search")?.addEventListener("input", (e) => {
      bkdQuery = e.target.value || "";
      bkdPage[bkdTab] = 1;
      renderMonthBar();
      renderBkdPanel();
    });
    document.getElementById("ch-month-select")?.addEventListener("change", (e) => {
      bkdMonth = e.target.value || currentMonth();
      bkdPage.banned = 1;
      renderMonthBar();
      renderBkdPanel();
    });

    document.getElementById("drain-mode")?.addEventListener("change", syncDrainMode);
    document.getElementById("drain-cancel")?.addEventListener("click", () => {
      document.getElementById("drain-modal").classList.remove("show");
    });
    document.getElementById("drain-submit")?.addEventListener("click", submitDrain);

  });
})();
