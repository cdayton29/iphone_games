/* ============================================================
   ARCADE CHESS — engine + UI, zero dependencies.
   Board: 64-length array. Index 0 = a8 … 63 = h1.
   White pieces: "PNBRQK"  Black pieces: "pnbrqk"  Empty: ""
   ============================================================ */
'use strict';

/* ============================ ENGINE ============================ */

const EMPTY = '';
const FILES = 'abcdefgh';
const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const MATE = 100000;

const N_D = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
const K_D = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
const B_D = [[-1,-1],[-1,1],[1,-1],[1,1]];
const R_D = [[-1,0],[1,0],[0,-1],[0,1]];

function inB(r, c){ return r >= 0 && r < 8 && c >= 0 && c < 8; }
function idx(r, c){ return r * 8 + c; }
function colorOf(p){ return p ? (p <= 'Z' ? 'w' : 'b') : null; }
function sqName(i){ return FILES[i & 7] + (8 - (i >> 3)); }

function initialBoard(){
  const b = new Array(64).fill(EMPTY);
  const back = ['r','n','b','q','k','b','n','r'];
  for (let c = 0; c < 8; c++){
    b[c]      = back[c];
    b[8 + c]  = 'p';
    b[48 + c] = 'P';
    b[56 + c] = back[c].toUpperCase();
  }
  return b;
}

function newState(){
  return {
    board: initialBoard(),
    turn: 'w',
    castling: { K: true, Q: true, k: true, q: true },
    ep: -1,          // en-passant target square, or -1
    half: 0,         // halfmove clock (50-move rule)
    full: 1
  };
}

function kingSq(bd, color){
  const k = color === 'w' ? 'K' : 'k';
  for (let i = 0; i < 64; i++) if (bd[i] === k) return i;
  return -1;
}

/* Is square `sq` attacked by side `by`? */
function attacked(bd, sq, by){
  const r = sq >> 3, c = sq & 7;
  // pawns (white pawns attack from a higher row index)
  const pr = by === 'w' ? r + 1 : r - 1;
  const pp = by === 'w' ? 'P' : 'p';
  for (const dc of [-1, 1]){
    if (inB(pr, c + dc) && bd[idx(pr, c + dc)] === pp) return true;
  }
  // knights
  const nn = by === 'w' ? 'N' : 'n';
  for (const [dr, dc] of N_D){
    const rr = r + dr, cc = c + dc;
    if (inB(rr, cc) && bd[idx(rr, cc)] === nn) return true;
  }
  // king
  const kk = by === 'w' ? 'K' : 'k';
  for (const [dr, dc] of K_D){
    const rr = r + dr, cc = c + dc;
    if (inB(rr, cc) && bd[idx(rr, cc)] === kk) return true;
  }
  // diagonal sliders
  for (const [dr, dc] of B_D){
    let rr = r + dr, cc = c + dc;
    while (inB(rr, cc)){
      const p = bd[idx(rr, cc)];
      if (p){
        if (colorOf(p) === by){
          const t = p.toLowerCase();
          if (t === 'b' || t === 'q') return true;
        }
        break;
      }
      rr += dr; cc += dc;
    }
  }
  // straight sliders
  for (const [dr, dc] of R_D){
    let rr = r + dr, cc = c + dc;
    while (inB(rr, cc)){
      const p = bd[idx(rr, cc)];
      if (p){
        if (colorOf(p) === by){
          const t = p.toLowerCase();
          if (t === 'r' || t === 'q') return true;
        }
        break;
      }
      rr += dr; cc += dc;
    }
  }
  return false;
}

function inCheck(st, color){
  return attacked(st.board, kingSq(st.board, color), color === 'w' ? 'b' : 'w');
}

