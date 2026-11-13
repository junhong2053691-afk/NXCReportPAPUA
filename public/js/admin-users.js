setActiveNav("admin");

let shareText = "";
let companyCatalog = [];
// 当前登录的 admin 是不是「全部公司」admin（/api/auth/me 的 company_scope，服务端每次查库；这里只决定显示）。
// 只有全部公司 admin 能建 admin、能给别的 admin 勾公司范围；受限 admin 只管自己范围内的 operator。
let actorFull = false;
let actorId = null;

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function roleLabel(role) {
  return role === "admin" ? "Admin" : "Operator";
}

function companyLabel(user) {
  if (user.role === "admin" && user.company_scope !== "limited") return '<span class="company-access-all">全部公司</span>';
  if (!user.companies || !user.companies.length) return '<span class="company-access-empty">未分配</span>';
  return user.companies.map((company) => `<span class="company-access-tag">${escapeHtml(company.name)}</span>`).join(" ");
}

function selectedCompanyIds(containerId) {
  return Array.from(document.querySelectorAll(`#${containerId} input[name="company_ids"]:checked`)).map((input) => input.value);
}

function renderCompanyOptions(containerId, selected) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const selectedSet = new Set(selected || []);
  container.innerHTML = companyCatalog.length
    ? companyCatalog.map((company) => {
        const checked = selectedSet.has(company.id);
        return `<label class="company-option${checked ? " selected" : ""}"><input type="checkbox" name="company_ids" value="${escapeHtml(company.id)}"${checked ? " checked" : ""}><span><strong>${escapeHtml(company.name)}</strong><small>${escapeHtml(company.id)}</small></span></label>`;
      }).join("")
    : '<p class="form-hint">暂无可授权公司</p>';
  container.querySelectorAll('input[name="company_ids"]').forEach((input) => {
    input.addEventListener("change", () => input.closest(".company-option")?.classList.toggle("selected", input.checked));
  });
}

function ensureAccountUi() {
  const table = document.querySelector("#rows")?.closest("table");
  if (table) {
    const head = table.querySelector("thead tr");
    if (head && !head.querySelector(".company-column")) {
      const th = document.createElement("th");
      th.className = "company-column";
      th.textContent = "授权公司";
      head.insertBefore(th, head.querySelector("th:last-child"));
    }
  }

  const createModal = document.querySelector("#create-modal .modal");
  if (createModal && !document.getElementById("new-role")) {
    const passwordGroup = document.getElementById("new-password")?.closest(".form-group");
    passwordGroup?.insertAdjacentHTML("afterend", '<div class="form-group"><label for="new-role">角色</label><select id="new-role"><option value="operator">Operator · 支付通道</option><option value="admin">Admin · 后台管理</option></select></div><label class="scope-all-toggle" id="new-scope-all-wrap" hidden><input type="checkbox" id="new-scope-all" checked> <span>全部公司（不限制）</span></label><fieldset class="user-company-picker" id="create-company-picker"><legend id="new-company-legend">Operator 授权公司</legend><div id="new-company-options" class="company-option-grid"></div><small class="form-hint">至少选择一家公司</small></fieldset><p id="create-hint" class="form-error" role="alert" aria-live="polite"></p>');
  }

  if (!document.getElementById("edit-modal")) {
    document.body.insertAdjacentHTML("beforeend", '<div class="modal-overlay" id="edit-modal"><div class="modal"><h2 id="edit-title">编辑 Operator 权限</h2><p class="modal-note"><strong id="edit-username"></strong>：选择允许管理的公司</p><label class="scope-all-toggle" id="edit-scope-all-wrap" hidden><input type="checkbox" id="edit-scope-all"> <span>全部公司（不限制）</span></label><fieldset class="user-company-picker" id="edit-company-picker"><legend>授权公司</legend><div id="edit-company-options" class="company-option-grid"></div><small class="form-hint">至少保留一家公司</small></fieldset><p id="edit-hint" class="form-error" role="alert" aria-live="polite"></p><div class="actions"><button class="btn btn-outline btn-sm" id="edit-cancel-btn">取消</button><button class="btn btn-success btn-sm" id="edit-save-btn">保存</button></div></div></div>');
  }

  const heading = document.querySelector("#create-modal h2");
  if (heading) heading.textContent = "新建账号";
  const description = document.querySelector(".page-description");
  if (description) description.textContent = "创建 Admin 或 Operator 账号；Operator 只能操作被授权公司的支付通道，Admin 可以限定只看哪几家公司";
}

