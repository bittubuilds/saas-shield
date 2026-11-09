/**
 * The "Example result" panel from the approved preview: three matched passages with
 * their similarity bars. It is explicitly an example, never presented as the user's
 * own scan data, and it only appears while the workspace has no websites yet.
 */
const EXAMPLES = [
  { site: 'clone-saas.io', pct: 94, part: 'Pricing page copy' },
  { site: 'rival-app.com', pct: 81, part: 'Feature section' },
  { site: 'copycat.dev', pct: 67, part: 'Hero headline' },
];

export default function ExampleResult({ rows = EXAMPLES, className = '' }) {
  return (
    <div className={`scan-report ${className}`.trim()} role="group" aria-label="Example scan result">
      <div className="sr-head">
        <span>Example result</span>
        <span>{rows.length} matches found</span>
      </div>
      <ul className="sr-list">
        {rows.map((r) => (
          <li key={r.site} className="sr-row">
            <b className="sr-site">{r.site}</b>
            <em className="sr-pct">{r.pct}%</em>
            <small className="sr-part">{r.part}</small>
            <span className="sr-bar" aria-hidden="true"><i style={{ '--w': `${r.pct}%` }} /></span>
          </li>
        ))}
      </ul>
    </div>
  );
}
