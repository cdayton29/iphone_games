/* =========================================================================
   Break — 8-Ball Pool
   Pure vanilla. No dependencies. Offline-first.
   ========================================================================= */
'use strict';

(function () {

/* ---------------------------------------------------------------- geometry */

const RAIL = 34;                 // rail thickness, world units
const PW = 880, PH = 440;        // playfield
const BW = PW + RAIL * 2;        // board incl. rails
const BH = PH + RAIL * 2;
const R = 11;                    // ball radius
const D = R * 2;
const POCKET_R = 21;             // visual mouth
const CATCH = 19;                // capture radius

const POCKETS = [
  { x: 0,      y: 0,       corner: true  },
  { x: PW / 2, y: -5,      corner: false },
  { x: PW,     y: 0,       corner: true  },
  { x: 0,      y: PH,      corner: true  },
  { x: PW / 2, y: PH + 5,  corner: false },
  { x: PW,     y: PH,      corner: true  }
];

/* ---------------------------------------------------------------- physics constants */

const MAXV   = 1560;   // units/sec at 100 power
const FRIC   = 0.90;   // exponential damping per second
const STOP   = 12;     // speed below which a ball is parked
const CUSH   = 0.86;   // cushion restitution
const CUSHF  = 0.96;   // tangential loss on cushion
const BB     = 0.95;   // ball-to-ball restitution
const DT     = 1 / 240;
const SUBS   = 4;      // substeps per animation frame

/* ---------------------------------------------------------------- ball table */

const SPEC = {
  1:  '#EFB918', 2:  '#1F5FCB', 3:  '#CE3B2C', 4:  '#6B3FA0',
  5:  '#E0762C', 6:  '#127A4A', 7:  '#8E2C24', 8:  '#141414',
  9:  '#EFB918', 10: '#1F5FCB', 11: '#CE3B2C', 12: '#6B3FA0',
  13: '#E0762C', 14: '#127A4A', 15: '#8E2C24'
};

const groupOf = id =>
  id === 0 ? 'cue' : id === 8 ? 'eight' : id < 8 ? 'solid' : 'stripe';
const GROUP_NAME = { solid: 'Solids', stripe: 'Stripes' };

/* ---------------------------------------------------------------- state */

const G = {
  mode: 'pvp',            // 'pvp' | 'ai'
  diff: 'medium',
  balls: [],
  turn: 0,                // 0 or 1
  groups: [null, null],
  open: true,
  broken: false,
  phase: 'aim',           // 'aim' | 'shooting' | 'hand' | 'over'
  aim: 0,
  power: 55,
  called: null,           // pocket index called for the 8
  potted: [[], []],
  winner: null,
  aiBusy: false
};

let ev = null;            // live shot event record
let shotClock = 0;

/* ---------------------------------------------------------------- dom */

const $ = s => document.querySelector(s);
const menu = $('#menu'), gameEl = $('#game'), over = $('#over');
const cv = $('#table'), ctx = cv.getContext('2d', { alpha: false });
const hintEl = $('#hint'), toastEl = $('#toast');

let dpr = 1, scale = 1, portrait = false, layoutW = 0, layoutH = 0;

/* =========================================================================
   RACK & SETUP
   ========================================================================= */

function makeBall(id, x, y) {
  return { id, x, y, vx: 0, vy: 0, out: false, roll: Math.random() * 6.283, spin: Math.random() * 6.283 };
}

function rack() {
  const b = [makeBall(0, PW * 0.24, PH / 2)];
  const rows = [[1], [11, 2], [3, 8, 10], [9, 7, 12, 4], [5, 13, 15, 6, 14]];
  const gap = D + 0.6;
  const apex = { x: PW * 0.70, y: PH / 2 };
  rows.forEach((row, r) => {
    const x = apex.x + r * gap * 0.866;
    row.forEach((id, i) => {
      const y = apex.y + (i - (row.length - 1) / 2) * gap;
      b.push(makeBall(id, x, y));
    });
  });
  b.sort((p, q) => p.id - q.id);
  return b;
}

function newGame(keepSettings) {
  G.balls = rack();
  G.turn = 0;
  G.groups = [null, null];
  G.open = true;
  G.broken = false;
  G.phase = 'aim';
  G.aim = 0;
  G.power = 62;
  G.called = null;
  G.potted = [[], []];
  G.winner = null;
  G.aiBusy = false;
  ev = null;
  if (!keepSettings) { /* settings arrive from the menu */ }
  over.hidden = true;
  syncUI();
  save();
}

/* =========================================================================
   PHYSICS  — operates on any ball array, so the AI can run it headless
   ========================================================================= */

function newEv() {
  return { potted: [], first: null, contact: false, railAfter: false, anyRail: false };
}

function step(balls, dt, e) {
  let moving = false;

  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (b.out) continue;
    if (b.vx || b.vy) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      const sp = Math.hypot(b.vx, b.vy);
      b.roll += sp * dt / R;
      moving = true;
    }
  }

  /* pockets first: the jaws win over the cushions */
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (b.out) continue;
    let drop = -1, near = 1e9;
    for (let p = 0; p < POCKETS.length; p++) {
      const P = POCKETS[p];
      const d = Math.hypot(b.x - P.x, b.y - P.y);
      if (d < near) { near = d; }
      if (d < CATCH) { drop = p; break; }
    }
    /* anything that slipped past the jaws is in the pocket, not off the table */
    if (drop < 0 && (b.x < -1 || b.x > PW + 1 || b.y < -1 || b.y > PH + 1)) {
      let bd = 1e9;
      for (let p = 0; p < POCKETS.length; p++) {
        const d = Math.hypot(b.x - POCKETS[p].x, b.y - POCKETS[p].y);
        if (d < bd) { bd = d; drop = p; }
      }
    }
    if (drop >= 0) {
      b.out = true; b.vx = b.vy = 0;
      e.potted.push({ id: b.id, pocket: drop });
      if (e.contact || b.id === 0) e.railAfter = true;
    }
  }

  /* cushions */
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (b.out) continue;
    let near = false;
    for (let p = 0; p < POCKETS.length; p++) {
      const P = POCKETS[p];
      if (Math.hypot(b.x - P.x, b.y - P.y) < POCKET_R + R * 0.55) { near = true; break; }
    }
    if (near) continue;

    let hit = false;
    if (b.x < R)      { b.x = R;      b.vx = Math.abs(b.vx) * CUSH;  b.vy *= CUSHF; hit = true; }
    if (b.x > PW - R) { b.x = PW - R; b.vx = -Math.abs(b.vx) * CUSH; b.vy *= CUSHF; hit = true; }
    if (b.y < R)      { b.y = R;      b.vy = Math.abs(b.vy) * CUSH;  b.vx *= CUSHF; hit = true; }
    if (b.y > PH - R) { b.y = PH - R; b.vy = -Math.abs(b.vy) * CUSH; b.vx *= CUSHF; hit = true; }
    if (hit) { e.anyRail = true; if (e.contact) e.railAfter = true; }
  }

  /* ball to ball */
  for (let i = 0; i < balls.length; i++) {
    const a = balls[i];
    if (a.out) continue;
    for (let j = i + 1; j < balls.length; j++) {
      const b = balls[j];
      if (b.out) continue;
      let dx = b.x - a.x, dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 >= D * D || d2 === 0) continue;

      const d = Math.sqrt(d2);
      const nx = dx / d, ny = dy / d;
      const push = (D - d) / 2 + 0.02;
      a.x -= nx * push; a.y -= ny * push;
      b.x += nx * push; b.y += ny * push;

      const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (vn > 0) continue;
      const imp = -(1 + BB) * vn / 2;
      a.vx -= imp * nx; a.vy -= imp * ny;
      b.vx += imp * nx; b.vy += imp * ny;

      if ((a.id === 0 || b.id === 0) && e.first === null) {
        e.first = a.id === 0 ? b.id : a.id;
        e.contact = true;
      }
    }
  }

  /* friction */
  const k = Math.exp(-FRIC * dt);
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (b.out || (!b.vx && !b.vy)) continue;
    b.vx *= k; b.vy *= k;
    if (Math.hypot(b.vx, b.vy) < STOP) { b.vx = 0; b.vy = 0; }
  }

  return moving;
}

