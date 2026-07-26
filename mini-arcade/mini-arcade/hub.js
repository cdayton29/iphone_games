/* ===========================================================
   ARCADE — hub launcher
   Reads games.json, paints cartridges, seats one in the stage.
   Adding a game never means editing this file.
   =========================================================== */

const $ = (sel) => document.querySelector(sel);

/* Paths in games.json are relative to THIS folder, not to whatever URL the
   browser is showing. Without this, a hub served at /arcade (no trailing
   slash) would look for games at /games/... and 404. */
const HERE = new URL('./', import.meta.url);
const abs = (path) => new URL(path, HERE).href;

const els = {
  hub:      $('#hub'),
  grid:     $('#grid'),
  readout:  $('#readout'),
  led:      $('#led'),
  stage:    $('#stage'),
  home:     $('#home-btn'),
  theme:    $('#theme-btn'),
  themeTxt: $('#theme-label'),
  cacheTag: $('#cache-tag'),
  pill:     $('#update-pill'),
  pillBtn:  $('#update-btn'),
};

let games = [];
let active = null;
let frame = null;   // the live game iframe, rebuilt on every launch

/* ----------------------------------------------------------
   1. Appearance — auto by default, tap to pin dark or light
   ---------------------------------------------------------- */

const MODES = ['auto', 'dark', 'light'];
const media = matchMedia('(prefers-color-scheme: light)');
let mode = localStorage.getItem('arcade.theme') || 'auto';

function resolvedTheme() {
  if (mode !== 'auto') return mode;
  return media.matches ? 'light' : 'dark';
}

function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  els.themeTxt.textContent = mode === 'auto' ? 'Auto' : theme === 'dark' ? 'Dark' : 'Light';
  // keep a running game in sync
  frame?.contentWindow?.postMessage({ type: 'theme', theme }, '*');
}

els.theme.addEventListener('click', () => {
  mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
  localStorage.setItem('arcade.theme', mode);
  applyTheme();
});
media.addEventListener('change', applyTheme);
applyTheme();

/* ----------------------------------------------------------
   2. Manifest
   ---------------------------------------------------------- */

/** Accepts either `[ … ]` or `{ "games": [ … ] }`. */
function normalize(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.games) ? data.games : [];
  return list
    .filter((g) => g && g.id && g.path)
    .map((g) => ({
      id: String(g.id),
      title: g.title || g.id,
      subtitle: g.subtitle || '',
      icon: g.icon || '',
      path: g.path.endsWith('/') ? g.path : g.path + '/',
      entry: g.entry || 'index.html',
      accent: g.accent || '',
      glyph: g.glyph || '',
    }));
}

async function loadGames() {
  try {
    // Network first so a freshly deployed game shows up straight away;
    // the service worker answers from cache when there is no signal.
    const res = await fetch(abs('games.json'), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`games.json returned ${res.status}`);
    games = normalize(await res.json());
  } catch (err) {
    console.warn('[arcade] manifest unavailable:', err);
    games = [];
  }
  render();
}

/* ----------------------------------------------------------
   3. Paint the shelf
   ---------------------------------------------------------- */

function render() {
  els.grid.textContent = '';

  if (!games.length) {
    const box = document.createElement('div');
    box.className = 'empty';
    box.innerHTML =
      '<strong>No cartridges found.</strong><br>' +
      'Drop a folder into <code>/games</code> and add an entry to <code>games.json</code> — ' +
      'the launcher picks it up on the next load.';
    els.grid.append(box);
    setReadout();
    return;
  }

  games.forEach((game, i) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'cart';
    card.dataset.id = game.id;
    if (game.accent) card.style.setProperty('--accent', game.accent);
    card.style.animationDelay = `${i * 45}ms`;

    const slot = document.createElement('span');
    slot.className = 'slot';
    slot.textContent = `Slot ${String(i + 1).padStart(2, '0')} · ${game.id.slice(0, 3).toUpperCase()}`;

    // The well falls back to a glyph, so a missing icon file still reads as
    // a deliberate label rather than a broken image.
    const well = document.createElement('span');
    well.className = 'well';

    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = game.glyph || game.title.slice(0, 1).toUpperCase();
    well.append(glyph);

    if (game.icon) {
      const img = document.createElement('img');
      img.src = abs(game.icon);
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('load', () => glyph.remove());
      img.addEventListener('error', () => img.remove());
      well.append(img);
    }

    const title = document.createElement('h2');
    title.textContent = game.title;

    card.append(slot, well, title);

    if (game.subtitle) {
      const sub = document.createElement('p');
      sub.textContent = game.subtitle;
      card.append(sub);
    }

    card.addEventListener('click', () => launch(game.id, true));
    els.grid.append(card);
  });

  setReadout();
}

function setReadout() {
  const n = games.length;
  const count = n ? `${n} cartridge${n === 1 ? '' : 's'}` : 'no cartridges';
  els.readout.textContent = `${count} · ${navigator.onLine ? 'online' : 'offline · playing from cache'}`;
  els.led.dataset.state = navigator.onLine ? 'online' : 'offline';
}

addEventListener('online', setReadout);
addEventListener('offline', setReadout);

/* ----------------------------------------------------------
   4. Stage — seat a cartridge, or eject it
   ---------------------------------------------------------- */