// 新建：operator 一定勾公司；admin 默认「全部公司」，取消勾才选具体公司。
function setCreateCompanyVisibility() {
  const role = document.getElementById("new-role")?.value || "operator";
  const scopeWrap = document.getElementById("new-scope-all-wrap");
  const all = document.getElementById("new-scope-all")?.checked;
  if (scopeWrap) scopeWrap.hidden = role !== "admin";
  const picker = document.getElementById("create-company-picker");
  if (picker) picker.hidden = role === "admin" && all;
  const legend = document.getElementById("new-company-legend");
  if (legend) legend.textContent = role === "admin" ? "Admin 授权公司" : "Operator 授权公司";
}

function setEditCompanyVisibility() {
  const modal = document.getElementById("edit-modal");
  const isAdminTarget = modal?.dataset.role === "admin";
  const all = document.getElementById("edit-scope-all")?.checked;
  document.getElementById("edit-scope-all-wrap").hidden = !isAdminTarget;
  document.getElementById("edit-company-picker").hidden = isAdminTarget && all;
}

async function loadCompanyCatalog() {
  const data = await api("/api/companies");
  companyCatalog = (data.companies || []).map((company) => ({ id: company.id, name: company.name }));
  renderCompanyOptions("new-company-options", []);
}

async function loadUsers() {
  const { users } = await api("/api/admin/users");
  document.getElementById("rows").innerHTML = users
    .map((user) => {
      // admin 行：只有全部公司 admin 能改别的 admin 的公司范围（不能改自己——服务端同样拦）。
      const ops = user.role === "admin"
        ? (actorFull && String(user.id) !== String(actorId) ? `<button class="btn btn-outline btn-sm" data-edit="${user.id}">权限</button>` : "-")
        : `<button class="btn btn-outline btn-sm" data-edit="${user.id}">权限</button><button class="btn btn-outline btn-sm" data-reset="${user.id}" data-name="${escapeHtml(user.username)}">改密</button><button class="btn btn-danger btn-sm" data-toggle="${user.id}" data-status="${user.status === "active" ? "disabled" : "active"}">${user.status === "active" ? "停用" : "启用"}</button>`;
      // 列序必须与表头一致：账号 ID | 名称 | 角色 | 状态 | 授权公司 | 操作。「授权公司」表头是
      // 上面 insertBefore(最后一列) 插进去的，落在「状态」之后；这里原来先输出公司再输出状态，两列对调了。
      return `<tr><td><b>${escapeHtml(user.username)}</b></td><td>${escapeHtml(user.name)}</td><td><span class="role-pill role-${escapeHtml(user.role)}">${roleLabel(user.role)}</span></td><td>${escapeHtml(user.status)}</td><td>${companyLabel(user)}</td><td>${ops}</td></tr>`;
    })
    .join("");

  document.querySelectorAll("[data-reset]").forEach((button) => {
    button.onclick = async () => {
      const password = await showPromptDialog({
        title: "修改密码",
        message: "为 " + button.dataset.name + " 设置新密码",
        label: "新密码",
        inputType: "password",
        autocomplete: "new-password",
        required: true,
        maxLength: 128,
        confirmLabel: "保存密码",
      });
      if (password == null) return;
      try {
        await api("/api/admin/users/" + button.dataset.reset, { method: "PUT", body: JSON.stringify({ password }) });
        showShare("后台: " + location.origin + "\n账号: " + button.dataset.name + "\n密码: " + password);
        await loadUsers();
      } catch (error) {
        showToast(error.message || "修改失败", { tone: "error", title: "修改密码失败" });
      }
    };
  });

  document.querySelectorAll("[data-toggle]").forEach((button) => {
    button.onclick = async () => {
      try {
        await api("/api/admin/users/" + button.dataset.toggle, { method: "PUT", body: JSON.stringify({ status: button.dataset.status }) });
        await loadUsers();
      } catch (error) {
        showToast(error.message || "更新失败", { tone: "error", title: "更新账号失败" });
      }
    };
  });

  document.querySelectorAll("[data-edit]").forEach((button) => {
    button.onclick = () => {
      const user = users.find((item) => String(item.id) === String(button.dataset.edit));
      if (!user) return;
      const modal = document.getElementById("edit-modal");
      document.getElementById("edit-username").textContent = user.username;
      document.getElementById("edit-hint").textContent = "";
      document.getElementById("edit-title").textContent = user.role === "admin" ? "编辑 Admin 公司范围" : "编辑 Operator 权限";
      document.getElementById("edit-scope-all").checked = user.role === "admin" && user.company_scope !== "limited";
      renderCompanyOptions("edit-company-options", user.company_ids || []);
      modal.dataset.userId = user.id;
      modal.dataset.role = user.role;
      setEditCompanyVisibility();
      modal.classList.add("show");
    };
  });
}

