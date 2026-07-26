/* ===========================================================
   SUDOKU — generated fresh each deal, always one solution.
   Tap a cell, tap a number. Notes mode writes pencil marks.
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

  /* ---------- elements ---------- */

  const gridEl = document.getElementById('grid');
  const digitsEl = document.getElementById('digits');
  const els = {
    time: document.getElementById('stat-time'),
    diff: document.getElementById('stat-diff'),
    check: document.getElementById('btn-check'),
    fresh: document.getElementById('btn-new'),
    notes: document.getElementById('btn-notes'),
    erase: document.getElementById('btn-erase'),
    undo: document.getElementById('btn-undo'),
    hint: document.getElementById('btn-hint'),
    picker: document.getElementById('picker'),
    cancel: document.getElementById('picker-cancel'),
    win: document.getElementById('win'),
    winStats: document.getElementById('win-stats'),
    again: document.getElementById('btn-again'),
  };

  /* ---------- solver: bitmask backtracking, most-constrained cell first ---------- */

  const ROW = (i) => (i / 9) | 0;
  const COL = (i) => i % 9;
  const BOX = (i) => ((i / 27) | 0) * 3 + (((i % 9) / 3) | 0);
  const BIT = (v) => 1 << (v - 1);

  /** Counts solutions up to `limit`. Also returns the first one found. */
  function solve(cells, limit) {
    const rows = new Int32Array(9), cols = new Int32Array(9), boxes = new Int32Array(9);
    const grid = Int8Array.from(cells);

    for (let i = 0; i < 81; i++) {
      const v = grid[i];
      if (!v) continue;
      const b = BIT(v);
      if (rows[ROW(i)] & b || cols[COL(i)] & b || boxes[BOX(i)] & b) return { count: 0, solution: null };
      rows[ROW(i)] |= b; cols[COL(i)] |= b; boxes[BOX(i)] |= b;
    }

    let count = 0;
    let solution = null;

    (function step() {
      if (count >= limit) return;

      let best = -1, bestMask = 0, bestCount = 10;
      for (let i = 0; i < 81; i++) {
        if (grid[i]) continue;
        const used = rows[ROW(i)] | cols[COL(i)] | boxes[BOX(i)];
        const free = ~used & 0x1ff;
        let n = 0;
        for (let m = free; m; m &= m - 1) n++;
        if (n === 0) return;
        if (n < bestCount) { bestCount = n; best = i; bestMask = free; if (n === 1) break; }
      }

      if (best === -1) {                       // every cell filled
        count++;
        if (!solution) solution = Array.from(grid);
        return;
      }

      for (let v = 1; v <= 9; v++) {
        const b = BIT(v);
        if (!(bestMask & b)) continue;
        grid[best] = v;
        rows[ROW(best)] |= b; cols[COL(best)] |= b; boxes[BOX(best)] |= b;
        step();
        grid[best] = 0;
        rows[ROW(best)] &= ~b; cols[COL(best)] &= ~b; boxes[BOX(best)] &= ~b;
        if (count >= limit) return;
      }
    })();

    return { count, solution };
  }

  /* ---------- generator ---------- */

  function shuffled(a) {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function fullGrid() {
    const grid = new Array(81).fill(0);
    const rows = new Int32Array(9), cols = new Int32Array(9), boxes = new Int32Array(9);

    (function fill(i) {
      if (i === 81) return true;
      for (const v of shuffled([1, 2, 3, 4, 5, 6, 7, 8, 9])) {
        const b = BIT(v);
        if (rows[ROW(i)] & b || cols[COL(i)] & b || boxes[BOX(i)] & b) continue;
        grid[i] = v;
        rows[ROW(i)] |= b; cols[COL(i)] |= b; boxes[BOX(i)] |= b;
        if (fill(i + 1)) return true;
        grid[i] = 0;
        rows[ROW(i)] &= ~b; cols[COL(i)] &= ~b; boxes[BOX(i)] &= ~b;
      }
      return false;
    })(0);

    return grid;
  }

  /** Remove clues in mirrored pairs, keeping the solution unique. */
  function carve(solution, targetClues) {
    const puzzle = solution.slice();
    let clues = 81;

    for (const i of shuffled([...Array(81).keys()])) {
      if (clues <= targetClues) break;
      const mirror = 80 - i;
      const pair = mirror === i ? [i] : [i, mirror];
      if (pair.some((p) => puzzle[p] === 0)) continue;
      if (clues - pair.length < targetClues) continue;

      const backup = pair.map((p) => puzzle[p]);
      pair.forEach((p) => { puzzle[p] = 0; });

      if (solve(puzzle, 2).count === 1) clues -= pair.length;
      else pair.forEach((p, k) => { puzzle[p] = backup[k]; });
    }

    return puzzle;
  }

  /* ---------- state ---------- */

  const LEVELS = { 46: 'Gentle', 38: 'Steady', 31: 'Tricky', 26: 'Severe' };

  let solution = [];
  let given = [];
  let values = [];
  let notes = [];        // bitmask per cell
  let hinted = new Set();
  let selected = null;
  let notesMode = false;
  let showWrong = false;
  let history = [];
  let elapsed = 0, started = 0, running = false;
  let cellEls = [];

  /* ---------- build ---------- */

  function buildGrid() {
    gridEl.textContent = '';
    cellEls = [];
    for (let i = 0; i < 81; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.i = i;
      cell.setAttribute('role', 'gridcell');
      if (COL(i) % 3 === 2 && COL(i) !== 8) cell.classList.add('br');
      if (ROW(i) % 3 === 2 && ROW(i) !== 8) cell.classList.add('bb');
      gridEl.append(cell);
      cellEls.push(cell);
    }
  }

  function buildPad() {
    digitsEl.textContent = '';
    for (let v = 1; v <= 9; v++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.v = v;
      b.innerHTML = `${v}<small data-count="${v}">9</small>`;
      digitsEl.append(b);
    }
  }

  function sizeGrid() {
    const stage = document.getElementById('stage');
    const size = Math.floor(Math.min(stage.clientWidth, stage.clientHeight) / 9) * 9;
    document.documentElement.style.setProperty('--size', Math.max(180, size) + 'px');
  }

  /* ---------- rendering ---------- */

  function peersOf(i) {
    const set = new Set();
    for (let k = 0; k < 9; k++) {
      set.add(ROW(i) * 9 + k);
      set.add(k * 9 + COL(i));
    }
    const r0 = Math.floor(ROW(i) / 3) * 3, c0 = Math.floor(COL(i) / 3) * 3;
    for (let r = r0; r < r0 + 3; r++) for (let c = c0; c < c0 + 3; c++) set.add(r * 9 + c);
    set.delete(i);
    return set;
  }

  function conflicts() {
    const bad = new Set();
    for (let i = 0; i < 81; i++) {
      const v = values[i];
      if (!v) continue;
      for (const p of peersOf(i)) if (values[p] === v) { bad.add(i); bad.add(p); }
    }
    return bad;
  }

  function render() {
    const bad = conflicts();
    const peers = selected === null ? new Set() : peersOf(selected);
    const focusValue = selected === null ? 0 : values[selected];

    for (let i = 0; i < 81; i++) {
      const cell = cellEls[i];
      const v = values[i];

      cell.className = 'cell'
        + (COL(i) % 3 === 2 && COL(i) !== 8 ? ' br' : '')
        + (ROW(i) % 3 === 2 && ROW(i) !== 8 ? ' bb' : '');

      if (given[i]) cell.classList.add('given');
      if (hinted.has(i)) cell.classList.add('hinted');
      if (bad.has(i) || (showWrong && v && v !== solution[i])) cell.classList.add('wrong');
      if (peers.has(i)) cell.classList.add('peer');
      if (focusValue && v === focusValue && i !== selected) cell.classList.add('twin');
      if (i === selected) cell.classList.add('sel');

      if (v) {
        cell.textContent = v;
      } else if (notes[i]) {
        cell.textContent = '';
        const box = document.createElement('div');
        box.className = 'notes';
        for (let n = 1; n <= 9; n++) {
          const s = document.createElement('span');
          s.textContent = notes[i] & BIT(n) ? n : '';
          box.append(s);
        }
        cell.append(box);
      } else {
        cell.textContent = '';
      }
    }

    // how many of each digit are still owed
    for (let v = 1; v <= 9; v++) {
      const placed = values.filter((x) => x === v).length;
      const btn = digitsEl.querySelector(`button[data-v="${v}"]`);
      btn.querySelector('small').textContent = Math.max(0, 9 - placed);
      btn.classList.toggle('done', placed >= 9);
    }

    els.undo.disabled = history.length === 0;
  }

  /* ---------- moves ---------- */

  function snapshot() {
    history.push({ values: values.slice(), notes: notes.slice(), hinted: new Set(hinted) });
    if (history.length > 300) history.shift();
  }

  function place(v) {
    if (selected === null || given[selected]) return;
    startClock();
    snapshot();

    if (notesMode) {
      if (values[selected]) values[selected] = 0;
      notes[selected] ^= BIT(v);
    } else {
      values[selected] = values[selected] === v ? 0 : v;
      notes[selected] = 0;
      hinted.delete(selected);
      if (values[selected]) {
        for (const p of peersOf(selected)) notes[p] &= ~BIT(v);   // tidy the pencil marks
      }
    }

    showWrong = false;
    render();
    checkWin();
  }

  function erase() {
    if (selected === null || given[selected]) return;
    snapshot();
    values[selected] = 0;
    notes[selected] = 0;
    hinted.delete(selected);
    showWrong = false;
    render();
  }

  function undo() {
    const prev = history.pop();
    if (!prev) return;
    values = prev.values;
    notes = prev.notes;
    hinted = prev.hinted;
    showWrong = false;
    render();
  }

  function hint() {
    const blanks = [];
    for (let i = 0; i < 81; i++) if (!given[i] && values[i] !== solution[i]) blanks.push(i);
    if (!blanks.length) return;

    const target = selected !== null && blanks.includes(selected)
      ? selected
      : blanks[Math.floor(Math.random() * blanks.length)];

    startClock();
    snapshot();
    values[target] = solution[target];
    notes[target] = 0;
    hinted.add(target);
    selected = target;
    for (const p of peersOf(target)) notes[p] &= ~BIT(solution[target]);
    showWrong = false;
    render();
    checkWin();
  }

  /* ---------- clock ---------- */

  function startClock() { if (!running) { running = true; started = Date.now(); } }
  function stopClock() { if (running) { elapsed += Date.now() - started; running = false; } }

  setInterval(() => {
    const s = Math.floor((elapsed + (running ? Date.now() - started : 0)) / 1000);
    els.time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopClock();
    else if (history.length && els.win.hidden) startClock();
  });

  /* ---------- win ---------- */

  function checkWin() {
    for (let i = 0; i < 81; i++) if (values[i] !== solution[i]) return;
    stopClock();
    selected = null;
    render();
    els.winStats.textContent = `${els.diff.textContent} · ${els.time.textContent}`;
    els.win.hidden = false;
  }

  /* ---------- input ---------- */

  gridEl.addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const i = +cell.dataset.i;
    selected = selected === i ? null : i;
    render();
  });

  digitsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) place(+btn.dataset.v);
  });

  els.notes.addEventListener('click', () => {
    notesMode = !notesMode;
    els.notes.setAttribute('aria-pressed', String(notesMode));
  });
  els.erase.addEventListener('click', erase);
  els.undo.addEventListener('click', undo);
  els.hint.addEventListener('click', hint);

  els.check.addEventListener('click', () => {
    showWrong = true;
    render();
    setTimeout(() => { showWrong = false; render(); }, 2200);
  });

  els.fresh.addEventListener('click', () => { els.picker.hidden = false; });
  els.cancel.addEventListener('click', () => { els.picker.hidden = true; });
  els.again.addEventListener('click', () => { els.win.hidden = true; els.picker.hidden = false; });

  els.picker.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-clues]');
    if (btn) newPuzzle(+btn.dataset.clues);
  });

  addEventListener('keydown', (e) => {
    if (e.key >= '1' && e.key <= '9') place(+e.key);
    if (e.key === 'Backspace' || e.key === 'Delete') erase();
    if (selected !== null) {
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -9, ArrowDown: 9 }[e.key];
      if (step) {
        selected = Math.max(0, Math.min(80, selected + step));
        render();
        e.preventDefault();
      }
    }
  });

  let resizeTimer;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(sizeGrid, 120);
  });

  /* ---------- new puzzle ---------- */

  function newPuzzle(clues) {
    els.picker.hidden = true;
    els.win.hidden = true;
    els.diff.textContent = LEVELS[clues] || `${clues} clues`;

    solution = fullGrid();
    const puzzle = carve(solution, clues);

    values = puzzle.slice();
    given = puzzle.map((v) => v !== 0);
    notes = new Array(81).fill(0);
    hinted = new Set();
    history = [];
    selected = null;
    notesMode = false;
    showWrong = false;
    els.notes.setAttribute('aria-pressed', 'false');
    elapsed = 0; running = false;
    els.time.textContent = '0:00';

    sizeGrid();
    render();
  }

  /* ---------- boot ---------- */

  buildGrid();
  buildPad();
  newPuzzle(38);
})();
