'use strict';
// Rank every school the file still contains, plus the three band ideas, each one
// standalone and each one given its OWN plan instead of the engine's.
//
// The engine hands every school a 35.6-point target against a 53.8-point stop.
// That plan breaks even at 60.2%, so a school running on it wins 60% and earns
// nothing — Keltner measured -183 points at 60.1% wired that way and +10,733 at
// 41.8% on its own plan. Same signal, same bars. So the ranking below only makes
// sense with each school on a plan of its own, and the plan is swept per school
// rather than assumed.
//
// Plans are multiples of the average bar range, never points, so the numbers do
// not silently belong to one volatility regime.
const { parseCSVFast } = require('./harness.js');
const fs = require('fs');
const PU = 0.1;

const sma = (s, n) => { const o = new Float64Array(s.length).fill(NaN); let a = 0; for (let i = 0; i < s.length; i++) { a += s[i]; if (i >= n) a -= s[i - n]; if (i >= n - 1) o[i] = a / n; } return o; };
const ema = (s, n) => { const o = new Float64Array(s.length), a = 2 / (n + 1); let p = NaN; for (let i = 0; i < s.length; i++) { p = Number.isFinite(p) ? (s[i] - p) * a + p : s[i]; o[i] = p; } return o; };
const rma = (s, n) => { const o = new Float64Array(s.length).fill(NaN); let p = NaN; for (let i = 0; i < s.length; i++) { p = Number.isFinite(p) ? (p * (n - 1) + s[i]) / n : s[i]; o[i] = p; } return o; };
function stdev(s, n) {
  const o = new Float64Array(s.length).fill(NaN); let a = 0, q = 0;
  for (let i = 0; i < s.length; i++) { a += s[i]; q += s[i] * s[i]; if (i >= n) { a -= s[i - n]; q -= s[i - n] * s[i - n]; } if (i >= n - 1) { const m = a / n; o[i] = Math.sqrt(Math.max(0, q / n - m * m)); } }
  return o;
}

const rows = parseCSVFast(fs.readFileSync(process.env.DATA || 'data2026.csv', 'utf8'));
const n = rows.length;
const H = new Float64Array(n), L = new Float64Array(n), C = new Float64Array(n), O = new Float64Array(n), V = new Float64Array(n);
for (let i = 0; i < n; i++) { H[i] = rows[i].high; L[i] = rows[i].low; C[i] = rows[i].close; O[i] = rows[i].open; V[i] = rows[i].volume || 0; }

const rngPts = new Float64Array(n);
for (let i = 0; i < n; i++) rngPts[i] = (H[i] - L[i]) / PU;
const unit = sma(rngPts, 500);                        // the market's unit of distance

// ── the shared helpers the schools are written against ───────────────────────
const tr = new Float64Array(n);
for (let i = 1; i < n; i++) tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
const atrV = rma(tr, 14);                             // ta.atr(14), only because the schools are written with it
const chEma = ema(C, 20), chE50 = ema(C, 50), chE100 = ema(C, 100), chE55 = ema(C, 55);
const stretch = new Float64Array(n);
for (let i = 0; i < n; i++) stretch[i] = atrV[i] === 0 ? 0 : (C[i] - chEma[i]) / atrV[i];
function rsi(len) {
  const u = new Float64Array(n), d = new Float64Array(n);
  for (let i = 1; i < n; i++) { u[i] = Math.max(C[i] - C[i - 1], 0); d[i] = Math.max(C[i - 1] - C[i], 0); }
  const U = rma(u, len), D = rma(d, len), o = new Float64Array(n);
  for (let i = 0; i < n; i++) o[i] = D[i] === 0 ? 100 : 100 - 100 / (1 + U[i] / D[i]);
  return o;
}
const rsi3 = rsi(3), rsi14 = rsi(14);
const vSma = sma(V, 20);
const clim = new Uint8Array(n), big = new Uint8Array(n);
for (let i = 0; i < n; i++) { clim[i] = V[i] > 2 * vSma[i] ? 1 : 0; big[i] = (H[i] - L[i]) > 1.5 * atrV[i] ? 1 : 0; }

