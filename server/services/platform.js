const { readConfig } = require("../lib/readConfig");
const { getDb } = require("../db/init");
const { getCompanyCredentials } = require("../lib/companies");

let cfg;

function loadCfg() {
  if (!cfg) cfg = readConfig();
  return cfg;
}

function platformCfg(companyId) {
  if (!companyId) throw new Error("companyId required for API call");
  const fromDb = getCompanyCredentials(getDb(), companyId);
  if (fromDb) return fromDb;
  const c = loadConfigFallback(companyId);
  if (c) return c;
  throw new Error("API not configured for company: " + companyId);
}

function loadConfigFallback(companyId) {
  const c = loadCfg().platform || {};
  if (companyId === "aussiex6" && c.apiUrl && (c.accessToken || c.apiKey)) {
    return {
      id: "aussiex6",
      name: "AussieX6",
      apiUrl: c.apiUrl,
      accessId: String(c.accessId ?? c.merchantId ?? ""),
      accessToken: String(c.accessToken ?? c.apiKey ?? ""),
    };
  }
  return null;
}

function buildFormData(companyId, module, extra = {}) {
  const p = platformCfg(companyId);
  const form = new FormData();
  form.append("module", module);
  form.append("accessId", p.accessId);
  form.append("accessToken", p.accessToken);
  for (const [k, v] of Object.entries(extra)) {
    if (k === "companyId") continue;
    if (v != null && v !== "") form.append(k, String(v));
  }
  return { form, apiUrl: p.apiUrl };
}

const MAX_API_ATTEMPTS = 4;
const MAX_TRANSIENT_NETWORK_ATTEMPTS = 8;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function retryJitterMs(companyId) {
  const text = String(companyId || "");
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash % 450;
}

// "Invalid Access!" / "access denied" / auth failures are NOT transient — they mean the
// platform rejected our credentials or source IP (e.g. wrong/closed VPN, IP not whitelisted,
// or a rotated token). Retrying hammers the API and can extend an IP ban, so we fail fast
// and let the next scheduled tick try again once the underlying access is restored.
function isAccessDenied(msg) {
  const s = String(msg || "").toLowerCase();
  return (
    s.includes("invalid access") ||
    s.includes("access denied") ||
    s.includes("unauthorized") ||
    s.includes("forbidden") ||
    s.includes("invalid token") ||
    s.includes("invalid credential")
  );
}

function accessDeniedError(module, rawMsg) {
  const err = new Error(
    module +
      " 拒绝访问 (Invalid Access): \u51fa\u53e3IP\u672a\u6388\u6743\u6216\u51ed\u8bc1\u5931\u6548\uff0c\u8bf7\u68c0\u67e5 VPN/\u7f51\u7edc\u51fa\u53e3\u6216\u5e73\u53f0\u51ed\u8bc1 [" +
      rawMsg +
      "]"
  );
  err.code = "ACCESS_DENIED";
  return err;
}

async function apiCall(module, extra = {}, attempt = 1, companyId) {
  const cid = companyId || extra.companyId;
  if (!cid) throw new Error("companyId required");
  const params = { ...extra };
  delete params.companyId;
  const { form, apiUrl } = buildFormData(cid, module, params);
  const timeoutMs = Number(loadCfg().apiTimeoutMs || 25000);

  // --- network layer: timeout + retry on transient network/HTTP failures ---
  let text;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(apiUrl, { method: "POST", body: form, signal: controller.signal });
      if (!res.ok && res.status >= 500) {
        throw new Error("HTTP " + res.status);
      }
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
  } catch (netErr) {
    const timedOut = netErr && netErr.name === "AbortError";
    const cause = netErr?.cause?.code || netErr?.cause?.message || "";
    const reason = timedOut
      ? "timeout after " + timeoutMs + "ms"
      : [netErr.message || String(netErr), cause].filter(Boolean).join(" (cause: ") + (cause ? ")" : "");
    // VPN route changes can reset several requests in a row. Give immediate
    // socket failures a longer retry window, and stagger companies so all four
    // do not reconnect to the shared platform edge at the exact same moment.
    const maxAttempts = timedOut ? MAX_API_ATTEMPTS : MAX_TRANSIENT_NETWORK_ATTEMPTS;
    if (attempt < maxAttempts) {
      await sleep(Math.min(600 * attempt, 3000) + retryJitterMs(cid));
      return apiCall(module, params, attempt + 1, cid);
    }
    throw new Error(module + " network error: " + reason);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    if (attempt < MAX_API_ATTEMPTS) {
      await sleep(700 * attempt);
      return apiCall(module, params, attempt + 1, cid);
    }
    throw new Error(module + " invalid JSON response");
  }
  if (json.status !== "SUCCESS") {
    const msg =
      (json.data && (json.data.message || json.data.msg)) ||
      json.message ||
      json.msg ||
      json.status ||
      "API error";
    // Access/credential rejection: fail fast, never retry (retrying can extend an IP ban).
    if (isAccessDenied(msg)) {
      throw accessDeniedError(module, msg);
    }
    // Other API errors (rate limit / transient server hiccups): retry with backoff.
    if (attempt < MAX_API_ATTEMPTS) {
      await sleep(900 * attempt);
      return apiCall(module, params, attempt + 1, cid);
    }
    throw new Error(module + " failed: " + msg);
  }
  return json.data || json;
}

async function fetchAllPages(module, extra = {}, pickRows, opts = {}) {
  const c = loadCfg();
  const companyId = opts.companyId || extra.companyId;
  if (!companyId) throw new Error("companyId required for fetchAllPages");
  const startPage = Math.max(0, Number(opts.startPage ?? 0));
  const maxPages = Number(opts.maxPages ?? c.maxPages ?? 500);
  const delayMs = Number(opts.delayMs ?? c.requestDelayMs ?? 120);
  const all = [];
  let totalPage = 1;
  let pagesFetched = 0;
  const pageSize = Number(opts.pageSize ?? c.pageSize ?? 200);
  const params = { ...extra };
  delete params.companyId;
  for (let i = 0; i < maxPages; i++) {
    const pageIndex = startPage + i;
    const data = await apiCall(module, { ...params, pageIndex, pageSize }, 1, companyId);
    if (pagesFetched === 0) totalPage = Number(data.totalPage || data.totalPages || 1);
    if (pageIndex >= totalPage) break;
    const rows = pickRows(data);
    pagesFetched++;
    if (!rows.length) {
      if (pageIndex + 1 < totalPage) continue;
      break;
    }
    all.push(...rows);
    if (pageIndex % 10 === 0 || pageIndex === totalPage - 1) {
      console.log("[sync]", companyId, module, "page", pageIndex + 1, "/", totalPage, "rows", all.length);
    }
    if (pageIndex + 1 < totalPage && i + 1 < maxPages && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  if (opts.returnMeta) {
    return { rows: all, startPage, pagesFetched, totalPage };
  }
  return all;
}

module.exports = { loadCfg, platformCfg, apiCall, fetchAllPages, isAccessDenied };
