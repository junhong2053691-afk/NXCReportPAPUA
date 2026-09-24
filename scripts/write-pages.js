const fs = require("fs");
const path = require("path");

const publicDir = path.join(__dirname, "..", "public");

const sidebar = (active) => `
    <aside class="sidebar" style="display:flex;flex-direction:column">
      <h2>操盘手后台</h2>
      <nav>
        <a href="/" data-page="home" class="${active === "home" ? "active" : ""}">首页</a>
        <a href="/deposits.html" data-page="deposits" class="${active === "deposits" ? "active" : ""}">充值单</a>
        <a href="/withdrawals.html" data-page="withdrawals" class="${active === "withdrawals" ? "active" : ""}">提现单</a>
        <a href="/customers.html" data-page="customers" class="${active === "customers" ? "active" : ""}">顾客列表</a>
        <a href="/admin-users.html" data-page="admin" id="nav-admin" style="display:none" class="${active === "admin" ? "active" : ""}">账号管理</a>
      </nav>
      <div class="user-info">
        <div id="current-user">-</div>
        <span class="logout-btn" id="logout-btn">退出登录</span>
      </div>
    </aside>`;

const shell = (title, active, body, script) => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - 操盘手后台</title>
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
  <div class="layout">
    ${sidebar(active)}
    <main class="main">${body}</main>
  </div>
  <script src="/js/app.js"></script>
  <script>${script}</script>
</body>
</html>`;

const pages = {
  "login.html": `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登录 - 操盘手后台</title>
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
  <div class="login-page">
    <div class="login-box">
      <h1>操盘手后台</h1>
      <p>请输入管理员分配的账号和密码</p>
      <form id="login-form">
        <div class="form-group">
          <label>账号 ID</label>
          <input type="text" id="username" placeholder="自定义账号，如 joshua-ops" required>
        </div>
        <div class="form-group">
          <label>密码</label>
          <input type="password" id="password" placeholder="自定义密码" required>
        </div>
        <button type="submit" class="btn btn-primary">登 录</button>
        <div id="error" class="error-msg" style="display:none"></div>
      </form>
    </div>
  </div>
  <script>
    document.getElementById("login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = document.getElementById("error");
      errEl.style.display = "none";
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: document.getElementById("username").value.trim(),
            password: document.getElementById("password").value,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "登录失败");
        window.location.href = "/";
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = "block";
      }
    });
  </script>
