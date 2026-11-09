import { Link, Outlet } from 'react-router-dom';
import StaggeredMenu from './StaggeredMenu.jsx';

function Logo() {
  return (
    <Link to="/" className="logo" aria-label="SaaS Shield home">
      <img className="logo-img" src={`${import.meta.env.BASE_URL}logo.png`} alt="" width="34" height="38" />
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
  const email = session && session.user ? session.user.email : '';
  const items = MENU.map((m) => ({ label: m.label, ariaLabel: `Go to ${m.label}`, link: m.to }));
  const more = [
    ...['Features', 'Pricing', 'About', 'Docs'].map((l) => ({ label: l, link: `/#${l.toLowerCase()}` })),
    { label: 'Privacy', link: '/privacy' },
    { label: 'Sign out', onClick: onSignOut },
  ];

  return (
    <div className="shell">
      <StaggeredMenu position="right" items={items} socialItems={more} displaySocials displayItemNumbering
        menuButtonColor="#ffffff" openMenuButtonColor="#0b0b10" changeMenuColorOnOpen
        colors={['#B497CF', '#5227FF']} accentColor="#5227FF" logo={<Logo />}>
        {workspace && <p className="sm-account">{workspace.name}{email ? ` · ${email}` : ''}</p>}
      </StaggeredMenu>
      <div className="nav-spacer" aria-hidden="true" />
      <main className="main"><Outlet /></main>
      <footer className="footer">
        <span>© {new Date().getFullYear()} SaaS Shield</span>
        <nav aria-label="Legal"><Link to="/privacy">Privacy Policy</Link></nav>
      </footer>
    </div>
  );
}
