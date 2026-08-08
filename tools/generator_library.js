'use strict';
/*
 * The generator library.
 *
 * The idea being tested is not mine. It is: instead of three sources that fire
 * often and win barely more than they lose, find thirty to sixty generators
 * that each fire rarely — one trade a day is fine — and win seventy or eighty
 * percent of the time at one-to-one, then run all of them together. Rare and
 * precise, many times over, beats frequent and marginal.
 *
 * The arithmetic behind it is sound and worth stating, because it is the whole
 * reason to do this. At one-to-one the breakeven is 50%, so a generator at 70%
 * earns 0.4R a trade. Thirty of them at one trade a day is thirty trades a day
 * — no longer rare at the portfolio level, which is the point: rarity buys
 * precision per generator, and the count buys sample size back. And if the
 * generators are genuinely independent, the portfolio's t-statistic grows with
 * the square root of the TOTAL trade count, not each generator's own.
 *
 * That last clause is where this either works or dies, and it is the reason
 * this file exists in the shape it does.
 *
 * ── THE DANGER, NAMED UP FRONT ──────────────────────────────────────────────
 *
 * "Rare, with a very high win rate" is also the exact signature of a curve fit.
 * A generator with 30 trades has a standard error on its win rate of about 9
 * percentage points, so 70% is a bit over two standard errors from breakeven —
 * unremarkable on its own. Scan a hundred thousand candidates and the best few
 * hundred will read 70-80% for no reason but the scanning. Keep sixty of those
 * and you have built a portfolio of noise that back-tests beautifully.
 *
 * So this library is built so that the selection can be measured, not just
 * performed:
 *
 *   1. Every candidate's outcome is computed ONCE, independent of any
 *      selection, and stored. Selection is then pure bookkeeping over masks,
 *      which makes it cheap enough to run the whole procedure again on
 *      synthetic data.
 *   2. Diversity is structural, not parametric. Sixty variants of one trendline
 *      is one bet wearing sixty hats. The families here are different objects:
 *      swing levels, gaps, session ranges, volume nodes, order blocks, round
 *      numbers, trendlines, pivots, VWAP, role reversals.
 *   3. Every row carries the context features needed to define a rare
 *      condition, so "only the third touch, only in the Asian session, only
 *      when the hour trend agrees" is expressible and countable.
 *
 * The search itself, the walk-forward selection and the best-of-N null control
 * live in tools/generator_search.js. This file only builds the table.
 *
 * ── THE ONE-TO-ONE SHORTCUT ─────────────────────────────────────────────────
 *
 * Because the user asked for one-to-one, the outcome of an entry collapses to a
 * single question: which barrier does price touch first, the one R above the
 * entry or the one R below? A long that wins is a short that loses, exactly.
 * So one forward scan per event settles every target size in the grid AND both
 * directions, instead of one scan per (size x direction). That is what makes
 * scanning a hundred thousand generators, and then scanning them all again on
 * shuffled data, affordable.
 *
 * Usage:  node tools/generator_library.js            build and cache
 *         node tools/generator_library.js --stats    describe what got built
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('./ai963_engine');
const { levelTestEvents } = require('./level_events');
const LV = require('./levels');
const RT = require('./fixes/rising-trendline.js');

const PU = 0.10;
const COST = 0.5;
const R_GRID = [30, 50, 80, 120];          // points; TP = SL = R
const HOLD_GRID = [240, 1440];             // minutes
const MAX_HOLD = Math.max(...HOLD_GRID);
const CACHE = path.join(__dirname, '..', '.cache', 'generator_table.json.gz');

// ─────────────────────────────────────────────────────────────────────────────
//  Families. Structurally different objects, not parameter twins.
//
//  `tfs` is the timeframes each is built on. A level anchored to the calendar —
//  yesterday's high, today's open, the Asian range — is already a daily object
//  and resampling it would only blur it, so those are built once on 1m.
// ─────────────────────────────────────────────────────────────────────────────
const FAMILIES = [
  { key: 'swingLow',   tfs: [5, 15, 60, 240], build: (b, a) => LV.swingLevels(b, { side: 'low',  left: 20, right: 20, atr: a }) },
  { key: 'swingHigh',  tfs: [5, 15, 60, 240], build: (b, a) => LV.swingLevels(b, { side: 'high', left: 20, right: 20, atr: a }) },
  { key: 'swingLow8',  tfs: [15, 60, 240],    build: (b, a) => LV.swingLevels(b, { side: 'low',  left: 8, right: 8, minTouches: 3, atr: a }) },
  { key: 'swingHigh8', tfs: [15, 60, 240],    build: (b, a) => LV.swingLevels(b, { side: 'high', left: 8, right: 8, minTouches: 3, atr: a }) },
  { key: 'fib',        tfs: [5, 15, 60, 240], build: (b) => LV.fibLevels(b, { left: 60, right: 60 }) },
  { key: 'fibFast',    tfs: [15, 60, 240],    build: (b) => LV.fibLevels(b, { left: 20, right: 20 }) },
  { key: 'fvg',        tfs: [5, 15, 60, 240], build: (b, a) => LV.fvgLevels(b, { atr: a }) },
  { key: 'failHigh',   tfs: [5, 15, 60],      build: (b, a) => LV.failedRetestLevels(b, { side: 'high', atr: a }) },
  { key: 'failLow',    tfs: [5, 15, 60],      build: (b, a) => LV.failedRetestLevels(b, { side: 'low',  atr: a }) },
  { key: 'absorb',     tfs: [5, 15, 60],      build: (b, a) => LV.absorptionLevels(b, { atr: a }) },
  { key: 'volNode',    tfs: [5, 15, 60],      build: (b) => LV.volumeNodeLevels(b) },
  { key: 'orderBlock', tfs: [5, 15, 60, 240], build: (b, a) => LV.orderBlockLevels(b, { atr: a }) },
  { key: 'roleRev',    tfs: [5, 15, 60],      build: (b, a) => LV.roleReversalLevels(b, { atr: a }) },
  { key: 'trendDown',  tfs: [5, 15, 60],      build: (b, a) => LV.trendLineLevels(b, { side: 'down', left: 10, right: 10, atr: a }) },
  { key: 'trendUp',    tfs: [5, 15, 60],      build: (b, a) => LV.trendLineLevels(b, { side: 'up',   left: 10, right: 10, atr: a }) },
  { key: 'trendUpRT',  tfs: [5, 15, 60],      build: (b, a) => RT.risingTrendline(b, a, { left: 5, right: 5, minSpan: 6, maxSpan: 200, pierceAtr: 0.1, maxProject: 200, breakAtr: 0.4 }) },
  { key: 'vwap',       tfs: [1],              build: (b) => LV.vwapLevels(b) },
  { key: 'prevDay',    tfs: [1],              build: (b) => LV.previousDayLevels(b) },
  { key: 'dayOpen',    tfs: [1],              build: (b) => LV.dailyOpenLevels(b) },
  { key: 'pivotCls',   tfs: [1],              build: (b) => LV.classicPivotLevels(b) },
  { key: 'asiaRange',  tfs: [1],              build: (b) => LV.sessionRangeLevels(b, { startHour: 0,  endHour: 7 }) },
  { key: 'londonRng',  tfs: [1],              build: (b) => LV.sessionRangeLevels(b, { startHour: 7,  endHour: 13 }) },
  { key: 'round10',    tfs: [1],              build: (b) => LV.roundNumberLevels(b, { step: 10 }) },
  { key: 'round25',    tfs: [1],              build: (b) => LV.roundNumberLevels(b, { step: 25 }) },
  { key: 'round50',    tfs: [1],              build: (b) => LV.roundNumberLevels(b, { step: 50 }) },
];

function buildTable() {
  const bars = RT.loadBars();
  const N = bars.length;
  const atr1 = E.atr(bars, 14);

  // ── context series, computed once on the execution timeline ───────────────
  const atrSorted = atr1.filter(Number.isFinite).slice().sort((x, y) => x - y);
  const pctOf = v => {
    if (!Number.isFinite(v) || !atrSorted.length) return NaN;
    let lo = 0, hi = atrSorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (atrSorted[m] < v) lo = m + 1; else hi = m; }
    return (100 * lo) / atrSorted.length;
  };
  const atrPct = new Float32Array(N);
  const htf240 = new Float32Array(N);
  const mom15 = new Float32Array(N);
  const rangePos = new Float32Array(N);
  const hourOf = new Uint8Array(N);
  const dowOf = new Uint8Array(N);
  {
    // rolling 240-bar high/low by monotonic deques
    const qH = [], qL = [];
    for (let i = 0; i < N; i++) {
      const lo = i - 239;
      while (qH.length && bars[qH[qH.length - 1]].h <= bars[i].h) qH.pop();
      qH.push(i);
      while (qH[0] < lo) qH.shift();
      while (qL.length && bars[qL[qL.length - 1]].l >= bars[i].l) qL.pop();
      qL.push(i);
      while (qL[0] < lo) qL.shift();
      const hi = bars[qH[0]].h, lw = bars[qL[0]].l;
      rangePos[i] = hi > lw ? (bars[i].c - lw) / (hi - lw) : 0.5;

      const a = atr1[i];
      atrPct[i] = pctOf(a);
      htf240[i] = i >= 240 && a > 0 ? (bars[i].c - bars[i - 240].c) / a : NaN;
      mom15[i] = i >= 15 && a > 0 ? (bars[i].c - bars[i - 15].c) / a : NaN;
      const d = new Date(bars[i].t);
      hourOf[i] = d.getUTCHours();
      dowOf[i] = d.getUTCDay();
    }
  }

  // ── the barrier scan, shared by every generator ───────────────────────────
  //  For an entry at bar i, find the first bar at which price reaches R points
  //  above, and the first at which it reaches R points below, for every R in
  //  the grid. At one-to-one that is the complete outcome for both directions:
  //  upper first means the long won and the short lost, by exactly the same
  //  amount. Same bar for both is unresolvable on candle data and is dropped.
  const scanCache = new Map();
  function barriers(i) {
    const hit = scanCache.get(i);
    if (hit) return hit;
    const up = new Int32Array(R_GRID.length).fill(-1);
    const dn = new Int32Array(R_GRID.length).fill(-1);
    const c = bars[i].c;
    let nu = 0, nd = 0;
    const end = Math.min(N - 1, i + MAX_HOLD);
    for (let j = i + 1; j <= end && (nu < R_GRID.length || nd < R_GRID.length); j++) {
      const b = bars[j];
      while (nu < R_GRID.length && b.h >= c + R_GRID[nu] * PU) up[nu++] = j;
      while (nd < R_GRID.length && b.l <= c - R_GRID[nd] * PU) dn[nd++] = j;
    }
    const v = { up, dn };
    if (scanCache.size < 400000) scanCache.set(i, v);
    return v;
  }

  // ── streams ───────────────────────────────────────────────────────────────
  const tfc = new Map();
  const tf = m => {
    if (!tfc.has(m)) {
      const { bars: b, index } = E.resample(bars, m);
      tfc.set(m, { bars: b, index, atr: E.atr(b, 14) });
    }
    return tfc.get(m);
  };

  const rows = [];
  const streams = [];
  for (const fam of FAMILIES) {
    for (const m of fam.tfs) {
      let line;
      try {
        const { bars: b, index, atr } = tf(m);
        const raw = fam.build(b, atr);
        const l = Array.isArray(raw) ? raw : raw.line;
        line = m === 1 ? l : E.projectConfirmed(l, index);
      } catch (err) {
        process.stderr.write(`  ${fam.key}@${m}m failed: ${err.message}\n`);
        continue;
      }
      let ev;
      try { ev = levelTestEvents(bars, line, atr1) || []; } catch (err) { continue; }
      if (ev.length < 20) continue;

      const sid = streams.length;
      streams.push({ sid, family: fam.key, tf: m, events: ev.length });

      // touch bookkeeping: how many times this same level has already been
      // tested, and how far price travelled away between one test and the next.
      let prevLevel = NaN, touch = 0, prevBar = -1;
      for (const e of ev) {
        const i = e.i;
        if (!Number.isFinite(i) || !e.dir || i < 300 || i >= N - 5) continue;
        const a = atr1[i];
        if (!(a > 0)) continue;

        if (Number.isFinite(prevLevel) && Math.abs(e.level - prevLevel) < a * 0.35) touch += 1;
        else touch = 1;
        let travel = 0;
        if (prevBar >= 0) {
          for (let j = prevBar; j <= i; j++) {
            const d = Math.abs(bars[j].c - e.level) / a;
            if (d > travel) travel = d;
          }
        }
        prevLevel = e.level;
        prevBar = i;

        rows.push({
          sid, i, t: bars[i].t,
          kind: e.kind === 'reject' ? 0 : 1,
          dir: e.dir,
          touch: Math.min(touch, 6),
          travel,
          dist: Math.abs(bars[i].c - e.level) / a,
          atrPct: atrPct[i],
          htf: htf240[i],
          mom: mom15[i],
          rangePos: rangePos[i],
          hour: hourOf[i],
          dow: dowOf[i],
        });
      }
    }
  }

  rows.sort((x, y) => x.i - y.i);

  // ── outcomes ──────────────────────────────────────────────────────────────
  //  upBar[r][k] / dnBar[r][k]: bar at which the barrier R_GRID[r] was first
  //  reached above / below the entry of row k, or -1 within MAX_HOLD.
  const K = rows.length;
  const upBar = R_GRID.map(() => new Int32Array(K));
  const dnBar = R_GRID.map(() => new Int32Array(K));
  const timeClose = HOLD_GRID.map(() => new Float32Array(K));
  for (let k = 0; k < K; k++) {
    const i = rows[k].i;
    const { up, dn } = barriers(i);
    for (let r = 0; r < R_GRID.length; r++) { upBar[r][k] = up[r]; dnBar[r][k] = dn[r]; }
    for (let h = 0; h < HOLD_GRID.length; h++) {
      const j = Math.min(N - 1, i + HOLD_GRID[h]);
      timeClose[h][k] = (bars[j].c - bars[i].c) / PU;
    }
  }

  return {
    meta: { bars: N, from: new Date(bars[0].t).toISOString(), to: new Date(bars[N - 1].t).toISOString(),
            R_GRID, HOLD_GRID, PU, COST, rows: K, streams: streams.length },
    streams, rows,
    upBar: upBar.map(a => Array.from(a)),
    dnBar: dnBar.map(a => Array.from(a)),
    timeClose: timeClose.map(a => Array.from(a)),
  };
}

/**
 * Settle one row into points, for a target size and a hold limit.
 * Returns null when both barriers fall on the same candle — candle data cannot
 * say which came first, and guessing would flatter or damn the result by turns.
 */
