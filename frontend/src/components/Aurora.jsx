import { useEffect, useRef } from 'react';
import { createAurora } from './aurora.js';

/** Hero background. The CSS gradient on .aurora is the static fallback (no WebGL, reduced motion, slow load). */
export default function Aurora({ colorStops, amplitude, blend, speed, className = '' }) {
  const ref = useRef(null);
  useEffect(() => createAurora(ref.current, { colorStops, amplitude, blend, speed }), [colorStops, amplitude, blend, speed]);
  return <div className={`aurora ${className}`.trim()} aria-hidden="true"><canvas ref={ref} /></div>;
}
