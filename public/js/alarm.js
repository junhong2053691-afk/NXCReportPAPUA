// Escalating alarm: the shared state machine behind every audible warning in
// the dashboard (platform pending approvals, C STATUS out of balance, bank
// balance over its limit).
//
// By default an alarm stays silent for FIRST_DELAY_MS after a problem appears,
// then plays exactly once, and once more every REPEAT_MS while the problem is
// still there. Each caller picks a preset from ALARM_PRESETS instead
// (2026-11-10, user decision: each kind of alarm gets its own cadence):
//   pending   -- platform pending approvals: play at once, repeat every 10 min.
//   reconcile -- C STATUS out of balance: play at once and KEEP playing
//                (continuous, audio.loop) until somebody presses OK. This is the
//                only alarm allowed to loop; the user asked for it explicitly.
//   balance   -- bank balance over its limit: play at once, repeat every 10 min.
// Acknowledging any of them silences it for SNOOZE_MS.
//
// State lives in localStorage keyed by scope, so a page refresh neither
// restarts the quiet window nor re-fires the sound. That refresh-and-it-
// screams-again behaviour was the loudest part of the old implementation.

const FIRST_DELAY_MS = 5 * 60 * 1000; // default silent grace period after a problem appears
const REPEAT_MS = 10 * 60 * 1000; // gap between repeats once it has fired
const SNOOZE_MS = 20 * 60 * 1000; // silence after the operator acknowledges
const TICK_MS = 15 * 1000; // self-driven, so escalation never waits on a page render

// The only place the per-alarm cadence is defined. Callers pass { preset: "..." }.
// app.js and cross-company-alerts.js share one storage key per company, so both
// MUST use "pending".
const ALARM_PRESETS = {
  pending: { firstDelayMs: 0, repeatMs: REPEAT_MS, snoozeMs: SNOOZE_MS, continuous: false },
  reconcile: { firstDelayMs: 0, repeatMs: REPEAT_MS, snoozeMs: SNOOZE_MS, continuous: true },
  balance: { firstDelayMs: 0, repeatMs: REPEAT_MS, snoozeMs: SNOOZE_MS, continuous: false },
};

function memoryStorage() {
  const map = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    setItem: function (k, v) { map[k] = String(v); },
    removeItem: function (k) { delete map[k]; },
  };
}

function defaultStorage() {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch (_) {}
  return memoryStorage();
}

function defaultCreateAudio(src) {
  if (typeof Audio === "undefined") return null;
  return new Audio(src);
}