function allStopped(balls) {
  for (const b of balls) if (!b.out && (b.vx || b.vy)) return false;
  return true;
}

/* =========================================================================
   HEADLESS SIMULATION (for the computer opponent)
   ========================================================================= */

function cloneBalls(balls) {
  const out = new Array(balls.length);
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    out[i] = { id: b.id, x: b.x, y: b.y, vx: 0, vy: 0, out: b.out, roll: 0, spin: 0 };
  }
  return out;
}

function simulate(balls, angle, power) {
  const s = cloneBalls(balls);
  const cue = s[0];
  const v = MAXV * (power / 100);
  cue.vx = Math.cos(angle) * v;
  cue.vy = Math.sin(angle) * v;
  const e = newEv();
  const dt = 1 / 120;
  for (let i = 0; i < 1400; i++) {
    step(s, dt, e);
    if (allStopped(s)) break;
  }
  return { balls: s, e };
}

/* =========================================================================
   RULES
   ========================================================================= */

function onTable(balls, g) {
  let n = 0;
  for (const b of balls) if (!b.out && groupOf(b.id) === g) n++;
  return n;
}

function legalTargets(balls, player) {
  const g = G.groups[player];
  if (g === null) {
    const ids = [];
    for (const b of balls) if (!b.out && b.id !== 0 && b.id !== 8) ids.push(b.id);
    return ids;
  }
  if (onTable(balls, g) === 0) return [8];
  const ids = [];
  for (const b of balls) if (!b.out && groupOf(b.id) === g) ids.push(b.id);
  return ids;
}

function isLegalFirst(balls, player, firstId) {
  if (firstId === null) return false;
  return legalTargets(balls, player).indexOf(firstId) !== -1;
}

/* Called once every ball has parked. */
function resolveShot() {
  const me = G.turn, opp = 1 - me;
  const e = ev;
  const pottedIds = e.potted.map(p => p.id);
  const scratch = pottedIds.indexOf(0) !== -1;
  const eight = e.potted.find(p => p.id === 8);

  /* what was legal to hit, measured before the shot cleared the table */
  const legalHit = isLegalFirst(preShot, me, e.first);
  const clearedBefore = G.groups[me] !== null && onTable(preShot, G.groups[me]) === 0;

  let foul = false, why = '';
  if (!e.contact)               { foul = true; why = 'No contact — free ball'; }
  else if (!legalHit)           { foul = true; why = 'Wrong ball first — free ball'; }
  else if (!e.railAfter)        { foul = true; why = 'No rail after contact — free ball'; }
  if (scratch)                  { foul = true; why = 'Scratch — free ball'; }

  /* return pocketed cue ball & log the rest */
  for (const p of e.potted) {
    if (p.id === 0) continue;
    if (p.id === 8) continue;
    const owner = G.groups[0] === groupOf(p.id) ? 0 : G.groups[1] === groupOf(p.id) ? 1 : null;
    if (owner !== null) G.potted[owner].push(p.id);
    else G.potted[me].push(p.id);           // open table: credited on assignment below
  }

  /* eight ball ends it, one way or the other */
  if (eight) {
    const legalEight = clearedBefore && legalHit && !scratch && e.railAfter &&
                       G.called !== null && G.called === eight.pocket;
    if (legalEight) return endGame(me, 'The eight dropped in the called pocket.');
    if (!clearedBefore) return endGame(opp, 'The eight went down early.');
    if (scratch) return endGame(opp, 'Scratched on the eight.');
    if (G.called !== null && G.called !== eight.pocket) return endGame(opp, 'The eight found the wrong pocket.');
    return endGame(opp, 'Illegal shot on the eight.');
  }

  /* group assignment: first legal pot after the break opens the table */
  const madeIds = pottedIds.filter(id => id !== 0 && id !== 8);
  if (G.open && G.broken && !foul && madeIds.length) {
    const g = groupOf(madeIds[0]);
    G.groups[me] = g;
    G.groups[opp] = g === 'solid' ? 'stripe' : 'solid';
    G.open = false;
    /* re-sort everything pocketed so far into the right rack */
    const all = G.potted[0].concat(G.potted[1]);
    G.potted = [[], []];
    for (const id of all) G.potted[G.groups[0] === groupOf(id) ? 0 : 1].push(id);
    toast('You have ' + GROUP_NAME[g].toLowerCase());
  }

  if (!G.broken) G.broken = true;

  /* put the cue ball back for a fresh placement */
  if (scratch) {
    const cue = G.balls[0];
    cue.out = false; cue.vx = cue.vy = 0;
    cue.x = PW * 0.24; cue.y = PH / 2;
  }

  const potMine = madeIds.some(id =>
    G.groups[me] === null ? true : groupOf(id) === G.groups[me]);

  if (foul) {
    G.turn = opp;
    G.phase = 'hand';
    toast(why);
  } else if (potMine) {
    G.phase = 'aim';
  } else {
    G.turn = opp;
    G.phase = 'aim';
  }

  G.called = null;
  G.power = Math.min(G.power, 80);
  ev = null;
  syncUI();
  save();
  if (G.mode === 'ai' && G.turn === 1) queueAI();
}