function showShare(text) {
  shareText = text;
  document.getElementById("share-text").textContent = text;
  document.getElementById("share-modal").classList.add("show");
}

ensureAccountUi();

document.getElementById("create-btn").onclick = () => {
  document.getElementById("create-hint").textContent = "";
  document.getElementById("new-username").value = "";
  document.getElementById("new-name").value = "";
  document.getElementById("new-password").value = "";
  document.getElementById("new-role").value = "operator";
  document.getElementById("new-scope-all").checked = true;
  renderCompanyOptions("new-company-options", []);
  document.getElementById("create-modal").classList.add("show");
  setCreateCompanyVisibility();
};
document.getElementById("cancel-btn").onclick = () => document.getElementById("create-modal").classList.remove("show");
document.getElementById("close-share").onclick = () => document.getElementById("share-modal").classList.remove("show");
document.getElementById("edit-cancel-btn").onclick = () => document.getElementById("edit-modal").classList.remove("show");
document.getElementById("new-role").onchange = setCreateCompanyVisibility;
document.getElementById("new-scope-all").onchange = setCreateCompanyVisibility;
document.getElementById("edit-scope-all").onchange = setEditCompanyVisibility;
document.getElementById("copy-btn").onclick = async () => {
  try {
    await navigator.clipboard.writeText(shareText);
    showToast("已复制，可以发给账号使用者", { tone: "success" });
  } catch (_) {
    showToast("复制失败", { tone: "error" });
  }
};

document.getElementById("save-btn").onclick = async () => {
  const username = document.getElementById("new-username").value.trim();
  const name = document.getElementById("new-name").value.trim();
  const password = document.getElementById("new-password").value;
  const role = document.getElementById("new-role").value;
  const scope = role === "admin" && !document.getElementById("new-scope-all").checked ? "limited" : "all";
  const needsCompanies = role === "operator" || scope === "limited";
  const companyIds = needsCompanies ? selectedCompanyIds("new-company-options") : [];
  const hint = document.getElementById("create-hint");
  hint.textContent = "";
  if (needsCompanies && !companyIds.length) {
    hint.textContent = "至少选择一家公司";
    return;
  }
  try {
    const payload = { username, name, password, role, company_ids: companyIds };
    if (role === "admin") payload.company_scope = scope;
    const { user } = await api("/api/admin/users", { method: "POST", body: JSON.stringify(payload) });
    document.getElementById("create-modal").classList.remove("show");
    const names = (user.companies || []).map((company) => company.name).join(", ");
    showShare("后台: " + location.origin + "\n账号: " + user.username + "\n密码: " + password + "\n角色: " + roleLabel(user.role) + (names ? "\n公司: " + names : "\n公司: 全部公司"));
    document.getElementById("new-password").value = "";
    await loadUsers();
  } catch (error) {
    hint.textContent = error.message || "创建失败";
  }
};

document.getElementById("edit-save-btn").onclick = async () => {
  const modal = document.getElementById("edit-modal");
  const isAdminTarget = modal.dataset.role === "admin";
  const all = isAdminTarget && document.getElementById("edit-scope-all").checked;
  const companyIds = all ? [] : selectedCompanyIds("edit-company-options");
  const hint = document.getElementById("edit-hint");
  hint.textContent = "";
  if (!all && !companyIds.length) {
    hint.textContent = "至少保留一家公司";
    return;
  }
  const payload = isAdminTarget
    ? (all ? { company_scope: "all" } : { company_scope: "limited", company_ids: companyIds })
    : { company_ids: companyIds };
  try {
    await api("/api/admin/users/" + modal.dataset.userId, { method: "PUT", body: JSON.stringify(payload) });
    modal.classList.remove("show");
    await loadUsers();
  } catch (error) {
    hint.textContent = error.message || "保存失败";
  }
};

loadUser().then(async (user) => {
  if (!user || user.role !== "admin") {
    location.href = "/bank-accounts.html";
    return;
  }
  actorFull = user.company_scope !== "limited";
  actorId = user.id;
  // 受限 admin 不能建 admin：把角色下拉里的 Admin 拿掉（服务端同样 403）。
  if (!actorFull) document.querySelector('#new-role option[value="admin"]')?.remove();
  try {
    await loadCompanyCatalog();
    await loadUsers();
  } catch (error) {
    const hint = document.getElementById("create-hint");
    if (hint) hint.textContent = error.message || "读取账号失败";
  }
});
