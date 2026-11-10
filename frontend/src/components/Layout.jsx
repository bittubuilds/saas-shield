import { Link, Outlet, useLocation } from 'react-router-dom';
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
  // The dashboard closes on its own screen; every other route keeps the slim legal strip.
  const onDashboard = useLocation().pathname === '/';
  const items = MENU.map((m) => ({ label: m.label, ariaLabel: `Go to ${m.label}`, link: m.to }));
  const more = [
    ...['Features', 'Pricing', 'Docs'].map((l) => ({ label: l, link: `/#${l.toLowerCase()}` })),
    { label: 'About', link: '/about' },
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
      {onDashboard ? (
        <footer className="closing db-closing">
          <div className="wrap">
            <div className="db-closing-top db-split">
              <div className="db-split-l">
                <p className="db-closing-eye">SaaS Shield</p>
                <p className="db-closing-line">Your words were first.<br /><em>Keep the proof.</em></p>
              </div>
              <ul className="db-closing-list db-split-r">
                <li><span>01</span>The passage that matched</li>
                <li><span>02</span>The page it was found on</li>
                <li><span>03</span>The day you saw it</li>
                <li><span>04</span>The competitor's copy, side by side</li>
                <li><span>05</span>Your words, quoted in the report</li>
                <li><span>06</span>One PDF, ready to send</li>
              </ul>
            </div>
            <div className="db-closing-foot">
              <span>© {new Date().getFullYear()} SaaS Shield</span>
              <nav aria-label="Legal" className="footer-links">
                <Link to="/about">About</Link>
                <Link to="/privacy">Privacy Policy</Link>
              </nav>
            </div>
          </div>
        </footer>
      ) : (
        <footer className="footer">
          <div className="wrap footer-wrap">
            <span>© {new Date().getFullYear()} SaaS Shield</span>
            <nav aria-label="Legal" className="footer-links">
              <Link to="/about">About</Link>
              <Link to="/privacy">Privacy Policy</Link>
            </nav>
          </div>
        </footer>
      )}
    </div>
  );
}
