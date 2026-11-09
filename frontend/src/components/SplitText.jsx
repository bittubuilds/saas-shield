import { useEffect, useRef, useState } from 'react';

/** Split Text: characters (or words) rise and fade in, staggered. Plays once, when it scrolls into view. */
export default function SplitText({ text, by = 'char', delay = 28, className = '', as: Tag = 'p' }) {
  const ref = useRef(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) { setOn(true); return undefined; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setOn(true); io.disconnect(); } }, { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const parts = by === 'word' ? text.split(' ') : [...text];
  return (
    <Tag ref={ref} className={`split ${on ? 'is-in' : ''} ${className}`.trim()} aria-label={text}>
      {parts.map((p, i) => (
        <span key={i} className="split-part" aria-hidden="true" style={{ '--i': i, '--d': `${delay}ms` }}>{p === ' ' ? '\u00A0' : p}{by === 'word' && i < parts.length - 1 ? '\u00A0' : ''}</span>
      ))}
    </Tag>
  );
}
