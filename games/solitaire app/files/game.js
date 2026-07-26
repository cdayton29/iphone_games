'use strict';

(function () {

  var SAVE_KEY = 'klondike-pwa-v1';
  var SUIT_GLYPHS = ['\u2665', '\u2666', '\u2663', '\u2660']; // hearts, diamonds, clubs, spades
  var RANK_TEXT = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var UNDO_LIMIT = 300;

  var els = {
    board: document.getElementById('board'),
    stock: document.getElementById('stock'),
    waste: document.getElementById('waste'),
    foundations: Array.prototype.slice.call(document.querySelectorAll('.pile.foundation')),
    tableaus: Array.prototype.slice.call(document.querySelectorAll('.pile.tableau')),
    dragLayer: document.getElementById('drag-layer'),
    fxLayer: document.getElementById('fx-layer'),
    winOverlay: document.getElementById('win-overlay'),
    winStats: document.getElementById('win-stats'),
    hudMoves: document.getElementById('hud-moves'),
    hudTime: document.getElementById('hud-time'),
    btnNew: document.getElementById('btn-new'),
    btnRestart: document.getElementById('btn-restart'),
    btnUndo: document.getElementById('btn-undo'),
    btnDraw: document.getElementById('btn-draw'),
    btnWinNew: document.getElementById('btn-win-new')
  };

  var state = null;      // { order, stock, waste, f, t, draw, moves, time, won }
  var undoStack = [];
  var drag = null;       // active pointer interaction
  var timerId = null;
  var fxRunning = false;

  /* ---------------- Deck & dealing ---------------- */

  function shuffledOrder() {
    var order = [];
    var s, r, i, j, tmp;
    for (s = 0; s < 4; s++) {
      for (r = 1; r <= 13; r++) {
        order.push({ s: s, r: r });
      }
    }
    for (i = order.length - 1; i > 0; i--) {
      j = Math.floor(Math.random() * (i + 1));
      tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }
    return order;
  }

  function dealFromOrder(order, drawMode) {
    var deck = order.map(function (c) {
      return { s: c.s, r: c.r, up: false };
    });
    var t = [[], [], [], [], [], [], []];
    var col, n;
    for (n = 0; n < 7; n++) {
      for (col = n; col < 7; col++) {
        t[col].push(deck.pop());
      }
    }
    for (col = 0; col < 7; col++) {
      t[col][t[col].length - 1].up = true;
    }
    return {
      order: order,
      stock: deck,          // last element = top of stock
      waste: [],            // last element = top of waste
      f: [[], [], [], []],  // fixed suits: hearts, diamonds, clubs, spades
      t: t,
      draw: drawMode,
      moves: 0,
      time: 0,
      won: false
    };
  }

  function newGame() {
    state = dealFromOrder(shuffledOrder(), state ? state.draw : 1);
    undoStack = [];
    hideWin();
    clearFx();
    save();
    render();
  }

  function restartGame() {
    if (!state) return;
    state = dealFromOrder(state.order, state.draw);
    undoStack = [];
    hideWin();
    clearFx();
    save();
    render();
  }

  /* ---------------- Rules ---------------- */

  function isRed(card) {
    return card.s < 2;
  }

  function canPlaceOnTableau(card, col) {
    if (col.length === 0) {
      return card.r === 13;
    }
    var top = col[col.length - 1];
    return top.up && isRed(top) !== isRed(card) && top.r === card.r + 1;
  }

  function canPlaceOnFoundation(card, fi) {
    if (card.s !== fi) return false;
    var pile = state.f[fi];
    if (pile.length === 0) return card.r === 1;
    return pile[pile.length - 1].r === card.r - 1;
  }

  function drawFromStock() {
    var i, c, n;
    if (state.stock.length === 0) {
      if (state.waste.length === 0) return false;
      var recycled = state.waste.splice(0).reverse();
      for (i = 0; i < recycled.length; i++) {
        recycled[i].up = false;
      }
      state.stock = recycled;
      return true;
    }
    n = Math.min(state.draw, state.stock.length);
    for (i = 0; i < n; i++) {
      c = state.stock.pop();
      c.up = true;
      state.waste.push(c);
    }
    return true;
  }

  /* ---------------- Undo & persistence ---------------- */

  function snapshot() {
    return JSON.stringify({
      stock: state.stock,
      waste: state.waste,
      f: state.f,
      t: state.t,
      moves: state.moves
    });
  }

  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > UNDO_LIMIT) {
      undoStack.shift();
    }
  }

  function undo() {
    if (undoStack.length === 0 || state.won) return;
    var snap = JSON.parse(undoStack.pop());
    state.stock = snap.stock;
    state.waste = snap.waste;
    state.f = snap.f;
    state.t = snap.t;
    state.moves = snap.moves;
    save();
    render();
  }

  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        state: state,
        undo: undoStack.slice(-60)
      }));
    } catch (err) {
      // Storage may be full or unavailable; the game keeps running in memory.
    }
  }

  function load() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      var st = data.state;
      if (!st || !st.order || st.order.length !== 52 || !st.t || st.t.length !== 7) {
        return false;
      }
      var count = st.stock.length + st.waste.length;
      var i;
      for (i = 0; i < 4; i++) count += st.f[i].length;
      for (i = 0; i < 7; i++) count += st.t[i].length;
      if (count !== 52) return false;
      state = st;
      undoStack = Array.isArray(data.undo) ? data.undo : [];
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ---------------- Moves ---------------- */

  function removeFromSource(src) {
    // src: { p: 's'|'w'|'f'|'t', pi: number, ci: number }
    if (src.p === 'w') {
      return [state.waste.pop()];
    }
    if (src.p === 'f') {
      return [state.f[src.pi].pop()];
    }
    return state.t[src.pi].splice(src.ci);
  }

  function afterMove() {
    var col, i;
    for (i = 0; i < 7; i++) {
      col = state.t[i];
      if (col.length && !col[col.length - 1].up) {
        col[col.length - 1].up = true;
      }
    }
    state.moves += 1;
    save();
    render();
    checkWin();
  }

  function applyMove(src, dest) {
    // dest: { p: 'f'|'t', pi: number }
    pushUndo();
    var cards = removeFromSource(src);
    if (dest.p === 'f') {
      state.f[dest.pi].push(cards[0]);
    } else {
      Array.prototype.push.apply(state.t[dest.pi], cards);
    }
    afterMove();
  }

  function findAutoDest(cards, src) {
    var card = cards[0];
    var i;
    if (cards.length === 1 && src.p !== 'f' && canPlaceOnFoundation(card, card.s)) {
      return { p: 'f', pi: card.s };
    }
    // Prefer landing on an existing sequence over an empty column.
    for (i = 0; i < 7; i++) {
      if (src.p === 't' && src.pi === i) continue;
      if (state.t[i].length > 0 && canPlaceOnTableau(card, state.t[i])) {
        return { p: 't', pi: i };
      }
    }
    for (i = 0; i < 7; i++) {
      if (src.p === 't' && src.pi === i) continue;
      if (state.t[i].length === 0 && canPlaceOnTableau(card, state.t[i])) {
        // Moving a bare king from one empty-rooted position to another empty
        // column achieves nothing; skip that case.
        if (src.p === 't' && src.ci === 0 && cards[0].r === 13) continue;
        return { p: 't', pi: i };
      }
    }
    return null;
  }

  function grabbableCards(src) {
    if (src.p === 'w') {
      if (state.waste.length === 0 || src.ci !== state.waste.length - 1) return null;
      return [state.waste[src.ci]];
    }
    if (src.p === 'f') {
      var pile = state.f[src.pi];
      if (pile.length === 0 || src.ci !== pile.length - 1) return null;
      return [pile[src.ci]];
    }
    if (src.p === 't') {
      var col = state.t[src.pi];
      if (!col[src.ci] || !col[src.ci].up) return null;
      return col.slice(src.ci);
    }
    return null;
  }

  /* ---------------- Rendering ---------------- */

  function makeCardEl(card, src) {
    var el = document.createElement('div');
    el.className = 'card ' + (card.up ? 'faceup ' + (isRed(card) ? 'red' : 'black') : 'facedown');
    if (card.up) {
      var corner = document.createElement('div');
      corner.className = 'corner';
      var rank = document.createElement('span');
      rank.textContent = RANK_TEXT[card.r];
      var suitSmall = document.createElement('span');
      suitSmall.className = 'suit-small';
      suitSmall.textContent = SUIT_GLYPHS[card.s];
      corner.appendChild(rank);
      corner.appendChild(suitSmall);
      var pip = document.createElement('div');
      pip.className = 'pip';
      pip.textContent = SUIT_GLYPHS[card.s];
      el.appendChild(corner);
      el.appendChild(pip);
    }
    if (src) {
      el.dataset.p = src.p;
      el.dataset.pi = String(src.pi);
      el.dataset.ci = String(src.ci);
    }
    return el;
  }

  function makeSlot(glyph, recycle) {
    var el = document.createElement('div');
    el.className = 'slot' + (recycle ? ' recycle' : '');
    el.textContent = glyph || '';
    return el;
  }

  function render() {
    var i, j, el, card;
    var cw = els.stock.getBoundingClientRect().width || 48;
    var ch = cw * 1.42;

    // Stock
    els.stock.innerHTML = '';
    if (state.stock.length > 0) {
      el = makeCardEl(state.stock[state.stock.length - 1], { p: 's', pi: 0, ci: 0 });
      els.stock.appendChild(el);
      var badge = document.createElement('div');
      badge.className = 'stack-count';
      badge.textContent = String(state.stock.length);
      els.stock.appendChild(badge);
    } else {
      els.stock.appendChild(makeSlot(state.waste.length ? '\u27F3' : '', state.waste.length > 0));
    }

    // Waste (fan up to 3 when in Draw 3 mode)
    els.waste.innerHTML = '';
    if (state.waste.length === 0) {
      els.waste.appendChild(makeSlot(''));
    } else {
      var visible = state.draw === 3 ? Math.min(3, state.waste.length) : 1;
      var fan = Math.round(cw * 0.32);
      for (i = state.waste.length - visible; i < state.waste.length; i++) {
        card = state.waste[i];
        el = makeCardEl(card, { p: 'w', pi: 0, ci: i });
        var slotIndex = i - (state.waste.length - visible);
        el.style.left = (slotIndex * fan) + 'px';
        if (i !== state.waste.length - 1) {
          el.style.pointerEvents = 'none';
        }
        els.waste.appendChild(el);
      }
    }

    // Foundations
    for (i = 0; i < 4; i++) {
      els.foundations[i].innerHTML = '';
      var fpile = state.f[i];
      if (fpile.length === 0) {
        els.foundations[i].appendChild(makeSlot(SUIT_GLYPHS[i]));
      } else {
        el = makeCardEl(fpile[fpile.length - 1], { p: 'f', pi: i, ci: fpile.length - 1 });
        els.foundations[i].appendChild(el);
      }
    }

    // Tableau
    var areaH = els.tableaus[0].getBoundingClientRect().height || (ch * 4);
    for (i = 0; i < 7; i++) {
      var colEl = els.tableaus[i];
      colEl.innerHTML = '';
      var col = state.t[i];
      if (col.length === 0) {
        colEl.appendChild(makeSlot(''));
        continue;
      }
      var nDown = 0;
      var nUp = 0;
      for (j = 0; j < col.length; j++) {
        if (col[j].up) nUp++; else nDown++;
      }
      var downOff = Math.round(ch * 0.16);
      var upOff = Math.round(ch * 0.3);
      var needed = nDown * downOff + Math.max(0, nUp - 1) * upOff + ch;
      if (needed > areaH) {
        var scale = (areaH - ch) / (needed - ch);
        downOff = Math.max(4, Math.floor(downOff * scale));
        upOff = Math.max(Math.round(cw * 0.36), Math.floor(upOff * scale));
        // Recompute with the enforced minimum readable face-up offset.
        needed = nDown * downOff + Math.max(0, nUp - 1) * upOff + ch;
        if (needed > areaH) {
          downOff = Math.max(3, Math.floor((areaH - ch - Math.max(0, nUp - 1) * upOff) / Math.max(1, nDown)));
        }
      }
      var y = 0;
      for (j = 0; j < col.length; j++) {
        card = col[j];
        el = makeCardEl(card, { p: 't', pi: i, ci: j });
        el.style.top = y + 'px';
        el.style.zIndex = String(j + 1);
        colEl.appendChild(el);
        y += card.up ? upOff : downOff;
      }
    }

    // HUD
    els.hudMoves.textContent = state.moves + (state.moves === 1 ? ' move' : ' moves');
    els.hudTime.textContent = formatTime(state.time);
    els.btnUndo.disabled = undoStack.length === 0 || state.won;
    var drawLabel = els.btnDraw.querySelector('.btn-label');
    if (drawLabel) {
      drawLabel.textContent = 'Draw ' + state.draw;
    } else {
      els.btnDraw.textContent = 'Draw ' + state.draw;
    }
  }

  function formatTime(sec) {
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ---------------- Win ---------------- */

  function checkWin() {
    if (state.won) return;
    for (var i = 0; i < 4; i++) {
      if (state.f[i].length !== 13) return;
    }
    state.won = true;
    save();
    showWin();
  }

  function showWin() {
    els.winStats.textContent = state.moves + ' moves \u00B7 ' + formatTime(state.time);
    els.winOverlay.classList.remove('hidden');
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      runCascade();
    }
  }

  function hideWin() {
    els.winOverlay.classList.add('hidden');
  }

  function clearFx() {
    fxRunning = false;
    els.fxLayer.innerHTML = '';
  }

  function runCascade() {
    fxRunning = true;
    var particles = [];
    var floor = window.innerHeight - 4;
    var spawnRank = 13;
    var spawnSuit = 0;
    var lastSpawn = 0;
    var rects = els.foundations.map(function (f) {
      return f.getBoundingClientRect();
    });

    function spawn(now) {
      if (spawnRank < 1) return;
      var rect = rects[spawnSuit];
      var card = { s: spawnSuit, r: spawnRank, up: true };
      var el = makeCardEl(card, null);
      el.style.position = 'absolute';
      el.style.left = '0';
      el.style.top = '0';
      els.fxLayer.appendChild(el);
      particles.push({
        el: el,
        x: rect.left,
        y: rect.top,
        vx: (Math.random() * 5 + 2.5) * (Math.random() < 0.5 ? -1 : 1),
        vy: -(Math.random() * 6 + 2)
      });
      spawnSuit = (spawnSuit + 1) % 4;
      if (spawnSuit === 0) spawnRank -= 1;
      lastSpawn = now;
    }

    function step(now) {
      if (!fxRunning) return;
      if (now - lastSpawn > 90) spawn(now);
      var alive = false;
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        if (!p.el) continue;
        p.vy += 0.55;
        p.x += p.vx;
        p.y += p.vy;
        var chNow = p.el.offsetHeight || 70;
        if (p.y + chNow > floor && p.vy > 0) {
          p.y = floor - chNow;
          p.vy = -p.vy * 0.72;
        }
        if (p.x < -120 || p.x > window.innerWidth + 120) {
          p.el.remove();
          p.el = null;
          continue;
        }
        p.el.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px)';
        alive = true;
      }
      if (alive || spawnRank >= 1) {
        requestAnimationFrame(step);
      } else {
        clearFx();
      }
    }

    requestAnimationFrame(step);
  }

  /* ---------------- Pointer input (drag + tap) ---------------- */

  var DRAG_THRESHOLD = 8;

  function sourceFromEl(el) {
    if (!el || !el.dataset || el.dataset.p === undefined) return null;
    return {
      p: el.dataset.p,
      pi: parseInt(el.dataset.pi || '0', 10),
      ci: parseInt(el.dataset.ci || '0', 10)
    };
  }

  function onPointerDown(e) {
    if (state.won || fxRunning || drag) return;
    if (e.target.closest('#hud') || e.target.closest('#win-overlay')) return;

    var cardEl = e.target.closest('.card');
    var pileEl = e.target.closest('.pile');
    if (!cardEl && !pileEl) return;

    var src = null;
    var cards = null;

    if (cardEl) {
      src = sourceFromEl(cardEl);
    } else {
      src = sourceFromEl(pileEl);
      if (src) src.ci = -1;
    }
    if (!src) return;

    if (src.p !== 's' && src.ci >= 0) {
      cards = grabbableCards(src);
    }

    drag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      curX: e.clientX,
      curY: e.clientY,
      src: src,
      cards: cards,
      dragging: false,
      originEls: [],
      cloneRects: []
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }

  function collectOriginEls(src) {
    var out = [];
    var nodes, i, s;
    if (src.p === 'w') {
      nodes = els.waste.querySelectorAll('.card');
    } else if (src.p === 'f') {
      nodes = els.foundations[src.pi].querySelectorAll('.card');
    } else {
      nodes = els.tableaus[src.pi].querySelectorAll('.card');
    }
    for (i = 0; i < nodes.length; i++) {
      s = sourceFromEl(nodes[i]);
      if (s && s.ci >= src.ci) out.push(nodes[i]);
    }
    return out;
  }

  function startDrag() {
    var i, orig, rect, clone;
    drag.originEls = collectOriginEls(drag.src);
    els.dragLayer.innerHTML = '';
    for (i = 0; i < drag.originEls.length; i++) {
      orig = drag.originEls[i];
      rect = orig.getBoundingClientRect();
      clone = orig.cloneNode(true);
      clone.style.left = rect.left + 'px';
      clone.style.top = rect.top + 'px';
      clone.style.position = 'absolute';
      clone.style.zIndex = String(100 + i);
      els.dragLayer.appendChild(clone);
      orig.classList.add('drag-hidden');
      if (i === 0) {
        drag.baseRect = rect;
      }
    }
    drag.dragging = true;
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.curX = e.clientX;
    drag.curY = e.clientY;
    var dx = drag.curX - drag.startX;
    var dy = drag.curY - drag.startY;
    if (!drag.dragging) {
      if (drag.cards && (dx * dx + dy * dy) > DRAG_THRESHOLD * DRAG_THRESHOLD) {
        startDrag();
      } else {
        return;
      }
    }
    els.dragLayer.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
  }

  function endPointer() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    els.dragLayer.innerHTML = '';
    els.dragLayer.style.transform = '';
    drag = null;
  }

  function onPointerCancel(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    endPointer();
    render();
  }

  function overlapArea(a, b) {
    var x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    var y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return x > 0 && y > 0 ? x * y : 0;
  }

  function resolveDrop() {
    var dx = drag.curX - drag.startX;
    var dy = drag.curY - drag.startY;
    var moved = {
      left: drag.baseRect.left + dx,
      right: drag.baseRect.right + dx,
      top: drag.baseRect.top + dy,
      bottom: drag.baseRect.bottom + dy
    };
    var best = null;
    var bestArea = 0;
    var i, rect, area;

    if (drag.cards.length === 1) {
      for (i = 0; i < 4; i++) {
        rect = els.foundations[i].getBoundingClientRect();
        area = overlapArea(moved, rect);
        if (area > bestArea && canPlaceOnFoundation(drag.cards[0], i) && drag.src.p !== 'f') {
          bestArea = area;
          best = { p: 'f', pi: i };
        }
      }
    }

    var boardRect = els.board.getBoundingClientRect();
    for (i = 0; i < 7; i++) {
      if (drag.src.p === 't' && drag.src.pi === i) continue;
      rect = els.tableaus[i].getBoundingClientRect();
      var zone = { left: rect.left, right: rect.right, top: rect.top, bottom: boardRect.bottom };
      area = overlapArea(moved, zone);
      if (area > bestArea && canPlaceOnTableau(drag.cards[0], state.t[i])) {
        bestArea = area;
        best = { p: 't', pi: i };
      }
    }
    return best;
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    var wasDragging = drag.dragging;
    var src = drag.src;
    var cards = drag.cards;
    var dest = null;

    if (wasDragging) {
      dest = resolveDrop();
    }
    endPointer();

    if (wasDragging) {
      if (dest) {
        applyMove(src, dest);
      } else {
        render();
      }
      return;
    }

    // Tap behavior
    if (src.p === 's') {
      pushUndo();
      if (drawFromStock()) {
        afterMove();
      } else {
        undoStack.pop();
      }
      return;
    }
    if (!cards) {
      // Tapping an exposed face-down top card flips it (defensive; normally auto-flipped).
      if (src.p === 't' && src.ci >= 0) {
        var col = state.t[src.pi];
        if (src.ci === col.length - 1 && col[src.ci] && !col[src.ci].up) {
          pushUndo();
          col[src.ci].up = true;
          afterMove();
        }
      }
      return;
    }
    var auto = findAutoDest(cards, src);
    if (auto) {
      applyMove(src, auto);
    }
  }

  /* ---------------- Timer ---------------- */

  function startTimer() {
    if (timerId) return;
    timerId = setInterval(function () {
      if (!state || state.won || document.visibilityState !== 'visible') return;
      state.time += 1;
      els.hudTime.textContent = formatTime(state.time);
      if (state.time % 10 === 0) save();
    }, 1000);
  }

  /* ---------------- Global event wiring ---------------- */

  function preventDefaults() {
    document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
    document.addEventListener('gesturechange', function (e) { e.preventDefault(); });
    document.addEventListener('dblclick', function (e) { e.preventDefault(); });
    document.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    var lastTouchEnd = 0;
    document.addEventListener('touchend', function (e) {
      var now = Date.now();
      if (now - lastTouchEnd < 300) e.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });
  }

  function init() {
    preventDefaults();

    if (!load()) {
      state = dealFromOrder(shuffledOrder(), 1);
      undoStack = [];
      save();
    }

    render();
    startTimer();

    if (state.won) {
      showWin();
    }

    els.board.addEventListener('pointerdown', onPointerDown);

    els.btnNew.addEventListener('click', newGame);
    els.btnWinNew.addEventListener('click', newGame);
    els.btnRestart.addEventListener('click', restartGame);
    els.btnUndo.addEventListener('click', undo);
    els.btnDraw.addEventListener('click', function () {
      state.draw = state.draw === 1 ? 3 : 1;
      save();
      render();
    });

    window.addEventListener('resize', function () {
      render();
    });
    window.addEventListener('orientationchange', function () {
      setTimeout(render, 250);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') save();
    });
    window.addEventListener('pagehide', save);
  }

  init();

})();
