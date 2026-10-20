'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const dns = require('dns').promises;
const config = require('../src/config');
const { assertSafeUrl, parseHttpUrl, UnsafeUrlError, isPrivateIpv4, isPrivateIpv6 } = require('../src/ssrf');
const { fetchPage, crawlSite } = require('../src/crawler');

// Fast test pacing (module-level config is process-local to this test file).
config.crawl.delayMs = 10;

// NOTE: SSRF default (allowPrivateIps=false) blocks 127.0.0.1. Positive-path
// crawler tests below flip the flag, mirroring the documented local/test mode.

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function htmlPage(title, body, extra = '') {
  return `<!DOCTYPE html><html><head><title>${title}</title>${extra}</head><body>${body}</body></html>`;
}

function fakeRes({ status = 200, location = null, contentType = 'text/html', body = '' } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        if (name === 'location') return location;
        if (name === 'content-type') return contentType;
        if (name === 'content-length') return String(body.length);
        return null;
      }
    },
    body: {
      getReader() {
        const buf = Buffer.from(body);
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: buf };
          },
          async cancel() {}
        };
      }
    }
  };
}

// ---------------------------------------------------------------------------
// URL validation (no network needed)
// ---------------------------------------------------------------------------
test('rejects invalid, non-http, credentialed and internal URLs', () => {
  const bad = [
    'notaurl',
    'ftp://example.com/file',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://user:pass@example.com/',
    'http://localhost/x',
    'http://sub.localhost/x',
    'http://app.internal/x',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://example.com:8080/x',
    'http://example.com:22/x',
    ''
  ];
  for (const u of bad) {
    assert.throws(() => parseHttpUrl(u), UnsafeUrlError, `expected rejection: ${u}`);
  }
  const ok = parseHttpUrl('https://example.com/path?q=1');
  assert.equal(ok.hostname, 'example.com');
});

test('blocks private, reserved and loopback IPv4 literals', async () => {
  const targets = ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.16.5.5', '172.31.9.9',
                   '169.254.169.254', '0.0.0.0', '100.64.1.1', '192.0.2.1', '224.0.0.1', '255.255.255.255'];
  for (const ip of targets) {
    assert.ok(isPrivateIpv4(ip), `${ip} should be private`);
    await assert.rejects(assertSafeUrl(`http://${ip}/`), UnsafeUrlError, `${ip} must be blocked`);
  }
  assert.ok(!isPrivateIpv4('93.184.216.34'));
  assert.ok(!isPrivateIpv4('1.1.1.1'));
});

test('blocks private/reserved IPv6 literals', async () => {
  const targets = ['::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1',
                   '64:ff9b::1.2.3.4', '2001:db8::1', 'ff02::1', '100::1'];
  for (const ip of targets) {
    assert.ok(isPrivateIpv6(ip), `${ip} should be private`);
  }
  await assert.rejects(assertSafeUrl('http://[::1]/x'), UnsafeUrlError);
  await assert.rejects(assertSafeUrl('http://[fe80::1]/x'), UnsafeUrlError);
  assert.ok(!isPrivateIpv6('2606:4700:4700::1111'));
});

test('blocks hostnames that resolve to private addresses (DNS revalidation)', async () => {
  const original = dns.lookup;
  dns.lookup = async () => [{ address: '10.0.0.5', family: 4 }];
  try {
    await assert.rejects(assertSafeUrl('http://rebind.example.com/x'), UnsafeUrlError);
  } finally {
    dns.lookup = original;
  }
});

// ---------------------------------------------------------------------------
// Redirects: every hop is revalidated (mocked fetch, no real network)
// ---------------------------------------------------------------------------
test('redirect to a blocked destination is rejected before fetching it', async () => {
  const originalFetch = global.fetch;
  const originalLookup = dns.lookup;
  const seen = [];
  dns.lookup = async (host) => {
    if (host === 'blocked.example') return [{ address: '169.254.169.254', family: 4 }];
    return [{ address: '93.184.216.34', family: 4 }];
  };
  global.fetch = async (u) => {
    const url = String(u);
    seen.push(url);
    if (url.includes('/robots.txt')) return fakeRes({ status: 404 });
    return fakeRes({ status: 302, location: 'http://blocked.example/latest/meta-data/' });
  };
  try {
    await assert.rejects(fetchPage('http://allowed.example/redirect'), UnsafeUrlError);
    assert.ok(!seen.some((s) => s.includes('blocked.example')), 'must never fetch the blocked target');
  } finally {
    global.fetch = originalFetch;
    dns.lookup = originalLookup;
  }
});

