/* ===========================================================
   SPACE CADET PINBALL — arcade loader.

   Sets up the Emscripten Module, then pulls in the engine
   (SpaceCadetPinball.js, which carries the wasm and the game
   data embedded inside it). No service worker here: the
   arcade's own worker caches this game, and a second worker
   on the same origin would wipe the arcade's cache.
   =========================================================== */

(function () {
  'use strict';

  var canvas = document.getElementById('canvas');
  var splash = document.getElementById('splash');
  var bar = document.querySelector('#bar > i');
  var statusEl = document.getElementById('status');
  var playBtn = document.getElementById('play');
  var SAVE_DIR = '/libsdl';           // SDL_GetPrefPath() lives under here on Emscripten
  var ready = false, started = false, syncing = false, totalDeps = 0;

  function setStatus(t) { statusEl.textContent = t; }

  // --- Canvas sizing: match the canvas backing store to its on-screen size so
  // SDL picks up the new size and the game re-lays itself out (it letterboxes
  // and keeps the table's aspect ratio itself).
  function fitCanvas() {
    var r = canvas.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(320, Math.round(r.width * dpr)), h = Math.max(240, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
    }
  }

  // --- Persistent saves (high scores, options) via IndexedDB
  function persist() {
    if (syncing || !window.FS || !FS.syncfs) return;
    syncing = true;
    FS.syncfs(false, function (err) { syncing = false; if (err) console.warn('save failed', err); });
  }

  window.Module = {
    canvas: canvas,
    noInitialRun: true,       // wait for a user gesture so audio can start
    print: function (t) { console.log(t); },
    printErr: function (t) { console.warn(t); },
    preRun: [function () {
      FS.mkdir(SAVE_DIR);
      FS.mount(IDBFS, {}, SAVE_DIR);
      Module.addRunDependency('idbfs');
      FS.syncfs(true, function (err) {
        if (err) console.warn('load saves failed', err);
        Module.removeRunDependency('idbfs');
      });
    }],
    setStatus: function (t) {
      var m = t && t.match(/\((\d+(?:\.\d+)?)\/(\d+)\)/);
      if (m) { bar.style.width = (100 * m[1] / m[2]).toFixed(1) + '%'; setStatus('Downloading game data…'); }
    },
    monitorRunDependencies: function (left) {
      totalDeps = Math.max(totalDeps, left);
      if (left === 0) bar.style.width = '100%';
    },
    onRuntimeInitialized: function () {
      ready = true;
      bar.style.width = '100%';
      setStatus('Ready');
      playBtn.style.display = 'inline-block';
      playBtn.focus();
    },
    onAbort: function (what) {
      var msg = (what && what.type) ? 'a file failed to load (' + what.type + ')' : String(what);
      setStatus('Could not start the game: ' + msg + '. Try reloading the page.');
    }
  };

  function start() {
    if (!ready || started) return;
    started = true;
    splash.style.display = 'none';
    fitCanvas();
    try { Module.callMain([]); } catch (e) { if (e !== 'unwind' && !(e && e.name === 'ExitStatus')) throw e; }
    canvas.focus();
    setInterval(persist, 10000);
    // Lock to landscape where supported when installed. Inside the arcade's
    // iframe this is a no-op, which is correct: the hub owns the orientation.
    try {
      if (screen.orientation && screen.orientation.lock &&
          matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches) {
        screen.orientation.lock('landscape').catch(function () {});
      }
    } catch (e) {}
  }
  playBtn.addEventListener('click', start);
  document.addEventListener('keydown', function (e) {
    if (!started && ready && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); start(); }
  });

  window.addEventListener('resize', fitCanvas);
  if (window.ResizeObserver) new ResizeObserver(fitCanvas).observe(canvas);
  document.addEventListener('visibilitychange', function () { if (document.hidden) persist(); });
  window.addEventListener('pagehide', persist);

  // Save before the hub tears this iframe down on the way back to the menu.
  window.addEventListener('beforeunload', persist);

  // Stop the browser from scrolling/zooming on game keys
  window.addEventListener('keydown', function (e) {
    if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '/', 'F1', 'F2', 'F3', 'F5', 'F10'].indexOf(e.key) >= 0 && started) e.preventDefault();
  }, { capture: true });

  // --- Touch controls
  function key(a, down) { if (started && Module._web_key) Module._web_key(a, down ? 1 : 0); }
  function enableTouch() { document.body.classList.add('touch'); }
  if (matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window) enableTouch();
  window.addEventListener('touchstart', enableTouch, { once: true, passive: true });

  var active = {}; // pointerId -> {el, a}
  document.querySelectorAll('#touch [data-a]').forEach(function (el) {
    var a = +el.dataset.a, tap = el.hasAttribute('data-tap');
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      active[e.pointerId] = { el: el, a: a };
      el.classList.add('on');
      key(a, true);
      if (tap) setTimeout(function () { key(a, false); }, 60);
      if (a <= 1) document.body.classList.add('played');
      if (navigator.vibrate && a <= 2) navigator.vibrate(8);
    });
    function up(e) {
      var s = active[e.pointerId]; if (!s) return;
      delete active[e.pointerId];
      s.el.classList.remove('on');
      if (!tap) key(s.a, false);
    }
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  });

  // --- Pull in the engine. It is one self-contained 8.6 MB file: the wasm and
  // the game data are embedded in it, so nothing else is fetched.
  var tag = document.createElement('script');
  tag.src = 'SpaceCadetPinball.js';
  tag.onerror = function () {
    setStatus('Could not load SpaceCadetPinball.js — make sure it is in this game’s folder.');
  };
  document.body.appendChild(tag);

  // indeterminate progress while the engine downloads and compiles
  var p = 0, t = setInterval(function () {
    if (ready) return clearInterval(t);
    p = Math.min(92, p + (95 - p) * 0.05);
    bar.style.width = p + '%';
  }, 150);

  window.__booted = true;
})();