function endGame(winner, body) {
  G.winner = winner;
  G.phase = 'over';
  ev = null;
  $('#overTitle').textContent = playerName(winner) + ' win' + (G.mode === 'ai' && winner === 0 ? '' : 's');
  $('#overBody').textContent = body;
  $('#overEyebrow').textContent = G.mode === 'ai'
    ? (winner === 0 ? 'Well played' : 'Rack over')
    : 'Rack over';
  over.hidden = false;
  syncUI();
  localStorage.removeItem('break8.save');
}

/* =========================================================================
   SHOOTING
   ========================================================================= */

let preShot = null;

function fire(angle, power) {
  if (G.phase !== 'aim' || G.winner !== null) return;
  if (needsCall() && G.called === null) { toast('Call a pocket for the eight'); return; }
  if (power < 4) return;

  preShot = cloneBalls(G.balls);
  const cue = G.balls[0];
  const v = MAXV * (power / 100);
  cue.vx = Math.cos(angle) * v;
  cue.vy = Math.sin(angle) * v;
  ev = newEv();
  shotClock = 0;
  G.phase = 'shooting';
  G.aiBusy = false;
  syncUI();
}

function needsCall() {
  const g = G.groups[G.turn];
  return g !== null && onTable(G.balls, g) === 0 && !G.balls[8].out;
}

/* =========================================================================
   COMPUTER OPPONENT
   ========================================================================= */

const clearPath = (balls, ax, ay, bx, by, ignore) => {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 0.001) return true;
  const ux = dx / len, uy = dy / len;
  for (const b of balls) {
    if (b.out || ignore.indexOf(b.id) !== -1) continue;
    const t = (b.x - ax) * ux + (b.y - ay) * uy;
    if (t < -R || t > len + R) continue;
    const px = ax + ux * Math.max(0, Math.min(len, t));
    const py = ay + uy * Math.max(0, Math.min(len, t));
    if (Math.hypot(b.x - px, b.y - py) < D - 0.5) return false;
  }
  return true;
};

function directCandidates(balls, player) {
  const cue = balls[0];
  const out = [];
  for (const id of legalTargets(balls, player)) {
    const t = balls[id];
    if (!t || t.out) continue;
    for (let pi = 0; pi < POCKETS.length; pi++) {
      const P = POCKETS[pi];
      const tp = Math.hypot(P.x - t.x, P.y - t.y);
      if (tp < 1) continue;
      const ux = (P.x - t.x) / tp, uy = (P.y - t.y) / tp;
      const gx = t.x - ux * D, gy = t.y - uy * D;
      if (gx < R || gx > PW - R || gy < R || gy > PH - R) continue;

      const cg = Math.hypot(gx - cue.x, gy - cue.y);
      if (cg < R) continue;
      const ax = (gx - cue.x) / cg, ay = (gy - cue.y) / cg;
      const cut = ax * ux + ay * uy;
      if (cut < 0.22) continue;                       // cut angle too thin
      if (!clearPath(balls, cue.x, cue.y, gx, gy, [0, id])) continue;
      if (!clearPath(balls, t.x, t.y, P.x, P.y, [id])) continue;

      const dist = cg + tp;
      let pw = 30 + dist / 12 + (1 - cut) * 34;
      pw = Math.max(24, Math.min(94, pw));
      out.push({
        angle: Math.atan2(ay, ax), power: pw, kind: 'pot',
        target: id, pocket: pi,
        rank: cut * cut * 900 / (dist + 120)
      });
    }
  }
  return out;
}

function bankCandidates(balls, player) {
  const cue = balls[0];
  const out = [];
  const walls = [
    { axis: 'y', v: R },       { axis: 'y', v: PH - R },
    { axis: 'x', v: R },       { axis: 'x', v: PW - R }
  ];
  for (const id of legalTargets(balls, player)) {
    const t = balls[id];
    if (!t || t.out) continue;
    for (let pi = 0; pi < POCKETS.length; pi++) {
      const P = POCKETS[pi];
      for (const w of walls) {
        const M = w.axis === 'y'
          ? { x: P.x, y: 2 * w.v - P.y }
          : { x: 2 * w.v - P.x, y: P.y };
        const tm = Math.hypot(M.x - t.x, M.y - t.y);
        if (tm < 1) continue;
        const ux = (M.x - t.x) / tm, uy = (M.y - t.y) / tm;
        const gx = t.x - ux * D, gy = t.y - uy * D;
        if (gx < R || gx > PW - R || gy < R || gy > PH - R) continue;
        const cg = Math.hypot(gx - cue.x, gy - cue.y);
        if (cg < R) continue;
        const ax = (gx - cue.x) / cg, ay = (gy - cue.y) / cg;
        if (ax * ux + ay * uy < 0.6) continue;
        if (!clearPath(balls, cue.x, cue.y, gx, gy, [0, id])) continue;
        out.push({ angle: Math.atan2(ay, ax), power: Math.min(96, 52 + cg / 14), kind: 'bank', target: id, pocket: pi });
      }
    }
  }
  return out;
}

function safetyCandidates(balls, player) {
  const cue = balls[0];
  const out = [];
  for (const id of legalTargets(balls, player)) {
    const t = balls[id];
    if (!t || t.out) continue;
    if (!clearPath(balls, cue.x, cue.y, t.x, t.y, [0, id])) continue;
    const base = Math.atan2(t.y - cue.y, t.x - cue.x);
    for (const off of [-0.14, -0.05, 0, 0.05, 0.14]) {
      for (const pw of [18, 28]) {
        out.push({ angle: base + off, power: pw, kind: 'safe', target: id, pocket: -1 });
      }
    }
  }
  return out;
}

function easeOfNextShot(balls, player) {
  let n = 0;
  const cue = balls[0];
  if (cue.out) return 0;
  for (const id of legalTargets(balls, player)) {
    const t = balls[id];
    if (!t || t.out) continue;
    for (const P of POCKETS) {
      const tp = Math.hypot(P.x - t.x, P.y - t.y);
      const ux = (P.x - t.x) / tp, uy = (P.y - t.y) / tp;
      const gx = t.x - ux * D, gy = t.y - uy * D;
      const cg = Math.hypot(gx - cue.x, gy - cue.y);
      if (cg < 1) continue;
      const ax = (gx - cue.x) / cg, ay = (gy - cue.y) / cg;
      if (ax * ux + ay * uy < 0.3) continue;
      if (!clearPath(balls, cue.x, cue.y, gx, gy, [0, id])) continue;
      if (!clearPath(balls, t.x, t.y, P.x, P.y, [id])) continue;
      n++;
    }
  }
  return n;
}

