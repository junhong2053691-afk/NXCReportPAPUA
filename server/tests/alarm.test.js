const test = require("node:test");
const assert = require("node:assert/strict");

const { createEscalatingAlarm, FIRST_DELAY_MS, REPEAT_MS, SNOOZE_MS } = require("../../public/js/alarm");

const MINUTE = 60 * 1000;

function fakeStorage() {
  const map = {};
  return {
    map: map,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    setItem: function (k, v) { map[k] = String(v); },
    removeItem: function (k) { delete map[k]; },
  };
}

// Records every play() so the tests can count how often the operator would
// actually have heard something.
function fakePlayer() {
  const plays = [];
  const audio = {
    loop: true, // starts wrong on purpose: the alarm must clear it
    muted: false,
    volume: 0,
    preload: "",
    currentTime: 0,
    play: function () { plays.push({ loop: audio.loop, muted: audio.muted }); },
    pause: function () {},
  };
  return { plays: plays, audio: audio, create: function () { return audio; } };
}

function harness(overrides) {
  const player = fakePlayer();
  const storage = fakeStorage();
  const clock = { t: 1000000 };
  const stages = [];
  const opts = Object.assign(
    {
      soundSrc: "/sounds/test.mp3",
      keyPrefix: "test-alarm",
      scope: "co1",
      storage: storage,
      createAudio: player.create,
      now: function () { return clock.t; },
      onStageChange: function (stage) { stages.push(stage); },
      autoTick: false,
      autoUnlock: false,
    },
    overrides || {}
  );
  const alarm = createEscalatingAlarm(opts);
  return { alarm: alarm, player: player, storage: storage, clock: clock, stages: stages, opts: opts };
}

test("stays completely silent during the grace period", () => {
  const h = harness();
  h.alarm.update("pending");
  assert.equal(h.player.plays.length, 0);
  assert.equal(h.alarm.stage(), "quiet");

  // Poll every 15s for just under the grace period: still not a single sound.
  for (let elapsed = 0; elapsed < FIRST_DELAY_MS; elapsed += 15 * 1000) {
    h.clock.t += 15 * 1000;
    if (h.clock.t - 1000000 >= FIRST_DELAY_MS) break;
    h.alarm.tick();
  }
  assert.equal(h.player.plays.length, 0, "nothing you deal with inside 5 minutes should ever make a sound");
  assert.equal(h.alarm.stage(), "quiet");
});

test("fires exactly once at the threshold, never looping", () => {
  const h = harness();
  h.alarm.update("pending");
  h.clock.t += FIRST_DELAY_MS;
  h.alarm.tick();

  assert.equal(h.player.plays.length, 1);
  assert.equal(h.player.plays[0].loop, false, "a looping alarm is what this module replaces");
  assert.equal(h.player.plays[0].muted, false);
  assert.equal(h.alarm.stage(), "loud");

  // Repeated polling right after does not stack up more sound.
  h.clock.t += 15 * 1000;
  h.alarm.tick();
  h.clock.t += 15 * 1000;
  h.alarm.tick();
  assert.equal(h.player.plays.length, 1);
});

test("repeats on the REPEAT_MS cadence while the problem is still there", () => {
  const h = harness();
  h.alarm.update("pending");

  h.clock.t += FIRST_DELAY_MS;
  h.alarm.tick();
  assert.equal(h.player.plays.length, 1);

  // Just before the repeat is due.
  h.clock.t += REPEAT_MS - 1000;
  h.alarm.tick();
  assert.equal(h.player.plays.length, 1);

  h.clock.t += 1000;
  h.alarm.tick();
  assert.equal(h.player.plays.length, 2, "5 min then 15 min, matching the chosen escalation");

  h.clock.t += REPEAT_MS;
  h.alarm.tick();
  assert.equal(h.player.plays.length, 3);
});

test("a page refresh neither re-fires nor restarts the quiet window", () => {
  const h = harness();
  h.alarm.update("pending");
  h.clock.t += FIRST_DELAY_MS;
  h.alarm.tick();
  assert.equal(h.player.plays.length, 1);
  const stateAfterFire = JSON.parse(h.storage.getItem("test-alarm:co1"));

  // Rebuild the alarm against the same storage: this is what a refresh does.
  const player2 = fakePlayer();
  const fresh = createEscalatingAlarm(
    Object.assign({}, h.opts, { createAudio: player2.create, onStageChange: function () {} })
  );
  h.clock.t += 5 * 1000;
  fresh.update("pending");

  assert.equal(player2.plays.length, 0, "refreshing the page must not scream at you again");
  const stateAfterRefresh = JSON.parse(h.storage.getItem("test-alarm:co1"));
  assert.equal(stateAfterRefresh.firstSeenAt, stateAfterFire.firstSeenAt);
  assert.equal(stateAfterRefresh.quietUntil, stateAfterFire.quietUntil);
  assert.equal(fresh.stage(), "loud", "the visual escalation does survive the refresh");
});