// CMO(9)
const up1 = new Float64Array(n), dn1 = new Float64Array(n);
for (let i = 1; i < n; i++) { up1[i] = Math.max(C[i] - C[i - 1], 0); dn1[i] = Math.max(C[i - 1] - C[i], 0); }
const su = sma(up1, 9), sd = sma(dn1, 9), cmo = new Float64Array(n);
for (let i = 0; i < n; i++) cmo[i] = 100 * (su[i] * 9 - sd[i] * 9) / (su[i] * 9 + sd[i] * 9 + 1e-5);

// supertrend(6, 7) direction, Pine's ta.supertrend
const stDir = new Int8Array(n);
{
  const atr7 = rma(tr, 7);
  let upB = NaN, dnB = NaN, dir = 1;
  for (let i = 1; i < n; i++) {
    const mid = (H[i] + L[i]) / 2, u = mid + 6 * atr7[i], d = mid - 6 * atr7[i];
    dnB = (C[i - 1] > dnB) ? Math.max(d, dnB) : d;
    upB = (C[i - 1] < upB) ? Math.min(u, upB) : u;
    dir = C[i] > upB ? -1 : C[i] < dnB ? 1 : (Number.isFinite(dir) ? dir : 1);
    stDir[i] = dir;
  }
}

// TSI
const pc = new Float64Array(n);
for (let i = 1; i < n; i++) pc[i] = (C[i] - C[i - 1]) / (C[i - 1] + 1e-5);
const apc = new Float64Array(n);
for (let i = 0; i < n; i++) apc[i] = Math.abs(pc[i]);
const tsiN = ema(ema(pc, 13), 7), tsiD = ema(ema(apc, 13), 7), tsi = new Float64Array(n);
for (let i = 0; i < n; i++) tsi[i] = 100 * tsiN[i] / (tsiD[i] + 1e-5);

// RMI, as the file's own source computes it
const rmiUp = new Float64Array(n), rmiDn = new Float64Array(n);
for (let i = 6; i < n; i++) { rmiUp[i] = Math.max(C[i] - C[i - 6], 0); rmiDn[i] = Math.max(C[i - 6] - C[i], 0); }
const rU = ema(rmiUp, 18), rD = ema(rmiDn, 18), rmi = new Float64Array(n);
for (let i = 0; i < n; i++) rmi[i] = rD[i] === 0 ? (rU[i] === 0 ? 50 : 100) : 100 - 100 / (1 + rU[i] / rD[i]);

// ── the bands ────────────────────────────────────────────────────────────────
const kcM = ema(C, 20), kcA = sma(rngPts.map ? rngPts : rngPts, 20);
const kcRange = new Float64Array(n);
for (let i = 0; i < n; i++) kcRange[i] = H[i] - L[i];
const kcAvg = sma(kcRange, 20);
const bbM = sma(C, 20), bbS = stdev(C, 20);

// the invented band: the distance past swings actually reached, in bar-ranges
function reversion(centreLen, K, M, P) {
  const centre = sma(C, centreLen);
  const up = new Float64Array(n).fill(NaN), dn = new Float64Array(n).fill(NaN);
  const hiD = [], loD = [];
  let lu = NaN, ld = NaN;
  for (let i = 0; i < n; i++) {
    const p = i - K;
    if (p - K >= 0 && Number.isFinite(centre[p]) && unit[p] > 0) {
      let isHi = true, isLo = true;
      for (let k = 1; k <= K; k++) {
        if (H[p - k] > H[p] || H[p + k] > H[p]) isHi = false;
        if (L[p - k] < L[p] || L[p + k] < L[p]) isLo = false;
      }
      if (isHi) { const d = (H[p] - centre[p]) / PU / unit[p]; if (d > 0) { hiD.push(d); if (hiD.length > M) hiD.shift(); } }
      if (isLo) { const d = (centre[p] - L[p]) / PU / unit[p]; if (d > 0) { loD.push(d); if (loD.length > M) loD.shift(); } }
    }
    if (hiD.length >= 20) { const a = hiD.slice().sort((x, y) => x - y); lu = a[Math.min(a.length - 1, Math.floor(a.length * P))]; }
    if (loD.length >= 20) { const a = loD.slice().sort((x, y) => x - y); ld = a[Math.min(a.length - 1, Math.floor(a.length * P))]; }
    if (Number.isFinite(centre[i]) && unit[i] > 0 && Number.isFinite(lu) && Number.isFinite(ld)) {
      up[i] = centre[i] + lu * unit[i] * PU; dn[i] = centre[i] - ld * unit[i] * PU;
    }
  }
  return { up, dn };
}
const RB = reversion(200, 8, 60, 0.85);

