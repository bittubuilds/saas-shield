import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import BouncingHeadline from '../components/BouncingHeadline.jsx';
import GlassIcon from '../components/GlassIcon.jsx';
import ScrambledText from '../components/ScrambledText.jsx';
import SilkBackground from '../components/SilkBackground.jsx';
import { Empty, Loading } from '../components/Status.jsx';
import { addWebsite, listWebsites, removeWebsite } from '../services/api.js';

const FEATURES = [
  { icon: 'bolt', tone: 'indigo', title: 'Smart Scanning', text: 'Automatically scan your website for competitor content.' },
  { icon: 'chart', tone: 'violet', title: 'Competitor Insights', text: 'Discover who’s copying you and how they do it.' },
  { icon: 'image', tone: 'purple', title: 'Screenshots', text: 'Capture proof with real screenshots.' },
  { icon: 'doc', tone: 'blue', title: 'Detailed Reports', text: 'Get comprehensive reports with actionable insights.' },
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
    const ok = window.confirm(`Remove ${label} from your dashboard?\n\nIt stops being scanned, but its scans, findings and reports are kept.`);
    if (!ok) return;
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
      const { website } = await addWebsite(url);
      navigate(`/scan/${website.id}`, { state: { url } });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <>
      <section className="hero" id="features">
        <SilkBackground className="silk" />
        <BouncingHeadline parts={[{ text: 'Protect Your' }, { text: 'SaaS Business with Smart Intelligence', accent: true }]} />
        <ScrambledText className="lead" text="Detect copied content, analyze competitors and get detailed insights about your SaaS product." />
        <form className="search" onSubmit={onSubmit} noValidate>
          <Icon name="link" size={24} className="search-icon" />
          <label htmlFor="url" className="sr-only">Website URL</label>
          <input id="url" type="text" inputMode="url" autoComplete="url" placeholder="Enter website URL..."
            value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={!!error}
            aria-describedby={error ? 'url-error' : undefined} disabled={busy} />
          <button className="search-btn" type="submit" aria-label="Start scan" disabled={busy}>
            {busy ? <span className="spinner" /> : <Icon name="search" size={26} />}
          </button>
        </form>
        {error && <p id="url-error" className="field-error" role="alert">{error}</p>}
      </section>

      <section className="page-narrow" aria-labelledby="sites-h">
        <div className="section-head">
          <h2 id="sites-h" className="sub-h"><span className="bar" />Your websites</h2>
        </div>
        {sitesError ? <p className="field-error" role="alert">{sitesError}</p>
          : !sites ? <Loading label="Loading websites…" />
          : sites.length === 0 ? <Empty>No websites yet. Add one above to start the first check.</Empty>
          : (
            <ul className="insights">
              {sites.map((s) => (
                <li key={s.id} className="site-row">
                  <Link className="card row" to={`/scan/${s.id}`}>
                    <h3>{s.url || s.domain}</h3>
                    <span>{s.kind === 'original' ? 'Your site' : 'Comparison'} · {s.status}</span>
                  </Link>
                  <button
                    type="button"
                    className="remove-btn"
                    onClick={() => onRemove(s)}
                    disabled={removing === s.id}
                    aria-label={`Remove ${s.url || s.domain}`}
                  >
                    {removing === s.id ? 'Removing…' : 'Remove'}
                  </button>
                </li>
              ))}
            </ul>
          )}
      </section>

      <section className="features" aria-labelledby="feat-h">
        <div className="section-head">
          <h2 id="feat-h"><span className="bar" />Powerful Features</h2>
          <Link className="btn btn-outline" to="/history">All reports <Icon name="arrow" size={16} /></Link>
        </div>
        <div className="grid">
          {FEATURES.map((f) => (
            <article className="card" key={f.title}>
              <GlassIcon icon={f.icon} tone={f.tone} />
              <h3>{f.title}</h3><p>{f.text}</p>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
