import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import GlassIcon from '../components/GlassIcon.jsx';
import ScrambledText from '../components/ScrambledText.jsx';
import SplitText from '../components/SplitText.jsx';
import FadeContent from '../components/FadeContent.jsx';
import AnimatedList from '../components/AnimatedList.jsx';
import TechText from '../components/TechText.jsx';
import ElectricLogo from '../components/ElectricLogo.jsx';
import { ClickSpark, DotGrid, Magnet, ScrollFloat, ScrollReveal, SpotlightCard } from '../components/bits.jsx';
import BounceText from '../components/BounceText.jsx';
import HoldButton from '../components/HoldButton.jsx';
import { Empty, Loading } from '../components/Status.jsx';
import { addWebsite, listWebsites, removeWebsite } from '../services/api.js';

// Heavy WebGL background: loaded after first paint; .aurora's CSS gradient shows meanwhile.
const Aurora = lazy(() => import('../components/Aurora.jsx'));
const AURORA_STOPS = ['#3b1a8a', '#6d28d9', '#1d4ed8'];

const FEATURES = [
  { icon: 'bolt', tone: 'indigo', title: 'Smart Scanning', text: 'Automatically scan your website for competitor content.' },
  { icon: 'chart', tone: 'violet', title: 'Competitor Insights', text: 'Discover who’s copying you and how they do it.' },
  { icon: 'image', tone: 'purple', title: 'Screenshots', text: 'Capture proof with real screenshots.' },
  { icon: 'doc', tone: 'blue', title: 'Detailed Reports', text: 'Get comprehensive reports with actionable insights.' },
];

const MATCHES = [
  { site: 'clone-saas.io', part: 'Pricing page copy', pct: 94 },
  { site: 'rival-app.com', part: 'Feature section', pct: 81 },
  { site: 'copycat.dev', part: 'Hero headline', pct: 67 },
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

  return (
    <>
      <ClickSpark scope=".search-btn" count={6} />
      <div className="below">
      <DotGrid />
      <section className="hero" id="features">
        <Suspense fallback={<div className="aurora" aria-hidden="true" />}><Aurora colorStops={AURORA_STOPS} amplitude={0.9} blend={0.7} speed={0.5} /></Suspense>
        <div className="stage-logo">
          <ElectricLogo src={`${import.meta.env.BASE_URL}logo.png`} label="SaaS Shield logo" color="#ecc7ff" glowColor="#ad6dff"
            scale={0.7} strands={4} bend={0.6} crackle={1.5} arcs={1} speed={2.5} interactive intensity={1} glow={1}
            thickness={1.5} flicker={0.6} fill={0} cursorIntensity={0.75} cursorRadius={100} />
        </div>
        <TechText maxSize={140} />
        <SplitText className="hero-tag" text="Catch copycats. Keep the proof." />
        <ScrambledText className="lead" text="Detect copied content, analyze competitors and get detailed insights about your SaaS product." />
        <form className="search" onSubmit={onSubmit} noValidate>
          <Icon name="link" size={24} className="search-icon" />
          <label htmlFor="url" className="sr-only">Website URL</label>
          <input id="url" type="text" inputMode="url" autoComplete="url" placeholder="Enter website URL..."
            value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={!!error}
            aria-describedby={error ? 'url-error' : undefined} disabled={busy} />
          <Magnet strength={0.25} range={60}>
            <button className="search-btn" type="submit" aria-label="Start scan" disabled={busy}>
              {busy ? <span className="spinner" /> : <Icon name="search" size={26} />}
            </button>
          </Magnet>
        </form>
        {error && <p id="url-error" className="field-error" role="alert">{error}</p>}
        <p className="search-hint">
          {(Array.isArray(sites) && sites.some((s) => s.kind === 'original'))
            ? 'This URL will be compared against your website.'
            : 'Start with your own website, then add a site to check against it.'}
        </p>
        <div className="scan-report" role="group" aria-label="Example scan result">
          <div className="sr-head"><span>Example result</span><span>{MATCHES.length} matches found</span></div>
          <AnimatedList items={MATCHES} getKey={(m) => m.site} label="Example matches" renderItem={(m) => (
            <>
              <b className="sr-site">{m.site}</b>
              <em className="sr-pct">{m.pct}%</em>
              <small className="sr-part">{m.part}</small>
              <span className="sr-bar" role="presentation"><i style={{ '--w': `${m.pct}%` }} /></span>
            </>
          )} />
        </div>
      </section>

      <FadeContent as="section" className="page-narrow" aria-labelledby="sites-h">
        <div className="section-head">
          <h2 id="sites-h" className="sub-h"><ScrollFloat text="Your websites" /></h2>
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
      </FadeContent>


      <FadeContent as="section" className="features" aria-labelledby="feat-h">
        <div className="section-head">
          <h2 id="feat-h"><ScrollFloat text="Powerful Features" /></h2>
          <Link className="btn btn-outline" to="/history"><ScrollReveal text="All reports" /> <Icon name="arrow" size={16} /></Link>
        </div>
        <div className="grid">
          {FEATURES.map((f) => (
            <SpotlightCard key={f.title}>
              <GlassIcon icon={f.icon} tone={f.tone} />
              <h3><BounceText text={f.title} /></h3><ScrambledText text={f.text} />
            </SpotlightCard>
          ))}
        </div>
      </FadeContent>
      </div>
    </>
  );
}
