const { runSync } = require("./services/sync");
const { getDb } = require("./db/init");
const { listEnabledCompanies } = require("./lib/companies");

// Per-company independent loops. Each company has its own fast lane (near real-time
// today data + stats) and slow lane (full user import + reconcile/prune). Companies
// run fully in parallel, so one slow/failing company can NEVER block the others.
// Fast and slow lanes for the same company are serialized inside runSync's per-company
// chain, so they never corrupt shared sync state.

const timers = new Set();
const started = new Set();
let stopped = false;

function scheduleLoop(fn, intervalMs, delayMsFn = null) {
  const run = async () => {
    if (stopped) return;
    try {
      await fn();
    } catch (e) {
      console.error("[scheduler] loop error:", e.message);
    } finally {
      if (!stopped) {
        const delay = typeof delayMsFn === "function" ? delayMsFn() : intervalMs;
        const t = setTimeout(run, Math.max(intervalMs, Number(delay || intervalMs)));
        timers.add(t);
      }
    }
  };
  run();
}

function isTransientNetworkError(e) {
  const msg = String((e && e.message) || e || "").toLowerCase();
  return msg.includes("network error") || msg.includes("fetch failed") || msg.includes("timeout");
}

function startScheduler(cfg) {
  stopped = false;
  const fastSec = Math.max(4, Number(cfg.syncIntervalSeconds || 6));
  const slowSec = Math.max(20, Number(cfg.slowSyncIntervalSeconds || 45));
  const accessDeniedBackoffSec = Math.max(60, Number(cfg.accessDeniedBackoffSeconds || 300));
  const accessDeniedBackoffMaxSec = Math.max(accessDeniedBackoffSec, Number(cfg.accessDeniedBackoffMaxSeconds || 1800));
  const networkBackoffSec = Math.max(fastSec, Number(cfg.networkBackoffSeconds || 60));
  const networkBackoffMaxSec = Math.max(networkBackoffSec, Number(cfg.networkBackoffMaxSeconds || 300));
  const backoff = new Map();
  console.log(
    "[scheduler] per-company parallel loops — fast",
    fastSec + "s",
    "/ slow",
    slowSec + "s"
  );

  const beginCompany = (companyId) => {
    if (started.has(companyId)) return;
    started.add(companyId);
    console.log("[scheduler] start loops for", companyId);
    const keyOf = (lane) => companyId + ":" + lane;
    const nextDelay = (lane, intervalMs) => {
      const state = backoff.get(keyOf(lane));
      if (!state || !state.until) return intervalMs;
      return Math.max(intervalMs, state.until - Date.now());
    };
    const runLane = async (lane) => {
      const key = keyOf(lane);
      const state = backoff.get(key);
      if (state && state.until > Date.now()) return;
      try {
        await runSync({ quick: true, lane, companyId });
        if (state) {
          backoff.delete(key);
          console.log("[scheduler]", companyId, lane, "backoff cleared");
        }
      } catch (e) {
        const denied = e.code === "ACCESS_DENIED";
        const transient = !denied && isTransientNetworkError(e);
        if (!denied && !transient) {
          console.error("[scheduler:" + lane + "]", companyId, e.message);
          return;
        }
        const base = denied ? accessDeniedBackoffSec : networkBackoffSec;
        const max = denied ? accessDeniedBackoffMaxSec : networkBackoffMaxSec;
        const prev = backoff.get(key) || { failures: 0, loggedAt: 0 };
        const failures = prev.failures + 1;
        const delaySec = Math.min(max, base * Math.pow(2, Math.min(failures - 1, 4)));
        const until = Date.now() + delaySec * 1000;
        backoff.set(key, { failures, until, loggedAt: Date.now() });
        console.warn(
          "[scheduler]",
          companyId,
          lane,
          denied ? "ACCESS_DENIED" : "network error",
          "- pause",
          delaySec + "s"
        );
      }
    };
    // Access-denied errors are already logged once (with recovery tracking) inside runSync,
    // so we stay silent here to avoid flooding the console every tick during an outage.
    // Fast lane: today tx + tail users + integrity + stats.
    scheduleLoop(() => runLane("fast"), fastSec * 1000, () => nextDelay("fast", fastSec * 1000));
    // Slow lane: rotating full user import + reconcile/prune. Staggered start.
    const slowDelay = setTimeout(() => {
      scheduleLoop(() => runLane("slow"), slowSec * 1000, () => nextDelay("slow", slowSec * 1000));
    }, 4000);
    timers.add(slowDelay);
  };

  // Discover companies now and periodically (picks up newly added companies live).
  const discover = () => {
    try {
      const companies = listEnabledCompanies(getDb());
      if (!companies.length) {
        console.log("[scheduler] no enabled companies with API credentials");
        return;
      }
      for (const co of companies) beginCompany(co.id);
    } catch (e) {
      console.error("[scheduler] discover error:", e.message);
    }
  };

  discover();
  const disc = setInterval(discover, 60 * 1000);
  timers.add(disc);
}

function stopScheduler() {
  stopped = true;
  for (const t of timers) {
    clearTimeout(t);
    clearInterval(t);
  }
  timers.clear();
  started.clear();
}

module.exports = { startScheduler, stopScheduler };
