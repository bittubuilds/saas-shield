import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import '../about.css';

// Official Bittu Builds site (the address that is actually live today). Kept in
// one place so the page never drifts from the real link.
const BITTU_BUILDS = 'https://bittubuilds.github.io/bittu-builds/';

const CAPABILITIES = [
  {
    title: 'Scan the sites you choose',
    text: 'Register a site you own, add the sites you want to compare against, and run a scan. SaaS Shield crawls the pages, then reads them side by side.'
  },
  {
    title: 'Find the passages that look alike',
    text: 'Page text is compared passage by passage, so similarity is judged on wording rather than on a single shared word. Matches that clear the threshold are kept.'
  },
  {
    title: 'Review each match yourself',
    text: 'Every finding shows the original passage next to the matching one, with the pages it came from. Nothing is hidden behind a score.'
  },
  {
    title: 'Keep the evidence organised',
    text: 'Findings, page details and screenshots stay grouped in a report you can come back to, share, or export as a PDF.'
  }
];

function useReveal() {
  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll('.ab [data-reveal]'));
    if (!nodes.length) return undefined;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || typeof IntersectionObserver === 'undefined') {
      nodes.forEach((n) => n.classList.add('is-in'));
      return undefined;
    }

    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });

    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, []);
}

function useReadingProgress() {
  useEffect(() => {
    const bar = document.querySelector('.ab-progress');
    if (!bar) return undefined;
    let frame = 0;

    const update = () => {
      frame = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const pct = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      bar.style.transform = `scaleX(${pct})`;
    };
    const onScroll = () => { if (!frame) frame = window.requestAnimationFrame(update); };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);
}

export default function About({ signedIn = false }) {
  const home = signedIn ? '/' : '/login';
  const ctaTo = signedIn ? '/' : '/login';
  const ctaLabel = signedIn ? 'Go to your dashboard' : 'Start a scan';
  const wrapRef = useRef(null);

  useReveal();
  useReadingProgress();

  useEffect(() => {
    const previous = document.title;
    document.title = 'About — SaaS Shield';
    window.scrollTo(0, 0);
    return () => { document.title = previous; };
  }, []);

  return (
    <div className="ab" ref={wrapRef}>
      <div className="ab-progress" aria-hidden="true" />

      <header className="ab-header">
        <Link className="ab-brand" to={home} aria-label="SaaS Shield">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" width="26" height="29" />
          <span>SaaS Shield</span>
        </Link>
        <nav className="ab-nav" aria-label="Secondary">
          <Link className="ab-nav-mid" to={home}>{signedIn ? 'Dashboard' : 'Sign in'}</Link>
          <Link className="ab-nav-strong" to="/about" aria-current="page">About</Link>
        </nav>
      </header>

      {/* 01 — hero ---------------------------------------------------------- */}
      <section className="ab-section ab-hero">
        <div className="ab-wrap">
          <p className="ab-eyebrow"><span className="ab-num">01</span> About SaaS Shield</p>

          <h1 className="ab-hero-h">
            <span className="ab-line"><span style={{ '--i': 0 }}>Built by a builder.</span></span>
            <span className="ab-line"><span style={{ '--i': 1 }}>For the people</span></span>
            <span className="ab-line"><span style={{ '--i': 2 }} className="ab-hero-em">who build.</span></span>
          </h1>

          <div className="ab-hero-body">
            <div className="ab-hero-copy">
              <p>Every great product starts with someone who decides to build something of their own.</p>
              <p>But building something original is only half the journey.</p>
              <p>Protecting the work behind it matters too.</p>
              <p className="ab-welcome">Welcome to SaaS Shield.</p>
            </div>
            <a className="ab-cue" href="#the-problem" aria-label="Scroll to the story">
              <span className="ab-cue-rail" aria-hidden="true"><i /></span>
              <span>Scroll</span>
            </a>
          </div>
        </div>
      </section>

      {/* 02 — the problem --------------------------------------------------- */}
      <section className="ab-section" id="the-problem">
        <div className="ab-wrap">
          <p className="ab-eyebrow"><span className="ab-num">02</span> The problem</p>

          <h2 className="ab-h" data-reveal>
            You build it.<br />
            Someone copies it.
            <span className="ab-serif-line">What happens next?</span>
          </h2>

          <div className="ab-problem">
            <div className="ab-problem-lead ab-body">
              <p data-reveal>
                You know what went into it. The structure nobody notices, the wording rewritten
                six times, the small decisions that make a page feel like yours.
              </p>
              <p data-reveal>
                Then one day something looks familiar. A headline. A pricing table. A paragraph you
                wrote yourself, sitting inside someone else&rsquo;s product.
              </p>
              <p data-reveal>
                Copied work rarely announces itself. It lives on a page you had no reason to open,
                and by the time it feels familiar, the trail has already gone cold. Most builders
                never look at all.
              </p>
            </div>

            <ul className="ab-beats">
              <li className="ab-beat" data-reveal>
                <span className="ab-beat-k">i</span>
                <h3>The work is invisible</h3>
                <p>What makes a product feel considered is exactly what nobody sees from outside.</p>
              </li>
              <li className="ab-beat" data-reveal style={{ '--ab-delay': '90ms' }}>
                <span className="ab-beat-k">ii</span>
                <h3>Copy travels quietly</h3>
                <p>A lifted section does not ping you. It simply exists somewhere else, unannounced.</p>
              </li>
              <li className="ab-beat" data-reveal style={{ '--ab-delay': '180ms' }}>
                <span className="ab-beat-k">iii</span>
                <h3>You find out late</h3>
                <p>Without a habit of checking, the first time you notice is usually by accident.</p>
              </li>
            </ul>
          </div>

          <div className="ab-problem-line" aria-hidden="true" />
        </div>
      </section>

      {/* 03 — the founder --------------------------------------------------- */}
      <section className="ab-section" id="founder">
        <div className="ab-wrap">
          <p className="ab-eyebrow"><span className="ab-num">03</span> The founder</p>

          <div className="ab-founder">
            <figure className="ab-portrait" data-reveal>
              <img
                src={`${import.meta.env.BASE_URL}founder-bittu.webp`}
                alt="Bittu, founder of SaaS Shield and Bittu Builds, photographed in black and white."
                width="1856"
                height="2320"
                loading="lazy"
                decoding="async"
              />
              <figcaption>Bittu · Founder, SaaS Shield</figcaption>
            </figure>

            <div>
              <h2 className="ab-founder-h" data-reveal>Meet the founder.</h2>
              <p className="ab-founder-statement" data-reveal>
                I&rsquo;m Bittu. <span className="ab-quiet">And I love building things.</span>
              </p>

              <div className="ab-body">
                <p data-reveal>
                  I&rsquo;m the person behind Bittu Builds and the founder building SaaS Shield.
                </p>
                <p data-reveal>
                  I&rsquo;m a young builder interested in startups, technology, AI, and turning ideas
                  into real products.
                </p>
                <p data-reveal>
                  I started Bittu Builds to document the actual journey of building businesses and
                  products &mdash; not just the finished results.
                </p>
              </div>

              <ul className="ab-list" data-reveal>
                <li><span>01</span> The experiments.</li>
                <li><span>02</span> The mistakes.</li>
                <li><span>03</span> The difficult decisions.</li>
                <li><span>04</span> The lessons that come from building something from scratch.</li>
              </ul>

              <div className="ab-body">
                <p data-reveal>SaaS Shield is one part of that journey.</p>
                <p data-reveal>
                  I&rsquo;m not here to pretend I have everything figured out. I&rsquo;m here to build,
                  learn, improve, and share the process.
                </p>
              </div>

              <p className="ab-founder-statement" style={{ marginBottom: 0 }} data-reveal>
                One idea at a time. <span className="ab-quiet">One product at a time.</span>
              </p>

              <div className="ab-sign" data-reveal>
                <span className="ab-sign-name">Bittu</span>
                <span className="ab-sign-role">Founder, SaaS Shield</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 04 — two brands ---------------------------------------------------- */}
      <section className="ab-section" id="journey">
        <div className="ab-wrap">
          <p className="ab-eyebrow"><span className="ab-num">04</span> Two brands, one belief</p>

          <h2 className="ab-h" data-reveal>
            More than a product.
            <span className="ab-serif-line">It&rsquo;s part of a bigger journey.</span>
          </h2>

          <div className="ab-brands-body ab-body">
            <div>
              <p data-reveal>
                Bittu Builds is my personal brand. It&rsquo;s where I document what I&rsquo;m learning,
                what I&rsquo;m building, and the challenges behind turning ideas into actual
                businesses.
              </p>
              <p data-reveal>
                SaaS Shield is one of the products I&rsquo;m building through that journey.
              </p>
            </div>
            <div>
              <p data-reveal className="ab-loud">
                Two different identities.<br />One shared belief:
              </p>
            </div>
          </div>

          <div className="ab-bridge">
            <div className="ab-bridge-row">
              <div className="ab-node" data-reveal>
                <p className="ab-node-k">The journey</p>
                <a className="ab-node-label" href={BITTU_BUILDS} target="_blank" rel="noopener noreferrer">
                  Bittu Builds<span className="ab-node-arrow" aria-hidden="true">↗</span>
                </a>
                <p className="ab-node-note">Building in public: what worked, what failed, what changed.</p>
              </div>

              <div className="ab-bridge-link" aria-hidden="true" />

              <div className="ab-node" data-reveal style={{ '--ab-delay': '120ms' }}>
                <p className="ab-node-k">The product</p>
                <Link className="ab-node-label" to="/">SaaS Shield</Link>
                <p className="ab-node-note">A tool for finding your own words on someone else&rsquo;s site.</p>
              </div>
            </div>
          </div>

          <p className="ab-belief" data-reveal>
            The best way to learn building is <em>to actually build.</em>
          </p>
        </div>
      </section>

      {/* 05 — the product --------------------------------------------------- */}
      <section className="ab-section" id="product">
        <div className="ab-wrap">
          <p className="ab-eyebrow"><span className="ab-num">05</span> The product</p>

          <h2 className="ab-h" data-reveal>
            Introducing <span className="ab-serif-line">SaaS Shield.</span>
          </h2>

          <div className="ab-body" style={{ marginTop: 'clamp(22px, 3vw, 34px)', maxWidth: '62ch' }}>
            <p data-reveal>
              A scanner that compares the pages you built with the pages you are worried about, and
              shows you what looks similar enough to be worth a second look.
            </p>
          </div>

          <div className="ab-caps">
            {CAPABILITIES.map((cap, i) => (
              <article className="ab-cap" key={cap.title} data-reveal style={{ '--ab-delay': `${i * 70}ms` }}>
                <span className="ab-cap-n">{String(i + 1).padStart(2, '0')}</span>
                <h3>{cap.title}</h3>
                <p>{cap.text}</p>
              </article>
            ))}
          </div>

          <div className="ab-honest" data-reveal>
            <p className="ab-honest-k">Worth saying</p>
            <p>
              SaaS Shield finds similarity worth reviewing. It does not decide whether something is
              lawful copying, and it does not replace legal advice. That judgement stays with you.
            </p>
          </div>
        </div>
      </section>

      {/* 06 — closing -------------------------------------------------------- */}
      <section className="ab-section">
        <div className="ab-wrap">
          <p className="ab-eyebrow"><span className="ab-num">06</span> If you build, protect it</p>

          <p className="ab-close-line" data-reveal>
            Your work deserves more than <em>a quick look now and then.</em>
          </p>

          <div className="ab-cta" data-reveal>
            <Link className="ab-btn ab-btn-solid" to={ctaTo}>
              {ctaLabel}
              <span className="ab-arrow" aria-hidden="true">→</span>
            </Link>
            <a className="ab-btn" href={BITTU_BUILDS} target="_blank" rel="noopener noreferrer">
              Visit Bittu Builds
              <span className="ab-arrow" aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
      </section>

      <footer className="ab-foot">
        <span>© {new Date().getFullYear()} SaaS Shield</span>
        <nav aria-label="Footer">
          <Link to="/about">About</Link>
          <Link to="/privacy">Privacy Policy</Link>
          <a href={BITTU_BUILDS} target="_blank" rel="noopener noreferrer">Bittu Builds</a>
        </nav>
      </footer>
    </div>
  );
}
