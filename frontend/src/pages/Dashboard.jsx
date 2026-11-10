import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import AnimatedList from '../components/AnimatedList.jsx';
import HoldButton from '../components/HoldButton.jsx';
import { Loading } from '../components/Status.jsx';
import { addWebsite, listWebsites, removeWebsite } from '../services/api.js';
import '../dashboard.css';

// Illustrative only, and labelled as such on the page. Real numbers come from a scan.
const MATCHES = [
  { site: 'clone-saas.io', part: 'Pricing page copy', pct: 94 },
  { site: 'rival-app.com', part: 'Feature section', pct: 81 },
  { site: 'copycat.dev', part: 'Hero headline', pct: 67 },
];

const CAPS = [
  { n: '01', icon: 'search', title: 'Scan a site', text: 'Point it at a URL. It crawls the pages you can reach and reads the text.' },
  { n: '02', icon: 'chart', title: 'See the overlap', text: 'Passages are compared against your pages and scored by how much matches.' },
  { n: '03', icon: 'image', title: 'Check the evidence', text: 'Each match opens beside the original, with the screenshot of where it was found.' },
  { n: '04', icon: 'doc', title: 'Keep the report', text: 'Matches, pages and evidence stay together in a report you can export.' },
];

const PRIVATE = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|\[::1\]|::1)/i;

/** Returns a normalized URL string or null if invalid. Mirrors the server's rules. */
function normalizeUrl(input) {
  const v = input.trim();
  if (!v) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    if (!u.hostname.includes('.') || PRIVATE.test(u.hostname)) return null;
    return u.href;
  } catch { return null; }
}

/** A drawn report fragment: the page that was crawled, with the matched passage lit.
    Inline SVG on purpose, so it renders with the page and needs no image request. */
function ReportPreview() {
  return (
    <div className="db-preview">
      <svg className="db-preview-art" viewBox="0 0 560 180" role="img" aria-label="A crawled page with the matched passage highlighted next to the text it copied">
        <rect x="0" y="0" width="252" height="180" rx="10" fill="rgba(255,255,255,.04)" stroke="rgba(255,255,255,.12)" />
        <rect x="16" y="16" width="60" height="7" rx="3.5" fill="rgba(255,255,255,.22)" />
        <rect x="16" y="34" width="150" height="5" rx="2.5" fill="rgba(255,255,255,.12)" />
        <rect x="16" y="46" width="120" height="5" rx="2.5" fill="rgba(255,255,255,.12)" />
        <rect x="16" y="66" width="220" height="5" rx="2.5" fill="rgba(255,255,255,.09)" />
        <rect x="16" y="78" width="196" height="5" rx="2.5" fill="rgba(255,255,255,.09)" />
        <rect x="12" y="94" width="228" height="34" rx="6" fill="rgba(139,92,246,.28)" stroke="rgba(196,181,253,.7)" />
        <rect x="20" y="104" width="180" height="5" rx="2.5" fill="rgba(240,236,255,.85)" />
        <rect x="20" y="115" width="140" height="5" rx="2.5" fill="rgba(240,236,255,.6)" />
        <rect x="16" y="142" width="204" height="5" rx="2.5" fill="rgba(255,255,255,.09)" />
        <rect x="16" y="154" width="168" height="5" rx="2.5" fill="rgba(255,255,255,.09)" />
        <path d="M262 111 h28" stroke="rgba(196,181,253,.75)" strokeWidth="2" strokeDasharray="4 4" />
        <rect x="300" y="0" width="260" height="180" rx="10" fill="rgba(139,92,246,.06)" stroke="rgba(196,181,253,.35)" />
        <rect x="316" y="16" width="72" height="18" rx="9" fill="rgba(139,92,246,.3)" />
        <text x="327" y="29" fill="#e6dcff" fontSize="11" fontFamily="inherit">94% match</text>
        <rect x="316" y="46" width="228" height="5" rx="2.5" fill="rgba(255,255,255,.12)" />
        <rect x="316" y="58" width="200" height="5" rx="2.5" fill="rgba(255,255,255,.12)" />
        <rect x="316" y="70" width="212" height="5" rx="2.5" fill="rgba(255,255,255,.12)" />
        <rect x="316" y="96" width="228" height="3" rx="1.5" fill="rgba(255,255,255,.1)" />
        <rect x="316" y="96" width="214" height="3" rx="1.5" fill="#a78bfa" />
        <text x="316" y="126" fill="#8b88a0" fontSize="11" fontFamily="inherit">pricing page · found 2 days ago</text>
        <rect x="316" y="140" width="228" height="26" rx="6" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.1)" />
        <text x="328" y="157" fill="#cfc9e4" fontSize="11" fontFamily="inherit">Open beside the original</text>
      </svg>
    </div>
  );
}