test('too many redirects and invalid redirect locations fail safely', async () => {
  const originalFetch = global.fetch;
  const originalLookup = dns.lookup;
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  global.fetch = async (u) => {
    const url = String(u);
    if (url.includes('/robots.txt')) return fakeRes({ status: 404 });
    if (url.includes('loop')) return fakeRes({ status: 302, location: 'http://allowed.example/loop' });
    return fakeRes({ status: 302, location: '::::not a url' });
  };
  try {
    await assert.rejects(fetchPage('http://allowed.example/loop'), UnsafeUrlError);
    await assert.rejects(fetchPage('http://allowed.example/badloc'), Error);
  } finally {
    global.fetch = originalFetch;
    dns.lookup = originalLookup;
  }
});

// ---------------------------------------------------------------------------
// Live crawler behavior against a local test server (private IPs allowed,
// exactly like documented local/test mode)
// ---------------------------------------------------------------------------
test('SSRF protection on by default: local server target is refused', async () => {
  const { srv, port } = await startServer((req, res) => res.end(htmlPage('t', 'x')));
  try {
    assert.equal(config.ssrf.allowPrivateIps, false);
    await assert.rejects(assertSafeUrl(`http://127.0.0.1:${port}/`), UnsafeUrlError);
  } finally {
    srv.close();
  }
});

async function withTestServer(handler, fn) {
  const prev = config.ssrf.allowPrivateIps;
  config.ssrf.allowPrivateIps = true;
  const { srv, port } = await startServer(handler);
  try {
    return await fn(port);
  } finally {
    config.ssrf.allowPrivateIps = prev;
    srv.close();
  }
}

test('timeouts produce a clean error, not a crash', async () => {
  await withTestServer((req, res) => { if (req.url !== '/robots.txt') setTimeout(() => res.end('late'), 5000); }, async (port) => {
    const prev = config.crawl.timeoutMs;
    config.crawl.timeoutMs = 300;
    try {
      await assert.rejects(fetchPage(`http://127.0.0.1:${port}/slow`), (e) => e.code === 'TIMEOUT');
    } finally {
      config.crawl.timeoutMs = prev;
    }
  });
});

test('HTTP errors are reported with the status', async () => {
  await withTestServer((req, res) => { res.statusCode = 404; res.end('gone'); }, async (port) => {
    await assert.rejects(fetchPage(`http://127.0.0.1:${port}/missing`), (e) => e.code === 'HTTP_ERROR' && e.status === 404);
  });
});

test('unsupported content types are rejected', async () => {
  await withTestServer((req, res) => {
    res.setHeader('content-type', 'application/pdf');
    res.end(Buffer.from('%PDF-1.4 fake'));
  }, async (port) => {
    await assert.rejects(fetchPage(`http://127.0.0.1:${port}/file.pdf`), (e) => e.code === 'UNSUPPORTED_TYPE');
  });
});

test('oversized responses are rejected by declared length and by stream cap', async () => {
  await withTestServer((req, res) => {
    if (req.url === '/declared') {
      res.setHeader('content-type', 'text/html');
      res.setHeader('content-length', '999999999');
      res.end();
    } else {
      res.setHeader('content-type', 'text/html');
      const chunk = 'x'.repeat(1024);
      let left = 30;                       // 30KB total, then end (cap in test is 8KB)
      res.write(chunk);
      left--;
      const iv = setInterval(() => {
        if (left-- <= 0) { clearInterval(iv); res.end(); return; }
        try { res.write(chunk); } catch { clearInterval(iv); }
      }, 5);
      res.on('close', () => clearInterval(iv));
    }
  }, async (port) => {
    const prev = config.crawl.maxResponseBytes;
    config.crawl.maxResponseBytes = 8192;
    try {
      await assert.rejects(fetchPage(`http://127.0.0.1:${port}/declared`), (e) => e.code === 'TOO_LARGE');
      await assert.rejects(fetchPage(`http://127.0.0.1:${port}/streamed`), (e) => e.code === 'TOO_LARGE');
    } finally {
      config.crawl.maxResponseBytes = prev;
    }
  });
});

