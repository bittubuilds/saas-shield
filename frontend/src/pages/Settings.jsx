import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { deleteAccount, listScans, listWebsites } from '../services/api.js';
import HoldButton from '../components/HoldButton.jsx';
import { maskEmail } from '../services/api.js';
import '../settings.css';

/** The blast radius, drawn: the account contains the workspace, the workspace contains
    the sites and their scans, and the cut runs through all of it. Inline SVG so it
    renders with the page and needs no image request. */
function ScopeMap() {
  return (
    <svg className="st-map" viewBox="0 0 420 232" role="img" aria-labelledby="st-map-t">
      <title id="st-map-t">The account holds the workspace, the sites and their scans; deleting the account removes all three.</title>
      <rect x="1" y="1" width="418" height="230" rx="14" fill="none" stroke="rgba(255,255,255,.10)" />
      <rect x="20" y="20" width="380" height="192" rx="10" fill="rgba(255,255,255,.03)" stroke="rgba(255,255,255,.14)" />
      <text x="36" y="44" fill="#8b88a0" fontSize="10.5" letterSpacing="1.6">ACCOUNT</text>
      <rect x="36" y="56" width="348" height="66" rx="8" fill="none" stroke="rgba(255,255,255,.10)" />
      <text x="50" y="76" fill="#8b88a0" fontSize="10.5" letterSpacing="1.6">WORKSPACE</text>
      <g stroke="rgba(255,255,255,.10)">
        <rect x="50" y="86" width="100" height="24" rx="5" fill="rgba(255,255,255,.02)" />
        <rect x="160" y="86" width="100" height="24" rx="5" fill="rgba(255,255,255,.02)" />
        <rect x="270" y="86" width="100" height="24" rx="5" fill="rgba(255,255,255,.02)" />
      </g>
      <g fill="#aeabc0" fontSize="10.5">
        <text x="60" y="102">sites</text>
        <text x="170" y="102">scans</text>
        <text x="280" y="102">findings</text>
      </g>
      <g>
        <rect x="36" y="134" width="348" height="26" rx="6" fill="rgba(255,255,255,.02)" stroke="rgba(255,255,255,.10)" />
        <text x="50" y="151" fill="#aeabc0" fontSize="10.5">reports and screenshots</text>
        <rect x="36" y="168" width="348" height="26" rx="6" fill="rgba(185,28,28,.10)" stroke="rgba(185,28,28,.35)" />
        <text x="50" y="185" fill="#e7b6b6" fontSize="10.5">deleted with the account</text>
        <rect x="36" y="202" width="348" height="1" fill="none" />
      </g>
      <g fill="none" stroke="#a78bfa" strokeWidth="1.4" strokeDasharray="4 4" opacity=".8">
        <path d="M14 20 L14 212" />
      </g>
      <text x="24" y="222" fill="#8b88a0" fontSize="10.5">the cut</text>
      <text x="200" y="222" fill="#8b88a0" fontSize="10.5">audit events survive it, without a name</text>
    </svg>
  );
}

/**
 * Settings, in the same console grammar as the dashboard: two bands of one
 * screen each, one .wrap on the shared container, hairlines instead of cards,
 * violet only where a hand can act. Behaviour is unchanged: the delete flow
 * still needs the word DELETE, reports errors in place, and signs out after.
 */
