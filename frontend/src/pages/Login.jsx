import { useEffect, useState } from 'react';
import Icon from '../components/Icon.jsx';
import { getAuthConfig, signIn, signUp } from '../services/api.js';

// Reasons the Google callback can send back. Anything unknown still gets a line.
const OAUTH_MESSAGES = {
  not_configured: 'Google sign-in is not configured on this deployment yet.',
  access_denied: 'Google sign-in was cancelled.',
  state_cookie_invalid: 'That sign-in attempt expired. Please try again.',
  state_mismatch: 'That sign-in attempt could not be verified. Please try again.',
  missing_code: 'Google did not return a sign-in code. Please try again.',
  exchange_failed: 'Google could not confirm the sign-in. Please try again.',
  jwks_unavailable: 'Google could not be reached just now. Use your email below.',
  server_error: 'Something went wrong on our side. Please try again.',
};

function readOauthError() {
  const search = new URLSearchParams(window.location.search);
  if (search.get('oauth_error')) return search.get('oauth_error');
  const hashQuery = window.location.hash.split('?')[1];
  if (hashQuery) {
    const fromHash = new URLSearchParams(hashQuery).get('oauth_error');
    if (fromHash) return fromHash;
  }
  return '';
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

export default function Login({ onSignedIn }) {
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [authConfig, setAuthConfig] = useState(null);

  // Which sign-in methods this deployment really has, so the page never offers a
  // button that cannot work.
  useEffect(() => {
    let alive = true;
    getAuthConfig().then((cfg) => { if (alive) setAuthConfig(cfg); });
    return () => { alive = false; };
  }, []);

  // Google returns here with ?oauth_error=<reason> when a sign-in fails.
  useEffect(() => {
    const reason = readOauthError();
    if (reason) setError(OAUTH_MESSAGES[reason] || 'Google sign-in did not complete. Please try again.');
  }, []);

  const google = authConfig && authConfig.google;
  const googleReady = !!(google && google.enabled);
  const modeIsSignup = mode === 'signup';

  async function submit(e) {
    e.preventDefault();
    setError(''); setNotice(''); setBusy(true);
    try {
      if (modeIsSignup) {
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

  function switchMode() {
    setMode(modeIsSignup ? 'signin' : 'signup');
    setError('');
    setNotice('');
  }

  return (
    <div className="auth-split">
      <section className="auth-pane">
        <div className="auth-pane-inner">
          <a className="auth-brand" href="./" aria-label="SaaS Shield">
            <img className="logo-img" src={`${import.meta.env.BASE_URL}logo.png`} alt="" width="28" height="32" />
            <span>SaaS Shield</span>
          </a>

          <h1 className="auth-heading">{modeIsSignup ? 'Create your account' : 'Welcome back'}</h1>
          <p className="muted auth-sub">
            {modeIsSignup
              ? 'One account, and the scanner starts watching for copied content.'
              : 'Sign in to run a scan and see what has been copied.'}
          </p>

          <div className="auth-oauth">
            <button
              type="button"
              className="oauth-btn"
              disabled={!googleReady || busy}
              onClick={() => { window.location.assign('/api/auth/google/start'); }}
            >
              <GoogleMark />
              <span>Continue with Google</span>
            </button>
            {authConfig && !googleReady && (
              <p className="muted small oauth-note">
                Google sign-in is not configured on this deployment. Use your email below.
              </p>
            )}
          </div>

          <div className="auth-divider" role="separator" aria-label="or">
            <span>or continue with email</span>
          </div>

          <form onSubmit={submit} noValidate className="stack">
            {modeIsSignup && (
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
                autoComplete={modeIsSignup ? 'new-password' : 'current-password'} placeholder="At least 8 characters" />
            </label>

            {error && <p className="field-error" role="alert">{error}</p>}
            {notice && <p className="muted" role="status">{notice}</p>}

            <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
              {busy ? <span className="spinner" /> : <Icon name="user" size={18} />}
              {modeIsSignup ? 'Create account' : 'Sign in'}
            </button>
          </form>

          <p className="muted auth-switch">
            {modeIsSignup ? 'Already have an account?' : 'No account yet?'}{' '}
            <button className="link-btn" type="button" onClick={switchMode}>
              {modeIsSignup ? 'Sign in' : 'Create one'}
            </button>
          </p>

          <p className="muted small auth-legal">
            By continuing you agree to our <a href="/app/privacy">Privacy Policy</a>.
          </p>
        </div>
      </section>

      <aside className="auth-aside" aria-hidden="true">
        <div className="auth-aside-glow" />
        <div className="auth-aside-inner">
          <div className="auth-aside-mark">
            <img className="logo-img" src={`${import.meta.env.BASE_URL}logo.png`} alt="" width="44" height="50" />
          </div>
          <h2 className="auth-aside-title">Know the moment your pages show up somewhere else.</h2>
          <ul className="auth-points">
            <li><Icon name="search" size={18} /> Scans the sites you choose, on demand</li>
            <li><Icon name="doc" size={18} /> Shows the matching passage side by side</li>
            <li><Icon name="chart" size={18} /> Keeps a report you can export and share</li>
          </ul>
          <p className="auth-aside-foot">Runs on your own deployment. Your content stays with you.</p>
        </div>
      </aside>
    </div>
  );
}
