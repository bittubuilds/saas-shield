// Letter bounce: letters drop away with a random spin, then spring back into place (lavender mid-flight).
// attachLetterBounce(root) expects `.lb` letter elements inside root; returns a cleanup function.
// Plays once on load (letters spring up into place) and again on hover or tap.
const LAV = '#c4b5fd';

export function attachLetterBounce(root) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};
  const letters = [...root.querySelectorAll('.lb')];
  let busy = false;

  const play = (intro) => {
    if (busy) return;
    busy = true;
    const runs = letters.map((el, i) => {
      const away = `translateY(${(1.3 + Math.random() * 1.4).toFixed(2)}em) rotate(${((Math.random() - 0.5) * 110).toFixed(0)}deg)`;
      const settle = [
        { transform: 'translateY(-.12em) rotate(0deg)', opacity: 1, offset: intro ? 0.7 : 0.85 },
        { transform: 'none', offset: 1 },
      ];
      const frames = intro
        ? [{ transform: away, color: LAV, opacity: 0, offset: 0, easing: 'cubic-bezier(.2,.8,.3,1)' }, ...settle]
        : [
            { transform: 'none', offset: 0, easing: 'cubic-bezier(.5,0,1,.5)' },
            { transform: away, color: LAV, opacity: 0, offset: 0.35, easing: 'cubic-bezier(.2,.8,.3,1)' },
            ...settle,
          ];
      return el.animate(frames, { duration: intro ? 1100 : 1700, delay: i * 16, fill: 'backwards' }).finished;
    });
    Promise.allSettled(runs).then(() => { busy = false; });
  };

  const onEnter = () => play(false);
  root.addEventListener('pointerenter', onEnter);
  root.addEventListener('click', onEnter);
  play(true);
  return () => {
    root.removeEventListener('pointerenter', onEnter);
    root.removeEventListener('click', onEnter);
    root.getAnimations({ subtree: true }).forEach((a) => a.cancel());
  };
}
