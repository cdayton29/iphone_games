/* ===========================================================
   SOLITAIRE — Klondike, draw one.
   Tap a card to pick it up, tap a pile to drop it.
   Double-tap sends a card home to the foundations.
   =========================================================== */

(function () {
  'use strict';

  /* ---------- shared with the hub ---------- */

  const params = new URLSearchParams(location.search);
  const setTheme = (t) => { document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark'; };
  setTheme(params.get('theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  addEventListener('message', (e) => { if (e.data?.type === 'theme') setTheme(e.data.theme); });

  ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) =>
    document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
  document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ---------- constants ---------- */

  const SUITS = ['♠', '♥', '♣', '♦'];
  const RED = new Set([1, 3]);
  const LABEL = [, 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  const board = document.getElementById('board');
  const els = {
    time: document.getElementById('stat-time'),
    moves: document.getElementById('stat-moves'),
    undo: document.getElementById('btn-undo'),
    auto: document.getElementById('btn-auto'),
    deal: document.getElementById('btn-new'),
    again: document.getElementById('btn-again'),
    win: document.getElementById('win'),
    winStats: document.getElementById('win-stats'),
  };

  /* ---------- state ---------- */

  // deck[id] = { id, rank, suit, up }
  let deck = [];
  let piles = {};        // stock, waste, foundation0-3, tableau0-6 → arrays of card ids
  let picked = null;     // { pile, index } — the card and everything above it
  let history = [];
  let moves = 0;
  let started = 0;
  let elapsed = 0;
  let running = false;
  let lastTapId = null;
  let lastTapAt = 0;

  const geom = { cw: 46, ch: 65, gap: 5, padX: 8, topY: 0, tabY: 0, downStep: 8, upStep: 14 };
  const nodes = new Map();   // card id → element
  const slots = new Map();   // pile key → element

  /* ---------- layout ---------- */

  function measure() {
    const W = board.clientWidth;
    const H = board.clientHeight;

    geom.gap = Math.max(4, Math.round(W * 0.014));
    geom.padX = Math.max(6, Math.round(W * 0.02));
    geom.cw = Math.floor((W - geom.padX * 2 - geom.gap * 6) / 7);
    geom.ch = Math.round(geom.cw * 1.42);
    geom.topY = Math.round(H * 0.012);
    geom.tabY = geom.topY + geom.ch + Math.round(H * 0.028);
    geom.downStep = Math.round(geom.ch * 0.15);
    geom.upStep = Math.round(geom.ch * 0.26);
    geom.tabH = H - geom.tabY - 6;

    document.documentElement.style.setProperty('--cw', geom.cw + 'px');
    document.documentElement.style.setProperty('--ch', geom.ch + 'px');
  }

  const colX = (i) => geom.padX + i * (geom.cw + geom.gap);

  /** Where does every card in a pile sit, and how tall is the pile? */
  function pileLayout(key) {
    const ids = piles[key];

    if (key === 'stock')  return { x: colX(0), y: geom.topY, step: 0 };
    if (key === 'waste')  return { x: colX(1), y: geom.topY, step: 0 };
    if (key.startsWith('foundation')) return { x: colX(3 + +key.slice(10)), y: geom.topY, step: 0 };

    // tableau: squeeze the fan so the longest pile still fits on screen
    const i = +key.slice(7);
    const down = ids.filter((id) => !deck[id].up).length;
    const up = ids.length - down;
    let downStep = geom.downStep;
    let upStep = geom.upStep;

    const needed = () => down * downStep + Math.max(0, up - 1) * upStep + geom.ch;
    if (needed() > geom.tabH && ids.length > 1) {
      const room = Math.max(20, geom.tabH - geom.ch);
      const units = down * 0.58 + Math.max(0, up - 1);
      upStep = Math.max(9, Math.floor(room / Math.max(1, units)));
      downStep = Math.max(4, Math.round(upStep * 0.58));
    }
    return { x: colX(i), y: geom.tabY, step: upStep, downStep };
  }

  function cardOffset(key, index) {
    const L = pileLayout(key);
    if (!key.startsWith('tableau')) return { x: L.x, y: L.y };
    let y = L.y;
    for (let i = 0; i < index; i++) y += deck[piles[key][i]].up ? L.step : L.downStep;
    return { x: L.x, y };
  }

  /* ---------- build the table once ---------- */

  function buildSlots() {
    board.textContent = '';
    slots.clear();
    nodes.clear();

    const make = (key, ghost, cls) => {
      const el = document.createElement('div');
      el.className = 'slot' + (cls ? ' ' + cls : '');
      el.dataset.pile = key;
      if (ghost) {
        const g = document.createElement('span');
        g.className = 'ghost';
        g.textContent = ghost;
        el.append(g);
      }
      board.append(el);
      slots.set(key, el);
    };

    make('stock', '↺', 'recycle');
    make('waste', '');
    for (let f = 0; f < 4; f++) make('foundation' + f, SUITS[f]);
    for (let t = 0; t < 7; t++) make('tableau' + t, '');

    for (const card of deck) {
      const el = document.createElement('div');
      el.className = 'card';
      el.dataset.id = card.id;
      el.innerHTML =
        `<span class="corner">${LABEL[card.rank]}<small>${SUITS[card.suit]}</small></span>` +
        `<span class="pip">${SUITS[card.suit]}</span>`;
      board.append(el);
      nodes.set(card.id, el);
    }
  }

  /* ---------- render ---------- */

  function render() {
    for (const [key, el] of slots) {
      const L = pileLayout(key);
      el.style.transform = `translate3d(${L.x}px, ${L.y}px, 0)`;
      if (key === 'stock') el.classList.toggle('recycle', piles.stock.length === 0);
    }

    let z = 10;
    for (const key of Object.keys(piles)) {
      piles[key].forEach((id, index) => {
        const card = deck[id];
        const el = nodes.get(id);
        const { x, y } = cardOffset(key, index);
        el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        el.style.zIndex = ++z;
        el.classList.toggle('down', !card.up);
        el.classList.toggle('red', RED.has(card.suit));
        el.classList.toggle('picked',
          !!picked && picked.pile === key && index >= picked.index);
      });
    }

    els.undo.disabled = history.length === 0;
    els.moves.textContent = `${moves} move${moves === 1 ? '' : 's'}`;
  }

  /* ---------- rules ---------- */

  const top = (key) => piles[key][piles[key].length - 1];
  const topCard = (key) => { const id = top(key); return id === undefined ? null : deck[id]; };

  function canDropOnFoundation(card, key) {
    const t = topCard(key);
    if (!t) return card.rank === 1 && +key.slice(10) === card.suit;
    return t.suit === card.suit && card.rank === t.rank + 1;
  }

  function canDropOnTableau(card, key) {
    const t = topCard(key);
    if (!t) return card.rank === 13;
    if (!t.up) return false;
    return RED.has(card.suit) !== RED.has(t.suit) && card.rank === t.rank - 1;
  }

  function canDrop(cards, key) {
    if (key.startsWith('foundation')) return cards.length === 1 && canDropOnFoundation(cards[0], key);
    if (key.startsWith('tableau')) return canDropOnTableau(cards[0], key);
    return false;
  }

  /* ---------- moving ---------- */

  function snapshot() {
    history.push({
      piles: JSON.parse(JSON.stringify(piles)),
      up: deck.map((c) => c.up),
      moves,
    });
    if (history.length > 200) history.shift();
  }

  function move(from, index, to) {
    snapshot();
    const taken = piles[from].splice(index);
    piles[to].push(...taken);

    // expose whatever was underneath
    const under = topCard(from);
    if (under && !under.up) under.up = true;

    moves++;
    picked = null;
    render();
    checkWin();
  }

  function undo() {
    const prev = history.pop();
    if (!prev) return;
    piles = prev.piles;
    prev.up.forEach((up, i) => { deck[i].up = up; });
    moves = prev.moves;
    picked = null;
    render();
  }

  function drawFromStock() {
    snapshot();
    if (piles.stock.length) {
      const id = piles.stock.pop();
      deck[id].up = true;
      piles.waste.push(id);
    } else if (piles.waste.length) {
      while (piles.waste.length) {
        const id = piles.waste.pop();
        deck[id].up = false;
        piles.stock.push(id);
      }
    } else {
      history.pop();
      return;
    }
    moves++;
    picked = null;
    render();
  }

  /** Send one card straight home if a foundation will take it. */
  function sendHome(from, index) {
    if (index !== piles[from].length - 1) return false;
    const card = deck[piles[from][index]];
    for (let f = 0; f < 4; f++) {
      const key = 'foundation' + f;
      if (canDropOnFoundation(card, key)) { move(from, index, key); return true; }
    }
    return false;
  }

  /** "Collect": pull up every card that cannot possibly be needed below. */
  function collect() {
    const sources = ['waste', ...Array.from({ length: 7 }, (_, i) => 'tableau' + i)];
    let any = false;

    for (let pass = 0; pass < 60; pass++) {
      let did = false;
      for (const key of sources) {
        const card = topCard(key);
        if (!card || !card.up) continue;

        const home = ['foundation0', 'foundation1', 'foundation2', 'foundation3']
          .find((f) => canDropOnFoundation(card, f));
        if (!home) continue;

        const heights = [0, 1, 2, 3].map((f) => piles['foundation' + f].length);
        const opposite = [0, 1, 2, 3].filter((s) => RED.has(s) !== RED.has(card.suit));
        const floor = Math.min(...opposite.map((s) => heights[s]));
        const safe = card.rank <= 2 || card.rank <= floor + 1;
        if (!safe) continue;

        move(key, piles[key].length - 1, home);
        did = any = true;
      }
      if (!did) break;
    }
    if (!any) flashNothing();
  }

  function flashNothing() {
    els.auto.animate(
      [{ opacity: 1 }, { opacity: .35 }, { opacity: 1 }],
      { duration: 380 }
    );
  }

  /* ---------- input ---------- */

  function pileOf(id) {
    for (const key of Object.keys(piles)) {
      const index = piles[key].indexOf(id);
      if (index !== -1) return { key, index };
    }
    return null;
  }

  /** A face-up run can only be lifted if it descends in alternating colours. */
  function liftable(key, index) {
    const ids = piles[key];
    if (!deck[ids[index]].up) return false;
    for (let i = index; i < ids.length - 1; i++) {
      const a = deck[ids[i]], b = deck[ids[i + 1]];
      if (!b.up || a.rank !== b.rank + 1 || RED.has(a.suit) === RED.has(b.suit)) return false;
    }
    return true;
  }

  board.addEventListener('click', (e) => {
    if (!els.win.hidden) return;
    startClock();

    const cardEl = e.target.closest('.card');
    const slotEl = e.target.closest('.slot');

    /* --- tapped a card --- */
    if (cardEl) {
      const id = +cardEl.dataset.id;
      const at = pileOf(id);
      if (!at) return;

      if (at.key === 'stock') { drawFromStock(); return; }

      // double-tap → straight to the foundations
      const now = Date.now();
      if (lastTapId === id && now - lastTapAt < 320) {
        lastTapId = null;
        if (sendHome(at.key, at.index)) return;
      }
      lastTapId = id;
      lastTapAt = now;

      // a picked card can be dropped onto the tapped card's pile
      if (picked && picked.pile !== at.key) {
        const cards = piles[picked.pile].slice(picked.index).map((c) => deck[c]);
        if (canDrop(cards, at.key)) { move(picked.pile, picked.index, at.key); return; }
      }

      if (!deck[id].up) return;
      if (at.key === 'waste' && at.index !== piles.waste.length - 1) return;
      if (at.key.startsWith('foundation') && at.index !== piles[at.key].length - 1) return;
      if (at.key.startsWith('tableau') && !liftable(at.key, at.index)) return;

      const same = picked && picked.pile === at.key && picked.index === at.index;
      picked = same ? null : { pile: at.key, index: at.index };
      render();
      return;
    }

    /* --- tapped an empty slot --- */
    if (slotEl) {
      const key = slotEl.dataset.pile;
      if (key === 'stock') { drawFromStock(); return; }
      if (picked && picked.pile !== key) {
        const cards = piles[picked.pile].slice(picked.index).map((c) => deck[c]);
        if (canDrop(cards, key)) { move(picked.pile, picked.index, key); return; }
      }
      picked = null;
      render();
      return;
    }

    picked = null;
    render();
  });

  /* ---------- clock ---------- */

  function startClock() {
    if (running) return;
    running = true;
    started = Date.now();
  }

  function tick() {
    const total = elapsed + (running ? Date.now() - started : 0);
    const s = Math.floor(total / 1000);
    els.time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  setInterval(tick, 500);

  function stopClock() {
    if (!running) return;
    elapsed += Date.now() - started;
    running = false;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopClock();
    else if (moves > 0 && els.win.hidden) startClock();
  });

  /* ---------- win ---------- */

  function checkWin() {
    const done = [0, 1, 2, 3].every((f) => piles['foundation' + f].length === 13);
    if (!done) return;
    stopClock();
    els.winStats.textContent = `${els.time.textContent} · ${moves} moves`;
    els.win.hidden = false;
  }

  /* ---------- new deal ---------- */

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function deal() {
    deck = [];
    for (let suit = 0; suit < 4; suit++)
      for (let rank = 1; rank <= 13; rank++)
        deck.push({ id: deck.length, rank, suit, up: false });

    const order = shuffle(deck.map((c) => c.id));

    piles = { stock: [], waste: [] };
    for (let f = 0; f < 4; f++) piles['foundation' + f] = [];
    for (let t = 0; t < 7; t++) piles['tableau' + t] = [];

    let k = 0;
    for (let t = 0; t < 7; t++) {
      for (let n = 0; n <= t; n++) {
        const id = order[k++];
        deck[id].up = n === t;
        piles['tableau' + t].push(id);
      }
    }
    while (k < order.length) piles.stock.push(order[k++]);

    picked = null;
    history = [];
    moves = 0;
    elapsed = 0;
    running = false;
    els.win.hidden = true;
    els.time.textContent = '0:00';

    measure();
    buildSlots();
    render();
  }

  /* ---------- wiring ---------- */

  els.deal.addEventListener('click', deal);
  els.again.addEventListener('click', deal);
  els.undo.addEventListener('click', undo);
  els.auto.addEventListener('click', () => { startClock(); collect(); });

  let resizeTimer;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { measure(); render(); }, 120);
  });

  deal();
})();
