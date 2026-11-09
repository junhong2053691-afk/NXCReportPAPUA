// Login page motion: money-flow streamlines radiating out of the NXC logo.
// Decorative only: the page is unauthenticated, nothing here is real data.
//
// What it shows is the system's own rhythm:
//   - streamlines leave the logo and curl outward: the companies' flows
//     fanning out of one back office
//   - every SYNC_MS (the fast lane's ~6 s cycle) a pulse ring leaves the logo
//     and kicks the streams it crosses, so they flare and speed up
//   - a few streams carry a ledger tag (DEPOSIT / WITHDRAW / BANK TRF ...,
//     amount masked): deposits spiral in and are absorbed at the logo,
//     withdrawals spiral out
// Input: the mouse parts and swirls the streams around it and a click fires a
// shock ring; on a phone a finger does the same through passive touch events
// (pointer events get cancelled as soon as the browser treats a drag as a
// scroll). The form never has its touches or scrolling intercepted.
(function () {
  "use strict";

  var root = document.documentElement;
  var canvas = document.getElementById("lg-bg");
  var logo = document.getElementById("lg-logo");
  var themeBtn = document.getElementById("lg-theme");

  // ---- theme toggle (works even if the canvas is unavailable)
  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("dash-theme", next); } catch (e) {}
    });
  }

  if (!canvas || !logo || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var SYNC_MS = 6000;
  var TAU = Math.PI * 2;
  var reduceQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  function reduced() { return !!(reduceQuery && reduceQuery.matches); }

  var col = { a: "#4fd0fa", b: "#cfe0ff", c: "#2f7bf0", pulse: "#5fd3fa", dark: true };
  function readColors() {
    var cs = getComputedStyle(root);
    function v(n, fb) { return (cs.getPropertyValue(n) || "").trim() || fb; }
    col.a = v("--lg-flow-a", col.a);
    col.b = v("--lg-flow-b", col.b);
    col.c = v("--lg-flow-c", col.c);
    col.pulse = v("--lg-pulse", col.pulse);
    col.pill = v("--lg-tag-bg", "rgba(5,13,31,.78)");
    col.ink2 = v("--lg-ink-2", "#9cb1d4");
    col.dark = root.getAttribute("data-theme") === "dark";
    FONT_FAMILY = (getComputedStyle(document.body).fontFamily || "").trim() || "system-ui, sans-serif";
    for (var i = 0; i < tags.length; i++) labelTag(tags[i]);
  }

  // ---- geometry
  var W = 0, H = 0, DPR = 1;
  var C = { x: 0, y: 0, r: 0 };
  var quiet = []; // rects the streams stay out of: the form, the brand text, the tools, the footer
  var quietEls = [".lg-form", ".lg-name", ".lg-title", ".lg-tools", ".lg-foot"].map(function (s) { return document.querySelector(s); });
  function measure() {
    var r = logo.getBoundingClientRect();
    C.x = r.left + r.width / 2;
    C.y = r.top + r.height / 2;
    C.r = r.width / 2;
    quiet = [];
    for (var i = 0; i < quietEls.length; i++) {
      if (!quietEls[i]) continue;
      var q = quietEls[i].getBoundingClientRect(), pad = i === 0 ? 18 : 6;
      quiet.push({ l: q.left - pad, t: q.top - pad, r: q.right + pad, b: q.bottom + pad });
    }
  }
  function isQuiet(x, y) {
    for (var i = 0; i < quiet.length; i++) {
      var q = quiet[i];
      if (x > q.l && x < q.r && y > q.t && y < q.b) return true;
    }
    return false;
  }

  // ---- state
  var particles = [], pulses = [];
  var pointer = { x: 0, y: 0, strength: 0, target: 0 };
  var clock = 0, lastSync = -1;

  // Outward drift with a slow curl, so the lines read as streams fanning out
  // of the logo rather than straight spokes or noise.
  function fieldAngle(x, y, t) {
    var dx = x - C.x, dy = y - C.y;
    var base = Math.atan2(dy, dx);
    var d = Math.sqrt(dx * dx + dy * dy);
    return base + 0.38
      + Math.sin(d * 0.0045 - t * 0.0004 + base * 2) * 0.62
      + Math.cos(d * 0.0019 + t * 0.00016 + base * 3) * 0.3;
  }

  // Each stream keeps its last TRAIL positions and the whole frame is redrawn
  // from them. Fading old pixels with destination-out instead leaves residue
  // that never reaches zero alpha: a permanent grey web over the page.
  var TRAIL = 34;
  function remember(p) {
    p.tx[p.head] = p.x;
    p.ty[p.head] = p.y;
    p.head = (p.head + 1) % TRAIL;
    if (p.n < TRAIL) p.n++;
  }

  function spawn(p, anywhere) {
    var a = Math.random() * TAU;
    var far = Math.hypot(Math.max(C.x, W - C.x), Math.max(C.y, H - C.y));
    var r0 = C.r * 1.12 + Math.random() * C.r * 0.35;
    var r = anywhere ? r0 + Math.random() * (far - r0) : r0;
    p.x = C.x + Math.cos(a) * r;
    p.y = C.y + Math.sin(a) * r;
    if (!p.tx) { p.tx = new Float32Array(TRAIL); p.ty = new Float32Array(TRAIL); }
    p.n = 0; p.head = 0;
    remember(p);
    p.vx = 0; p.vy = 0;
    p.speed = 0.6 + Math.random() * 0.9;
    p.life = 500 + Math.random() * 900;
    var k = Math.random();
    p.kind = k < 0.5 ? 0 : k < 0.78 ? 1 : 2; // logo cyan, pale, brand blue
    p.hot = 0;
  }

  // ---- ledger tags: some streams carry a bank-ledger entry
  // Deposits ride the spiral inward and are absorbed at the logo; withdrawals
  // ride it out. Statuses are the ledger's own vocabulary; amounts are always
  // masked: the page is unauthenticated and must not show or invent numbers.
  var IN_STATUS = ["DEPOSIT", "CASH IN", "BANK TRANSFER", "DEPOSIT"];
  var OUT_STATUS = ["WITHDRAW", "CASH OUT", "BANK TRF", "WITHDRAW"];
  var tags = [], absorbs = [];
  var FONT_FAMILY = "system-ui, sans-serif";
  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
  function masked() {
    var n = Math.random();
    return n < 0.45 ? "•••.••" : n < 0.9 ? "•,•••.••" : "••,•••.••";
  }
  function labelTag(t) {
    if (!t.status) {
      t.status = pick(t.inbound ? IN_STATUS : OUT_STATUS);
      t.amount = (t.inbound ? "+$" : "−$") + masked();
    }
    ctx.font = "600 10px " + FONT_FAMILY;
    t.w1 = ctx.measureText(t.status).width;
    ctx.font = "700 11px " + FONT_FAMILY;
    t.w2 = ctx.measureText(t.amount).width;
  }
  function tagCount() { return W < 720 ? 6 : 12; }
  function spawnTag(t, anywhere) {
    t.inbound = Math.random() < 0.6;
    var far = Math.hypot(Math.max(C.x, W - C.x), Math.max(C.y, H - C.y));
    // born somewhere visible: a tag that starts under the form is a wasted tag
    for (var tries = 0; tries < 10; tries++) {
      var a = Math.random() * TAU, r;
      if (t.inbound) {
        // enter from somewhere on screen near the edges, then spiral in
        r = anywhere ? C.r * 2.2 + Math.random() * (far - C.r * 2.2) : far * (0.55 + Math.random() * 0.45);
      } else {
        r = anywhere ? C.r * 1.4 + Math.random() * (far - C.r * 1.4) : C.r * 1.3;
      }
      t.x = Math.max(16, Math.min(W - 16, C.x + Math.cos(a) * r));
      t.y = Math.max(16, Math.min(H - 16, C.y + Math.sin(a) * r));
      if (!isQuiet(t.x, t.y)) break;
    }
    if (!t.tx) { t.tx = new Float32Array(TRAIL); t.ty = new Float32Array(TRAIL); }
    t.n = 0; t.head = 0;
    remember(t);
    t.vx = 0; t.vy = 0;
    t.speed = 0.8 + Math.random() * 0.45;
    t.age = 0;
    t.life = 900 + Math.random() * 700;
    t.hot = 0;
    t.status = ""; // new direction, new entry
    labelTag(t);
  }
  function stepTags(dt, mx, my, ms) {
    var want = tagCount();
    while (tags.length < want) { var nt = {}; spawnTag(nt, true); tags.push(nt); }
    if (tags.length > want) tags.length = want;
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i];
      var dcx = t.x - C.x, dcy = t.y - C.y, dc = Math.sqrt(dcx * dcx + dcy * dcy);
      var a = fieldAngle(t.x, t.y, clock) + (t.inbound ? Math.PI : 0);
      t.vx += (Math.cos(a) * t.speed - t.vx) * 0.05 * dt;
      t.vy += (Math.sin(a) * t.speed - t.vy) * 0.05 * dt;
      if (ms > 0.01) {
        var dx = t.x - mx, dy = t.y - my, d = Math.sqrt(dx * dx + dy * dy);
        if (d < 130 && d > 0.1) {
          var f = 1 - d / 130; f = f * f * ms;
          t.vx += (dx / d) * 1.2 * f * dt;
          t.vy += (dy / d) * 1.2 * f * dt;
          t.hot = Math.max(t.hot, f * 1.6);
        }
      }
      for (var j = 0; j < pulses.length; j++) {
        var q = pulses[j], qx = t.x - q.x, qy = t.y - q.y, qd = Math.sqrt(qx * qx + qy * qy) || 1;
        if (Math.abs(qd - q.r) < 34) t.hot = Math.max(t.hot, q.life);
      }
      t.x += t.vx * dt;
      t.y += t.vy * dt;
      t.hot *= Math.pow(0.95, dt);
      t.age += dt;
      remember(t);
      var gone = t.x < -60 || t.x > W + 60 || t.y < -40 || t.y > H + 40 || t.age > t.life;
      if (t.inbound && dc < C.r * 1.2) {
        absorbs.push({ x: t.x, y: t.y, life: 1 });
        gone = true;
      }
      if (gone) spawnTag(t, false);
    }
    for (var k = absorbs.length - 1; k >= 0; k--) {
      absorbs[k].life -= 0.03 * dt;
      if (absorbs[k].life <= 0) absorbs.splice(k, 1);
    }
  }
  function boxQuiet(l, t, r, b) {
    for (var i = 0; i < quiet.length; i++) {
      var q = quiet[i];
      if (l < q.r && r > q.l && t < q.b && b > q.t) return true;
    }
    return false;
  }
  var drawnBoxes = [];
  function drawTag(t, alpha, pillAlpha) {
    var cIn = t.inbound ? col.a : col.b;
    var x = t.x, y = t.y;
    var padX = 8, gap = 6, h = 20;
    var w = padX * 2 + t.w1 + gap + t.w2;
    var l = x + 7, top = y - h / 2;
    if (l + w > W - 6) l = x - 7 - w; // near the right edge the label hangs left of its dot
    var bl = Math.min(l, x - 3), br = Math.max(l + w, x + 3);
    if (boxQuiet(bl, top, br, top + h)) return;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = cIn;
    ctx.beginPath(); ctx.arc(x, y, 2.2, 0, TAU); ctx.fill();
    // the plate folds away near the logo and never stacks on another plate
    if (pillAlpha < 0.02) return;
    for (var i = 0; i < drawnBoxes.length; i++) {
      var d = drawnBoxes[i];
      if (bl < d.r && br > d.l && top < d.b && top + h > d.t) return;
    }
    drawnBoxes.push({ l: bl - 4, t: top - 4, r: br + 4, b: top + h + 4 });
    alpha *= pillAlpha;
    ctx.fillStyle = col.pill;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(l, top, w, h, 6); else ctx.rect(l, top, w, h);
    ctx.fill();
    ctx.strokeStyle = cIn;
    ctx.globalAlpha = alpha * 0.55;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.textAlign = "left";
    ctx.fillStyle = col.ink2;
    ctx.font = "600 10px " + FONT_FAMILY;
    ctx.fillText(t.status, l + padX, y);
    ctx.fillStyle = cIn;
    ctx.font = "700 11px " + FONT_FAMILY;
    ctx.fillText(t.amount, l + padX + t.w1 + gap, y);
  }
  function drawTags() {
    ctx.textBaseline = "middle";
    ctx.lineCap = "round";
    drawnBoxes.length = 0;
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i], n = t.n;
      var fadeIn = Math.min(1, t.age / 40);
      var dc = Math.hypot(t.x - C.x, t.y - C.y);
      var near = t.inbound ? Math.min(1, Math.max(0, (dc - C.r * 1.2) / (C.r * 0.9))) : 1;
      var plate = Math.min(1, Math.max(0, (dc - C.r * 2.3) / (C.r * 0.8)));
      var a = fadeIn * near * Math.min(1, (col.dark ? 0.62 : 0.72) + t.hot * 0.5);
      if (a < 0.02) continue;
      // the stream the tag rides on
      if (n > 1) {
        var oldest = (t.head - n + TRAIL) % TRAIL, pen = false;
        ctx.beginPath();
        for (var s = 0; s < n; s++) {
          var ix = (oldest + s) % TRAIL, x = t.tx[ix], y = t.ty[ix];
          if (isQuiet(x, y)) { pen = false; continue; }
          if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
        }
        ctx.strokeStyle = t.inbound ? col.a : col.b;
        ctx.globalAlpha = a * 0.55;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
      drawTag(t, a, plate);
    }
    ctx.strokeStyle = col.a;
    ctx.lineWidth = 1.4;
    for (var k = 0; k < absorbs.length; k++) {
      var ab = absorbs[k];
      ctx.globalAlpha = ab.life * 0.7;
      ctx.beginPath(); ctx.arc(ab.x, ab.y, (1 - ab.life) * 14 + 2, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    measure();
    var want = Math.max(160, Math.min(720, Math.round((W * H) / 1700)));
    if (particles.length > want) particles.length = want;
    while (particles.length < want) particles.push({});
    for (var i = 0; i < particles.length; i++) spawn(particles[i], true);
    tags.length = 0;
    absorbs.length = 0;
    ctx.clearRect(0, 0, W, H);
    if (reduced()) drawStatic();
  }

  // ---- input
  function offLimits(el) { return el && el.closest && el.closest(".lg-form, .lg-tools, .lg-captcha-overlay, a, button, input, label"); }
  function aim(x, y, s) { pointer.x = x; pointer.y = y; pointer.target = s; }
  function shock(x, y, strong) {
    pulses.push({ x: x, y: y, r: strong ? 0 : C.r * 1.1, v: strong ? 0.42 : 0.5, life: 1, sync: !strong });
    if (pulses.length > 6) pulses.shift();
  }

  document.addEventListener("pointermove", function (e) {
    if (e.pointerType === "touch") return;
    aim(e.clientX, e.clientY, 1);
  }, { passive: true });
  document.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "touch" || reduced() || offLimits(e.target)) return;
    shock(e.clientX, e.clientY, true);
  }, { passive: true });
  root.addEventListener("pointerleave", function () { pointer.target = 0; });
  window.addEventListener("blur", function () { pointer.target = 0; });

  document.addEventListener("touchstart", function (e) {
    var t = e.touches[0];
    if (!t || offLimits(e.target)) return;
    aim(t.clientX, t.clientY, 1.15);
    if (!reduced()) shock(t.clientX, t.clientY, true);
  }, { passive: true });
  document.addEventListener("touchmove", function (e) {
    var t = e.touches[0];
    if (t && pointer.target > 0) aim(t.clientX, t.clientY, 1.15);
  }, { passive: true });
  function release() { pointer.target = 0; }
  document.addEventListener("touchend", release, { passive: true });
  document.addEventListener("touchcancel", release, { passive: true });

  // ---- simulation (dt in 60 fps frames; real-time based so a throttled tab never stalls)
  function sync(now) {
    var turn = Math.floor(now / SYNC_MS);
    if (turn === lastSync) return;
    var first = lastSync < 0;
    lastSync = turn;
    if (first) return;
    shock(C.x, C.y, false);
    logo.classList.remove("is-sync");
    void logo.offsetWidth; // restart the CSS ring
    logo.classList.add("is-sync");
  }

  function step(dt, now) {
    sync(now);
    pointer.strength += (pointer.target - pointer.strength) * Math.min(1, 0.08 * dt);
    var R = W < 720 ? 110 : 150, R2 = R * R;
    var mx = pointer.x, my = pointer.y, ms = pointer.strength;

    for (var k = pulses.length - 1; k >= 0; k--) {
      var pl = pulses[k];
      pl.r += pl.v * 16.667 * dt;
      pl.life -= (pl.sync ? 0.0075 : 0.014) * dt;
      if (pl.life <= 0) pulses.splice(k, 1);
    }

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      var dcx = p.x - C.x, dcy = p.y - C.y;
      var dc = Math.sqrt(dcx * dcx + dcy * dcy);
      var a = fieldAngle(p.x, p.y, clock);
      var sp = p.speed * (0.8 + Math.min(1.2, dc / 600));
      p.vx += (Math.cos(a) * sp - p.vx) * 0.06 * dt;
      p.vy += (Math.sin(a) * sp - p.vy) * 0.06 * dt;

      if (ms > 0.01) {
        var dx = p.x - mx, dy = p.y - my, d2 = dx * dx + dy * dy;
        if (d2 < R2 && d2 > 0.01) {
          var d = Math.sqrt(d2), f = 1 - d / R;
          f = f * f * ms;
          // part the stream and curl it around the pointer like water around a finger
          p.vx += ((dx / d) * 2.2 - (dy / d) * 1.2) * f * dt;
          p.vy += ((dy / d) * 2.2 + (dx / d) * 1.2) * f * dt;
          p.hot = Math.max(p.hot, f * 1.4);
        }
      }

      for (var j = 0; j < pulses.length; j++) {
        var q = pulses[j];
        var qx = p.x - q.x, qy = p.y - q.y, qd = Math.sqrt(qx * qx + qy * qy) || 1;
        var band = Math.abs(qd - q.r);
        if (band < 34) {
          var kick = (1 - band / 34) * q.life * (q.sync ? 1.6 : 3);
          p.vx += (qx / qd) * kick * dt;
          p.vy += (qy / qd) * kick * dt;
          p.hot = Math.max(p.hot, q.life);
        }
      }

      var vmax = 9, v = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (v > vmax) { p.vx *= vmax / v; p.vy *= vmax / v; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.hot *= Math.pow(0.94, dt);
      p.life -= dt;
      remember(p);
      if (p.x < -40 || p.x > W + 40 || p.y < -40 || p.y > H + 40 || p.life <= 0 || dc < C.r * 0.9) spawn(p, false);
    }
    stepTags(dt, mx, my, ms);
  }

  // ---- drawing
  var TAIL_ALPHA = [0.18, 0.5, 1]; // oldest third .. newest third of a trail
  function draw() {
    ctx.clearRect(0, 0, W, H);
    var base = col.dark ? 0.42 : 0.58; // blue on a pale ground reads weaker than on navy
    var palette = [col.a, col.b, col.c];
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // batch by colour x heat x trail third: 18 strokes per frame, not 500
    var paths = [];
    for (var b = 0; b < 18; b++) paths.push(null);
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i], n = p.n;
      if (n < 2) continue;
      var group = (p.kind * 2 + (p.hot > 0.25 ? 1 : 0)) * 3;
      var oldest = (p.head - n + TRAIL) % TRAIL;
      // one continuous polyline per trail third (thirds share their end point);
      // a point inside a quiet rect breaks the line instead of drawing into it
      for (var third = 0; third < 3; third++) {
        var s0 = Math.floor(((n - 1) * third) / 3), s1 = Math.floor(((n - 1) * (third + 1)) / 3);
        if (s1 <= s0) continue;
        var path = paths[group + third] || (paths[group + third] = new Path2D());
        var pen = false;
        for (var s = s0; s <= s1; s++) {
          var ix = (oldest + s) % TRAIL, x = p.tx[ix], y = p.ty[ix];
          if (isQuiet(x, y)) { pen = false; continue; }
          if (pen) path.lineTo(x, y); else { path.moveTo(x, y); pen = true; }
        }
      }
    }
    for (var k2 = 0; k2 < 18; k2++) {
      if (!paths[k2]) continue;
      var kind = Math.floor(k2 / 6), hot = Math.floor(k2 / 3) % 2, third = k2 % 3;
      ctx.strokeStyle = palette[kind];
      ctx.globalAlpha = (hot ? Math.min(1, base * 2.2) : base) * TAIL_ALPHA[third];
      ctx.lineWidth = hot ? 2 : (col.dark ? 1.2 : 1.35);
      ctx.stroke(paths[k2]);
    }
    drawTags();

    ctx.strokeStyle = col.pulse;
    ctx.lineWidth = 1.5;
    for (var k = 0; k < pulses.length; k++) {
      var q = pulses[k];
      ctx.globalAlpha = q.life * (q.sync ? 0.3 : 0.38) * (col.dark ? 1 : 0.8);
      ctx.beginPath();
      ctx.arc(q.x, q.y, Math.max(0, q.r), 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Reduced motion: one still frame of streamlines traced out of the logo,
  // no animation, no pointer reaction.
  function drawStatic() {
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = "round";
    ctx.lineWidth = 1.1;
    var palette = [col.a, col.b, col.c];
    var lines = Math.round(particles.length / 4);
    for (var i = 0; i < lines; i++) {
      var a0 = (i / lines) * TAU, r = C.r * 1.2 + (i % 5) * 26;
      var x = C.x + Math.cos(a0) * r, y = C.y + Math.sin(a0) * r;
      ctx.strokeStyle = palette[i % 3];
      ctx.globalAlpha = col.dark ? 0.3 : 0.36;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (var s = 0; s < 60; s++) {
        var a = fieldAngle(x, y, 0);
        x += Math.cos(a) * 5;
        y += Math.sin(a) * 5;
        if (isQuiet(x, y)) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // a handful of ledger tags parked on the still streams
    ctx.textBaseline = "middle";
    drawnBoxes.length = 0;
    var far = Math.min(W, H) * 0.42;
    for (var k = 0; k < 6; k++) {
      var ang = (k / 6) * TAU + 0.35, t = { inbound: k % 2 === 0 };
      t.x = C.x + Math.cos(ang) * Math.max(C.r * 2.2, far);
      t.y = C.y + Math.sin(ang) * Math.max(C.r * 2.2, far);
      if (t.x < 20 || t.x > W - 20 || t.y < 20 || t.y > H - 20) continue;
      labelTag(t);
      drawTag(t, col.dark ? 0.62 : 0.72, 1);
    }
    ctx.globalAlpha = 1;
  }

  // ---- loop
  var raf = 0, lastT = 0;
  function frame(now) {
    raf = 0;
    now = Math.max(now, performance.now());
    // ~60 fps is plenty for slow streams: skip extra frames on 120/144 Hz screens
    if (lastT && now - lastT < 15) { schedule(); return; }
    var ms = lastT ? Math.min(50, now - lastT) : 16.667;
    lastT = now;
    clock += ms;
    // every frame: an error line, the language switch or the keyboard moves
    // the form, and the streams must never cross it, not even for a second
    measure();
    step(ms / 16.667, now);
    draw();
    schedule();
  }
  // the captcha dialog blurs the page behind it: no point animating under it
  function covered() { return document.body.classList.contains("modal-open"); }
  function schedule() {
    if (raf || reduced() || document.hidden || covered()) return;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lastT = 0;
  }
  function restart() {
    stop();
    if (reduced()) drawStatic();
    else { ctx.clearRect(0, 0, W, H); schedule(); }
  }

  var resizeTimer = 0;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop();
    else schedule();
  });
  if (reduceQuery) {
    if (reduceQuery.addEventListener) reduceQuery.addEventListener("change", restart);
    else if (reduceQuery.addListener) reduceQuery.addListener(restart);
  }
  if (window.MutationObserver) {
    new MutationObserver(function () { readColors(); if (reduced()) drawStatic(); })
      .observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    new MutationObserver(function () { if (covered()) stop(); else schedule(); })
      .observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }
  // The logo image decides the pulse origin; re-measure once it has a size.
  var logoImg = logo.querySelector("img");
  if (logoImg && !logoImg.complete) logoImg.addEventListener("load", resize);

  readColors();
  resize();
  schedule();
})();
