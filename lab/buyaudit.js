'use strict';
// The user's challenge: "not one indicator has ever shown a profitable BUY side
// with you -> your tests must be wrong."  This audits the BUY side of the
// harness itself instead of defending it.
//
//  A) mirror invariance  - flip the price series upside down; a BUY on the
//     mirrored bars MUST return exactly what a SELL returned on the originals.
//     Any difference is a coding bug in the forward walk.
//  B) random control     - random entries, matched count, BUY-all vs SELL-all.
//     Measures what the raw market pays each side over the tested window.
//  C) the base engine    - what the untouched indicator's own BUY side did.
//  D) raw drift          - where price started and finished.
const { load } = require('./dump.js');
const { simulate, stats, D } = require('./sim.js');

const PU = D.pointUnit;

// ---------------------------------------------------------------- forward walk
// Deliberately written once and used for both sides so the two cannot diverge.
function walk(O, bar, side, tpPts, slPts, maxHold) {
  const entry = O.close[bar];
  const tp = side === 1 ? entry + tpPts * PU : entry - tpPts * PU;
  const sl = side === 1 ? entry - slPts * PU : entry + slPts * PU;
  const last = Math.min(O.n - 1, bar + maxHold);
  for (let i = bar + 1; i <= last; i++) {
    const ht = side === 1 ? O.high[i] >= tp : O.low[i] <= tp;
    const hs = side === 1 ? O.low[i] <= sl : O.high[i] >= sl;
    if (ht && hs) return -slPts;          // same bar -> stop wins (pessimistic)
    if (ht) return tpPts;
    if (hs) return -slPts;
  }
  return (side === 1 ? O.close[last] - entry : entry - O.close[last]) / PU;
}

function mirror(O) {
  const n = O.n, P = 2 * O.close[0];
  const m = { n, time: O.time, open: new Float64Array(n), high: new Float64Array(n),
    low: new Float64Array(n), close: new Float64Array(n) };
  for (let i = 0; i < n; i++) {
    m.open[i]  = P - O.open[i];
    m.close[i] = P - O.close[i];
    m.high[i]  = P - O.low[i];   // a high becomes a low
    m.low[i]   = P - O.high[i];
  }
  return m;
}

function agg(res) {
  let net = 0, w = 0;
  for (const p of res) { net += p; if (p > 0) w++; }
  return { n: res.length, wr: res.length ? 100 * w / res.length : 0, net: Math.round(net),
    avg: res.length ? +(net / res.length).toFixed(2) : 0 };
}

// deterministic PRNG so the control is reproducible
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

const PLANS = [[50, 50], [60, 40], [40, 60], [50, 65]];
const files = process.argv.slice(2);

for (const file of files) {
  const F = load(file);
  const O = Object.assign({ n: F.n }, F.ohlc);
  const M = mirror(O);
  const yr = file.match(/\d{4}/)[0];
  const days = (O.time[F.n - 1] - O.time[300]) / 86400000;

  console.log('\n════════════════════ ' + file + '  (' + days.toFixed(0) + ' days) ════════════════════');

  // ---- D) raw drift -------------------------------------------------------
  const p0 = O.close[300], p1 = O.close[F.n - 1];
  console.log('D) price ' + p0.toFixed(2) + ' -> ' + p1.toFixed(2) +
    '   drift ' + ((p1 - p0) / PU).toFixed(0) + ' points (' + (p1 > p0 ? 'UP' : 'DOWN') + ')');

  // ---- A) mirror invariance ----------------------------------------------
  // sample 4000 bars spread across the year, every plan, both directions
  const step = Math.max(1, Math.floor((F.n - 700) / 4000));
  let checked = 0, bad = 0, worstDiff = 0;
  for (const [tp, sl] of PLANS) {
    for (let i = 300; i < F.n - 400; i += step) {
      const sellOrig = walk(O, i, -1, tp, sl, 600);
      const buyMirr  = walk(M, i,  1, tp, sl, 600);
      const buyOrig  = walk(O, i,  1, tp, sl, 600);
      const sellMirr = walk(M, i, -1, tp, sl, 600);
      checked += 2;
      const d1 = Math.abs(sellOrig - buyMirr), d2 = Math.abs(buyOrig - sellMirr);
      if (d1 > 1e-6) bad++;
      if (d2 > 1e-6) bad++;
      worstDiff = Math.max(worstDiff, d1, d2);
    }
  }
  console.log('A) mirror invariance: ' + checked + ' paired walks, mismatches ' + bad +
    ', worst difference ' + worstDiff.toExponential(2) +
    (bad === 0 ? '   -> the walk is side-symmetric' : '   -> BUG IN THE WALK'));

  // ---- B) random control --------------------------------------------------
  const rows = [];
  for (const [tp, sl] of PLANS) {
    const r = rng(20260101);
    const B = [], S = [];
    for (let k = 0; k < 20000; k++) {
      const i = 300 + Math.floor(r() * (F.n - 700));
      B.push(walk(O, i, 1, tp, sl, 600));
      S.push(walk(O, i, -1, tp, sl, 600));
    }
    const b = agg(B), s = agg(S);
    rows.push({ plan: tp + '/' + sl, buyWR: +b.wr.toFixed(2), buyAvg: b.avg,
      sellWR: +s.wr.toFixed(2), sellAvg: s.avg, edgeBuy: +(b.avg).toFixed(2),
      gap: +(s.avg - b.avg).toFixed(2) });
  }
  console.log('B) random entries, 20000 per side per plan (no rule at all):');
  console.table(rows);
}

// ---- C) the base engine's own two sides -------------------------------------
console.log('\n════════════════════ C) the untouched engine, per side ════════════════════');
const R31 = { extraGate: (F, i, side) => side !== 1 ||
  !(F.num.chStretch[i] > 0.25 && F.num.rangePos[i] > 45 && !F.bool.qaBuyReversal[i]) };
const crows = [];
for (const file of files) {
  const F = load(file);
  for (const [tag, cfg] of [['SYR30', {}], ['SYR31', R31]]) {
    if (tag === 'SYR31' && !/lev31/.test(file)) continue;
    if (tag === 'SYR30' && /lev31/.test(file)) continue;
    const T = simulate(F, cfg);
    const b = stats(T.filter(t => t.side === 1)), s = stats(T.filter(t => t.side === -1));
    crows.push({ file, engine: tag,
      buyN: b.trades, buyWR: +b.wr.toFixed(2), buyNet: Math.round(b.net),
      sellN: s.trades, sellWR: +s.wr.toFixed(2), sellNet: Math.round(s.net) });
  }
}
console.table(crows);
