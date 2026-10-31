(async function () {
  "use strict";

  const user = await loadUser();
  if (!user || user.role !== "admin") {
    window.location.href = "/";
    return;
  }
  setActiveNav("telegram-settings");
  setupLogout();

  const STATE_LABELS = {
    pending: ["待发送", "等待发出；关掉总开关期间的报警会留在这里"],
    sent: ["已发送", "成功投递"],
    failed: ["发送失败", "重试耗尽，需要检查 token 或 chat"],
    skipped: ["已跳过", "该公司没有配收件 chat"],
    expired: ["已过期", "积压超过 24 小时，不再补发"],
  };

  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  }

  function setMessage(message, tone) {
    const el = $("tg-err");
    if (!el) return;
    el.classList.remove("success", "error");
    if (tone) el.classList.add(tone);
    el.textContent = message || "";
  }

  // api() 在 401 时会自己跳登录页并抛 { cancelled: true }，那种情况不该再弹错误提示。
  function reportError(error, fallback) {
    if (error && (error.cancelled || error.unauthorized)) return;
    const message = (error && error.message) || fallback;
    setMessage(message, "error");
    showToast(message, { tone: "error" });
  }

  function fillForm(s) {
    $("tg-enabled").checked = Boolean(s.enabled);
    $("tg-mirror").checked = Boolean(s.mirror_alerts_to_control);
    // token 永不回填明文，只把脱敏值放进 placeholder。
    $("tg-token").value = "";
    $("tg-token").placeholder = s.control_bot_token_set
      ? "已保存 " + s.control_bot_token_masked + "，留空则保持不变"
      : "向 @BotFather 申请";
    $("tg-chats").value = s.control_chat_ids || "";
    $("tg-poll").value = s.poll_timeout_seconds;
    $("tg-flush").value = s.outbox_flush_seconds;
    $("tg-reconcile").value = s.reconcile_seconds;

    const updated = $("tg-updated");
    if (!s.control_bot_token_set) {
      updated.textContent = "总控 Bot 尚未配置。未配置不影响各公司 Bot，它们照常推送。";
    } else if (s.updated_at) {
      updated.textContent = "上次修改：" + s.updated_at + (s.updated_by ? "（" + s.updated_by + "）" : "");
    } else {
      updated.textContent = "";
    }
  }

  function formPayload() {
    return {
      enabled: $("tg-enabled").checked,
      mirror_alerts_to_control: $("tg-mirror").checked,
      control_bot_token: $("tg-token").value.trim(),
      control_chat_ids: $("tg-chats").value.trim(),
      poll_timeout_seconds: $("tg-poll").value.trim(),
      outbox_flush_seconds: $("tg-flush").value.trim(),
      reconcile_seconds: $("tg-reconcile").value.trim(),
    };
  }

  function badChatIds() {
    return $("tg-chats")
      .value.split(/[,;\s]+/)
      .filter(Boolean)
      .filter((v) => !/^-?\d+$/.test(v));
  }

  async function loadSettings() {
    const data = await api("/api/admin/telegram", { bg: true });
    fillForm(data.settings);
  }

  async function loadStatus() {
    const data = await api("/api/admin/telegram/status", { bg: true });
    const tbody = $("tg-status-rows");
    const rows = Object.keys(STATE_LABELS)
      .map((state) => {
        const n = Number(data.counts?.[state] || 0);
        const [label, note] = STATE_LABELS[state];
        const emphasis = (state === "failed" || state === "pending") && n > 0 ? ' class="tg-count-warn"' : "";
        return (
          "<tr><td>" + esc(label) + "</td><td" + emphasis + ">" + n + "</td><td>" + esc(note) + "</td></tr>"
        );
      })
      .join("");
    tbody.innerHTML = rows;

    // Bot 级别的故障（token 无效 / 被踢出群 / 有别的进程抢 getUpdates）不产生 outbox 行，
    // 只看队列的话坏 token 会完全静默，所以这里单独列出来。
    const botLines = (data.bots || []).map((b) => {
      const bits = [b.bot_key + "：" + (b.running ? "运行中" : "未运行")];
      if (b.parked_reason) {
        bits.push("已暂停（" + b.parked_reason + "，约 " + b.retry_in_seconds + " 秒后重试）");
      } else if (!b.running && b.last_error) {
        bits.push("上次错误：" + b.last_error);
      }
      return bits.join(" — ");
    });
    $("tg-bot-health").innerHTML = botLines.length
      ? botLines.map((l) => "<div>" + esc(l) + "</div>").join("")
      : "<div>暂无 Bot 运行记录。</div>";

    const hint = $("tg-last-failure");
    const parts = [];
    if (data.last_sent_at) parts.push("最近一次成功发送：" + data.last_sent_at);
    if (data.last_failure) {
      parts.push(
        "最近一次失败：" +
          data.last_failure.created_at +
          "（" +
          (data.last_failure.bot_key || "?") +
          "）— " +
          data.last_failure.reason
      );
    }
    hint.textContent = parts.join("　|　") || "暂无推送记录。";
  }

  async function reloadAll() {
    // bank-settings.js 的加载函数没有 .catch，401 时整页空白无提示。别照抄那个。
    try {
      await Promise.all([loadSettings(), loadStatus()]);
    } catch (error) {
      reportError(error, "加载失败，请刷新重试");
    }
  }

  async function save() {
    const bad = badChatIds();
    if (bad.length) {
      setMessage("chat id 必须是整数（群为负数）：" + bad.join(", "), "error");
      $("tg-chats").focus();
      return;
    }
    const body = formPayload();
    // 同 Access Token：留空 = 保持不变，不要把已存的 token 清空。
    if (!body.control_bot_token) delete body.control_bot_token;
    try {
      const data = await api("/api/admin/telegram", { method: "PUT", body: JSON.stringify(body) });
      fillForm(data.settings);
      setMessage("已保存，立即生效（无需重启）", "success");
      showToast("Telegram 设置已保存", { tone: "success" });
      loadStatus().catch(() => {});
    } catch (error) {
      reportError(error, "保存失败，请重试");
    }
  }

  async function sendTest() {
    const bad = badChatIds();
    if (bad.length) {
      setMessage("chat id 必须是整数（群为负数）：" + bad.join(", "), "error");
      $("tg-chats").focus();
      return;
    }
    const btn = $("tg-test");
    btn.disabled = true;
    setMessage("正在发送…", null);
    try {
      // 发的是表单里的当前值（token 留空则用已存的），所以保存前就能验证配置对不对。
      const body = {
        control_bot_token: $("tg-token").value.trim(),
        control_chat_ids: $("tg-chats").value.trim(),
      };
      if (!body.control_bot_token) delete body.control_bot_token;
      const data = await api("/api/admin/telegram/test", { method: "POST", body: JSON.stringify(body) });
      setMessage(data.message || "已发送", "success");
      showToast(data.message || "测试消息已发送", { tone: "success" });
    } catch (error) {
      reportError(error, "发送失败");
    } finally {
      btn.disabled = false;
    }
  }

  async function clearToken() {
    const ok = await showConfirmDialog({
      title: "清除总控 Bot Token",
      message: "清除后总控 Bot 会立即停止，/balance 与 /today 不再响应。\n各公司自己的 Bot 不受影响。",
      confirmLabel: "确认清除",
      tone: "danger",
    });
    if (!ok) return;
    try {
      const data = await api("/api/admin/telegram/token", { method: "DELETE" });
      fillForm(data.settings);
      setMessage("已清除总控 Bot Token", "success");
      showToast("已清除总控 Bot Token", { tone: "success" });
    } catch (error) {
      reportError(error, "清除失败，请重试");
    }
  }

  $("tg-save").addEventListener("click", save);
  $("tg-test").addEventListener("click", sendTest);
  $("tg-clear").addEventListener("click", clearToken);
  $("tg-refresh").addEventListener("click", () => {
    loadStatus().catch((error) => reportError(error, "刷新失败"));
  });

  reloadAll();
})();
