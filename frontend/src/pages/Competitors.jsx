import { useCallback, useEffect, useState } from 'react';
import Icon from '../components/Icon.jsx';
import { Empty, ErrorState, Loading } from '../components/Status.jsx';
import {
  collectCompetitor, getCompetitorIntelligence, listCompetitors, listScreenshots, screenshotCapability,
} from '../services/api.js';

const arr = (v) => (Array.isArray(v) ? v : null);

export default function Competitors() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [caps, setCaps] = useState(null);
  const [sel, setSel] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError('');
    listCompetitors().then(setRows).catch((e) => setError(e.message));
    screenshotCapability().then(setCaps).catch(() => setCaps(null));
  }, []);
  useEffect(load, [load]);

  async function open(c) {
    setSel({ id: c.id, loading: true });
    const [intel, shots] = await Promise.all([
      getCompetitorIntelligence(c.id).catch(() => null),
      listScreenshots(c.id).catch(() => null),
    ]);
    setSel({ id: c.id, intelligence: intel, shots });
  }

  async function onCollect(id) {
    setBusy(true); setError('');
    try { await collectCompetitor(id); load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const shotState = caps && caps.browser && caps.browser.available === false
    ? 'Screenshot capture is unavailable on this server (no browser installed).'
    : caps && caps.enabled === false
      ? 'Screenshot capture is disabled on this server.'
      : null;

  return (
    <section className="page-narrow">
      <h1 className="page-title">Competitors</h1>

      {shotState && <p className="muted">{shotState}</p>}
      {error && <p className="field-error" role="alert">{error}</p>}

      {!rows ? <Loading label="Loading competitors…" />
        : rows.length === 0 ? (
          <Empty>
            No competitors have been collected yet. Add a second website to compare against, or start
            discovery once this server has a search provider configured.
          </Empty>
        ) : (
          <ul className="insights">
            {rows.map((c) => (
              <li className="card" key={c.id}>
                <button className="row-btn" onClick={() => open(c)} aria-expanded={sel && sel.id === c.id}>
                  <h3>{c.name || c.domain || c.id}</h3>
                  <span>{c.domain}{c.status ? ` · ${c.status}` : ''}</span>
                </button>
                <div className="actions">
                  <button className="btn btn-outline" onClick={() => onCollect(c.id)} disabled={busy}>
                    {busy ? <span className="spinner" /> : <Icon name="bolt" size={16} />}Collect now
                  </button>
                </div>
                {sel && sel.id === c.id && (
                  sel.loading ? <Loading label="Loading intelligence…" /> : (
                    <dl className="details card">
                      <dt>Features</dt><dd>{arr(sel.intelligence && (sel.intelligence.features || sel.intelligence.claims))?.length ?? '—'}</dd>
                      <dt>Pricing plans</dt><dd>{arr(sel.intelligence && (sel.intelligence.pricing || sel.intelligence.plans))?.length ?? '—'}</dd>
                      <dt>Evidence</dt><dd>{arr(sel.intelligence && sel.intelligence.evidence)?.length ?? '—'}</dd>
                      <dt>Screenshots</dt><dd>{sel.shots && sel.shots.summary ? JSON.stringify(sel.shots.summary) : '—'}</dd>
                      <dt>Storage durable</dt><dd>{sel.shots && sel.shots.durability ? String(!!sel.shots.durability.durable) : '—'}</dd>
                    </dl>
                  )
                )}
              </li>
            ))}
          </ul>
        )}

      <p className="muted">
        Similarity scores are signals about overlapping public text. They are not proof of copying,
        and a missing claim means the page did not state it, not that the feature is absent.
      </p>
    </section>
  );
}
