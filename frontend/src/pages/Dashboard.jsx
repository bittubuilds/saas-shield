import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import GlassIcon from '../components/GlassIcon.jsx';
import ScrambledText from '../components/ScrambledText.jsx';
import SilkBackground from '../components/SilkBackground.jsx';
import ShatterWordmark from '../components/ShatterWordmark.jsx';
import SplitTagline from '../components/SplitTagline.jsx';
import ExampleResult from '../components/ExampleResult.jsx';
import HoldButton from '../components/HoldButton.jsx';
import { Empty, Loading } from '../components/Status.jsx';
import { addWebsite, listWebsites, removeWebsite } from '../services/api.js';

const FEATURES = [
  { icon: 'bolt', tone: 'indigo', title: 'Paste your URL', text: 'We crawl the public pages of your site.' },
  { icon: 'chart', tone: 'violet', title: 'We match text', text: 'Your wording is compared against other sites.' },
  { icon: 'image', tone: 'purple', title: 'See the evidence', text: 'Every finding links to the page and screenshot.' },
  { icon: 'doc', tone: 'blue', title: 'Send the report', text: 'Export a PDF you can put in front of anyone.' },
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

/** Moves the card spotlight under the pointer (design port, purely decorative). */
function trackSpot(e) {
  const card = e.target.closest && e.target.closest('.card');
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty('--mx', `${e.clientX - r.left}px`);
  card.style.setProperty('--my', `${e.clientY - r.top}px`);
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
      setSitesError(e.message || `Could not remove ${label}.`);
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
        <div className="aurora" aria-hidden="true" />
        <SilkBackground className="silk" />
        <SilkBackground className="silk-ribbon" color="#ff3d9a" speed={0.75} interactive={false} />
        <div className="stage-logo" aria-hidden="true">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" width="150" height="170" />
        </div>
        <ShatterWordmark />
        <SplitTagline className="hero-tag" text="Catch copycats. Keep the proof." />
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
        {sites && sites.length === 0 && <ExampleResult />}
      </section>

      <div className="below">
        <section className="page-narrow" aria-labelledby="sites-h">
          <div className="section-head">
            <h2 id="sites-h" className="sub-h">Your websites</h2>
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
                    <HoldButton
                      className="remove-btn"
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

        <section className="features" aria-labelledby="feat-h">
          <div className="section-head">
            <h2 id="feat-h">Powerful Features</h2>
            <Link className="btn btn-outline" to="/history">All reports <Icon name="arrow" size={16} /></Link>
          </div>
          <div className="grid" onPointerMove={trackSpot}>
            {FEATURES.map((f) => (
              <article className="card spot" key={f.title}>
                <GlassIcon icon={f.icon} tone={f.tone} />
                <h3>{f.title}</h3><p>{f.text}</p>
              </article>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
