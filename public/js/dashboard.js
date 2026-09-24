setActiveNav("home");
api("/api/data/dashboard")
  .then((d) => {
    document.getElementById("report-date").textContent = "报表日: " + d.date;
    document.getElementById("dep-count").textContent = d.deposits.count + " 笔";
    document.getElementById("dep-total").textContent = "合计 " + fmtMoney(d.deposits.total);
    document.getElementById("wd-count").textContent = d.withdrawals.count + " 笔";
    document.getElementById("wd-total").textContent = "合计 " + fmtMoney(d.withdrawals.total);
    document.getElementById("cust-total").textContent = d.customers.total;
    document.getElementById("cust-new").textContent = "今日新注册 " + d.customers.newToday;
  })
  .catch(() => {});
