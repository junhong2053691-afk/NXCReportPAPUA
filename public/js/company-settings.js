(async function () {
  const user = await loadUser();
  if (!user || user.role !== "admin") {
    window.location.href = "/";
    return;
  }
  setActiveNav("company-settings");
  setupLogout();

  const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
  const wrap = document.getElementById("company-cards");
  const createModal = document.getElementById("create-modal");
  const deleteModal = document.getElementById("delete-modal");
  let deleteTarget = null;

  function esc(s) {
    return String(s || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  function cardPayload(card) {
    const body = {};
    card.querySelectorAll("[data-f]").forEach((el) => {
      const k = el.dataset.f;
      if (el.type === "checkbox") body[k] = el.checked;
      else body[k] = el.value.trim();
    });
    return body;
  }

  function credsComplete(body, co) {
    const tokenOk = body.access_token || co.access_token_set;
    return Boolean(body.api_url && body.access_id && tokenOk);
  }

  function setMessage(element, message, tone) {
    if (!element) return;
    element.classList.remove("success", "error");
    if (tone) element.classList.add(tone);
    element.textContent = message || "";
  }

  async function testCreds(id, body) {
    const r = await api("/api/companies/" + id + "/test", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return r.message || "连接成功";
  }

  async function load() {
    const data = await api("/api/companies");
    wrap.innerHTML = "";
    for (const co of data.companies) {
      const card = document.createElement("div");
      card.className = "card company-card";
      card.dataset.id = co.id;
      card.innerHTML =
        '<div class="form-group"><label>显示名称</label><input data-f="name" value="' +
        esc(co.name) +
        '"></div>' +
        '<p class="company-id-note">公司 ID：<code>' +
        esc(co.id) +
        "</code>（创建后不可改）</p>" +
        '<div class="form-group"><label>API URL</label><input data-f="api_url" value="' +
        esc(co.api_url) +
        '" placeholder="https://.../api/v1/index.php"></div>' +
        '<div class="form-group"><label>Access ID</label><input data-f="access_id" value="' +
        esc(co.access_id) +
        '"></div>' +
        '<div class="form-group"><label>Access Token</label><input data-f="access_token" type="password" placeholder="' +
        (co.access_token_set ? "已保存 " + co.access_token_masked + "，留空则保持不变" : "必填") +
        '"></div>' +
        '<label class="export-check"><input type="checkbox" data-f="enabled" ' +
        (co.enabled ? "checked" : "") +
        "> 启用同步</label>" +
        '<p class="company-hint">' +
        (co.last_sync_at ? "上次同步: " + co.last_sync_at + " — " + (co.last_sync_msg || "") : "尚未同步") +
        "</p>" +
        '<div class="actions company-actions">' +
        '<button class="btn btn-primary btn-sm save-btn">保存</button> ' +
        '<button class="btn btn-outline btn-sm test-btn">测试连接</button> ' +
        '<button class="btn btn-danger btn-sm delete-btn">删除</button>' +
        "</div>";
      card.querySelector(".save-btn").onclick = () => saveCard(co, card);
      card.querySelector(".test-btn").onclick = () => testCard(co, card);
      card.querySelector(".delete-btn").onclick = () => openDelete(co);
      wrap.appendChild(card);
    }
  }

  async function saveCard(co, card) {
    const body = cardPayload(card);
    const hint = card.querySelector(".company-hint");
    if (!body.name) {
      setMessage(hint, "请填写显示名称", "error");
      card.querySelector('[data-f="name"]')?.focus();
      return;
    }
    if (body.enabled && !credsComplete(body, co)) {
      setMessage(hint, "启用同步前请填写完整 API URL、Access ID 和 Token", "error");
      const missing = Array.from(card.querySelectorAll('[data-f="api_url"], [data-f="access_id"], [data-f="access_token"]'))
        .find((input) => !input.value.trim() && !(input.dataset.f === "access_token" && co.access_token_set));
      missing?.focus();
      return;
    }
    if (body.enabled && !co.enabled) {
      const ok = await showConfirmDialog({
        title: "启用定时同步",
        message: "即将启用「" + body.name + "」的定时同步。\n建议先点「测试连接」确认 API 正确。",
        confirmLabel: "保存并启用",
        tone: "warning",
      });
      if (!ok) return;
    }
    if (!body.access_token) delete body.access_token;
    try {
      await api("/api/companies/" + co.id, { method: "PUT", body: JSON.stringify(body) });
      showToast("公司设置已保存", { tone: "success" });
      load();
    } catch (error) {
      setMessage(hint, error.message || "保存失败，请重试", "error");
      showToast(error.message || "保存失败，请重试", { tone: "error" });
    }
  }

  async function testCard(co, card) {
    const body = cardPayload(card);
    if (!body.api_url || !body.access_id) {
      setMessage(card.querySelector(".company-hint"), "请先填写 API URL 和 Access ID", "error");
      card.querySelector(!body.api_url ? '[data-f="api_url"]' : '[data-f="access_id"]')?.focus();
      return;
    }
    if (!body.access_token && !co.access_token_set) {
      setMessage(card.querySelector(".company-hint"), "请先填写 Access Token", "error");
      card.querySelector('[data-f="access_token"]')?.focus();
      return;
    }
    if (!body.access_token) delete body.access_token;
    try {
      const msg = await testCreds(co.id, body);
      const hint = card.querySelector(".company-hint");
      if (hint) {
        hint.classList.remove("error");
        hint.classList.add("success");
        hint.textContent = "测试通过: " + msg;
      }
      showToast(msg, { tone: "success", title: "连接测试通过" });
    } catch (e) {
      const hint = card.querySelector(".company-hint");
      if (hint) {
        hint.classList.remove("success");
        hint.classList.add("error");
        hint.textContent = "测试失败: " + e.message;
      }
      showToast(e.message || "连接测试失败", { tone: "error", title: "连接测试失败" });
    }
  }

  function openDelete(co) {
    deleteTarget = co;
    document.getElementById("delete-name").textContent = co.name + " (" + co.id + ")";
    document.getElementById("delete-confirm-id").value = "";
    deleteModal.classList.add("show");
  }

  document.getElementById("create-btn").onclick = () => {
    ["new-id", "new-name", "new-api-url", "new-access-id", "new-access-token"].forEach((id) => {
      document.getElementById(id).value = "";
    });
    document.getElementById("create-hint").textContent = "";
    createModal.classList.add("show");
  };
  document.getElementById("cancel-btn").onclick = () => createModal.classList.remove("show");
  document.getElementById("create-test-btn").onclick = async () => {
    const body = {
      api_url: document.getElementById("new-api-url").value.trim(),
      access_id: document.getElementById("new-access-id").value.trim(),
      access_token: document.getElementById("new-access-token").value.trim(),
    };
    if (!body.api_url || !body.access_id || !body.access_token) {
      const hint = document.getElementById("create-hint");
      setMessage(hint, "请先填写完整 API 信息再测试", "error");
      const missingId = !body.api_url ? "new-api-url" : !body.access_id ? "new-access-id" : "new-access-token";
      document.getElementById(missingId)?.focus();
      return;
    }
    try {
      const r = await api("/api/companies/test-connection", { method: "POST", body: JSON.stringify(body) });
      const msg = r.message || "连接成功";
      const hint = document.getElementById("create-hint");
      hint.classList.remove("error");
      hint.classList.add("success");
      hint.textContent = "测试通过: " + msg;
    } catch (e) {
      const hint = document.getElementById("create-hint");
      hint.classList.remove("success");
      hint.classList.add("error");
      hint.textContent = "测试失败: " + e.message;
    }
  };
  document.getElementById("create-submit").onclick = async () => {
    const body = {
      id: document.getElementById("new-id").value.trim().toLowerCase(),
      name: document.getElementById("new-name").value.trim(),
      api_url: document.getElementById("new-api-url").value.trim(),
      access_id: document.getElementById("new-access-id").value.trim(),
      access_token: document.getElementById("new-access-token").value.trim(),
    };
    if (!body.id || !ID_RE.test(body.id)) {
      setMessage(document.getElementById("create-hint"), "公司 ID 仅支持小写字母、数字、下划线和连字符（2-32位）", "error");
      document.getElementById("new-id")?.focus();
      return;
    }
    if (!body.name) {
      setMessage(document.getElementById("create-hint"), "请填写显示名称", "error");
      document.getElementById("new-name")?.focus();
      return;
    }
    try {
      await api("/api/companies", { method: "POST", body: JSON.stringify(body) });
      createModal.classList.remove("show");
      showToast("公司已创建。请测试连接无误后再勾选「启用同步」。", { tone: "success", duration: 7000 });
      load();
    } catch (e) {
      setMessage(document.getElementById("create-hint"), e.message || "创建失败", "error");
    }
  };

  document.getElementById("delete-cancel-btn").onclick = () => {
    deleteModal.classList.remove("show");
    deleteTarget = null;
  };
  document.getElementById("delete-submit-btn").onclick = async () => {
    if (!deleteTarget) return;
    const typed = document.getElementById("delete-confirm-id").value.trim().toLowerCase();
    if (typed !== deleteTarget.id) {
      showToast("请输入正确的公司 ID 以确认删除", { tone: "error" });
      document.getElementById("delete-confirm-id")?.focus();
      return;
    }
    const ok = await showConfirmDialog({
      title: "最后确认",
      message: "将永久删除「" + deleteTarget.name + "」及其所有同步数据（客户、交易、统计）。\n\n此操作不可恢复。",
      confirmLabel: "永久删除",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api("/api/companies/" + deleteTarget.id, {
        method: "DELETE",
        body: JSON.stringify({ confirm: typed }),
      });
      deleteModal.classList.remove("show");
      deleteTarget = null;
      showToast("公司及其同步数据已删除", { tone: "success" });
      window.setTimeout(() => window.location.reload(), 650);
    } catch (e) {
      showToast(e.message || "删除失败", { tone: "error", title: "删除失败" });
    }
  };

  load();
})();