// ── the candidates ───────────────────────────────────────────────────────────
const mk = fn => { const m = new Uint8Array(n); for (let i = 2; i < n; i++) m[i] = fn(i) ? 1 : 0; return m; };
const SCHOOLS = [
  ['chRib  EMA ribbon pullback', 1, mk(i => chEma[i] > chE50[i] && chE50[i] > chE100[i] && L[i] <= chE50[i] && C[i] > chE50[i] && C[i] > O[i])],
  ['chRib  EMA ribbon pullback', -1, mk(i => chEma[i] < chE50[i] && chE50[i] < chE100[i] && H[i] >= chE50[i] && C[i] < chE50[i] && C[i] < O[i])],
  ['chCld  EMA cloud break', 1, mk(i => C[i - 1] <= Math.max(chEma[i - 1], chE55[i - 1]) && C[i] > Math.max(chEma[i], chE55[i]) && C[i] > O[i])],
  ['chCld  EMA cloud break', -1, mk(i => C[i - 1] >= Math.min(chEma[i - 1], chE55[i - 1]) && C[i] < Math.min(chEma[i], chE55[i]) && C[i] < O[i])],
  ['chKelt Keltner touch', 1, mk(i => L[i] < chEma[i] - 2 * atrV[i] && rsi3[i] < 18 && big[i])],
  ['chKelt Keltner touch', -1, mk(i => H[i] > chEma[i] + 2 * atrV[i] && rsi3[i] > 82 && big[i])],
  ['chR14  RSI14 turn', 1, mk(i => rsi14[i] < 30 && rsi14[i] > rsi14[i - 1] && stretch[i] < -1)],
  ['chR14  RSI14 turn', -1, mk(i => rsi14[i] > 70 && rsi14[i] < rsi14[i - 1] && stretch[i] > 1)],
  ['chUt   supertrend fade', 1, mk(i => stDir[i] === -1 && rsi3[i] < 18 && big[i])],
  ['chUt   supertrend fade', -1, mk(i => stDir[i] === 1 && rsi3[i] > 82 && big[i])],
  ['chCmo  CMO snap', 1, mk(i => cmo[i] < -60 && rsi3[i] < 18 && big[i])],
  ['chCmo  CMO snap', -1, mk(i => cmo[i] > 60 && rsi3[i] > 82 && big[i])],
  ['chCrev climax reversal', 1, mk(i => clim[i - 1] && C[i - 1] < O[i - 1] && C[i] > O[i] && C[i] > C[i - 1])],
  ['chCrev climax reversal', -1, mk(i => clim[i - 1] && C[i - 1] > O[i - 1] && C[i] < O[i] && C[i] < C[i - 1])],
  ['chQuad RSI3+RSI14', 1, mk(i => rsi3[i] < 18 && rsi14[i] < 40 && big[i])],
  ['chQuad RSI3+RSI14', -1, mk(i => rsi3[i] > 82 && rsi14[i] > 60 && big[i])],
  ['chTsi  TSI fade', 1, mk(i => tsi[i] < -15 && rsi3[i] < 18 && big[i])],
  ['chTsi  TSI fade', -1, mk(i => tsi[i] > 15 && rsi3[i] > 82 && big[i])],
  ['RMI    zone 78 reaction', -1, (() => {
    const m = new Uint8Array(n);
    let armed = false, armBar = -1, react = 0, ext = false;
    for (let i = 41; i < n; i++) {
      if (rmi[i] >= 78 && !(rmi[i - 1] >= 78)) { armed = true; armBar = i; react = 0; ext = false; }
      if (!armed) continue;
      if (i - armBar > 12) { armed = false; continue; }
      let hh = -1e18; for (let k = 1; k <= 40; k++) if (H[i - k] > hh) hh = H[i - k];
      if (H[i] >= hh) ext = true;
      react = C[i] < O[i] ? react + 1 : 0;
      if (react >= 2 && ext) { m[i] = 1; armed = false; }
    }
    return m;
  })()],
  ['BAND   Keltner 20x2 pierce', -1, mk(i => H[i] > kcM[i] + 2 * kcAvg[i] && C[i] < kcM[i] + 2 * kcAvg[i])],
  ['BAND   Keltner 20x2 pierce', 1, mk(i => L[i] < kcM[i] - 2 * kcAvg[i] && C[i] > kcM[i] - 2 * kcAvg[i])],
  ['BAND   Bollinger 20x2 pierce', -1, mk(i => H[i] > bbM[i] + 2 * bbS[i] && C[i] < bbM[i] + 2 * bbS[i])],
  ['BAND   Bollinger 20x2 pierce', 1, mk(i => L[i] < bbM[i] - 2 * bbS[i] && C[i] > bbM[i] - 2 * bbS[i])],
  ['BAND   measured reversion p85', 1, mk(i => Number.isFinite(RB.dn[i]) && L[i] < RB.dn[i] && C[i] > RB.dn[i])],
  ['BAND   measured reversion p85', -1, mk(i => Number.isFinite(RB.up[i]) && H[i] > RB.up[i] && C[i] < RB.up[i])],
];