function scoreOutcome(before, after, e, player) {
  const opp = 1 - player;
  const myGroup = G.groups[player];
  let s = 0;

  const pottedIds = e.potted.map(p => p.id);
  const scratch = pottedIds.indexOf(0) !== -1;
  const legalHit = isLegalFirst(before, player, e.first);
  const foul = !e.contact || !legalHit || !e.railAfter || scratch;

  if (foul) s -= 420;
  if (scratch) s -= 160;

  for (const p of e.potted) {
    if (p.id === 0) continue;
    if (p.id === 8) {
      const cleared = myGroup !== null && onTable(before, myGroup) === 0;
      s += (cleared && !foul && G.called === p.pocket) ? 5000 : -5000;
      continue;
    }
    const g = groupOf(p.id);
    if (myGroup === null) s += 120;
    else if (g === myGroup) s += 160;
    else s -= 90;
  }

  s += easeOfNextShot(after, player) * 9;
  s -= easeOfNextShot(after, opp) * 5;

  /* safeties like distance between the cue ball and the opponent's work */
  if (after[0] && !after[0].out) {
    let near = 1e9;
    for (const b of after) {
      if (b.out || b.id === 0) continue;
      if (G.groups[opp] && groupOf(b.id) !== G.groups[opp]) continue;
      near = Math.min(near, Math.hypot(b.x - after[0].x, b.y - after[0].y));
    }
    if (near < 1e9) s += Math.min(near, 400) * 0.05;
  }
  return s;
}

function aiPlaceCueBall() {
  const balls = G.balls;
  let best = null, bestScore = -1e9;
  for (let ix = 1; ix <= 9; ix++) {
    for (let iy = 1; iy <= 5; iy++) {
      const x = (PW / 10) * ix, y = (PH / 6) * iy;
      let ok = true;
      for (const b of balls) {
        if (b.out || b.id === 0) continue;
        if (Math.hypot(b.x - x, b.y - y) < D + 2) { ok = false; break; }
      }
      if (!ok) continue;
      const trial = cloneBalls(balls);
      trial[0].x = x; trial[0].y = y; trial[0].out = false;
      const sc = easeOfNextShot(trial, 1) * 10 - Math.random() * 3;
      if (sc > bestScore) { bestScore = sc; best = { x, y }; }
    }
  }
  if (best) { balls[0].x = best.x; balls[0].y = best.y; balls[0].out = false; }
}

function aiChooseCall() {
  /* pick the pocket the eight can actually reach */
  const balls = G.balls, cue = balls[0], eight = balls[8];
  let best = 0, bestScore = -1e9;
  for (let pi = 0; pi < POCKETS.length; pi++) {
    const P = POCKETS[pi];
    const tp = Math.hypot(P.x - eight.x, P.y - eight.y);
    const ux = (P.x - eight.x) / tp, uy = (P.y - eight.y) / tp;
    const gx = eight.x - ux * D, gy = eight.y - uy * D;
    const cg = Math.hypot(gx - cue.x, gy - cue.y) || 1;
    const ax = (gx - cue.x) / cg, ay = (gy - cue.y) / cg;
    let sc = (ax * ux + ay * uy) * 100 - tp * 0.05;
    if (!clearPath(balls, eight.x, eight.y, P.x, P.y, [8])) sc -= 200;
    if (!clearPath(balls, cue.x, cue.y, gx, gy, [0, 8])) sc -= 200;
    if (sc > bestScore) { bestScore = sc; best = pi; }
  }
  G.called = best;
}

function aiShot() {
  const balls = G.balls;
  if (needsCall()) aiChooseCall();

  const diff = G.diff;
  let list = [];

  if (diff === 'easy') {
    const targets = legalTargets(balls, 1);
    const id = targets[Math.floor(Math.random() * targets.length)];
    const t = balls[id] || balls[8];
    const cue = balls[0];
    const P = POCKETS[Math.floor(Math.random() * POCKETS.length)];
    let base = Math.atan2(t.y - cue.y, t.x - cue.x);
    const tp = Math.hypot(P.x - t.x, P.y - t.y);
    if (tp > 1) {
      const gx = t.x - (P.x - t.x) / tp * D;
      const gy = t.y - (P.y - t.y) / tp * D;
      if (gx > R && gx < PW - R && gy > R && gy < PH - R) base = Math.atan2(gy - cue.y, gx - cue.x);
    }
    return {
      angle: base + (Math.random() - 0.5) * 0.055,
      power: 30 + Math.random() * 60
    };
  }

  list = directCandidates(balls, 1);
  if (diff === 'hard') {
    list = list.concat(bankCandidates(balls, 1));
    if (list.length < 3) list = list.concat(safetyCandidates(balls, 1));
  }
  if (!list.length) list = safetyCandidates(balls, 1);
  if (!list.length) {
    const targets = legalTargets(balls, 1);
    const t = balls[targets[0]] || balls[8];
    const base = t ? Math.atan2(t.y - balls[0].y, t.x - balls[0].x) : Math.random() * 6.283;
    return { angle: base, power: 46 };
  }

  const cap = diff === 'hard' ? 30 : 16;
  list.sort((a, b) => (b.rank || 0) - (a.rank || 0));
  if (list.length > cap) list = list.slice(0, cap);

  /* the same line, struck firmer — often the difference between a pot and a hang */
  if (diff === 'hard') {
    const extra = [];
    for (const c of list.slice(0, 10)) {
      if (c.kind !== 'pot') continue;
      extra.push({ angle: c.angle, power: Math.min(98, c.power * 1.35), kind: 'pot', target: c.target, pocket: c.pocket });
      extra.push({ angle: c.angle, power: Math.max(20, c.power * 0.78), kind: 'pot', target: c.target, pocket: c.pocket });
    }
    list = list.concat(extra);
  }

  let best = list[0], bestScore = -1e9;
  for (const c of list) {
    const sim = simulate(balls, c.angle, c.power);
    let sc = scoreOutcome(balls, sim.balls, sim.e, 1);
    if (c.kind === 'bank') sc -= 30;
    if (c.kind === 'safe') sc -= 15;
    if (sc > bestScore) { bestScore = sc; best = c; }
  }

  const aErr = diff === 'hard' ? 0.005 : 0.017;
  const pErr = diff === 'hard' ? 0.03 : 0.16;
  return {
    angle: best.angle + (Math.random() - 0.5) * 2 * aErr,
    power: Math.max(14, Math.min(100, best.power * (1 + (Math.random() - 0.5) * 2 * pErr)))
  };
}

function queueAI() {
  if (G.mode !== 'ai' || G.turn !== 1 || G.winner !== null) return;
  G.aiBusy = true;
  syncUI();
  setTimeout(() => {
    if (G.turn !== 1 || G.winner !== null) { G.aiBusy = false; return; }
    if (G.phase === 'hand') { aiPlaceCueBall(); G.phase = 'aim'; }
    let shot;
    try { shot = aiShot(); }
    catch (err) { shot = { angle: Math.random() * 6.283, power: 45 }; }
    G.aim = shot.angle;
    G.power = shot.power;
    syncUI();
    setTimeout(() => {
      if (G.turn === 1 && G.winner === null && G.phase === 'aim') fire(G.aim, G.power);
      G.aiBusy = false;
    }, 520);
  }, 420);
}

