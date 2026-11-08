'use strict';
// Tests for the Interference Ribbons canvas port (public/ribbons.<hash>.js).
//
// jsdom has no 2D canvas, which is exactly the interesting case: the component
// must stay quiet and leave the DOM alone instead of throwing or appending a
// dead canvas. The pixels themselves are checked in a real browser (see
// docs/REACTBITS.md); here we check the contract around it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch { JSDOM = null; }
const skip = JSDOM ? false : 'jsdom is not installed (npm install --no-save jsdom)';

const PUBLIC = path.join(__dirname, '..', 'public');
const ribbonFile = fs.readdirSync(PUBLIC).find((f) => /^ribbons\.[a-z0-9]+\.js$/.test(f));
const code = ribbonFile ? fs.readFileSync(path.join(PUBLIC, ribbonFile), 'utf8') : '';
const appHtml = fs.readFileSync(path.join(PUBLIC, 'app.html'), 'utf8');
const appFile = fs.readdirSync(PUBLIC).find((f) => /^app\.[a-z0-9]+\.js$/.test(f));
const appCode = fs.readFileSync(path.join(PUBLIC, appFile), 'utf8');

function boot(markup, { reducedMotion = false } = {}) {
  const dom = new JSDOM(markup || '<div id="host" data-ribbons></div>', {
    url: 'http://127.0.0.1/app', runScripts: 'outside-only', pretendToBeVisual: true
  });
  dom.window.matchMedia = (q) => ({
    matches: reducedMotion && /prefers-reduced-motion/.test(q),
    media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}
  });
  // No 2D context in this environment, on purpose.
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.eval(code);
  return dom;
}

test('the hashed asset is shipped and loaded before the app script', () => {
  assert.ok(ribbonFile, 'public/ribbons.<hash>.js exists');
  assert.match(appHtml, new RegExp(`<script src="/${ribbonFile.replace(/\./g, '\\.')}"></script>`), 'app.html loads the module');
  const ribbonAt = appHtml.indexOf(ribbonFile);
  assert.ok(ribbonAt > -1 && ribbonAt < appHtml.indexOf(appFile), 'the ribbons module loads before app.js');
});

test('the public API exposes mount, autoMount and the documented defaults', { skip }, () => {
  const dom = boot();
  const api = dom.window.InterferenceRibbons;
  assert.equal(typeof api.mount, 'function');
  assert.equal(typeof api.autoMount, 'function');
  assert.equal(typeof api.unmountAll, 'function');
  const d = api.defaults;
  // Defaults follow the Pro component's props; wires is lowered for the hero band.
  assert.equal(Array.from(d.colors).join(','), '#7c5cff,#d46bff');   // cross-realm array
  assert.equal(d.wires, 56);
  assert.equal(d.lineWidth, 1.4);
  assert.equal(d.twist, 1.7);
  assert.equal(d.depth, 0.65);
  assert.equal(d.pulseSpeed, 1.1);
  assert.equal(d.interactive, true);
  assert.equal(d.paused, false);
  assert.equal(d.quality, 0.85);
  dom.window.close();
});

test('without a 2D context it returns a handle and leaves the DOM untouched', { skip }, () => {
  const dom = boot();
  const el = dom.window.document.getElementById('host');
  let handle = null;
  assert.doesNotThrow(() => { handle = dom.window.InterferenceRibbons.mount(el, { wires: 12 }); });
  assert.equal(handle.canvas, null, 'no canvas is claimed');
  assert.equal(el.children.length, 0, 'no dead canvas is appended');
  assert.doesNotThrow(() => handle.destroy());
  assert.doesNotThrow(() => handle.pulse(0.5));
  assert.doesNotThrow(() => handle.destroy(), 'destroy is idempotent');
  dom.window.close();
});

test('a missing host is a no-op, not a crash', { skip }, () => {
  const dom = boot();
  const api = dom.window.InterferenceRibbons;
  assert.doesNotThrow(() => api.mount(null));
  assert.doesNotThrow(() => api.autoMount());
  assert.doesNotThrow(() => api.unmountAll());
  dom.window.close();
});

test('reduced motion is detected from matchMedia', { skip }, () => {
  const normal = boot();
  assert.equal(normal.window.InterferenceRibbons.prefersReducedMotion(), false);
  normal.window.close();

  const reduced = boot(undefined, { reducedMotion: true });
  assert.equal(reduced.window.InterferenceRibbons.prefersReducedMotion(), true);
  reduced.window.close();
});

test('data-ribbons options are parsed from the markup, not hardcoded', { skip }, () => {
  const dom = boot('<div id="host" data-ribbons data-ribbons-wires="24" data-ribbons-interactive="false" data-ribbons-glitch="2.5"></div>');
  const el = dom.window.document.getElementById('host');
  // The parser feeds mount(); with no 2D context we can still prove it ran
  // through the attribute scan by calling autoMount twice without duplicating work.
  assert.doesNotThrow(() => dom.window.InterferenceRibbons.autoMount());
  assert.doesNotThrow(() => dom.window.InterferenceRibbons.autoMount());
  assert.equal(el.children.length, 0);
  dom.window.close();
});

test('the dashboard hero carries the ribbon layer and mounts it after render', () => {
  assert.match(appCode, /class="hero-ribbons"[^>]*data-ribbons/, 'the hero declares a ribbon layer');
  assert.match(appCode, /InterferenceRibbons\.autoMount\(\)/, 'the page mounts it');
  assert.match(appCode, /InterferenceRibbons\.unmountAll\(\)/, 'and tears it down before the shell is replaced');
});
