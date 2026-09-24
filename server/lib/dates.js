const TZ = "Australia/Sydney";

function todayKey() {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

function dateKeyFromIso(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (isNaN(ms)) return "";
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
}

function shiftDateKey(dateKey, deltaDays) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + deltaDays);
  const yy = t.getUTCFullYear();
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function formatSydneyDateTime(iso) {
  const ms = Date.parse(iso || new Date().toISOString());
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function monthBounds(dateKey, today) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(dateKey || ""));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const month = m[1] + "-" + m[2];
  const from = month + "-01";
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const toMonthEnd = month + "-" + String(lastDay).padStart(2, "0");
  const cap = today || todayKey();
  const to = toMonthEnd > cap ? cap : toMonthEnd;
  const label = y + "年" + mo + "月";
  return { month, from, to, label, isComplete: toMonthEnd <= cap };
}

module.exports = { TZ, todayKey, dateKeyFromIso, shiftDateKey, formatSydneyDateTime, monthBounds };
