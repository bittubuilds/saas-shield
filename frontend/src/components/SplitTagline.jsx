/**
 * Hero tagline ported from the approved premium preview: each character rises into
 * place with a short stagger. The accessible name is the whole sentence, and the
 * letters are hidden from assistive tech so the tagline is not spelled out.
 */
export default function SplitTagline({ text, className = '' }) {
  const chars = [...text];
  return (
    <p className={`split-tag ${className}`.trim()} aria-label={text}>
      {chars.map((c, i) => (
        <span key={i} className="split-part" aria-hidden="true" style={{ '--i': i }}>
          {c === ' ' ? '\u00a0' : c}
        </span>
      ))}
    </p>
  );
}
