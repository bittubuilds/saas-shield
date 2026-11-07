import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import Icon from './Icon.jsx';

function Logo() {
  return (
    <Link to="/" className="logo" aria-label="SaaS Shield home">
      <img src="/logo.png" alt="" width="40" height="44" className="logo-img" />
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
];

export default function Layout({ session, workspace, onSignOut }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const { pathname } = useLocation();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    const onDown = (e) => wrap.current && !wrap.current.contains(e.target) && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [open]);

  const email = session && session.user ? session.user.email : '';

  return (
    <div className="shell">
      <header className="nav">
        <Logo />
        <nav className="nav-links" aria-label="Primary">
          {['Features', 'Pricing', 'About', 'Docs'].map((l) => <Link key={l} to={`/#${l.toLowerCase()}`}>{l}</Link>)}
        </nav>
        <div className="menu-wrap" ref={wrap}>
          <button className="menu-btn" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open}
            aria-controls="main-menu" onClick={() => setOpen((o) => !o)}>
            <Icon name={open ? 'close' : 'menu'} size={24} />
          </button>
          {open && (
            <nav id="main-menu" className="menu-panel" aria-label="Account menu">
              {workspace && <p className="menu-account">{workspace.name}{email ? ` · ${email}` : ''}</p>}
              {MENU.map((m) => (
                <NavLink key={m.label} to={m.to} end className="menu-item"><Icon name={m.icon} size={18} />{m.label}</NavLink>
              ))}
              <button className="menu-item" onClick={onSignOut}><Icon name="logout" size={18} />Sign out</button>
            </nav>
          )}
        </div>
      </header>
      <main className="main"><Outlet /></main>
    </div>
  );
}
