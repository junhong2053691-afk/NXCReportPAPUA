setActiveNav("deposits");
document.getElementById("date").value = todaySydney();

async function loadDeposits() {
  const q = document.getElementById("q").value;
  const date = document.getElementById("date").value;
  const { rows } = await api("/api/data/deposits?q=" + encodeURIComponent(q) + "&date=" + date);
  const tbody = document.getElementById("rows");
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无数据，请先同步盘方 API</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map(
      (r) =>
        "<tr><td>" +
        fmtDate(r.created_at) +
        "</td><td>" +
        displayNameHtml(r.name || '-') +
        "</td><td>" +
        (r.mobile || "-") +
        "</td><td>" +
        fmtMoney(r.amount) +
        "</td><td>" +
        (r.status || "-") +
        "</td><td>" +
        r.id +
        "</td></tr>"
    )
    .join("");
}

document.getElementById("search-btn").onclick = loadDeposits;
loadDeposits();
startAutoReload(loadDeposits, 10);
