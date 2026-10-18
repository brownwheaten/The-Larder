/* The Larder — service worker.
 * Makes the app open instantly and work with no signal (in a store, at a farm stand).
 *
 * Strategy
 *  - The app page and the Larder's own data files: serve the cached copy immediately,
 *    then fetch a fresh copy in the background. If the fresh copy differs, store it and
 *    tell the page, which shows an "Updated — tap to reload" notice. Nothing goes stale
 *    for more than one visit, and nothing ever blocks on the network.
 *  - Icons / manifest / fonts: cache-first (they rarely change).
 *  - The Google service (cooking log, pantry sync): never cached; the app queues changes
 *    locally and syncs them when back online.
 * Bump CACHE_VERSION only when this file's strategy changes; content updates are automatic.
 */
const CACHE_VERSION = 'larder-v1';
const CORE = ['./', 'data/pantry_catalog.json', 'data/local_sources.json', 'data/zips.json',
              'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // Cache each file independently so one missing file can't break installation.
    await Promise.all(CORE.map(u => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isAppShell(url) {
  return url.origin === self.location.origin &&
    (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html') || /\/data\/[^/]+\.json$/.test(url.pathname));
}
function isStatic(url) {
  return (url.origin === self.location.origin && /\/(icons\/|manifest\.webmanifest)/.test(url.pathname)) ||
    url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
}
function cacheKey(request, url) {
  // One cache entry per file: ignore ?v=… and #list=… so shared-list links and cache-busting URLs work offline.
  if (url.origin === self.location.origin) {
    return new Request(url.origin + url.pathname.replace(/index\.html$/, ''));
  }
  return request;
}

async function notifyClients(msg) {
  const all = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  all.forEach(c => c.postMessage(msg));
}

async function staleWhileRevalidate(event, request, url) {
  const cache = await caches.open(CACHE_VERSION);
  const key = cacheKey(request, url);
  const cached = await cache.match(key);
  // Read the cached copy now: once it's handed to the page its body is used up and can't be compared later.
  const cachedText = cached ? cached.clone().text() : null;
  const refresh = (async () => {
    try {
      // Re-fetch by URL: a page-load (navigate) request can't be re-issued with options.
      const fresh = await fetch(url.href.split('#')[0], { cache: 'no-cache', credentials: 'same-origin' });
      if (!fresh || !fresh.ok) return null;
      if (cached) {
        const [a, b] = await Promise.all([cachedText, fresh.clone().text()]);
        if (a === b) return fresh;
        await cache.put(key, fresh.clone());
        // Only the app itself warrants a reload prompt; data files are picked up on next read.
        if (!/\/data\//.test(url.pathname)) await notifyClients({ type: 'larder-updated' });
      } else {
        await cache.put(key, fresh.clone());
      }
      return fresh;
    } catch (e) { return null; }
  })();
  event.waitUntil(refresh);
  if (cached) return cached;
  const fresh = await refresh;
  if (fresh) return fresh;
  // Offline and never cached: for a page load, fall back to the cached app if we have it.
  if (request.mode === 'navigate') { const shell = await cache.match(new Request(new URL('./', self.registration.scope).href)); if (shell) return shell; }
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}

async function cacheFirst(request, url) {
  const cache = await caches.open(CACHE_VERSION);
  const key = cacheKey(request, url);
  const cached = await cache.match(key);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    if (fresh && (fresh.ok || fresh.type === 'opaque')) await cache.put(key, fresh.clone());
    return fresh;
  } catch (e) { return new Response('', { status: 504 }); }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.hostname === 'script.google.com' || url.hostname.endsWith('googleusercontent.com')) return; // live sync only
  if (request.mode === 'navigate' || isAppShell(url)) { event.respondWith(staleWhileRevalidate(event, request, url)); return; }
  if (isStatic(url)) { event.respondWith(cacheFirst(request, url)); return; }
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});
