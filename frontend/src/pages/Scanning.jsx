import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import { DecryptedText } from '../components/bits.jsx';
import { ErrorState, Loading } from '../components/Status.jsx';
import { STAGES, cancelScan, describeInitialScan, getInitialScan, retryScan } from '../services/api.js';

const POLL_MS = 2000;
const MAX_NETWORK_FAILURES = 3;

export default function Scanning() {
  const { websiteId } = useParams();
  const navigate = useNavigate();
  const hint = useLocation().state?.url;
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);

  const poll = useCallback(async (signal) => {
    try {
      const d = describeInitialScan(await getInitialScan(websiteId));
      if (signal.cancelled) return;
      failures.current = 0;
      setState(d);
      if (d.needsComparison) return;   // nothing to wait for; the panel explains it below
      if (d.done) {
        // Only a finished, non-failed scan has a report to show.
        if (d.scanId && !d.failed && !d.cancelled) navigate(`/report/${d.scanId}`, { replace: true });
        return;
      }
      signal.timer = setTimeout(() => poll(signal), POLL_MS);
    } catch (e) {
      if (signal.cancelled) return;
      if (e.status === 401) return navigate('/login', { replace: true });
      if (e.status === 404 || ++failures.current >= MAX_NETWORK_FAILURES) return setError(e.message);
      signal.timer = setTimeout(() => poll(signal), POLL_MS);
    }
  }, [websiteId, navigate]);

  useEffect(() => {
    const signal = { cancelled: false, timer: null };
    setError(''); poll(signal);
    return () => { signal.cancelled = true; clearTimeout(signal.timer); };
  }, [poll, attempt]);

  async function onCancel() {
    if (!state?.scanId) return;
    setBusy(true);
    try { await cancelScan(state.scanId); setAttempt((a) => a + 1); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function onRetry() {
    if (!state?.scanId) return;
    setBusy(true);
    try { await retryScan(state.scanId); setError(''); setAttempt((a) => a + 1); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const url = state?.url || hint;
  const stageIndex = state?.stageIndex ?? 0;
  const pct = Math.round((stageIndex / (STAGES.length - 1)) * 100);
  const stage = STAGES[Math.min(stageIndex, STAGES.length - 1)];
  const active = state && !state.done;
  // Short technical label for the current phase. Purely cosmetic: it never gates or delays the real progress.
  const phase = state && (state.done && !state.failed && !state.cancelled ? 'COMPLETE' : ['INITIALIZING', 'ANALYZING', 'VERIFYING', 'COMPLETE'][Math.min(stageIndex, 3)]);

  return (
    <section className="page-narrow">
      <h1 className="page-title">Scanning Website</h1>
      {url && <p className="url-line"><Icon name="link" size={18} />{url}</p>}

      {error && !state ? (
        <ErrorState message={error} onRetry={() => { failures.current = 0; setAttempt((a) => a + 1); }} />
      ) : !state ? (
        <Loading label="Connecting to scan…" />
      ) : (
        <div className="panel">
          {phase && !state.failed && !state.cancelled && <p className="phase" aria-hidden="true"><DecryptedText key={phase} text={phase} /></p>}
          <Ring value={pct} />
          <ol className="stages">
            {STAGES.map((s, i) => (
              <li key={s.key} className={i < stageIndex ? 'done' : i === stageIndex ? 'active' : ''}
                aria-current={i === stageIndex ? 'step' : undefined}>
                <span className="dot">{i < stageIndex ? <Icon name="check" size={16} /> : null}</span>{s.label}
              </li>
            ))}
          </ol>
          <div className="bar-track" role="progressbar" aria-label="Scan progress" aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={pct}>
            <div className={`bar-fill ${state.needsComparison ? 'indeterminate' : ''}`} style={state.needsComparison ? undefined : { width: `${pct}%` }} />
          </div>

          <p className="stage-desc" aria-live="polite">
            {state.needsComparison ? 'No comparison site is available yet, so no scan has run. Add the site you want to check against, or run discovery, and the scan starts on its own.'
              : state.failed ? (state.error || 'The scan failed.')
              : state.cancelled ? 'This scan was cancelled.'
              : state.done ? (state.findings ? `${state.findings} finding(s) recorded.` : 'No overlapping content was found.')
              : stage.description}
          </p>

          <dl className="details card">
            <dt>Status</dt><dd>{state.status}</dd>
            <dt>Pages read</dt><dd>{state.pages ?? '—'}</dd>
            <dt>Pages compared</dt><dd>{state.pagesCompared ?? '—'}</dd>
            <dt>Findings</dt><dd>{state.findings ?? '—'}</dd>
            {state.discovery && (<><dt>Discovery</dt><dd>{state.discovery.status}</dd></>)}
          </dl>

          {state.done && !state.failed && !state.cancelled && !state.scanId && (
            <p className="muted">No comparison ran, so there is nothing to report yet. Add the site you want to check against.</p>
          )}

          <div className="actions">
            {active && state.scanId && (
              <button className="btn btn-outline" onClick={onCancel} disabled={busy}>
                {busy ? <span className="spinner" /> : <Icon name="close" size={16} />}Cancel scan
              </button>
            )}
            {(state.failed || state.cancelled) && state.scanId && (
              <button className="btn btn-primary" onClick={onRetry} disabled={busy}>
                {busy ? <span className="spinner" /> : <Icon name="bolt" size={16} />}Retry scan
              </button>
            )}
            {state.scanId && (
              <Link className="btn btn-outline" to={`/report/${state.scanId}`}>Open report</Link>
            )}
          </div>
          {error && <p className="field-error" role="alert">{error}</p>}
        </div>
      )}
      <Link to="/" className="back">Back to dashboard</Link>
    </section>
  );
}

function Ring({ value }) {
  const r = 70, c = 2 * Math.PI * r;
  return (
    <div className="ring" aria-hidden="true">
      <svg viewBox="0 0 180 180">
        <circle cx="90" cy="90" r={r} className="ring-bg" />
        <circle cx="90" cy="90" r={r} className="ring-fg" stroke="var(--violet)" strokeDasharray={c}
          strokeDashoffset={c * (1 - (value ?? 0) / 100)} transform="rotate(-90 90 90)" />
      </svg>
      <span>{`${value}%`}</span>
    </div>
  );
}
