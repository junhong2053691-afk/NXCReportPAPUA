(async function () {
  const user = await loadUser();
  if (!user || user.role !== "admin") {
    window.location.href = "/";
    return;
  }
  setActiveNav("company-settings");
  setupLogout();

  const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
  // 两栏都是 password 框且上下紧挨，Bot Token 粘进 Access Token 是很容易犯的错，
  // 而且后果隐蔽：保存成功、toast 报"已保存"，只有底部同步状态几秒后变成"API 拒绝访问"。
  // 平台 Access Token 是 64 位十六进制，Telegram 是 <bot_id>:<35+ 字符>，按形状拦。
  // server/routes/companies.js 有同一条后端校验兜底。
  const TELEGRAM_TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
  // 浏览器会把保存的后台登录密码自动填进 Access Token 框（截图里的浅蓝底），点保存就把真 token
  // 覆盖掉。输入框已加 autocomplete="new-password" 阻止填充，这里再按形状兜底。
  const ACCESS_TOKEN_RE = /^[0-9a-f]{64}$/i;
  const BAD_ACCESS_TOKEN_MSG = "Access Token 应为 64 位十六进制。可能是浏览器自动填入了登录密码——清空该框（留空即保持原 token 不变）。";
  // 这几个框都不是登录表单，一律不让浏览器自动填充 / 记住。
  const NO_FILL = ' autocomplete="off" data-lpignore="true" data-1p-ignore';
  const NO_FILL_SECRET = ' autocomplete="new-password" data-lpignore="true" data-1p-ignore';
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
        '<div class="form-group"><label>API URL</label><input data-f="api_url"' + NO_FILL + ' value="' +
        esc(co.api_url) +
        '" placeholder="https://.../api/v1/index.php"></div>' +
        '<div class="form-group"><label>Access ID</label><input data-f="access_id"' + NO_FILL + ' value="' +
        esc(co.access_id) +
        '"></div>' +
        '<div class="form-group"><label>Access Token</label><input data-f="access_token" type="password"' + NO_FILL_SECRET + ' placeholder="' +
        (co.access_token_set ? "已保存 " + esc(co.access_token_masked) + "，留空则保持不变" : "必填") +
        '"></div>' +
        '<label class="export-check"><input type="checkbox" data-f="enabled" ' +
        (co.enabled ? "checked" : "") +
        "> 启用同步</label>" +
        '<div class="form-group"><label>Telegram Bot Token</label><input data-f="telegram_bot_token" type="password"' + NO_FILL_SECRET + ' placeholder="' +
        (co.telegram_bot_token_set
          ? "已保存 " + esc(co.telegram_bot_token_masked) + "，留空则保持不变"
          : "向 @BotFather 申请，留空则不启用") +
        '"><small class="form-hint">该公司专属 Bot，用于推送余额报警并响应 /balance、/today。</small></div>' +
        '<div class="form-group"><label>Telegram 收件 chat</label><input data-f="telegram_chat_ids" value="' +
        esc(co.telegram_chat_ids) +
        '" placeholder="例如 -1001234567890,555"><small class="form-hint">多个用逗号分隔。把 Bot 拉进群后发送 /myid 即可获取，群 chat id 是负数。</small></div>' +
        '<p class="company-hint">' +
        (co.last_sync_at ? "上次同步: " + esc(co.last_sync_at) + " — " + esc(co.last_sync_msg || "") : "尚未同步") +
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
    if (body.access_token && TELEGRAM_TOKEN_RE.test(body.access_token)) {
      setMessage(hint, "Access Token 里填的是 Telegram Bot Token（形如 123456:AA...）。平台 Access Token 不含冒号——请检查是不是粘错了输入框。", "error");
      card.querySelector('[data-f="access_token"]')?.focus();
      return;
    }
    if (body.access_token && !ACCESS_TOKEN_RE.test(body.access_token)) {
      setMessage(hint, BAD_ACCESS_TOKEN_MSG, "error");
      card.querySelector('[data-f="access_token"]')?.focus();
      return;
    }
    if (body.telegram_bot_token && !TELEGRAM_TOKEN_RE.test(body.telegram_bot_token)) {
      setMessage(hint, "Telegram Bot Token 格式不对，应形如 123456789:AAxxxxxxxx（向 @BotFather 索取）。", "error");
      card.querySelector('[data-f="telegram_bot_token"]')?.focus();
      return;
    }
    if (!body.access_token) delete body.access_token;
    // 同 access_token：留空表示不改，而不是清空已保存的 token。
    if (!body.telegram_bot_token) delete body.telegram_bot_token;
    const badChat = (body.telegram_chat_ids || "")
      .split(/[,;\s]+/)
      .filter(Boolean)
      .filter((v) => !/^-?\d+$/.test(v));
    if (badChat.length) {
      setMessage(hint, "Telegram chat id 必须是整数（群为负数）：" + badChat.join(", "), "error");
      card.querySelector('[data-f="telegram_chat_ids"]')?.focus();
      return;
    }
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
    if (body.access_token && !ACCESS_TOKEN_RE.test(body.access_token)) {
      setMessage(card.querySelector(".company-hint"), BAD_ACCESS_TOKEN_MSG, "error");
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
    if (body.access_token && TELEGRAM_TOKEN_RE.test(body.access_token)) {
      setMessage(document.getElementById("create-hint"), "Access Token 里填的是 Telegram Bot Token（形如 123456:AA...）。Bot Token 请在公司创建后于卡片里单独填写。", "error");
      document.getElementById("new-access-token")?.focus();
      return;
    }
    if (body.access_token && !ACCESS_TOKEN_RE.test(body.access_token)) {
      setMessage(document.getElementById("create-hint"), "Access Token 应为 64 位十六进制，请检查是否粘贴完整、是否被浏览器自动填入了登录密码。", "error");
      document.getElementById("new-access-token")?.focus();
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
