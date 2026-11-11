'use strict';
// A host that answers with a JavaScript shell must not store an empty page.
// The renderer is injected here so the test never launches a browser: what is
// under test is the fallback decision and its failure behaviour.
process.env.SHIELD_ALLOW_PRIVATE_IPS = 'true';
process.env.CRAWL_RESPECT_ROBOTS = '0';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crawler = require('../src/crawler');
const render = require('../src/render');

const SHELL = '<html><head><script src="/aes.js"></script></head><body>This site requires Javascript to work, please enable Javascript in your browser.</body></html>';
const REAL = `<html><body><h1>Studio</h1><p>${'Photography retainer options include two shoot days per month, a licensed image library and a quarterly brand audit. '.repeat(4)}</p></body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(SHELL);
});

test.before(async () => { await new Promise((r) => server.listen(0, '127.0.0.1', r)); });
test.after(() => new Promise((r) => server.close(r)));

function origin() { return `http://127.0.0.1:${server.address().port}/`; }

test('a JavaScript shell is rendered once and the hydrated page is kept', async () => {
  let called = 0;
  const out = await crawler.fetchPage(origin(), {
    renderHtml: async (url) => { called++; assert.ok(url.startsWith('http://127.0.0.1')); return { html: REAL, finalUrl: url }; }
  });
  assert.equal(called, 1, 'the renderer runs exactly once for a thin page');
  assert.equal(out.rendered, true);
  assert.match(out.html, /Photography retainer options/, 'the hydrated markup is what the crawler stores');
});

test('a failed render keeps the thin page instead of losing it', async () => {
  const out = await crawler.fetchPage(origin(), { renderHtml: async () => { throw new Error('browser crashed'); } });
  assert.equal(out.rendered, undefined);
  assert.match(out.html, /requires Javascript/);
});

test('a page with real text is never rendered', async () => {
  let called = 0;
  const full = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(REAL); });
  await new Promise((r) => full.listen(0, '127.0.0.1', r));
  try {
    const out = await crawler.fetchPage(`http://127.0.0.1:${full.address().port}/`, {
      renderHtml: async () => { called++; return { html: REAL }; }
    });
    assert.equal(called, 0, 'no browser cost when the page already has content');
    assert.equal(out.rendered, undefined);
  } finally {
    await new Promise((r) => full.close(r));
  }
});

test('rendering follows the environment switch, off by default under NODE_ENV=test', () => {
  delete process.env.CRAWL_RENDER_THIN_PAGES;
  assert.equal(render.enabled(), false, 'tests never launch a browser by default');
  process.env.CRAWL_RENDER_THIN_PAGES = '1';
  assert.equal(render.enabled(), true, 'an explicit switch forces it on');
  process.env.CRAWL_RENDER_THIN_PAGES = '0';
  assert.equal(render.enabled(), false, 'an explicit switch forces it off in production too');
  delete process.env.CRAWL_RENDER_THIN_PAGES;
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  assert.equal(render.enabled(), render.available(), 'production enables it when the browser exists');
  if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before;
});
