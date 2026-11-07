// Login page motion: the sync dial and the money moving around it.
// Decorative only: the page is unauthenticated, nothing here is real data.
//
// What it shows is the system's own rhythm:
//   - the sweep turns once every SYNC_MS, the fast lane's ~6 s sync cycle;
//     each full turn is a "sync" (a pulse ring + the four company nodes blink)
//   - cyan points flowing in from the edges are deposits, pale points flowing
//     out are withdrawals
// Input: mouse tilts the dial, a click outside the form forces a sync; on a
// phone a finger drag spins the dial ring and a tap forces a sync. The form
// itself never has its touches or scrolling intercepted.
(function () {
  "use strict";

  var root = document.documentElement;
  var dial = document.getElementById("lg-dial");
  var dialCanvas = document.getElementById("lg-dial-canvas");
  var bg = document.getElementById("lg-bg");
  var wordmark = document.getElementById("lg-wordmark");
  var themeBtn = document.getElementById("lg-theme");

  // ---- theme toggle (works even if the canvases are unavailable)
  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("dash-theme", next); } catch (e) {}
    });
  }

  if (!dial || !dialCanvas || !bg || !dialCanvas.getContext || !bg.getContext) return;
  var dctx = dialCanvas.getContext("2d");
  var bctx = bg.getContext("2d");
  if (!dctx || !bctx) return;

  var SYNC_MS = 6000;
  var TAU = Math.PI * 2;
  var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  if (reduce && wordmark && wordmark.pauseAnimations) wordmark.pauseAnimations();

  var col = {};
  function readColors() {
    var cs = getComputedStyle(root);
    function v(n, fb) { return (cs.getPropertyValue(n) || "").trim() || fb; }
    col.ink = v("--lg-dial-ink", "rgba(170,205,255,.3)");
    col.hot = v("--lg-dial-hot", "#5fd3fa");
    col.in = v("--lg-in", "#4fd0fa");
    col.out = v("--lg-out", "#cfe0ff");
    col.dust = v("--lg-dust", "rgba(190,215,255,.3)");
  }

  // ---- geometry
  var W = 0, H = 0, DPR = 1, S = 0;
  var center = { x: 0, y: 0, r: 0, rIn: 0 };
  var formEl = document.querySelector(".lg-form");
  var formBox = { l: 0, t: 0, r: 0, b: 0 };
  // Points crossing the form fade out: the form is the task, the motion is not.
  function overForm(x, y) {
    return x > formBox.l && x < formBox.r && y > formBox.t && y < formBox.b;
  }
  function measure() {
    if (formEl) {
      var fr = formEl.getBoundingClientRect();
      formBox = { l: fr.left - 24, t: fr.top - 24, r: fr.right + 24, b: fr.bottom + 24 };
    }
    var r = dial.getBoundingClientRect();
    S = dial.offsetWidth; // layout size: the bounding box grows with the 3D tilt
    center.x = r.left + r.width / 2;
    center.y = r.top + r.height / 2;
    center.r = S * 0.47;
    center.rIn = center.r * 0.66;
  }
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    bg.width = Math.round(W * DPR); bg.height = Math.round(H * DPR);
    bctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    measure();
    dialCanvas.width = Math.round(S * DPR); dialCanvas.height = Math.round(S * DPR);
    dctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    seedDust();
  }

  // ---- state
  var particles = [], pulses = [], absorbs = [], dust = [];
  var nodeFlash = 0, tickFlash = 0, lastSync = -1;
  var spin = 0, spinV = 0;
  var tilt = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 };
  var ptr = { x: -9999, y: -9999, on: false };
  var lastInput = -1e9;

  function seedDust() {
    dust = [];
    var n = Math.round((W * H) / 14000);
    for (var i = 0; i < n; i++) dust.push({ x: Math.random() * W, y: Math.random() * H, ph: Math.random() * TAU, r: 0.6 + Math.random() * 1.1 });
  }

  function edgePoint() {
    var side = Math.floor(Math.random() * 4), m = 20;
    if (side === 0) return { x: Math.random() * W, y: -m };
    if (side === 1) return { x: W + m, y: Math.random() * H };
    if (side === 2) return { x: Math.random() * W, y: H + m };
    return { x: -m, y: Math.random() * H };
  }
  function spawn(kind, from) {
    var a, b;
    if (kind === "in") {
      a = from || edgePoint();
      var ang = Math.atan2(a.y - center.y, a.x - center.x);
      b = { x: center.x + Math.cos(ang) * center.rIn, y: center.y + Math.sin(ang) * center.rIn };
    } else {
      var ang2 = Math.random() * TAU;
      a = { x: center.x + Math.cos(ang2) * center.rIn, y: center.y + Math.sin(ang2) * center.rIn };
      var far = Math.max(W, H);
      var bend = ang2 + (Math.random() - 0.5) * 0.9;
      b = { x: center.x + Math.cos(bend) * far, y: center.y + Math.sin(bend) * far };
    }
    var dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy) || 1;
    var off = (Math.random() - 0.5) * 0.7 * dist;
    particles.push({
      kind: kind,
      a: a, b: b,
      c: { x: (a.x + b.x) / 2 - (dy / dist) * off, y: (a.y + b.y) / 2 + (dx / dist) * off },
      t: 0,
      dur: 3600 + Math.random() * 3200,
      trail: [],
    });
  }
  function targetCount() { return W < 700 ? 24 : 46; }

  function sync(strong) {
    pulses.push({ r: center.rIn, life: 1, strong: !!strong });
    if (pulses.length > 5) pulses.shift();
    nodeFlash = 1;
    if (strong) tickFlash = 1;
  }
  function manualSync() {
    sync(true);
    for (var i = 0; i < 8; i++) spawn("in");
    lastInput = performance.now();
  }

  // ---- input
  function offLimits(el) { return el && el.closest && el.closest(".lg-form, .lg-tools, a, button, input, label"); }
  function aim(x, y) {
    var nx = Math.max(-1, Math.min(1, (x - center.x) / (W / 2)));
    var ny = Math.max(-1, Math.min(1, (y - center.y) / (H / 2)));
    tilt.ty = nx * 10;
    tilt.tx = -ny * 10;
  }
  document.addEventListener("pointermove", function (e) {
    if (e.pointerType === "touch") return;
    ptr.x = e.clientX; ptr.y = e.clientY; ptr.on = true;
    aim(e.clientX, e.clientY);
    lastInput = performance.now();
  }, { passive: true });
  root.addEventListener("pointerleave", function () { ptr.on = false; tilt.tx = tilt.ty = 0; });
  document.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "touch" || offLimits(e.target) || reduce) return;
    manualSync();
  });

  var touch = null;
  document.addEventListener("touchstart", function (e) {
    var t = e.touches[0];
    if (!t || offLimits(e.target)) { touch = null; return; }
    touch = { x: t.clientX, y: t.clientY, lx: t.clientX, moved: 0, at: performance.now() };
    ptr.x = t.clientX; ptr.y = t.clientY; ptr.on = true;
    lastInput = performance.now();
  }, { passive: true });
  document.addEventListener("touchmove", function (e) {
    var t = e.touches[0];
    if (!t || !touch) return;
    var dx = t.clientX - touch.lx;
    touch.lx = t.clientX;
    touch.moved += Math.abs(dx) + Math.abs(t.clientY - touch.y) * 0.1;
    spinV = dx * 0.006;
    spin += spinV;
    ptr.x = t.clientX; ptr.y = t.clientY;
    aim(t.clientX, t.clientY);
    lastInput = performance.now();
  }, { passive: true });
  document.addEventListener("touchend", function () {
    if (touch && touch.moved < 8 && performance.now() - touch.at < 350 && !reduce) manualSync();
    touch = null;
    ptr.on = false;
    tilt.tx = tilt.ty = 0;
  }, { passive: true });

  // ---- simulation (real-time based, so throttled tabs never park mid-way)
  function bez(p, t) {
    var u = 1 - t;
    return { x: u * u * p.a.x + 2 * u * t * p.c.x + t * t * p.b.x, y: u * u * p.a.y + 2 * u * t * p.c.y + t * t * p.b.y };
  }
  function step(dt, now) {
    var turn = Math.floor(now / SYNC_MS);
    if (lastSync >= 0 && turn !== lastSync) sync(false);
    lastSync = turn;

    // idle: a slow sway so a phone with no hover still shows the dial is live
    if (now - lastInput > 4000 && !touch) {
      tilt.ty = Math.sin(now / 2600) * 5;
      tilt.tx = Math.cos(now / 3400) * 3;
    }
    var k = Math.min(1, dt / 16.67);
    tilt.vx += ((tilt.tx - tilt.x) * 0.1 - tilt.vx * 0.3) * k;
    tilt.vy += ((tilt.ty - tilt.y) * 0.1 - tilt.vy * 0.3) * k;
    tilt.x += tilt.vx * k; tilt.y += tilt.vy * k;
    if (!touch) { spin += spinV * k; spinV *= Math.pow(0.95, k); }
    dial.style.transform = "perspective(900px) rotateX(" + tilt.x.toFixed(2) + "deg) rotateY(" + tilt.y.toFixed(2) + "deg)";

    while (particles.length < targetCount()) spawn(Math.random() < 0.64 ? "in" : "out");
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.t += dt / p.dur;
      if (p.t >= 1) {
        if (p.kind === "in") absorbs.push({ x: p.b.x, y: p.b.y, life: 1 });
        particles.splice(i, 1);
        continue;
      }
      var e = p.kind === "in" ? p.t * p.t * (3 - 2 * p.t) : p.t;
      var pos = bez(p, e);
      if (ptr.on) {
        var dx = pos.x - ptr.x, dy = pos.y - ptr.y, d = Math.hypot(dx, dy);
        if (d < 120 && d > 0.1) {
          var f = (1 - d / 120); f = f * f * 28;
          pos.x += (dx / d) * f; pos.y += (dy / d) * f;
        }
      }
      p.trail.push(pos);
      if (p.trail.length > 9) p.trail.shift();
    }
    for (var j = pulses.length - 1; j >= 0; j--) {
      pulses[j].r += dt * (pulses[j].strong ? 0.42 : 0.3);
      pulses[j].life -= dt / (pulses[j].strong ? 1700 : 1400);
      if (pulses[j].life <= 0) pulses.splice(j, 1);
    }
    for (var q = absorbs.length - 1; q >= 0; q--) {
      absorbs[q].life -= dt / 500;
      if (absorbs[q].life <= 0) absorbs.splice(q, 1);
    }
    nodeFlash *= Math.pow(0.9, k);
    tickFlash *= Math.pow(0.93, k);
  }

  // ---- drawing
  function drawBg(now) {
    bctx.clearRect(0, 0, W, H);
    bctx.fillStyle = col.dust;
    for (var i = 0; i < dust.length; i++) {
      var d = dust[i];
      bctx.globalAlpha = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(now * 0.0007 + d.ph));
      bctx.fillRect(d.x, d.y, d.r, d.r);
    }
    bctx.lineCap = "round";
    for (var p = 0; p < particles.length; p++) {
      var pt = particles[p], tr = pt.trail, n = tr.length;
      if (n < 2) continue;
      var c = pt.kind === "in" ? col.in : col.out;
      var fade = pt.t < 0.12 ? pt.t / 0.12 : (pt.kind === "out" && pt.t > 0.7 ? (1 - pt.t) / 0.3 : 1);
      if (overForm(tr[n - 1].x, tr[n - 1].y)) fade *= 0.12;
      bctx.strokeStyle = c;
      bctx.lineWidth = pt.kind === "in" ? 1.6 : 1.2;
      for (var s = 1; s < n; s++) {
        bctx.globalAlpha = (s / n) * 0.55 * fade;
        bctx.beginPath(); bctx.moveTo(tr[s - 1].x, tr[s - 1].y); bctx.lineTo(tr[s].x, tr[s].y); bctx.stroke();
      }
      var h = tr[n - 1];
      bctx.fillStyle = c;
      if (pt.kind === "in") {
        bctx.globalAlpha = 0.16 * fade;
        bctx.beginPath(); bctx.arc(h.x, h.y, 5, 0, TAU); bctx.fill();
      }
      bctx.globalAlpha = 0.95 * fade;
      bctx.beginPath(); bctx.arc(h.x, h.y, pt.kind === "in" ? 1.9 : 1.5, 0, TAU); bctx.fill();
    }
    for (var a = 0; a < absorbs.length; a++) {
      var ab = absorbs[a];
      bctx.globalAlpha = ab.life * 0.5;
      bctx.strokeStyle = col.in; bctx.lineWidth = 1;
      bctx.beginPath(); bctx.arc(ab.x, ab.y, (1 - ab.life) * 9 + 1, 0, TAU); bctx.stroke();
    }
    for (var k = 0; k < pulses.length; k++) {
      var pl = pulses[k];
      bctx.globalAlpha = pl.life * (pl.strong ? 0.45 : 0.28);
      bctx.strokeStyle = col.hot; bctx.lineWidth = pl.strong ? 1.6 : 1.1;
      bctx.beginPath(); bctx.arc(center.x, center.y, pl.r, 0, TAU); bctx.stroke();
    }
    bctx.globalAlpha = 1;
  }

  function annulus(r0, r1, a0, a1) {
    dctx.beginPath();
    dctx.arc(S / 2, S / 2, r1, a0, a1);
    dctx.arc(S / 2, S / 2, r0, a1, a0, true);
    dctx.closePath();
  }
  function drawDial(now) {
    var c = S / 2, R = S * 0.47, rTick = R * 0.86, rIn = R * 0.66;
    var sweep = ((now % SYNC_MS) / SYNC_MS) * TAU;           // from 12 o'clock, clockwise
    var base = -Math.PI / 2 + spin;
    dctx.clearRect(0, 0, S, S);
    dctx.lineCap = "round";

    // rings
    dctx.strokeStyle = col.ink; dctx.lineWidth = 1; dctx.globalAlpha = 1;
    dctx.beginPath(); dctx.arc(c, c, R, 0, TAU); dctx.stroke();
    dctx.beginPath(); dctx.arc(c, c, rIn, 0, TAU); dctx.stroke();
    dctx.globalAlpha = 0.5;
    dctx.beginPath(); dctx.arc(c, c, rTick - R * 0.05, 0, TAU); dctx.stroke();

    // sweep trail: a soft wedge behind the hand
    if (!reduce) {
      dctx.fillStyle = col.hot;
      for (var k = 0; k < 26; k++) {
        var a1 = base + sweep - k * 0.035, a0 = a1 - 0.035;
        dctx.globalAlpha = 0.2 * Math.pow(1 - k / 26, 2);
        annulus(rIn, R, a0, a1); dctx.fill();
      }
      dctx.globalAlpha = 0.9; dctx.strokeStyle = col.hot; dctx.lineWidth = 1.5;
      dctx.beginPath();
      dctx.moveTo(c + Math.cos(base + sweep) * rIn, c + Math.sin(base + sweep) * rIn);
      dctx.lineTo(c + Math.cos(base + sweep) * R, c + Math.sin(base + sweep) * R);
      dctx.stroke();
    }

    // 60 ticks, every 5th long; lit after the hand passes, fading exponentially
    for (var i = 0; i < 60; i++) {
      var th = (i / 60) * TAU, ang = base + th;
      var behind = ((sweep - th) % TAU + TAU) % TAU;
      var glow = reduce ? 0 : Math.min(1, Math.exp(-behind / 0.85) + tickFlash);
      var long = i % 5 === 0;
      var r0 = long ? rTick - R * 0.07 : rTick, r1 = R - R * 0.02;
      var x0 = c + Math.cos(ang) * r0, y0 = c + Math.sin(ang) * r0;
      var x1 = c + Math.cos(ang) * r1, y1 = c + Math.sin(ang) * r1;
      dctx.lineWidth = long ? 1.6 : 1;
      dctx.globalAlpha = 1; dctx.strokeStyle = col.ink;
      dctx.beginPath(); dctx.moveTo(x0, y0); dctx.lineTo(x1, y1); dctx.stroke();
      if (glow > 0.02) {
        dctx.globalAlpha = glow; dctx.strokeStyle = col.hot;
        dctx.beginPath(); dctx.moveTo(x0, y0); dctx.lineTo(x1, y1); dctx.stroke();
      }
    }

    // four company nodes on the inner ring; they blink on every sync
    for (var n = 0; n < 4; n++) {
      var na = base + Math.PI / 4 + n * (Math.PI / 2);
      var nx = c + Math.cos(na) * rIn, ny = c + Math.sin(na) * rIn;
      if (nodeFlash > 0.02) {
        dctx.globalAlpha = nodeFlash * 0.3; dctx.fillStyle = col.hot;
        dctx.beginPath(); dctx.arc(nx, ny, 9, 0, TAU); dctx.fill();
      }
      dctx.globalAlpha = 0.55 + nodeFlash * 0.45; dctx.fillStyle = col.hot;
      dctx.beginPath(); dctx.arc(nx, ny, 3, 0, TAU); dctx.fill();
    }
    dctx.globalAlpha = 1;
  }

  // ---- loop
  var raf = 0, lastT = 0, measureAcc = 0;
  function frame(now) {
    raf = 0;
    var dt = lastT ? Math.min(50, now - lastT) : 16.67;
    lastT = now;
    measureAcc += dt;
    if (measureAcc > 1000) { measureAcc = 0; measure(); }
    step(dt, now);
    drawBg(now);
    drawDial(now);
    schedule();
  }
  function schedule() {
    if (raf || reduce || document.hidden) return;
    raf = requestAnimationFrame(frame);
  }
  function staticFrame() {
    drawBg(0);
    drawDial(0);
  }

  window.addEventListener("resize", function () { resize(); if (reduce) staticFrame(); });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; lastT = 0; }
    else schedule();
  });
  if (window.MutationObserver) {
    new MutationObserver(function () { readColors(); if (reduce) staticFrame(); })
      .observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  }

  readColors();
  resize();
  if (reduce) staticFrame();
  else schedule();
})();