/* Pseudo-legal move generation for the side to move. */
function genPseudo(st){
  const bd = st.board, color = st.turn, moves = [];
  const enemy = color === 'w' ? 'b' : 'w';

  for (let i = 0; i < 64; i++){
    const p = bd[i];
    if (!p || colorOf(p) !== color) continue;
    const t = p.toLowerCase();
    const r = i >> 3, c = i & 7;

    if (t === 'p'){
      const dir = color === 'w' ? -1 : 1;
      const startR = color === 'w' ? 6 : 1;
      const promoR = color === 'w' ? 0 : 7;
      const fr = r + dir;
      // forward
      if (inB(fr, c) && !bd[idx(fr, c)]){
        if (fr === promoR){
          for (const pr of ['q','r','b','n']) moves.push({ from: i, to: idx(fr, c), promo: pr });
        } else {
          moves.push({ from: i, to: idx(fr, c) });
          const dr2 = r + dir * 2;
          if (r === startR && !bd[idx(dr2, c)]) moves.push({ from: i, to: idx(dr2, c), double: true });
        }
      }
      // captures + en passant
      for (const dc of [-1, 1]){
        const cc = c + dc;
        if (!inB(fr, cc)) continue;
        const target = idx(fr, cc);
        const q = bd[target];
        if (q && colorOf(q) === enemy){
          if (fr === promoR){
            for (const pr of ['q','r','b','n']) moves.push({ from: i, to: target, promo: pr });
          } else moves.push({ from: i, to: target });
        } else if (target === st.ep && !q){
          moves.push({ from: i, to: target, ep: true });
        }
      }
    }
    else if (t === 'n' || t === 'k'){
      for (const [dr, dc] of (t === 'n' ? N_D : K_D)){
        const rr = r + dr, cc = c + dc;
        if (!inB(rr, cc)) continue;
        const q = bd[idx(rr, cc)];
        if (!q || colorOf(q) === enemy) moves.push({ from: i, to: idx(rr, cc) });
      }
      if (t === 'k'){
        // castling — squares empty and king path not attacked
        if (color === 'w' && i === 60){
          if (st.castling.K && bd[63] === 'R' && !bd[61] && !bd[62] &&
              !attacked(bd, 60, 'b') && !attacked(bd, 61, 'b') && !attacked(bd, 62, 'b'))
            moves.push({ from: 60, to: 62, castle: 'K' });
          if (st.castling.Q && bd[56] === 'R' && !bd[57] && !bd[58] && !bd[59] &&
              !attacked(bd, 60, 'b') && !attacked(bd, 59, 'b') && !attacked(bd, 58, 'b'))
            moves.push({ from: 60, to: 58, castle: 'Q' });
        }
        if (color === 'b' && i === 4){
          if (st.castling.k && bd[7] === 'r' && !bd[5] && !bd[6] &&
              !attacked(bd, 4, 'w') && !attacked(bd, 5, 'w') && !attacked(bd, 6, 'w'))
            moves.push({ from: 4, to: 6, castle: 'K' });
          if (st.castling.q && bd[0] === 'r' && !bd[1] && !bd[2] && !bd[3] &&
              !attacked(bd, 4, 'w') && !attacked(bd, 3, 'w') && !attacked(bd, 2, 'w'))
            moves.push({ from: 4, to: 2, castle: 'Q' });
        }
      }
    }
    else {
      const dirs = t === 'b' ? B_D : t === 'r' ? R_D : B_D.concat(R_D);
      for (const [dr, dc] of dirs){
        let rr = r + dr, cc = c + dc;
        while (inB(rr, cc)){
          const q = bd[idx(rr, cc)];
          if (!q){ moves.push({ from: i, to: idx(rr, cc) }); }
          else { if (colorOf(q) === enemy) moves.push({ from: i, to: idx(rr, cc) }); break; }
          rr += dr; cc += dc;
        }
      }
    }
  }
  return moves;
}

/* Apply a move; returns a serialisable undo record. */
function make(st, m){
  const bd = st.board;
  const mover = st.turn;
  const piece = bd[m.from];
  const rec = {
    m, piece,
    captured: bd[m.to],
    epCapSq: -1,
    prevCast: { K: st.castling.K, Q: st.castling.Q, k: st.castling.k, q: st.castling.q },
    prevEp: st.ep, prevHalf: st.half, prevFull: st.full
  };

  bd[m.to] = m.promo ? (mover === 'w' ? m.promo.toUpperCase() : m.promo) : piece;
  bd[m.from] = EMPTY;

  if (m.ep){
    rec.epCapSq = m.to + (mover === 'w' ? 8 : -8);
    rec.captured = bd[rec.epCapSq];
    bd[rec.epCapSq] = EMPTY;
  }
  if (m.castle){
    if (mover === 'w'){
      if (m.castle === 'K'){ bd[61] = 'R'; bd[63] = EMPTY; }
      else { bd[59] = 'R'; bd[56] = EMPTY; }
    } else {
      if (m.castle === 'K'){ bd[5] = 'r'; bd[7] = EMPTY; }
      else { bd[3] = 'r'; bd[0] = EMPTY; }
    }
  }

  if (piece === 'K'){ st.castling.K = st.castling.Q = false; }
  if (piece === 'k'){ st.castling.k = st.castling.q = false; }
  if (m.from === 63 || m.to === 63) st.castling.K = false;
  if (m.from === 56 || m.to === 56) st.castling.Q = false;
  if (m.from === 7  || m.to === 7)  st.castling.k = false;
  if (m.from === 0  || m.to === 0)  st.castling.q = false;

  st.ep = m.double ? (m.from + m.to) / 2 : -1;
  st.half = (piece.toLowerCase() === 'p' || rec.captured) ? 0 : st.half + 1;
  if (mover === 'b') st.full++;
  st.turn = mover === 'w' ? 'b' : 'w';
  return rec;
}