/* =========================================================================
   AIM PREVIEW
   ========================================================================= */

function traceAim(balls, ox, oy, angle) {
  const pts = [{ x: ox, y: oy }];
  let px = ox, py = oy;
  let dx = Math.cos(angle), dy = Math.sin(angle);
  let hit = null;

  for (let bounce = 0; bounce < 3; bounce++) {
    let bestT = Infinity, bestBall = null;

    for (const b of balls) {
      if (b.out || b.id === 0) continue;
      const ex = b.x - px, ey = b.y - py;
      const proj = ex * dx + ey * dy;
      if (proj <= 0) continue;
      const perp2 = ex * ex + ey * ey - proj * proj;
      const rr = D * D;
      if (perp2 > rr) continue;
      const t = proj - Math.sqrt(rr - perp2);
      if (t > 0.01 && t < bestT) { bestT = t; bestBall = b; }
    }

    /* cushion */
    let wallT = Infinity, axis = null;
    if (dx > 0) { const t = (PW - R - px) / dx; if (t > 0 && t < wallT) { wallT = t; axis = 'x'; } }
    if (dx < 0) { const t = (R - px) / dx;      if (t > 0 && t < wallT) { wallT = t; axis = 'x'; } }
    if (dy > 0) { const t = (PH - R - py) / dy; if (t > 0 && t < wallT) { wallT = t; axis = 'y'; } }
    if (dy < 0) { const t = (R - py) / dy;      if (t > 0 && t < wallT) { wallT = t; axis = 'y'; } }

    if (bestBall && bestT <= wallT) {
      const gx = px + dx * bestT, gy = py + dy * bestT;
      pts.push({ x: gx, y: gy });
      const nx = (bestBall.x - gx) / D, ny = (bestBall.y - gy) / D;
      hit = { ball: bestBall, gx, gy, nx, ny };
      break;
    }

    const wx = px + dx * wallT, wy = py + dy * wallT;
    pts.push({ x: wx, y: wy });

    /* a preview that runs into a pocket mouth just ends there */
    let inPocket = false;
    for (const P of POCKETS) if (Math.hypot(wx - P.x, wy - P.y) < POCKET_R + R) inPocket = true;
    if (inPocket) break;

    px = wx; py = wy;
    if (axis === 'x') dx = -dx; else dy = -dy;
  }
  return { pts, hit };
}

/* =========================================================================
   RENDERING
   ========================================================================= */

function resize() {
  const stage = $('#stage');
  const powerW = $('#side').offsetWidth || 62;
  const availW = stage.clientWidth - powerW - 30;
  const availH = stage.clientHeight - 8;
  if (availW <= 0 || availH <= 0) return;

  portrait = availH > availW;
  const boardW = portrait ? BH : BW;
  const boardH = portrait ? BW : BH;
  scale = Math.min(availW / boardW, availH / boardH);

  layoutW = boardW * scale;
  layoutH = boardH * scale;
  dpr = Math.min(window.devicePixelRatio || 1, 3);

  cv.style.width = layoutW + 'px';
  cv.style.height = layoutH + 'px';
  cv.width = Math.round(layoutW * dpr);
  cv.height = Math.round(layoutH * dpr);
}

function setTransform() {
  if (portrait) ctx.setTransform(0, scale * dpr, -scale * dpr, 0, BH * scale * dpr, 0);
  else          ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
}

/* screen (css px, relative to canvas) -> playfield coords */
function toWorld(sx, sy) {
  let bx, by;
  if (portrait) { bx = sy / scale; by = BH - sx / scale; }
  else          { bx = sx / scale; by = sy / scale; }
  return { x: bx - RAIL, y: by - RAIL };
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function drawTable() {
  /* rail frame */
  const g = ctx.createLinearGradient(0, 0, 0, BH);
  g.addColorStop(0, '#4A2E1E');
  g.addColorStop(0.5, '#3A2419');
  g.addColorStop(1, '#25150E');
  ctx.fillStyle = g;
  roundRect(ctx, 0, 0, BW, BH, 16);
  ctx.fill();

  ctx.save();
  ctx.translate(RAIL, RAIL);

  /* felt */
  ctx.fillStyle = '#0E6B4F';
  ctx.fillRect(-4, -4, PW + 8, PH + 8);
  const vg = ctx.createRadialGradient(PW / 2, PH / 2, PH * 0.15, PW / 2, PH / 2, PW * 0.68);
  vg.addColorStop(0, 'rgba(255,255,255,.055)');
  vg.addColorStop(1, 'rgba(0,0,0,.30)');
  ctx.fillStyle = vg;
  ctx.fillRect(-4, -4, PW + 8, PH + 8);

  /* cushion shadow lip */
  ctx.strokeStyle = 'rgba(0,0,0,.32)';
  ctx.lineWidth = 5;
  ctx.strokeRect(-2, -2, PW + 4, PH + 4);

  /* head string + foot spot */
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(PW * 0.25, 0); ctx.lineTo(PW * 0.25, PH);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.10)';
  ctx.beginPath(); ctx.arc(PW * 0.70, PH / 2, 2.6, 0, 6.284); ctx.fill();

  /* pockets */
  for (let i = 0; i < POCKETS.length; i++) {
    const P = POCKETS[i];
    const pg = ctx.createRadialGradient(P.x, P.y, 2, P.x, P.y, POCKET_R);
    pg.addColorStop(0, '#000');
    pg.addColorStop(0.72, '#050505');
    pg.addColorStop(1, 'rgba(0,0,0,.25)');
    ctx.fillStyle = pg;
    ctx.beginPath(); ctx.arc(P.x, P.y, POCKET_R, 0, 6.284); ctx.fill();
    ctx.strokeStyle = 'rgba(201,162,39,.30)';
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(P.x, P.y, POCKET_R, 0, 6.284); ctx.stroke();

    if (G.called === i) {
      ctx.strokeStyle = '#C9A227';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(P.x, P.y, POCKET_R + 5, 0, 6.284); ctx.stroke();
    }
  }
  ctx.restore();

  /* brass sights */
  ctx.fillStyle = 'rgba(201,162,39,.55)';
  const sights = [];
  for (let i = 1; i <= 7; i++) if (i !== 4) sights.push({ x: RAIL + PW * i / 8, y: RAIL / 2 }, { x: RAIL + PW * i / 8, y: BH - RAIL / 2 });
  for (let i = 1; i <= 3; i++) sights.push({ x: RAIL / 2, y: RAIL + PH * i / 4 }, { x: BW - RAIL / 2, y: RAIL + PH * i / 4 });
  for (const s of sights) {
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-3, -3, 6, 6);
    ctx.restore();
  }
}

