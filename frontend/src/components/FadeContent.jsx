import { useEffect, useRef, useState } from 'react';

/** Fade Content: blur-to-clear reveal with a small rise, once, on viewport entry. */
export default function FadeContent({ children, className = '', as: Tag = 'div', delay = 0, ...rest }) {
  const ref = useRef(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) { setOn(true); return undefined; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setOn(true); io.disconnect(); } }, { threshold: 0.12 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <Tag ref={ref} className={`fade-content ${on ? 'is-in' : ''} ${className}`.trim()} style={{ '--fd': `${delay}ms` }} {...rest}>{children}</Tag>;
}
