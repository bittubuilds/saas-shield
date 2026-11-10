import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { SECTIONS } from '../docs/content.js';
import '../docs.css';

/* ---------------------------------------------------------------- helpers */

const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

const FLAT = SECTIONS.flatMap((section) =>
  section.items.map((article) => ({ ...article, sectionId: section.id, sectionTitle: section.title }))
);

const BY_SLUG = new Map(FLAT.map((a) => [a.slug, a]));

/** Every block's text, for search and for the reading-time figure. */
function blockText(block) {
  switch (block.t) {
    case 'p': case 'h2': case 'h3': return block.x || '';
    case 'ul': case 'ol': return (block.items || []).join(' ');
    case 'steps': return (block.items || []).map((s) => `${s.title} ${s.text}`).join(' ');
    case 'table': return [...(block.head || []), ...(block.rows || []).flat()].join(' ');
    case 'callout': return `${block.title || ''} ${block.text || ''}`;
    default: return '';
  }
}

const articleText = (a) => [a.title, a.summary, ...(a.blocks || []).map(blockText)].join(' ');

const plain = (s) => String(s).replace(/\*\*|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

/* ------------------------------------------------------------------ inline */

/** **bold**, `code` and [label](/path). Nothing else: content stays plain text. */
function Inline({ text }) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g).filter(Boolean);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const [, label, href] = link;
      return href.startsWith('/')
        ? <Link key={i} to={href}>{label}</Link>
        : <a key={i} href={href} target="_blank" rel="noreferrer noopener">{label}</a>;
    }
    return <span key={i}>{part}</span>;
  });
}

/* ------------------------------------------------------------------ blocks */

