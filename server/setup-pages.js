const fs = require("fs");
const path = require("path");
const publicDir = path.join(__dirname, "..", "public");

function sidebar(active) {
  return `<aside class="sidebar" style="display:flex;flex-direction:column">
<h2>操盘手后台</h2>
<nav>
<a href="/" data-page="home" class="${active === "home" ? "active" : ""}">首页</a>
<a href="/deposits.html" data-page="deposits" class="${active === "deposits" ? "active" : ""}">充值单</a>
<a href="/withdrawals.html" data-page="withdrawals" class="${active === "withdrawals" ? "active" : ""}">提现单</a>
<a href="/customers.html" data-page="customers" class="${active === "customers" ? "active" : ""}">顾客列表</a>
<a href="/admin-users.html" data-page="admin" id="nav-admin" style="display:none" class="${active === "admin" ? "active" : ""}">账号管理</a>
</nav>
<div class="user-info"><div id="current-user">-</div><span class="logout-btn" id="logout-btn">退出登录</span></div>
</aside>`;
}

function page(title, active, body, extraScript) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} - 操盘手后台</title>
<link rel="stylesheet" href="/css/style.css">
</head>
<body>
<div class="layout">${sidebar(active)}<main class="main">${body}</main></div>
<script src="/js/app.js"></script>
<script>${extraScript}</script>
</body>
</html>`;
}

const files = {
  "index.html": page("首页", "home", `
<div class="page-header"><h1>今日概览</h1><span id="report-date" style="color:#666;font-size:14px"></span></div>
<div class="cards">
<div class="card green"><div class="label">今日充值</div><div class="value" id="dep-count">-</div><div class="sub" id="dep-total"></div></div>
<div class="card red"><div class="label">今日提现</div><div class="value" id="wd-count">-</div><div class="sub" id="wd-total"></div></div>
<div class="card blue"><div class="label">总顾客</div><div class="value" id="cust-total">-</div><div class="sub" id="cust-new"></div></div>
</div>`, `
setActiveNav("home");
api("/api/data/dashboard").then(d=>{
document.getElementById("report-date").textContent="报表日: "+d.date;
document.getElementById("dep-count").textContent=d.deposits.count+" 笔";
document.getElementById("dep-total").textContent="合计 "+fmtMoney(d.deposits.total);
document.getElementById("wd-count").textContent=d.withdrawals.count+" 笔";
document.getElementById("wd-total").textContent="合计 "+fmtMoney(d.withdrawals.total);
document.getElementById("cust-total").textContent=d.customers.total;
document.getElementById("cust-new").textContent="今日新注册 "+d.customers.newToday;
}).catch(()=>{});`),

  "deposits.html": page("充值单", "deposits", `
<div class="page-header"><h1>充值单</h1></div>
<div class="filters">
<div class="form-group"><label>搜索</label><input id="q" placeholder="ID/手机/姓名"></div>
<div class="form-group"><label>日期</label><input type="date" id="date"></div>
<button class="btn btn-primary btn-sm" id="search-btn">搜索</button>
</div>
<div class="table-wrap"><table><thead><tr><th>时间</th><th>姓名</th><th>手机</th><th>金额</th><th>状态</th><th>交易号</th></tr></thead><tbody id="rows"></tbody></table></div>`, `
setActiveNav("deposits");
document.getElementById("date").value=todaySydney();
async function load(){const p=new URLSearchParams({q:document.getElementById("q").value,date:document.getElementById("date").value});
const {rows}=await api("/api/data/deposits?"+p);
const tb=document.getElementById("rows");
if(!rows.length){tb.innerHTML='<tr><td colspan="6" class="empty">暂无数据，请先同步盘方 API</td></tr>';return;}
tb.innerHTML=rows.map(r=>'<tr><td>'+fmtDate(r.created_at)+'</td><td>'+(r.name||"-")+'</td><td>'+(r.mobile||"-")+'</td><td>'+fmtMoney(r.amount)+'</td><td>'+(r.status||"-")+'</td><td>'+r.id+'</td></tr>').join("");}
document.getElementById("search-btn").onclick=load; load();`),

  "withdrawals.html": page("提现单", "withdrawals", `
<div class="page-header"><h1>提现单</h1></div>
<div class="filters">
<div class="form-group"><label>搜索</label><input id="q"></div>
<div class="form-group"><label>日期</label><input type="date" id="date"></div>
<button class="btn btn-primary btn-sm" id="search-btn">搜索</button>
</div>
<div class="table-wrap"><table><thead><tr><th>时间</th><th>姓名</th><th>手机</th><th>金额</th><th>PayID</th><th>状态</th></tr></thead><tbody id="rows"></tbody></table></div>`, `
setActiveNav("withdrawals");
document.getElementById("date").value=todaySydney();
async function load(){const p=new URLSearchParams({q:document.getElementById("q").value,date:document.getElementById("date").value});
const {rows}=await api("/api/data/withdrawals?"+p);
const tb=document.getElementById("rows");
if(!rows.length){tb.innerHTML='<tr><td colspan="6" class="empty">暂无数据</td></tr>';return;}
tb.innerHTML=rows.map(r=>'<tr><td>'+fmtDate(r.created_at)+'</td><td>'+(r.name||"-")+'</td><td>'+(r.mobile||"-")+'</td><td>'+fmtMoney(r.amount)+'</td><td>'+(r.payid||"-")+'</td><td>'+(r.status||"-")+'</td></tr>').join("");}
document.getElementById("search-btn").onclick=load; load();`),

  "customers.html": page("顾客列表", "customers", `