test('robots.txt disallow rules are respected', async () => {
  await withTestServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.setHeader('content-type', 'text/plain');
      res.end('User-agent: *\nDisallow: /private\n');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(htmlPage('page', 'content here'));
  }, async (port) => {
    await assert.rejects(fetchPage(`http://127.0.0.1:${port}/private/secret`), (e) => e.code === 'ROBOTS');
    const ok = await fetchPage(`http://127.0.0.1:${port}/public`);
    assert.ok(ok.html.includes('content here'));
  });
});

test('crawlSite extracts titles, canonical urls, dedupes content, strips nav', async () => {
  await withTestServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/') {
      res.end(htmlPage('Home', '<nav>Menu items here</nav><main>' + 'unique home content '.repeat(20) +
        '</main><a href="/page2">p2</a><a href="/copy">copy</a>' +
        '<link rel="canonical" href="https://canonical.example/home">'));
    } else if (req.url === '/page2') {
      res.end(htmlPage('Two', 'second page words ' + 'second body '.repeat(30) + '<a href="/">home</a>'));
    } else if (req.url === '/copy') {
      // EXACT same visible text as /page2 -> same content hash
      res.end(htmlPage('Two', 'second page words ' + 'second body '.repeat(30) + '<a href="/">home</a>'));
    } else {
      res.statusCode = 404;
      res.end('no');
    }
  }, async (port) => {
    const pages = [];
    const site = { id: 'w_test', workspace_id: 'ws_test', submitted_url: `http://127.0.0.1:${port}/` };
    const summary = await crawlSite(site, async (p) => pages.push(p), { maxPages: 10, maxDepth: 1 });
    const urls = pages.map((p) => p.url.replace(`http://127.0.0.1:${port}`, ''));
    assert.ok(urls.includes('/'), 'seed page stored');
    assert.ok(urls.includes('/page2'), 'linked page stored');
    assert.ok(urls.includes('/copy'), 'duplicate-content page recorded');
    const uniqueHashes = new Set(pages.map((p) => p.content_hash));
    assert.equal(uniqueHashes.size, 2, 'content duplicate detected via hash');
    assert.equal(summary.pagesStored, 2);
    const home = pages.find((p) => p.url.endsWith('/'));
    assert.equal(home.title, 'Home');
    assert.equal(home.canonical_url, 'https://canonical.example/home');
    assert.ok(home.text_content.includes('unique home content'));
    assert.ok(!home.text_content.includes('Menu items here'), 'nav boilerplate stripped');
  });
});

test('crawlSite honors page and depth limits', async () => {
  await withTestServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/') {
      res.end(htmlPage('seed', 'seed body '.repeat(20) + '<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>'));
    } else {
      res.end(htmlPage(req.url, 'leaf ' + req.url + ' body '.repeat(20)));
    }
  }, async (port) => {
    const pages1 = [];
    await crawlSite({ id: 'w', workspace_id: 'ws', submitted_url: `http://127.0.0.1:${port}/` },
      async (p) => pages1.push(p), { maxPages: 2, maxDepth: 1 });
    assert.equal(pages1.length, 2, 'page cap enforced');
    const pages2 = [];
    await crawlSite({ id: 'w2', workspace_id: 'ws', submitted_url: `http://127.0.0.1:${port}/` },
      async (p) => pages2.push(p), { maxPages: 10, maxDepth: 0 });
    assert.equal(pages2.length, 1, 'depth 0 = seed only');
  });
});

test('crawlSite throws immediately for unsafe seed URLs', async () => {
  const prev = config.ssrf.allowPrivateIps;
  config.ssrf.allowPrivateIps = false;
  try {
    await assert.rejects(
      crawlSite({ id: 'w', workspace_id: 'ws', submitted_url: 'http://192.168.1.1/admin' }, async () => {}),
      UnsafeUrlError
    );
  } finally {
    config.ssrf.allowPrivateIps = prev;
  }
});