function createEscalatingAlarm(options) {
  const opts = options || {};
  const soundSrc = opts.soundSrc;
  const keyPrefix = opts.keyPrefix || "dash-alarm";
  const volume = opts.volume == null ? 0.85 : opts.volume;
  const onStageChange = typeof opts.onStageChange === "function" ? opts.onStageChange : function () {};
  const now = typeof opts.now === "function" ? opts.now : function () { return Date.now(); };
  const createAudio = typeof opts.createAudio === "function" ? opts.createAudio : defaultCreateAudio;
  const storage = opts.storage || defaultStorage();
  const preset = (opts.preset && ALARM_PRESETS[opts.preset]) || {};
  function pick(name, fallback) {
    if (opts[name] != null) return opts[name];
    if (preset[name] != null) return preset[name];
    return fallback;
  }
  const firstDelayMs = pick("firstDelayMs", FIRST_DELAY_MS);
  const repeatMs = pick("repeatMs", REPEAT_MS);
  const snoozeMs = pick("snoozeMs", SNOOZE_MS);
  // Continuous: loop the sound for as long as the alarm is loud. Only the
  // reconcile preset does this (see the header).
  const continuous = !!pick("continuous", false);

  let audio = null;
  let sig = "";
  let stage = "quiet";
  let blocked = false;
  let unlocked = false;
  let timer = null;
  let playing = false; // continuous mode only: is the loop currently running?

  function scopeValue() {
    const scope = opts.scope;
    const v = typeof scope === "function" ? scope() : scope;
    return v == null || v === "" ? "__current__" : String(v);
  }

  function storageKey() {
    return keyPrefix + ":" + scopeValue();
  }

  function readState() {
    try {
      const raw = storage.getItem(storageKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function writeState(state) {
    try {
      storage.setItem(storageKey(), JSON.stringify(state));
    } catch (_) {}
  }

  function clearState() {
    try {
      storage.removeItem(storageKey());
    } catch (_) {}
  }

  function getAudio() {
    if (audio) return audio;
    audio = createAudio(soundSrc);
    if (!audio) return null;
    // Only a continuous alarm loops; everything else plays once per firing.
    audio.loop = continuous;
    audio.preload = "auto";
    audio.volume = volume;
    return audio;
  }

  function stop() {
    playing = false;
    if (!audio) return;
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch (_) {}
  }

  function play() {
    const a = getAudio();
    if (!a) return;
    a.loop = continuous;
    a.muted = false;
    try {
      a.currentTime = 0;
    } catch (_) {}
    playing = continuous;
    const played = a.play();
    if (played && typeof played.then === "function") {
      played
        .then(function () {
          if (blocked) {
            blocked = false;
            onStageChange(stage, { blocked: blocked });
          }
        })
        .catch(function () {
          // Autoplay blocked: let the next tick try again once the page has been touched.
          playing = false;
          blocked = true;
          onStageChange(stage, { blocked: blocked });
        });
    }
  }

  // Muted probe play, so the browser counts the alarm as user-initiated long
  // before it actually needs to be heard.
  function unlock() {
    if (unlocked) return;
    const a = getAudio();
    if (!a) return;
    const wasMuted = a.muted;
    a.muted = true;
    const played = a.play();
    if (played && typeof played.then === "function") {
      played
        .then(function () {
          try {
            a.pause();
            a.currentTime = 0;
          } catch (_) {}
          a.muted = wasMuted;
          unlocked = true;
        })
        .catch(function () {
          a.muted = wasMuted;
        });
    } else {
      a.muted = wasMuted;
      unlocked = true;
    }
  }

  function setStage(next) {
    if (next === stage) return;
    stage = next;
    onStageChange(stage, { blocked: blocked });
  }

  function stageFor(state) {
    return state && state.firedAt && !state.acked ? "loud" : "quiet";
  }

  function evaluate() {
    if (!sig) {
      setStage("quiet");
      return;
    }
    const t = now();
    let state = readState();
    if (!state || state.sig !== sig) {
      // A new problem (or a changed one): restart the quiet window.
      state = { sig: sig, firstSeenAt: t, quietUntil: t + firstDelayMs, firedAt: 0, acked: false };
      writeState(state);
    }
    if (t >= state.quietUntil) {
      state.firedAt = t;
      state.acked = false;
      state.quietUntil = t + repeatMs;
      writeState(state);
      // A continuous alarm that is already looping just keeps going.
      if (!(continuous && playing)) play();
    } else if (continuous) {
      // Continuous: the sound follows the stage. Resume after a refresh / new
      // instance while still loud; stop if another tab acknowledged it, or the
      // scope moved to one that is snoozed.
      if (stageFor(state) === "loud" && !playing) play();
      else if (stageFor(state) !== "loud" && playing) stop();
    }
    setStage(stageFor(state));
  }

  function startTimer() {
    if (timer || opts.autoTick === false) return;
    if (typeof setInterval !== "function") return;
    timer = setInterval(evaluate, opts.tickMs == null ? TICK_MS : opts.tickMs);
  }

  function update(signature) {
    const next = signature == null ? "" : String(signature);
    if (!next) {
      sig = "";
      clearState();
      stop();
      setStage("quiet");
      return;
    }
    sig = next;
    startTimer();
    evaluate();
  }

  function acknowledge() {
    if (!sig) return;
    const state = readState() || { sig: sig, firstSeenAt: now(), firedAt: 0 };
    state.sig = sig;
    state.acked = true;
    state.quietUntil = now() + snoozeMs;
    writeState(state);
    blocked = false;
    stop();
    setStage("quiet");
  }

  function dispose() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    stop();
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function" && opts.autoUnlock !== false) {
    ["pointerdown", "keydown", "touchstart"].forEach(function (eventName) {
      window.addEventListener(eventName, function () {
        unlock();
      }, { passive: true });
    });
  }

  return {
    update: update,
    acknowledge: acknowledge,
    tick: evaluate,
    stage: function () { return stage; },
    blocked: function () { return blocked; },
    // True only between an acknowledge() and the snooze expiring, so callers can
    // tell "snoozed by the operator" apart from "still inside the grace period".
    acked: function () {
      const state = readState();
      return !!(state && state.sig === sig && state.acked);
    },
    stop: stop,
    dispose: dispose,
    playing: function () { return playing; },
    // The signature stored for the current scope (survives a refresh). balance-alerts.js
    // uses it to carry its "only new problems re-fire" baseline across reloads.
    storedSig: function () {
      const state = readState();
      return (state && state.sig) || "";
    },
    firstDelayMs: firstDelayMs,
    repeatMs: repeatMs,
    snoozeMs: snoozeMs,
    continuous: continuous,
  };
}

// Browser global (guarded so Node can require this file in tests).
if (typeof window !== "undefined") {
  window.createEscalatingAlarm = createEscalatingAlarm;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    createEscalatingAlarm: createEscalatingAlarm,
    FIRST_DELAY_MS: FIRST_DELAY_MS,
    REPEAT_MS: REPEAT_MS,
    SNOOZE_MS: SNOOZE_MS,
    TICK_MS: TICK_MS,
    ALARM_PRESETS: ALARM_PRESETS,
  };
}