function unmake(st, rec){
  st.turn = st.turn === 'w' ? 'b' : 'w';   // back to the mover
  const bd = st.board, m = rec.m;
  bd[m.from] = rec.piece;
  bd[m.to] = EMPTY;
  if (rec.epCapSq >= 0) bd[rec.epCapSq] = rec.captured;
  else if (rec.captured) bd[m.to] = rec.captured;
  if (m.castle){
    if (rec.piece === 'K'){
      if (m.castle === 'K'){ bd[63] = 'R'; bd[61] = EMPTY; }
      else { bd[56] = 'R'; bd[59] = EMPTY; }
    } else {
      if (m.castle === 'K'){ bd[7] = 'r'; bd[5] = EMPTY; }
      else { bd[0] = 'r'; bd[3] = EMPTY; }
    }
  }
  st.castling = rec.prevCast;
  st.ep = rec.prevEp; st.half = rec.prevHalf; st.full = rec.prevFull;
}

function legalMoves(st){
  const mover = st.turn, out = [];
  for (const m of genPseudo(st)){
    const rec = make(st, m);
    if (!attacked(st.board, kingSq(st.board, mover), st.turn)) out.push(m);
    unmake(st, rec);
  }
  return out;
}

function insufficientMaterial(bd){
  const minors = [];
  for (let i = 0; i < 64; i++){
    const p = bd[i];
    if (!p) continue;
    const t = p.toLowerCase();
    if (t === 'k') continue;
    if (t === 'n' || t === 'b') minors.push(t);
    else return false;                      // pawn, rook, or queen present
  }
  return minors.length <= 1;                // K v K, or K+minor v K
}

/* status: null while playing, else {result:'w'|'b'|'d', reason} */
function gameStatus(st){
  if (legalMoves(st).length === 0){
    if (inCheck(st, st.turn)) return { result: st.turn === 'w' ? 'b' : 'w', reason: 'checkmate' };
    return { result: 'd', reason: 'stalemate' };
  }
  if (st.half >= 100) return { result: 'd', reason: '50-move rule' };
  if (insufficientMaterial(st.board)) return { result: 'd', reason: 'insufficient material' };
  return null;
}

/* ------------------------- evaluation ------------------------- */
/* Piece-square tables, white's point of view (index 0 = a8).     */
const PST = {
  p: [ 0,  0,  0,  0,  0,  0,  0,  0,
      50, 50, 50, 50, 50, 50, 50, 50,
      10, 10, 20, 30, 30, 20, 10, 10,
       5,  5, 10, 25, 25, 10,  5,  5,
       0,  0,  0, 20, 20,  0,  0,  0,
       5, -5,-10,  0,  0,-10, -5,  5,
       5, 10, 10,-20,-20, 10, 10,  5,
       0,  0,  0,  0,  0,  0,  0,  0],
  n: [-50,-40,-30,-30,-30,-30,-40,-50,
      -40,-20,  0,  0,  0,  0,-20,-40,
      -30,  0, 10, 15, 15, 10,  0,-30,
      -30,  5, 15, 20, 20, 15,  5,-30,
      -30,  0, 15, 20, 20, 15,  0,-30,
      -30,  5, 10, 15, 15, 10,  5,-30,
      -40,-20,  0,  5,  5,  0,-20,-40,
      -50,-40,-30,-30,-30,-30,-40,-50],
  b: [-20,-10,-10,-10,-10,-10,-10,-20,
      -10,  0,  0,  0,  0,  0,  0,-10,
      -10,  0,  5, 10, 10,  5,  0,-10,
      -10,  5,  5, 10, 10,  5,  5,-10,
      -10,  0, 10, 10, 10, 10,  0,-10,
      -10, 10, 10, 10, 10, 10, 10,-10,
      -10,  5,  0,  0,  0,  0,  5,-10,
      -20,-10,-10,-10,-10,-10,-10,-20],
  r: [  0,  0,  0,  0,  0,  0,  0,  0,
        5, 10, 10, 10, 10, 10, 10,  5,
       -5,  0,  0,  0,  0,  0,  0, -5,
       -5,  0,  0,  0,  0,  0,  0, -5,
       -5,  0,  0,  0,  0,  0,  0, -5,
       -5,  0,  0,  0,  0,  0,  0, -5,
       -5,  0,  0,  0,  0,  0,  0, -5,
        0,  0,  0,  5,  5,  0,  0,  0],
  q: [-20,-10,-10, -5, -5,-10,-10,-20,
      -10,  0,  0,  0,  0,  0,  0,-10,
      -10,  0,  5,  5,  5,  5,  0,-10,
       -5,  0,  5,  5,  5,  5,  0, -5,
        0,  0,  5,  5,  5,  5,  0, -5,
      -10,  5,  5,  5,  5,  5,  0,-10,
      -10,  0,  5,  0,  0,  0,  0,-10,
      -20,-10,-10, -5, -5,-10,-10,-20],
  k: [-30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -20,-30,-30,-40,-40,-30,-30,-20,
      -10,-20,-20,-20,-20,-20,-20,-10,
       20, 20,  0,  0,  0,  0, 20, 20,
       20, 30, 10,  0,  0, 10, 30, 20]
};