function play(mask, side, tgt, stp) {
  const T = [];
  let live = null;
  for (let i = 600; i < n - 1; i++) {
    if (live) {
      const ht = side === 1 ? H[i] >= live.tp : L[i] <= live.tp;
      const hs = side === 1 ? L[i] <= live.sl : H[i] >= live.sl;
      let x = null;
      if (ht && hs) x = -live.s; else if (ht) x = live.t; else if (hs) x = -live.s;
      else if (i - live.bar >= 600) x = (side === 1 ? C[i] - live.en : live.en - C[i]) / PU;
      if (x !== null) { T.push(x); live = null; }
      continue;
    }
    if (!mask[i] || !(unit[i] > 0)) continue;
    const t = Math.max(10, unit[i] * tgt), s = Math.max(10, unit[i] * stp), en = C[i];
    live = { en, bar: i, t, s, tp: side === 1 ? en + t * PU : en - t * PU, sl: side === 1 ? en - s * PU : en + s * PU };
  }
  let net = 0, w = 0, eq = 0, pk = 0, dd = 0, ml = 0, cl = 0;
  for (const p of T) { net += p; if (p > 0) { w++; cl = 0; } else { cl++; if (cl > ml) ml = cl; } eq += p; if (eq > pk) pk = eq; if (pk - eq > dd) dd = pk - eq; }
  return { n: T.length, wr: T.length ? 100 * w / T.length : 0, net, dd, run: ml };
}

const all = new Uint8Array(n).fill(1);
const PLANS = [[2, 1.5], [3, 2], [4, 2], [4, 3], [5, 3], [6, 3], [3, 3]];
const days = (rows[n - 1].time - rows[600].time) / 86400000 * 5 / 7;

const out = [];
for (const [name, side, mask] of SCHOOLS) {
  let best = null;
  for (const [t, s] of PLANS) {
    const r = play(mask, side, t, s);
    if (r.n < 100) continue;
    const drift = play(all, side, t, s);
    const edge = r.net / r.n - drift.net / drift.n;      // above a matched random entry
    if (!best || r.net > best.r.net) best = { r, t, s, edge };
  }
  if (!best) continue;
  out.push({
    school: name, side: side === 1 ? 'BUY' : 'SELL',
    plan: best.t + 'x/' + best.s + 'x',
    trades: best.r.n, perDay: +(best.r.n / days).toFixed(1),
    WR: +best.r.wr.toFixed(1), net: Math.round(best.r.net),
    perTrade: +(best.r.net / best.r.n).toFixed(2),
    edge: +best.edge.toFixed(2), maxDD: Math.round(best.r.dd), worstRun: best.r.run,
  });
}
out.sort((a, b) => b.net - a.net);
console.log('\n' + (process.env.DATA || 'data2026.csv') + ' — each school standalone, one position, on its own best plan.');
console.log('edge = points per trade above a random entry, same side, same plan.\n');
console.table(out);

