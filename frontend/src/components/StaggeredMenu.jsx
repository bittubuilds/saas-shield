import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

/**
 * Staggered Menu (React Bits behaviour, dependency-free): the header shows a logo and a Menu/Close toggle.
 * Opening slides coloured pre-layers in from the edge, then the panel, then the items rise in one by one.
 * All motion is CSS transitions, so it costs nothing at rest and reduced-motion turns it off.
 */
export default function StaggeredMenu({
  position = 'right', items = [], socialItems = [], displaySocials = true, displayItemNumbering = true,
  menuButtonColor = '#fff', openMenuButtonColor = '#0b0b10', changeMenuColorOnOpen = true,
  colors = ['#B497CF', '#5227FF'], accentColor = '#5227FF', panelBg = '#ffffff', panelText = '#0b0b10',
  logo = null, onMenuOpen, onMenuClose, children,
}) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const panel = useRef(null);
  const toggle = useRef(null);
  const first = useRef(true);
  const { pathname } = useLocation();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on(); window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);

  useEffect(() => {
    if (panel.current) panel.current.inert = !open;           // closed panel is unreachable by keyboard and screen readers
    if (first.current) { first.current = false; return undefined; }
    if (open) {
      onMenuOpen && onMenuOpen();
      const t = setTimeout(() => panel.current && panel.current.querySelector('a, button') && panel.current.querySelector('a, button').focus({ preventScroll: true }), 650);
      const html = document.documentElement, prev = html.style.overflow; html.style.overflow = 'hidden';
      const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
      document.addEventListener('keydown', onKey);
      return () => { clearTimeout(t); html.style.overflow = prev; document.removeEventListener('keydown', onKey); };
    }
    onMenuClose && onMenuClose();
    if (toggle.current && panel.current && panel.current.contains(document.activeElement)) toggle.current.focus();
    return undefined;
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const layers = colors.slice(0, 4);
  const style = { '--sm-accent': accentColor, '--sm-panel': panelBg, '--sm-text': panelText, '--sm-n': layers.length,
    '--sm-btn': changeMenuColorOnOpen && open ? openMenuButtonColor : menuButtonColor };

  return (
    <div className={`sm-wrap sm-${position} ${open ? 'is-open' : ''} ${scrolled && !open ? 'is-scrolled' : ''}`} style={style} data-open={open}>
      {open && <div className="sm-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
      <header className="nav sm-header">
        <div className="sm-logo">{logo}</div>
        <button ref={toggle} className="sm-toggle nav__toggle" type="button" aria-expanded={open} aria-controls="sm-panel"
          aria-label={open ? 'Close menu' : 'Open menu'} onClick={() => setOpen((o) => !o)}>
          <span className="sm-txt" aria-hidden="true"><span className="sm-txt-in">{open ? 'Close' : 'Menu'}</span></span>
          <span className="sm-icon" aria-hidden="true"><i /><i /></span>
        </button>
      </header>

      <div className="sm-layers" aria-hidden="true">
        {layers.map((c, i) => <span key={c + i} className="sm-layer" style={{ background: c, '--i': i }} />)}
      </div>
      <aside ref={panel} id="sm-panel" className="sm-panel" aria-label="Site menu">
        <nav aria-label="Primary">
          <ul className="sm-list" style={{ counterReset: 'smi' }}>
            {items.map((it, i) => (
              <li key={it.label} className="sm-li" style={{ '--i': i }}>
                <NavLink to={it.link} end className="sm-link" aria-label={it.ariaLabel} onClick={it.onClick}>
                  <span className="sm-item-in">{it.label}</span>
                  {displayItemNumbering && <span className="sm-num" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="sm-foot" style={{ '--i': items.length }}>
          {children}
          {displaySocials && socialItems.length > 0 && (
            <ul className="sm-social" aria-label="More">
              {socialItems.map((s) => <li key={s.label}>{s.onClick
                ? <button type="button" onClick={s.onClick}>{s.label}</button>
                : <NavLink to={s.link}>{s.label}</NavLink>}</li>)}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