/* Score from White's perspective (centipawns). */
function evaluate(bd){
  let s = 0;
  for (let i = 0; i < 64; i++){
    const p = bd[i];
    if (!p) continue;
    const t = p.toLowerCase();
    if (colorOf(p) === 'w') s += VAL[t] + PST[t][i];
    else                    s -= VAL[t] + PST[t][i ^ 56];   // mirror ranks
  }
  return s;
}

function orderMoves(st, moves){
  const bd = st.board;
  for (const m of moves){
    let sc = 0;
    const victim = m.ep ? 'p' : (bd[m.to] ? bd[m.to].toLowerCase() : null);
    if (victim) sc += 10 * VAL[victim] - VAL[bd[m.from].toLowerCase()];
    if (m.promo) sc += 8 * VAL[m.promo];
    m._o = sc;
  }
  moves.sort((a, b) => b._o - a._o);
  return moves;
}

/* Negamax with alpha-beta. Returns score for the side to move. */
function search(st, depth, alpha, beta, ply){
  if (depth === 0){
    const e = evaluate(st.board);
    return st.turn === 'w' ? e : -e;
  }
  const moves = orderMoves(st, legalMoves(st));
  if (moves.length === 0){
    return inCheck(st, st.turn) ? -MATE + ply : 0;
  }
  if (st.half >= 100 || insufficientMaterial(st.board)) return 0;

  let best = -Infinity;
  for (const m of moves){
    const rec = make(st, m);
    const sc = -search(st, depth - 1, -beta, -alpha, ply + 1);
    unmake(st, rec);
    if (sc > best) best = sc;
    if (sc > alpha) alpha = sc;
    if (alpha >= beta) break;
  }
  return best;
}

/* Pick the AI's move. level: 'easy' | 'med' | 'hard' */
function chooseMove(st, level){
  const moves = legalMoves(st);
  if (moves.length === 0) return null;
  if (level === 'easy'){
    return moves[Math.floor(Math.random() * moves.length)];
  }
  const depth = level === 'hard' ? 3 : 2;
  // Shuffle so equally-scored moves vary game to game.
  for (let i = moves.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [moves[i], moves[j]] = [moves[j], moves[i]];
  }
  orderMoves(st, moves);
  let best = null, bestSc = -Infinity;
  let alpha = -Infinity;
  for (const m of moves){
    const rec = make(st, m);
    const sc = -search(st, depth - 1, -Infinity, -alpha, 1);
    unmake(st, rec);
    if (sc > bestSc){ bestSc = sc; best = m; }
    if (sc > alpha) alpha = sc;
  }
  return best;
}

/* Standard algebraic notation for a move (call BEFORE making it). */
function sanFor(st, m){
  let s;
  if (m.castle){
    s = m.castle === 'K' ? 'O-O' : 'O-O-O';
  } else {
    const piece = st.board[m.from];
    const t = piece.toLowerCase();
    const capture = !!st.board[m.to] || m.ep;
    s = '';
    if (t !== 'p'){
      s = t.toUpperCase();
      const rivals = legalMoves(st).filter(x =>
        x.to === m.to && x.from !== m.from && st.board[x.from] === piece);
      if (rivals.length){
        const sameFile = rivals.some(x => (x.from & 7) === (m.from & 7));
        const sameRank = rivals.some(x => (x.from >> 3) === (m.from >> 3));
        if (!sameFile)      s += FILES[m.from & 7];
        else if (!sameRank) s += String(8 - (m.from >> 3));
        else                s += sqName(m.from);
      }
    } else if (capture){
      s = FILES[m.from & 7];
    }
    if (capture) s += 'x';
    s += sqName(m.to);
    if (m.promo) s += '=' + m.promo.toUpperCase();
  }
  const rec = make(st, m);
  if (inCheck(st, st.turn)) s += legalMoves(st).length ? '+' : '#';
  unmake(st, rec);
  return s;
}

