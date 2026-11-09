import { useEffect, useRef } from 'react';

/**
 * Hero wordmark with the Shatter Type behaviour from the reference video:
 * glass shards fly in and assemble left to right, cracks open under the cursor,
 * click/tap (and a timer) bursts the shards apart, then they fly back home.
 * Canvas 2D; each shard is a small jittered triangle cut out of the rendered text.
 */
const rnd = (a = 0, b = 1) => a + Math.random() * (b - a);
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const easeOut = (p) => 1 - (1 - p) ** 3;
const easeIn = (p) => p * p * (3 - 2 * p);
const ACCENT = '#a78bfa';

export default function ShardWordmark({ text = 'SAAS SHIELD', autoplay = 6 }) {
  const wrap = useRef(null);
  const cv = useRef(null);

  useEffect(() => {
    const canvas = cv.current, box = wrap.current;
    const ctx = canvas.getContext('2d');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0, white, violet, shards = [], anim = null, raf = 0, timer = 0, alive = true, ptr = null;

    const bitmap = (color, size, font) => {
      const c = document.createElement('canvas');
      c.width = W * dpr; c.height = H * dpr;
      const x = c.getContext('2d');
      x.scale(dpr, dpr); x.font = `900 ${size}px ${font}`; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.letterSpacing = '-0.02em'; x.fillStyle = color; x.fillText(text, W / 2, H / 2);
      return c;
    };

    function build() {
      const font = getComputedStyle(document.body).fontFamily || 'sans-serif';
      W = Math.max(240, Math.floor(box.clientWidth));
      const probe = document.createElement('canvas').getContext('2d');
      probe.font = `900 100px ${font}`; probe.letterSpacing = '-0.02em';
      const size = Math.min(230, (W * 0.94 * 100) / probe.measureText(text).width);
      H = Math.round(size * 1.3);
      canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.height = `${H}px`;
      white = bitmap('#fff', size, font); violet = bitmap(ACCENT, size, font);
      const mask = white.getContext('2d').getImageData(0, 0, white.width, white.height).data;
      const solid = (x, y) => x >= 0 && y >= 0 && x < W && y < H && mask[((y * dpr | 0) * white.width + (x * dpr | 0)) * 4 + 3] > 40;
      const s = size * 0.095, cols = Math.ceil(W / s) + 1, rows = Math.ceil(H / s) + 1, g = [];
      for (let j = 0; j <= rows; j++) { g[j] = []; for (let i = 0; i <= cols; i++) g[j][i] = [i * s + (i && i < cols ? rnd(-0.3, 0.3) * s : 0), j * s + (j && j < rows ? rnd(-0.3, 0.3) * s : 0)]; }
      shards = [];
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const [a, b, c, d] = [g[j][i], g[j][i + 1], g[j + 1][i + 1], g[j + 1][i]];
        const tris = Math.random() < 0.5 ? [[a, b, c], [a, c, d]] : [[a, b, d], [b, c, d]];
        for (const t of tris) {
          const cx = (t[0][0] + t[1][0] + t[2][0]) / 3, cy = (t[0][1] + t[1][1] + t[2][1]) / 3;
          if (!(solid(cx, cy) || t.some((p) => solid((p[0] + cx) / 2, (p[1] + cy) / 2)))) continue;
          shards.push({ cx, cy, v: t.map((p) => [p[0] - cx, p[1] - cy]), k: 0, r: Math.random(), r2: Math.random(), acc: Math.random() < 0.12, ang: rnd(-1, 1) });
        }
      }
    }

    function drawRest() { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H); ctx.drawImage(white, 0, 0, W, H); }

    function start(type, ox, oy) {
      if (anim || reduced) return;
      const now = performance.now();
      for (const p of shards) {
        const nx = (p.cx - ox) / W, ny = (p.cy - oy) / H;
        p.dist = Math.min(1, Math.hypot(nx, ny));
        p.d = type === 'intro' ? (p.cx / W) * 0.7 + p.r * 0.3 : p.dist * 0.3;
        const m = Math.hypot(nx, ny) || 1;
        p.vx = (nx / m) * W * 0.2 * (0.4 + p.r) + rnd(-1, 1) * W * 0.05;
        p.vy = (ny / m) * H * 0.9 * (0.4 + p.r2) + rnd(-1, 1) * H * 0.4;
        p.sx = -W * rnd(0.1, 0.35); p.sy = rnd(-1, 1) * H * 0.7;
      }
      anim = { type, t0: now, ox, oy, len: type === 'intro' ? 2.1 : 3.1 };
      kick();
    }

    function frame(now) {
      raf = 0;
      if (!alive) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      const el = anim ? (now - anim.t0) / 1000 : 0;
      let moving = !!ptr;
      for (const p of shards) {
        let x = 0, y = 0, rot = 0, a = 1, flying = false;
        if (anim) {
          const q = el - p.d;
          if (anim.type === 'intro') {
            const e = easeOut(clamp(q / 1.1));
            x = p.sx * (1 - e); y = p.sy * (1 - e); rot = p.ang * 2.5 * (1 - e); a = clamp(q / 0.35); flying = e < 0.98;
          } else if (q >= 0) {
            const out = easeOut(clamp(q / 1.3)), back = easeIn(clamp((q - 1.5) / 1.2)), e = out * (1 - back);
            x = p.vx * e; y = p.vy * e; rot = p.ang * 3 * e; a = 1 - 0.5 * e; flying = e > 0.02;
          }
        }
        if (ptr) { // hairline cracks open under the cursor
          const dx = p.cx - ptr.x, dy = p.cy - ptr.y, d = Math.hypot(dx, dy), R = H * 1.1;
          p.k += ((d < R ? 1 - d / R : 0) - p.k) * 0.2;
          x += (dx / (d || 1)) * p.k * 5; y += (dy / (d || 1)) * p.k * 5;
        } else if (p.k > 0.01) { p.k *= 0.85; moving = true; x += p.k; }
        ctx.save();
        ctx.translate(p.cx + x, p.cy + y); ctx.rotate(rot); ctx.globalAlpha = a;
        ctx.beginPath(); ctx.moveTo(p.v[0][0], p.v[0][1]); ctx.lineTo(p.v[1][0], p.v[1][1]); ctx.lineTo(p.v[2][0], p.v[2][1]); ctx.closePath(); ctx.clip();
        ctx.drawImage(p.acc && flying ? violet : white, -p.cx, -p.cy, W, H);
        ctx.restore();
      }
      if (anim && el > anim.len) { anim = null; if (!moving) drawRest(); }
      if (anim || moving) kick();
    }
    const kick = () => { if (!raf && alive) raf = requestAnimationFrame(frame); };

    const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }; };
    const onMove = (e) => { if (e.pointerType === 'mouse') { ptr = local(e); kick(); } };
    const onLeave = () => { ptr = null; kick(); };
    const onDown = (e) => { const p = local(e); start('burst', p.x, p.y); };

    let ro;
    document.fonts.ready.then(() => {
      if (!alive) return;
      build();
      if (reduced) { drawRest(); } else { start('intro', 0, H / 2); timer = window.setInterval(() => start('burst', W / 2, H / 2), Math.max(3.5, autoplay) * 1000); }
      let rt = 0;
      ro = new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if (box.clientWidth !== W) { build(); anim = null; drawRest(); } }, 150); });
      ro.observe(box);
    });
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerdown', onDown);
    return () => {
      alive = false; cancelAnimationFrame(raf); clearInterval(timer); ro && ro.disconnect();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown);
    };
  }, [text, autoplay]);

  return (
    <h1 className="stage-word" ref={wrap}>
      <canvas ref={cv} aria-hidden="true" />
      <span className="sr-only">{text}</span>
    </h1>
  );
}
