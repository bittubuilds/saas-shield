import { Link } from 'react-router-dom';

// Deliberately factual: it describes what the software actually stores and does.
// It makes no compliance claim, because none has been legally reviewed.
export default function Privacy() {
  return (
    <article className="doc">
      <p className="doc-kicker">Legal</p>
      <h1>Privacy Policy</h1>
      <p className="doc-lead">
        This page explains what SaaS Shield stores when you use it, why it is stored, and what you
        can ask us to do with it. It describes the current build of the product; it is not a
        certified compliance statement and has not been reviewed by a lawyer.
      </p>
      <p className="doc-meta">Last updated: 8 November 2026</p>

      <h2>1. What we store</h2>
      <ul>
        <li><strong>Account:</strong> your email address, a hashed password (never the password itself), and your name if you provide one.</li>
        <li><strong>Workspace:</strong> the workspace name and who belongs to it.</li>
        <li><strong>Websites you add:</strong> the URL you submit, the normalised domain, crawl status and timestamps.</li>
        <li><strong>Public page content:</strong> text, structure and screenshots captured from the public pages of the sites you add.</li>
        <li><strong>Analysis output:</strong> findings, evidence references, generated reports and PDFs.</li>
        <li><strong>Operational records:</strong> session records, verification tokens (stored only as hashes), and security audit events.</li>
      </ul>

      <h2>2. Why we store it</h2>
      <p>
        To run the comparison you asked for, to keep findings traceable to the evidence that produced
        them, to secure accounts, and to answer support or abuse questions. We do not sell personal data.
      </p>

      <h2>3. Cookies and sessions</h2>
      <p>
        Signing in sets a single session cookie that is HTTP-only and SameSite=Lax. It keeps you signed in
        and is cleared when you sign out or delete your account. We do not use advertising cookies.
      </p>

      <h2>4. Service providers</h2>
      <p>
        Depending on how this deployment is configured, requests may pass through a managed PostgreSQL
        host (Neon), a hosting provider (Render), an email delivery provider (for example Resend) and a
        search API used for competitor discovery. Which providers are active depends on the environment
        configuration; only the ones actually configured receive data.
      </p>

      <h2>5. Retention</h2>
      <p>
        Account, workspace and analysis data are kept until you remove a site or delete your account.
        Removing a site archives it: its findings and reports stay readable, because published reports
        cite that evidence. Deleting your account removes your account, your memberships and any
        workspace you are the only member of. Security audit events are kept for abuse and billing
        integrity, with the link to your identity removed.
      </p>

      <h2>6. Your choices</h2>
      <ul>
        <li>Remove a site from your dashboard at any time (Settings &rarr; Danger zone, or the Remove button on a site).</li>
        <li>Delete your account in <Link to="/settings">Settings</Link>.</li>
        <li>Ask for a copy of your data using the contact address below.</li>
      </ul>

      <h2>7. What this page does not claim</h2>
      <p>
        It does not claim a certification, a specific data-residency guarantee, or compliance with a
        named regulation. Those depend on how this deployment is operated and would need separate review
        before being stated anywhere.
      </p>

      <h2>8. Contact</h2>
      <p>
        For privacy questions or a data request, use the contact address published in the project
        repository (github.com/bittubuilds/saas-shield).
      </p>

      <p className="doc-foot"><Link to="/">Back to dashboard</Link></p>
    </article>
  );
}
