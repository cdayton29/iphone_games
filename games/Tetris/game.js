/* ============================================================================
 * Cascade — an offline block-drop puzzle
 * ----------------------------------------------------------------------------
 * Architecture
 *   1. Pure data      : piece shapes, SRS kick tables, gravity curve
 *   2. Game class     : state + fixed-step update, fully separate from drawing
 *   3. Renderer       : reads state, writes pixels, never mutates state
 *   4. Input          : touch pad / keyboard -> press(action) / release(action)
 *   5. Module surface : window.CascadeGame.create(options) for an arcade shell
 *
 * No build step, no dependencies, no network at runtime.
 * ========================================================================== */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';

  /* -------------------------------------------------------------- 1. data */

  var DEFAULTS = {
    id: 'cascade',
    title: 'Cascade',
    cols: 10,
    rows: 20,
    nextCount: 3,
    startLevel: 1,
    das: 165,          // ms before auto-shift kicks in
    arr: 45,           // ms between auto-shifted steps
    softDropFactor: 20,// soft drop is this many times faster than gravity
    lockDelay: 500,    // ms a grounded piece waits before locking
    maxLockResets: 15, // move-reset cap, stops infinite stalling
    clearFlashMs: 170,
    dangerRows: 4,     // stack this close to the ceiling turns the frame red
    sound: true,
    storageKey: 'cascade.best.v1'
  };

  var TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

  var COLORS = {
    I: '#22d3ee', O: '#fbbf24', T: '#b06cf0',
    S: '#34d06a', Z: '#f2555f', J: '#4b7bff', L: '#ff8a3d'
  };

  var SHAPES = {
    I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
    O: [[1, 1], [1, 1]],
    T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
    S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
    Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
    J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
    L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]]
  };

  function rotateCW(m) {
    var n = m.length, out = [], y, x;
    for (y = 0; y < n; y++) {
      out.push([]);
      for (x = 0; x < n; x++) out[y].push(m[n - 1 - x][y]);
    }
    return out;
  }

  // ROT[type][rotationIndex] -> matrix. Four states precomputed once.
  var ROT = {};
  TYPES.forEach(function (t) {
    var states = [SHAPES[t]], i;
    for (i = 1; i < 4; i++) states.push(rotateCW(states[i - 1]));
    ROT[t] = states;
  });

  // Spawn column, and the row offset that puts each piece's top row at row 0.
  var SPAWN_X = { I: 3, O: 4, T: 3, S: 3, Z: 3, J: 3, L: 3 };
  var SPAWN_Y = {};
  TYPES.forEach(function (t) {
    var m = ROT[t][0], y, x;
    for (y = 0; y < m.length; y++) {
      for (x = 0; x < m.length; x++) {
        if (m[y][x]) { SPAWN_Y[t] = -y; return; }
      }
    }
  });

  /* Super Rotation System wall kicks, already converted to screen space
     (y grows downward). Key format: "fromRotation>toRotation". */
  var KICKS_JLSTZ = {
    '0>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '1>0': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    '1>2': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    '2>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '2>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    '3>2': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '3>0': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '0>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]]
  };

  var KICKS_I = {
    '0>1': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
    '1>0': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
    '1>2': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
    '2>1': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
    '2>3': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
    '3>2': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
    '3>0': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
    '0>3': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]]
  };

  var LINE_SCORE = [0, 100, 300, 500, 800];
  var CLEAR_NAME = ['', 'Single', 'Double', 'Triple', 'Cascade'];

  // Guideline-style curve: each level falls faster, floored at one frame.
  function gravityFor(level) {
    var l = Math.min(level, 20);
    return Math.max(Math.pow(0.8 - (l - 1) * 0.007, l - 1) * 1000, 16);
  }

  var STEP_MS = 1000 / 60; // fixed simulation step

  /* --------------------------------------------------------- 2. utilities */

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function readStore(key, fallback) {
    try {
      var v = global.localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function writeStore(key, value) {
    try { global.localStorage.setItem(key, String(value)); } catch (e) {}
  }

  /** Tiny WebAudio blip synth. No asset files, so nothing to download. */
  function Sfx(enabled) {
    this.enabled = !!enabled;
    this.ctx = null;
  }
  Sfx.prototype.unlock = function () {
    if (!this.ctx) {
      var C = global.AudioContext || global.webkitAudioContext;
      if (!C) return;
      try { this.ctx = new C(); } catch (e) { return; }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  };
  Sfx.prototype.play = function (freq, dur, type, gain) {
    if (!this.enabled) return;
    this.unlock();
    if (!this.ctx) return;
    var t = this.ctx.currentTime;
    var osc = this.ctx.createOscillator();
    var amp = this.ctx.createGain();
    osc.type = type || 'square';
    osc.frequency.setValueAtTime(freq, t);
    amp.gain.setValueAtTime(gain || 0.035, t);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.06));
    osc.connect(amp);
    amp.connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + (dur || 0.06) + 0.02);
  };

  /* ------------------------------------------------------------- 3. game */

  function Game(options) {
    this.cfg = Object.assign({}, DEFAULTS, options || {});
    this.listeners = {};
    this.sfx = new Sfx(this.cfg.sound);
    this.dpr = 1;
    this.cell = 0;
    this.raf = 0;
    this.acc = 0;
    this.lastTs = 0;
    this.mounted = false;
    this.touches = new Map();
    this.usingTouch = false;
    this.best = parseInt(readStore(this.cfg.storageKey, '0'), 10) || 0;

    // bound handlers, kept so destroy() can detach every one of them
    this.onFrame = this.onFrame.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onTouchStart = this.onTouchStart.bind(this);
    this.onTouchMove = this.onTouchMove.bind(this);
    this.onTouchEnd = this.onTouchEnd.bind(this);
    this.onMouseDown = this.onMouseDown.bind(this);
    this.onMouseUp = this.onMouseUp.bind(this);
    this.onResize = this.onResize.bind(this);
    this.onVisibility = this.onVisibility.bind(this);
    this.blockGesture = function (e) { if (e.cancelable) e.preventDefault(); };
  }

  /* ---- events ---- */

  Game.prototype.on = function (name, fn) {
    (this.listeners[name] || (this.listeners[name] = [])).push(fn);
    return this;
  };
  Game.prototype.off = function (name, fn) {
    var list = this.listeners[name];
    if (list) this.listeners[name] = list.filter(function (f) { return f !== fn; });
    return this;
  };
  Game.prototype.emit = function (name, detail) {
    (this.listeners[name] || []).forEach(function (fn) {
      try { fn(detail); } catch (e) { console.error(e); }
    });
    (this.listeners['*'] || []).forEach(function (fn) {
      try { fn({ type: name, detail: detail }); } catch (e) { console.error(e); }
    });
  };

  /* ---- lifecycle ---- */

  Game.prototype.mount = function (root) {
    if (this.mounted) return this;
    var el = typeof root === 'string' ? document.querySelector(root) : root;
    this.root = el || document.querySelector('[data-cascade-host]') || document.body;

    var q = this.root.querySelector.bind(this.root);
    this.els = {
      stage: q('#stage'),
      board: q('#board'),
      hold: q('#hold'),
      next: Array.prototype.slice.call(this.root.querySelectorAll('[data-next]')),
      score: q('#score'),
      level: q('#level'),
      lines: q('#lines'),
      best: q('#best'),
      pad: q('#pad'),
      pause: q('#pause'),
      sound: q('#sound'),
      veil: q('#veil'),
      veilEyebrow: q('#veil-eyebrow'),
      veilTitle: q('#veil-title'),
      veilBody: q('#veil-body'),
      veilAction: q('#veil-action'),
      toast: q('#toast')
    };
    this.ctx = this.els.board.getContext('2d', { alpha: false });

    this.bindInput();
    this.reset();
    this.syncViewport();
    this.layout();
    this.showVeil({
      eyebrow: 'Ready',
      title: this.cfg.title,
      body: 'Clear lines to climb levels. Runs fully offline once installed.',
      action: 'Play'
    });
    this.mounted = true;
    this.startLoop();
    this.emit('ready', { version: VERSION });
    return this;
  };

  Game.prototype.destroy = function () {
    this.stopLoop();
    this.unbindInput();
    this.mounted = false;
    this.emit('destroy', null);
  };

  Game.prototype.reset = function () {
    var cfg = this.cfg, y;
    this.board = [];
    for (y = 0; y < cfg.rows; y++) this.board.push(new Uint8Array(cfg.cols));

    this.bag = [];
    this.queue = [];
    this.refillQueue();

    this.active = null;
    this.hold = null;
    this.holdLocked = false;

    this.score = 0;
    this.lines = 0;
    this.level = cfg.startLevel;
    this.combo = -1;
    this.b2b = false;
    this.gravityMs = gravityFor(this.level);

    this.gravityAcc = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.dasDir = 0;
    this.dasTimer = 0;
    this.dasCharged = false;
    this.arrAcc = 0;
    this.softDropping = false;
    this.clearing = null;
    this.stackTop = cfg.rows;

    this.phase = 'idle';
    this.syncHud();
    this.setAccent('#6ee7ff');
  };

  Game.prototype.start = function () {
    this.reset();
    this.spawn();
    this.phase = 'playing';
    this.hideVeil();
    this.sfx.unlock();
    this.emit('start', null);
    return this;
  };

  Game.prototype.pause = function () {
    if (this.phase !== 'playing') return this;
    this.phase = 'paused';
    this.releaseAll();
    this.showVeil({
      eyebrow: 'Paused',
      title: String(this.score),
      body: 'Level ' + this.level + ' · ' + this.lines + ' lines cleared.',
      action: 'Resume'
    });
    this.emit('pause', null);
    return this;
  };

  Game.prototype.resume = function () {
    if (this.phase !== 'paused') return this;
    this.phase = 'playing';
    this.hideVeil();
    this.emit('resume', null);
    return this;
  };

  Game.prototype.togglePause = function () {
    if (this.phase === 'playing') this.pause();
    else if (this.phase === 'paused') this.resume();
    else if (this.phase === 'idle' || this.phase === 'over') this.start();
  };

  Game.prototype.gameOver = function () {
    this.phase = 'over';
    this.releaseAll();
    var record = this.score > this.best;
    if (record) { this.best = this.score; writeStore(this.cfg.storageKey, this.best); }
    this.syncHud();
    this.sfx.play(160, 0.5, 'sawtooth', 0.05);
    this.showVeil({
      eyebrow: record ? 'New best' : 'Game over',
      title: String(this.score),
      body: 'Level ' + this.level + ' · ' + this.lines + ' lines · best ' + this.best + '.',
      action: 'Play again'
    });
    this.emit('gameover', { score: this.score, lines: this.lines, level: this.level, best: this.best });
  };

  /* ---- piece supply ---- */

  Game.prototype.refillQueue = function () {
    while (this.queue.length < this.cfg.nextCount + 1) {
      if (!this.bag.length) {
        this.bag = TYPES.slice();
        for (var i = this.bag.length - 1; i > 0; i--) { // Fisher-Yates 7-bag
          var j = Math.floor(Math.random() * (i + 1));
          var t = this.bag[i]; this.bag[i] = this.bag[j]; this.bag[j] = t;
        }
      }
      this.queue.push(this.bag.pop());
    }
  };

  Game.prototype.makePiece = function (type) {
    return { type: type, rot: 0, x: SPAWN_X[type], y: SPAWN_Y[type] };
  };

  Game.prototype.spawn = function (type) {
    if (!type) { type = this.queue.shift(); this.refillQueue(); }
    this.active = this.makePiece(type);
    this.gravityAcc = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.setAccent(COLORS[type]);
    this.drawQueues();
    if (this.collides(this.active, 0, 0)) { this.active = null; this.gameOver(); return false; }
    return true;
  };

  Game.prototype.holdPiece = function () {
    if (this.phase !== 'playing' || !this.active || this.holdLocked || this.clearing) return;
    var swap = this.hold;
    this.hold = this.active.type;
    this.holdLocked = true;
    this.sfx.play(520, 0.05, 'triangle', 0.03);
    if (swap) {
      this.active = this.makePiece(swap);
      this.gravityAcc = this.lockTimer = this.lockResets = 0;
      this.setAccent(COLORS[swap]);
      if (this.collides(this.active, 0, 0)) { this.active = null; this.gameOver(); return; }
      this.drawQueues();
    } else {
      this.spawn();
    }
  };

  /* ---- collision & movement ---- */

  Game.prototype.matrixOf = function (piece) { return ROT[piece.type][piece.rot]; };

  Game.prototype.collides = function (piece, dx, dy, rot) {
    var m = ROT[piece.type][rot === undefined ? piece.rot : rot];
    var px = piece.x + dx, py = piece.y + dy;
    var cols = this.cfg.cols, rows = this.cfg.rows;
    for (var y = 0; y < m.length; y++) {
      for (var x = 0; x < m.length; x++) {
        if (!m[y][x]) continue;
        var bx = px + x, by = py + y;
        if (bx < 0 || bx >= cols || by >= rows) return true;
        if (by >= 0 && this.board[by][bx]) return true; // above the ceiling is free
      }
    }
    return false;
  };

  Game.prototype.pieceMoved = function () {
    // Move reset: touching the floor restarts the lock timer, up to a cap.
    if (this.collides(this.active, 0, 1) && this.lockResets < this.cfg.maxLockResets) {
      this.lockTimer = 0;
      this.lockResets++;
    }
  };

  Game.prototype.move = function (dx) {
    if (!this.active || this.clearing) return false;
    if (this.collides(this.active, dx, 0)) return false;
    this.active.x += dx;
    this.pieceMoved();
    this.sfx.play(220, 0.02, 'square', 0.018);
    return true;
  };

  Game.prototype.rotate = function (dir) {
    if (!this.active || this.clearing) return false;
    var p = this.active;
    if (p.type === 'O') return true;
    var from = p.rot;
    var to = (from + (dir > 0 ? 1 : 3)) % 4;
    var table = p.type === 'I' ? KICKS_I : KICKS_JLSTZ;
    var tests = table[from + '>' + to] || [[0, 0]];
    for (var i = 0; i < tests.length; i++) {
      var dx = tests[i][0], dy = tests[i][1];
      if (!this.collides(p, dx, dy, to)) {
        p.x += dx; p.y += dy; p.rot = to;
        this.pieceMoved();
        this.sfx.play(330, 0.035, 'triangle', 0.025);
        return true;
      }
    }
    return false;
  };

  Game.prototype.ghostY = function () {
    var p = this.active, d = 0;
    if (!p) return 0;
    while (!this.collides(p, 0, d + 1)) d++;
    return p.y + d;
  };

  Game.prototype.hardDrop = function () {
    if (!this.active || this.clearing || this.phase !== 'playing') return;
    var d = 0;
    while (!this.collides(this.active, 0, d + 1)) d++;
    this.active.y += d;
    if (d) this.addScore(d * 2);
    this.sfx.play(140, 0.07, 'square', 0.045);
    this.lockPiece();
  };

  /* ---- locking, clearing, scoring ---- */

  Game.prototype.lockPiece = function () {
    var p = this.active;
    if (!p) return;
    var m = this.matrixOf(p);
    var idx = TYPES.indexOf(p.type) + 1;
    var aboveCeiling = true;
    var y, x;

    for (y = 0; y < m.length; y++) {
      for (x = 0; x < m.length; x++) {
        if (!m[y][x]) continue;
        var by = p.y + y, bx = p.x + x;
        if (by >= 0) { this.board[by][bx] = idx; aboveCeiling = false; }
      }
    }

    this.active = null;
    this.holdLocked = false;
    this.lockTimer = 0;

    if (aboveCeiling) { this.gameOver(); return; }

    var full = [];
    for (y = 0; y < this.cfg.rows; y++) {
      var complete = true;
      for (x = 0; x < this.cfg.cols; x++) if (!this.board[y][x]) { complete = false; break; }
      if (complete) full.push(y);
    }

    if (full.length) {
      this.clearing = { rows: full, t: 0 };
      this.sfx.play(full.length === 4 ? 880 : 620, 0.12, 'sine', 0.05);
      this.emit('lineclear', { count: full.length, rows: full.slice() });
    } else {
      this.combo = -1;
      this.recomputeStackTop();
      this.spawn();
    }
  };

  Game.prototype.finishClear = function () {
    var rows = this.clearing.rows;
    var n = rows.length;
    this.clearing = null;

    // Remove cleared rows from the top down, then pad the top with empties.
    rows.sort(function (a, b) { return a - b; }).forEach(function (r) {
      this.board.splice(r, 1);
      this.board.unshift(new Uint8Array(this.cfg.cols));
    }, this);

    var isTetris = n === 4;
    var points = LINE_SCORE[n] * this.level;
    if (isTetris && this.b2b) points = Math.floor(points * 1.5);
    this.combo++;
    if (this.combo > 0) points += 50 * this.combo * this.level;
    this.b2b = isTetris;

    this.lines += n;
    this.addScore(points);

    var nextLevel = clamp(this.cfg.startLevel + Math.floor(this.lines / 10), 1, 20);
    if (nextLevel !== this.level) {
      this.level = nextLevel;
      this.gravityMs = gravityFor(this.level);
      this.sfx.play(1040, 0.14, 'triangle', 0.04);
      this.emit('levelup', { level: this.level });
    }

    this.recomputeStackTop();
    this.syncHud();
    this.emit('score', { score: this.score, lines: this.lines, clear: CLEAR_NAME[n] });
    this.spawn();
  };

  Game.prototype.addScore = function (points) {
    this.score += points;
    this.syncHud();
  };

  Game.prototype.recomputeStackTop = function () {
    var rows = this.cfg.rows, cols = this.cfg.cols, y, x;
    for (y = 0; y < rows; y++) {
      for (x = 0; x < cols; x++) {
        if (this.board[y][x]) { this.stackTop = y; return; }
      }
    }
    this.stackTop = rows;
  };

  /* -------------------------------------------------------- 4. simulation */

  Game.prototype.startLoop = function () {
    if (this.raf) return;
    this.lastTs = 0;
    this.raf = requestAnimationFrame(this.onFrame);
  };

  Game.prototype.stopLoop = function () {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  };

  Game.prototype.onFrame = function (ts) {
    this.raf = requestAnimationFrame(this.onFrame);
    if (!this.lastTs) this.lastTs = ts;
    var dt = Math.min(ts - this.lastTs, 250); // a backgrounded tab must not fast-forward
    this.lastTs = ts;

    // Fixed-step updates keep physics identical on 60Hz and 120Hz screens.
    this.acc += dt;
    var guard = 0;
    while (this.acc >= STEP_MS && guard++ < 8) {
      this.step(STEP_MS);
      this.acc -= STEP_MS;
    }
    this.render();
  };

  Game.prototype.step = function (dt) {
    if (this.phase !== 'playing') return;

    if (this.clearing) {
      this.clearing.t += dt;
      if (this.clearing.t >= this.cfg.clearFlashMs) this.finishClear();
      return;
    }
    if (!this.active) return;

    this.stepShift(dt);
    this.stepGravity(dt);
    this.stepLock(dt);
  };

  Game.prototype.stepShift = function (dt) {
    if (!this.dasDir) return;
    this.dasTimer += dt;
    if (!this.dasCharged) {
      if (this.dasTimer >= this.cfg.das) { this.dasCharged = true; this.arrAcc = 0; this.move(this.dasDir); }
      return;
    }
    this.arrAcc += dt;
    while (this.arrAcc >= this.cfg.arr) {
      this.arrAcc -= this.cfg.arr;
      if (!this.move(this.dasDir)) { this.arrAcc = 0; break; }
    }
  };

  Game.prototype.stepGravity = function (dt) {
    var interval = this.softDropping
      ? Math.max(this.gravityMs / this.cfg.softDropFactor, 16)
      : this.gravityMs;
    this.gravityAcc += dt;
    var guard = 0;
    while (this.gravityAcc >= interval && guard++ < 24) {
      this.gravityAcc -= interval;
      if (this.collides(this.active, 0, 1)) { this.gravityAcc = 0; break; }
      this.active.y++;
      this.lockTimer = 0;
      this.lockResets = 0;
      if (this.softDropping) this.addScore(1);
    }
  };

  Game.prototype.stepLock = function (dt) {
    if (this.collides(this.active, 0, 1)) {
      this.lockTimer += dt;
      if (this.lockTimer >= this.cfg.lockDelay) this.lockPiece();
    } else {
      this.lockTimer = 0;
    }
  };

  /* ---------------------------------------------------------- 5. renderer */

  Game.prototype.syncViewport = function () {
    // visualViewport tracks the real usable height on iOS when the URL bar
    // expands or collapses; innerHeight alone leaves the pad clipped.
    var vv = global.visualViewport;
    var h = vv ? vv.height : global.innerHeight;
    document.documentElement.style.setProperty('--app-h', Math.round(h) + 'px');
  };

  Game.prototype.layout = function () {
    var stage = this.els.stage;
    if (!stage) return;
    var rect = stage.getBoundingClientRect();
    var cols = this.cfg.cols, rows = this.cfg.rows;
    var cell = Math.floor(Math.min(rect.width / cols, rect.height / rows));
    cell = Math.max(cell, 6);

    this.dpr = clamp(global.devicePixelRatio || 1, 1, 3);
    this.cell = cell;

    var cssW = cell * cols, cssH = cell * rows;
    var board = this.els.board;
    board.style.width = cssW + 'px';
    board.style.height = cssH + 'px';
    board.width = Math.round(cssW * this.dpr);
    board.height = Math.round(cssH * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.els.next.concat([this.els.hold]).forEach(function (c) {
      if (!c) return;
      var r = c.getBoundingClientRect();
      c.width = Math.round(r.width * this.dpr);
      c.height = Math.round(r.height * this.dpr);
      var cx = c.getContext('2d');
      cx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }, this);

    this.drawQueues();
  };

  Game.prototype.setAccent = function (color) {
    (this.root || document.documentElement).style.setProperty('--accent', color);
  };

  /** Draw one mino: flat fill, rounded corner, one bright top edge. Enough
      shape to read at 14px cells without turning into a bevelled 90s tile. */
  Game.prototype.drawCell = function (ctx, cx, cy, size, color, alpha) {
    var pad = Math.max(1, Math.round(size * 0.06));
    var s = size - pad * 2;
    var r = Math.max(1, Math.round(size * 0.16));
    ctx.globalAlpha = alpha === undefined ? 1 : alpha;
    ctx.fillStyle = color;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(cx + pad, cy + pad, s, s, r);
      ctx.fill();
    } else {
      ctx.fillRect(cx + pad, cy + pad, s, s);
    }
    ctx.globalAlpha = (alpha === undefined ? 1 : alpha) * 0.5;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(cx + pad + r * 0.4, cy + pad + Math.max(1, s * 0.08), s - r * 0.8, Math.max(1, s * 0.09));
    ctx.globalAlpha = 1;
  };

  Game.prototype.render = function () {
    var ctx = this.ctx;
    if (!ctx || !this.cell) return;
    var cell = this.cell, cols = this.cfg.cols, rows = this.cfg.rows;
    var w = cell * cols, h = cell * rows;
    var x, y;

    ctx.fillStyle = '#0b111c';
    ctx.fillRect(0, 0, w, h);

    // grid
    ctx.strokeStyle = 'rgba(120,150,200,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (x = 1; x < cols; x++) { ctx.moveTo(x * cell + 0.5, 0); ctx.lineTo(x * cell + 0.5, h); }
    for (y = 1; y < rows; y++) { ctx.moveTo(0, y * cell + 0.5); ctx.lineTo(w, y * cell + 0.5); }
    ctx.stroke();

    // locked stack
    for (y = 0; y < rows; y++) {
      for (x = 0; x < cols; x++) {
        var v = this.board[y][x];
        if (v) this.drawCell(ctx, x * cell, y * cell, cell, COLORS[TYPES[v - 1]], 1);
      }
    }

    // clear flash
    if (this.clearing) {
      var p = clamp(this.clearing.t / this.cfg.clearFlashMs, 0, 1);
      ctx.globalAlpha = 1 - p;
      ctx.fillStyle = '#ffffff';
      this.clearing.rows.forEach(function (r) {
        var inset = (cell * 0.5) * p;
        ctx.fillRect(0, r * cell + inset, w, Math.max(0, cell - inset * 2));
      });
      ctx.globalAlpha = 1;
    }

    if (this.active && this.phase !== 'over') {
      var m = this.matrixOf(this.active);
      var color = COLORS[this.active.type];
      var gy = this.ghostY();

      // ghost — hidden once the piece has reached it, to avoid a doubled edge
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, cell * 0.08);
      for (y = 0; gy !== this.active.y && y < m.length; y++) {
        for (x = 0; x < m.length; x++) {
          if (!m[y][x]) continue;
          var gx2 = (this.active.x + x) * cell, gy2 = (gy + y) * cell;
          if (gy + y < 0) continue;
          ctx.globalAlpha = 0.12;
          ctx.fillStyle = color;
          ctx.fillRect(gx2 + 2, gy2 + 2, cell - 4, cell - 4);
          ctx.globalAlpha = 0.5;
          ctx.strokeRect(gx2 + 2, gy2 + 2, cell - 4, cell - 4);
        }
      }
      ctx.globalAlpha = 1;

      // active piece, brighter as the lock timer fills
      var lockGlow = this.lockTimer > 0 ? clamp(this.lockTimer / this.cfg.lockDelay, 0, 1) : 0;
      for (y = 0; y < m.length; y++) {
        for (x = 0; x < m.length; x++) {
          if (!m[y][x]) continue;
          var by = this.active.y + y;
          if (by < 0) continue;
          this.drawCell(ctx, (this.active.x + x) * cell, by * cell, cell, color, 1);
          if (lockGlow > 0.05) {
            ctx.globalAlpha = lockGlow * 0.4;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect((this.active.x + x) * cell + 2, by * cell + 2, cell - 4, cell - 4);
            ctx.globalAlpha = 1;
          }
        }
      }
    }

    var danger = this.phase === 'playing' && this.stackTop <= this.cfg.dangerRows;
    if (this.els.stage.dataset.danger !== String(danger)) {
      this.els.stage.dataset.danger = String(danger);
    }
  };

  Game.prototype.drawMini = function (canvas, type) {
    if (!canvas) return;
    var cx = canvas.getContext('2d');
    var w = canvas.width / this.dpr, h = canvas.height / this.dpr;
    cx.clearRect(0, 0, w, h);
    if (!type) return;

    var m = ROT[type][0];
    var minX = 99, maxX = -1, minY = 99, maxY = -1, x, y;
    for (y = 0; y < m.length; y++) {
      for (x = 0; x < m.length; x++) {
        if (!m[y][x]) continue;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    var pw = maxX - minX + 1, ph = maxY - minY + 1;
    var cell = Math.floor(Math.min((w - 8) / pw, (h - 8) / ph));
    var ox = (w - pw * cell) / 2, oy = (h - ph * cell) / 2;
    for (y = minY; y <= maxY; y++) {
      for (x = minX; x <= maxX; x++) {
        if (!m[y][x]) continue;
        this.drawCell(cx, ox + (x - minX) * cell, oy + (y - minY) * cell, cell, COLORS[type], 1);
      }
    }
  };

  Game.prototype.drawQueues = function () {
    this.drawMini(this.els.hold, this.hold);
    if (this.els.hold) this.els.hold.dataset.locked = String(this.holdLocked);
    for (var i = 0; i < this.els.next.length; i++) {
      this.drawMini(this.els.next[i], this.queue[i]);
    }
  };

  Game.prototype.syncHud = function () {
    if (!this.els) return;
    this.els.score.textContent = this.score;
    this.els.level.textContent = this.level;
    this.els.lines.textContent = this.lines;
    this.els.best.textContent = Math.max(this.best, this.score);
  };

  Game.prototype.showVeil = function (opts) {
    var e = this.els;
    e.veilEyebrow.textContent = opts.eyebrow;
    e.veilTitle.textContent = opts.title;
    e.veilBody.textContent = opts.body;
    e.veilAction.textContent = opts.action;
    e.veil.hidden = false;
  };

  Game.prototype.hideVeil = function () { this.els.veil.hidden = true; };

  Game.prototype.toast = function (message, actionLabel, onAction) {
    var t = this.els.toast;
    if (!t) return;
    t.textContent = message;
    if (actionLabel) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = actionLabel;
      b.addEventListener('click', onAction);
      t.appendChild(b);
    }
    t.hidden = false;
  };

  /* ------------------------------------------------------------- 6. input */

  var KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowDown: 'softDrop', KeyS: 'softDrop',
    Space: 'hardDrop',
    ArrowUp: 'rotateCW', KeyX: 'rotateCW',
    KeyZ: 'rotateCCW', ControlLeft: 'rotateCCW', ControlRight: 'rotateCCW',
    KeyC: 'hold', ShiftLeft: 'hold', ShiftRight: 'hold',
    KeyP: 'pause', Escape: 'pause'
  };

  Game.prototype.press = function (action, btn) {
    if (btn) btn.dataset.pressed = 'true';
    this.sfx.unlock();

    if (action === 'pause') { this.togglePause(); return; }
    if (this.phase === 'idle' || this.phase === 'over') { this.start(); return; }
    if (this.phase !== 'playing') return;

    switch (action) {
      case 'left':
      case 'right':
        var dir = action === 'left' ? -1 : 1;
        this.move(dir);
        this.dasDir = dir;
        this.dasTimer = 0;
        this.dasCharged = false;
        this.arrAcc = 0;
        break;
      case 'softDrop':
        // Prime the accumulator with exactly one soft-drop interval so the
        // press lands a single cell on the next step. Priming it with the
        // full gravity interval would empty into ~20 cells at once.
        this.softDropping = true;
        this.gravityAcc = Math.max(this.gravityMs / this.cfg.softDropFactor, 16);
        break;
      case 'hardDrop': this.hardDrop(); break;
      case 'rotateCW': this.rotate(1); break;
      case 'rotateCCW': this.rotate(-1); break;
      case 'hold': this.holdPiece(); break;
    }
  };

  Game.prototype.release = function (action, btn) {
    if (btn) btn.dataset.pressed = 'false';
    if ((action === 'left' && this.dasDir === -1) || (action === 'right' && this.dasDir === 1)) {
      this.dasDir = 0;
      this.dasCharged = false;
    }
    if (action === 'softDrop') { this.softDropping = false; this.gravityAcc = 0; }
  };

  Game.prototype.releaseAll = function () {
    this.dasDir = 0;
    this.dasCharged = false;
    this.softDropping = false;
    this.touches.clear();
    if (this.els && this.els.pad) {
      Array.prototype.forEach.call(this.els.pad.querySelectorAll('.pad__btn'), function (b) {
        b.dataset.pressed = 'false';
      });
    }
  };

  Game.prototype.buttonAt = function (clientX, clientY) {
    var el = document.elementFromPoint(clientX, clientY);
    return el && el.closest ? el.closest('.pad__btn') : null;
  };

  Game.prototype.onTouchStart = function (e) {
    this.usingTouch = true;
    if (e.cancelable) e.preventDefault(); // kills double-tap zoom and ghost clicks
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var btn = this.buttonAt(t.clientX, t.clientY);
      if (!btn) continue;
      this.touches.set(t.identifier, btn);
      this.press(btn.dataset.action, btn);
    }
  };

  Game.prototype.onTouchMove = function (e) {
    if (e.cancelable) e.preventDefault(); // no panning, pinching or edge-swipe
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var prev = this.touches.get(t.identifier) || null;
      var btn = this.buttonAt(t.clientX, t.clientY);
      if (prev === btn) continue;
      if (prev) this.release(prev.dataset.action, prev);
      if (btn) {
        this.touches.set(t.identifier, btn);
        this.press(btn.dataset.action, btn);
      } else {
        this.touches.delete(t.identifier);
      }
    }
  };

  Game.prototype.onTouchEnd = function (e) {
    if (e.cancelable) e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var btn = this.touches.get(t.identifier);
      if (btn) { this.release(btn.dataset.action, btn); this.touches.delete(t.identifier); }
    }
  };

  Game.prototype.onMouseDown = function (e) {
    if (this.usingTouch) return; // touch already handled it
    var btn = this.buttonAt(e.clientX, e.clientY);
    if (!btn) return;
    e.preventDefault();
    this.mouseBtn = btn;
    this.press(btn.dataset.action, btn);
  };

  Game.prototype.onMouseUp = function () {
    if (!this.mouseBtn) return;
    this.release(this.mouseBtn.dataset.action, this.mouseBtn);
    this.mouseBtn = null;
  };

  Game.prototype.onKeyDown = function (e) {
    var action = KEYMAP[e.code];
    if (!action) return;
    e.preventDefault();
    if (e.repeat) return; // our DAS handles repeats, not the OS
    this.press(action, null);
  };

  Game.prototype.onKeyUp = function (e) {
    var action = KEYMAP[e.code];
    if (!action) return;
    this.release(action, null);
  };

  Game.prototype.onResize = function () {
    this.syncViewport();
    this.layout();
  };

  Game.prototype.onVisibility = function () {
    if (document.hidden) this.pause();
  };

  Game.prototype.bindInput = function () {
    var pad = this.els.pad, opts = { passive: false };

    pad.addEventListener('touchstart', this.onTouchStart, opts);
    pad.addEventListener('touchmove', this.onTouchMove, opts);
    pad.addEventListener('touchend', this.onTouchEnd, opts);
    pad.addEventListener('touchcancel', this.onTouchEnd, opts);
    pad.addEventListener('mousedown', this.onMouseDown);
    global.addEventListener('mouseup', this.onMouseUp);
    pad.addEventListener('contextmenu', this.blockGesture);

    // Page-level gesture suppression: nothing here scrolls or zooms.
    document.addEventListener('touchmove', this.blockGesture, opts);
    document.addEventListener('gesturestart', this.blockGesture, opts);
    document.addEventListener('gesturechange', this.blockGesture, opts);
    document.addEventListener('dblclick', this.blockGesture, opts);

    global.addEventListener('keydown', this.onKeyDown);
    global.addEventListener('keyup', this.onKeyUp);
    global.addEventListener('blur', this.releaseAll.bind(this));
    document.addEventListener('visibilitychange', this.onVisibility);

    global.addEventListener('resize', this.onResize);
    global.addEventListener('orientationchange', this.onResize);
    if (global.visualViewport) {
      global.visualViewport.addEventListener('resize', this.onResize);
      global.visualViewport.addEventListener('scroll', this.onResize);
    }
    if (global.ResizeObserver) {
      this.ro = new ResizeObserver(this.layout.bind(this));
      this.ro.observe(this.els.stage);
    }

    var self = this;
    this.els.veilAction.addEventListener('click', function () {
      this.blur();
      if (self.phase === 'paused') self.resume(); else self.start();
    });
    this.els.pause.addEventListener('click', function () { this.blur(); self.togglePause(); });
    this.els.sound.addEventListener('click', function () {
      self.sfx.enabled = !self.sfx.enabled;
      this.setAttribute('aria-pressed', String(self.sfx.enabled));
      this.setAttribute('aria-label', self.sfx.enabled ? 'Sound on' : 'Sound off');
      if (self.sfx.enabled) self.sfx.play(660, 0.05, 'triangle', 0.03);
    });
  };

  Game.prototype.unbindInput = function () {
    var pad = this.els && this.els.pad;
    if (pad) {
      pad.removeEventListener('touchstart', this.onTouchStart);
      pad.removeEventListener('touchmove', this.onTouchMove);
      pad.removeEventListener('touchend', this.onTouchEnd);
      pad.removeEventListener('touchcancel', this.onTouchEnd);
      pad.removeEventListener('mousedown', this.onMouseDown);
    }
    global.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('touchmove', this.blockGesture);
    document.removeEventListener('gesturestart', this.blockGesture);
    document.removeEventListener('gesturechange', this.blockGesture);
    document.removeEventListener('dblclick', this.blockGesture);
    global.removeEventListener('keydown', this.onKeyDown);
    global.removeEventListener('keyup', this.onKeyUp);
    global.removeEventListener('resize', this.onResize);
    global.removeEventListener('orientationchange', this.onResize);
    if (global.visualViewport) {
      global.visualViewport.removeEventListener('resize', this.onResize);
      global.visualViewport.removeEventListener('scroll', this.onResize);
    }
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.ro) this.ro.disconnect();
  };

  /* ------------------------------------------------- 7. module + bootstrap */

  var CascadeGame = {
    id: DEFAULTS.id,
    title: DEFAULTS.title,
    version: VERSION,
    configUrl: './game.config.json',
    /** Arcade shells call this instead of relying on auto-boot. */
    create: function (options) { return new Game(options); },
    /** Loads game.config.json (cached by the service worker), then mounts. */
    boot: function (options) {
      var opts = options || {};
      return loadConfig(opts.configUrl || CascadeGame.configUrl).then(function (fileCfg) {
        var game = new Game(Object.assign({}, fileCfg, opts.settings));
        game.mount(opts.root || '[data-cascade-host]');
        return game;
      });
    }
  };

  function loadConfig(url) {
    if (!global.fetch) return Promise.resolve({});
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('config ' + r.status);
      return r.json();
    }).then(function (json) {
      return (json && json.settings) || {};
    }).catch(function () {
      return {}; // defaults are always playable, config is an enhancement
    });
  }

  global.CascadeGame = CascadeGame;

  // Announce ourselves either way: shells that loaded first can register
  // directly, shells that load later can listen for the event.
  if (global.ArcadeShell && typeof global.ArcadeShell.register === 'function') {
    global.ArcadeShell.register(CascadeGame);
  }
  global.dispatchEvent(new CustomEvent('arcade:game-available', { detail: CascadeGame }));

  function registerServiceWorker(game) {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    navigator.serviceWorker.register('./sw.js').then(function (reg) {
      reg.addEventListener('updatefound', function () {
        var sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', function () {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            game.toast('New version ready', 'Reload', function () {
              sw.postMessage({ type: 'SKIP_WAITING' });
              location.reload();
            });
          }
        });
      });
    }).catch(function (err) {
      console.warn('Service worker not registered:', err.message);
    });
  }

  // Auto-boot when running standalone. A shell sets window.ARCADE_MANUAL_BOOT
  // = true before loading this file to take over mounting itself.
  if (!global.ARCADE_MANUAL_BOOT && document.querySelector('[data-cascade-host]')) {
    CascadeGame.boot().then(function (game) {
      global.cascade = game;
      registerServiceWorker(game);
    });
  }

})(window);