/** The method, drawn: a page is read, the passages are set side by side, the finding is kept. */
function MethodFlow() {
  return (
    <svg className="db-flow" viewBox="0 0 1120 168" role="img"
      aria-label="A page is crawled, its passages are set beside yours, and the finding is kept with the screenshot">
      <g fill="none" stroke="rgba(255,255,255,.14)">
        <rect x="1" y="1" width="320" height="166" rx="12" fill="rgba(255,255,255,.025)" />
        <rect x="377" y="1" width="366" height="166" rx="12" fill="rgba(255,255,255,.025)" />
        <rect x="799" y="1" width="320" height="166" rx="12" fill="rgba(139,92,246,.08)" stroke="rgba(196,181,253,.3)" />
      </g>
      <text x="25" y="34" fill="#8b88a0" fontSize="11" fontFamily="inherit" letterSpacing="1.6">SCAN</text>
      <text x="401" y="34" fill="#8b88a0" fontSize="11" fontFamily="inherit" letterSpacing="1.6">COMPARE</text>
      <text x="823" y="34" fill="#b9a3ff" fontSize="11" fontFamily="inherit" letterSpacing="1.6">KEEP</text>

      <g fill="rgba(255,255,255,.16)">
        <rect x="25" y="52" width="72" height="6" rx="3" />
        <rect x="25" y="70" width="240" height="4" rx="2" opacity=".6" />
        <rect x="25" y="82" width="196" height="4" rx="2" opacity=".6" />
        <rect x="25" y="100" width="252" height="4" rx="2" opacity=".35" />
        <rect x="25" y="112" width="212" height="4" rx="2" opacity=".35" />
      </g>
      <rect x="21" y="124" width="204" height="26" rx="5" fill="rgba(139,92,246,.26)" stroke="rgba(196,181,253,.6)" />

      <g fill="rgba(255,255,255,.14)">
        <rect x="401" y="52" width="150" height="4" rx="2" />
        <rect x="401" y="64" width="132" height="4" rx="2" opacity=".6" />
        <rect x="401" y="76" width="144" height="4" rx="2" opacity=".6" />
        <rect x="401" y="94" width="150" height="4" rx="2" opacity=".3" />
        <rect x="401" y="106" width="118" height="4" rx="2" opacity=".3" />
      </g>
      <g fill="rgba(255,255,255,.14)">
        <rect x="581" y="52" width="140" height="4" rx="2" />
        <rect x="581" y="64" width="150" height="4" rx="2" opacity=".6" />
        <rect x="581" y="76" width="120" height="4" rx="2" opacity=".6" />
        <rect x="581" y="94" width="144" height="4" rx="2" opacity=".3" />
        <rect x="581" y="106" width="132" height="4" rx="2" opacity=".3" />
      </g>
      <path d="M401 128 h150" stroke="#a78bfa" strokeWidth="2" strokeDasharray="5 5" />
      <path d="M581 128 h140" stroke="#a78bfa" strokeWidth="2" strokeDasharray="5 5" />
      <text x="401" y="152" fill="#cfc9e4" fontSize="11" fontFamily="inherit">same passage, two sites</text>

      <g fill="rgba(255,255,255,.18)">
        <rect x="823" y="52" width="60" height="18" rx="9" fill="rgba(139,92,246,.34)" />
      </g>
      <text x="835" y="65" fill="#e6dcff" fontSize="11" fontFamily="inherit">94%</text>
      <g fill="rgba(255,255,255,.16)">
        <rect x="823" y="84" width="248" height="4" rx="2" opacity=".7" />
        <rect x="823" y="96" width="212" height="4" rx="2" opacity=".5" />
      </g>
      <rect x="823" y="112" width="248" height="3" rx="1.5" fill="rgba(255,255,255,.12)" />
      <rect x="823" y="112" width="234" height="3" rx="1.5" fill="#a78bfa" />
      <text x="823" y="140" fill="#b9a3ff" fontSize="11" fontFamily="inherit">passage · page · screenshot</text>
    </svg>
  );
}

