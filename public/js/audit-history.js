setActiveNav("audit-history");

const auditState = { page: 1, pages: 1, limit: 50, lastFocus: null };

const ACTION_LABELS = {
  "platform_transaction.synced": "平台交易首次同步",
  "platform_transaction.changed": "平台交易关键变化",
  "ledger.created": "新增流水",
  "ledger.updated": "修改流水",
  "ledger.deleted": "删除流水",
  "ledger.restored": "恢复流水",
  "pending.approved": "审批平台单",
  "pending.skipped": "跳过平台单",
  "pending.restored": "恢复待处理",
  "pending.deleted": "删除已跳过单",
  "pending.expired": "\u5df2\u8df3\u8fc7\u5355\u81ea\u52a8\u8fc7\u671f",
  "transfer.created": "创建调钱",
  "balance.adjusted": "余额校正",
  "bank_account.created": "新增银行账户",
  "bank_account.updated": "修改银行账户",
  "bank_account.banned": "封禁银行账户",
  "bank_account.unbanned": "解封银行账户",
  "bank_account.archived": "归档银行账户",
  "bank_account.unarchived": "取消归档银行账户",
  "bank_account.deleted": "删除银行账户",
};

const SOURCE_LABELS = {
  user: "后台用户",
  system: "系统",
  platform: "平台",
  backfill: "旧记录",
};

const FIELD_LABELS = {
  amount: "金额",
  amount_in: "IN",
  amount_out: "OUT",
  help_amount: "HELP",
  trf_amount: "TRF",
  status: "状态",
  state: "处理状态",
  bank_account_id: "银行账户",
  bank_acc: "BANK ACC",
  entry_time: "流水时间",
  tx_id: "交易号",
  username: "客户账号",
  name: "客户姓名",
  c_status: "C STATUS",
  remark: "备注",
  other_info: "其他信息",
  operator: "平台操作人",
  method: "支付方式",
  approve_mode: "审批方式",
  lifecycle_status: "账户状态",
  account_number: "账号",
  account_name: "账户名",
  bank_branch: "银行/分行",
  active: "使用中",
  note: "备注",
};

