import { useState } from 'react';
import Icon from '../components/Icon.jsx';
import { signIn, signUp } from '../services/api.js';

export default function Login({ onSignedIn }) {
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(''); setNotice(''); setBusy(true);
    try {
      if (mode === 'signup') {
        await signUp(email.trim(), password, name.trim() || undefined);
        // Accounts are usable immediately when email delivery is in instant mode.
        // If the deployment requires verification, this sign-in returns the reason.
        try {
          await signIn(email.trim(), password);
        } catch (err) {
          setNotice(err.message || 'Check your email to finish creating the account.');
          setBusy(false);
          return;
        }
      } else {
        await signIn(email.trim(), password);
      }
      await onSignedIn();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <main className="main">
      <section className="page-narrow auth">
        <div className="auth-card card">
          <h1 className="page-title">{mode === 'signin' ? 'Sign in' : 'Create your account'}</h1>
          <p className="muted">SaaS Shield watches for copied content on other sites.</p>

          <form onSubmit={submit} noValidate className="stack">
            {mode === 'signup' && (
              <label className="form-row">
                <span>Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Optional" />
              </label>
            )}
            <label className="form-row">
              <span>Email</span>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                autoComplete="email" placeholder="you@example.com" aria-invalid={!!error} />
            </label>
            <label className="form-row">
              <span>Password</span>
              <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} placeholder="At least 8 characters" />
            </label>

            {error && <p className="field-error" role="alert">{error}</p>}
            {notice && <p className="muted" role="status">{notice}</p>}

            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? <span className="spinner" /> : <Icon name="user" size={18} />}
              {mode === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <p className="muted">
            {mode === 'signin' ? 'No account yet?' : 'Already have an account?'}{' '}
            <button className="link-btn" type="button" onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); setNotice(''); }}>
              {mode === 'signin' ? 'Create one' : 'Sign in'}
            </button>
          </p>
        </div>
      </section>
    </main>
  );
}
