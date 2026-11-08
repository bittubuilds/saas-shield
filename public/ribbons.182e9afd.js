/* ---------------------------------------------------------------------------
   Interference Ribbons — vanilla canvas port

   Source component: React Bits Pro, "Interference Ribbons"
   (https://pro.reactbits.dev/docs/components/interference-ribbons).
   The Pro package is a React + Tailwind registry component and cannot be
   installed into this frontend: SaaS Shield has no React, no Tailwind and no
   components.json, and the registry needs REACTBITS_LICENSE_KEY. This file
   reproduces the same effect and the same props on plain canvas 2D so the visual
   is available without a React toolchain. See docs/REACTBITS.md.

   What it draws: a band of fine strands that drift, swing and twist over
   themselves. Where the ribbon turns edge-on the strands bunch, which reads as a
   bright knot; the far side thins and dims. Colour cycles across the band and
   creeps along it. Optional light pulses run along the strands.

   Deliberate differences from the Pro source, all noted in docs/REACTBITS.md:
     - backgroundColor defaults to transparent so the page surface shows through
     - colours blend in sRGB, not OKLab
     - no React children wrapper; mount() returns a handle instead
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var TAU = Math.PI * 2;

  var DEFAULTS = {
    colors: ['#7c5cff', '#d46bff'],
    backgroundColor: 'transparent',
    mode: 'auto',            // auto | glow | ink
    wires: 56,
    lineWidth: 1.4,
    ribbonWidth: 0.26,
    amplitude: 0.62,
    waveLength: 1,
    angle: 34,
    twist: 1.7,
    curl: 0.25,
    depth: 0.65,
    stripes: 2.2,
    colorFlow: 0.04,
    glow: 0.5,
    intensity: 1,
    speed: 0.7,
    spin: 0.35,
    interactive: true,
    hoverPulses: true,
    clickPulse: true,
    pulseSpeed: 1.1,
    pulseStrength: 1,
    hoverBoost: 1,
    paused: false,
    quality: 0.85,
    samples: 48
  };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function rgb(hex) {
    var h = String(hex).trim().replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (!isFinite(n)) return [124, 92, 255];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mix(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t)
    ];
  }

  function prefersReducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  // A canvas that silently stays empty is worse than no canvas, so callers get a
  // handle either way and the element is left untouched when 2D is unavailable.
  function mount(el, options) {
    if (!el || !el.appendChild) return { destroy: function () {}, pulse: function () {}, canvas: null };

    var opts = {};
    for (var k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) opts[k] = DEFAULTS[k];
    if (options) for (var j in options) if (Object.prototype.hasOwnProperty.call(options, j)) opts[j] = options[j];

    // Narrow screens get fewer strands: same look, a third of the segments.
    var narrow = (window.innerWidth || 1024) < 720;
    var wires = Math.round(clamp(narrow ? Math.min(opts.wires, 26) : opts.wires, 4, 120));
    var quality = clamp(opts.quality, 0.25, 1);
    var colorA = rgb(opts.colors[0]);
    var colorB = rgb(opts.colors[1]);
    var angleRad = (opts.angle * Math.PI) / 180;
    var runX = Math.cos(angleRad), runY = Math.sin(angleRad);
    var normX = -runY, normY = runX;
    var reduce = prefersReducedMotion();

    var canvas = document.createElement('canvas');
    canvas.className = 'ribbon-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    var ctx = null;
    try { ctx = canvas.getContext('2d', { alpha: true }); } catch (e) { ctx = null; }
    if (!ctx) return { destroy: function () {}, pulse: function () {}, canvas: null };

    var buffer = document.createElement('canvas');
    var bctx = null;
    try { bctx = buffer.getContext('2d', { alpha: true }); } catch (e) { bctx = null; }
    if (!bctx) return { destroy: function () {}, pulse: function () {}, canvas: null };

    var blurSupported = typeof ctx.filter === 'string';
    el.appendChild(canvas);

    var W = 0, H = 0, dpr = 1;
    var raf = 0, running = false, visible = true, t = 0, last = 0, hover = 0, targetHover = 0;
    var pulses = [];

    function resize() {
      var rect = el.getBoundingClientRect();
      var cssW = Math.max(1, Math.round(rect.width));
      var cssH = Math.max(1, Math.round(rect.height));
      dpr = Math.min(window.devicePixelRatio || 1, 2) * quality;
      W = cssW; H = cssH;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      buffer.width = canvas.width;
      buffer.height = canvas.height;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function pulse(fromS) {
      var at = typeof fromS === 'number' ? clamp(fromS, 0, 1) : 0.5;
      pulses.push({ s: at, born: t, dir: 1 });
      if (opts.clickPulse !== false) pulses.push({ s: at, born: t, dir: -1 });
      if (pulses.length > 24) pulses = pulses.slice(-24);
    }

    // Brightness contributed by travelling pulses at position s.
    function pulseAt(s) {
      if (!pulses.length) return 0;
      var sum = 0;
      for (var i = 0; i < pulses.length; i++) {
        var p = pulses[i];
        var front = p.s + (t - p.born) * 0.7 * opts.pulseSpeed * p.dir;
        var d = s - front;
        var falloff = Math.exp(-(d * d) / 0.0016);
        if (falloff > 0.004) sum += falloff * opts.pulseStrength;
      }
      return Math.min(sum, 3);
    }

    function render() {
      bctx.clearRect(0, 0, W, H);
      bctx.globalCompositeOperation = 'lighter';

      var time = opts.paused ? 0 : t;
      var swingT = time * 0.55;
      var spinT = time * opts.spin;
      var flowT = time * opts.colorFlow;
      var halfBand = (opts.ribbonWidth * H) / 2;
      var spanX = W * 1.3;
      var S = Math.max(12, Math.round(opts.samples));

      for (var w = 0; w < wires; w++) {
        var u = wires === 1 ? 0 : (w / (wires - 1)) * 2 - 1;
        var phase = ((u + 1) / 2) * opts.stripes + flowT;
        var stripe = 0.5 + 0.5 * Math.sin(phase * Math.PI);
        var base = mix(colorA, colorB, stripe);
        // One deep variant per neighbouring strand keeps the band from flattening.
        var deep = w % 3 === 0 ? 0.72 : 1;

        bctx.beginPath();
        var firstX = 0, firstY = 0;
        var lastFacing = 1;
        for (var i = 0; i <= S; i++) {
          var s = i / S;
          var swing = Math.sin(s * TAU * opts.waveLength + swingT) * 0.62
            + Math.sin(s * TAU * opts.waveLength * 2.3 - swingT * 0.7) * 0.28;
          var cx = (s - 0.5) * spanX;
          var cy = H * 0.5 + swing * opts.amplitude * H * 0.34;

          var th = s * TAU * opts.twist + spinT;
          var facing = Math.cos(th);
          var across = u * halfBand * facing;
          var curl = opts.curl * (u * u - 0.33) * halfBand * Math.sin(th);

          var x = cx + across * normX + curl * runX;
          var y = cy + across * normY + curl * runY;
          if (i === 0) { firstX = x; firstY = y; bctx.moveTo(x, y); } else bctx.lineTo(x, y);
          lastFacing = facing;
        }

        var facingAvg = Math.abs(lastFacing);
        var near = 1 - opts.depth * 0.5 * (1 - (facingAvg + 1) / 2);
        var alpha = clamp(opts.intensity, 0, 3) * (0.22 + 0.78 * (0.4 + 0.6 * facingAvg)) * near * deep;
        var width = opts.lineWidth * (0.4 + 0.6 * facingAvg) * near;
        bctx.strokeStyle = 'rgba(' + base[0] + ',' + base[1] + ',' + base[2] + ',' + clamp(alpha, 0, 1).toFixed(3) + ')';
        bctx.lineWidth = Math.max(0.35, width);
        bctx.stroke();

        // Pulse highlights: short bright arcs where a pulse front currently is.
        if (pulses.length && Math.abs(pulseAt(0.5)) > 0) {
          for (var seg = 0; seg < S; seg += 2) {
            var s0 = seg / S, s1 = (seg + 2) / S;
            var boost = pulseAt((s0 + s1) / 2);
            if (boost < 0.05) continue;
            var pth = ((s0 + s1) / 2) * TAU * opts.twist + spinT;
            var pface = Math.cos(pth);
            var pAcross = u * halfBand * pface;
            var pCurl = opts.curl * (u * u - 0.33) * halfBand * Math.sin(pth);
            var pSwingA = Math.sin(s0 * TAU * opts.waveLength + swingT) * 0.62 + Math.sin(s0 * TAU * opts.waveLength * 2.3 - swingT * 0.7) * 0.28;
            var pSwingB = Math.sin(s1 * TAU * opts.waveLength + swingT) * 0.62 + Math.sin(s1 * TAU * opts.waveLength * 2.3 - swingT * 0.7) * 0.28;
            bctx.beginPath();
            bctx.moveTo((s0 - 0.5) * spanX + pAcross * normX + pCurl * runX, H * 0.5 + pSwingA * opts.amplitude * H * 0.34 + pAcross * normY + pCurl * runY);
            bctx.lineTo((s1 - 0.5) * spanX + pAcross * normX + pCurl * runX, H * 0.5 + pSwingB * opts.amplitude * H * 0.34 + pAcross * normY + pCurl * runY);
            bctx.strokeStyle = 'rgba(255,255,255,' + clamp(boost * 0.5, 0, 0.85).toFixed(3) + ')';
            bctx.lineWidth = Math.max(0.5, opts.lineWidth * 0.9);
            bctx.stroke();
          }
        }
      }
      bctx.globalCompositeOperation = 'source-over';

      // Compose: haze pass then crisp pass, so glow costs one blur, not N shadows.
      ctx.clearRect(0, 0, W, H);
      if (opts.backgroundColor && opts.backgroundColor !== 'transparent') {
        ctx.fillStyle = opts.backgroundColor;
        ctx.fillRect(0, 0, W, H);
      }
      ctx.globalCompositeOperation = 'lighter';
      if (blurSupported && opts.glow > 0) {
        ctx.filter = 'blur(' + (1 + opts.glow * 7).toFixed(1) + 'px)';
        ctx.globalAlpha = clamp(0.35 + opts.glow * 0.35, 0, 1);
        ctx.drawImage(buffer, 0, 0, W, H);
        ctx.filter = 'none';
        ctx.globalAlpha = 1;
      }
      ctx.drawImage(buffer, 0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }

    function frame(now) {
      if (!running) return;
      var dt = last ? Math.min((now - last) / 1000, 0.1) : 0.016;
      last = now;
      hover += (targetHover - hover) * Math.min(1, dt * 6);
      t += dt * opts.speed * (1 + hover * 0.8 * opts.hoverBoost);
      render();
      raf = requestAnimationFrame(frame);
    }

    function start() {
      if (running || reduce) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    }

    function stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    var onPointerMove = function (e) {
      if (!opts.interactive) return;
      var rect = el.getBoundingClientRect();
      if (!rect.width) return;
      var x = (e.clientX - rect.left) / rect.width;
      targetHover = 1;
      if (opts.hoverPulses && x >= 0 && x <= 1 && Math.random() < 0.14) {
        pulses.push({ s: clamp(x, 0, 1), born: t, dir: Math.random() < 0.5 ? 1 : -1 });
        if (pulses.length > 24) pulses = pulses.slice(-24);
      }
    };
    var onPointerLeave = function () { targetHover = 0; };
    var onClick = function (e) {
      if (!opts.interactive || !opts.clickPulse) return;
      var rect = el.getBoundingClientRect();
      if (!rect.width) return;
      pulse((e.clientX - rect.left) / rect.width);
    };
    var onVisibility = function () { if (document.hidden) stop(); else if (visible) start(); };

    var ro = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(function () { resize(); if (!running) render(); });
      ro.observe(el);
    }
    var io = null;
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible && !document.hidden) start(); else stop();
      }, { threshold: 0.01 });
      io.observe(el);
    }

    resize();
    render();                     // first frame is always drawn, motion or not
    if (!reduce) {
      start();
      el.addEventListener('pointermove', onPointerMove);
      el.addEventListener('pointerleave', onPointerLeave);
      el.addEventListener('click', onClick);
      document.addEventListener('visibilitychange', onVisibility);
    }

    return {
      canvas: canvas,
      pulse: pulse,
      resize: function () { resize(); render(); },
      destroy: function () {
        stop();
        if (ro) ro.disconnect();
        if (io) io.disconnect();
        el.removeEventListener('pointermove', onPointerMove);
        el.removeEventListener('pointerleave', onPointerLeave);
        el.removeEventListener('click', onClick);
        document.removeEventListener('visibilitychange', onVisibility);
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
    };
  }

  var V2 = {};
  var mounted = new WeakMap();

  // Auto-mounts every [data-ribbons] host, parsing its data attributes as options.
  function autoMount(scope) {
    var nodes = (scope || document).querySelectorAll('[data-ribbons]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (mounted.has(el)) continue;
      var opts = {};
      for (var a = 0; a < el.attributes.length; a++) {
        var attr = el.attributes[a];
        if (attr.name.indexOf('data-ribbons-') !== 0) continue;
        var key = attr.name.slice('data-ribbons-'.length).replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
        var raw = attr.value;
        var num = Number(raw);
        opts[key] = raw === 'true' ? true : raw === 'false' ? false : (raw !== '' && isFinite(num) ? num : raw);
      }
      mounted.set(el, mount(el, opts));
    }
  }

  function unmountAll() {
    // Only used when the dashboard is torn down mid-animation.
    var nodes = document.querySelectorAll('[data-ribbons]');
    for (var i = 0; i < nodes.length; i++) {
      var handle = mounted.get(nodes[i]);
      if (handle) { handle.destroy(); mounted.delete(nodes[i]); }
    }
  }

  V2.defaults = DEFAULTS;
  V2.mount = mount;
  V2.autoMount = autoMount;
  V2.unmountAll = unmountAll;
  V2.prefersReducedMotion = prefersReducedMotion;
  window.InterferenceRibbons = V2;
})();
