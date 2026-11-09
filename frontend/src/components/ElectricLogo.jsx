import { useEffect, useRef } from 'react';

/**
 * Electric Logo: turns a logo's silhouette into a living lightning outline with a soft glow,
 * crackling strands, arcs that leap off the edges and a cursor that stirs the current.
 * Canvas 2D port with the same props as the React Bits Pro component. Fills its positioned parent.
 */
const rnd = (a = 0, b = 1) => a + Math.random() * (b - a);
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0); return c; };

function tint(src, color) {
  const c = mk(src.width, src.height), x = c.getContext('2d');
  x.drawImage(src, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
  return c;
}

export default function ElectricLogo({
  src, color = '#ecc7ff', glowColor = '#ad6dff', scale = 0.7, strands = 4, bend = 0.6, crackle = 1.5, arcs = 1,
  speed = 2.5, interactive = true, intensity = 1, glow = 1, thickness = 1.5, flicker = 0.6, fill = 0,
  cursorIntensity = 0.75, cursorRadius = 100, label = 'Logo', className = '',
}) {
  const box = useRef(null);
  const cv = useRef(null);

  useEffect(() => {
    const canvas = cv.current, parent = box.current, ctx = canvas.getContext('2d');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const img = new Image();
    let alive = true, raf = 0, S = 0, dpr = 1, ox = 0, oy = 0, L = 0;
    let mask, edgeC, edgeW, fillC, tmp, buf, g1, g2, pts = [], bolts = [], ptr = null, t0 = performance.now(), last = t0;

    function build() {
      const r = parent.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(80, r.width), h = Math.max(80, r.height);
      canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      const W = canvas.width, H = canvas.height;
      L = Math.min(W, H) * scale;
      const lw = img.width >= img.height ? L : (L * img.width) / img.height, lh = img.width >= img.height ? (L * img.height) / img.width : L;
      ox = (W - lw) / 2; oy = (H - lh) / 2;
      const m = mk(W, H); m.getContext('2d').drawImage(img, ox, oy, lw, lh); mask = m;
      const a = m.getContext('2d').getImageData(0, 0, W, H).data;
      const band = (rad) => {
        const out = mk(W, H), ox2 = out.getContext('2d'), id = ox2.createImageData(W, H), d = id.data;
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [.7, .7], [-.7, .7], [.7, -.7], [-.7, -.7]];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4, inside = a[i + 3] > 110;
          let edge = false;
          for (const [dx, dy] of dirs) {
            const xx = Math.round(x + dx * rad), yy = Math.round(y + dy * rad);
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            if ((a[(yy * W + xx) * 4 + 3] > 110) !== inside) { edge = true; break; }
          }
          if (edge) { d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = 255; }
        }
        ox2.putImageData(id, 0, 0); return out;
      };
      const th = thickness * dpr;
      edgeC = tint(band(th * 0.9), color); edgeW = tint(band(th * 0.35), '#ffffff');
      fillC = tint(m, glowColor);
      pts = [];
      const e = edgeW.getContext('2d').getImageData(0, 0, W, H).data;
      for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) if (e[(y * W + x) * 4 + 3] > 0) pts.push([x, y]);
      tmp = mk(W, H); buf = mk(W, H);
      g1 = mk(W / 4, H / 4); g2 = mk(W / 12, H / 12);
    }

    // Smooth pseudo-noise: a few detuned sines per strand.
    const wob = (p, t, k) => Math.sin(p * 0.021 + t * 1.3 + k * 2.1) * bend + Math.sin(p * 0.071 - t * 2.7 + k * 5.3) * 0.55 * crackle + Math.sin(p * 0.19 + t * 6.1 + k * 1.7) * 0.3 * crackle;

    function strand(src2, t, k, amp) {
      const W = canvas.width, H = canvas.height, step = Math.max(3, 3 * dpr | 0);
      const tx = tmp.getContext('2d'), bx = buf.getContext('2d');
      tx.clearRect(0, 0, W, H);
      for (let y = 0; y < H; y += step) {
        let f = 1; if (ptr) f += 3 * cursorIntensity * clamp(1 - Math.abs(y - ptr.y) / (cursorRadius * dpr));
        tx.drawImage(src2, 0, y, W, step, wob(y, t, k) * amp * f, y, W, step);
      }
      for (let x = 0; x < W; x += step) {
        let f = 1; if (ptr) f += 3 * cursorIntensity * clamp(1 - Math.abs(x - ptr.x) / (cursorRadius * dpr));
        bx.drawImage(tmp, x, 0, step, H, x, wob(x + 97, t * 1.1, k + 3) * amp * f, step, H);
      }
    }

    function bolt(from) {
      const cx = canvas.width / 2, cy = canvas.height / 2;
      let dx = from[0] - cx, dy = from[1] - cy; const m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
      if (ptr && Math.random() < 0.5) { dx = ptr.x - from[0]; dy = ptr.y - from[1]; const n = Math.hypot(dx, dy) || 1; dx /= n; dy /= n; }
      const len = L * rnd(0.08, 0.2), n = 9, path = [[from[0], from[1]]];
      for (let i = 1; i <= n; i++) { const j = (i / n) * len, s = rnd(-1, 1) * L * 0.03; path.push([from[0] + dx * j - dy * s, from[1] + dy * j + dx * s]); }
      bolts.push({ path, born: performance.now(), life: rnd(90, 220) });
    }

    function frame(now) {
      raf = 0; if (!alive) return;
      const t = ((now - t0) / 1000) * speed, W = canvas.width, H = canvas.height;
      const dt = (now - last) / 1000; last = now;
      const intro = clamp((now - t0) / 2200), fl = 1 - flicker * 0.3 * Math.abs(Math.sin(t * 9) * Math.sin(t * 23.7));
      const k = intensity * fl * (0.15 + 0.85 * intro * intro);
      const bx = buf.getContext('2d'); bx.clearRect(0, 0, W, H);
      const n = Math.max(1, Math.round(strands));
      for (let s = 0; s < n; s++) { bx.globalAlpha = s === 0 ? 0.55 : 0.8 / Math.sqrt(n); strand(s === 0 ? edgeC : edgeC, t, s, (s === 0 ? 0.6 : 1.4 + s * 0.5) * dpr); }
      bx.globalAlpha = 1; strand(edgeW, t, 9, 0.5 * dpr);
      // arcs that leap off the edges
      if (pts.length && Math.random() < arcs * 6 * dt * (1 + (ptr ? 2 : 0))) bolt(pts[(Math.random() * pts.length) | 0]);
      bolts = bolts.filter((b) => now - b.born < b.life);
      bx.lineJoin = 'round'; bx.lineCap = 'round';
      for (const b of bolts) {
        const a = 1 - (now - b.born) / b.life;
        for (const [lw, col] of [[2.6 * dpr, color], [1 * dpr, '#fff']]) {
          bx.strokeStyle = col; bx.lineWidth = lw; bx.globalAlpha = a * (0.6 + Math.random() * 0.4);
          bx.beginPath(); b.path.forEach((p, i) => (i ? bx.lineTo(p[0] + rnd(-1, 1) * dpr, p[1] + rnd(-1, 1) * dpr) : bx.moveTo(p[0], p[1]))); bx.stroke();
        }
      }
      bx.globalAlpha = 1;
      // cursor: brighten the current near the pointer
      if (ptr) {
        const R = cursorRadius * dpr * 1.6, gr = bx.createRadialGradient(ptr.x, ptr.y, 0, ptr.x, ptr.y, R);
        gr.addColorStop(0, `rgba(255,255,255,${0.9 * cursorIntensity})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
        bx.globalCompositeOperation = 'source-atop'; bx.fillStyle = gr; bx.fillRect(ptr.x - R, ptr.y - R, R * 2, R * 2); bx.globalCompositeOperation = 'source-over';
      }
      // glow = cheap blur via down/up scaling
      const a1 = g1.getContext('2d'), a2 = g2.getContext('2d');
      a1.clearRect(0, 0, g1.width, g1.height); a1.drawImage(buf, 0, 0, g1.width, g1.height);
      a2.clearRect(0, 0, g2.width, g2.height); a2.drawImage(buf, 0, 0, g2.width, g2.height);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      if (fill > 0) { ctx.globalAlpha = fill * 0.35 * k; ctx.drawImage(fillC, 0, 0); }
      ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = clamp(0.9 * glow * k, 0, 1); ctx.drawImage(tint(g2, glowColor), 0, 0, W, H);
      ctx.globalAlpha = clamp(0.7 * glow * k, 0, 1); ctx.drawImage(tint(g2, glowColor), 0, 0, W, H);
      ctx.globalAlpha = clamp(0.8 * glow * k, 0, 1); ctx.drawImage(tint(g1, glowColor), 0, 0, W, H);
      ctx.globalAlpha = clamp(k, 0, 1); ctx.drawImage(buf, 0, 0);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      if (!reduced) raf = requestAnimationFrame(frame);
    }

    const move = (e) => { const r = canvas.getBoundingClientRect(); ptr = { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr }; };
    const leave = () => { ptr = null; };
    img.onload = () => {
      if (!alive) return;
      build(); if (reduced) t0 -= 3000; raf = requestAnimationFrame(frame);
      ro = new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => alive && build(), 150); }); ro.observe(parent);
    };
    let ro, rt = 0;
    img.src = src;
    if (interactive) { canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerdown', move); canvas.addEventListener('pointerleave', leave); }
    return () => {
      alive = false; cancelAnimationFrame(raf); clearTimeout(rt); ro && ro.disconnect();
      canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerdown', move); canvas.removeEventListener('pointerleave', leave);
    };
  }, [src, color, glowColor, scale, strands, bend, crackle, arcs, speed, interactive, intensity, glow, thickness, flicker, fill, cursorIntensity, cursorRadius]);

  return (
    <div ref={box} className={`electric-logo ${className}`.trim()} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <canvas ref={cv} role="img" aria-label={label} style={{ display: 'block' }} />
    </div>
  );
}
