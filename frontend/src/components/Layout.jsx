import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import Icon from './Icon.jsx';

function Logo() {
  return (
    <Link to="/" className="logo" aria-label="SaaS Shield home">
      <img src={`${import.meta.env.BASE_URL}logo.png`} srcSet={`${import.meta.env.BASE_URL}logo.png 1x`} alt="SaaS Shield" width="40" height="44" className="logo-img" />
      <span>SaaS Shield</span>
    </Link>
  );
}

// Every item here goes somewhere real. Settings, Help and Account have no
// backend route yet, so they are not shown rather than shown disabled.
const MENU = [
  { label: 'Dashboard', icon: 'home', to: '/' },
  { label: 'Reports', icon: 'reports', to: '/history' },
  { label: 'Competitors', icon: 'chart', to: '/competitors' },
  { label: 'History', icon: 'history', to: '/history' },
  { label: 'Settings', icon: 'settings', to: '/settings' },
];

export default function Layout({ session, workspace, onSignOut }) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const panel = useRef(null);
  const toggle = useRef(null);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      if (toggle.current) toggle.current.focus();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = panel.current && panel.current.querySelector('a, button');
    if (first) first.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const email = session && session.user ? session.user.email : '';

  return (
    <div className="shell">
      <header className="topbar">
        <Logo />
        <button
          ref={toggle}
          type="button"
          className={`menu-toggle${open ? ' is-open' : ''}`}
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          aria-controls="site-menu"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="menu-toggle-txt">{open ? 'Close' : 'Menu'}</span>
          <span className="menu-toggle-icon" aria-hidden="true"><i /><i /></span>
        </button>
      </header>

      <main className="main"><Outlet /></main>

      <footer className="footer">
        <span>© {new Date().getFullYear()} SaaS Shield</span>
        <nav aria-label="Legal"><Link to="/privacy">Privacy Policy</Link></nav>
      </footer>

      {/* Side menu ported from the approved preview: colour slabs sweep in first,
          the light panel follows. All links stay real routes. */}
      <div className={`drawer${open ? ' is-open' : ''}`} aria-hidden={open ? undefined : 'true'}>
        <button type="button" className="drawer-scrim" tabIndex={-1} aria-hidden="true" onClick={() => setOpen(false)} />
        <div className="drawer-layers" aria-hidden="true">
          <span className="drawer-layer drawer-layer-lilac" />
          <span className="drawer-layer drawer-layer-violet" />
        </div>
        <aside
          id="site-menu"
          ref={panel}
          className="drawer-panel"
          role="dialog"
          aria-modal={open ? 'true' : undefined}
          aria-label="Site menu"
          inert={open ? undefined : ''}
        >
          <div className="drawer-head">
            <p className="drawer-kicker">Menu</p>
            {workspace && <p className="drawer-account">{workspace.name}{email ? ` · ${email}` : ''}</p>}
          </div>
          <nav className="drawer-list" aria-label="Primary">
            {MENU.map((m, i) => (
              <NavLink key={m.label} to={m.to} end className="drawer-item">
                <span className="drawer-num">{String(i + 1).padStart(2, '0')}</span>
                <span className="drawer-label">{m.label}</span>
                <Icon name="arrow" size={18} className="drawer-arrow" />
              </NavLink>
            ))}
          </nav>
          <div className="drawer-foot">
            <Link to="/privacy" className="drawer-legal">Privacy Policy</Link>
            <button type="button" className="drawer-signout" onClick={onSignOut}>
              <Icon name="logout" size={18} />Sign out
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
