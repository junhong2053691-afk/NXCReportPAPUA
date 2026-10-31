// Escalating alarm: the shared state machine behind every audible warning in
// the dashboard (platform pending approvals, C STATUS out of balance).
//
// The point of this file is that "don't let me miss it" and "don't nag me" are
// not in conflict once the alarm is allowed to stay quiet for a while. An
// alarm here NEVER loops. It stays silent for FIRST_DELAY_MS after a problem
// appears -- long enough that anything you deal with straight away never makes
// a sound at all -- then plays exactly once, and once more every REPEAT_MS
// while the problem is still there.
//
// State lives in localStorage keyed by scope, so a page refresh neither
// restarts the quiet window nor re-fires the sound. That refresh-and-it-
// screams-again behaviour was the loudest part of the old implementation.

const FIRST_DELAY_MS = 5 * 60 * 1000; // silent grace period after a problem appears
const REPEAT_MS = 10 * 60 * 1000; // gap between repeats once it has fired
const SNOOZE_MS = 20 * 60 * 1000; // silence after the operator acknowledges
const TICK_MS = 15 * 1000; // self-driven, so escalation never waits on a page render

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
  const firstDelayMs = opts.firstDelayMs == null ? FIRST_DELAY_MS : opts.firstDelayMs;
  const repeatMs = opts.repeatMs == null ? REPEAT_MS : opts.repeatMs;
  const snoozeMs = opts.snoozeMs == null ? SNOOZE_MS : opts.snoozeMs;

  let audio = null;
  let sig = "";
  let stage = "quiet";
  let blocked = false;
  let unlocked = false;
  let timer = null;

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
    // Never loop. A looping alarm is the thing this module exists to replace.
    audio.loop = false;
    audio.preload = "auto";
    audio.volume = volume;
    return audio;
  }

  function stop() {
    if (!audio) return;
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch (_) {}
  }

  function play() {
    const a = getAudio();
    if (!a) return;
    a.loop = false;
    a.muted = false;
    try {
      a.currentTime = 0;
    } catch (_) {}
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
      play();
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
    firstDelayMs: firstDelayMs,
    snoozeMs: snoozeMs,
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
  };
}
