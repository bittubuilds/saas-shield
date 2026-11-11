'use strict';
// Provider behaviour for auto-discovery, without touching the network: global
// fetch is stubbed so the parsers and the fallback order are what get tested.
const test = require('node:test');
const assert = require('node:assert');

process.env.SERPER_API_KEY = '';
process.env.SEARCH_KEYLESS_FORCED = '1';
const search = require('../src/search');

const realFetch = global.fetch;

function stub(routes) {
  global.fetch = async (url) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) return { ok: false, status: 404, text: async () => '' };
    const r = routes[key];
    if (r instanceof Error) throw r;
    return { ok: r.ok !== false, status: r.status || 200, text: async () => r.body, json: async () => r.json };
  };
}

test.afterEach(() => { global.fetch = realFetch; });

test('duckduckgo parser reads the uddg target and drops engine links', () => {
  const html = `
    <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcopy.example%2Fpage&amp;rut=abc">one</a>
    <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fother.example%2Fx">two</a>
    <a href="https://duckduckgo.com/settings">settings</a>`;
  assert.deepEqual(search.parseDuckDuckGo(html), ['https://copy.example/page', 'https://other.example/x']);
});

test('mojeek parser reads result anchors only', () => {
  const html = `
    <a class="ob" href="https://copied.example/a">result</a>
    <a class="nav" href="https://mojeek.com/about">nav</a>`;
  assert.deepEqual(search.parseMojeek(html), ['https://copied.example/a']);
});

test('keyless search falls back to the second engine when the first returns a shell', async () => {
  stub({
    'html.duckduckgo.com': { body: '<html><body>anomaly</body></html>' },
    'mojeek.com': { body: '<a class="ob" href="https://copied.example/deep">x</a>' }
  });
  const urls = await search.searchWeb('some quoted sentence');
  assert.deepEqual(urls, ['https://copied.example/deep']);
});

test('every engine failing raises SearchUnavailableError, never an empty success', async () => {
  stub({});
  await assert.rejects(() => search.searchWeb('x'), (e) => e.code === 'SEARCH_UNAVAILABLE');
});

test('a configured key is used first, and its failure still falls back', async () => {
  process.env.SERPER_API_KEY = 'test-key';
  stub({
    'google.serper.dev': { ok: false, status: 401, body: '', json: {} },
    'html.duckduckgo.com': { body: '<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fkeyed.example%2F">x</a>' }
  });
  const urls = await search.searchWeb('x');
  assert.deepEqual(urls, ['https://keyed.example/']);
  process.env.SERPER_API_KEY = '';
});

test('the keyless chain can be switched off for a deployment', async () => {
  process.env.SEARCH_KEYLESS_FORCED = '';
  process.env.SEARCH_KEYLESS_DISABLED = '1';
  assert.equal(search.isSearchConfigured(), false);
  assert.equal(search.describe().available, false);
  await assert.rejects(() => search.searchWeb('x'), (e) => e.code === 'SEARCH_UNAVAILABLE');
  process.env.SEARCH_KEYLESS_DISABLED = '';
  process.env.SEARCH_KEYLESS_FORCED = '1';
});

test('discovery reports itself usable without a key', () => {
  assert.equal(search.isSearchConfigured(), true);
  const d = search.describe();
  assert.equal(d.available, true);
  assert.equal(d.provider, 'keyless');
  assert.ok(d.providers.includes('mojeek'));
});
