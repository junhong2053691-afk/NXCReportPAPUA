function layout(title, active, body, script) {
  const nav = [
    ["home", "/", "首页"],
    ["deposits", "/deposits.html", "充值单"],
    ["withdrawals", "/withdrawals.html", "提现单"],
    ["customers", "/customers.html", "顾客列表"],
    ["admin", "/admin-users.html", "账号管理"],
  ];
  const links = nav
    .map(([key, href, label]) => {
      const cls = key === active ? ' class="active"' : "";
      const hide = key === "admin" ? ' id="nav-admin" style="display:none"' : "";
      return `<a href="${href}" data-page="${key}"${cls}${hide}>${label}</a>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} - 操盘手后台</title>
<link rel="stylesheet" href="/css/style.css">
</head>
<body>
<div class="layout">
<aside class="sidebar" style="display:flex;flex-direction:column">
<h2>操盘手后台</h2>
<nav>${links}</nav>
<div class="user-info"><div id="current-user">-</div><span class="logout-btn" id="logout-btn">退出登录</span></div>
</aside>
<main class="main">${body}</main>
</div>
<script src="/js/app.js"></script>
${script ? `<script src="${script}"></script>` : ""}
</body>
</html>`;
}

const pages = {
  index: layout(
    "首页",
    "home",
    `<div class="page-header"><h1>今日概览</h1><span id="report-date" style="color:#666;font-size:14px"></span></div>
<div class="cards">
<div class="card green"><div class="label">今日充值</div><div class="value" id="dep-count">-</div><div class="sub" id="dep-total"></div></div>
<div class="card red"><div class="label">今日提现</div><div class="value" id="wd-count">-</div><div class="sub" id="wd-total"></div></div>
<div class="card blue"><div class="label">总顾客</div><div class="value" id="cust-total">-</div><div class="sub" id="cust-new"></div></div>
</div>`,
    "/js/dashboard-inline.js"
  ),
  deposits: layout(
    "充值单",
    "deposits",
    `<div class="page-header"><h1>充值单</h1></div>
<div class="filters"><input id="q" placeholder="ID/手机/姓名"><input type="date" id="date"><button class="btn btn-primary btn-sm" id="search-btn">搜索</button></div>
<div class="table-wrap"><table><thead><tr><th>时间</th><th>姓名</th><th>手机</th><th>金额</th><th>状态</th><th>交易号</th></tr></thead><tbody id="rows"></tbody></table></div>`,
    "/js/deposits.js"
  ),
  withdrawals: layout(
    "提现单",
    "withdrawals",
    `<div class="page-header"><h1>提现单</h1></div>
<div class="filters"><input id="q" placeholder="搜索"><input type="date" id="date"><button class="btn btn-primary btn-sm" id="search-btn">搜索</button></div>
<div class="table-wrap"><table><thead><tr><th>时间</th><th>姓名</th><th>手机</th><th>金额</th><th>PayID</th><th>状态</th></tr></thead><tbody id="rows"></tbody></table></div>`,
    "/js/withdrawals.js"
  ),
  customers: layout(
    "顾客列表",
    "customers",
    `<div class="page-header"><h1>顾客列表</h1></div>
<div class="filters"><input id="q" placeholder="手机/姓名"><button class="btn btn-primary btn-sm" id="search-btn">搜索</button></div>
<div class="table-wrap"><table><thead><tr><th>注册日</th><th>姓名</th><th>手机</th><th>充值次数</th><th>充值总额</th><th>最后充值</th><th>最后登录</th></tr></thead><tbody id="rows"></tbody></table></div>`,
    "/js/customers.js"
  ),
  adminUsers: layout(
    "账号管理",
    "admin",
    `<div class="page-header"><h1>账号管理</h1><button class="btn btn-success btn-sm" id="create-btn">+ 新建账号</button></div>
<p style="color:#666;margin-bottom:16px;font-size:14px">自定义账号 ID 和密码，创建后复制发给操盘手</p>
<div class="table-wrap"><table><thead><tr><th>账号 ID</th><th>名称</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody id="rows"></tbody></table></div>
<div class="modal-overlay" id="create-modal"><div class="modal"><h2>新建操盘手账号</h2>
<div class="form-group"><label>账号 ID</label><input id="new-username" placeholder="如 joshua-ops"></div>
<div class="form-group"><label>显示名称</label><input id="new-name" placeholder="如 小王"></div>
<div class="form-group"><label>密码</label><input id="new-password" type="password" placeholder="至少4位"></div>
<div class="actions"><button class="btn btn-outline btn-sm" id="cancel-btn">取消</button><button class="btn btn-success btn-sm" id="save-btn">创建</button></div>
</div></div>
<div class="modal-overlay" id="share-modal"><div class="modal"><h2>发给操盘手</h2><div class="copy-box" id="share-text"></div>
<div class="actions"><button class="btn btn-primary btn-sm" id="copy-btn">复制</button><button class="btn btn-outline btn-sm" id="close-share">关闭</button></div></div></div>`,
    "/js/admin-users.js"
  ),
};

module.exports = { pages, layout };
