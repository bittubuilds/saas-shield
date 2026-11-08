import { useEffect, useRef } from 'react';

/**
 * "SAAS SHIELD" rendered with the Shatter Type port already in this repo
 * (public/shatter.c824b1d1.js): the wordmark assembles from glass shards,
 * opens hairline cracks under the cursor and bursts on click.
 * The port is loaded once, lazily, and unmounted cleanly.
 */
let loading = null;
function loadPort() {
  if (window.ShatterType) return Promise.resolve(window.ShatterType);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${import.meta.env.BASE_URL}shatter.c824b1d1.js`;
    s.async = true;
    s.onload = () => (window.ShatterType ? resolve(window.ShatterType) : reject(new Error('shatter port missing')));
    s.onerror = () => reject(new Error('shatter port failed to load'));
    document.head.appendChild(s);
  });
  return loading;
}

export default function ShatterWordmark({ text = 'SAAS SHIELD', className = '' }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let handle = null;
    let cancelled = false;
    el.textContent = text;
    loadPort().then((port) => {
      if (cancelled || !ref.current) return;
      handle = port.mount(el, {
        fontWeight: 900,
        align: 'center',
        letterSpacing: '-0.02em',
        shardSize: 0.075,
        irregularity: 0.6,
        crack: 0.6,
        heal: 0.9,
        shatter: true,
        autoplay: true,
        autoplayInterval: 6,
        intro: 'assemble',
        introDuration: 1.5,
        accentColor: '#a78bfa',
      });
    }).catch(() => {});
    return () => {
      cancelled = true;
      if (handle && handle.destroy) handle.destroy();
      if (ref.current) ref.current.textContent = text;
    };
  }, [text]);

  return <div ref={ref} className={`wordmark ${className}`.trim()}>{text}</div>;
}