// ── the ten that stay, each with the plan its own sweep chose ────────────────
// One entry per side, because several schools earn on one side and bleed on the
// other; chCld and chRib and the Keltner band are sell-side rules whatever their
// buy leg does.
const byName = {};
for (const [nm, sd, mk2] of SCHOOLS) byName[nm + '|' + sd] = mk2;
const TEN = [
  ['RMI zone reaction',        'RMI    zone 78 reaction|-1',       -1, 6, 3],
  ['Keltner band pierce',      'BAND   Keltner 20x2 pierce|-1',    -1, 6, 3],
  ['Bollinger band pierce',    'BAND   Bollinger 20x2 pierce|-1',  -1, 4, 2],
  ['QUAD RSI3+RSI14 buy',      'chQuad RSI3+RSI14|1',               1, 4, 2],
  ['QUAD RSI3+RSI14 sell',     'chQuad RSI3+RSI14|-1',             -1, 4, 2],
  ['EMA cloud break',          'chCld  EMA cloud break|-1',        -1, 5, 3],
  ['Keltner touch buy',        'chKelt Keltner touch|1',            1, 4, 2],
  ['Keltner touch sell',       'chKelt Keltner touch|-1',          -1, 4, 2],
  ['TSI fade buy',             'chTsi  TSI fade|1',                 1, 4, 2],
  ['TSI fade sell',            'chTsi  TSI fade|-1',               -1, 4, 2],
  ['EMA ribbon pullback',      'chRib  EMA ribbon pullback|-1',    -1, 6, 3],
  ['CMO snap buy',             'chCmo  CMO snap|1',                 1, 4, 2],
  ['measured reversion buy',   'BAND   measured reversion p85|1',   1, 6, 3],
];

// independent: every school carries its own position and ignores the others
function independent() {
  const T = [];
  for (const [label, key, side, t, s] of TEN) {
    const m = byName[key];
    let live = null;
    for (let i = 600; i < n - 1; i++) {
      if (live) {
        const ht = side === 1 ? H[i] >= live.tp : L[i] <= live.tp;
        const hs = side === 1 ? L[i] <= live.sl : H[i] >= live.sl;
        let x = null;
        if (ht && hs) x = -live.s; else if (ht) x = live.t; else if (hs) x = -live.s;
        else if (i - live.bar >= 600) x = (side === 1 ? C[i] - live.en : live.en - C[i]) / PU;
        if (x !== null) { T.push({ p: x, exit: i, label }); live = null; }
        continue;
      }
      if (!m[i] || !(unit[i] > 0)) continue;
      const tt = Math.max(10, unit[i] * t), ss = Math.max(10, unit[i] * s), en = C[i];
      live = { en, bar: i, t: tt, s: ss, tp: side === 1 ? en + tt * PU : en - tt * PU, sl: side === 1 ? en - ss * PU : en + ss * PU };
    }
  }
  return T;
}

// respecting: one position for all thirteen, first to fire takes it
function respecting() {
  const T = [];
  let live = null;
  for (let i = 600; i < n - 1; i++) {
    if (live) {
      const side = live.side;
      const ht = side === 1 ? H[i] >= live.tp : L[i] <= live.tp;
      const hs = side === 1 ? L[i] <= live.sl : H[i] >= live.sl;
      let x = null;
      if (ht && hs) x = -live.s; else if (ht) x = live.t; else if (hs) x = -live.s;
      else if (i - live.bar >= 600) x = (side === 1 ? C[i] - live.en : live.en - C[i]) / PU;
      if (x !== null) { T.push({ p: x, exit: i, label: live.label }); live = null; }
      continue;
    }
    if (!(unit[i] > 0)) continue;
    for (const [label, key, side, t, s] of TEN) {
      if (!byName[key][i]) continue;
      const tt = Math.max(10, unit[i] * t), ss = Math.max(10, unit[i] * s), en = C[i];
      live = { side, en, bar: i, t: tt, s: ss, label,
        tp: side === 1 ? en + tt * PU : en - tt * PU, sl: side === 1 ? en - ss * PU : en + ss * PU };
      break;
    }
  }
  return T;
}

