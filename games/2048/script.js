/* =========================================================
   2048 — game engine, gestures, and persistence.
   No dependencies, no network calls.
   ========================================================= */
(function () {
  'use strict';

  var SIZE = 4;
  var GOAL = 2048;
  var UNDO_DEPTH = 24;

  var KEY_SAVE = 'g2048.save.v1';
  var KEY_BEST = 'g2048.best.v1';

  var $ = function (sel) { return document.querySelector(sel); };

  /* ---------------------------------------------------------
     Storage — guarded, the game runs fine without it
     --------------------------------------------------------- */

  var store = {
    read: function (key, fallback) {
      try {
        var raw = window.localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    write: function (key, value) {
      try { window.localStorage.setItem(key, JSON.stringify(value)); return true; }
      catch (e) { return false; }
    },
    remove: function (key) {
      try { window.localStorage.removeItem(key); } catch (e) { /* unavailable */ }
    }
  };

  /* ---------------------------------------------------------
     DOM
     --------------------------------------------------------- */

  var boardEl = $('#board');
  var tilesEl = $('#tiles');
  var wellsEl = $('#wells');
  var rungsEl = $('#rungs');
  var ladderTopEl = $('#ladder-top');
  var scoreEl = $('#score');
  var scoreBoxEl = $('#score-box');
  var scoreGainEl = $('#score-gain');
  var bestEl = $('#best');
  var undoBtn = $('#btn-undo');
  var hintEl = $('#hint');
  var scrimEl = $('#scrim');
  var winOverlay = $('#overlay-win');
  var overOverlay = $('#overlay-over');
  var newDialog = $('#dialog-new');

  for (var w = 0; w < SIZE * SIZE; w++) wellsEl.appendChild(document.createElement('i'));

  var RUNGS = 12; // 2 through 4096
  for (var g = 1; g <= RUNGS; g++) {
    var rung = document.createElement('span');
    rung.className = 'rung r' + g;
    rungsEl.appendChild(rung);
  }
  var rungEls = rungsEl.children;

  /* ---------------------------------------------------------
     State
     --------------------------------------------------------- */

  var cells = [];          // SIZE x SIZE of tile objects or null
  var score = 0;
  var best = Number(store.read(KEY_BEST, 0)) || 0;
  var won = false;         // 2048 has been reached
  var keepPlaying = false; // player chose to continue past 2048
  var over = false;
  var undoStack = [];
  var nextId = 1;

  function makeTile(r, c, value) {
    return { id: nextId++, r: r, c: c, value: value, prev: null, mergedFrom: null };
  }

  function emptyGrid() {
    var grid = [];
    for (var r = 0; r < SIZE; r++) {
      grid.push([]);
      for (var c = 0; c < SIZE; c++) grid[r].push(null);
    }
    return grid;
  }

  function eachTile(fn) {
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        if (cells[r][c]) fn(cells[r][c], r, c);
      }
    }
  }

  function emptyCells() {
    var list = [];
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) if (!cells[r][c]) list.push({ r: r, c: c });
    }
    return list;
  }

  function addRandomTile() {
    var free = emptyCells();
    if (!free.length) return null;
    var spot = free[Math.floor(Math.random() * free.length)];
    var tile = makeTile(spot.r, spot.c, Math.random() < 0.9 ? 2 : 4);
    cells[spot.r][spot.c] = tile;
    return tile;
  }

  function highestValue() {
    var max = 0;
    eachTile(function (t) { if (t.value > max) max = t.value; });
    return max;
  }

  /* ---------------------------------------------------------
     Sizing — tiles are positioned in pixels off a measured cell
     --------------------------------------------------------- */

  var cellSize = 70, gapSize = 10;
  var wrapEl = document.querySelector('.board-wrap');

  function sizeBoard() {
    var avail = Math.min(wrapEl.clientWidth, wrapEl.clientHeight);
    if (!avail) return;

    var box = Math.floor(avail);
    boardEl.style.width = box + 'px';
    boardEl.style.height = box + 'px';

    gapSize = Math.round(Math.min(12, Math.max(7, box * 0.028)));
    cellSize = (box - gapSize * (SIZE + 1)) / SIZE;
    boardEl.style.setProperty('--gap', gapSize + 'px');
    boardEl.style.setProperty('--cell', cellSize + 'px');
    positionAll();
  }

  function offset(index) { return index * (cellSize + gapSize) + 'px'; }

  function positionAll() {
    var nodes = tilesEl.children;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.dataset.r === undefined) continue;
      el.style.setProperty('--tx', offset(Number(el.dataset.c)));
      el.style.setProperty('--ty', offset(Number(el.dataset.r)));
    }
  }

  if (window.ResizeObserver) new ResizeObserver(sizeBoard).observe(wrapEl);
  window.addEventListener('resize', sizeBoard);
  window.addEventListener('orientationchange', function () { setTimeout(sizeBoard, 250); });

  /* ---------------------------------------------------------
     Rendering
     --------------------------------------------------------- */

  function exponentOf(value) {
    return Math.min(RUNGS, Math.round(Math.log(value) / Math.LN2));
  }

  function buildTileEl(tile, atR, atC) {
    var el = document.createElement('div');
    var digits = String(tile.value).length;
    el.className = 'tile e' + exponentOf(tile.value) + ' d' + digits;
    el.textContent = String(tile.value);
    el.dataset.r = atR;
    el.dataset.c = atC;
    el.style.setProperty('--tx', offset(atC));
    el.style.setProperty('--ty', offset(atR));
    el.setAttribute('role', 'gridcell');
    el.setAttribute('aria-label', tile.value + ' at row ' + (atR + 1) + ', column ' + (atC + 1));
    return el;
  }

  /* instant = restored from storage, so nothing animates in */
  function render(instant) {
    tilesEl.textContent = '';
    tilesEl.classList.toggle('settle', !!instant);

    var moving = [];

    eachTile(function (tile) {
      if (tile.mergedFrom && !instant) {
        // draw both sources sliding into the merge cell, then the result on top
        tile.mergedFrom.forEach(function (src) {
          var el = buildTileEl(src, src.prev.r, src.prev.c);
          tilesEl.appendChild(el);
          moving.push({ el: el, r: tile.r, c: tile.c });
        });
        var mergedEl = buildTileEl(tile, tile.r, tile.c);
        mergedEl.classList.add('merged');
        tilesEl.appendChild(mergedEl);
      } else if (tile.prev && !instant) {
        var el2 = buildTileEl(tile, tile.prev.r, tile.prev.c);
        tilesEl.appendChild(el2);
        moving.push({ el: el2, r: tile.r, c: tile.c });
      } else {
        var el3 = buildTileEl(tile, tile.r, tile.c);
        if (!instant && !tile.prev && !tile.mergedFrom) el3.classList.add('spawn');
        tilesEl.appendChild(el3);
      }
    });

    if (moving.length) {
      // one forced reflow, then the transitions run
      void tilesEl.offsetWidth;
      moving.forEach(function (m) {
        m.el.dataset.r = m.r;
        m.el.dataset.c = m.c;
        m.el.style.setProperty('--tx', offset(m.c));
        m.el.style.setProperty('--ty', offset(m.r));
      });
    }

    if (instant) {
      requestAnimationFrame(function () { tilesEl.classList.remove('settle'); });
    }

    paintScores();
    paintLadder();
    undoBtn.disabled = undoStack.length === 0 || over;
  }

  function paintScores() {
    scoreEl.textContent = score.toLocaleString('en-US');
    bestEl.textContent = best.toLocaleString('en-US');
  }

  function paintLadder() {
    var top = highestValue();
    var reached = top ? exponentOf(top) : 0;
    for (var i = 0; i < rungEls.length; i++) {
      rungEls[i].classList.toggle('lit', i < reached);
    }
    ladderTopEl.textContent = top ? top.toLocaleString('en-US') : '\u2014';
  }

  function celebrateScore(gain) {
    if (gain <= 0) return;
    scoreBoxEl.classList.remove('bump');
    scoreGainEl.classList.remove('run');
    void scoreBoxEl.offsetWidth;
    scoreGainEl.textContent = '+' + gain;
    scoreBoxEl.classList.add('bump');
    scoreGainEl.classList.add('run');
  }

  var hintTimer = null;
  function say(text) {
    hintEl.textContent = text || '';
    hintEl.classList.toggle('show', !!text);
    clearTimeout(hintTimer);
    if (text) hintTimer = setTimeout(function () { hintEl.classList.remove('show'); }, 4000);
  }

  /* ---------------------------------------------------------
     Moves
     --------------------------------------------------------- */

  var VECTORS = {
    up:    { r: -1, c: 0 },
    right: { r: 0, c: 1 },
    down:  { r: 1, c: 0 },
    left:  { r: 0, c: -1 }
  };

  function traversals(vector) {
    var rows = [], cols = [];
    for (var i = 0; i < SIZE; i++) { rows.push(i); cols.push(i); }
    if (vector.r === 1) rows.reverse();
    if (vector.c === 1) cols.reverse();
    return { rows: rows, cols: cols };
  }

  function withinBounds(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  }

  function findFarthest(r, c, vector) {
    var pr = r, pc = c, lastR = r, lastC = c;
    do {
      lastR = pr;
      lastC = pc;
      pr += vector.r;
      pc += vector.c;
    } while (withinBounds(pr, pc) && !cells[pr][pc]);

    return {
      farthest: { r: lastR, c: lastC },
      next: withinBounds(pr, pc) ? { r: pr, c: pc } : null
    };
  }

  function snapshot() {
    var flat = [];
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) flat.push(cells[r][c] ? cells[r][c].value : 0);
    }
    return { grid: flat, score: score, won: won, keepPlaying: keepPlaying };
  }

  function restoreSnapshot(snap) {
    cells = emptyGrid();
    for (var i = 0; i < snap.grid.length; i++) {
      var v = snap.grid[i];
      if (!v) continue;
      var r = Math.floor(i / SIZE), c = i % SIZE;
      cells[r][c] = makeTile(r, c, v);
    }
    score = snap.score;
    won = !!snap.won;
    keepPlaying = !!snap.keepPlaying;
  }

  function movesAvailable() {
    if (emptyCells().length) return true;
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        var v = cells[r][c].value;
        if (c + 1 < SIZE && cells[r][c + 1].value === v) return true;
        if (r + 1 < SIZE && cells[r + 1][c].value === v) return true;
      }
    }
    return false;
  }

  function move(direction) {
    if (over) return;
    if (!winOverlay.hidden || !overOverlay.hidden || !newDialog.hidden) return;

    var vector = VECTORS[direction];
    var order = traversals(vector);
    var before = snapshot();
    var moved = false;
    var gained = 0;
    var hitGoal = false;

    eachTile(function (tile) {
      tile.prev = { r: tile.r, c: tile.c };
      tile.mergedFrom = null;
    });

    order.rows.forEach(function (r) {
      order.cols.forEach(function (c) {
        var tile = cells[r][c];
        if (!tile) return;

        var spot = findFarthest(r, c, vector);
        var next = spot.next ? cells[spot.next.r][spot.next.c] : null;

        if (next && next.value === tile.value && !next.mergedFrom) {
          var merged = makeTile(spot.next.r, spot.next.c, tile.value * 2);
          merged.mergedFrom = [tile, next];

          cells[spot.next.r][spot.next.c] = merged;
          cells[r][c] = null;

          tile.r = merged.r;
          tile.c = merged.c;

          gained += merged.value;
          if (merged.value === GOAL && !won) hitGoal = true;
          moved = true;
        } else {
          var dest = spot.farthest;
          if (dest.r !== r || dest.c !== c) {
            cells[r][c] = null;
            cells[dest.r][dest.c] = tile;
            tile.r = dest.r;
            tile.c = dest.c;
            moved = true;
          }
        }
      });
    });

    if (!moved) {
      // a dead board rejects every direction — surface that instead of going quiet
      if (!movesAvailable()) endGame();
      return;
    }

    undoStack.push(before);
    if (undoStack.length > UNDO_DEPTH) undoStack.shift();

    score += gained;
    if (score > best) {
      best = score;
      store.write(KEY_BEST, best);
    }

    addRandomTile();
    render(false);
    celebrateScore(gained);

    if (hitGoal) {
      won = true;
      showOverlay(winOverlay);
    } else if (!movesAvailable()) {
      endGame();
    }

    save();
  }

  function endGame() {
    over = true;
    $('#over-score').textContent = score.toLocaleString('en-US');
    $('#over-kicker').textContent = (score > 0 && score >= best) ? 'New best' : 'Final score';
    showOverlay(overOverlay);
    undoBtn.disabled = undoStack.length === 0;
    save();
  }

  function undo() {
    if (!undoStack.length) return;
    var snap = undoStack.pop();
    restoreSnapshot(snap);
    over = false;
    hideOverlay(overOverlay);
    render(true);
    save();
    say('Took back one move.');
  }

  /* ---------------------------------------------------------
     Game lifecycle
     --------------------------------------------------------- */

  function newGame() {
    cells = emptyGrid();
    score = 0;
    won = false;
    keepPlaying = false;
    over = false;
    undoStack = [];
    addRandomTile();
    addRandomTile();
    hideOverlay(winOverlay);
    hideOverlay(overOverlay);
    render(false);
    save();
    say('Swipe to slide every tile at once.');
  }

  function save() {
    store.write(KEY_SAVE, {
      grid: snapshot().grid,
      score: score,
      won: won,
      keepPlaying: keepPlaying,
      over: over,
      undo: undoStack
    });
  }

  function restore() {
    var s = store.read(KEY_SAVE, null);
    if (!s || !Array.isArray(s.grid) || s.grid.length !== SIZE * SIZE) return false;
    if (!s.grid.some(function (v) { return v > 0; })) return false;

    restoreSnapshot({ grid: s.grid, score: Number(s.score) || 0, won: s.won, keepPlaying: s.keepPlaying });
    over = !!s.over;
    undoStack = Array.isArray(s.undo) ? s.undo.filter(function (u) {
      return u && Array.isArray(u.grid) && u.grid.length === SIZE * SIZE;
    }) : [];

    render(true);

    // trust the board, not the saved flag
    if (!movesAvailable()) {
      endGame();
    } else {
      over = false;
    }
    return true;
  }

  /* ---------------------------------------------------------
     Overlays and dialog
     --------------------------------------------------------- */

  function showOverlay(el) { el.hidden = false; }
  function hideOverlay(el) { el.hidden = true; }

  function openDialog() {
    scrimEl.hidden = false;
    newDialog.hidden = false;
  }
  function closeDialog() {
    scrimEl.hidden = true;
    newDialog.hidden = true;
  }

  $('#btn-keep').addEventListener('click', function () {
    keepPlaying = true;
    hideOverlay(winOverlay);
    save();
    say('Endless mode. Next rung is 4096.');
  });

  $('#btn-win-new').addEventListener('click', function () {
    hideOverlay(winOverlay);
    newGame();
  });

  $('#btn-over-new').addEventListener('click', function () {
    hideOverlay(overOverlay);
    newGame();
  });

  $('#btn-over-undo').addEventListener('click', undo);

  $('#btn-undo').addEventListener('click', undo);

  $('#btn-new').addEventListener('click', function () {
    if (!undoStack.length && score === 0) { newGame(); return; }
    openDialog();
  });

  $('#btn-new-confirm').addEventListener('click', function () {
    closeDialog();
    newGame();
  });

  $('#btn-new-cancel').addEventListener('click', closeDialog);
  scrimEl.addEventListener('click', closeDialog);

  /* ---------------------------------------------------------
     Input — swipe and keyboard
     --------------------------------------------------------- */

  var THRESHOLD = 22;
  var startX = 0, startY = 0, startT = 0, tracking = false, fired = false;

  boardEl.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) { tracking = false; return; }
    var t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    startT = Date.now();
    tracking = true;
    fired = false;
  }, { passive: true });

  boardEl.addEventListener('touchmove', function (e) {
    if (!tracking || fired) return;
    var t = e.touches[0];
    var dx = t.clientX - startX;
    var dy = t.clientY - startY;
    if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return;

    fired = true;
    if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 'right' : 'left');
    else move(dy > 0 ? 'down' : 'up');
  }, { passive: true });

  boardEl.addEventListener('touchend', function (e) {
    if (!tracking || fired) { tracking = false; return; }
    tracking = false;

    // a quick flick can end before touchmove crosses the threshold
    var t = e.changedTouches[0];
    var dx = t.clientX - startX;
    var dy = t.clientY - startY;
    var elapsed = Date.now() - startT;
    if (elapsed > 500) return;
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;

    if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 'right' : 'left');
    else move(dy > 0 ? 'down' : 'up');
  }, { passive: true });

  var KEYS = {
    ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down', ArrowLeft: 'left',
    w: 'up', d: 'right', s: 'down', a: 'left',
    W: 'up', D: 'right', S: 'down', A: 'left'
  };

  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === 'Escape' && !newDialog.hidden) { closeDialog(); return; }

    var dir = KEYS[e.key];
    if (dir) { move(dir); e.preventDefault(); return; }

    if (e.key === 'z' || e.key === 'Z' || e.key === 'Backspace') { undo(); e.preventDefault(); }
  });

  /* ---------------------------------------------------------
     Gesture suppression for standalone iOS
     --------------------------------------------------------- */

  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  document.addEventListener('gesturechange', function (e) { e.preventDefault(); });
  document.addEventListener('gestureend', function (e) { e.preventDefault(); });

  document.addEventListener('touchmove', function (e) {
    // nothing in this app scrolls, so every drag is a game gesture
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  var lastTouchEnd = 0;
  document.addEventListener('touchend', function (e) {
    var node = e.target;
    var interactive = node && node.nodeType === 1 && node.closest('button');
    var now = Date.now();
    if (!interactive && now - lastTouchEnd <= 320 && e.cancelable) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });

  /* ---------------------------------------------------------
     Boot
     --------------------------------------------------------- */

  document.addEventListener('visibilitychange', function () { if (document.hidden) save(); });
  window.addEventListener('pagehide', save);

  cells = emptyGrid();
  sizeBoard();

  if (!restore()) {
    newGame();
  } else {
    say('Picked up where you left off.');
  }
  sizeBoard();

  // No service worker here. The arcade's sw.js caches this game already, and a
  // second worker on the same origin would delete the arcade's cache on activate.

  window.__booted = true;
})();
