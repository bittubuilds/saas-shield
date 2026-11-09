// Ports of React Bits effects (reactbits.dev), written without extra dependencies:
// SpotlightCard, Magnet, DecryptedText, ClickSpark, DotGrid.
import { useEffect, useLayoutEffect, useRef } from 'react';

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Spotlight Card: a soft light follows the pointer and catches the card edge. */
export function SpotlightCard({ as: Tag = 'article', className = '', children, ...rest }) {
  const move = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
  };
  return <Tag className={`card spot ${className}`.trim()} onPointerMove={move} {...rest}>{children}</Tag>;
}

/** Magnet: the child eases toward the pointer and springs back. */
export function Magnet({ children, strength = 0.3, range = 90 }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (still() || window.matchMedia('(hover: none), (pointer: coarse)').matches) return undefined;
    const move = (e) => {
      const r = el.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      const near = Math.abs(dx) < r.width / 2 + range && Math.abs(dy) < r.height / 2 + range;
      el.style.transform = near ? `translate(${dx * strength}px, ${dy * strength}px)` : '';
    };
    const reset = () => { el.style.transform = ''; };
    window.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerleave', reset);
    return () => { window.removeEventListener('pointermove', move); document.removeEventListener('pointerleave', reset); reset(); };
  }, [strength, range]);
  return <span ref={ref} className="magnet">{children}</span>;
}

/** Decrypted Text: glyphs cycle, then resolve left to right. Plays on load and on hover/tap. */
const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#$%&*+<>';
export function DecryptedText({ text, className = '' }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (still()) return undefined;
    let timer = 0;
    const run = () => {
      clearInterval(timer);
      let n = 0;
      timer = setInterval(() => {
        n += 0.6;
        el.textContent = [...text].map((c, i) => (c === ' ' || i < n ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join('');
        if (n >= text.length) { clearInterval(timer); el.textContent = text; }
      }, 40);
    };
    run();
    el.parentNode.addEventListener('pointerenter', run);
    el.parentNode.addEventListener('click', run);
    return () => { clearInterval(timer); el.parentNode.removeEventListener('pointerenter', run); el.parentNode.removeEventListener('click', run); };
  }, [text]);
  return (
    <span className={className}>
      <span className="sr-only">{text}</span>
      <span ref={ref} aria-hidden="true">{text}</span>
    </span>
  );
}

/** Click Spark: a burst of short sparks at every click or tap. */
export function ClickSpark({ color = '#a78bfa', count = 9, scope = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current, ctx = cv.getContext('2d');
    if (still()) return undefined;
    let sparks = [], raf = 0;
    const fit = () => { cv.width = innerWidth; cv.height = innerHeight; };
    const draw = (now) => {
      ctx.clearRect(0, 0, cv.width, cv.height);
      sparks = sparks.filter((s) => now - s.t < 450);
      ctx.lineWidth = 2; ctx.lineCap = 'round';
      for (const s of sparks) {
        ctx.strokeStyle = s.w ? '#ffffff' : color;
        const p = (now - s.t) / 450, e = 1 - (1 - p) ** 3, r0 = 6 + 26 * e, r1 = r0 + 12 * (1 - p);
        ctx.globalAlpha = 1 - p; ctx.beginPath();
        ctx.moveTo(s.x + Math.cos(s.a) * r0, s.y + Math.sin(s.a) * r0); ctx.lineTo(s.x + Math.cos(s.a) * r1, s.y + Math.sin(s.a) * r1); ctx.stroke();
      }
      raf = sparks.length ? requestAnimationFrame(draw) : 0;
      if (!raf) ctx.clearRect(0, 0, cv.width, cv.height);
    };
    const down = (e) => {
      if (scope && !(e.target.closest && e.target.closest(scope))) return;
      const t = performance.now();
      for (let i = 0; i < count; i++) sparks.push({ x: e.clientX, y: e.clientY, a: (i / count) * Math.PI * 2 + Math.random() * 0.3, t, w: i % 2 });
      if (!raf) raf = requestAnimationFrame(draw);
    };
    fit(); addEventListener('resize', fit); addEventListener('pointerdown', down, { passive: true });
    return () => { cancelAnimationFrame(raf); removeEventListener('resize', fit); removeEventListener('pointerdown', down); };
  }, [color, count, scope]);
  return <canvas ref={ref} className="click-spark" aria-hidden="true" />;
}

