import { useEffect, useRef, useState } from 'react';

/**
 * SAAS SHIELD brand wordmark with a shatter/regather cycle.
 *
 * The glyphs are rasterised once into an offscreen canvas, sampled into particles,
 * and those particles scatter outward and fly back on a single requestAnimationFrame
 * loop. Nothing here touches the existing text animations: this is a separate canvas
 * that draws the brand text itself.
 */
const HOLD_MS = 1500;   // fully assembled, readable
const BREAK_MS = 1300;  // fragments scatter
const RETURN_MS = 1500; // fragments fly home
const CYCLE = HOLD_MS + BREAK_MS + RETURN_MS;

const easeOut = (t) => 1 - (1 - t) ** 3;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export default function BrandShatter({ text = 'SAAS SHIELD' }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [staticMode, setStaticMode] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return undefined;

    const reduced = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { setStaticMode(true); return undefined; }

    const ctx = canvas.getContext('2d');
    if (!ctx) { setStaticMode(true); return undefined; }

    let particles = [];
    let width = 0;
    let height = 0;
    let raf = 0;
    let started = performance.now();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    function sample() {
      const rect = wrap.getBoundingClientRect();
      width = Math.max(240, Math.floor(rect.width));
      height = Math.max(96, Math.min(240, Math.round(width * 0.2)));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const off = document.createElement('canvas');
      off.width = Math.floor(width * dpr);
      off.height = Math.floor(height * dpr);
      const octx = off.getContext('2d');
      if (!octx) return;
      octx.scale(dpr, dpr);
      octx.textAlign = 'center';
      octx.textBaseline = 'middle';
      // Scale the wordmark to the available width without letting it clip.
      let size = height * 0.82;
      octx.font = `900 ${size}px Inter, "Segoe UI", system-ui, sans-serif`;
      const measured = octx.measureText(text).width;
      if (measured > width * 0.94) {
        size *= (width * 0.94) / measured;
        octx.font = `900 ${size}px Inter, "Segoe UI", system-ui, sans-serif`;
      }
      octx.fillStyle = '#ffffff';
      octx.fillText(text, width / 2, height / 2);

      const { data } = octx.getImageData(0, 0, off.width, off.height);
      const gap = Math.max(3, Math.round(size / 30));
      particles = [];
      for (let y = 0; y < off.height; y += gap) {
        for (let x = 0; x < off.width; x += gap) {
          if (data[(y * off.width + x) * 4 + 3] > 140) {
            particles.push({
              hx: x / dpr,
              hy: y / dpr,
              angle: Math.random() * Math.PI * 2,
              speed: 0.35 + Math.random() * 0.9,
              spin: (Math.random() - 0.5) * 0.5,
              size: 1 + Math.random() * 1.6,
              accent: Math.random() < 0.14,
            });
          }
        }
      }
    }

    function frame(now) {
      const t = (now - started) % CYCLE;
      let spread = 0;
      if (t < HOLD_MS) spread = 0;
      else if (t < HOLD_MS + BREAK_MS) spread = easeOut((t - HOLD_MS) / BREAK_MS);
      else spread = 1 - easeInOut((t - HOLD_MS - BREAK_MS) / RETURN_MS);

      ctx.clearRect(0, 0, width, height);
      const reach = Math.max(width * 0.32, 90);
      for (const p of particles) {
        const dx = Math.cos(p.angle) * reach * p.speed * spread;
        const dy = Math.sin(p.angle) * reach * 0.55 * p.speed * spread;
        const alpha = 1 - 0.45 * spread;
        ctx.fillStyle = p.accent ? `rgba(167, 139, 250, ${alpha})` : `rgba(255, 255, 255, ${alpha})`;
        ctx.fillRect(p.hx + dx, p.hy + dy, p.size, p.size);
        if (spread > 0.02) {
          // A short wake keeps the fragments from reading as a static cloud.
          ctx.fillStyle = p.accent ? 'rgba(167, 139, 250, 0.18)' : 'rgba(255, 255, 255, 0.12)';
          ctx.fillRect(p.hx + dx * 0.72, p.hy + dy * 0.72, p.size, p.size);
        }
      }
      raf = window.requestAnimationFrame(frame);
    }

    let resizeTimer = 0;
    function onResize() {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => { sample(); started = performance.now(); }, 150);
    }

    sample();
    raf = window.requestAnimationFrame(frame);
    window.addEventListener('resize', onResize);

    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      particles = [];
    };
  }, [text]);

  if (staticMode) return <h2 className="brand-word-static">{text}</h2>;

  return (
    <div className="brand-shatter" ref={wrapRef}>
      <canvas ref={canvasRef} aria-hidden="true" />
      <span className="sr-only">{text}</span>
    </div>
  );
}
