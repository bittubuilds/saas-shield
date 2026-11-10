import { useEffect, useRef, useState } from 'react';

/**
 * Animated List (React Bits behaviour, dependency-free): rows spring into view in a stagger,
 * a single selection glides between rows, and the arrow keys move it.
 * renderItem(item, index) draws the row body. Entrance plays once, when the list scrolls into view.
 */
export default function AnimatedList({ items, renderItem, getKey = (it, i) => i, label, className = '', stagger = 90 }) {
  const box = useRef(null);
  const rows = useRef([]);
  const [shown, setShown] = useState(false);
  const [active, setActive] = useState(-1);
  const [glide, setGlide] = useState({ y: 0, h: 0 });

  useEffect(() => {
    const el = box.current;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) { setShown(true); return undefined; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setShown(true); io.disconnect(); } }, { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Park the selection behind the active row.
  useEffect(() => {
    const r = rows.current[active];
    if (r) setGlide({ y: r.offsetTop, h: r.offsetHeight });
  }, [active, items]);

  const onKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    setActive((a) => (e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
      : e.key === 'ArrowDown' ? Math.min(items.length - 1, a + 1) : Math.max(0, a < 0 ? 0 : a - 1)));
  };

  // Rows animate from here, not from a hidden CSS state: with scripts off, or with
  // motion turned down, the list is simply there and readable.
  useEffect(() => {
    if (!shown || !box.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    box.current.querySelectorAll('.alist-row').forEach((el, i) => {
      el.animate(
        [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
        { duration: 520, delay: i * stagger, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'both' },
      );
    });
  }, [shown, stagger]);

  return (
    <ul ref={box} className={`alist ${shown ? 'is-in' : ''} ${className}`.trim()} role="listbox" aria-label={label}
      aria-activedescendant={active >= 0 ? `alist-${active}` : undefined} tabIndex={0}
      onKeyDown={onKey} onFocus={() => setActive((a) => (a < 0 ? 0 : a))} onBlur={() => setActive(-1)}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse' && document.activeElement !== box.current) setActive(-1); }}>
      <li className={`alist-glide ${active >= 0 ? 'on' : ''}`} aria-hidden="true" style={{ transform: `translateY(${glide.y}px)`, height: glide.h }} />
      {items.map((it, i) => (
        <li key={getKey(it, i)} id={`alist-${i}`} role="option" aria-selected={active === i} ref={(n) => { rows.current[i] = n; }}
          className="alist-row" style={{ '--i': i, '--s': `${stagger}ms` }}
          onPointerEnter={(e) => { if (e.pointerType === 'mouse') setActive(i); }} onPointerDown={() => setActive(i)}>
          {renderItem(it, i)}
        </li>
      ))}
    </ul>
  );
}
