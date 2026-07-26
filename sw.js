/* ===========================================================
   ARCADE — service worker

   Bump CACHE_NAME whenever you add a game or change any file.
   That single edit is what tells iOS to pull the new assets down.
   =========================================================== */

const CACHE_NAME = 'arcade-v3';

/** Resolve relative to the worker, so project subpaths (GitHub Pages) work. */
const url = (path) => new URL(path, self.location).toString();

/** Hub files. Everything else is discovered from games.json. */
const CORE = [
  './',
  './index.html',
  './styles.css',
  './hub.js',
  './games.json',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/favicon-64.png',
].map(url);

/* ----------------------------------------------------------
   Install — read the registry, cache every game it names
   ---------------------------------------------------------- */

/** Turn games.json into a flat list of absolute URLs. */
async function gameAssets() {
  const res = await fetch(url('./games.json'), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`games.json returned ${res.status}`);

  const data = await res.json();
  const list = Array.isArray(data) ? data : Array.isArray(data.games) ? data.games : [];
  const out = [];

  for (const game of list) {
    if (!game || !game.path) continue;
    const base = game.path.endsWith('/') ? game.path : game.path + '/';

    out.push(url(base + (game.entry || 'index.html')));
    out.push(url(base + 'script.js'));          // folder convention
    if (game.icon) out.push(url(game.icon));

    // Anything else the game needs: extra scripts, sprites, sounds.
    for (const extra of game.assets || []) {
      out.push(/^https?:/i.test(extra) ? extra : url(extra));
    }
  }
  return out;
}

/** Cache one by one so a single 404 cannot fail the whole install. */
async function cacheAll(cache, urls) {
  const unique = [...new Set(urls)];
  const results = await Promise.allSettled(
    unique.map((u) => cache.add(new Request(u, { cache: 'reload' })))
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.warn('[sw] skipped', unique[i], r.reason?.message || '');
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cacheAll(cache, CORE);

    try {
      await cacheAll(cache, await gameAssets());
    } catch (err) {
      console.warn('[sw] registry unreadable, hub cached alone:', err.message);
    }
    // No skipWaiting() here on purpose: a new version waits until the
    // player taps Reload, so a deploy never yanks a game out from under them.
  })());
});

/* ----------------------------------------------------------
   Activate — drop older versions
   ---------------------------------------------------------- */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

/* ----------------------------------------------------------
   Fetch
   ---------------------------------------------------------- */

const scope = new URL('./', self.location).toString();

self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (req.method !== 'GET') return;
  if (!req.url.startsWith(scope)) return;          // leave anything off-app alone
  if (req.headers.has('range')) return;            // media seeking: let the network handle it

  const path = new URL(req.url).pathname;

  // The registry itself: freshest wins, cache is the safety net.
  if (path.endsWith('/games.json')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Page loads: serve the shell instantly, fall back to it when offline.
  if (req.mode === 'navigate') {
    event.respondWith(cacheFirst(req, url('./index.html')));
    return;
  }

  event.respondWith(cacheFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: true })) || Response.error();
  }
}

async function cacheFirst(req, fallbackUrl) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(req, { ignoreSearch: true });

  if (hit) {
    // Refresh in the background; the bumped CACHE_NAME is the hard reset.
    fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); }).catch(() => {});
    return hit;
  }

  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  } catch {
    if (fallbackUrl) {
      const shell = await cache.match(fallbackUrl);
      if (shell) return shell;
    }
    return new Response('Offline and not cached.', {
      status: 504,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

/* ----------------------------------------------------------
   Messages from the hub
   ---------------------------------------------------------- */

self.addEventListener('message', (event) => {
  const { type } = event.data || {};
  if (type === 'SKIP_WAITING') self.skipWaiting();
  if (type === 'VERSION') event.ports[0]?.postMessage({ cacheName: CACHE_NAME });
});