function settle(T, k, rIdx, hIdx, tradeDir) {
  const R = T.meta.R_GRID[rIdx];
  const H = T.meta.HOLD_GRID[hIdx];
  const i = T.rows[k].i;
  const u = T.upBar[rIdx][k], d = T.dnBar[rIdx][k];
  const uOK = u >= 0 && u - i <= H;
  const dOK = d >= 0 && d - i <= H;
  if (uOK && dOK && u === d) return null;
  let raw;
  if (uOK && (!dOK || u < d)) raw = tradeDir === 1 ? R : -R;
  else if (dOK && (!uOK || d < u)) raw = tradeDir === 1 ? -R : R;
  else raw = T.timeClose[hIdx][k] * tradeDir;
  return raw - T.meta.COST;
}

function load() {
  if (fs.existsSync(CACHE)) {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(CACHE)).toString('utf8'));
  }
  const T = buildTable();
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, zlib.gzipSync(Buffer.from(JSON.stringify(T)), { level: 6 }));
  return T;
}

module.exports = { buildTable, load, settle, FAMILIES, R_GRID, HOLD_GRID, PU, COST, CACHE };

if (require.main === module) {
  const t0 = Date.now();
  const T = load();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`الجدول: ${T.meta.rows} حدث من ${T.meta.streams} مجرى   (${secs}s)`);
  console.log(`  ${T.meta.bars} شمعة   ${T.meta.from.slice(0, 10)} … ${T.meta.to.slice(0, 10)}`);
  console.log(`  أهداف ${T.meta.R_GRID.join('/')} نقطة عند 1:1   حيازة ${T.meta.HOLD_GRID.join('/')} دقيقة\n`);
  const byFam = new Map();
  for (const s of T.streams) {
    if (!byFam.has(s.family)) byFam.set(s.family, []);
    byFam.get(s.family).push(s);
  }
  const cnt = new Map();
  for (const r of T.rows) cnt.set(r.sid, (cnt.get(r.sid) || 0) + 1);
  for (const [fam, list] of byFam) {
    const parts = list.map(s => `${s.tf}m:${cnt.get(s.sid) || 0}`).join('  ');
    console.log(`  ${fam.padEnd(11)} ${parts}`);
  }
  const days = (Date.parse(T.meta.to) - Date.parse(T.meta.from)) / 86400000;
  console.log(`\n  إجمالي ${T.meta.rows} حدث على ${days.toFixed(0)} يومًا`);
}
