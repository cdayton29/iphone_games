'use strict';

var CACHE_NAME = 'solitaire-cache-v3';

var ASSETS = [
  './',
  './index.html',
  './styles.css',
  './game.js',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(ASSETS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) {
          return key !== CACHE_NAME;
        }).map(function (key) {
          return caches.delete(key);
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;

  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Navigation requests: serve the cached shell so the app opens
  // instantly and works fully offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then(function (cached) {
        return cached || fetch(event.request).then(function (response) {
          return cacheAndReturn(event.request, response);
        });
      }).catch(function () {
        return caches.match('./index.html');
      })
    );
    return;
  }

  // Everything else: cache-first, falling back to network (and caching
  // the network response for next time).
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).then(function (response) {
        return cacheAndReturn(event.request, response);
      });
    })
  );
});

function cacheAndReturn(request, response) {
  if (!response || response.status !== 200 || response.type !== 'basic') {
    return response;
  }
  var copy = response.clone();
  caches.open(CACHE_NAME).then(function (cache) {
    cache.put(request, copy);
  });
  return response;
}
