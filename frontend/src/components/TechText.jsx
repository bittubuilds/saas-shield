import { useEffect, useRef } from 'react';

/**
 * Tech Text (React Bits style): a heavy wordmark whose letters turn into dashed vector outlines under the
 * cursor, with a selection box, size label and drifting specks. Letters can be dragged (they spring back)
 * and kicked with a click. When nobody is pointing, a sweep walks across the word so the effect is visible.
 */
export default function TechText({
  text = 'SAAS SHIELD', fontWeight = 800, letterSpacing = -0.04, dashLength = 4, dashGap = 2, specks = 15, clickKick = true,
  lineStyle = 'dashed', strokeWidth = 1.5, bounce = 0.4, selection = true, labels = true, draggable = true, sweep = true,
  reach = 200, softness = 0.7, maxSize = 230,
}) {
  const box = useRef(null);
  const cv = useRef(null);

  useEffect(() => {
    const canvas = cv.current, wrap = box.current, ctx = canvas.getContext('2d');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    let W = 0, H = 0, size = 0, dpr = 1, baseY = 0, font = '', L = [], raf = 0, alive = true, visible = true;
    let ptr = null, drag = null, lastReal = performance.now() + 800, last = performance.now(), ax = 0, ay = 0, ro, rt = 0, io;

    function build() {
      const fam = getComputedStyle(document.body).fontFamily || 'sans-serif';
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = Math.max(240, Math.floor(wrap.clientWidth));
      const m = document.createElement('canvas').getContext('2d');
      m.font = `${fontWeight} 100px ${fam}`;
      const total100 = [...text].reduce((a, c) => a + m.measureText(c).width + letterSpacing * 100, 0) - letterSpacing * 100;
      size = Math.min(maxSize, (W * 0.92 * 100) / total100);
      H = Math.round(size * 1.6);
      canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      font = `${fontWeight} ${size}px ${fam}`; ctx.font = font;
      const ws = [...text].map((c) => ctx.measureText(c).width);
      const tot = ws.reduce((a, b) => a + b + letterSpacing * size, 0) - letterSpacing * size;
      let x = (W - tot) / 2; baseY = H / 2 + size * 0.36;
      const capH = size * 0.72;
      L = [...text].map((c, i) => { const o = { c, sp: c === ' ', x, w: ws[i], cx: x + ws[i] / 2, cy: baseY - capH / 2, capH, h: 0, ox: 0, oy: 0, vx: 0, vy: 0 }; x += ws[i] + letterSpacing * size; return o; });
      ax = W / 2; ay = baseY - capH / 2;
    }

    const dash = () => (lineStyle === 'solid' ? [] : lineStyle === 'dotted' ? [1, 3] : [dashLength, dashGap]);

    function frame(now) {
      raf = 0;
      if (!alive) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      let p = ptr;
      if (!p && sweep && !reduced) {
        const idle = (now - lastReal) / 1000;
        if (idle > 1.2) { const e = ((idle - 1.2) % 7) / 4.2; if (e < 1) p = { x: W * 0.04 + W * 0.92 * e, y: baseY - size * 0.3 }; }
      }
      const R = (reach * size) / 150, pw = 2 + (1 - softness) * 3;
      let best = null;
      for (const l of L) {
        if (l.sp) continue;
        let target = 0;
        if (p) { const d = Math.max(0, Math.hypot(p.x - l.cx, (p.y - l.cy) * 0.6) - l.w * 0.5); target = Math.pow(clamp01(1 - d / R), pw); }
        l.h += (target - l.h) * Math.min(1, dt * 14);
        if (drag && drag.l === l) { l.ox = drag.x - drag.sx; l.oy = drag.y - drag.sy; l.vx = l.vy = 0; }
        else {
          const k = 110, c = 2 * Math.sqrt(k) * (1 - bounce * 0.75);
          l.vx += (-k * l.ox - c * l.vx) * dt; l.ox += l.vx * dt; l.vy += (-k * l.oy - c * l.vy) * dt; l.oy += l.vy * dt;
        }
        if (!best || l.h > best.h) best = l;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      ctx.font = font; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round'; ctx.lineWidth = strokeWidth;
      for (const l of L) {
        if (l.sp) continue;
        const x = l.x + l.ox, y = baseY + l.oy;
        ctx.setLineDash([]);
        ctx.fillStyle = `rgba(255,255,255,${(1 - l.h * 0.96).toFixed(3)})`; ctx.fillText(l.c, x, y);
        if (l.h > 0.04) { ctx.setLineDash(dash()); ctx.strokeStyle = `rgba(255,255,255,${Math.min(1, l.h * 1.2).toFixed(3)})`; ctx.strokeText(l.c, x, y); }
      }
      ctx.setLineDash([]);
      if (best && best.h > 0.35) {
        const l = best, a = clamp01((best.h - 0.35) / 0.4);
        const pad = size * 0.04, x0 = l.x + l.ox - pad, y0 = baseY + l.oy - l.capH - pad, bw = l.w + pad * 2, bh = l.capH + pad * 2;
        ax += (l.cx + l.ox - ax) * 0.2; ay += (l.cy + l.oy - ay) * 0.2;
        ctx.globalAlpha = a;
        if (selection) {
          ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1; ctx.strokeRect(x0, y0, bw, bh);
          ctx.fillStyle = '#fff';
          for (const [hx, hy] of [[x0, y0], [x0 + bw, y0], [x0, y0 + bh], [x0 + bw, y0 + bh]]) ctx.fillRect(hx - 3, hy - 3, 6, 6);
          ctx.strokeStyle = '#fff'; ctx.strokeRect(x0 + bw / 2 - 2.5, y0 - 12, 5, 5);
          ctx.beginPath(); ctx.moveTo(x0 + bw / 2, y0 - 7); ctx.lineTo(x0 + bw / 2, y0); ctx.stroke();
        }
        if (labels) {
          ctx.font = '11px ui-monospace, Menlo, Consolas, monospace'; ctx.fillStyle = 'rgba(255,255,255,.65)'; ctx.textBaseline = 'bottom';
          const sg = (v) => `${v >= 0 ? '+' : ''}${Math.round(v)}`;
          ctx.fillText(drag && drag.l === l ? `${sg(l.ox)}, ${sg(l.oy)}` : `${l.c}  ${Math.round(l.w)} × ${Math.round(l.capH)}`, x0, y0 - 16);
        }
        ctx.fillStyle = 'rgba(255,255,255,.45)';
        for (let i = 0; i < specks; i++) {
          const ph = i * 2.399, t = now / 1000, s = 0.25 + (i % 5) * 0.08;
          ctx.fillRect(ax + Math.cos(ph + t * s) * l.w * (0.8 + (i % 4) * 0.12), ay + Math.sin(ph * 1.3 + t * s * 0.8) * l.capH * (0.65 + (i % 3) * 0.1), 2 + (i % 3), 2 + (i % 3));
        }
        ctx.globalAlpha = 1;
      }
      if (visible && !reduced) raf = requestAnimationFrame(frame);
    }
    const kick = () => { if (!raf && alive) { last = performance.now(); raf = requestAnimationFrame(frame); } };

    const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }; };
    const hit = (p) => L.find((l) => !l.sp && p.x >= l.x && p.x <= l.x + l.w + 4 && p.y >= baseY - l.capH - 8 && p.y <= baseY + 8);
    const onMove = (e) => {
      if (e.pointerType !== 'mouse' && !drag) return;
      const p = local(e); ptr = p; lastReal = performance.now();
      if (drag) { drag.x = p.x; drag.y = p.y; if (Math.hypot(p.x - drag.sx0, p.y - drag.sy0) > 4) drag.moved = true; }
    };
    const onDown = (e) => {
      const p = local(e); ptr = p; lastReal = performance.now();
      const l = hit(p);
      if (l && (draggable || clickKick)) { drag = { l, sx: p.x - l.ox, sy: p.y - l.oy, sx0: p.x, sy0: p.y, x: p.x, y: p.y, moved: false }; canvas.setPointerCapture(e.pointerId); if (!draggable) drag.sx = drag.x; }
    };
    const onUp = (e) => {
      if (drag) { if (!drag.moved && clickKick) drag.l.vy = -size * 7; if (!draggable) { drag.l.ox = drag.l.oy = 0; } drag = null; }
      if (e.pointerType !== 'mouse') ptr = null;
      lastReal = performance.now();
    };
    const onLeave = (e) => { if (!drag && e.pointerType === 'mouse') ptr = null; };

    document.fonts.ready.then(() => {
      if (!alive) return;
      build();
      if (reduced) { frame(performance.now()); } else kick();
      ro = new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if (alive && wrap.clientWidth !== W) { build(); if (reduced) frame(performance.now()); } }, 120); });
      ro.observe(wrap);
      io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible && !reduced) kick(); });
      io.observe(canvas);
    });
    canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp); canvas.addEventListener('pointerleave', onLeave);
    return () => {
      alive = false; cancelAnimationFrame(raf); clearTimeout(rt); ro && ro.disconnect(); io && io.disconnect();
      canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp); canvas.removeEventListener('pointerleave', onLeave);
    };
  }, [text, fontWeight, letterSpacing, dashLength, dashGap, specks, clickKick, lineStyle, strokeWidth, bounce, selection, labels, draggable, sweep, reach, softness, maxSize]);

  return (
    <h1 className="stage-word" ref={box}>
      <canvas ref={cv} aria-hidden="true" />
      <span className="sr-only">{text}</span>
    </h1>
  );
}