export default function Settings({ session, onSignOut }) {
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [counts, setCounts] = useState(null);
  const email = session?.user?.email || '';
  const workspaceName = session?.workspaces?.[0]?.name || '—';

  // Real figures only: what this workspace actually holds right now.
  useEffect(() => {
    let alive = true;
    Promise.all([listWebsites(), listScans()])
      .then(([sites, scans]) => { if (alive) setCounts({ sites: sites.length, scans: scans.length }); })
      .catch(() => { if (alive) setCounts(null); });
    return () => { alive = false; };
  }, []);

  // The page's one moment: the figures roll once the run has mounted, so it is
  // mounted again by hand when the real counts arrive (mountAll only scans once).
  useEffect(() => {
    const base = import.meta.env.BASE_URL;
    const host = document.querySelector('[data-moment="counter-rolls"]');
    import(/* @vite-ignore */ `${base}moments/moments.js`)
      .then((m) => { if (host) m.mount(host); if (m.ready) m.ready.catch(() => {}); })
      .catch(() => {});
  }, [counts]);

  async function onDelete(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (confirm.trim().toUpperCase() !== 'DELETE') {
      setError('Type DELETE exactly to confirm.');
      return;
    }
    setBusy(true); setError('');
    try {
      await deleteAccount('DELETE');
      setDone(true);
      setTimeout(() => onSignOut && onSignOut(), 1200);
    } catch (err) {
      setError(err.message || 'Could not delete the account.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="st st-hero" aria-labelledby="st-h">
        <div className="wrap">
          <div className="hero-text">
            <div className="st-hero-grid">
              <div className="st-hero-text">
                <p className="st-kicker">Account</p>
                <h1 id="st-h" className="st-h1">Settings</h1>
                <p className="st-sub">What this account holds, who it belongs to, and the one control that ends it.</p>
              </div>

              <div className="st-hero-side">
                <p className="st-col-h">Profile</p>
                <dl className="st-rows">
                  <div className="st-row">
                    <dt>Email</dt>
                    <dd>{email ? maskEmail(email) : '—'}</dd>
                  </div>
                  <div className="st-row">
                    <dt>Workspace</dt>
                    <dd>{workspaceName}</dd>
                  </div>
                  <div className="st-row">
                    <dt>Session</dt>
                    <dd>Signed in here</dd>
                  </div>
                </dl>
                <p className="st-note">Scans run under this account. Findings belong to the workspace, not to the device.</p>
                <div className="st-actions">
                  <button type="button" className="st-btn" onClick={() => onSignOut && onSignOut()}>
                    Sign out
                  </button>
                  <Link className="st-link" to="/privacy">Privacy Policy</Link>
                </div>
              </div>
            </div>

            {counts && (
                <div className="st-facts-band">
                  <dl className="st-facts" data-moment="counter-rolls" aria-label="What this account holds today">
                    <div className="st-fact">
                      <dt className="st-fact-h">{counts.sites === 1 ? 'Site monitored' : 'Sites monitored'}</dt>
                      <dd className="st-figure" data-count>{counts.sites}</dd>
                    </div>
                    <div className="st-fact">
                      <dt className="st-fact-h">{counts.scans === 1 ? 'Scan kept' : 'Scans kept'}</dt>
                      <dd className="st-figure" data-count>{counts.scans}</dd>
                    </div>
                  </dl>
                  <p className="st-facts-note">Counts come from this workspace and update after every scan.</p>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="st st-band" aria-labelledby="st-del-h">
        <div className="wrap">
          <h2 id="st-del-h" className="sr-only">Delete the account</h2>
          <p className="st-h2" aria-hidden="true">Delete the account</p>
          <p className="st-lead">One action removes everything inside the cut. Nothing in it can be recovered afterwards.</p>

          <div className="st-split">
            <div className="st-col">
              <ul className="st-list">
                <li><span>01</span>The account and its sign-in</li>
                <li><span>02</span>Workspace memberships</li>
                <li><span>03</span>Any workspace you are the only member of, with its sites, scans and findings</li>
                <li><span>04</span>The reports and screenshots attached to those scans</li>
              </ul>
            </div>

            <div className="st-col st-split-r">
              <ScopeMap />
              {done ? (
                <p role="status" className="st-ok">Account deleted. Signing you out…</p>
              ) : (
                <form className="st-form" onSubmit={(e) => e.preventDefault()}>
                  <label className="st-label" htmlFor="confirm-delete">Type DELETE to confirm</label>
                  <input
                    className="st-input" id="confirm-delete" value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="off" aria-describedby="delete-help"
                  />
                  <p id="delete-help" className="st-fine">Case does not matter, but the word must match.</p>
                  <HoldButton className="st-btn st-btn-danger" onConfirm={onDelete} busy={busy}
                              ariaLabel="Hold to permanently delete my account">
                    {busy ? 'Deleting…' : 'Hold to delete my account'}
                  </HoldButton>
                </form>
              )}
              {error && <p role="alert" className="st-err">{error}</p>}
              <p className="st-note st-note-quiet">
                Reports you still need should be exported first. <Link className="st-inline" to="/history">Open the history</Link>.
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