</body>
</html>`,

  "index.html": shell("首页", "home", `
      <div class="page-header"><h1>今日概览</h1><span id="report-date" style="color:#666;font-size:14px"></span></div>
      <div class="cards">
        <div class="card green"><div class="label">今日充值</div><div class="value" id="dep-count">-</div><div class="sub" id="dep-total"></div></div>
        <div class="card red"><div class="label">今日提现</div><div class="value" id="wd-count">-</div><div class="sub" id="wd-total"></div></div>
        <div class="card blue"><div class="label">总顾客</div><div class="value" id="cust-total">-</div><div class="sub" id="cust-new"></div></div>
      </div>
      <p style="color:#888;font-size:14px">接入盘方 API 同步后显示实时数据。</p>`,
    `setActiveNav("home");
    api("/api/data/dashboard").then((d) => {
      document.getElementById("report-date").textContent = "报表日: " + d.date;
      document.getElementById("dep-count").textContent = d.deposits.count + " 笔";
      document.getElementById("dep-total").textContent = "合计 " + fmtMoney(d.deposits.total);
      document.getElementById("wd-count").textContent = d.withdrawals.count + " 笔";
      document.getElementById("wd-total").textContent = "合计 " + fmtMoney(d.withdrawals.total);
      document.getElementById("cust-total").textContent = d.customers.total;
      document.getElementById("cust-new").textContent = "今日新注册 " + d.customers.newToday;
    }).catch(() => {});`),

  "deposits.html": shell("充值单", "deposits", `
      <div class="page-header"><h1>充值单</h1></div>
      <div class="filters">
        <div class="form-group"><label>搜索</label><input id="q" placeholder="ID / 手机 / 姓名"></div>
        <div class="form-group"><label>日期</label><input type="date" id="date"></div>
        <div class="form-group"><label>状态</label><select id="status"><option value="">全部</option><option value="COMPLETED">COMPLETED</option><option value="PENDING">PENDING</option></select></div>
        <button class="btn btn-primary btn-sm" onclick="loadData()">搜索</button>
      </div>
      <div class="table-wrap"><table><thead><tr><th>时间</th><th>姓名</th><th>手机</th><th>金额</th><th>银行</th><th>状态</th><th>交易号</th></tr></thead><tbody id="rows"></tbody></table></div>`,
    `setActiveNav("deposits");
    document.getElementById("date").value = todaySydney();
    async function loadData() {
      const q = document.getElementById("q").value;
      const date = document.getElementById("date").value;
      const status = document.getElementById("status").value;
      const params = new URLSearchParams({ q, date, status });
      const { rows, total } = await api("/api/data/deposits?" + params);
      const tbody = document.getElementById("rows");
      if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无数据，请先同步盘方 API</td></tr>'; return; }
      tbody.innerHTML = rows.map(r => '<tr><td>'+fmtDate(r.created_at)+'</td><td>'+(r.name||"-")+'</td><td>'+(r.mobile||"-")+'</td><td>'+fmtMoney(r.amount)+'</td><td>'+(r.bank_name||"-")+'</td><td><span class="badge badge-green">'+(r.status||"-")+'</span></td><td>'+r.id+'</td></tr>').join("");
    }
    loadData();`),

  "withdrawals.html": shell("提现单", "withdrawals", `
      <div class="page-header"><h1>提现单</h1></div>
      <div class="filters">
        <div class="form-group"><label>搜索</label><input id="q" placeholder="ID / 手机 / 姓名"></div>
        <div class="form-group"><label>日期</label><input type="date" id="date"></div>
        <div class="form-group"><label>状态</label><select id="status"><option value="">全部</option><option value="COMPLETED">COMPLETED</option></select></div>
        <button class="btn btn-primary btn-sm" onclick="loadData()">搜索</button>
      </div>
      <div class="table-wrap"><table><thead><tr><th>时间</th><th>姓名</th><th>手机</th><th>金额</th><th>银行</th><th>PayID</th><th>状态</th></tr></thead><tbody id="rows"></tbody></table></div>`,
    `setActiveNav("withdrawals");
    document.getElementById("date").value = todaySydney();
    async function loadData() {
      const params = new URLSearchParams({
        q: document.getElementById("q").value,
        date: document.getElementById("date").value,
        status: document.getElementById("status").value,
      });
      const { rows } = await api("/api/data/withdrawals?" + params);
      const tbody = document.getElementById("rows");
      if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无数据</td></tr>'; return; }
      tbody.innerHTML = rows.map(r => '<tr><td>'+fmtDate(r.created_at)+'</td><td>'+(r.name||"-")+'</td><td>'+(r.mobile||"-")+'</td><td>'+fmtMoney(r.amount)+'</td><td>'+(r.bank_name||"-")+'</td><td>'+(r.payid||"-")+'</td><td><span class="badge badge-red">'+(r.status||"-")+'</span></td></tr>').join("");
    }
    loadData();`),

  "customers.html": shell("顾客列表", "customers", `
      <div class="page-header"><h1>顾客列表</h1></div>
      <div class="filters">
        <div class="form-group"><label>搜索</label><input id="q" placeholder="手机 / 姓名 / 用户名"></div>
        <button class="btn btn-primary btn-sm" onclick="loadData()">搜索</button>
      </div>
      <div class="table-wrap"><table><thead><tr><th>注册日</th><th>姓名</th><th>手机</th><th>充值次数</th><th>充值总额</th><th>提现总额</th><th>最后充值</th><th>最后登录</th></tr></thead><tbody id="rows"></tbody></table></div>`,
    `setActiveNav("customers");
    async function loadData() {
      const { rows } = await api("/api/data/customers?q=" + encodeURIComponent(document.getElementById("q").value));
      const tbody = document.getElementById("rows");
      if (!rows.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty">暂无数据</td></tr>'; return; }
      tbody.innerHTML = rows.map(r => '<tr><td>'+fmtDate(r.register_date)+'</td><td>'+(r.name||"-")+'</td><td>'+(r.mobile||"-")+'</td><td>'+(r.dep_count||0)+'</td><td>'+fmtMoney(r.dep_total)+'</td><td>'+fmtMoney(r.wd_total)+'</td><td>'+fmtDate(r.last_deposit)+'</td><td>'+fmtDate(r.last_login)+'</td></tr>').join("");
    }
    loadData();`),

  "admin-users.html": shell("账号管理", "admin", `
      <div class="page-header">
        <h1>账号管理</h1>
        <button class="btn btn-success btn-sm" onclick="showCreate()">+ 新建账号</button>
      </div>
      <p style="color:#666;margin-bottom:16px;font-size:14px">创建自定义账号和密码，发给操盘手登录。账号支持字母、数字、._-</p>
      <div class="table-wrap"><table><thead><tr><th>账号 ID</th><th>名称</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody id="rows"></tbody></table></div>
      <div class="modal-overlay" id="create-modal">
        <div class="modal">
          <h2>新建操盘手账号</h2>
          <div class="form-group"><label>账号 ID（登录用）</label><input id="new-username" placeholder="如 joshua-ops"></div>
          <div class="form-group"><label>显示名称</label><input id="new-name" placeholder="如 小王"></div>
          <div class="form-group"><label>密码</label><input id="new-password" type="password" placeholder="至少 4 位"></div>
          <div class="actions">
            <button class="btn btn-outline btn-sm" onclick="hideCreate()">取消</button>
            <button class="btn btn-success btn-sm" onclick="createUser()">创建</button>
          </div>
        </div>
      </div>
      <div class="modal-overlay" id="share-modal">
        <div class="modal">
          <h2>发给操盘手</h2>
          <p>复制以下内容发送给对方：</p>
          <div class="copy-box" id="share-text"></div>
          <div class="actions">
            <button class="btn btn-primary btn-sm" onclick="copyShare()">复制</button>
            <button class="btn btn-outline btn-sm" onclick="document.getElementById('share-modal').classList.remove('show')">关闭</button>
          </div>
        </div>
      </div>`,
    `setActiveNav("admin");
    let shareContent = "";
    function showCreate() { document.getElementById("create-modal").classList.add("show"); }
    function hideCreate() { document.getElementById("create-modal").classList.remove("show"); }
    async function loadUsers() {
      const { users } = await api("/api/admin/users");
      const tbody = document.getElementById("rows");
      tbody.innerHTML = users.map(u => {
        const ops = u.role === "admin" ? "-" :
          '<button class="btn btn-outline btn-sm" onclick="resetPwd('+u.id+',\\''+u.username+'\\')">改密</button> ' +
          (u.status === "active"
            ? '<button class="btn btn-danger btn-sm" onclick="toggleStatus('+u.id+',\\'disabled\\')">停用</button>'
            : '<button class="btn btn-success btn-sm" onclick="toggleStatus('+u.id+',\\'active\\')">启用</button>');
        return '<tr><td><b>'+u.username+'</b></td><td>'+u.name+'</td><td>'+u.role+'</td><td><span class="badge '+(u.status==="active"?"badge-green":"badge-gray")+'">'+u.status+'</span></td><td>'+fmtDate(u.created_at)+'</td><td>'+ops+'</td></tr>';
      }).join("");
    }
    async function createUser() {
      const username = document.getElementById("new-username").value.trim();
      const name = document.getElementById("new-name").value.trim();
      const password = document.getElementById("new-password").value;
      const { user } = await api("/api/admin/users", { method: "POST", body: JSON.stringify({ username, name, password }) });
      hideCreate();
      shareContent = "后台地址: " + location.origin + "\\n账号 ID: " + user.username + "\\n密码: " + password + "\\n名称: " + user.name;
      document.getElementById("share-text").textContent = shareContent;
      document.getElementById("share-modal").classList.add("show");
      loadUsers();
    }
    function copyShare() { navigator.clipboard.writeText(shareContent); alert("已复制"); }
    async function resetPwd(id, username) {
      const password = prompt("为 " + username + " 设置新密码（至少4位）:");
      if (!password) return;
      await api("/api/admin/users/" + id, { method: "PUT", body: JSON.stringify({ password }) });
      shareContent = "后台地址: " + location.origin + "\\n账号 ID: " + username + "\\n新密码: " + password;
      document.getElementById("share-text").textContent = shareContent;
      document.getElementById("share-modal").classList.add("show");
      loadUsers();
    }
    async function toggleStatus(id, status) {
      await api("/api/admin/users/" + id, { method: "PUT", body: JSON.stringify({ status }) });
      loadUsers();
    }
    loadUser().then(u => { if (u.role !== "admin") location.href = "/"; else loadUsers(); });`),
};

for (const [file, content] of Object.entries(pages)) {
  fs.writeFileSync(path.join(publicDir, file), content, "utf8");
  console.log("wrote", file);
}