function escAudit(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sydneyDateKey(date) {
  // en-CA gives an ISO YYYY-MM-DD key for API params, not a display language.
  // Do NOT route this through dateLocale().
  return date.toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
}

function defaultDates() {
  const now = new Date();
  const from = new Date(now.getTime() - 6 * 86400000);
  document.getElementById("audit-from").value = sydneyDateKey(from);
  document.getElementById("audit-to").value = sydneyDateKey(now);
}

function formatAuditTime(value) {
  if (!value) return "-";
  const normalized = /[zZ]|[+-]\d\d:?\d\d$/.test(value)
    ? value
    : String(value).replace(" ", "T") + "Z";
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatAuditValue(value) {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function actionLabel(action) {
  return ACTION_LABELS[action] || action || "未知动作";
}

function actorLabel(row) {
  const username = String(row.actor_username || "").trim();
  const name = String(row.actor_name || "").trim();
  if (row.actor_type === "system") {
    return name === "Skipped expiry" ? "\u8df3\u8fc7\u5355\u8fc7\u671f\u4efb\u52a1" : (name || "\u7cfb\u7edf");
  }
  if (row.actor_type === "platform") return name || "Platform API";
  if (!username && !name) return "未知操作者";
  return name && name !== username ? `${name} (${username})` : (username || name);
}

function actorOptionLabel(actor) {
  if (actor.username === "SYSTEM") {
    return actor.name === "Skipped expiry" ? "\u8df3\u8fc7\u5355\u8fc7\u671f\u4efb\u52a1 (SYSTEM)" : `${actor.name || "\u7cfb\u7edf"} (SYSTEM)`;
  }
  if (actor.username === "PLATFORM") return `${actor.name || "Platform API"} (PLATFORM)`;
  return actor.name ? `${actor.name} (${actor.username})` : actor.username;
}

function primaryRef(refs) {
  const priorities = ["transaction", "ledger", "bank_account", "pending", "transfer_group"];
  for (const type of priorities) {
    const ref = (refs || []).find((item) => item.type === type);
    if (ref) return ref;
  }
  return (refs || [])[0] || null;
}

function refLabel(ref) {
  if (!ref) return "—";
  const labels = {
    transaction: "交易",
    ledger: "流水",
    bank_account: "银行账户",
    pending: "待处理",
    transfer_group: "调钱组",
  };
  return `${labels[ref.type] || ref.type} · ${ref.id}`;
}

function sourceChip(row) {
  return `<span class="audit-source audit-source-${escAudit(row.source)}">${escAudit(SOURCE_LABELS[row.source] || row.source)}</span>`;
}

function renderEventRows(rows) {
  const tbody = document.getElementById("audit-rows");
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state audit-empty"><i data-lucide="history"></i><strong>没有符合条件的操作记录</strong><span>可扩大日期范围或清除筛选条件。</span></div></td></tr>';
    if (window.lucide) window.lucide.createIcons();
    return;
  }
  tbody.innerHTML = rows.map((row) => {
    const ref = primaryRef(row.refs);
    return `<tr class="audit-row" data-event-id="${Number(row.id)}" tabindex="0" aria-label="查看 ${escAudit(actionLabel(row.action))} 详情">
      <td class="audit-time"><strong>${escAudit(formatAuditTime(row.occurred_at).slice(0, 10))}</strong><span>${escAudit(formatAuditTime(row.occurred_at).slice(12))}</span></td>
      <td><div class="audit-actor"><strong translate="no">${escAudit(actorLabel(row))}</strong><span>${sourceChip(row)}${row.actor_role ? ` ${escAudit(row.actor_role)}` : ""}</span></div></td>
      <td><span class="audit-action audit-action-${escAudit(row.action.split(".")[0])}">${escAudit(actionLabel(row.action))}</span></td>
      <td>${ref ? `<button class="audit-ref-link" type="button" data-ref-type="${escAudit(ref.type)}" data-ref-id="${escAudit(ref.id)}">${escAudit(refLabel(ref))}</button>` : "—"}</td>
      <!-- summary is server-generated text recorded at the time of the action,
           reason is free text the operator typed: an audit trail must keep the
           wording it was written with, so neither is translated. -->
      <td class="audit-summary-cell" translate="no">${escAudit(row.summary || actionLabel(row.action))}</td>
      <td class="audit-reason-cell" translate="no">${row.reason ? escAudit(row.reason) : '<span class="muted">—</span>'}</td>
      <td><button class="icon-btn audit-detail-btn" type="button" data-event-id="${Number(row.id)}" aria-label="查看详情"><i data-lucide="chevron-right"></i></button></td>
    </tr>`;
  }).join("");
  if (window.lucide) window.lucide.createIcons();
}

function renderPager(total) {
  const pager = document.getElementById("audit-pager");
  pager.innerHTML = `<button class="btn btn-outline btn-sm" id="audit-prev" ${auditState.page <= 1 ? "disabled" : ""}>上一页</button><span>第 ${auditState.page} / ${auditState.pages} 页 · ${Number(total || 0).toLocaleString()} 条</span><button class="btn btn-outline btn-sm" id="audit-next" ${auditState.page >= auditState.pages ? "disabled" : ""}>下一页</button>`;
  document.getElementById("audit-prev").onclick = () => {
    if (auditState.page > 1) {
      auditState.page -= 1;
      loadEvents();
    }
  };
  document.getElementById("audit-next").onclick = () => {
    if (auditState.page < auditState.pages) {
      auditState.page += 1;
      loadEvents();
    }
  };
}

function filterParams() {
  const params = new URLSearchParams({
    page: String(auditState.page),
    limit: String(auditState.limit),
  });
  const values = {
    from: document.getElementById("audit-from").value,
    to: document.getElementById("audit-to").value,
    actor: document.getElementById("audit-actor").value,
    action: document.getElementById("audit-action").value,
    source: document.getElementById("audit-source").value,
    q: document.getElementById("audit-q").value.trim(),
  };
  Object.entries(values).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  return params;
}

async function loadEvents() {
  const tbody = document.getElementById("audit-rows");
  tbody.innerHTML = '<tr><td colspan="7" class="sheet-empty">正在读取操作记录...</td></tr>';
  try {
    const data = await api(`/api/audit/events?${filterParams().toString()}`, { bg: true });
    auditState.pages = Number(data.pages || 1);
    document.getElementById("audit-total").textContent = `当前公司共找到 ${Number(data.total || 0).toLocaleString()} 条记录`;
    renderEventRows(data.rows || []);
    renderPager(data.total);
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="7" class="sheet-empty">读取失败：${escAudit(error.message || "请重试")}</td></tr>`;
  }
}

async function loadOptions() {
  const data = await api("/api/audit/options", { bg: true });
  const actorSelect = document.getElementById("audit-actor");
  const actionSelect = document.getElementById("audit-action");
  const actorValue = actorSelect.value;
  const actionValue = actionSelect.value;
  actorSelect.innerHTML = '<option value="">全部操作者</option>' + (data.actors || []).map((actor) =>
    `<option value="${escAudit(actor.username)}">${escAudit(actorOptionLabel(actor))} · ${Number(actor.event_count || 0)}</option>`
  ).join("");
  actionSelect.innerHTML = '<option value="">全部动作</option>' + (data.actions || []).map((action) =>
    `<option value="${escAudit(action.action)}">${escAudit(actionLabel(action.action))} · ${Number(action.event_count || 0)}</option>`
  ).join("");
  actorSelect.value = actorValue;
  actionSelect.value = actionValue;
}

function openDrawer(title, kicker, html, trigger) {
  const layer = document.getElementById("audit-drawer-layer");
  auditState.lastFocus = trigger || document.activeElement;
  document.getElementById("audit-drawer-title").textContent = title;
  document.getElementById("audit-drawer-kicker").textContent = kicker;
  document.getElementById("audit-drawer-body").innerHTML = html;
  layer.hidden = false;
  document.body.classList.add("audit-drawer-open");
  window.requestAnimationFrame(() => document.getElementById("audit-drawer").focus());
  if (window.lucide) window.lucide.createIcons();
}

function closeDrawer() {
  const layer = document.getElementById("audit-drawer-layer");
  if (layer.hidden) return;
  layer.hidden = true;
  document.body.classList.remove("audit-drawer-open");
  const focus = auditState.lastFocus;
  auditState.lastFocus = null;
  if (focus && document.contains(focus)) focus.focus();
}

function diffHtml(before, after) {
  const oldValue = before && typeof before === "object" && !Array.isArray(before) ? before : null;
  const newValue = after && typeof after === "object" && !Array.isArray(after) ? after : null;
  if (!oldValue && !newValue) {
    return `<pre class="audit-json">${escAudit(formatAuditValue(before || after))}</pre>`;
  }
  const keys = [...new Set([...Object.keys(oldValue || {}), ...Object.keys(newValue || {})])];
  if (!keys.length) return '<p class="audit-detail-empty">没有字段快照。</p>';
  return `<div class="audit-diff-table" role="table">${keys.map((key) => `<div class="audit-diff-row" role="row"><div class="audit-diff-field" role="cell">${escAudit(FIELD_LABELS[key] || key)}</div><div class="audit-diff-before" role="cell"><span>修改前</span><pre>${escAudit(formatAuditValue(oldValue?.[key]))}</pre></div><div class="audit-diff-arrow" aria-hidden="true"><i data-lucide="arrow-right"></i></div><div class="audit-diff-after" role="cell"><span>修改后</span><pre>${escAudit(formatAuditValue(newValue?.[key]))}</pre></div></div>`).join("")}</div>`;
}

function refsHtml(refs) {
  if (!refs?.length) return '<span class="muted">无</span>';
  return `<div class="audit-ref-list">${refs.map((ref) => `<button type="button" class="audit-ref-link" data-ref-type="${escAudit(ref.type)}" data-ref-id="${escAudit(ref.id)}">${escAudit(refLabel(ref))}</button>`).join("")}</div>`;
}

async function openEventDetail(id, trigger) {
  openDrawer("读取中...", "操作详情", '<div class="audit-drawer-loading">正在读取事件...</div>', trigger);
  try {
    const data = await api(`/api/audit/events/${encodeURIComponent(id)}`, { bg: true });
    const event = data.event;
    document.getElementById("audit-drawer-title").textContent = actionLabel(event.action);
    document.getElementById("audit-drawer-body").innerHTML = `<div class="audit-detail-meta">
      <div><span>操作时间</span><strong>${escAudit(formatAuditTime(event.occurred_at))}</strong></div>
      <div><span>操作者</span><strong>${escAudit(actorLabel(event))}</strong></div>
      <div><span>来源</span><strong>${escAudit(SOURCE_LABELS[event.source] || event.source)}</strong></div>
      <div><span>动作代码</span><strong class="mono">${escAudit(event.action)}</strong></div>
    </div>
    <section class="audit-detail-section"><h3>摘要</h3><p>${escAudit(event.summary || actionLabel(event.action))}</p></section>
    <section class="audit-detail-section"><h3>操作原因</h3><p>${event.reason ? escAudit(event.reason) : '<span class="muted">未填写</span>'}</p></section>
    <section class="audit-detail-section"><h3>关联对象</h3>${refsHtml(event.refs)}</section>
    <section class="audit-detail-section"><h3>字段变化</h3>${diffHtml(event.before, event.after)}</section>
    ${event.metadata ? `<details class="audit-metadata"><summary>技术信息</summary><pre>${escAudit(JSON.stringify(event.metadata, null, 2))}</pre></details>` : ""}`;
    if (window.lucide) window.lucide.createIcons();
  } catch (error) {
    document.getElementById("audit-drawer-body").innerHTML = `<div class="empty-state"><strong>读取失败</strong><span>${escAudit(error.message || "请重试")}</span></div>`;
  }
}

function ledgerAmount(row) {
  const amount = Number(row.amount_in || 0) || Number(row.amount_out || 0) || Number(row.help_amount || 0) || Number(row.trf_amount || 0);
  return amount.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function eventTimelineHtml(events) {
  if (!events.length) return '<div class="audit-history-note"><i data-lucide="info"></i><span>这笔记录暂无可用操作历史。</span></div>';
  return `<ol class="audit-timeline">${events.map((event) => `<li><span class="audit-timeline-dot audit-dot-${escAudit(event.source)}"></span><div class="audit-timeline-card"><div class="audit-timeline-head"><strong>${escAudit(actionLabel(event.action))}</strong><time>${escAudit(formatAuditTime(event.occurred_at))}</time></div><p>${escAudit(event.summary || "")}</p><div class="audit-timeline-meta"><span>${escAudit(actorLabel(event))}</span>${event.reason ? `<span>原因：${escAudit(event.reason)}</span>` : ""}<button type="button" class="audit-inline-detail" data-event-id="${Number(event.id)}">查看字段</button></div></div></li>`).join("")}</ol>`;
}

function transactionSummaryHtml(data) {
  const tx = data.transaction;
  const pending = data.pending;
  const allLedgers = [...(data.ledgers || []).map((row) => ({ ...row, deleted: false })), ...(data.deleted_ledgers || []).map((row) => ({ ...row, id: row.original_id, deleted: true }))];
  const txCustomerLabel = tx ? tx.name || tx.username || tx.mobile || "-" : "-";
  const txCustomerHtml = tx && typeof customerLink === "function"
    ? customerLink(txCustomerLabel, tx.customer_id, tx.mobile)
    : escAudit(txCustomerLabel);
  const txCard = tx ? `<div class="audit-subject-card"><div class="audit-card-title"><span>平台原单</span><strong class="mono">${escAudit(tx.id)}</strong></div><dl><div><dt>类型</dt><dd>${escAudit(tx.type || "-")}</dd></div><div><dt>金额</dt><dd>${Number(tx.amount || 0).toLocaleString("en-AU", { minimumFractionDigits: 2 })}</dd></div><div><dt>状态</dt><dd>${escAudit(tx.status || "-")}</dd></div><div><dt>客户</dt><dd>${txCustomerHtml}</dd></div><div><dt>平台操作人</dt><dd>${escAudit(tx.operator || "-")}</dd></div><div><dt>创建时间</dt><dd>${escAudit(tx.created_at || "-")}</dd></div></dl></div>` : '<div class="audit-subject-card audit-card-missing"><strong>没有平台原单</strong><span>这可能是一条手工账单流水。</span></div>';
  const pendingCard = pending ? `<div class="audit-subject-card"><div class="audit-card-title"><span>处理状态</span><strong>${escAudit(pending.state || "-")}</strong></div><dl><div><dt>审批方式</dt><dd>${escAudit(pending.approve_mode || "-")}</dd></div><div><dt>审批人</dt><dd>${escAudit(pending.approved_by || pending.decided_by || "-")}</dd></div><div><dt>审批时间</dt><dd>${escAudit(pending.approved_at || pending.decided_at || "-")}</dd></div><div><dt>银行账户</dt><dd>${escAudit(pending.bank_account_id || "-")}</dd></div></dl></div>` : "";
  const ledgerHtml = allLedgers.length ? `<div class="audit-ledger-list">${allLedgers.map((row) => `<button type="button" class="audit-ledger-card" data-ref-type="ledger" data-ref-id="${Number(row.id)}"><span class="audit-ledger-state ${row.deleted ? "is-deleted" : ""}">${row.deleted ? "已删除" : "现存"}</span><strong>流水 #${Number(row.id)}</strong><span>${escAudit(row.status || "-")} · ${escAudit(ledgerAmount(row))}</span><small>${escAudit(row.entry_time || "-")} · ${escAudit(row.bank_acc || "未关联银行")}</small></button>`).join("")}</div>` : '<p class="audit-detail-empty">没有关联账单流水。</p>';
  return `<div class="audit-trace-summary">${data.history_note ? `<div class="audit-history-note"><i data-lucide="info"></i><span>${escAudit(data.history_note)}</span></div>` : ""}<div class="audit-subject-grid">${txCard}${pendingCard}</div><section class="audit-detail-section"><h3>关联账单流水</h3>${ledgerHtml}</section><section class="audit-detail-section"><h3>操作时间线</h3>${eventTimelineHtml(data.events || [])}</section></div>`;
}

async function openTimeline(type, id, trigger) {
  const value = String(id || "").trim();
  if (!value) return;
  const param = type === "ledger" ? "ledger_id" : "transaction_id";
  openDrawer("读取中...", "单笔交易追踪", '<div class="audit-drawer-loading">正在组合平台原单、流水与操作历史...</div>', trigger);
  try {
    const data = await api(`/api/audit/timeline?${param}=${encodeURIComponent(value)}`, { bg: true });
    document.getElementById("audit-drawer-title").textContent = data.transaction_id ? `交易 ${data.transaction_id}` : `流水 #${data.ledger_id}`;
    document.getElementById("audit-drawer-body").innerHTML = transactionSummaryHtml(data);
    if (window.lucide) window.lucide.createIcons();
    const url = new URL(location.href);
    url.searchParams.delete("tx_id");
    url.searchParams.delete("ledger_id");
    url.searchParams.set(type === "ledger" ? "ledger_id" : "tx_id", value);
    history.replaceState(null, "", url);
  } catch (error) {
    document.getElementById("audit-drawer-title").textContent = "未找到记录";
    document.getElementById("audit-drawer-body").innerHTML = `<div class="empty-state"><i data-lucide="search-x"></i><strong>无法完成追踪</strong><span>${escAudit(error.message || "请检查编号")}</span></div>`;
    if (window.lucide) window.lucide.createIcons();
  }
}

document.getElementById("audit-filters").addEventListener("submit", (event) => {
  event.preventDefault();
  auditState.page = 1;
  loadEvents();
});

document.getElementById("audit-reset").addEventListener("click", () => {
  document.getElementById("audit-filters").reset();
  defaultDates();
  auditState.page = 1;
  loadEvents();
});

document.getElementById("audit-refresh").addEventListener("click", () => {
  Promise.all([loadOptions(), loadEvents()]);
});

document.getElementById("trace-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = document.getElementById("trace-query").value.trim();
  const type = document.getElementById("trace-type").value;
  const message = document.getElementById("trace-message");
  if (!query) {
    message.textContent = "请输入交易号或流水 ID。";
    return;
  }
  if (type === "ledger" && !/^\d+$/.test(query)) {
    message.textContent = "流水 ID 必须是数字。";
    return;
  }
  message.textContent = "";
  openTimeline(type, query, event.submitter);
});

document.getElementById("audit-rows").addEventListener("click", (event) => {
  const ref = event.target.closest("[data-ref-type][data-ref-id]");
  if (ref) {
    const type = ref.dataset.refType;
    if (type === "transaction" || type === "ledger") openTimeline(type, ref.dataset.refId, ref);
    return;
  }
  const button = event.target.closest("[data-event-id]");
  const row = event.target.closest("tr[data-event-id]");
  const id = button?.dataset.eventId || row?.dataset.eventId;
  if (id) openEventDetail(id, button || row);
});

document.getElementById("audit-rows").addEventListener("keydown", (event) => {
  const row = event.target.closest("tr[data-event-id]");
  if (row && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openEventDetail(row.dataset.eventId, row);
  }
});

document.getElementById("audit-drawer-body").addEventListener("click", (event) => {
  const detail = event.target.closest("[data-event-id]");
  if (detail) {
    openEventDetail(detail.dataset.eventId, detail);
    return;
  }
  const ref = event.target.closest("[data-ref-type][data-ref-id]");
  if (ref && ["transaction", "ledger"].includes(ref.dataset.refType)) {
    openTimeline(ref.dataset.refType, ref.dataset.refId, ref);
  }
});

document.getElementById("audit-drawer-close").addEventListener("click", closeDrawer);
document.getElementById("audit-drawer-backdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => {
  const layer = document.getElementById("audit-drawer-layer");
  if (layer.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeDrawer();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...document.getElementById("audit-drawer").querySelectorAll('button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((node) => !node.disabled && !node.hidden);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

bindCompanySwitch(async () => {
  closeDrawer();
  auditState.page = 1;
  await Promise.all([loadOptions(), loadEvents()]);
});

defaultDates();
Promise.all([loadOptions(), loadEvents()]).then(() => {
  const params = new URLSearchParams(location.search);
  const txId = params.get("tx_id");
  const ledgerId = params.get("ledger_id");
  if (txId) {
    document.getElementById("trace-query").value = txId;
    document.getElementById("trace-type").value = "transaction";
    openTimeline("transaction", txId, document.getElementById("trace-query"));
  } else if (ledgerId) {
    document.getElementById("trace-query").value = ledgerId;
    document.getElementById("trace-type").value = "ledger";
    openTimeline("ledger", ledgerId, document.getElementById("trace-query"));
  }
});
