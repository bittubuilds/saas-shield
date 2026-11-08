import { useEffect, useRef } from 'react';
import { createSilk } from './silk.js';

/** Decorative WebGL background. Fills its positioned parent; ignores pointer events itself. */
export default function SilkBackground({ color = '#5227ff', speed = 1, interactive = true, className = '' }) {
  const ref = useRef(null);
  useEffect(() => createSilk(ref.current, { color, speed, interactive }), [color, speed, interactive]);
  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
