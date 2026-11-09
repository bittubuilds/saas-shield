import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import CountUp from '../components/CountUp.jsx';
import { Empty, ErrorState, Loading } from '../components/Status.jsx';
import {
  aiPdfUrl, downloadPdf, getAiReport, getAiStatus, getScan, listResults, startAi,
} from '../services/api.js';

const fmtDate = (d) => (d ? new Date(d).toLocaleString(undefined, {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '—');

export default function Report() {
  const { scanId } = useParams();
  const navigate = useNavigate();
  const [scan, setScan] = useState(null);
  const [ai, setAi] = useState(null);
  const [payload, setPayload] = useState(undefined); // undefined loading, null no report
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const [s, status, rep] = await Promise.all([
        getScan(scanId),
        getAiStatus(scanId),
        getAiReport(scanId, version ?? undefined),
      ]);
      setScan(s); setAi(status); setPayload(rep);
    } catch (e) {
      if (e.status === 401) return navigate('/login', { replace: true });
      setError(e.message);
    }
    try { setResults(await listResults({ scanId, limit: 20 })); } catch { setResults(null); }
  }, [scanId, version, navigate]);

  useEffect(() => { load(); }, [load]);

  // While synthesis is running, look again instead of making the user reload.
  useEffect(() => {
    const running = ai && ['running', 'pending'].includes(ai.status);
    if (!running || payload) return undefined;
    const t = setTimeout(load, 5000);
    return () => clearTimeout(t);
  }, [ai, payload, load]);

  async function onRunAnalysis() {
    setBusy(true); setError('');
    try { await startAi(scanId); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function onDownload(v) {
    setBusy(true); setError('');
    try { await downloadPdf(aiPdfUrl(scanId, v ?? version ?? undefined), `saas-shield-report-${scanId}${v ?? version ? `-v${v ?? version}` : ''}.pdf`); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  if (error && !scan) return <section className="page-narrow"><ErrorState message={error} onRetry={load} /></section>;
  if (!scan || payload === undefined) return <section className="page-narrow"><Loading label="Loading report…" /></section>;

  const report = payload ? payload.report : null;
  const history = payload && Array.isArray(payload.history) ? payload.history : [];
  const versions = [...new Set(history.map((h) => h && h.version).filter((v) => typeof v === 'number'))].sort((a, b) => b - a);
  const competitors = (report && Array.isArray(report.competitors)) ? report.competitors : [];
  const findingCount = competitors.reduce((n, c) => n + (Array.isArray(c.findings) ? c.findings.length : 0), 0);
  const counts = (ai && ai.counts) || {};
  const analysisDone = scan.status === 'completed';
  const items = results && Array.isArray(results.results) ? results.results : null;

  return (
    <section className="page-narrow">
      <p className={analysisDone ? 'status-ok' : 'muted'}>
        <span className="check"><Icon name={analysisDone ? 'check' : 'bolt'} size={16} /></span>
        {analysisDone ? 'Scan complete' : `Scan ${scan.status}`}
      </p>
      <h1 className="page-title">Report Overview</h1>
      <p className="url-line">
        <Icon name="link" size={18} />
        {scan.original_url}
        {scan.comparison_url && <> <span className="sep" /> vs {scan.comparison_url}</>}
        <span className="sep" /> {fmtDate(scan.finished_at || scan.created_at)}
      </p>

      {error && <p className="field-error" role="alert">{error}</p>}

      {!report ? (
        <div className="panel">
          <h2 className="sub-h"><span className="bar" />Analysis</h2>
          <p className="stage-desc">
            {ai && ai.status === 'running' ? 'The AI analysis is running. This page updates on its own.'
              : ai && ai.status === 'failed' ? 'The last analysis failed. You can run it again.'
              : 'No AI report exists for this scan yet.'}
          </p>
          <dl className="details card">
            <dt>Analysis state</dt><dd>{(ai && ai.status) || 'not_started'}</dd>
            <dt>Completed</dt><dd>{counts.completed ?? 0}</dd>
            <dt>Pending</dt><dd>{counts.pending ?? 0}</dd>
            <dt>Failed</dt><dd>{counts.failed ?? 0}</dd>
            <dt>Findings on this scan</dt><dd>{scan.findings ?? 0}</dd>
          </dl>
          <div className="actions">
            <button className="btn btn-primary" onClick={onRunAnalysis} disabled={busy || (ai && ai.status === 'running')}>
              {busy ? <span className="spinner" /> : <Icon name="bolt" size={18} />}Run analysis
            </button>
            <Link className="btn btn-ghost" to="/">New scan</Link>
          </div>
        </div>
      ) : (
        <>
          <div className="stats">
            <div className="card stat"><strong><CountUp to={competitors.length} /></strong><span>Competitors analysed</span></div>
            <div className="card stat"><strong><CountUp to={findingCount} /></strong><span>Findings</span></div>
            <div className="card stat"><strong><CountUp to={Array.isArray(report.recommendations) ? report.recommendations.length : 0} /></strong><span>Recommendations</span></div>
            <div className="card stat"><strong><CountUp to={report.coverage ? report.coverage.competitors_analysed : '—'} /></strong><span>Coverage</span></div>
          </div>

          {report.executive_summary && (
            <p className="lead">{report.executive_summary}</p>
          )}

          <h2 className="sub-h"><span className="bar" />Key Insights</h2>
          {(!report.gaps || report.gaps.length === 0) && (!report.recommendations || report.recommendations.length === 0) ? (
            <Empty>No insights were returned for this scan.</Empty>
          ) : (
            <ul className="insights">
              {(report.gaps || []).map((g, n) => (
                <li className="card" key={`gap-${n}`}>
                  <h3>{g.gap || g.title || 'Gap'}</h3>
                  <p>{g.description || g.detail || ''}</p>
                </li>
              ))}
              {(report.recommendations || []).map((r, n) => (
                <li className="card" key={`rec-${n}`}>
                  <h3>{r.recommendation}</h3>
                  {r.reason && <p>{r.reason}</p>}
                  {r.confidence != null && <p className="muted">Confidence {Math.round(r.confidence * 100)}%</p>}
                  {r.limitations && <p className="muted">{r.limitations}</p>}
                </li>
              ))}
            </ul>
          )}

          {competitors.length > 0 && (
            <>
              <h2 className="sub-h"><span className="bar" />Competitors</h2>
              <ul className="insights">
                {competitors.map((c) => (
                  <li className="card" key={c.competitor_id || c.domain}>
                    <h3>{c.name || c.domain}</h3>
                    <p className="muted">{c.domain} · {Array.isArray(c.findings) ? c.findings.length : 0} finding(s)</p>
                    {Array.isArray(c.sources) && c.sources.length > 0 && (
                      <p className="muted">
                        Sources: {c.sources.slice(0, 3).map((s) => (
                          <a key={s} href={s} target="_blank" rel="noreferrer noopener">{s.replace(/^https?:\/\//, '').slice(0, 40)} </a>
                        ))}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="actions">
            <button className="btn btn-primary" onClick={() => onDownload()} disabled={busy}>
              {busy ? <span className="spinner" /> : <Icon name="download" size={18} />}Download PDF
            </button>
            {versions.length > 1 && (
              <label className="form-row inline">
                <span>Version</span>
                <select value={version ?? ''} onChange={(e) => setVersion(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">Latest</option>
                  {versions.map((v) => <option key={v} value={v}>v{v}</option>)}
                </select>
              </label>
            )}
            <Link className="btn btn-ghost" to="/">New scan</Link>
          </div>
        </>
      )}

      <h2 className="sub-h"><span className="bar" />Findings on this scan</h2>
      {!items ? <Loading label="Loading findings…" />
        : items.length === 0 ? <Empty>No overlapping content was recorded for this scan.</Empty>
        : (
          <ul className="insights">
            {items.map((f) => (
              <li className="card row" key={f.id}>
                <h3>{f.original_url}</h3>
                <span>{f.match_type} · similarity {Number(f.jaccard_score).toFixed(2)} · {f.status}</span>
              </li>
            ))}
          </ul>
        )}
      {results && results.total > items.length && <p className="muted">Showing {items.length} of {results.total} findings.</p>}
    </section>
  );
}
