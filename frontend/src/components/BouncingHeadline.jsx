import { useLayoutEffect, useRef } from 'react';
import { attachLetterBounce } from './letterBounce.js';

/**
 * Hero headline whose letters bounce. parts: [{ text, accent? }]. Accent parts render inside <em>.
 * Screen readers get the full text via aria-label; the split letters are hidden from them.
 */
export default function BouncingHeadline({ parts }) {
  const ref = useRef(null);
  useLayoutEffect(() => attachLetterBounce(ref.current), []);
  const label = parts.map((p) => p.text).join(' ');
  const words = (text) => text.split(' ').map((w, wi) => (
    <span key={wi}>
      <span className="lb-word">{[...w].map((c, ci) => <span key={ci} className="lb" aria-hidden="true">{c}</span>)}</span>{' '}
    </span>
  ));
  return (
    <h1 ref={ref} aria-label={label}>
      {parts.map((p, i) => (p.accent ? <em key={i}>{words(p.text)}</em> : <span key={i}>{words(p.text)}</span>))}
    </h1>
  );
}
