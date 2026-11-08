import { useState } from 'react';
import { Link } from 'react-router-dom';
import { deleteAccount } from '../services/api.js';
import { maskEmail } from '../services/api.js';

export default function Settings({ session, onSignOut }) {
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const email = session?.user?.email || '';

  async function onDelete(e) {
    e.preventDefault();
    if (confirm.trim().toUpperCase() !== 'DELETE') {
      setError('Type DELETE exactly to confirm.');
      return;
    }
    const ok = window.confirm('Delete your account permanently?\n\nThis removes your account, your sites and their scans. Reports already generated become unreachable. This cannot be undone.');
    if (!ok) return;
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
    <section className="doc">
      <p className="doc-kicker">Account</p>
      <h1>Settings</h1>

      <div className="card settings-block">
        <h2>Profile</h2>
        <p className="muted">Signed in as {email ? maskEmail(email) : '—'}</p>
        <p className="muted">Workspace: {session?.workspaces?.[0]?.name || '—'}</p>
      </div>

      <div className="card settings-block">
        <h2>Legal</h2>
        <p><Link to="/privacy">Privacy Policy</Link></p>
      </div>

      <div className="card settings-block danger">
        <h2>Danger zone</h2>
        <p className="muted">
          Deleting your account removes your account, your workspace memberships, and any workspace you are the
          only member of, together with its sites, scans and findings. Security audit events are retained without
          your identity attached. This cannot be undone.
        </p>
        {done ? (
          <p role="status" className="ok">Account deleted. Signing you out…</p>
        ) : (
          <form onSubmit={onDelete}>
            <label htmlFor="confirm-delete">Type DELETE to confirm</label>
            <input id="confirm-delete" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                   autoComplete="off" aria-describedby="delete-help" />
            <p id="delete-help" className="muted small">Case does not matter, but the word must match.</p>
            <button type="submit" className="btn-danger" disabled={busy}>
              {busy ? 'Deleting…' : 'Delete my account'}
            </button>
          </form>
        )}
        {error && <p role="alert" className="err">{error}</p>}
      </div>
    </section>
  );
}