function drawBall(b) {
  const c = b.id === 0 ? '#F6F2E8' : SPEC[b.id];
  const stripe = b.id > 8;

  ctx.save();
  ctx.translate(b.x, b.y);

  /* shadow */
  ctx.fillStyle = 'rgba(0,0,0,.34)';
  ctx.beginPath(); ctx.ellipse(1.6, 3.2, R * 1.02, R * 0.92, 0, 0, 6.284); ctx.fill();

  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, R, 0, 6.284); ctx.clip();

  if (stripe) {
    ctx.fillStyle = '#F6F2E8';
    ctx.fillRect(-R, -R, D, D);
    ctx.save();
    ctx.rotate(b.roll * 0.35);
    ctx.fillStyle = c;
    ctx.fillRect(-R, -R * 0.52, D, R * 1.04);
    ctx.restore();
  } else {
    ctx.fillStyle = c;
    ctx.fillRect(-R, -R, D, D);
  }

  /* shading */
  const sh = ctx.createRadialGradient(-R * 0.35, -R * 0.4, R * 0.15, 0, 0, R * 1.15);
  sh.addColorStop(0, 'rgba(255,255,255,.42)');
  sh.addColorStop(0.45, 'rgba(255,255,255,0)');
  sh.addColorStop(1, 'rgba(0,0,0,.48)');
  ctx.fillStyle = sh;
  ctx.fillRect(-R, -R, D, D);
  ctx.restore();

  /* number spot */
  if (b.id !== 0) {
    ctx.save();
    ctx.rotate(b.roll * 0.35);
    ctx.fillStyle = 'rgba(246,242,232,.96)';
    ctx.beginPath(); ctx.arc(0, 0, R * 0.44, 0, 6.284); ctx.fill();
    ctx.restore();
  }

  /* specular */
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  ctx.beginPath(); ctx.ellipse(-R * 0.36, -R * 0.42, R * 0.20, R * 0.14, -0.7, 0, 6.284); ctx.fill();

  ctx.strokeStyle = 'rgba(0,0,0,.25)';
  ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.arc(0, 0, R - 0.4, 0, 6.284); ctx.stroke();
  ctx.restore();
}

function drawAim() {
  const cue = G.balls[0];
  if (cue.out) return;
  const { pts, hit } = traceAim(G.balls, cue.x, cue.y, G.aim);

  ctx.save();
  ctx.translate(RAIL, RAIL);

  ctx.setLineDash([9, 8]);
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = 'rgba(243,239,230,.55)';
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  ctx.setLineDash([]);

  if (hit) {
    /* ghost cue ball */
    ctx.strokeStyle = 'rgba(243,239,230,.75)';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(hit.gx, hit.gy, R, 0, 6.284); ctx.stroke();

    /* object ball departure */
    ctx.strokeStyle = 'rgba(201,162,39,.9)';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(hit.ball.x, hit.ball.y);
    ctx.lineTo(hit.ball.x + hit.nx * 74, hit.ball.y + hit.ny * 74);
    ctx.stroke();
  }

  /* cue stick */
  const back = 26 + G.power * 0.55;
  const ux = Math.cos(G.aim), uy = Math.sin(G.aim);
  const sx = cue.x - ux * back, sy = cue.y - uy * back;
  const ex = cue.x - ux * (back + 300), ey = cue.y - uy * (back + 300);
  const grad = ctx.createLinearGradient(sx, sy, ex, ey);
  grad.addColorStop(0, '#EFE3C8');
  grad.addColorStop(0.08, '#C9A96E');
  grad.addColorStop(0.62, '#8A5A32');
  grad.addColorStop(1, '#2A1A11');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 5.2;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();

  ctx.strokeStyle = '#5B8FB9';
  ctx.lineWidth = 5.2;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(sx - ux * 7, sy - uy * 7);
  ctx.stroke();

  ctx.restore();
}

