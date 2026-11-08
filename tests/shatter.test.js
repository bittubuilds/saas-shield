'use strict';
// Tests for the Shatter Type DOM port (public/shatter.<hash>.js).
//
// jsdom has no Web Animations API, which is the graceful-degradation path: the
// headline must still cut into shards, keep its text intact and put itself back
// together on destroy. The motion itself is verified in Chromium (docs/REACTBITS.md).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch { JSDOM = null; }
const skip = JSDOM ? false : 'jsdom is not installed (npm install --no-save jsdom)';

const PUBLIC = path.join(__dirname, '..', 'public');
const shatterFile = fs.readdirSync(PUBLIC).find((f) => /^shatter\.[a-z0-9]+\.js$/.test(f));
const code = fs.readFileSync(path.join(PUBLIC, shatterFile), 'utf8');
const appHtml = fs.readFileSync(path.join(PUBLIC, 'app.html'), 'utf8');
const appFile = fs.readdirSync(PUBLIC).find((f) => /^app\.[a-z0-9]+\.js$/.test(f));
const appCode = fs.readFileSync(path.join(PUBLIC, appFile), 'utf8');

const HEADLINE = 'Protect Your SaaS Business with <span class="grad">Smart Intelligence</span>';

function boot(markup, { reducedMotion = false } = {}) {
  const dom = new JSDOM(markup || `<h1 id="host" data-shatter>${HEADLINE}</h1>`, {
    url: 'http://127.0.0.1/app', runScripts: 'outside-only', pretendToBeVisual: true
  });
  dom.window.matchMedia = (q) => ({
    matches: reducedMotion && /prefers-reduced-motion/.test(q),
    media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}
  });
  dom.window.eval(code);
  return dom;
}

test('the hashed asset ships and loads after ribbons, before the app', () => {
  assert.ok(shatterFile, 'public/shatter.<hash>.js exists');
  assert.match(appHtml, new RegExp(`<script src="/${shatterFile.replace(/\./g, '\\.')}"></script>`));
  const at = appHtml.indexOf(shatterFile);
  const ribbonsAt = appHtml.indexOf('ribbons.');
  assert.ok(at > ribbonsAt, 'loads after the ribbons module');
  assert.ok(at < appHtml.indexOf(appFile), 'loads before app.js');
});

test('the API exposes mount, autoMount, unmountAll and the documented defaults', { skip }, () => {
  const dom = boot();
  const api = dom.window.ShatterType;
  assert.equal(typeof api.mount, 'function');
  assert.equal(typeof api.autoMount, 'function');
  assert.equal(typeof api.unmountAll, 'function');
  const d = api.defaults;
  assert.equal(d.shardSize, 0.09);
  assert.equal(d.irregularity, 0.6);
  assert.equal(d.crack, 0.6);
  assert.equal(d.crackRadius, 0.5);
  assert.equal(d.heal, 0.9);
  assert.equal(d.shatterRadius, 0.55);
  assert.equal(d.reassemble, 1.1);
  assert.equal(d.stiffness, 0.55);
  assert.equal(d.intro, 'assemble');
  assert.equal(d.interactive, true);
  assert.equal(d.paused, false);
  dom.window.close();
});

test('the headline is cut into clipped shards and keeps its text', { skip }, () => {
  const dom = boot();
  const el = dom.window.document.getElementById('host');
  const handle = dom.window.ShatterType.mount(el, {});

  const shards = el.querySelectorAll('.shatter-shard');
  assert.ok(shards.length >= 6, `expected a fracture, got ${shards.length} shards`);
  for (const s of shards) {
    assert.match(s.style.clipPath, /^polygon\(/, 'every shard is a clipped polygon');
  }
  const base = el.querySelector('.shatter-base');
  assert.ok(base, 'the readable copy is kept for layout and screen readers');
  assert.notEqual(base.getAttribute('aria-hidden'), 'true', 'screen readers still get the headline');
  assert.ok(el.querySelector('.shatter-stage').getAttribute('aria-hidden') === 'true', 'the shard layer is hidden from AT');
  assert.ok(base.innerHTML.includes('Smart Intelligence'), 'the original markup is preserved');
  assert.ok(el.textContent.includes('Protect Your SaaS Business'), 'the headline text survives');
  dom.window.close();
});

test('destroy restores the original markup exactly', { skip }, () => {
  const dom = boot();
  const el = dom.window.document.getElementById('host');
  const before = el.innerHTML;
  const handle = dom.window.ShatterType.mount(el, {});
  assert.notEqual(el.innerHTML, before, 'mount did replace the content');
  handle.destroy();
  assert.equal(el.innerHTML, before, 'destroy puts it back byte for byte');
  assert.equal(el.querySelectorAll('.shatter-shard').length, 0);
  assert.doesNotThrow(() => handle.destroy(), 'destroy is idempotent');
  dom.window.close();
});

test('without the Web Animations API it still cuts, and the actions are safe', { skip }, () => {
  const dom = boot();
  const el = dom.window.document.getElementById('host');
  const handle = dom.window.ShatterType.mount(el, {});
  assert.equal(typeof dom.window.Element.prototype.animate, 'undefined', 'this environment has no WAAPI');
  assert.doesNotThrow(() => handle.shatter());
  assert.doesNotThrow(() => handle.assemble());
  assert.ok(el.querySelectorAll('.shatter-shard').length >= 6);
  dom.window.close();
});

test('reduced motion keeps the headline still', { skip }, () => {
  const dom = boot(undefined, { reducedMotion: true });
  const el = dom.window.document.getElementById('host');
  const handle = dom.window.ShatterType.mount(el, {});
  const before = [...el.querySelectorAll('.shatter-shard')].map((s) => s.style.opacity);
  assert.doesNotThrow(() => handle.shatter(10, 10));
  const after = [...el.querySelectorAll('.shatter-shard')].map((s) => s.style.opacity);
  assert.deepEqual(after, before, 'a shatter request changes nothing');
  dom.window.close();
});

test('autoMount is idempotent and options come from the markup', { skip }, () => {
  const dom = boot('<h1 id="host" data-shatter data-shatter-paused="true" data-shatter-shard-size="0.2">Head<span>line</span></h1>');
  const el = dom.window.document.getElementById('host');
  dom.window.ShatterType.autoMount();
  const first = el.querySelectorAll('.shatter-shard').length;
  assert.ok(first >= 6);
  dom.window.ShatterType.autoMount();
  assert.equal(el.querySelectorAll('.shatter-shard').length, first, 'second call does not duplicate the fracture');
  dom.window.ShatterType.unmountAll();
  assert.equal(el.querySelectorAll('.shatter-shard').length, 0, 'unmountAll cleans up');
  dom.window.close();
});

test('a missing host is a no-op', { skip }, () => {
  const dom = boot();
  assert.doesNotThrow(() => dom.window.ShatterType.mount(null));
  assert.doesNotThrow(() => dom.window.ShatterType.autoMount());
  assert.doesNotThrow(() => dom.window.ShatterType.unmountAll());
  dom.window.close();
});

test('the dashboard headline is a Shatter Type host and is torn down with the shell', () => {
  assert.match(appCode, /class="hero-title" data-shatter/, 'the hero headline declares the effect');
  assert.match(appCode, /ShatterType\.autoMount\(\)/, 'the page mounts it');
  assert.match(appCode, /ShatterType\.unmountAll\(\)/, 'and unmounts before the shell is replaced');
});
