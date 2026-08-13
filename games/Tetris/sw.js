/* ============================================================================
 * Cascade service worker
 * ----------------------------------------------------------------------------
 * Strategy
 *   install  : precache every shipped asset, so the first load is the only
 *              load that ever needs a network.
 *   navigate : cache first (index.html), network only as a fallback. The app
 *              shell never changes between requests, so this is both faster
 *              and offline-proof.
 *   assets   : cache first, with a silent background refresh so a redeploy is
 *              picked up on the next visit without ever blocking gameplay.
 *
 * Bump CACHE_VERSION on every deploy — the activate handler deletes anything
 * that does not match it.
 * ========================================================================== */

const CACHE_VERSION = 'cascade-v1.0.0';
const OFFLINE_URL = './index.html';

const PRECACHE = [
  './',
  './index.html',
  './style.css',
  './game.js',
  './manifest.json',
  './game.config.json',
  './icon.svg',
  './icon-192.png',
  './apple-touch-icon.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

/* ------------------------------------------------------------------ install */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // Added one at a time: a single 404 (say, a missing icon) must not
    // invalidate the whole precache and leave the game unplayable offline.
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        console.warn('[sw] could not precache', url, err);
      }
    }));
    await self.skipWaiting();
  })());
});

/* ----------------------------------------------------------------- activate */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
    );
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.disable();
    }
    await self.clients.claim();
  })());
});

/* -------------------------------------------------------------------- fetch */

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin pass through

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  event.respondWith(handleAsset(request));
});

async function handleNavigation(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(OFFLINE_URL);
  if (cached) {
    revalidate(cache, new Request(OFFLINE_URL));
    return cached;
  }
  try {
    const fresh = await fetch(request);
    cache.put(OFFLINE_URL, fresh.clone());
    return fresh;
  } catch (err) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
      '<body style="background:#080b12;color:#e8eef9;font:16px system-ui;display:grid;' +
      'place-items:center;height:100vh;margin:0"><p>Cascade is not cached yet. ' +
      'Reconnect once to install it.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function handleAsset(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request, { ignoreSearch: true });

  if (cached) {
    revalidate(cache, request);
    return cached;
  }

  try {
    const fresh = await fetch(request);
    if (fresh && fresh.status === 200 && fresh.type === 'basic') {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

/** Refresh a cached entry in the background. Failures are expected offline. */
function revalidate(cache, request) {
  fetch(request)
    .then((response) => {
      if (response && response.status === 200 && response.type === 'basic') {
        return cache.put(request, response);
      }
    })
    .catch(() => { /* offline: keep what we have */ });
}

/* ------------------------------------------------------------------ message */

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