function drawHand() {
  const cue = G.balls[0];
  ctx.save();
  ctx.translate(RAIL, RAIL);
  const ok = handValid(cue.x, cue.y);
  ctx.strokeStyle = ok ? 'rgba(201,162,39,.9)' : 'rgba(196,85,61,.95)';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  ctx.beginPath(); ctx.arc(cue.x, cue.y, R + 7, 0, 6.284); ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function draw() {
  setTransform();
  ctx.fillStyle = '#0B100E';
  ctx.fillRect(0, 0, BW, BH);
  drawTable();

  ctx.save();
  ctx.translate(RAIL, RAIL);
  for (const b of G.balls) if (!b.out) drawBall(b);
  ctx.restore();

  if (G.phase === 'aim' && G.winner === null) drawAim();
  if (G.phase === 'hand') drawHand();
}

/* =========================================================================
   LOOP
   ========================================================================= */

function frame() {
  if (G.phase === 'shooting') {
    for (let i = 0; i < SUBS; i++) step(G.balls, DT, ev);
    shotClock += SUBS * DT;
    if (allStopped(G.balls) || shotClock > 18) {
      for (const b of G.balls) { b.vx = 0; b.vy = 0; }
      resolveShot();
    }
  }
  draw();
  requestAnimationFrame(frame);
}

/* =========================================================================
   BALL IN HAND
   ========================================================================= */

function handValid(x, y) {
  if (x < R + 1 || x > PW - R - 1 || y < R + 1 || y > PH - R - 1) return false;
  for (const P of POCKETS) if (Math.hypot(x - P.x, y - P.y) < POCKET_R + R * 0.4) return false;
  for (const b of G.balls) {
    if (b.out || b.id === 0) continue;
    if (Math.hypot(b.x - x, b.y - y) < D + 0.6) return false;
  }
  return true;
}

/* =========================================================================
   INPUT
   ========================================================================= */

let dragging = false, dragMoved = false, dragStart = null;

function canvasPoint(e) {
  const r = cv.getBoundingClientRect();
  return toWorld(e.clientX - r.left, e.clientY - r.top);
}

function humanTurn() {
  return G.winner === null && !(G.mode === 'ai' && G.turn === 1);
}

cv.addEventListener('pointerdown', e => {
  if (!humanTurn()) return;
  e.preventDefault();
  cv.setPointerCapture(e.pointerId);
  dragging = true; dragMoved = false;
  const p = canvasPoint(e);
  dragStart = p;

  if (G.phase === 'hand') {
    G.balls[0].x = p.x; G.balls[0].y = p.y;
  } else if (G.phase === 'aim') {
    aimAt(p);
  }
});

cv.addEventListener('pointermove', e => {
  if (!dragging || !humanTurn()) return;
  e.preventDefault();
  const p = canvasPoint(e);
  if (Math.hypot(p.x - dragStart.x, p.y - dragStart.y) > 6) dragMoved = true;
  if (G.phase === 'hand') { G.balls[0].x = p.x; G.balls[0].y = p.y; }
  else if (G.phase === 'aim') aimAt(p);
});

cv.addEventListener('pointerup', e => {
  if (!dragging) return;
  dragging = false;
  const p = canvasPoint(e);

  if (G.phase === 'hand') {
    if (handValid(p.x, p.y)) {
      G.balls[0].x = p.x; G.balls[0].y = p.y;
      G.phase = 'aim';
      syncUI(); save();
    } else {
      toast('Not there — pick clear felt');
    }
    return;
  }

  /* a tap near a pocket calls the eight */
  if (!dragMoved && needsCall()) {
    for (let i = 0; i < POCKETS.length; i++) {
      if (Math.hypot(p.x - POCKETS[i].x, p.y - POCKETS[i].y) < POCKET_R * 2.1) {
        G.called = i;
        toast('Eight called');
        syncUI();
        return;
      }
    }
  }
});

cv.addEventListener('pointercancel', () => { dragging = false; });

function aimAt(p) {
  const cue = G.balls[0];
  const dx = p.x - cue.x, dy = p.y - cue.y;
  if (Math.hypot(dx, dy) < 4) return;
  G.aim = Math.atan2(dy, dx);
}

/* ---- power meter ---- */

const powerEl = $('#power'), fillEl = $('#powerFill'), gripEl = $('#powerGrip'), valEl = $('#powerVal');
let powerDrag = false;

function powerFromEvent(e) {
  const track = powerEl.querySelector('.power-track').getBoundingClientRect();
  const t = 1 - (e.clientY - track.top) / track.height;
  return Math.max(0, Math.min(100, Math.round(t * 100)));
}

powerEl.addEventListener('pointerdown', e => {
  if (!humanTurn() || G.phase !== 'aim') return;
  e.preventDefault();
  powerEl.setPointerCapture(e.pointerId);
  powerDrag = true;
  setPower(powerFromEvent(e));
});
powerEl.addEventListener('pointermove', e => {
  if (!powerDrag) return;
  e.preventDefault();
  setPower(powerFromEvent(e));
});
powerEl.addEventListener('pointerup', () => {
  if (!powerDrag) return;
  powerDrag = false;
  if (G.phase === 'aim' && humanTurn() && G.power >= 5) fire(G.aim, G.power);
});
powerEl.addEventListener('pointercancel', () => { powerDrag = false; });

function setPower(v) {
  G.power = Math.max(0, Math.min(100, v));
  paintPower();
}

function paintPower() {
  const p = Math.round(G.power);
  fillEl.style.height = p + '%';
  gripEl.style.bottom = 'calc(' + p + '% - 28px)';
  valEl.textContent = p;
  powerEl.setAttribute('aria-valuenow', p);
}

/* ---- buttons ---- */

function nudge(delta) {
  if (!humanTurn() || G.phase !== 'aim') return;
  G.aim += delta;
}
function holdRepeat(el, fn) {
  let timer = null, iv = null;
  const start = e => {
    e.preventDefault();
    fn();
    timer = setTimeout(() => { iv = setInterval(fn, 40); }, 320);
  };
  const stop = () => { clearTimeout(timer); clearInterval(iv); };
  el.addEventListener('pointerdown', start);
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointerleave', stop);
  el.addEventListener('pointercancel', stop);
}

holdRepeat($('#aimLeft'),  () => nudge(-0.0055));
holdRepeat($('#aimRight'), () => nudge(0.0055));
holdRepeat($('#powerDown'), () => { if (humanTurn() && G.phase === 'aim') setPower(G.power - 5); });
holdRepeat($('#powerUp'),   () => { if (humanTurn() && G.phase === 'aim') setPower(G.power + 5); });

$('#strike').addEventListener('click', () => {
  if (humanTurn() && G.phase === 'aim') fire(G.aim, G.power);
});

$('#resetShot').addEventListener('click', () => {
  if (!humanTurn() || G.phase !== 'aim') return;
  setPower(50);
  const cue = G.balls[0];
  const targets = legalTargets(G.balls, G.turn);
  let best = null, bd = Infinity;
  for (const id of targets) {
    const b = G.balls[id];
    if (!b || b.out) continue;
    const d = Math.hypot(b.x - cue.x, b.y - cue.y);
    if (d < bd) { bd = d; best = b; }
  }
  if (best) G.aim = Math.atan2(best.y - cue.y, best.x - cue.x);
  G.called = null;
  syncUI();
});

$('#menuBtn').addEventListener('click', () => {
  save();
  gameEl.hidden = true;
  menu.hidden = false;
  over.hidden = true;
  refreshMenu();
});

$('#newBtn').addEventListener('click', () => {
  newGame(true);
  if (G.mode === 'ai' && G.turn === 1) queueAI();
});

$('#againBtn').addEventListener('click', () => {
  over.hidden = true;
  newGame(true);
  if (G.mode === 'ai' && G.turn === 1) queueAI();
});

$('#overMenuBtn').addEventListener('click', () => {
  over.hidden = true;
  gameEl.hidden = true;
  menu.hidden = false;
  refreshMenu();
});

/* =========================================================================
   MENU
   ========================================================================= */

const DIFF_NOTE = {
  easy:   'Aims by eye, hits too hard or too soft, and takes whatever ball it sees first.',
  medium: 'Sinks what it sees, misjudges pace now and then, reads a bounce off one cushion.',
  hard:   'Precise on line and pace, banks when the path is blocked, and plays safe rather than gamble.'
};

let pendingMode = null;

document.querySelectorAll('.mode-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('is-on'));
    card.classList.add('is-on');
    pendingMode = card.dataset.mode;
    $('#diffBlock').hidden = pendingMode !== 'ai';
  });
});

document.querySelectorAll('.seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('is-on'));
    btn.classList.add('is-on');
    G.diff = btn.dataset.diff;
    $('#diffNote').textContent = DIFF_NOTE[G.diff];
  });
});

$('#startBtn').addEventListener('click', () => {
  G.mode = pendingMode || 'pvp';
  localStorage.setItem('break8.prefs', JSON.stringify({ mode: G.mode, diff: G.diff }));
  menu.hidden = true;
  gameEl.hidden = false;
  newGame(true);
  requestAnimationFrame(() => { resize(); syncUI(); });
});

$('#resumeBtn').addEventListener('click', () => {
  if (!load()) return;
  menu.hidden = true;
  gameEl.hidden = false;
  requestAnimationFrame(() => {
    resize(); syncUI();
    if (G.mode === 'ai' && G.turn === 1) queueAI();
  });
});

