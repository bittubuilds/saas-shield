'use strict';
// Guards the legal/account surface of the React UI. These are structural assertions:
// they fail if a route, the footer link or the logo path is removed, which is exactly
// the kind of change that silently breaks a shipped page.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('privacy policy page is routed and reachable from the footer', () => {
  const app = read('frontend/src/App.jsx');
  assert.match(app, /path="\/privacy"/, 'the /privacy route is registered');
  assert.match(app, /import Privacy from '\.\/pages\/Privacy\.jsx'/, 'the page is imported');

  const layout = read('frontend/src/components/Layout.jsx');
  assert.match(layout, /<footer[^>]*>/, 'a footer exists');
  assert.match(layout, /<Link to="\/privacy">Privacy Policy<\/Link>/, 'the footer links to the policy');
  assert.match(layout, /aria-label="Legal"/, 'the footer link sits in a labelled nav');
});

test('the policy covers the required sections and claims nothing it cannot support', () => {
  const page = read('frontend/src/pages/Privacy.jsx');
  for (const heading of ['What we store', 'Why we store it', 'Cookies and sessions', 'Service providers', 'Retention', 'Your choices', 'Contact']) {
    assert.ok(page.includes(heading), `section present: ${heading}`);
  }
  assert.match(page, /does not claim/i, 'states what it does not claim');
  assert.ok(!/GDPR compliant|SOC ?2 certified|HIPAA compliant/i.test(page), 'no invented compliance claim');
});

test('account settings expose deletion behind a typed confirmation', () => {
  const page = read('frontend/src/pages/Settings.jsx');
  assert.match(page, /deleteAccount\('DELETE'\)/, 'calls the API with the confirmation word');
  assert.match(page, /HoldButton/, 'the delete action is a hold-to-confirm button');
  assert.match(page, /DELETE/, 'still requires the typed word');
  assert.match(page, /role="status"/, 'reports success');
  assert.match(page, /role="alert"/, 'reports failure');
});

test('the logo resolves under the /app mount instead of the site root', () => {
  const layout = read('frontend/src/components/Layout.jsx');
  assert.match(layout, /BASE_URL\}logo\.png/, 'logo path goes through the Vite base');
  assert.ok(!/src="\/logo\.png"/.test(layout), 'no root-absolute logo path remains');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'frontend/public/logo.png')), 'the asset exists');
});

test('the brand wordmark keeps a static fallback and honours reduced motion', () => {
  const cmp = read('frontend/src/components/BrandShatter.jsx');
  assert.match(cmp, /prefers-reduced-motion: reduce/, 'checks the reduced-motion preference');
  assert.match(cmp, /brand-word-static/, 'renders readable static text as a fallback');
  assert.match(cmp, /cancelAnimationFrame/, 'cleans up the animation loop');
  assert.match(cmp, /removeEventListener\('resize'/, 'cleans up the resize listener');
});

test('hold-to-confirm gates both destructive actions and cleans up its loop', () => {
  const hold = read('frontend/src/components/HoldButton.jsx');
  assert.match(hold, /cancelAnimationFrame/, 'cancels the animation frame on release and unmount');
  assert.match(hold, /onPointerLeave/, 'releasing off the button aborts the hold');
  assert.match(hold, /e\.key === ' '/, 'keyboard hold is supported');
  const dash = read('frontend/src/pages/Dashboard.jsx');
  assert.match(dash, /<HoldButton[\s\S]*onRemove\(s\)/, 'Remove runs only after a completed hold');
  assert.ok(!/window\.confirm/.test(dash), 'the hold replaces the browser popup');
});