/* perft — used only by tests */
function perft(st, depth){
  if (depth === 0) return 1;
  let n = 0;
  for (const m of legalMoves(st)){
    const rec = make(st, m);
    n += perft(st, depth - 1);
    unmake(st, rec);
  }
  return n;
}

/* Node test hook */
if (typeof module !== 'undefined' && module.exports){
  module.exports = { newState, legalMoves, make, unmake, perft, gameStatus,
                     chooseMove, sanFor, evaluate, inCheck, attacked };
}

/* ============================== UI ============================== */

if (typeof window !== 'undefined' && window.document){ (function(){

const SAVE_KEY  = 'arcade_chess_save_v1';
const STATS_KEY = 'arcade_chess_stats_v1';

const GLYPH = { p: '\u265F', n: '\u265E', b: '\u265D', r: '\u265C', q: '\u265B', k: '\u265A' };
const TXT = '\uFE0E';   // text-presentation selector (blocks emoji rendering on iOS)

const $ = id => document.getElementById(id);
const boardEl = $('board'), ghostEl = $('dragGhost');

/* ------------------------- app state ------------------------- */
let S = newState();
let undoStack = [];            // undo records, oldest first
let sanList = [];              // SAN strings parallel to undoStack
let over = null;               // gameStatus() result once finished
let overCounted = false;
let settings = { mode: 'ai', diff: 'med', side: 'w', rotate: false };
let stats = { aiW: 0, aiL: 0, aiD: 0, pW: 0, pB: 0, pD: 0 };
let selected = -1, selMoves = [];
let aiToken = 0, aiThinking = false;
let pendingPromo = null;       // { from, to } awaiting piece choice
let drag = null;               // { from, moved, id }
const squares = [];

/* ------------------------- persistence ----------------------- */
function safeGet(k){ try { return localStorage.getItem(k); } catch (e){ return null; } }
function safeSet(k, v){ try { localStorage.setItem(k, v); } catch (e){} }
function safeDel(k){ try { localStorage.removeItem(k); } catch (e){} }

function save(){
  safeSet(SAVE_KEY, JSON.stringify({
    board: S.board.map(p => p || '.').join(''),
    turn: S.turn, castling: S.castling, ep: S.ep, half: S.half, full: S.full,
    undoStack, sanList, settings,
    over, overCounted
  }));
  safeSet(STATS_KEY, JSON.stringify(stats));
}

function load(){
  const st = safeGet(STATS_KEY);
  if (st){ try { Object.assign(stats, JSON.parse(st)); } catch (e){} }
  const raw = safeGet(SAVE_KEY);
  if (!raw) return false;
  try {
    const d = JSON.parse(raw);
    if (!d.board || d.board.length !== 64) return false;
    S = {
      board: d.board.split('').map(ch => ch === '.' ? EMPTY : ch),
      turn: d.turn, castling: d.castling, ep: d.ep, half: d.half, full: d.full
    };
    undoStack = d.undoStack || [];
    sanList = d.sanList || [];
    settings = Object.assign(settings, d.settings || {});
    over = d.over || null;
    overCounted = !!d.overCounted;
    return true;
  } catch (e){ return false; }
}

/* --------------------------- board DOM ----------------------- */
function buildBoard(){
  for (let i = 0; i < 64; i++){
    const sq = document.createElement('div');
    const r = i >> 3, c = i & 7;
    sq.className = 'sq' + ((r + c) % 2 ? ' dark' : '');
    sq.dataset.i = i;
    if (r === 7){
      const f = document.createElement('span');
      f.className = 'coord file'; f.textContent = FILES[c];
      sq.appendChild(f);
    }
    if (c === 0){
      const rk = document.createElement('span');
      rk.className = 'coord rank'; rk.textContent = String(8 - r);
      sq.appendChild(rk);
    }
    const pc = document.createElement('span');
    pc.className = 'pc';
    sq.appendChild(pc);
    boardEl.appendChild(sq);
    squares.push(sq);
  }
}

function isFlipped(){
  if (settings.mode === 'ai') return settings.side === 'b';
  return settings.rotate && S.turn === 'b' && !over;
}

function humanTurn(){
  if (over) return false;
  if (settings.mode === '2p') return true;
  return S.turn === settings.side && !aiThinking;
}

function lastMove(){
  return undoStack.length ? undoStack[undoStack.length - 1].m : null;
}

function render(){
  const lm = lastMove();
  const checkSq = inCheck(S, S.turn) ? kingSq(S.board, S.turn) : -1;
  for (let i = 0; i < 64; i++){
    const sq = squares[i], p = S.board[i];
    const pc = sq.lastElementChild;
    pc.textContent = p ? GLYPH[p.toLowerCase()] + TXT : '';
    pc.className = 'pc' + (p ? (colorOf(p) === 'w' ? ' w' : ' b') : '');
    sq.classList.toggle('last', !!lm && (lm.from === i || lm.to === i));
    sq.classList.toggle('sel', selected === i);
    sq.classList.toggle('check', checkSq === i);
    const mv = selMoves.find(m => m.to === i);
    sq.classList.toggle('dot',  !!mv && !S.board[i] && !mv.ep);
    sq.classList.toggle('take', !!mv && (!!S.board[i] || !!mv.ep));
    sq.classList.toggle('ghosted', !!drag && drag.from === i && drag.moved);
  }
  boardEl.classList.toggle('flip', isFlipped());
  renderCaptured();
  renderLog();
  renderTurnBar();
  renderStatsLine();
  $('btnUndo').disabled = undoStack.length === 0 || aiThinking;
}

function renderTurnBar(){
  const bar = $('turnBar');
  bar.classList.remove('thinking', 'over');
  if (over){
    bar.classList.add('over');
    bar.innerHTML = over.result === 'd'
      ? 'Draw &mdash; ' + over.reason
      : (over.result === 'w' ? 'White wins' : 'Black wins') + ' &mdash; ' + over.reason;
    return;
  }
  const name = S.turn === 'w' ? 'White' : 'Black';
  if (aiThinking){
    bar.classList.add('thinking');
    bar.innerHTML = '<span class="swatch ' + S.turn + '"></span> Computer is thinking&hellip;';
  } else {
    const chk = inCheck(S, S.turn) ? ' &mdash; check!' : '';
    bar.innerHTML = '<span class="swatch ' + S.turn + '"></span> ' + name + ' to move' + chk;
  }
}

function renderCaptured(){
  // Pieces each side has captured, plus material lead.
  const byW = [], byB = [];
  for (const rec of undoStack){
    if (!rec.captured) continue;
    (colorOf(rec.captured) === 'b' ? byW : byB).push(rec.captured);
  }
  const val = arr => arr.reduce((s, p) => s + VAL[p.toLowerCase()], 0);
  const lead = val(byW) - val(byB);
  const order = p => -VAL[p.toLowerCase()];
  byW.sort((a, b) => order(a) - order(b));
  byB.sort((a, b) => order(a) - order(b));

  const strip = (el, who, arr, cls, diff) => {
    el.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'who'; label.textContent = who;
    el.appendChild(label);
    for (const p of arr){
      const s = document.createElement('span');
      s.className = cls; s.textContent = GLYPH[p.toLowerCase()] + TXT;
      el.appendChild(s);
    }
    if (diff > 0){
      const d = document.createElement('span');
      d.className = 'diff'; d.textContent = '+' + Math.round(diff / 100 * 10) / 10;
      el.appendChild(d);
    }
  };
  // top strip belongs to the player shown at the top of the board
  const whiteOnTop = isFlipped();
  const topIsWhite = whiteOnTop;
  strip($('captTop'),
        topIsWhite ? 'White' : 'Black',
        topIsWhite ? byW : byB,
        topIsWhite ? 'cb' : 'cw',
        topIsWhite ? lead : -lead);
  strip($('captBottom'),
        topIsWhite ? 'Black' : 'White',
        topIsWhite ? byB : byW,
        topIsWhite ? 'cw' : 'cb',
        topIsWhite ? -lead : lead);
}

function renderLog(){
  const log = $('moveLog');
  log.innerHTML = '';
  if (sanList.length === 0){
    log.innerHTML = '<div class="empty">No moves yet.</div>';
    return;
  }
  for (let i = 0; i < sanList.length; i += 2){
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML =
      '<span class="num">' + (i / 2 + 1) + '.</span>' +
      '<span>' + sanList[i] + '</span>' +
      '<span>' + (sanList[i + 1] || '') + '</span>';
    log.appendChild(row);
  }
  log.scrollTop = log.scrollHeight;
}

function renderStatsLine(){
  const el = $('statsLine');
  if (settings.mode === 'ai'){
    el.innerHTML = 'You <b>' + stats.aiW + 'W</b> \u00B7 <b>' + stats.aiL + 'L</b> \u00B7 <b>' + stats.aiD + 'D</b>';
  } else {
    el.innerHTML = '\u26AA <b>' + stats.pW + '</b> \u00B7 \u26AB <b>' + stats.pB + '</b> \u00B7 = <b>' + stats.pD + '</b>';
  }
}

/* ------------------------- game flow ------------------------- */
function clearSelection(){
  selected = -1; selMoves = [];
}

function commitMove(m){
  const san = sanFor(S, m);
  const rec = make(S, m);
  undoStack.push(rec);
  sanList.push(san);
  clearSelection();
  over = gameStatus(S);
  if (over) onGameOver();
  save();
  render();
  maybeAIMove();
}

function onGameOver(){
  if (!overCounted){
    overCounted = true;
    if (settings.mode === 'ai'){
      if (over.result === 'd') stats.aiD++;
      else if (over.result === settings.side) stats.aiW++;
      else stats.aiL++;
    } else {
      if (over.result === 'd') stats.pD++;
      else if (over.result === 'w') stats.pW++;
      else stats.pB++;
    }
  }
  showGameOver();
}

function showGameOver(){
  $('overTitle').textContent =
    over.result === 'd' ? 'Draw'
    : settings.mode === 'ai'
      ? (over.result === settings.side ? 'You win!' : 'Computer wins')
      : (over.result === 'w' ? 'White wins!' : 'Black wins!');
  $('overDetail').textContent = 'By ' + over.reason + ' \u00B7 ' +
    Math.ceil(sanList.length / 2) + ' moves';
  $('overOverlay').classList.add('on');
}

function tryMove(from, to){
  const candidates = selMoves.filter(m => m.from === from && m.to === to);
  if (candidates.length === 0) return false;
  if (candidates[0].promo){
    pendingPromo = { from, to };
    openPromo();
  } else {
    commitMove(candidates[0]);
  }
  return true;
}

function openPromo(){
  const row = $('promoRow');
  row.innerHTML = '';
  const cls = S.turn === 'w' ? 'w' : 'b';
  for (const t of ['q','r','b','n']){
    const b = document.createElement('button');
    b.innerHTML = '<span class="pc ' + cls + '">' + GLYPH[t] + TXT + '</span>';
    b.addEventListener('click', () => {
      const mv = selMoves.find(m =>
        m.from === pendingPromo.from && m.to === pendingPromo.to && m.promo === t);
      $('promoOverlay').classList.remove('on');
      pendingPromo = null;
      if (mv) commitMove(mv);
    });
    row.appendChild(b);
  }
  $('promoOverlay').classList.add('on');
}

function undo(){
  if (undoStack.length === 0 || aiThinking) return;
  const pop = () => { unmake(S, undoStack.pop()); sanList.pop(); };
  pop();
  // vs AI: also take back the computer's reply so it's your move again
  if (settings.mode === 'ai' && S.turn !== settings.side && undoStack.length) pop();
  over = null; overCounted = false;
  clearSelection();
  $('overOverlay').classList.remove('on');
  save();
  render();
  maybeAIMove();   // covers undoing while playing Black on move 1
}

function maybeAIMove(){
  if (over || settings.mode !== 'ai' || S.turn === settings.side) return;
  aiThinking = true;
  const token = ++aiToken;
  render();
  setTimeout(() => {
    if (token !== aiToken) return;         // cancelled by New Game / Undo
    const m = chooseMove(S, settings.diff);
    aiThinking = false;
    if (m) commitMove(m);
    else render();
  }, 380);
}

function startNewGame(){
  aiToken++; aiThinking = false;
  S = newState();
  undoStack = []; sanList = [];
  over = null; overCounted = false;
  clearSelection();
  pendingPromo = null;
  $('overOverlay').classList.remove('on');
  $('promoOverlay').classList.remove('on');
  save();
  render();
  maybeAIMove();
}

/* ---------------------- touch & drag input -------------------- */
function squareFromPoint(x, y){
  const el = document.elementFromPoint(x, y);
  const sq = el && el.closest ? el.closest('.sq') : null;
  return sq ? +sq.dataset.i : -1;
}

function selectSquare(i){
  const p = S.board[i];
  if (p && colorOf(p) === S.turn && humanTurn()){
    selected = i;
    selMoves = legalMoves(S).filter(m => m.from === i);
    return true;
  }
  return false;
}

boardEl.addEventListener('pointerdown', e => {
  if (!humanTurn() || pendingPromo) return;
  e.preventDefault();
  const i = squareFromPoint(e.clientX, e.clientY);
  if (i < 0) return;

  if (selected >= 0 && tryMove(selected, i)) return;

  if (selectSquare(i)){
    drag = { from: i, moved: false, id: e.pointerId, x: e.clientX, y: e.clientY };
    render();
  } else if (selected >= 0){
    clearSelection();
    render();
  }
});

window.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  e.preventDefault();
  if (!drag.moved){
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 7) return;
    drag.moved = true;
    const p = S.board[drag.from];
    ghostEl.textContent = GLYPH[p.toLowerCase()] + TXT;
    ghostEl.className = 'on pc ' + colorOf(p);
    ghostEl.id = 'dragGhost';
    render();
  }
  ghostEl.style.left = e.clientX + 'px';
  ghostEl.style.top  = e.clientY + 'px';
}, { passive: false });

