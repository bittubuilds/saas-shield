// Scrambled text: characters start as scrambled symbols and resolve into the real text left to right.
// Moving the pointer near the text re-scrambles nearby characters, which then settle again.
// attachScramble(root) expects `.sc` character elements inside root; returns a cleanup function.
// Each character box is locked to its real width so the layout never shifts while scrambled.
const SET = '.:;,+*';

export function attachScramble(root, { radius = 100, duration = 1 } = {}) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};
  const chars = [...root.querySelectorAll('.sc')].map((el) => ({ el, ch: el.textContent, until: 0, swap: 0 }));
  const rnd = () => SET[(Math.random() * SET.length) | 0];
  let raf = 0, pointer = null, alive = true;

  const tick = (now) => {
    raf = 0;
    if (!alive) return;
    if (pointer) {
      for (const c of chars) {
        const r = c.el.getBoundingClientRect();
        const d = Math.hypot(pointer.x - (r.left + r.width / 2), pointer.y - (r.top + r.height / 2));
        if (d < radius) {
          const t = now + 150 + duration * 600 * (1 - d / radius);
          if (t > c.until) c.until = t;
        }
      }
    }
    let active = false;
    for (const c of chars) {
      if (now < c.until) {
        active = true;
        if (now - c.swap > 55) { c.el.textContent = rnd(); c.swap = now; }
      } else if (c.el.textContent !== c.ch) {
        c.el.textContent = c.ch;
      }
    }
    if (active || pointer) raf = requestAnimationFrame(tick);
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };

  const lock = () => {
    chars.forEach((c) => { c.el.style.width = ''; c.el.textContent = c.ch; });
    const widths = chars.map((c) => c.el.getBoundingClientRect().width);
    chars.forEach((c, i) => { c.el.style.width = `${widths[i]}px`; c.swap = 0; });
    tick(performance.now());
  };

  const onMove = (e) => {
    const r = root.getBoundingClientRect();
    const near = e.clientX > r.left - radius && e.clientX < r.right + radius && e.clientY > r.top - radius && e.clientY < r.bottom + radius;
    pointer = near ? { x: e.clientX, y: e.clientY } : null;
    if (near) kick();
  };
  const onUp = (e) => { if (e.pointerType !== 'mouse') pointer = null; };
  const onLeave = () => { pointer = null; };

  // Intro: everything starts scrambled, then resolves left to right with a little jitter.
  const t0 = performance.now();
  chars.forEach((c, i) => { c.until = t0 + 350 + i * 14 + Math.random() * 350; c.el.textContent = rnd(); });
  lock();

  const ro = new ResizeObserver(lock);
  ro.observe(root);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => alive && lock());
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerup', onUp, { passive: true });
  window.addEventListener('pointercancel', onUp, { passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);
  kick();

  return () => {
    alive = false; cancelAnimationFrame(raf); ro.disconnect();
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    document.documentElement.removeEventListener('pointerleave', onLeave);
    chars.forEach((c) => { c.el.textContent = c.ch; c.el.style.width = ''; });
  };
}
