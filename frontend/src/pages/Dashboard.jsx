import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import AnimatedList from '../components/AnimatedList.jsx';
import HoldButton from '../components/HoldButton.jsx';
import { ClickSpark } from '../components/bits.jsx';
import { Loading } from '../components/Status.jsx';
import { addWebsite, listWebsites, removeWebsite } from '../services/api.js';
import '../dashboard.css';

// Heavy WebGL wash: loaded after first paint, and only behind the hero band.
const Aurora = lazy(() => import('../components/Aurora.jsx'));
const AURORA_STOPS = ['#3b1a8a', '#6d28d9', '#1d4ed8'];

// Illustrative only, and labelled as such on the page. Real numbers come from a scan.
const MATCHES = [
  { site: 'clone-saas.io', part: 'Pricing page copy', pct: 94 },
  { site: 'rival-app.com', part: 'Feature section', pct: 81 },
  { site: 'copycat.dev', part: 'Hero headline', pct: 67 },
];

const CAPS = [
  { n: '01', title: 'Scan a site', text: 'Point it at a URL. It crawls the pages you can reach and reads the text.' },
  { n: '02', title: 'See the overlap', text: 'Passages are compared against your pages and scored by how much matches.' },
  { n: '03', title: 'Check the evidence', text: 'Each match opens beside the original, with the screenshot of where it was found.' },
  { n: '04', title: 'Keep the report', text: 'Matches, pages and evidence stay together in a report you can export.' },
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
      <ClickSpark scope=".db-btn" count={6} />
      <div className="db">
        <section className="db-hero">
          <div className="db-glow" aria-hidden="true">
            <Suspense fallback={null}>
              <Aurora colorStops={AURORA_STOPS} amplitude={0.7} blend={0.6} speed={0.4} />
            </Suspense>
          </div>

          <p className="db-lock">
            <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" width="26" height="30" />
            <span>SaaS Shield</span>
            <em>Content copying detector</em>
          </p>

          <h1 className="db-h1">Catch <em>copycats.</em><br />Keep the proof.</h1>
          <p className="db-sub">
            Scan a site, compare its pages against yours, and keep the matching passages in one report.
          </p>

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
        </section>

        <div className="db-work">
          <section className="db-panel" aria-labelledby="sites-h">
            <div className="db-panel-h">
              <h2 id="sites-h">Your websites</h2>
              <Link to="/history">All reports <Icon name="arrow" size={14} /></Link>
            </div>
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
          </section>

          <aside className="db-panel db-ex" aria-labelledby="ex-h">
            <div className="db-panel-h">
              <h2 id="ex-h">Example result</h2>
              <span className="db-count">{MATCHES.length} matches</span>
            </div>
            <AnimatedList className="db-ex-list" items={MATCHES} getKey={(m) => m.site} label="Example matches" renderItem={(m, i) => (
              <>
                <b className="db-ex-site">{m.site}</b>
                <em className="db-ex-pct">{m.pct}%</em>
                <small className="db-ex-part">{m.part}</small>
                <span className="db-ex-bar" role="presentation" style={{ '--i': i }}><i style={{ '--w': `${m.pct}%` }} /></span>
              </>
            )} />
            <p className="db-ex-note">Sample data, shown to explain the shape of a report. Your numbers come from a real scan.</p>
          </aside>
        </div>

        <section className="db-caps" id="features" aria-labelledby="caps-h">
          <div className="db-caps-h"><h2 id="caps-h">What it does</h2></div>
          <div className="db-caps-grid">
            {CAPS.map((c) => (
              <article key={c.n} className="db-cap">
                <b>{c.n}</b>
                <h3>{c.title}</h3>
                <p>{c.text}</p>
              </article>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
