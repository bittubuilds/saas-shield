/* ---------------------------------------------------------------------------
   Shatter Type — DOM port

   Source component: React Bits Pro, "Shatter Type"
   (https://pro.reactbits.dev/docs/components/shatter-type).
   That component is a React + Tailwind registry package. This frontend has no
   React, no Tailwind and no components.json, and the Pro registry needs
   REACTBITS_LICENSE_KEY, so the package cannot be installed here. This file
   reproduces the effect with DOM, CSS clip-path and the Web Animations API, and
   keeps the same props. See docs/REACTBITS.md.

   What it does: the headline is cut into irregular glass shards that assemble on
   entrance, open hairline gaps under the cursor, and burst apart on click before
   flying back together.

   Differences from the Pro source, all documented:
     - shards are DOM nodes with clip-path, not WebGL triangles
     - colours come from the page's own text colour and the accent token
     - shard count is computed from the box, capped at 28 for layout cost
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var DEFAULTS = {
    fontWeight: 700,
    fontSize: 0,          // 0 = inherit the page size
    letterSpacing: null,  // null = inherit
    lineHeight: null,
    align: 'inherit',
    accentColor: null,    // null = read --accent from CSS
    shardSize: 0.09,
    irregularity: 0.6,
    crack: 0.6,
    crackRadius: 0.5,
    heal: 0.9,
    shatter: true,
    shatterRadius: 0.55,
    force: 1,
    spin: 1,
    depth: 1,
    gravity: 0,
    reassemble: 1.1,
    stiffness: 0.55,
    glint: 0.8,
    intro: 'assemble',
    introDuration: 1.6,
    autoplay: false,
    autoplayInterval: 4,
    interactive: true,
    paused: false,
    quality: 1
  };

  var SEQ = 0;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function rand(seed) {
    // Deterministic per instance so the fracture pattern is stable across
    // re-renders instead of reshuffling on every mount.
    var x = Math.sin(seed * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }

  function reduceMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  function canAnimate(el) { return typeof el.animate === 'function'; }

  function readAccent(el) {
    try {
      var v = getComputedStyle(el).getPropertyValue('--accent').trim();
      return v || '#7c5cff';
    } catch (e) { return '#7c5cff'; }
  }

  function mount(el, options) {
    if (!el || !el.appendChild) return { shatter: function () {}, assemble: function () {}, destroy: function () {} };

    var opts = {};
    for (var k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) opts[k] = DEFAULTS[k];
    if (options) for (var j in options) if (Object.prototype.hasOwnProperty.call(options, j)) opts[j] = options[j];

    var original = el.innerHTML;
    var reduced = reduceMotion();
    var frozen = reduced || opts.paused;
    var accent = opts.accentColor || readAccent(el);
    var uid = 'sh' + (++SEQ);
    var shards = [];
    var stage = null;
    var raf = 0;
    var pointer = { x: -9999, y: -9999, inside: false };
    var crackState = [];
    var autoplayTimer = 0;

    try {
      el.classList.add('shatter-host');
      el.setAttribute('data-shatter-ready', '');

      // The original markup stays in the box at zero opacity: it keeps the layout
      // width and height, and screen readers still read the real headline once.
      var base = document.createElement('span');
      base.className = 'shatter-base';
      base.innerHTML = original;

      stage = document.createElement('span');
      stage.className = 'shatter-stage';
      stage.setAttribute('aria-hidden', 'true');
      stage.style.setProperty('--shatter-accent', accent);

      el.textContent = '';
      el.appendChild(base);
      el.appendChild(stage);

      var box = base.getBoundingClientRect();
      var fontPx = parseFloat(getComputedStyle(base).fontSize) || 32;
      var W = Math.max(1, Math.round(box.width));
      var H = Math.max(1, Math.round(box.height));

      // Cell sizing: shardSize is relative to the font size, as in the Pro prop.
      var cell = Math.max(22, fontPx * opts.shardSize * 10);
      var cols = clamp(Math.round(W / cell), 3, 9);
      var rows = clamp(Math.round(H / cell), 2, 4);

      // One jittered grid, shared by neighbouring cells, so the pieces tile exactly.
      var pts = [];
      for (var r = 0; r <= rows; r++) {
        pts[r] = [];
        for (var c = 0; c <= cols; c++) {
          var jx = (c === 0 || c === cols) ? 0 : (rand(r * 31 + c * 7 + 1) - 0.5) * (W / cols) * opts.irregularity * 0.9;
          var jy = (r === 0 || r === rows) ? 0 : (rand(r * 17 + c * 13 + 2) - 0.5) * (H / rows) * opts.irregularity * 0.9;
          pts[r][c] = { x: (c / cols) * W + jx, y: (r / rows) * H + jy };
        }
      }

      function pct(p) { return ((p.x / W) * 100).toFixed(2) + '% ' + ((p.y / H) * 100).toFixed(2) + '%'; }

      for (var rr = 0; rr < rows; rr++) {
        for (var cc = 0; cc < cols; cc++) {
          var a = pts[rr][cc], b = pts[rr][cc + 1], d = pts[rr + 1][cc + 1], e = pts[rr + 1][cc];
          var shard = document.createElement('span');
          shard.className = 'shatter-shard';
          shard.style.clipPath = 'polygon(' + [a, b, d, e].map(pct).join(', ') + ')';
          shard.style.webkitClipPath = shard.style.clipPath;

          var face = document.createElement('span');
          face.className = 'shatter-face';
          face.innerHTML = original;
          shard.appendChild(face);

          var cx = (a.x + b.x + d.x + e.x) / 4;
          var cy = (a.y + b.y + d.y + e.y) / 4;
          shard.style.transformOrigin = cx.toFixed(1) + 'px ' + cy.toFixed(1) + 'px';
          stage.appendChild(shard);

          shards.push({
            el: shard,
            face: face,
            cx: cx,
            cy: cy,
            seed: rand(rr * 7 + cc * 3 + 5),
            crack: 0,
            anims: []
          });
        }
      }

      shards.forEach(function (s) {
        s.el.style.setProperty('--shatter-sheen', (0.05 + s.seed * 0.12 * opts.glint).toFixed(3));
      });

      if (!frozen) {
        if (canAnimate(stage)) {
          introAnimation();
        } else {
          // No Web Animations API: the headline simply appears assembled.
          shards.forEach(function (s) { s.el.style.opacity = '1'; });
        }
      }

      if (!frozen && opts.interactive) {
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerleave', onLeave);
        el.addEventListener('click', onClick);
        el.addEventListener('pointerdown', onClick);
      }
      if (!frozen && opts.autoplay) startAutoplay();

      return {
        shatter: shatterAt,
        assemble: assembleNow,
        destroy: destroy
      };
    } catch (err) {
      // Anything unexpected leaves the original headline in place.
      el.innerHTML = original;
      el.classList.remove('shatter-host');
      el.removeAttribute('data-shatter-ready');
      return { shatter: function () {}, assemble: function () {}, destroy: function () {} };
    }

    // ---------------------------------------------------------------- entrance
    function introAnimation() {
      if (!canAnimate(el)) return;   // no WAAPI: the headline simply stays assembled
      var intro = opts.intro;
      if (intro === 'none') return;
      var dur = Math.max(0.2, opts.introDuration) * 1000;
      shards.forEach(function (s, i) {
        var delay = intro === 'fade' ? 0 : (s.seed * 0.55 + (i / shards.length) * 0.45) * dur * 0.55;
        var from;
        if (intro === 'drop') {
          from = { transform: 'translate3d(' + ((s.seed - 0.5) * 30).toFixed(1) + 'px,' + (-90 - s.seed * 90).toFixed(1) + 'px,0) rotate(' + ((s.seed - 0.5) * 26).toFixed(1) + 'deg)', opacity: '0' };
        } else if (intro === 'fade') {
          from = { opacity: '0' };
        } else {
          from = {
            transform: 'translate3d(' + ((s.seed - 0.5) * 160).toFixed(1) + 'px,' + ((rand(s.seed * 91) - 0.5) * 130).toFixed(1) + 'px,0) rotate(' + ((rand(s.seed * 57) - 0.5) * 70).toFixed(1) + 'deg) scale(1.18)',
            opacity: '0'
          };
        }
        var anim = s.el.animate([from, { transform: 'none', opacity: '1' }], {
          duration: Math.min(dur, 900),
          delay: delay,
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
          fill: 'both'
        });
        s.anims.push(anim);
        anim.onfinish = function () {
          s.el.style.opacity = '1';
          try { anim.cancel(); } catch (e) { /* already gone */ }
          // The flash as a piece locks into place.
          if (opts.glint > 0) {
            s.el.classList.add('shatter-lock');
            setTimeout(function () { s.el.classList.remove('shatter-lock'); }, 220);
          }
        };
      });
    }

    function assembleNow() {
      shards.forEach(function (s) {
        s.anims.forEach(function (a) { try { a.cancel(); } catch (e) { /* noop */ } });
        s.anims = [];
        s.el.style.transform = '';
        s.el.style.opacity = '1';
      });
      introAnimation();
    }

    // ------------------------------------------------------------------- crack
    function onMove(e) {
      var rect = stage.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      pointer.inside = true;
      startLoop();
    }

    function onLeave() {
      pointer.inside = false;
      pointer.x = -9999; pointer.y = -9999;
      startLoop();
    }

    function startLoop() {
      if (raf || frozen) return;
      raf = requestAnimationFrame(step);
    }

    function step() {
      raf = 0;
      var fontPx = parseFloat(getComputedStyle(el).fontSize) || 32;
      var radius = Math.max(48, opts.crackRadius * fontPx * 2.6);
      var active = false;

      shards.forEach(function (s) {
        var target = 0;
        var dx = 0, dy = 0;
        if (pointer.inside) {
          var vx = s.cx - pointer.x;
          var vy = s.cy - pointer.y;
          var dist = Math.sqrt(vx * vx + vy * vy) || 1;
          if (dist < radius) {
            target = (1 - dist / radius) * opts.crack;
            dx = (vx / dist) * target * 3.2;
            dy = (vy / dist) * target * 3.2;
          }
        }
        s.crack += (target - s.crack) * clamp(0.28 + opts.heal * 0.05, 0.05, 0.9);
        if (Math.abs(target - s.crack) > 0.004 || target > 0) active = true;
        if (s.crack > 0.004) {
          var rot = (s.seed - 0.5) * s.crack * 1.4;
          s.face.style.transform = 'translate3d(' + dx.toFixed(2) + 'px,' + dy.toFixed(2) + 'px,0) rotate(' + rot.toFixed(2) + 'deg)';
          s.el.style.setProperty('--shatter-gap', (s.crack * opts.crack).toFixed(3));
        } else if (s.face.style.transform) {
          s.face.style.transform = '';
          s.el.style.setProperty('--shatter-gap', '0');
        }
      });

      if (active || pointer.inside) raf = requestAnimationFrame(step);
    }

    // ----------------------------------------------------------------- shatter
    function shatterAt(x, y) {
      if (frozen) return;
      var rect = stage.getBoundingClientRect();
      var px = typeof x === 'number' ? x : rect.width * (0.2 + rand(Date.now() % 97) * 0.6);
      var py = typeof y === 'number' ? y : rect.height * (0.25 + rand(Date.now() % 53) * 0.5);
      var fontPx = parseFloat(getComputedStyle(el).fontSize) || 32;
      var radius = Math.max(72, opts.shatterRadius * fontPx * 3.4);

      shards.forEach(function (s) {
        var vx = s.cx - px;
        var vy = s.cy - py;
        var dist = Math.sqrt(vx * vx + vy * vy) || 1;
        var hit = dist < radius;

        if (!hit) {
          // Glass just outside the break only cracks.
          s.crack = Math.max(s.crack, 0.45 * opts.crack);
          s.el.style.setProperty('--shatter-gap', (s.crack).toFixed(3));
          return;
        }

        var power = (1 - dist / radius) * opts.force;
        var ox = (vx / dist) * (40 + power * 90) * (0.6 + s.seed * 0.8);
        var oy = (vy / dist) * (34 + power * 70) * (0.6 + s.seed * 0.8) - 18 * opts.depth;
        var rot = (s.seed - 0.5) * 120 * opts.spin * (0.5 + power);
        var scale = 1 + 0.12 * opts.depth * power;

        if (!canAnimate(s.el)) {
          s.el.style.opacity = '0.35';
          setTimeout(function () { s.el.style.opacity = '1'; }, Math.max(200, opts.reassemble * 1000));
          return;
        }

        var burst = s.el.animate([
          { transform: 'translate3d(0,0,0) rotate(0deg) scale(1)', opacity: '1', offset: 0 },
          {
            transform: 'translate3d(' + ox.toFixed(1) + 'px,' + oy.toFixed(1) + 'px,0) rotate(' + rot.toFixed(1) + 'deg) scale(' + scale.toFixed(2) + ')',
            opacity: '0.55',
            offset: 0.45
          },
          {
            transform: 'translate3d(' + (ox * 1.08).toFixed(1) + 'px,' + (oy * 1.08 + opts.gravity * 40).toFixed(1) + 'px,0) rotate(' + (rot * 1.12).toFixed(1) + 'deg) scale(' + scale.toFixed(2) + ')',
            opacity: '0.5',
            offset: 0.72
          },
          { transform: 'translate3d(0,0,0) rotate(0deg) scale(1)', opacity: '1', offset: 1 }
        ], {
          duration: Math.max(420, opts.reassemble * 1000 + 520),
          easing: 'cubic-bezier(0.34, 0.02, 0.24, 1)',
          fill: 'none'
        });
        s.anims.push(burst);
        burst.onfinish = function () {
          try { burst.cancel(); } catch (e) { /* noop */ }
          if (opts.glint > 0) {
            s.el.classList.add('shatter-lock');
            setTimeout(function () { s.el.classList.remove('shatter-lock'); }, 240);
          }
        };
      });
    }

    function onClick(e) {
      if (!opts.shatter || frozen) return;
      var rect = stage.getBoundingClientRect();
      shatterAt(e.clientX - rect.left, e.clientY - rect.top);
    }

    function startAutoplay() {
      var ms = Math.max(1200, opts.autoplayInterval * 1000);
      autoplayTimer = setInterval(function () {
        if (document.hidden || pointer.inside) return;
        shatterAt();
      }, ms);
    }

    function destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (autoplayTimer) clearInterval(autoplayTimer);
      autoplayTimer = 0;
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('click', onClick);
      el.removeEventListener('pointerdown', onClick);
      el.classList.remove('shatter-host');
      el.removeAttribute('data-shatter-ready');
      if (stage && stage.parentNode) stage.parentNode.removeChild(stage);
      var base = el.querySelector('.shatter-base');
      if (base) {
        el.innerHTML = original;
      }
    }
  }

  var mounted = new WeakMap();
  var API = { defaults: DEFAULTS, mount: mount };

  API.autoMount = function (scope) {
    var nodes = (scope || document).querySelectorAll('[data-shatter]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (mounted.has(el)) continue;
      var opts = {};
      for (var a = 0; a < el.attributes.length; a++) {
        var attr = el.attributes[a];
        if (attr.name.indexOf('data-shatter-') !== 0) continue;
        var name = attr.name.slice('data-shatter-'.length).replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
        var raw = attr.value;
        var num = Number(raw);
        opts[name] = raw === 'true' ? true : raw === 'false' ? false : (raw !== '' && isFinite(num) ? num : raw);
      }
      mounted.set(el, mount(el, opts));
    }
  };

  API.unmountAll = function () {
    var nodes = document.querySelectorAll('[data-shatter]');
    for (var i = 0; i < nodes.length; i++) {
      var handle = mounted.get(nodes[i]);
      if (handle) { handle.destroy(); mounted.delete(nodes[i]); }
    }
  };

  window.ShatterType = API;
})();
