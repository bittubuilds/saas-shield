import { useEffect, useRef, useState } from 'react';

/** Count Up: eases from 0 to the real value once, when it becomes visible. Non-numbers render untouched. */
export default function CountUp({ to, duration = 1200, className = '' }) {
  const isNum = typeof to === 'number' && Number.isFinite(to);
  const ref = useRef(null);
  const played = useRef(false);
  const [shown, setShown] = useState(isNum ? 0 : to);
  useEffect(() => {
    if (!isNum) { setShown(to); return undefined; }
    const el = ref.current;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (still || played.current) { setShown(to); return undefined; }
    let raf = 0;
    const run = () => {
      played.current = true;
      const t0 = performance.now();
      const step = (now) => {
        const p = Math.min(1, (now - t0) / duration);
        setShown(Math.round(to * (1 - (1 - p) ** 3)));
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting && !played.current) { run(); io.disconnect(); } }, { threshold: 0.4 });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [to, isNum, duration]);
  // Always show the true value to assistive tech; the ticking number is decoration.
  return <span ref={ref} className={className}><span className="sr-only">{String(to)}</span><span aria-hidden="true">{isNum ? shown : to}</span></span>;
}