window.addEventListener('pointerup', e => {
  if (!drag || e.pointerId !== drag.id) return;
  const wasDrag = drag.moved;
  const from = drag.from;
  drag = null;
  ghostEl.className = '';
  if (wasDrag){
    const i = squareFromPoint(e.clientX, e.clientY);
    if (i >= 0 && i !== from) tryMove(from, i);
    render();          // tryMove renders on success; this covers misses
  } else {
    render();          // simple tap: keep selection showing
  }
});

window.addEventListener('pointercancel', () => {
  if (!drag) return;
  drag = null;
  ghostEl.className = '';
  render();
});

/* Block iOS pinch-zoom / double-tap zoom / scroll on the board */
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('gesturechange', e => e.preventDefault());
boardEl.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
boardEl.addEventListener('touchmove',  e => e.preventDefault(), { passive: false });
document.addEventListener('dblclick',  e => e.preventDefault());

/* --------------------------- setup UI ------------------------ */
let draft = null;   // settings being edited in the sheet

function segInit(id, key){
  $(id).addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    draft[key] = b.dataset.v;
    syncSetupUI();
  });
}

function syncSetupUI(){
  const set = (id, key) => {
    for (const b of $(id).querySelectorAll('button'))
      b.classList.toggle('on', b.dataset.v === draft[key]);
  };
  set('segMode', 'mode'); set('segDiff', 'diff'); set('segSide', 'side');
  $('aiOpts').style.display = draft.mode === 'ai' ? '' : 'none';
  $('rotOpt').style.display = draft.mode === '2p' ? '' : 'none';
  $('swRotate').classList.toggle('on', draft.rotate);
  renderStatsGrid();
}

