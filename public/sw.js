'use strict';
/* SaaS Shield service worker: offline shell for static assets only.
   API calls (/api/*) are NEVER cached - scan data must always be live. */

const CACHE = 'saas-shield-v5';
const SHELL = [
  '/',
  '/app',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/brand/logo-full.png',
  '/brand/logo-mark.png',
  '/favicon.ico'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // network-only, never cache

  // code files (html/js/css): network-first so deploys are picked up immediately
  const isCode = /\.(?:html|js|css)$/.test(url.pathname) || url.pathname === '/' || url.pathname === '/app';
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(e.request).then((c) => c || caches.match(isCode ? '/app' : '/')))
  );
});
