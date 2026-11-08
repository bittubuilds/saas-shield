import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, ErrorState, Loading } from '../components/Status.jsx';
import { listScans } from '../services/api.js';

const fmt = (d) => (d ? new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export default function History() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError(''); setItems(null);
    listScans().then(setItems).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  return (
    <section className="page-narrow">
      <h1 className="page-title">Reports</h1>
      {error ? <ErrorState message={error} onRetry={load} />
        : !items ? <Loading label="Loading reports…" />
        : items.length === 0 ? <Empty>No reports yet. <Link to="/">Scan a website</Link> to create one.</Empty>
        : (
          <ul className="insights">
            {items.map((s) => (
              <li key={s.id}>
                <Link className="card row" to={`/report/${s.id}`}>
                  <h3>{s.original_url}</h3>
                  <span>{s.status} · {s.findings ?? 0} finding(s) · {fmt(s.finished_at || s.created_at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}