function renderStatsGrid(){
  const g = $('statsGrid');
  const cell = (v, k, cls) =>
    '<div class="cell"><div class="v ' + (cls || '') + '">' + v + '</div><div class="k">' + k + '</div></div>';
  g.innerHTML = draft.mode === 'ai'
    ? cell(stats.aiW, 'Wins', 'win') + cell(stats.aiL, 'Losses', 'loss') + cell(stats.aiD, 'Draws')
    : cell(stats.pW, 'White', 'win') + cell(stats.pB, 'Black', 'loss') + cell(stats.pD, 'Draws');
}

function openSetup(){
  draft = Object.assign({}, settings);
  syncSetupUI();
  $('btnCancelSetup').style.display = undoStack.length || over ? '' : 'none';
  $('setupOverlay').classList.add('on');
}

segInit('segMode', 'mode');
segInit('segDiff', 'diff');
segInit('segSide', 'side');
$('swRotate').addEventListener('click', () => { draft.rotate = !draft.rotate; syncSetupUI(); });
$('btnStart').addEventListener('click', () => {
  settings = draft;
  $('setupOverlay').classList.remove('on');
  startNewGame();
});
$('btnCancelSetup').addEventListener('click', () => $('setupOverlay').classList.remove('on'));
$('btnResetStats').addEventListener('click', () => {
  stats = { aiW: 0, aiL: 0, aiD: 0, pW: 0, pB: 0, pD: 0 };
  safeSet(STATS_KEY, JSON.stringify(stats));
  renderStatsGrid(); renderStatsLine();
});

$('btnNew').addEventListener('click', openSetup);
$('btnUndo').addEventListener('click', undo);
$('btnRematch').addEventListener('click', () => {
  $('overOverlay').classList.remove('on');
  openSetup();
});
$('btnReview').addEventListener('click', () => $('overOverlay').classList.remove('on'));

/* ---------------------------- boot --------------------------- */
buildBoard();
const resumed = load();
render();
if (resumed){
  if (over) showGameOver();
  else maybeAIMove();
} else {
  openSetup();
}
save();

})(); }