test("acknowledge silences for SNOOZE_MS and drops back to the quiet look", () => {
  const h = harness();
  h.alarm.update("pending");
  h.clock.t += FIRST_DELAY_MS;
  h.alarm.tick();
  assert.equal(h.alarm.stage(), "loud");

  h.alarm.acknowledge();
  assert.equal(h.alarm.stage(), "quiet");

  h.clock.t += SNOOZE_MS - 1000;
  h.alarm.tick();
  assert.equal(h.player.plays.length, 1, "still snoozed");
  assert.equal(h.alarm.stage(), "quiet");

  h.clock.t += 1000;
  h.alarm.tick();
  assert.equal(h.player.plays.length, 2, "the snooze expires, so nothing stays muted forever");
  assert.equal(h.alarm.stage(), "loud");
});

test("resolving the problem clears the stored state", () => {
  const h = harness();
  h.alarm.update("pending");
  h.clock.t += FIRST_DELAY_MS;
  h.alarm.tick();
  assert.ok(h.storage.getItem("test-alarm:co1"));

  h.alarm.update("");
  assert.equal(h.storage.getItem("test-alarm:co1"), null);
  assert.equal(h.alarm.stage(), "quiet");

  // And a later tick with no problem stays silent.
  h.clock.t += REPEAT_MS;
  h.alarm.tick();
  assert.equal(h.player.plays.length, 1);
});

test("a changed signature restarts the grace period", () => {
  const h = harness();
  h.alarm.update("cimb:100");
  h.clock.t += FIRST_DELAY_MS;
  h.alarm.tick();
  assert.equal(h.player.plays.length, 1);

  // The difference changed: a different problem, so it gets its own quiet window.
  h.clock.t += 1000;
  h.alarm.update("cimb:250");
  assert.equal(h.player.plays.length, 1);
  assert.equal(h.alarm.stage(), "quiet");

  h.clock.t += FIRST_DELAY_MS - 1000;
  h.alarm.tick();
  assert.equal(h.player.plays.length, 1);

  h.clock.t += 1000;
  h.alarm.tick();
  assert.equal(h.player.plays.length, 2);
});

test("scopes are isolated, so switching company keeps each timeline separate", () => {
  const scope = { id: "co1" };
  const h = harness({ scope: function () { return scope.id; } });
  h.alarm.update("pending");
  h.clock.t += FIRST_DELAY_MS;
  h.alarm.tick();
  assert.equal(h.player.plays.length, 1);

  scope.id = "co2";
  h.alarm.update("pending");
  assert.equal(h.player.plays.length, 1, "the other company gets its own grace period");
  assert.ok(h.storage.getItem("test-alarm:co1"));
  assert.ok(h.storage.getItem("test-alarm:co2"));

  h.clock.t += FIRST_DELAY_MS;
  h.alarm.tick();
  assert.equal(h.player.plays.length, 2);
});

test("thresholds are the agreed 5 / 15 minute escalation", () => {
  assert.equal(FIRST_DELAY_MS, 5 * MINUTE);
  assert.equal(FIRST_DELAY_MS + REPEAT_MS, 15 * MINUTE);
  assert.equal(SNOOZE_MS, 20 * MINUTE);
});

// ── Per-alarm presets (2026-11-10: each kind of alarm gets its own cadence) ──

const { ALARM_PRESETS } = require("../../public/js/alarm");

test("presets: pending and balance fire at once, reconcile loops until OK", () => {
  assert.equal(ALARM_PRESETS.pending.firstDelayMs, 0);
  assert.equal(ALARM_PRESETS.pending.repeatMs, 10 * MINUTE);
  assert.equal(ALARM_PRESETS.pending.snoozeMs, 20 * MINUTE);
  assert.equal(ALARM_PRESETS.pending.continuous, false);
  assert.equal(ALARM_PRESETS.balance.firstDelayMs, 0);
  assert.equal(ALARM_PRESETS.balance.repeatMs, 10 * MINUTE);
  assert.equal(ALARM_PRESETS.balance.continuous, false);
  assert.equal(ALARM_PRESETS.reconcile.firstDelayMs, 0);
  assert.equal(ALARM_PRESETS.reconcile.snoozeMs, 20 * MINUTE);
  assert.equal(ALARM_PRESETS.reconcile.continuous, true);
});