/** Dot Grid: a springy dot field the pointer pushes through. Fills its positioned parent. */
export function DotGrid({ gap = 30, radius = 1.6, reach = 130, color = '167,139,250' }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current, ctx = cv.getContext('2d'), box = cv.parentNode, reduced = still();
    let dots = [], raf = 0, ptr = null, W = 0, H = 0;
    const build = () => {
      const r = box.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
      W = r.width; H = r.height; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dots = [];
      for (let y = gap / 2; y < H; y += gap) for (let x = gap / 2; x < W; x += gap) dots.push({ x, y, ox: 0, oy: 0 });
      draw();
    };
    const draw = () => {
      raf = 0; ctx.clearRect(0, 0, W, H);
      let live = !!ptr;
      for (const d of dots) {
        let tx = 0, ty = 0;
        if (ptr) { const dx = d.x - ptr.x, dy = d.y - ptr.y, m = Math.hypot(dx, dy); if (m < reach) { const f = (1 - m / reach) * 28; tx = (dx / (m || 1)) * f; ty = (dy / (m || 1)) * f; } }
        d.ox += (tx - d.ox) * 0.14; d.oy += (ty - d.oy) * 0.14;
        if (Math.abs(d.ox - tx) + Math.abs(d.oy - ty) > 0.05) live = true;
        const near = Math.hypot(d.ox, d.oy) / 28;
        ctx.fillStyle = `rgba(${color},${0.18 + near * 0.7})`;
        ctx.beginPath(); ctx.arc(d.x + d.ox, d.y + d.oy, radius + near * 1.4, 0, 6.283); ctx.fill();
      }
      if (live && !reduced) raf = requestAnimationFrame(draw);
    };
    const move = (e) => {
      const r = box.getBoundingClientRect();
      ptr = e.clientY >= r.top - reach && e.clientY <= r.bottom + reach ? { x: e.clientX - r.left, y: e.clientY - r.top } : null;
      if (!raf && !reduced) raf = requestAnimationFrame(draw);
    };
    const ro = new ResizeObserver(build); ro.observe(box);
    addEventListener('pointermove', move, { passive: true });
    return () => { cancelAnimationFrame(raf); ro.disconnect(); removeEventListener('pointermove', move); };
  }, [gap, radius, reach, color]);
  return <canvas ref={ref} className="dot-grid" aria-hidden="true" />;
}

const words = (text, wcls, lcls) => text.split(' ').map((w, wi, all) => (
  <span key={wi}><span className={wcls}>{[...w].map((c, ci) => <span key={ci} className={lcls} aria-hidden="true">{c}</span>)}</span>{wi < all.length - 1 ? ' ' : ''}</span>
));

/** Scroll Float: letters rise out of a mask, one after another, scrubbed by scroll position. */
export function ScrollFloat({ text, className = '' }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current, items = [...el.querySelectorAll('.sfl')], n = items.length;
    const apply = (p) => items.forEach((s, i) => {
      const lp = clamp01(p * (1 + n * 0.1) - i * 0.1), e = 1 - (1 - lp) ** 3;
      s.style.opacity = lp; s.style.transform = `translateY(${(1 - e) * 120}%) scale(${0.7 + 0.3 * e}, ${2.3 - 1.3 * e})`;
    });
    if (still()) { apply(1); return undefined; }
    let raf = 0;
    const update = () => { raf = 0; const r = el.getBoundingClientRect(); apply(clamp01((innerHeight * 0.92 - r.top) / (innerHeight * 0.42))); };
    const on = () => { if (!raf) raf = requestAnimationFrame(update); };
    update(); addEventListener('scroll', on, { passive: true }); addEventListener('resize', on);
    return () => { cancelAnimationFrame(raf); removeEventListener('scroll', on); removeEventListener('resize', on); };
  }, []);
  return <span ref={ref} role="text" aria-label={text} className={`sf ${className}`.trim()}>{words(text, 'sf-word', 'sfl')}</span>;
}

/** Scroll Reveal: words unblur and brighten one by one as the text scrolls into view. */
export function ScrollReveal({ text, className = '' }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current, items = [...el.querySelectorAll('.srw')], n = items.length;
    const apply = (p) => items.forEach((s, i) => {
      const wp = clamp01(p * (1 + n * 0.35) - i * 0.35);
      s.style.opacity = 0.12 + 0.88 * wp; s.style.filter = `blur(${((1 - wp) * 5).toFixed(2)}px)`;
    });
    if (still()) { apply(1); return undefined; }
    let raf = 0;
    const update = () => { raf = 0; const r = el.getBoundingClientRect(); apply(clamp01((innerHeight * 0.95 - r.top) / (innerHeight * 0.4))); };
    const on = () => { if (!raf) raf = requestAnimationFrame(update); };
    update(); addEventListener('scroll', on, { passive: true }); addEventListener('resize', on);
    return () => { cancelAnimationFrame(raf); removeEventListener('scroll', on); removeEventListener('resize', on); };
  }, []);
  return <span ref={ref} role="text" aria-label={text} className={className}>{words(text, 'sr-word', 'srw')}</span>;
}
