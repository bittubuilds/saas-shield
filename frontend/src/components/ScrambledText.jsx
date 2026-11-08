import { useLayoutEffect, useRef } from 'react';
import { attachScramble } from './scramble.js';

/** Paragraph that resolves from scrambled symbols into text and re-scrambles near the pointer. */
export default function ScrambledText({ text, className = '' }) {
  const ref = useRef(null);
  useLayoutEffect(() => attachScramble(ref.current), []);
  return (
    <p ref={ref} className={className} aria-label={text}>
      {text.split(' ').map((w, wi) => (
        <span key={wi}>
          <span className="sc-word">{[...w].map((c, ci) => <span key={ci} className="sc" aria-hidden="true">{c}</span>)}</span>{' '}
        </span>
      ))}
    </p>
  );
}