<div class="page-header"><h1>顾客列表</h1></div>
<div class="filters"><div class="form-group"><label>搜索</label><input id="q" placeholder="手机/姓名"></div><button class="btn btn-primary btn-sm" id="search-btn">搜索</button></div>
<div class="table-wrap"><table><thead><tr><th>注册日</th><th>姓名</th><th>手机</th><th>充值次数</th><th>充值总额</th><th>最后充值</th><th>最后登录</th></tr></thead><tbody id="rows"></tbody></table></div>`, `
setActiveNav("customers");
async function load(){const {rows}=await api("/api/data/customers?q="+encodeURIComponent(document.getElementById("q").value));
const tb=document.getElementById("rows");
if(!rows.length){tb.innerHTML='<tr><td colspan="7" class="empty">暂无数据</td></tr>';return;}
tb.innerHTML=rows.map(r=>'<tr><td>'+fmtDate(r.register_date)+'</td><td>'+(r.name||"-")+'</td><td>'+(r.mobile||"-")+'</td><td>'+(r.dep_count||0)+'</td><td>'+fmtMoney(r.dep_total)+'</td><td>'+fmtDate(r.last_deposit)+'</td><td>'+fmtDate(r.last_login)+'</td></tr>').join("");}
document.getElementById("search-btn").onclick=load; load();`),

  "admin-users.html": page("账号管理", "admin", `
<div class="page-header"><h1>账号管理</h1><button class="btn btn-success btn-sm" id="create-btn">+ 新建账号</button></div>
<p style="color:#666;margin-bottom:16px;font-size:14px">自定义账号 ID 和密码，创建后复制发给操盘手</p>
<div class="table-wrap"><table><thead><tr><th>账号 ID</th><th>名称</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody id="rows"></tbody></table></div>
<div class="modal-overlay" id="create-modal"><div class="modal"><h2>新建操盘手账号</h2>
<div class="form-group"><label>账号 ID</label><input id="new-username" placeholder="如 joshua-ops"></div>
<div class="form-group"><label>显示名称</label><input id="new-name" placeholder="如 小王"></div>
<div class="form-group"><label>密码</label><input id="new-password" type="password"></div>
<div class="actions"><button class="btn btn-outline btn-sm" id="cancel-btn">取消</button><button class="btn btn-success btn-sm" id="save-btn">创建</button></div>
</div></div>
<div class="modal-overlay" id="share-modal"><div class="modal"><h2>发给操盘手</h2><div class="copy-box" id="share-text"></div>
<div class="actions"><button class="btn btn-primary btn-sm" id="copy-btn">复制</button><button class="btn btn-outline btn-sm" id="close-share">关闭</button></div></div></div>`, `
setActiveNav("admin");
let shareText="";
function showShare(text){shareText=text;document.getElementById("share-text").textContent=text;document.getElementById("share-modal").classList.add("show");}
async function loadUsers(){const {users}=await api("/api/admin/users");
document.getElementById("rows").innerHTML=users.map(u=>{
if(u.role==="admin")return '<tr><td><b>'+u.username+'</b></td><td>'+u.name+'</td><td>admin</td><td>'+u.status+'</td><td>-</td></tr>';
return '<tr><td><b>'+u.username+'</b></td><td>'+u.name+'</td><td>trader</td><td>'+u.status+'</td><td><button class="btn btn-outline btn-sm" data-reset="'+u.id+'" data-name="'+u.username+'">改密</button> <button class="btn btn-danger btn-sm" data-toggle="'+u.id+'" data-status="'+(u.status==="active"?"disabled":"active")+'">'+(u.status==="active"?"停用":"启用")+'</button></td></tr>';
}).join("");
document.querySelectorAll("[data-reset]").forEach(b=>b.onclick=async()=>{const pw=prompt("新密码 for "+b.dataset.name);if(!pw)return;await api("/api/admin/users/"+b.dataset.reset,{method:"PUT",body:JSON.stringify({password:pw})});showShare("后台: "+location.origin+"\\n账号: "+b.dataset.name+"\\n密码: "+pw);loadUsers();});
document.querySelectorAll("[data-toggle]").forEach(b=>b.onclick=async()=>{await api("/api/admin/users/"+b.dataset.toggle,{method:"PUT",body:JSON.stringify({status:b.dataset.status})});loadUsers();});}
document.getElementById("create-btn").onclick=()=>document.getElementById("create-modal").classList.add("show");
document.getElementById("cancel-btn").onclick=()=>document.getElementById("create-modal").classList.remove("show");
document.getElementById("close-share").onclick=()=>document.getElementById("share-modal").classList.remove("show");
document.getElementById("copy-btn").onclick=()=>{navigator.clipboard.writeText(shareText);alert("已复制");};
document.getElementById("save-btn").onclick=async()=>{const username=document.getElementById("new-username").value.trim();const name=document.getElementById("new-name").value.trim();const password=document.getElementById("new-password").value;
const {user}=await api("/api/admin/users",{method:"POST",body:JSON.stringify({username,name,password})});
document.getElementById("create-modal").classList.remove("show");
showShare("后台: "+location.origin+"\\n账号: "+user.username+"\\n密码: "+password+"\\n名称: "+user.name);loadUsers();};
loadUser().then(u=>{if(u.role!=="admin")location.href="/";else loadUsers();});`),
};

for (const [name, html] of Object.entries(files)) {
  fs.writeFileSync(path.join(publicDir, name), html, "utf8");
  console.log("wrote", name);
}
