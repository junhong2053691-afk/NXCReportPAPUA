(function () {
  "use strict";

  let statusRows = [];
  let cStatusRows = [];
  let companies = [];

  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function slugStatus(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ");
  }
  function companyOptions(selected) {
    return '<option value="">-</option>' + companies.map((c) => {
      const id = String(c.id || "");
      return `<option value="${esc(id)}"${id === selected ? " selected" : ""}>${esc(c.name || id)}</option>`;
    }).join("");
  }
  function toast(msg, tone) {
    showToast(msg, { tone: tone || "success" });
  }

  function loadStatus() {
    return api("/api/banks/status-options", { bg: true }).then((d) => {
      statusRows = d.options || [];
      renderStatus();
    });
  }
  function loadCStatus() {
    return api("/api/banks/c-status-options", { bg: true }).then((d) => {
      cStatusRows = d.options || [];
      companies = d.companies || [];
      renderCStatus();
    });
  }
  function reloadAll() {
    return Promise.all([loadStatus(), loadCStatus()]);
  }

  function renderStatus() {
    const tbody = document.getElementById("status-rows");
    if (!tbody) return;
    tbody.innerHTML = statusRows.map((r) => `
      <tr data-value="${esc(r.value)}">
        <td class="mono" translate="no">${esc(r.value)}</td>
        <td><input class="setting-input st-label" value="${esc(r.label || "")}"></td>
        <td><input class="setting-color st-color" type="color" value="${esc(r.color || "#64748b")}"></td>
        <td translate="no"><span class="ledger-status" style="--ledger-status-accent:${esc(r.color || "#64748b")}">${esc(r.label || r.value)}</span></td>
        <td>
          <button type="button" class="btn btn-success btn-xs st-save">\u4fdd\u5b58</button>
          <button type="button" class="btn btn-outline btn-xs st-del">\u79fb\u9664</button>
        </td>
      </tr>`).join("") || '<tr><td colspan="5" class="empty-state">\u6682\u65e0 STATUS</td></tr>';
  }

  function renderCStatus() {
    const select = document.getElementById("cs-company");
    if (select) select.innerHTML = companyOptions(select.value || "");
    const tbody = document.getElementById("cstatus-rows");
    if (!tbody) return;
    tbody.innerHTML = cStatusRows.map((r) => `
      <tr data-name="${esc(r.name)}">
        <td translate="no">${esc(r.name)}</td>
        <td translate="no">${esc(companies.find((c) => c.id === r.target_company_id)?.name || r.target_company_id || "-")}</td>
        <td><input type="checkbox" class="cs-reconcile" aria-label="\u9700\u8981\u5bf9\u5e73"${r.target_company_id ? "" : " disabled"}${Number(r.reconcile_required) ? " checked" : ""}></td>
        <td><button type="button" class="btn btn-outline btn-xs cs-del">\u79fb\u9664</button></td>
      </tr>`).join("") || '<tr><td colspan="4" class="empty-state">\u6682\u65e0 C STATUS</td></tr>';
  }

  function bind() {
    document.getElementById("status-add")?.addEventListener("click", () => {
      const title = document.getElementById("status-title")?.value.trim() || "";
      const value = slugStatus(document.getElementById("status-value")?.value || title);
      const color = document.getElementById("status-color")?.value || "#64748b";
      if (!title || !value) return toast("\u8bf7\u586b\u5199 STATUS title");
      api("/api/banks/status-options", {
        method: "POST",
        body: JSON.stringify({ value, label: title, color }),
      }).then(() => {
        document.getElementById("status-title").value = "";
        document.getElementById("status-value").value = "";
        return loadStatus();
      }).then(() => toast("\u5df2\u6dfb\u52a0 STATUS")).catch((e) => toast(e.message || "\u6dfb\u52a0\u5931\u8d25", "error"));
    });

    document.getElementById("status-rows")?.addEventListener("click", async (e) => {
      const tr = e.target.closest("tr[data-value]");
      if (!tr) return;
      const value = tr.dataset.value;
      if (e.target.closest(".st-save")) {
        api(`/api/banks/status-options/${encodeURIComponent(value)}`, {
          method: "PUT",
          body: JSON.stringify({
            label: tr.querySelector(".st-label")?.value.trim() || value,
            color: tr.querySelector(".st-color")?.value || "#64748b",
          }),
        }).then(loadStatus).then(() => toast("\u5df2\u4fdd\u5b58 STATUS")).catch((err) => toast(err.message || "\u4fdd\u5b58\u5931\u8d25", "error"));
      }
      if (e.target.closest(".st-del")) {
        const confirmed = await showConfirmDialog({
          title: "\u79fb\u9664 STATUS",
          message: "\u786e\u5b9a\u79fb\u9664\u300c" + value + "\u300d\uff1f",
          confirmLabel: "\u79fb\u9664",
          tone: "danger",
        });
        if (!confirmed) return;
        api(`/api/banks/status-options/${encodeURIComponent(value)}`, { method: "DELETE" })
          .then(loadStatus).then(() => toast("\u5df2\u79fb\u9664 STATUS")).catch((err) => toast(err.message || "\u79fb\u9664\u5931\u8d25", "error"));
      }
    });

    document.getElementById("cs-add")?.addEventListener("click", () => {
      const name = document.getElementById("cs-name")?.value.trim() || "";
      const target = document.getElementById("cs-company")?.value || "";
      if (!name) return toast("\u8bf7\u586b\u5199 C STATUS");
      api("/api/banks/c-status-options", {
        method: "POST",
        body: JSON.stringify({
          name,
          target_company_id: target,
        }),
      }).then(() => {
        document.getElementById("cs-name").value = "";
        return loadCStatus();
      }).then(() => toast("\u5df2\u6dfb\u52a0 C STATUS")).catch((e) => toast(e.message || "\u6dfb\u52a0\u5931\u8d25", "error"));
    });

    // 只传 name + flag：banks.js 把未传的 target_company_id 当作「保持原值」。
    document.getElementById("cstatus-rows")?.addEventListener("change", (e) => {
      const box = e.target.closest(".cs-reconcile");
      if (!box) return;
      const name = box.closest("tr[data-name]")?.dataset.name;
      if (!name) return;
      api("/api/banks/c-status-options", {
        method: "POST",
        body: JSON.stringify({ name, reconcile_required: box.checked ? 1 : 0 }),
      }).then(loadCStatus).then(() => toast("已保存")).catch((err) => {
        box.checked = !box.checked;
        toast(err.message || "保存失败", "error");
      });
    });

    document.getElementById("cstatus-rows")?.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-name]");
      if (!tr) return;
      if (!e.target.closest(".cs-del")) return;
      api(`/api/banks/c-status-options/${encodeURIComponent(tr.dataset.name)}`, { method: "DELETE" })
        .then(loadCStatus).then(() => toast("\u5df2\u79fb\u9664 C STATUS")).catch((err) => toast(err.message || "\u79fb\u9664\u5931\u8d25", "error"));
    });

    if (typeof bindCompanySwitch === "function") bindCompanySwitch(reloadAll);
  }

  document.addEventListener("DOMContentLoaded", () => {
    bind();
    reloadAll();
  });
})();
