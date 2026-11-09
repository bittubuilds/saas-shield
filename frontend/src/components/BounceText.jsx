import { useLayoutEffect, useRef } from 'react';
import { attachLetterBounce } from './letterBounce.js';

/** Inline text whose letters bounce away and spring back on hover or tap (reuses letterBounce.js). */
export default function BounceText({ text, className = '' }) {
  const ref = useRef(null);
  useLayoutEffect(() => attachLetterBounce(ref.current), []);
  return (
    <span ref={ref} role="text" aria-label={text} className={className}>
      <span aria-hidden="true">
        {text.split(' ').map((w, wi, all) => (
          <span key={wi}><span className="lb-word">{[...w].map((c, ci) => <span key={ci} className="lb" aria-hidden="true">{c}</span>)}</span>{wi < all.length - 1 ? ' ' : ''}</span>
        ))}
      </span>
    </span>
  );
}