function Block({ block, headings, index }) {
  switch (block.t) {
    case 'h2':
    case 'h3': {
      const id = headings[index];
      return block.t === 'h2'
        ? <h2 id={id} className="dc-h2">{block.x}</h2>
        : <h3 id={id} className="dc-h3">{block.x}</h3>;
    }
    case 'p':
      return <p className="dc-p"><Inline text={block.x} /></p>;
    case 'ul':
      return <ul className="dc-ul">{block.items.map((it, i) => <li key={i}><Inline text={it} /></li>)}</ul>;
    case 'ol':
      return <ol className="dc-ol">{block.items.map((it, i) => <li key={i}><Inline text={it} /></li>)}</ol>;
    case 'steps':
      return (
        <ol className="dc-steps">
          {block.items.map((s, i) => (
            <li key={i}>
              <span className="dc-step-n" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
              <div>
                <p className="dc-step-t">{s.title}</p>
                <p className="dc-p"><Inline text={s.text} /></p>
              </div>
            </li>
          ))}
        </ol>
      );
    case 'table':
      return (
        <div className="dc-table-wrap">
          <table className="dc-table">
            <thead><tr>{block.head.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>{row.map((cell, c) => <td key={c}><Inline text={cell} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'callout':
      return (
        <aside className={`dc-callout dc-${block.kind || 'note'}`} role="note">
          {block.title && <p className="dc-callout-t">{block.title}</p>}
          <p className="dc-callout-x"><Inline text={block.text} /></p>
        </aside>
      );
    case 'related': {
      const items = (block.slugs || []).map((s) => BY_SLUG.get(s)).filter(Boolean);
      if (!items.length) return null;
      return (
        <nav className="dc-related" aria-label="Read next">
          <p className="dc-related-h">Read next</p>
          <ul>
            {items.map((a) => (
              <li key={a.slug}>
                <Link to={`/docs/${a.slug}`}>
                  <span>{a.title}</span>
                  <em>{a.sectionTitle}</em>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      );
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ search */

function buildIndex() {
  return FLAT.map((a) => ({
    slug: a.slug,
    title: a.title,
    section: a.sectionTitle,
    summary: a.summary,
    text: articleText(a),
  }));
}

function searchDocs(index, rawQuery) {
  const q = rawQuery.trim().toLowerCase();
  if (q.length < 2) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  return index
    .map((doc) => {
      const title = doc.title.toLowerCase();
      const summary = (doc.summary || '').toLowerCase();
      const text = doc.text.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (!text.includes(term)) return null;              // every term must appear somewhere
        if (title === term) score += 12;
        if (title.includes(term)) score += 6;
        if (summary.includes(term)) score += 3;
        score += Math.min(6, text.split(term).length - 1);
      }
      const at = text.indexOf(terms[0]);
      const from = Math.max(0, at - 60);
      const snippet = plain(doc.text.slice(from, from + 190)).trim();
      return { ...doc, score, snippet: `${from > 0 ? '…' : ''}${snippet}${doc.text.length > from + 190 ? '…' : ''}` };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

function SearchBox({ index, onGo, autoFocus, idPrefix }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchDocs(index, q), [index, q]);
  const wrap = useRef(null);

  useEffect(() => { setActive(0); }, [q]);

  // A click anywhere else closes the result list without stealing the query.
  useEffect(() => {
    function onDoc(e) { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function go(slug) { setOpen(false); setQ(''); onGo(slug); }

  function onKeyDown(e) {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (!results.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => (i + 1) % results.length); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); setActive((i) => (i - 1 + results.length) % results.length); }
    if (e.key === 'Enter') { e.preventDefault(); go(results[Math.min(active, results.length - 1)].slug); }
  }

  const listId = `${idPrefix}-results`;
  const show = open && q.trim().length >= 2;

  return (
    <div className="dc-search" ref={wrap}>
      <label className="dc-search-label" htmlFor={`${idPrefix}-input`}>Search documentation</label>
      <div className="dc-search-field">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" strokeLinecap="round" />
        </svg>
        <input
          id={`${idPrefix}-input`}
          type="search"
          value={q}
          autoFocus={autoFocus}
          placeholder="Scan, report, limits…"
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={show}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={show && results[active] ? `${listId}-${active}` : undefined}
        />
      </div>

      {show && (
        results.length ? (
          <ul className="dc-results" id={listId} role="listbox" aria-label="Search results">
            {results.map((r, i) => (
              <li key={r.slug} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
                <button type="button" onMouseEnter={() => setActive(i)} onClick={() => go(r.slug)}>
                  <span className="dc-result-t">{r.title}</span>
                  <span className="dc-result-s">{r.section}</span>
                  <span className="dc-result-x">{r.snippet}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="dc-results-empty" id={listId}>No article matches “{q.trim()}”. Try a shorter word, such as <em>scan</em> or <em>report</em>.</p>
        )
      )}
    </div>
  );
}

/* -------------------------------------------------------------- navigation */

function SidebarNav({ activeSlug, onNavigate, idPrefix }) {
  return (
    <nav className="dc-nav" aria-label="Documentation">
      {SECTIONS.map((section) => (
        <div className="dc-nav-group" key={section.id}>
          <p className="dc-nav-h">{section.title}</p>
          <ul>
            {section.items.map((a) => (
              <li key={a.slug}>
                <Link
                  to={`/docs/${a.slug}`}
                  className={a.slug === activeSlug ? 'is-active' : undefined}
                  aria-current={a.slug === activeSlug ? 'page' : undefined}
                  onClick={onNavigate}
                  id={`${idPrefix}-${a.slug}`}
                >
                  {a.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function TableOfContents({ headings }) {
  const [active, setActive] = useState(headings[0]?.id || '');
  const ids = headings.map((h) => h.id).join('|');

  useEffect(() => {
    if (!headings.length) return undefined;
    const nodes = headings.map((h) => document.getElementById(h.id)).filter(Boolean);
    if (!nodes.length) return undefined;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-88px 0px -68% 0px', threshold: [0, 1] }
    );
    nodes.forEach((n) => obs.observe(n));
    return () => obs.disconnect();
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps

  if (headings.length < 2) return null;

  return (
    <nav className="dc-toc" aria-label="On this page">
      <p className="dc-toc-h">On this page</p>
      <ul>
        {headings.map((h) => (
          <li key={h.id} className={h.level === 3 ? 'is-sub' : undefined}>
            <a
              href={`#${h.id}`}
              className={h.id === active ? 'is-active' : undefined}
              aria-current={h.id === active ? 'true' : undefined}
              onClick={(e) => {
                e.preventDefault();
                const el = document.getElementById(h.id);
                if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); el.setAttribute('tabindex', '-1'); }
              }}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* -------------------------------------------------------------------- page */

export default function Docs({ signedIn }) {
  const { slug } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const index = useMemo(buildIndex, []);
  const [drawer, setDrawer] = useState(false);
  const closeDrawer = useCallback(() => setDrawer(false), []);

  const article = slug ? BY_SLUG.get(slug) : null;
  const position = article ? FLAT.findIndex((a) => a.slug === article.slug) : -1;
  const prev = position > 0 ? FLAT[position - 1] : null;
  const next = position >= 0 && position < FLAT.length - 1 ? FLAT[position + 1] : null;

  // Each article starts at the top: a hash would otherwise land mid-page.
  useEffect(() => {
    if (!location.hash) window.scrollTo({ top: 0, behavior: 'auto' });
    setDrawer(false);
  }, [slug, location.hash]);

  // Close the mobile drawer with Escape, and keep it out of the tab order when shut.
  useEffect(() => {
    if (!drawer) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setDrawer(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);

  const headings = useMemo(() => {
    if (!article) return [];
    return (article.blocks || [])
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.t === 'h2' || b.t === 'h3')
      .map(({ b, i }) => ({ id: `s-${i}-${slugify(b.x)}`, text: plain(b.x), level: b.t === 'h2' ? 2 : 3 }));
  }, [article]);

  const headingIds = useMemo(() => {
    const map = {};
    if (!article) return map;
    (article.blocks || []).forEach((b, i) => { if (b.t === 'h2' || b.t === 'h3') map[i] = `s-${i}-${slugify(b.x)}`; });
    return map;
  }, [article]);

  const onGo = useCallback((nextSlug) => navigate(`/docs/${nextSlug}`), [navigate]);

  if (slug && !article) {
    return (
      <div className="dc-shell">
        <DocsHeader signedIn={signedIn} />
        <main className="dc-main" id="dc-main">
          <section className="dc-article dc-missing">
            <p className="dc-crumb">Docs</p>
            <h1 className="dc-h1">That page does not exist</h1>
            <p className="dc-p">No article matches <code>{slug}</code>. It may have been renamed. Start from the [introduction](/docs/introduction) or search the docs.</p>
            <p className="dc-p"><Link to="/docs">Back to the documentation index</Link></p>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className={`dc-shell${drawer ? ' is-drawer' : ''}`}>
      <DocsHeader signedIn={signedIn} />

      <div className="dc-layout">
        <aside className="dc-side" id="dc-side">
          <div className="dc-side-inner">
            <SearchBox index={index} onGo={onGo} idPrefix="side" />
            <SidebarNav activeSlug={article ? article.slug : ''} onNavigate={closeDrawer} idPrefix="side-link" />
          </div>
        </aside>

        {drawer && <button type="button" className="dc-scrim" aria-label="Close navigation" onClick={closeDrawer} />}

        <main className="dc-main" id="dc-main">
          {article ? (
            <article className="dc-article">
              <nav className="dc-crumb" aria-label="Breadcrumb">
                <Link to="/docs">Docs</Link>
                <span aria-hidden="true">/</span>
                <Link to={`/docs#${article.sectionId}`}>{article.sectionTitle}</Link>
              </nav>

              <h1 className="dc-h1">{article.title}</h1>
              <p className="dc-summary">{article.summary}</p>

              <div className="dc-body">
                {(article.blocks || []).map((block, i) => (
                  <Block key={i} block={block} headings={headingIds} index={i} />
                ))}
              </div>

              <nav className="dc-pager" aria-label="Article navigation">
                {prev ? (
                  <Link className="dc-pager-link" to={`/docs/${prev.slug}`} rel="prev">
                    <span>Previous</span>
                    <strong>{prev.title}</strong>
                  </Link>
                ) : <span />}
                {next ? (
                  <Link className="dc-pager-link dc-pager-next" to={`/docs/${next.slug}`} rel="next">
                    <span>Next</span>
                    <strong>{next.title}</strong>
                  </Link>
                ) : <span />}
              </nav>
            </article>
          ) : (
            <section className="dc-article dc-index">
              <p className="dc-crumb">Documentation</p>
              <h1 className="dc-h1">SaaS Shield documentation</h1>
              <p className="dc-summary">
                How the product actually works: scanning, similarity detection, reports and the account.
                Every article describes this build, including the limits it has.
              </p>

              <div className="dc-index-search">
                <SearchBox index={index} onGo={onGo} idPrefix="index" />
              </div>

              <div className="dc-cards">
                {SECTIONS.map((section) => (
                  <section className="dc-card" key={section.id} id={section.id} aria-labelledby={`h-${section.id}`}>
                    <h2 className="dc-card-h" id={`h-${section.id}`}>{section.title}</h2>
                    <ul>
                      {section.items.map((a) => (
                        <li key={a.slug}>
                          <Link to={`/docs/${a.slug}`}>
                            <span className="dc-card-t">{a.title}</span>
                            <span className="dc-card-s">{a.summary}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>

              <aside className="dc-callout dc-limit" role="note">
                <p className="dc-callout-t">What these docs never do</p>
                <p className="dc-callout-x">
                  They do not describe a feature that is not in the code, do not claim a certification or a
                  legal outcome, and do not document an API that customers cannot call. Where something is
                  unfinished, it is labelled. See <Link to="/docs/not-available-yet">Not available yet</Link>.
                </p>
              </aside>
            </section>
          )}

          <footer className="dc-foot">
            <p>© {new Date().getFullYear()} SaaS Shield</p>
            <nav aria-label="Documentation footer">
              <Link to="/docs">Docs index</Link>
              <Link to="/about">About</Link>
              <Link to="/privacy">Privacy Policy</Link>
              <Link to="/docs/contacting-support">Support</Link>
            </nav>
          </footer>
        </main>

        <div className="dc-toc-col">{article && <TableOfContents headings={headings} />}</div>
      </div>

      <button
        type="button"
        className="dc-drawer-btn"
        aria-expanded={drawer}
        aria-controls="dc-side"
        onClick={() => setDrawer((v) => !v)}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" />
        </svg>
        {drawer ? 'Close contents' : 'Contents'}
      </button>
    </div>
  );
}

function DocsHeader({ signedIn }) {
  return (
    <header className="dc-head">
      <div className="dc-head-in">
        <Link to="/docs" className="dc-brand" aria-label="SaaS Shield documentation">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" width="26" height="29" />
          <span>SaaS Shield</span>
          <em>Docs</em>
        </Link>
        <nav className="dc-head-nav" aria-label="Product">
          <Link to="/about">About</Link>
          {signedIn
            ? <Link className="dc-head-cta" to="/">Dashboard</Link>
            : <Link className="dc-head-cta" to="/login">Sign in</Link>}
        </nav>
      </div>
    </header>
  );
}