function refreshMenu() {
  const saved = localStorage.getItem('break8.save');
  $('#resumeBtn').hidden = !saved;
  try {
    const p = JSON.parse(localStorage.getItem('break8.prefs') || '{}');
    if (p.mode) {
      pendingMode = p.mode;
      document.querySelectorAll('.mode-card').forEach(c =>
        c.classList.toggle('is-on', c.dataset.mode === p.mode));
      $('#diffBlock').hidden = p.mode !== 'ai';
    }
    if (p.diff) {
      G.diff = p.diff;
      document.querySelectorAll('.seg-btn').forEach(b =>
        b.classList.toggle('is-on', b.dataset.diff === p.diff));
      $('#diffNote').textContent = DIFF_NOTE[p.diff];
    }
  } catch (err) { /* first run */ }
}

/* =========================================================================
   HUD
   ========================================================================= */

function playerName(i) {
  if (G.mode === 'ai') return i === 0 ? 'You' : 'Computer';
  return 'Player ' + (i + 1);
}

function syncUI() {
  $('#nameP1').textContent = playerName(0);
  $('#nameP2').textContent = playerName(1);

  $('#matchLabel').textContent = G.mode === 'ai'
    ? 'Vs. computer · ' + G.diff
    : 'Two players';

  const turnEl = $('#turnLabel');
  turnEl.classList.toggle('is-ai', G.mode === 'ai' && G.turn === 1);

  if (G.winner !== null) {
    turnEl.textContent = playerName(G.winner) + ' wins';
  } else if (G.phase === 'shooting') {
    turnEl.textContent = 'Balls rolling';
  } else if (G.aiBusy) {
    turnEl.textContent = 'Computer is lining up';
  } else if (G.phase === 'hand') {
    turnEl.textContent = playerName(G.turn) + ' — place the cue ball';
  } else if (!G.broken) {
    turnEl.textContent = playerName(G.turn) + ' to break';
  } else if (needsCall()) {
    turnEl.textContent = G.called === null
      ? playerName(G.turn) + ' — call a pocket'
      : playerName(G.turn) + ' on the eight';
  } else {
    turnEl.textContent = playerName(G.turn) + ' to shoot';
  }

  for (const i of [0, 1]) {
    const rackEl = i === 0 ? $('#rackP1') : $('#rackP2');
    rackEl.classList.toggle('is-active', G.turn === i && G.winner === null);
    const g = G.groups[i];
    (i === 0 ? $('#groupP1') : $('#groupP2')).textContent =
      g ? GROUP_NAME[g] : (G.open ? 'Open' : '—');

    const pips = i === 0 ? $('#pipsP1') : $('#pipsP2');
    pips.innerHTML = '';
    for (const id of G.potted[i]) {
      const d = document.createElement('span');
      d.className = 'pip' + (id > 8 ? ' stripe' : '');
      d.style.background = SPEC[id];
      d.innerHTML = '<b>' + id + '</b>';
      pips.appendChild(d);
    }
  }

  const canAct = humanTurn() && G.phase === 'aim';
  ['#strike', '#aimLeft', '#aimRight', '#powerDown', '#powerUp', '#resetShot']
    .forEach(s => { $(s).disabled = !canAct; });
  $('#strike').disabled = !canAct || (needsCall() && G.called === null);

  if (G.phase === 'hand' && humanTurn()) showHint('Drag the cue ball onto clear felt');
  else if (canAct && needsCall() && G.called === null) showHint('Tap a pocket to call the eight');
  else if (canAct && !G.broken) showHint('Drag to aim · pull the slider to strike');
  else showHint('');

  paintPower();
}

let hintTimer = null;
function showHint(text) {
  if (!text) { hintEl.classList.remove('show'); return; }
  hintEl.textContent = text;
  hintEl.classList.add('show');
}

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2200);
}

/* =========================================================================
   PERSISTENCE
   ========================================================================= */

function save() {
  if (G.winner !== null) { localStorage.removeItem('break8.save'); return; }
  try {
    localStorage.setItem('break8.save', JSON.stringify({
      v: 1,
      mode: G.mode, diff: G.diff, turn: G.turn,
      groups: G.groups, open: G.open, broken: G.broken,
      phase: G.phase === 'shooting' ? 'aim' : G.phase,
      aim: G.aim, power: G.power, called: G.called, potted: G.potted,
      balls: G.balls.map(b => ({ i: b.id, x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, o: b.out ? 1 : 0 }))
    }));
  } catch (err) { /* storage full or blocked */ }
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem('break8.save') || 'null');
    if (!s || s.v !== 1) return false;
    G.mode = s.mode; G.diff = s.diff; G.turn = s.turn;
    G.groups = s.groups; G.open = s.open; G.broken = s.broken;
    G.phase = s.phase; G.aim = s.aim; G.power = s.power;
    G.called = s.called; G.potted = s.potted;
    G.winner = null; G.aiBusy = false; ev = null;
    G.balls = s.balls.map(b => {
      const nb = makeBall(b.i, b.x, b.y);
      nb.out = !!b.o;
      return nb;
    });
    G.balls.sort((a, b) => a.id - b.id);
    return true;
  } catch (err) { return false; }
}

window.addEventListener('pagehide', save);
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });

/* =========================================================================
   BROWSER CHROME SUPPRESSION
   ========================================================================= */

document.addEventListener('touchmove', e => {
  if (e.target && e.target.closest && e.target.closest('#menu')) return;
  e.preventDefault();
}, { passive: false });
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('gesturechange', e => e.preventDefault());
document.addEventListener('dblclick', e => e.preventDefault());
document.addEventListener('contextmenu', e => e.preventDefault());

let lastTouch = 0;
document.addEventListener('touchend', e => {
  const now = Date.now();
  if (now - lastTouch < 320) e.preventDefault();
  lastTouch = now;
}, { passive: false });

window.addEventListener('resize', () => { resize(); });
window.addEventListener('orientationchange', () => setTimeout(resize, 220));

/* =========================================================================
   BOOT
   ========================================================================= */

refreshMenu();
newGame(true);
resize();
syncUI();
requestAnimationFrame(frame);

if (typeof window !== 'undefined' && window.__BREAK_TEST__) {
  window.__BREAK__ = { G, step, simulate, aiShot, fire, allStopped, newGame,
                       legalTargets, resolveShot, frame, POCKETS, handValid, queueAI, syncUI };
}

// No service worker here. The arcade's sw.js caches this game already, and a
// second worker on the same origin would delete the arcade's cache on activate.

// Inside an iframe the first layout pass can report zero size, so measure again
// once the stage has real dimensions.
requestAnimationFrame(() => resize());
if (window.ResizeObserver) new ResizeObserver(() => resize()).observe($('#stage'));

window.__booted = true;

})();