function tally(T, label) {
  const x = T.slice().sort((a, b) => a.exit - b.exit);
  let net = 0, w = 0, eq = 0, pk = 0, dd = 0, cl = 0, ml = 0;
  for (const r of x) {
    net += r.p; if (r.p > 0) { w++; cl = 0; } else { cl++; if (cl > ml) ml = cl; }
    eq += r.p; if (eq > pk) pk = eq; if (pk - eq > dd) dd = pk - eq;
  }
  return { build: label, trades: x.length, perDay: +(x.length / days).toFixed(1),
    WR: +(100 * w / x.length).toFixed(1), net: Math.round(net),
    perMonth: Math.round(net / (days / 21)), maxDD: Math.round(dd), worstRun: ml };
}
console.log('\nthe ten schools together:\n');
console.table([tally(independent(), 'each school independent (respect OFF)'),
               tally(respecting(), 'one shared position (respect ON for all)')]);

// ── how much drawdown is bought back by asking for less ─────────────────────
// A 36% win rate forces long losing runs; that is arithmetic, not a defect. The
// only honest levers are how many schools are allowed to fire, how long the
// system sits out after a run of losses, and how far the target sits from the
// stop. Each is measured, none is assumed.
function shared(list, cdAfterLosses, cdBars, planOverride) {
  const T = [];
  let live = null, lossRun = 0, blockUntil = -1;
  for (let i = 600; i < n - 1; i++) {
    if (live) {
      const side = live.side;
      const ht = side === 1 ? H[i] >= live.tp : L[i] <= live.tp;
      const hs = side === 1 ? L[i] <= live.sl : H[i] >= live.sl;
      let x = null;
      if (ht && hs) x = -live.s; else if (ht) x = live.t; else if (hs) x = -live.s;
      else if (i - live.bar >= 600) x = (side === 1 ? C[i] - live.en : live.en - C[i]) / PU;
      if (x !== null) {
        T.push({ p: x, exit: i });
        live = null;
        if (x < 0) { lossRun++; if (cdAfterLosses && lossRun >= cdAfterLosses) { blockUntil = i + cdBars; lossRun = 0; } }
        else lossRun = 0;
      }
      continue;
    }
    if (!(unit[i] > 0) || i < blockUntil) continue;
    for (const [label, key, side, t0, s0] of list) {
      if (!byName[key][i]) continue;
      const t = planOverride ? planOverride[0] : t0, sp = planOverride ? planOverride[1] : s0;
      const tt = Math.max(10, unit[i] * t), ss = Math.max(10, unit[i] * sp), en = C[i];
      live = { side, en, bar: i, t: tt, s: ss,
        tp: side === 1 ? en + tt * PU : en - tt * PU, sl: side === 1 ? en - ss * PU : en + ss * PU };
      break;
    }
  }
  return T;
}
function score(T, label) {
  const x = T.slice().sort((a, b) => a.exit - b.exit);
  let net = 0, w = 0, eq = 0, pk = 0, dd = 0, cl = 0, ml = 0;
  for (const r of x) {
    net += r.p; if (r.p > 0) { w++; cl = 0; } else { cl++; if (cl > ml) ml = cl; }
    eq += r.p; if (eq > pk) pk = eq; if (pk - eq > dd) dd = pk - eq;
  }
  return { build: label, trades: x.length, perDay: +(x.length / days).toFixed(1),
    WR: +(100 * w / x.length).toFixed(1), net: Math.round(net),
    perMonth: Math.round(net / (days / 21)), maxDD: Math.round(dd),
    'net/DD': +(net / dd).toFixed(1), worstRun: ml };
}
// the five with the largest edge over a random entry, rather than the largest net
const TOP5 = TEN.filter(r => ['measured reversion buy','EMA ribbon pullback','QUAD RSI3+RSI14 buy','CMO snap buy','RMI zone reaction'].includes(r[0]));
console.log('\n');
console.table([
  score(shared(TEN, 0, 0, null), 'all 13, no pause'),
  score(shared(TEN, 4, 60, null), 'all 13, pause 60 bars after 4 losses'),
  score(shared(TEN, 3, 120, null), 'all 13, pause 120 bars after 3 losses'),
  score(shared(TEN, 0, 0, [3, 2]), 'all 13, every plan 3x/2x'),
  score(shared(TEN, 0, 0, [2, 2]), 'all 13, every plan 2x/2x (1:1)'),
  score(shared(TOP5, 0, 0, null), 'only the 5 with the highest edge'),
  score(shared(TOP5, 4, 60, null), 'the 5 highest edge, pause after 4 losses'),
]);