test("app.js and cross-company-alerts.js share a key, so both must use the pending preset", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const app = fs.readFileSync(path.join(__dirname, "../../public/js/app.js"), "utf8");
  const xco = require("../../public/js/cross-company-alerts");
  assert.match(app, /preset: "pending"/);
  assert.equal(xco.XCO_ALARM_PRESET, "pending");
});

test("pending preset: plays once immediately, never loops, repeats every 10 min", () => {
  const h = harness({ preset: "pending" });
  h.alarm.update("pending");
  assert.equal(h.player.plays.length, 1, "an order coming in sounds straight away");
  assert.equal(h.player.plays[0].loop, false);
  assert.equal(h.alarm.stage(), "loud");

  h.clock.t += REPEAT_MS - 1000;
  h.alarm.tick();
  assert.equal(h.player.plays.length, 1);
  h.clock.t += 1000;
  h.alarm.tick();
  assert.equal(h.player.plays.length, 2);
});

test("pending preset: rebuilding the instance (a refresh) does not re-fire", () => {
  const h = harness({ preset: "pending" });
  h.alarm.update("pending");
  assert.equal(h.player.plays.length, 1);
  const player2 = fakePlayer();
  const fresh = createEscalatingAlarm(Object.assign({}, h.opts, { createAudio: player2.create, onStageChange: function () {} }));
  h.clock.t += 5000;
  fresh.update("pending");
  assert.equal(player2.plays.length, 0);
});

test("explicit options still override a preset", () => {
  const h = harness({ preset: "pending", firstDelayMs: 60 * 1000 });
  h.alarm.update("pending");
  assert.equal(h.player.plays.length, 0);
  assert.equal(h.alarm.firstDelayMs, 60 * 1000);
});

test("reconcile preset: loops from the first moment and stops only on acknowledge", () => {
  const h = harness({ preset: "reconcile" });
  h.alarm.update("cimb:100");
  assert.equal(h.player.plays.length, 1);
  assert.equal(h.player.plays[0].loop, true, "keeps ringing for as long as it is out of balance");
  assert.equal(h.alarm.playing(), true);

  // Ticks while still looping must not restart the sound.
  for (let i = 0; i < 80; i += 1) {
    h.clock.t += 15 * 1000;
    h.alarm.tick();
  }
  assert.equal(h.player.plays.length, 1, "a running loop is left alone, even past REPEAT_MS");

  h.alarm.acknowledge();
  assert.equal(h.alarm.playing(), false);
  assert.equal(h.alarm.stage(), "quiet");

  h.clock.t += SNOOZE_MS - 1000;
  h.alarm.tick();
  assert.equal(h.player.plays.length, 1, "OK silences it for 20 minutes");
  h.clock.t += 1000;
  h.alarm.tick();
  assert.equal(h.player.plays.length, 2, "still out of balance after the snooze: rings again");
  assert.equal(h.alarm.playing(), true);
});

test("reconcile preset: resolving the problem stops the loop", () => {
  const h = harness({ preset: "reconcile" });
  h.alarm.update("cimb:100");
  h.alarm.update("");
  assert.equal(h.alarm.playing(), false);
  assert.equal(h.alarm.stage(), "quiet");
});

test("reconcile preset: a refresh while loud resumes the loop", () => {
  const h = harness({ preset: "reconcile" });
  h.alarm.update("cimb:100");
  const player2 = fakePlayer();
  const fresh = createEscalatingAlarm(Object.assign({}, h.opts, { createAudio: player2.create, onStageChange: function () {} }));
  h.clock.t += 5000;
  fresh.update("cimb:100");
  assert.equal(player2.plays.length, 1, "out of balance means ringing, refresh or not");
  assert.equal(player2.plays[0].loop, true);
});

test("reconcile preset: acknowledged in another tab, this tab stops on its next tick", () => {
  const h = harness({ preset: "reconcile" });
  h.alarm.update("cimb:100");
  const other = createEscalatingAlarm(Object.assign({}, h.opts, { createAudio: fakePlayer().create, onStageChange: function () {} }));
  other.update("cimb:100");
  other.acknowledge();
  h.clock.t += 15 * 1000;
  h.alarm.tick();
  assert.equal(h.alarm.playing(), false);
  assert.equal(h.alarm.stage(), "quiet");
});

test("corrupt stored state is treated as a fresh problem, not a crash", () => {
  const h = harness();
  h.storage.setItem("test-alarm:co1", "{not json");
  h.alarm.update("pending");
  assert.equal(h.player.plays.length, 0);
  h.clock.t += FIRST_DELAY_MS;
  h.alarm.tick();
  assert.equal(h.player.plays.length, 1);
});