export default function Dashboard() {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sites, setSites] = useState(null);
  const [sitesError, setSitesError] = useState('');
  const [removing, setRemoving] = useState('');
  const navigate = useNavigate();

  const loadSites = useCallback(() => {
    setSitesError('');
    listWebsites().then(setSites).catch((e) => setSitesError(e.message));
  }, []);
  useEffect(loadSites, [loadSites]);

  // The page's one moment, driven by the kit's own runtime (public/moments).
  useEffect(() => {
    if (window.__momentsLoaded) return;
    window.__momentsLoaded = true;
    const base = import.meta.env.BASE_URL;
    import(/* @vite-ignore */ `${base}moments/moments.js`).catch(() => {});
  }, []);

  async function onRemove(site) {
    const label = site.url || site.domain;
    setRemoving(site.id);
    setSitesError('');
    try {
      await removeWebsite(site.id);
      setSites(await listWebsites());
    } catch (e) {
      setSitesError(e.message || 'Could not remove this site.');
    } finally {
      setRemoving('');
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    const url = normalizeUrl(value);
    if (!url) return setError('Enter a public website URL, for example example.com.');
    setError(''); setBusy(true);
    try {
      // The backend allows one "original" website per workspace; every later site
      // is the one it gets compared against. The UI has to say which it is, or a
      // second URL would be rejected and no scan could ever run.
      let hasOriginal = Array.isArray(sites) && sites.some((s) => s.kind === 'original');
      if (!Array.isArray(sites)) {
        try { hasOriginal = (await listWebsites()).some((s) => s.kind === 'original'); } catch { /* fall through */ }
      }
      const { website } = await addWebsite(url, { kind: hasOriginal ? 'comparison' : 'original' });
      navigate(`/scan/${website.id}`, { state: { url } });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const hasOriginal = Array.isArray(sites) && sites.some((s) => s.kind === 'original');

  return (
    <>
      {/* One screen: the hero stands alone, nothing of the next section on load. */}
      <section className="db-hero" aria-labelledby="hero-h">
        <div className="wrap db-hero-wrap">
          <div className="hero-text">
          <p className="db-lock">
            <span>SaaS Shield</span>
            <em>Content copying detector</em>
          </p>

          <div className="db-hero-split">
            <div className="db-hero-l">
              <h1 id="hero-h" className="db-h1">Catch <em>copycats.</em><br />Keep the proof.</h1>
              <p className="db-sub">
                Scan a site, compare its pages against yours, and keep the matching passages in one report.
              </p>
              <p className="db-facts">
                Reads up to 25 pages per scan · Runs in your browser · Exports to PDF
              </p>
              <ReportPreview />
            </div>

            <div className="db-hero-r">
              <div className="db-field">
                <label className="db-label" htmlFor="url">Website to scan</label>
                <form className="db-compose" onSubmit={onSubmit} noValidate>
                  <span className="db-compose-icon" aria-hidden="true"><Icon name="link" size={20} /></span>
                  <input id="url" className="db-input" type="text" inputMode="url" autoComplete="url"
                    placeholder="example.com or https://…" value={value} onChange={(e) => setValue(e.target.value)}
                    aria-invalid={!!error} aria-describedby={error ? 'url-error' : undefined} disabled={busy} />
                  <button className="db-btn" type="submit" disabled={busy}>
                    {busy ? <><span className="spinner" aria-hidden="true" /> Scanning…</> : <>Start scan <Icon name="arrow" size={16} /></>}
                  </button>
                </form>
              </div>

              {error
                ? <p id="url-error" className="db-error" role="alert">{error}</p>
                : (
                  <p className="db-hint">
                    {hasOriginal
                      ? 'This URL will be compared against your website.'
                      : 'Start with your own website, then add a site to check against it.'}
                  </p>
                )}

              <ul className="db-signals">
                <li><Icon name="image" size={16} /><span>Screenshot of the page each match was found on</span></li>
                <li><Icon name="doc" size={16} /><span>The matching passage kept beside the original</span></li>
                <li><Icon name="download" size={16} /><span>One PDF report, ready to send</span></li>
              </ul>
            </div>
          </div>
          </div>
        </div>
      </section>

      {/* One screen for the work: what you have on the left, what a finding looks like on the right. */}
      <section className="db-band db-work-band" aria-labelledby="sites-h">
        <div className="wrap db-work-grid">
          <div className="db-work-main">
            <h2 id="sites-h">Your websites</h2>
            <p className="db-sec-note">
              The first site you add becomes your original. Add a second to check against it.
            </p>
            {sitesError ? <p className="db-error" role="alert">{sitesError}</p>
              : !sites ? <p className="db-quiet"><Loading label="Loading websites…" /></p>
              : sites.length === 0 ? (
                <p className="db-empty">No websites yet. Add one above to start the first check.</p>
              ) : (
                <ul className="db-sites">
                  {sites.map((s) => (
                    <li key={s.id} className="db-site">
                      <Link className="db-site-link" to={`/scan/${s.id}`}>
                        <b>{s.url || s.domain}</b>
                        <small>
                          <span className={`db-kind ${s.kind === 'original' ? 'is-own' : ''}`}>
                            {s.kind === 'original' ? 'Your site' : 'Comparison'}
                          </span>
                          {' · '}{s.status}
                        </small>
                      </Link>
                      <HoldButton
                        className="db-remove"
                        onConfirm={() => onRemove(s)}
                        busy={removing === s.id}
                        ariaLabel={`Hold to remove ${s.url || s.domain}`}
                      >
                        {removing === s.id ? 'Removing…' : 'Hold to remove'}
                      </HoldButton>
                    </li>
                  ))}
                </ul>
              )}
            <Link className="db-sec-link db-work-link" to="/history">All reports <Icon name="arrow" size={14} /></Link>
          </div>

          <div className="db-work-side">
            <div className="db-side-h">
              <h3>Example result</h3>
              <span className="db-count">{MATCHES.length} matches</span>
            </div>
            <p className="db-sec-note">
              A match opens beside the original: the passage, how much of it matches, and the page it was found on.
            </p>
            <div className="db-mock" aria-hidden="true">
              <div className="db-mock-h">
                <span className="db-mock-pill"><Icon name="alert" size={12} /> 94% match</span>
                <span className="db-mock-host">clone-saas.io/pricing</span>
              </div>
              <p className="db-mock-q">“Kick off in minutes with dashboards built for teams.”</p>
              <div className="db-mock-bar"><i /></div>
              <p className="db-mock-foot"><Icon name="image" size={13} /> pricing.html · found 2 days ago</p>
            </div>
            <div className="db-ex-list">
              <AnimatedList className="db-ex" items={MATCHES} getKey={(m) => m.site} label="Example matches" renderItem={(m, i) => (
                <>
                  <b className="db-ex-site">{m.site}</b>
                  <em className="db-ex-pct">{m.pct}%</em>
                  <small className="db-ex-part">{m.part}</small>
                  <span className="db-ex-bar" role="presentation" style={{ '--i': i }}><i style={{ '--w': `${m.pct}%` }} /></span>
                </>
              )} />
            </div>
          </div>
        </div>
      </section>

      {/* One screen for the method and the close. */}
      <section className="db-band db-why" id="features" aria-labelledby="caps-h">
        <div className="wrap db-why-wrap">
          <h2 id="caps-h">What it does</h2>
          <div className="db-caps-grid">
            {CAPS.map((c) => (
              <article key={c.n} className="db-cap">
                <span className="db-cap-icon"><Icon name={c.icon} size={20} /></span>
                <b>{c.n}</b>
                <h3>{c.title}</h3>
                <p>{c.text}</p>
              </article>
            ))}
          </div>

          <div className="db-statement-hold" data-moment="word-highlight">
            <p className="db-statement">
              A scan reads a site&#39;s pages, keeps the passage that matched, and the screenshot of the page it came from.
            </p>
          </div>

          <MethodFlow />

          <div className="db-close-row">
            <button className="db-cta" type="button" onClick={() => document.getElementById('url')?.focus()}>
              Run a scan <Icon name="arrow" size={16} />
            </button>
            <span className="db-close-meta"><Icon name="download" size={16} /> A PDF per report, with the screenshots</span>
          </div>
        </div>
      </section>
    </>
  );
}
