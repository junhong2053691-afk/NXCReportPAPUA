// Login page background: "money flow" streamlines that the pointer can push
// around. Pure decoration -- the page is unauthenticated, so nothing here may
// ever show real data. External file because the CSP is script-src 'self'.
//
// Input model:
//   mouse/pen  -> pointer events: hover bends the flow, click fires a pulse
//   touch      -> touch events (passive), because pointer events get cancelled
//                 the moment the browser decides a drag is a scroll
//   idle       -> a slow "ghost" pointer wanders so phones (no hover) still
//                 show that the background is alive and touchable
(function () {
  "use strict";

  var canvas = document.getElementById("login-flow");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var root = document.documentElement;
  var card = document.querySelector(".login-box");
  var reduceQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

  var W = 0, H = 0, DPR = 1;
  var particles = [];
  var pulses = [];
  var colors = { primary: "#1768e5", cyan: "#067a8b", green: "#0b7a55", dark: false };
  var raf = 0, lastT = 0, clock = 0;

  // Pointer influence. `strength` eases toward `target` so releasing a finger
  // lets the flow heal instead of snapping back.
  var pointer = { x: 0, y: 0, strength: 0, target: 0, lastInput: -1e9 };
  var IDLE_AFTER_MS = 3500;

  function readColors() {
    var cs = getComputedStyle(root);
    function v(name, fallback) { return (cs.getPropertyValue(name) || "").trim() || fallback; }
    colors.primary = v("--primary", colors.primary);
    colors.cyan = v("--cyan", colors.cyan);
    colors.green = v("--green", colors.green);
    colors.dark = root.getAttribute("data-theme") === "dark";
  }

  function reduced() { return !!(reduceQuery && reduceQuery.matches); }
  function isSmall() { return W < 720; }
  function radius() { return isSmall() ? 120 : 160; }

  // Rightward drift with slow, layered undulation -- reads as ledgers streaming
  // across the screen rather than random noise.
  function fieldAngle(x, y, t) {
    return Math.sin(y * 0.0042 + t * 0.00023) * 0.55
      + Math.cos(x * 0.0031 - t * 0.00017) * 0.35
      + Math.sin((x + y) * 0.0017 + t * 0.00011) * 0.25;
  }

  function spawn(p, anywhere) {
    p.x = anywhere ? Math.random() * W : -10 - Math.random() * 60;
    p.y = Math.random() * H;
    p.px = p.x;
    p.py = p.y;
    p.vx = 0;
    p.vy = 0;
    p.speed = 0.55 + Math.random() * 0.9;
    p.life = 400 + Math.random() * 700;
    var r = Math.random();
    p.kind = r < 0.08 ? 2 : r < 0.24 ? 1 : 0; // green "deposit" glints, cyan, brand blue
    p.hot = 0;
  }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    var want = Math.max(200, Math.min(620, Math.round((W * H) / 2000)));
    if (particles.length > want) particles.length = want;
    while (particles.length < want) {
      var p = {};
      spawn(p, true);
      particles.push(p);
    }
    for (var i = 0; i < particles.length; i++) {
      var q = particles[i];
      if (q.x > W || q.y > H) spawn(q, true);
    }
    ctx.clearRect(0, 0, W, H);
    if (reduced()) drawStatic();
  }

  // ---- input

  function notePointer(x, y, strength) {
    pointer.x = x;
    pointer.y = y;
    pointer.target = strength;
    pointer.lastInput = performance.now();
  }

  function pulse(x, y) {
    pulses.push({ x: x, y: y, r: 0, life: 1 });
    if (pulses.length > 6) pulses.shift();
  }

  function moveSpotlight(x, y) {
    if (!card) return;
    var rect = card.getBoundingClientRect();
    card.style.setProperty("--spot-x", (x - rect.left) + "px");
    card.style.setProperty("--spot-y", (y - rect.top) + "px");
    var near = x > rect.left - 120 && x < rect.right + 120 && y > rect.top - 120 && y < rect.bottom + 120;
    card.style.setProperty("--spot-o", near ? "1" : "0");
  }

  document.addEventListener("pointermove", function (e) {
    if (e.pointerType === "touch") return;
    notePointer(e.clientX, e.clientY, 1);
    moveSpotlight(e.clientX, e.clientY);
  }, { passive: true });

  document.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "touch" || reduced()) return;
    pulse(e.clientX, e.clientY);
  }, { passive: true });

  document.documentElement.addEventListener("pointerleave", function () {
    pointer.target = 0;
    if (card) card.style.setProperty("--spot-o", "0");
  });
  window.addEventListener("blur", function () { pointer.target = 0; });

  document.addEventListener("touchstart", function (e) {
    var t = e.touches[0];
    if (!t) return;
    notePointer(t.clientX, t.clientY, 1.15);
    if (!reduced()) pulse(t.clientX, t.clientY);
  }, { passive: true });

  document.addEventListener("touchmove", function (e) {
    var t = e.touches[0];
    if (t) notePointer(t.clientX, t.clientY, 1.15);
  }, { passive: true });

  function release() { pointer.target = 0; pointer.lastInput = performance.now(); }
  document.addEventListener("touchend", release, { passive: true });
  document.addEventListener("touchcancel", release, { passive: true });

  // ---- simulation

  function ghost(now) {
    // Lissajous wander through the open area; weaker than a real pointer.
    var t = now * 0.00018;
    pointer.x = W * (0.5 + 0.36 * Math.sin(t * 1.3));
    pointer.y = H * (0.5 + 0.3 * Math.sin(t * 2.1 + 1.2));
    pointer.target = 0.45;
  }

  function step(dt, now) {
    if (now - pointer.lastInput > IDLE_AFTER_MS) ghost(now);
    pointer.strength += (pointer.target - pointer.strength) * Math.min(1, 0.08 * dt);

    var R = radius();
    var R2 = R * R;
    var mx = pointer.x, my = pointer.y, ms = pointer.strength;

    for (var k = pulses.length - 1; k >= 0; k--) {
      var pl = pulses[k];
      pl.r += 7 * dt;
      pl.life -= 0.016 * dt;
      if (pl.life <= 0) pulses.splice(k, 1);
    }

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.px = p.x;
      p.py = p.y;

      var a = fieldAngle(p.x, p.y, clock);
      var fx = Math.cos(a) * p.speed * 1.6;
      var fy = Math.sin(a) * p.speed * 0.9;
      p.vx += (fx - p.vx) * 0.06 * dt;
      p.vy += (fy - p.vy) * 0.06 * dt;

      if (ms > 0.01) {
        var dx = p.x - mx, dy = p.y - my;
        var d2 = dx * dx + dy * dy;
        if (d2 < R2 && d2 > 0.01) {
          var d = Math.sqrt(d2);
          var f = (1 - d / R);
          f = f * f * ms;
          // Push outward plus a swirl, so the stream parts and curls around
          // the cursor like water around a finger.
          p.vx += ((dx / d) * 2.4 - (dy / d) * 1.3) * f * dt;
          p.vy += ((dy / d) * 2.4 + (dx / d) * 1.3) * f * dt;
          p.hot = Math.max(p.hot, f * 1.4);
        }
      }

      for (var j = 0; j < pulses.length; j++) {
        var q = pulses[j];
        var qx = p.x - q.x, qy = p.y - q.y;
        var qd = Math.sqrt(qx * qx + qy * qy) || 1;
        var band = Math.abs(qd - q.r);
        if (band < 36) {
          var kick = (1 - band / 36) * q.life * 3.2;
          p.vx += (qx / qd) * kick * dt;
          p.vy += (qy / qd) * kick * dt;
          p.hot = Math.max(p.hot, q.life);
        }
      }

      var vmax = 9;
      var sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (sp > vmax) { p.vx *= vmax / sp; p.vy *= vmax / sp; }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.hot *= Math.pow(0.94, dt);
      p.life -= dt;

      if (p.x > W + 20 || p.y < -40 || p.y > H + 40 || p.x < -120 || p.life <= 0) {
        spawn(p, p.life <= 0);
      }
    }
  }

  // ---- drawing

  function draw() {
    // Fade old pixels toward transparent (not toward a colour), so the body's
    // own gradient keeps showing through the trails in both themes.
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(0,0,0," + (colors.dark ? 0.085 : 0.07) + ")";
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";

    // Light theme needs more ink: blue on #edf2f7 reads far weaker than on #10151c.
    var base = colors.dark ? 0.42 : 0.55;
    var palette = [colors.primary, colors.cyan, colors.green];
    ctx.lineCap = "round";

    // Batch by colour x heat so there are 6 strokes per frame, not 600.
    for (var kind = 0; kind < 3; kind++) {
      for (var hot = 0; hot < 2; hot++) {
        ctx.beginPath();
        var any = false;
        for (var i = 0; i < particles.length; i++) {
          var p = particles[i];
          if (p.kind !== kind || (p.hot > 0.25 ? 1 : 0) !== hot) continue;
          ctx.moveTo(p.px, p.py);
          ctx.lineTo(p.x, p.y);
          any = true;
        }
        if (!any) continue;
        ctx.strokeStyle = palette[kind];
        ctx.globalAlpha = hot ? Math.min(1, base * 2.2) : base;
        ctx.lineWidth = hot ? 2 : (colors.dark ? 1.25 : 1.4);
        ctx.stroke();
      }
    }

    for (var k = 0; k < pulses.length; k++) {
      var q = pulses[k];
      ctx.beginPath();
      ctx.arc(q.x, q.y, q.r, 0, Math.PI * 2);
      ctx.strokeStyle = colors.primary;
      ctx.globalAlpha = q.life * (colors.dark ? 0.35 : 0.25);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Reduced motion: one still frame of traced streamlines, no animation, no
  // pointer reaction.
  function drawStatic() {
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = "round";
    ctx.lineWidth = 1.1;
    var lines = Math.round(particles.length / 5);
    var palette = [colors.primary, colors.cyan, colors.green];
    for (var i = 0; i < lines; i++) {
      var x = Math.random() * W, y = Math.random() * H;
      var r = Math.random();
      ctx.strokeStyle = palette[r < 0.08 ? 2 : r < 0.24 ? 1 : 0];
      ctx.globalAlpha = colors.dark ? 0.3 : 0.35;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (var s = 0; s < 46; s++) {
        var a = fieldAngle(x, y, 0);
        x += Math.cos(a) * 4.2;
        y += Math.sin(a) * 2.4;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    raf = 0;
    var dt = lastT ? Math.min(50, now - lastT) / 16.667 : 1;
    lastT = now;
    clock += dt * 16.667;
    step(dt, now);
    draw();
    schedule();
  }

  function schedule() {
    if (raf || reduced() || document.hidden) return;
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
    var onReduce = function () { restart(); };
    if (reduceQuery.addEventListener) reduceQuery.addEventListener("change", onReduce);
    else if (reduceQuery.addListener) reduceQuery.addListener(onReduce);
  }

  if (window.MutationObserver) {
    new MutationObserver(function () {
      readColors();
      if (reduced()) drawStatic();
    }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  }

  readColors();
  resize();
  schedule();
})();