function launch(id, pushState) {
  const game = games.find((g) => g.id === id);
  if (!game || active === id) return;

  active = id;

  // A fresh iframe each time keeps game navigation out of the hub's history.
  frame = document.createElement('iframe');
  frame.className = 'frame';
  frame.title = game.title;
  frame.setAttribute('allow', 'autoplay; fullscreen');
  const src = new URL(game.path + game.entry, HERE);
  src.searchParams.set('theme', resolvedTheme());
  frame.src = src.href;
  els.stage.textContent = '';
  els.stage.append(frame);

  els.stage.hidden = false;
  els.stage.classList.remove('seating');
  void els.stage.offsetWidth;           // restart the animation
  els.stage.classList.add('seating');
  els.home.hidden = false;
  els.hub.setAttribute('aria-hidden', 'true');
  document.title = `${game.title} — Arcade`;

  // A history entry means the iOS back-swipe returns to the menu too.
  if (pushState) history.pushState({ game: id }, '', `#${id}`);

  confirmReachable(game, frame);
}

/** The iframe shows the server's 404 page on a bad path. Say something clearer. */
async function confirmReachable(game, myFrame) {
  const target = new URL(game.path + game.entry, HERE).href;
  let problem = null;

  try {
    const res = await fetch(target);
    if (!res.ok) problem = `the server answered ${res.status}`;
  } catch {
    problem = 'it is not cached and there is no connection';
  }

  if (!problem || frame !== myFrame) return;

  const panel = document.createElement('div');
  panel.className = 'stage-error';
  panel.innerHTML =
    `<h2>${game.title} didn't load</h2>` +
    `<p>Looked for <code>${target.replace(HERE.href, '')}</code> — ${problem}.</p>` +
    `<p class="fix">Check the <code>path</code> in games.json against the folder name, then bump ` +
    `<code>CACHE_NAME</code> in sw.js.</p>`;

  els.stage.textContent = '';
  els.stage.append(panel);
}

function close(popHistory) {
  if (!active) return;
  active = null;

  els.stage.hidden = true;
  els.stage.textContent = '';           // tear the game down: timers, audio, memory
  frame = null;
  els.home.hidden = true;
  els.hub.removeAttribute('aria-hidden');
  document.title = 'Arcade';

  if (popHistory && history.state?.game) history.back();
  else if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

els.home.addEventListener('click', () => close(true));

addEventListener('popstate', (e) => {
  const id = e.state?.game || location.hash.slice(1);
  if (id && games.some((g) => g.id === id)) launch(id, false);
  else close(false);
});

// Let a game ask to come home: parent.postMessage({ type: 'arcade:exit' }, '*')
addEventListener('message', (e) => {
  if (e.data?.type === 'arcade:exit') close(true);
});

/* ----------------------------------------------------------
   5. Keep the browser out of the way
   ---------------------------------------------------------- */

// pinch-zoom (iOS Safari gesture events)
['gesturestart', 'gesturechange', 'gestureend'].forEach((type) =>
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false })
);

// double-tap zoom
let lastTap = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - lastTap < 320) e.preventDefault();
  lastTap = now;
}, { passive: false });

// rubber-band / pull-to-refresh everywhere except declared scrollers
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) { e.preventDefault(); return; }
  if (!e.target.closest?.('[data-scroll]')) e.preventDefault();
}, { passive: false });

// long-press callout
document.addEventListener('contextmenu', (e) => e.preventDefault());

/* ----------------------------------------------------------
   6. Service worker
   ---------------------------------------------------------- */

async function initServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    els.cacheTag.textContent = 'cache unavailable';
    return;
  }

  const hadController = !!navigator.serviceWorker.controller;

  try {
    const reg = await navigator.serviceWorker.register(abs('sw.js'));

    // A waiting worker means new assets are already downloaded.
    const offerUpdate = (worker) => {
      if (!worker || !navigator.serviceWorker.controller) return;
      els.pill.hidden = false;
      els.pillBtn.onclick = () => {
        worker.postMessage({ type: 'SKIP_WAITING' });
        els.pillBtn.textContent = 'Reloading…';
      };
    };

    if (reg.waiting) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw?.addEventListener('statechange', () => {
        if (sw.state === 'installed') offerUpdate(reg.waiting || sw);
      });
    });

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // First install just takes control quietly; only an update reloads.
      if (!hadController) { showCacheVersion(); return; }
      if (reloading) return;
      reloading = true;
      location.reload();
    });

    reg.update().catch(() => {});
    showCacheVersion();
  } catch (err) {
    console.warn('[arcade] service worker failed:', err);
    els.cacheTag.textContent = 'cache off';
  }
}

function showCacheVersion() {
  const sw = navigator.serviceWorker.controller;
  if (!sw) { els.cacheTag.textContent = 'cache priming'; return; }
  const channel = new MessageChannel();
  channel.port1.onmessage = (e) => {
    if (e.data?.cacheName) els.cacheTag.textContent = `cache ${e.data.cacheName}`;
  };
  sw.postMessage({ type: 'VERSION' }, [channel.port2]);
}

/* ----------------------------------------------------------
   7. Boot
   ---------------------------------------------------------- */

(async function boot() {
  await loadGames();

  // Deep link: /#sudoku opens straight into a game.
  const deep = location.hash.slice(1);
  if (deep && games.some((g) => g.id === deep)) launch(deep, false);

  initServiceWorker();
})();
