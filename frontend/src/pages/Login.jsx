import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import '../login.css';
import { getAuthConfig, signIn, signUp } from '../services/api.js';

// Reasons the OAuth callbacks can send back. Both providers land here with
// ?oauth_error=<reason>&provider=google|github, so the wording stays honest
// about which button the person actually pressed.
const OAUTH_MESSAGES = {
  not_configured: (p) => `${p} sign-in is not configured on this deployment yet.`,
  access_denied: (p) => `${p} sign-in was cancelled.`,
  state_cookie_invalid: () => 'That sign-in attempt expired. Please try again.',
  state_mismatch: () => 'That sign-in attempt could not be verified. Please try again.',
  missing_code: (p) => `${p} did not return a sign-in code. Please try again.`,
  exchange_failed: (p) => `${p} could not confirm the sign-in. Please try again.`,
  jwks_unavailable: (p) => `${p} could not be reached just now. Use your email below.`,
  identity_failed: (p) => `${p} could not be reached just now. Use your email below.`,
  email_not_verified: (p) => `Your ${p} account has no verified email address. Verify one with ${p}, then try again.`,
  local_account_unverified: () => 'An account with this email already exists but is not verified. Sign in with your password instead.',
  server_error: () => 'Something went wrong on our side. Please try again.',
};

function readOauthError() {
  const read = (params) => ({
    reason: params.get('oauth_error') || '',
    provider: params.get('provider') === 'github' ? 'GitHub' : 'Google'
  });
  const search = read(new URLSearchParams(window.location.search));
  if (search.reason) return search;
  const hashQuery = window.location.hash.split('?')[1];
  if (hashQuery) {
    const fromHash = read(new URLSearchParams(hashQuery));
    if (fromHash.reason) return fromHash;
  }
  return { reason: '', provider: 'Google' };
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

function GitHubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M8 1.9 15 14H1L8 1.9Z" strokeLinejoin="round" />
      <path d="M8 6v3.4" strokeLinecap="round" />
      <circle cx="8" cy="11.6" r=".75" fill="currentColor" stroke="none" />
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

  // Either provider returns here with ?oauth_error=<reason> when it fails.
  useEffect(() => {
    const { reason, provider } = readOauthError();
    if (!reason) return;
    const template = OAUTH_MESSAGES[reason];
    setError(template ? template(provider) : `${provider} sign-in did not complete. Please try again.`);
  }, []);

  const modeIsSignup = mode === 'signup';

  useEffect(() => {
    const previous = document.title;
    document.title = modeIsSignup ? 'Create your account — SaaS Shield' : 'Sign in — SaaS Shield';
    return () => { document.title = previous; };
  }, [modeIsSignup]);

  const google = authConfig && authConfig.google;
  const googleReady = !!(google && google.enabled);
  const github = authConfig && authConfig.github;
  const githubReady = !!(github && github.enabled);
  const missingProviders = authConfig
    ? [googleReady ? null : 'Google', githubReady ? null : 'GitHub'].filter(Boolean)
    : [];

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
    <div className="lg">
      <div className="lg-main">
        <div className="lg-top">
          <a className="lg-brand" href="./" aria-label="SaaS Shield">
            <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" width="26" height="29" />
            <span>SaaS Shield</span>
          </a>
          <nav className="lg-topnav" aria-label="Secondary">
            <Link to="/about">About</Link>
          </nav>
        </div>

        <div className="lg-center">
          <div className="lg-col">
            <h1 className="lg-h lg-rise">
              {modeIsSignup ? (<>Create your <em>account.</em></>) : (<>Welcome <em>back.</em></>)}
            </h1>
            <p className="lg-sub lg-rise" style={{ '--lg-d': '60ms' }}>
              {modeIsSignup
                ? 'One account, and the scanner starts watching for copied content.'
                : 'Sign in to run a scan and see what has been copied.'}
            </p>

            <div className="lg-oauth lg-rise" style={{ '--lg-d': '110ms' }}>
              <button
                type="button"
                className="lg-provider"
                disabled={!googleReady || busy}
                onClick={() => { window.location.assign('/api/auth/google/start'); }}
              >
                <GoogleMark />
                <span>Continue with Google</span>
              </button>
              <button
                type="button"
                className="lg-provider"
                disabled={!githubReady || busy}
                onClick={() => { window.location.assign('/api/auth/github/start'); }}
              >
                <GitHubMark />
                <span>Continue with GitHub</span>
              </button>
              {missingProviders.length > 0 && (
                <p className="lg-note">
                  Sign-in with {missingProviders.join(' and ')} is not configured on this deployment. Use your email below.
                </p>
              )}
            </div>

            <div className="lg-or" role="separator" aria-label="or">or continue with email</div>

            <form onSubmit={submit} noValidate className="lg-form">
              {modeIsSignup && (
                <label className="lg-field">
                  <span className="lg-label">Name</span>
                  <input
                    className="lg-input" value={name} onChange={(e) => setName(e.target.value)}
                    autoComplete="name" placeholder="Optional" />
                </label>
              )}
              <label className="lg-field">
                <span className="lg-label">Email</span>
                <input
                  className="lg-input" type="email" required value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email" placeholder="you@example.com" aria-invalid={!!error} />
              </label>
              <label className="lg-field">
                <span className="lg-label">Password</span>
                <input
                  className="lg-input" type="password" required value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={modeIsSignup ? 'new-password' : 'current-password'}
                  placeholder="At least 8 characters" aria-invalid={!!error} />
              </label>

              {error && (
                <p className="lg-alert" role="alert"><AlertIcon /><span>{error}</span></p>
              )}
              {notice && <p className="lg-status" role="status">{notice}</p>}

              <button className="lg-submit" type="submit" disabled={busy}>
                {busy ? <span className="spinner" /> : null}
                {modeIsSignup ? 'Create account' : 'Sign in'}
              </button>
            </form>

            <p className="lg-switch">
              {modeIsSignup ? 'Already have an account?' : 'No account yet?'}{' '}
              <button className="lg-link" type="button" onClick={switchMode}>
                {modeIsSignup ? 'Sign in' : 'Create one'}
              </button>
            </p>

            <p className="lg-legal">
              By continuing you agree to our <a href="/app/privacy">Privacy Policy</a>.
              {' · '}
              <Link to="/about">About SaaS Shield</Link>
            </p>
          </div>
        </div>
      </div>

      <aside className="lg-aside">
        <span className="lg-thread" aria-hidden="true" />
        <p className="lg-quote">
          Know the moment your pages show up <span className="lg-quiet">somewhere else.</span>
        </p>
        <ul className="lg-points">
          <li><span className="lg-tick" aria-hidden="true">i</span><span>Scans the sites you choose, on demand</span></li>
          <li><span className="lg-tick" aria-hidden="true">ii</span><span>Shows the matching passage side by side</span></li>
          <li><span className="lg-tick" aria-hidden="true">iii</span><span>Keeps a report you can export and share</span></li>
        </ul>
        <p className="lg-aside-foot">
          Built in public. <Link to="/about">Read the story</Link>
        </p>
      </aside>
    </div>
  );
}
