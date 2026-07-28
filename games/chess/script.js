/* ===========================================================
   CHESS — full rules, pass-and-play or against the computer.
   Board index 0 = a8, 63 = h1, so the array reads like the screen.
   =========================================================== */

(function () {
  'use strict';

  /* ===================== ENGINE START ===================== */

  const P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  const KNIGHT_D = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const BISHOP_D = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
  const ROOK_D = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const QUEEN_D = BISHOP_D.concat(ROOK_D);
  const KING_D = QUEEN_D;

  /* king destination -> [rook from, rook to] */
  const ROOK_HOP = { 62: [63, 61], 58: [56, 59], 6: [7, 5], 2: [0, 3] };

  /* castling rights that survive a piece touching each square */
  const CASTLE_MASK = new Int8Array(64).fill(15);
  CASTLE_MASK[60] = 15 & ~3; CASTLE_MASK[63] = 15 & ~1; CASTLE_MASK[56] = 15 & ~2;
  CASTLE_MASK[4] = 15 & ~12; CASTLE_MASK[7] = 15 & ~4; CASTLE_MASK[0] = 15 & ~8;

  const sq = (f, r) => r * 8 + f;
  const fileOf = (i) => i & 7;
  const rankOf = (i) => i >> 3;
  const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

  function fromFEN(fen) {
    const parts = fen.trim().split(/\s+/);
    const board = new Int8Array(64);
    let i = 0;
    for (const ch of parts[0]) {
      if (ch === '/') continue;
      if (ch >= '1' && ch <= '8') { i += +ch; continue; }
      const code = { p: P, n: N, b: B, r: R, q: Q, k: K }[ch.toLowerCase()];
      board[i++] = ch === ch.toUpperCase() ? code : -code;
    }
    const cast = parts[2] || '-';
    let ep = -1;
    if (parts[3] && parts[3] !== '-') {
      ep = sq(parts[3].charCodeAt(0) - 97, 8 - +parts[3][1]);
    }
    return {
      board,
      turn: parts[1] === 'b' ? -1 : 1,
      castle: (cast.includes('K') ? 1 : 0) | (cast.includes('Q') ? 2 : 0) |
              (cast.includes('k') ? 4 : 0) | (cast.includes('q') ? 8 : 0),
      ep,
      half: +(parts[4] || 0),
      full: +(parts[5] || 1),
    };
  }

  function toFEN(s) {
    let out = '';
    for (let r = 0; r < 8; r++) {
      let run = 0;
      for (let f = 0; f < 8; f++) {
        const pc = s.board[sq(f, r)];
        if (!pc) { run++; continue; }
        if (run) { out += run; run = 0; }
        const ch = ' pnbrqk'[Math.abs(pc)];
        out += pc > 0 ? ch.toUpperCase() : ch;
      }
      if (run) out += run;
      if (r < 7) out += '/';
    }
    let cast = (s.castle & 1 ? 'K' : '') + (s.castle & 2 ? 'Q' : '') +
               (s.castle & 4 ? 'k' : '') + (s.castle & 8 ? 'q' : '');
    const ep = s.ep < 0 ? '-' : 'abcdefgh'[fileOf(s.ep)] + (8 - rankOf(s.ep));
    return `${out} ${s.turn === 1 ? 'w' : 'b'} ${cast || '-'} ${ep} ${s.half} ${s.full}`;
  }

  function clone(s) {
    return { board: Int8Array.from(s.board), turn: s.turn, castle: s.castle, ep: s.ep, half: s.half, full: s.full };
  }

  /* ---------- attack detection ---------- */

  function isAttacked(s, target, by) {
    const b = s.board, f = fileOf(target), r = rankOf(target);

    /* pawns: an attacker sits one rank toward its own side */
    const pr = r + (by === 1 ? 1 : -1);
    if (pr >= 0 && pr < 8) {
      for (const df of [-1, 1]) {
        const nf = f + df;
        if (nf >= 0 && nf < 8 && b[sq(nf, pr)] === by * P) return true;
      }
    }

    for (const [df, dr] of KNIGHT_D) {
      const nf = f + df, nr = r + dr;
      if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
      if (b[sq(nf, nr)] === by * N) return true;
    }

    for (const [df, dr] of KING_D) {
      const nf = f + df, nr = r + dr;
      if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
      if (b[sq(nf, nr)] === by * K) return true;
    }

    for (const [df, dr] of BISHOP_D) {
      let nf = f + df, nr = r + dr;
      while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
        const pc = b[sq(nf, nr)];
        if (pc) { if (pc === by * B || pc === by * Q) return true; break; }
        nf += df; nr += dr;
      }
    }

    for (const [df, dr] of ROOK_D) {
      let nf = f + df, nr = r + dr;
      while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
        const pc = b[sq(nf, nr)];
        if (pc) { if (pc === by * R || pc === by * Q) return true; break; }
        nf += df; nr += dr;
      }
    }
    return false;
  }

  function kingSquare(s, side) {
    for (let i = 0; i < 64; i++) if (s.board[i] === side * K) return i;
    return -1;
  }

  function inCheck(s, side) {
    const k = kingSquare(s, side);
    return k >= 0 && isAttacked(s, k, -side);
  }

  /* ---------- move generation ---------- */

  function pushPawn(out, from, to, me, capture) {
    const last = me === 1 ? 0 : 7;
    if (rankOf(to) === last) {
      for (const promo of [Q, R, B, N]) out.push({ from, to, promo, capture });
    } else {
      out.push({ from, to, promo: 0, capture });
    }
  }

  function genMoves(s, capturesOnly) {
    const out = [], b = s.board, me = s.turn;

    for (let from = 0; from < 64; from++) {
      const pc = b[from];
      if (!pc || sgn(pc) !== me) continue;
      const type = Math.abs(pc);
      const f = fileOf(from), r = rankOf(from);

      if (type === P) {
        const dr = me === 1 ? -1 : 1;
        const startRank = me === 1 ? 6 : 1;
        const oneR = r + dr;
        if (oneR >= 0 && oneR < 8) {
          const one = sq(f, oneR);
          if (!b[one] && !capturesOnly) {
            pushPawn(out, from, one, me, false);
            const twoR = r + dr * 2;
            if (r === startRank && !b[sq(f, twoR)]) {
              out.push({ from, to: sq(f, twoR), promo: 0, dbl: true, capture: false });
            }
          }
          for (const df of [-1, 1]) {
            const nf = f + df;
            if (nf < 0 || nf > 7) continue;
            const to = sq(nf, oneR);
            const t = b[to];
            if (t && sgn(t) !== me) pushPawn(out, from, to, me, true);
            else if (!t && to === s.ep) out.push({ from, to, promo: 0, ep: true, capture: true });
          }
        }
        continue;
      }

      const steps = type === N ? KNIGHT_D : type === K ? KING_D : null;
      if (steps) {
        for (const [df, dr] of steps) {
          const nf = f + df, nr = r + dr;
          if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
          const to = sq(nf, nr), t = b[to];
          if (t && sgn(t) === me) continue;
          if (capturesOnly && !t) continue;
          out.push({ from, to, promo: 0, capture: !!t });
        }
        continue;
      }

      const dirs = type === B ? BISHOP_D : type === R ? ROOK_D : QUEEN_D;
      for (const [df, dr] of dirs) {
        let nf = f + df, nr = r + dr;
        while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
          const to = sq(nf, nr), t = b[to];
          if (t && sgn(t) === me) break;
          if (!capturesOnly || t) out.push({ from, to, promo: 0, capture: !!t });
          if (t) break;
          nf += df; nr += dr;
        }
      }
    }

    if (!capturesOnly) genCastles(s, me, out);
    return out;
  }

  function genCastles(s, me, out) {
    const b = s.board;
    if (me === 1) {
      if (b[60] !== K) return;
      if ((s.castle & 1) && !b[61] && !b[62] && b[63] === R &&
          !isAttacked(s, 60, -1) && !isAttacked(s, 61, -1) && !isAttacked(s, 62, -1)) {
        out.push({ from: 60, to: 62, promo: 0, castle: true, capture: false });
      }
      if ((s.castle & 2) && !b[59] && !b[58] && !b[57] && b[56] === R &&
          !isAttacked(s, 60, -1) && !isAttacked(s, 59, -1) && !isAttacked(s, 58, -1)) {
        out.push({ from: 60, to: 58, promo: 0, castle: true, capture: false });
      }
    } else {
      if (b[4] !== -K) return;
      if ((s.castle & 4) && !b[5] && !b[6] && b[7] === -R &&
          !isAttacked(s, 4, 1) && !isAttacked(s, 5, 1) && !isAttacked(s, 6, 1)) {
        out.push({ from: 4, to: 6, promo: 0, castle: true, capture: false });
      }
      if ((s.castle & 8) && !b[3] && !b[2] && !b[1] && b[0] === -R &&
          !isAttacked(s, 4, 1) && !isAttacked(s, 3, 1) && !isAttacked(s, 2, 1)) {
        out.push({ from: 4, to: 2, promo: 0, castle: true, capture: false });
      }
    }
  }

  /* ---------- make / unmake ---------- */

  function makeMove(s, m) {
    const b = s.board, me = s.turn, pc = b[m.from];
    const u = { move: m, captured: b[m.to], capSq: m.to, castle: s.castle, ep: s.ep, half: s.half, full: s.full };

    b[m.to] = pc;
    b[m.from] = 0;

    if (m.ep) {
      const capSq = m.to + (me === 1 ? 8 : -8);
      u.captured = b[capSq];
      u.capSq = capSq;
      b[capSq] = 0;
    }
    if (m.promo) b[m.to] = me * m.promo;
    if (m.castle) {
      const hop = ROOK_HOP[m.to];
      b[hop[1]] = b[hop[0]];
      b[hop[0]] = 0;
    }

    s.castle &= CASTLE_MASK[m.from] & CASTLE_MASK[m.to];
    s.ep = m.dbl ? (m.from + m.to) / 2 : -1;
    s.half = (Math.abs(pc) === P || u.captured) ? 0 : s.half + 1;
    if (me === -1) s.full++;
    s.turn = -me;
    return u;
  }

  function unmakeMove(s, u) {
    const m = u.move, b = s.board;
    s.turn = -s.turn;
    const me = s.turn;

    b[m.from] = m.promo ? me * P : b[m.to];
    b[m.to] = 0;
    b[u.capSq] = u.captured;

    if (m.castle) {
      const hop = ROOK_HOP[m.to];
      b[hop[0]] = b[hop[1]];
      b[hop[1]] = 0;
    }

    s.castle = u.castle; s.ep = u.ep; s.half = u.half; s.full = u.full;
  }

  function legalMoves(s) {
    const out = [];
    for (const m of genMoves(s, false)) {
      const u = makeMove(s, m);
      if (!inCheck(s, -s.turn)) out.push(m);
      unmakeMove(s, u);
    }
    return out;
  }

  function perft(s, depth) {
    if (depth === 0) return 1;
    let n = 0;
    for (const m of genMoves(s, false)) {
      const u = makeMove(s, m);
      if (!inCheck(s, -s.turn)) n += depth === 1 ? 1 : perft(s, depth - 1);
      unmakeMove(s, u);
    }
    return n;
  }

  /* ---------- draws ---------- */

  function insufficientMaterial(s) {
    const minor = [];
    for (let i = 0; i < 64; i++) {
      const t = Math.abs(s.board[i]);
      if (!t || t === K) continue;
      if (t === P || t === R || t === Q) return false;
      minor.push(s.board[i] > 0 ? t : -t);
    }
    if (minor.length === 0) return true;                 // K v K
    if (minor.length === 1) return true;                 // K+minor v K
    if (minor.length === 2 && minor[0] === -minor[1] && Math.abs(minor[0]) === N) return true;
    return false;
  }

  function positionKey(s) {
    return toFEN(s).split(' ').slice(0, 4).join(' ');
  }

  /* ---------- evaluation ---------- */

  const VAL = [0, 100, 320, 330, 500, 900, 20000];

  const PST = [null,
    [ 0, 0, 0, 0, 0, 0, 0, 0,
     50,50,50,50,50,50,50,50,
     10,10,20,30,30,20,10,10,
      5, 5,10,25,25,10, 5, 5,
      0, 0, 0,20,20, 0, 0, 0,
      5,-5,-10,0, 0,-10,-5, 5,
      5,10,10,-20,-20,10,10,5,
      0, 0, 0, 0, 0, 0, 0, 0],
    [-50,-40,-30,-30,-30,-30,-40,-50,
     -40,-20,  0,  0,  0,  0,-20,-40,
     -30,  0, 10, 15, 15, 10,  0,-30,
     -30,  5, 15, 20, 20, 15,  5,-30,
     -30,  0, 15, 20, 20, 15,  0,-30,
     -30,  5, 10, 15, 15, 10,  5,-30,
     -40,-20,  0,  5,  5,  0,-20,-40,
     -50,-40,-30,-30,-30,-30,-40,-50],
    [-20,-10,-10,-10,-10,-10,-10,-20,
     -10,  0,  0,  0,  0,  0,  0,-10,
     -10,  0,  5, 10, 10,  5,  0,-10,
     -10,  5,  5, 10, 10,  5,  5,-10,
     -10,  0, 10, 10, 10, 10,  0,-10,
     -10, 10, 10, 10, 10, 10, 10,-10,
     -10,  5,  0,  0,  0,  0,  5,-10,
     -20,-10,-10,-10,-10,-10,-10,-20],
    [  0,  0,  0,  0,  0,  0,  0,  0,
       5, 10, 10, 10, 10, 10, 10,  5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
       0,  0,  0,  5,  5,  0,  0,  0],
    [-20,-10,-10, -5, -5,-10,-10,-20,
     -10,  0,  0,  0,  0,  0,  0,-10,
     -10,  0,  5,  5,  5,  5,  0,-10,
      -5,  0,  5,  5,  5,  5,  0, -5,
       0,  0,  5,  5,  5,  5,  0, -5,
     -10,  5,  5,  5,  5,  5,  0,-10,
     -10,  0,  5,  0,  0,  0,  0,-10,
     -20,-10,-10, -5, -5,-10,-10,-20],
    [-30,-40,-40,-50,-50,-40,-40,-30,
     -30,-40,-40,-50,-50,-40,-40,-30,
     -30,-40,-40,-50,-50,-40,-40,-30,
     -30,-40,-40,-50,-50,-40,-40,-30,
     -20,-30,-30,-40,-40,-30,-30,-20,
     -10,-20,-20,-20,-20,-20,-20,-10,
      20, 20,  0,  0,  0,  0, 20, 20,
      20, 30, 10,  0,  0, 10, 30, 20],
  ];

  function evaluate(s) {
    let score = 0;
    for (let i = 0; i < 64; i++) {
      const pc = s.board[i];
      if (!pc) continue;
      const t = Math.abs(pc);
      score += sgn(pc) * (VAL[t] + PST[t][pc > 0 ? i : i ^ 56]);
    }
    return score * s.turn;
  }

  /* ---------- search ---------- */

  const MATE = 100000;
  let nodes = 0, deadline = 0, aborted = false;

  function order(moves, s) {
    for (const m of moves) {
      m._s = m.capture ? 10 * VAL[Math.abs(s.board[m.to])] - VAL[Math.abs(s.board[m.from])] : 0;
      if (m.promo) m._s += VAL[m.promo];
    }
    moves.sort((a, b) => b._s - a._s);
    return moves;
  }

  function quiesce(s, alpha, beta) {
    const stand = evaluate(s);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;

    for (const m of order(genMoves(s, true), s)) {
      const u = makeMove(s, m);
      if (inCheck(s, -s.turn)) { unmakeMove(s, u); continue; }
      nodes++;
      const score = -quiesce(s, -beta, -alpha);
      unmakeMove(s, u);
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  function negamax(s, depth, alpha, beta, ply) {
    if ((nodes & 1023) === 0 && Date.now() > deadline) { aborted = true; return 0; }
    if (depth <= 0) return quiesce(s, alpha, beta);

    let any = false;
    for (const m of order(genMoves(s, false), s)) {
      const u = makeMove(s, m);
      if (inCheck(s, -s.turn)) { unmakeMove(s, u); continue; }
      any = true;
      nodes++;
      const score = -negamax(s, depth - 1, -beta, -alpha, ply + 1);
      unmakeMove(s, u);
      if (aborted) return 0;
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }

    if (!any) return inCheck(s, s.turn) ? -MATE + ply : 0;
    return alpha;
  }

  /** Picks a move. `spread` lets the easier levels choose a near-best move. */
  function chooseMove(s, maxDepth, budgetMs, spread) {
    nodes = 0; aborted = false;
    deadline = Date.now() + budgetMs;

    const roots = legalMoves(s);
    if (!roots.length) return null;

    let best = roots[0], scored = [];
    for (let depth = 1; depth <= maxDepth; depth++) {
      const pass = [];
      let alpha = -Infinity;
      for (const m of order(roots.slice(), s)) {
        const u = makeMove(s, m);
        const score = -negamax(s, depth - 1, -Infinity, -alpha, 1);
        unmakeMove(s, u);
        if (aborted) break;
        pass.push({ m, score });
        if (score > alpha) alpha = score;
      }
      if (aborted || !pass.length) break;
      pass.sort((a, b) => b.score - a.score);
      scored = pass;
      best = pass[0].m;
      if (Date.now() > deadline) break;
    }

    if (spread > 0 && scored.length) {
      const top = scored[0].score;
      const pool = scored.filter((e) => top - e.score <= spread);
      best = pool[Math.floor(Math.random() * pool.length)].m;
    }
    return best;
  }

  /* ====================== ENGINE END ====================== */

  if (typeof document === 'undefined') return;   // engine-only import (tests)

  /* ---------- arcade bridge ---------- */

  const params = new URLSearchParams(location.search);
  const setTheme = (t) => { document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark'; };
  setTheme(params.get('theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  addEventListener('message', (e) => { if (e.data && e.data.type === 'theme') setTheme(e.data.theme); });

  ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) =>
    document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
  document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ---------- elements ---------- */

  const $ = (sel) => document.querySelector(sel);
  const boardEl = $('#board');
  const els = {
    turn: $('#turn'),
    note: $('#note'),
    capTop: $('#cap-top'),
    capBot: $('#cap-bot'),
    undo: $('#btn-undo'),
    flip: $('#btn-flip'),
    fresh: $('#btn-new'),
    menu: $('#menu'),
    promo: $('#promo'),
    promoRow: $('#promo-row'),
    over: $('#over'),
    overTitle: $('#over-title'),
    overNote: $('#over-note'),
    overAgain: $('#btn-again'),
    resume: $('#btn-resume'),
  };

  const GLYPH = { 1: '\u265F', 2: '\u265E', 3: '\u265D', 4: '\u265C', 5: '\u265B', 6: '\u265A' };
  const SAVE_KEY = 'arcade.chess.v1';
  const LEVELS = { easy: [1, 200, 90], medium: [3, 700, 0], hard: [4, 1400, 0] };

  /* ---------- game state ---------- */

  let S = fromFEN(START);
  let history = [];          // FEN before each move, for undo
  let counts = {};           // position key -> times seen, for threefold
  let selected = -1;
  let targets = [];
  let lastMove = null;
  let flipped = false;
  let mode = 'pvp';          // 'pvp' | 'ai'
  let level = 'medium';
  let thinking = false;
  let over = null;
  let pendingPromo = null;
  let squareEls = [];

  /* ---------- board build & paint ---------- */

  function buildBoard() {
    boardEl.textContent = '';
    squareEls = [];
    for (let i = 0; i < 64; i++) {
      const d = document.createElement('div');
      d.className = 'sqr';
      boardEl.append(d);
      squareEls.push(d);
    }
  }

  const viewIndex = (i) => (flipped ? 63 - i : i);

  function sizeBoard() {
    const wrap = $('#board-wrap');
    const cs = getComputedStyle(wrap);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const w = (wrap.clientWidth || document.documentElement.clientWidth || 360) - padX;
    const h = (wrap.clientHeight || 360) - padY;
    const size = Math.floor(Math.max(0, Math.min(w, h)) / 8) * 8;
    document.documentElement.style.setProperty('--board', Math.max(160, size) + 'px');
  }

  function paint() {
    const checkSq = inCheck(S, S.turn) ? kingSquare(S, S.turn) : -1;

    for (let v = 0; v < 64; v++) {
      const i = viewIndex(v);
      const el = squareEls[v];
      const pc = S.board[i];
      const dark = (fileOf(i) + rankOf(i)) % 2 === 1;

      el.className = 'sqr' + (dark ? ' dark' : '');
      if (i === selected) el.classList.add('sel');
      if (lastMove && (i === lastMove.from || i === lastMove.to)) el.classList.add('last');
      if (i === checkSq) el.classList.add('check');

      const hit = targets.find((m) => m.to === i);
      if (hit) el.classList.add(pc ? 'take' : 'move');

      el.textContent = '';
      if (pc) {
        const span = document.createElement('span');
        span.className = 'pc ' + (pc > 0 ? 'w' : 'b');
        span.textContent = GLYPH[Math.abs(pc)];
        el.append(span);
      }
    }

    paintCaptures();
    paintStatus();
    els.undo.disabled = history.length === 0 || thinking;
  }

  function paintCaptures() {
    const seen = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, [-1]: 0, [-2]: 0, [-3]: 0, [-4]: 0, [-5]: 0 };
    for (let i = 0; i < 64; i++) {
      const pc = S.board[i];
      if (pc && Math.abs(pc) !== K) seen[pc]++;
    }
    const full = { 1: 8, 2: 2, 3: 2, 4: 2, 5: 1 };
    const list = (side) => {
      let out = '';
      for (const t of [5, 4, 3, 2, 1]) {
        const missing = full[t] - (seen[side * t] || 0);
        for (let n = 0; n < missing; n++) out += GLYPH[t];
      }
      return out;
    };
    /* pieces captured from the player at the top of the screen */
    const topSide = flipped ? 1 : -1;
    els.capTop.textContent = list(topSide);
    els.capBot.textContent = list(-topSide);
    els.capTop.className = 'cap ' + (topSide > 0 ? 'w' : 'b');
    els.capBot.className = 'cap ' + (topSide > 0 ? 'b' : 'w');
  }

  function sideName(side) {
    if (mode === 'ai') return side === 1 ? 'You' : 'Computer';
    return side === 1 ? 'White' : 'Black';
  }

  function paintStatus() {
    if (over) {
      els.turn.textContent = over.title;
      els.note.textContent = over.note;
      return;
    }
    els.turn.textContent = thinking ? 'Computer is thinking' : sideName(S.turn) + ' to move';
    els.note.textContent = inCheck(S, S.turn) ? 'Check' : (mode === 'ai' ? level : 'pass and play');
  }

  /* ---------- interaction ---------- */

  function humanTurn() {
    return !over && !thinking && !(mode === 'ai' && S.turn === -1);
  }

  boardEl.addEventListener('click', (e) => {
    if (!humanTurn()) return;
    const el = e.target.closest('.sqr');
    if (!el) return;
    const i = viewIndex(squareEls.indexOf(el));

    const hit = targets.filter((m) => m.to === i);
    if (hit.length) {
      if (hit.length > 1) askPromotion(hit);
      else applyMove(hit[0]);
      return;
    }

    const pc = S.board[i];
    if (pc && sgn(pc) === S.turn && i !== selected) {
      selected = i;
      targets = legalMoves(S).filter((m) => m.from === i);
    } else {
      selected = -1;
      targets = [];
    }
    paint();
  });

  function askPromotion(options) {
    pendingPromo = options;
    els.promoRow.textContent = '';
    for (const m of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'promo-pick ' + (S.turn > 0 ? 'w' : 'b');
      b.textContent = GLYPH[m.promo];
      b.addEventListener('click', () => {
        els.promo.hidden = true;
        pendingPromo = null;
        applyMove(m);
      });
      els.promoRow.append(b);
    }
    els.promo.hidden = false;
  }

  function applyMove(m) {
    history.push(toFEN(S));
    if (history.length > 400) history.shift();

    makeMove(S, m);
    lastMove = m;
    selected = -1;
    targets = [];

    const key = positionKey(S);
    counts[key] = (counts[key] || 0) + 1;

    checkEnd();
    paint();
    save();

    if (!over && mode === 'ai' && S.turn === -1) computerMove();
  }

  function computerMove() {
    thinking = true;
    paint();
    const cfg = LEVELS[level] || LEVELS.medium;
    setTimeout(() => {
      const m = chooseMove(S, cfg[0], cfg[1], cfg[2]);
      thinking = false;
      if (!m) { checkEnd(); paint(); return; }
      applyMove(m);
    }, 30);
  }

  function checkEnd() {
    const moves = legalMoves(S);
    if (!moves.length) {
      over = inCheck(S, S.turn)
        ? { title: sideName(-S.turn) + ' wins', note: 'Checkmate' }
        : { title: 'Draw', note: 'Stalemate' };
    } else if (S.half >= 100) {
      over = { title: 'Draw', note: 'Fifty-move rule' };
    } else if (counts[positionKey(S)] >= 3) {
      over = { title: 'Draw', note: 'Threefold repetition' };
    } else if (insufficientMaterial(S)) {
      over = { title: 'Draw', note: 'Not enough material' };
    } else {
      return;
    }
    els.overTitle.textContent = over.title;
    els.overNote.textContent = over.note;
    els.over.hidden = false;
  }

  function undo() {
    if (!history.length || thinking) return;
    /* against the computer, step back over its reply too */
    const steps = mode === 'ai' && history.length > 1 && S.turn === 1 ? 2 : 1;
    for (let n = 0; n < steps && history.length; n++) S = fromFEN(history.pop());
    over = null;
    els.over.hidden = true;
    lastMove = null;
    selected = -1;
    targets = [];
    counts = {};
    paint();
    save();
  }

  /* ---------- persistence ---------- */

  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        fen: toFEN(S), history, mode, level, flipped, over,
      }));
    } catch (e) { /* storage unavailable */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      return d && d.fen ? d : null;
    } catch (e) { return null; }
  }

  function restore(d) {
    S = fromFEN(d.fen);
    history = Array.isArray(d.history) ? d.history : [];
    mode = d.mode === 'ai' ? 'ai' : 'pvp';
    level = LEVELS[d.level] ? d.level : 'medium';
    flipped = !!d.flipped;
    over = d.over || null;
    counts = {};
    lastMove = null;
    selected = -1;
    targets = [];
    els.over.hidden = !over;
    if (over) { els.overTitle.textContent = over.title; els.overNote.textContent = over.note; }
  }

  /* ---------- new game ---------- */

  function newGame(nextMode, nextLevel) {
    mode = nextMode || mode;
    level = nextLevel || level;
    S = fromFEN(START);
    history = [];
    counts = {};
    selected = -1;
    targets = [];
    lastMove = null;
    over = null;
    thinking = false;
    flipped = false;
    els.over.hidden = true;
    els.menu.hidden = true;
    sizeBoard();
    paint();
    save();
  }

  /* ---------- wiring ---------- */

  els.undo.addEventListener('click', undo);
  els.flip.addEventListener('click', () => { flipped = !flipped; paint(); save(); });
  els.fresh.addEventListener('click', () => { els.menu.hidden = false; });
  els.overAgain.addEventListener('click', () => { els.over.hidden = true; els.menu.hidden = false; });

  els.menu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (btn) newGame(btn.dataset.mode, btn.dataset.level);
  });
  $('#menu-cancel').addEventListener('click', () => { els.menu.hidden = true; });
  $('#promo-cancel').addEventListener('click', () => {
    els.promo.hidden = true;
    pendingPromo = null;
    selected = -1; targets = []; paint();
  });

  let resizeTimer;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { sizeBoard(); }, 120);
  });

  /* ---------- boot ---------- */

  buildBoard();

  const saved = load();
  if (saved) {
    restore(saved);
    els.resume.hidden = false;
    els.resume.addEventListener('click', () => { els.menu.hidden = true; sizeBoard(); paint(); });
    els.menu.hidden = false;
  } else {
    els.menu.hidden = false;
  }

  sizeBoard();
  paint();
  requestAnimationFrame(sizeBoard);

  window.__booted = true;
})();
