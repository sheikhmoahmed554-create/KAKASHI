'use strict';
/*
 * Round psychological numbers on XAUUSD — rebuilt from the definition up.
 *
 * WHAT WAS WRONG WITH THE OLD CONSTRUCTION
 *
 *   tools/levels.js:roundNumberLevels returns  Math.round(close / step) * step.
 *   That is "the nearest round number to the close", and it is not a level: it
 *   is a staircase glued to price. It changes value the instant price crosses
 *   the midpoint between two round numbers, which means the level-test engine
 *   in tools/level_events.js resets its state on every crossing (the engine
 *   treats a value change larger than half an ATR as a brand new level). The
 *   thing it was measuring was therefore "price wandered across the halfway
 *   mark and came back", not "price came to 3400 and turned".
 *
 *   A round number is the easiest level in the world to define correctly: it is
 *   a constant. 3400 is 3400 on every bar of the sample, known before the data
 *   starts. So the correct construction is a FIXED GRID, with every member of
 *   the grid watched independently and tested one at a time.
 *
 * WHAT THIS FILE DOES
 *
 *   stage current    measures the old staircase construction, direction-adjusted
 *   stage grid       fixed grid; sweeps step, tolerance, approach, timeframe
 *   stage excursion   measures the MFE/MAE a test actually produces
 *   stage tuned      sizes target/stop to that excursion, both readings
 *   stage final      the chosen configuration plus controls
 *
 *   Usage:  node --max-old-space-size=3500 tools/fixes/round-numbers.js <stage>
 *
 * CAUSALITY
 *   The grid is a set of constants, so there is no information in it at all —
 *   nothing to leak. An event at bar i uses only bars[i], bars[i-1].c and
 *   atr[i]; entry is the close of bar i. When the test is detected on a higher
 *   timeframe, the event is mapped to the LAST 1m bar of that higher-timeframe
 *   candle, i.e. the moment that candle closed. Stage `final` asserts this
 *   explicitly and also runs an off-grid control (levels shifted to non-round
 *   values), which must collapse to the random baseline if the measurement is
 *   honest.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('../ai963_engine');
const LV = require('../levels');
const { levelTestEvents, respectRate } = require('../level_events');

// ── constants, identical to tools/sweep_timeframes.js ────────────────────────
const PU = 0.10;          // 1 point = 0.10 USD
const COST = 0.5;         // points, round trip
const TP0 = 90, SL0 = 90; // the legacy target everything was forced onto
const MAX_HOLD = 1440;
const RANDOM_RESPECT = 68.95;
const TF_NAME = { 1: '1m', 5: '5m', 15: '15m', 60: '1H', 240: '4H', 1440: 'D' };

// ── data ─────────────────────────────────────────────────────────────────────
function loadBars() {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'KAKASHI_V16_TV_PARITY_AUDIT.html'), 'utf8');
  const csv = zlib.gunzipSync(Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1], 'base64')).toString('utf8');
  const lines = csv.split('\n');
  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const a = lines[i].split(',');
    const t = Date.parse(a[0].replace(' ', 'T'));
    const c = +a[4];
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
    bars.push({ t, o: +a[1], h: +a[2], l: +a[3], c, v: +a[5] });
  }
  return bars.sort((x, y) => x.t - y.t);
}

const bars = loadBars();
const N = bars.length;
const atr1 = E.atr(bars, 14);

// Higher-timeframe candles + their ATR, cached.
const TF = new Map();
function tf(m) {
  if (!TF.has(m)) {
    const { bars: b, index } = E.resample(bars, m);
    // lastOf[j] = index of the final 1m bar inside higher-timeframe candle j
    const lastOf = new Array(b.length).fill(-1);
    for (let i = 0; i < index.length; i++) if (index[i] >= 0) lastOf[index[i]] = i;
    TF.set(m, { bars: b, index, lastOf, atr: E.atr(b, 14) });
  }
  return TF.get(m);
}

// ── trade simulation ─────────────────────────────────────────────────────────
/** Race a target against a stop from the close of bar i. Returns points, or null if ambiguous. */
function race(i, dir, tp, sl, maxHold) {
  const e = bars[i].c;
  const t = e + dir * tp * PU, s = e - dir * sl * PU;
  const end = Math.min(N - 1, i + maxHold);
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    const ht = dir === 1 ? b.h >= t : b.l <= t;
    const hs = dir === 1 ? b.l <= s : b.h >= s;
    if (ht && hs) return null;              // same candle — cannot resolve honestly
    if (ht) return tp - COST;
    if (hs) return -sl - COST;
  }
  return (bars[end].c - e) * dir / PU - COST;
}

function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * The blind baseline for this exact target/stop/hold. It MUST be recomputed for
 * every target size: -4.8 / +4.3 are the 90/90 numbers and mean nothing at 20/20.
 */
const BLIND = new Map();
function blind(dir, tp, sl, maxHold) {
  const key = `${dir}|${tp}|${sl}|${maxHold}`;
  if (BLIND.has(key)) return BLIND.get(key);
  const r = rng(dir === 1 ? 31337 : 73331);
  let c = 0, net = 0;
  const lo = 100, hi = N - maxHold - 2;
  for (let k = 0; k < 40000; k++) {
    const p = race(lo + Math.floor(r() * (hi - lo)), dir, tp, sl, maxHold);
    if (p === null) continue;
    c++; net += p;
  }
  const v = net / c;
  BLIND.set(key, v);
  return v;
}

/** Direction-adjusted score: longs against blind long, shorts against blind short. */
function score(events, tp = TP0, sl = SL0, maxHold = MAX_HOLD) {
  const BL = blind(1, tp, sl, maxHold), BS = blind(-1, tp, sl, maxHold);
  let ln = 0, lnet = 0, sn = 0, snet = 0, wins = 0;
  for (const e of events) {
    const p = race(e.i, e.dir, tp, sl, maxHold);
    if (p === null) continue;
    if (p > 0) wins++;
    if (e.dir === 1) { ln++; lnet += p; } else { sn++; snet += p; }
  }
  const tot = ln + sn;
  const la = ln ? lnet / ln - BL : 0;
  const sa = sn ? snet / sn - BS : 0;
  return {
    ...respectRate(events),
    traded: tot,
    longs: ln, shorts: sn,
    shortShare: tot ? (100 * sn) / tot : NaN,
    winRate: tot ? (100 * wins) / tot : NaN,
    raw: tot ? (lnet + snet) / tot : NaN,
    alpha: tot ? (la * ln + sa * sn) / tot : NaN,
  };
}

// ── the generator: a fixed grid of round numbers ─────────────────────────────
/**
 * Every multiple of `step` that the sample's price range visits. These are
 * constants: known before the first bar, never revised, never following price.
 * `offset` shifts the whole grid off the round values — the control.
 */
function roundGrid(step, offset = 0) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < N; i++) { if (bars[i].l < lo) lo = bars[i].l; if (bars[i].h > hi) hi = bars[i].h; }
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step; v += step) out.push(+(v + offset).toFixed(6));
  return out;
}

/** How "round" a value is: 100 > 50 > 25 > 10 > 5. Higher rank = rounder. */
function roundness(v) {
  const near = (m) => Math.abs(v / m - Math.round(v / m)) < 1e-6;
  if (near(1000)) return 5;
  if (near(500)) return 4;
  if (near(100)) return 3;
  if (near(50)) return 2;
  if (near(25) || near(10)) return 1;
  return 0;
}

/**
 * Discrete test events against ONE fixed level value.
 *
 * Semantics are a line-for-line match of tools/level_events.js:levelTestEvents
 * with a constant line — price must have been `approachAtr` away, then arrive
 * within `tolAtr`, then react; the level locks until price walks `resetAtr`
 * off. The only thing removed is the level-changed reset, which cannot fire
 * because the level never changes.
 */
function constLevelEvents(b, atr, L, opts = {}) {
  const tolAtr = opts.tolAtr ?? 0.20;
  const approachAtr = opts.approachAtr ?? 1.5;
  const breakAtr = opts.breakAtr ?? 0.25;
  const resetAtr = opts.resetAtr ?? 1.0;
  // A psychological level arguably has a FIXED dollar half-width, not an
  // ATR-scaled one — nobody widens their 4000 order because volatility rose.
  // These overrides make that testable.
  const tolUsd = opts.tolUsd, approachUsd = opts.approachUsd, resetUsd = opts.resetUsd, breakUsd = opts.breakUsd;

  const events = [];
  let approached = false, locked = false;
  for (let i = 1; i < b.length; i++) {
    const a = atr[i];
    if (!Number.isFinite(a) || a <= 0) continue;
    const bar = b[i];
    const tol = tolUsd ?? a * tolAtr;
    const appr = approachUsd ?? a * approachAtr;
    const reset = resetUsd ?? a * resetAtr;
    const brkD = breakUsd ?? a * breakAtr;
    const dist = Math.abs(bar.c - L);
    if (locked && dist > reset) locked = false;
    if (dist >= appr) approached = true;
    if (!approached || locked) continue;

    const fromAbove = b[i - 1].c > L;
    const reached = fromAbove ? bar.l <= L + tol : bar.h >= L - tol;
    if (!reached) continue;

    if (fromAbove) {
      if (bar.c > L + tol * 0.5) events.push({ i, dir: 1, kind: 'reject', level: L });
      else if (bar.c < L - brkD) events.push({ i, dir: -1, kind: 'break', level: L });
      else continue;
    } else {
      if (bar.c < L - tol * 0.5) events.push({ i, dir: -1, kind: 'reject', level: L });
      else if (bar.c > L + brkD) events.push({ i, dir: 1, kind: 'break', level: L });
      else continue;
    }
    locked = true;
    approached = false;
  }
  return events;
}

/**
 * All test events for a whole grid, detected on `minutes` candles and mapped
 * back to the 1m bar on which that candle closed.
 */
const GRID_CACHE = new Map();
function gridEvents(step, opts = {}) {
  const key = `${step}|${opts.minutes ?? 1}|${opts.offset ?? 0}|${opts.tolAtr ?? 0.20}|${opts.approachAtr ?? 1.5}|${opts.breakAtr ?? 0.25}|${opts.resetAtr ?? 1.0}|${opts.tolUsd ?? ''}|${opts.approachUsd ?? ''}|${opts.resetUsd ?? ''}|${opts.breakUsd ?? ''}`;
  if (GRID_CACHE.has(key)) return GRID_CACHE.get(key);
  const v = gridEventsRaw(step, opts);
  if (GRID_CACHE.size < 400) GRID_CACHE.set(key, v);
  return v;
}
function gridEventsRaw(step, opts = {}) {
  const minutes = opts.minutes ?? 1;
  const offset = opts.offset ?? 0;
  const { bars: b, lastOf, atr } = minutes === 1
    ? { bars, lastOf: null, atr: atr1 }
    : tf(minutes);
  const grid = roundGrid(step, offset);
  const all = [];
  for (const L of grid) {
    for (const e of constLevelEvents(b, atr, L, opts)) {
      const i1 = minutes === 1 ? e.i : lastOf[e.i];
      if (i1 < 1 || i1 >= N - 2) continue;
      all.push({ i: i1, dir: e.dir, kind: e.kind, level: e.level, rank: roundness(e.level), htf: e.i });
    }
  }
  all.sort((x, y) => x.i - y.i || x.level - y.level);
  // Two grid members cannot honestly be tested by the same candle: keep the nearer.
  const out = [];
  for (const e of all) {
    const prev = out[out.length - 1];
    if (prev && prev.i === e.i) {
      if (Math.abs(bars[e.i].c - e.level) < Math.abs(bars[prev.i].c - prev.level)) out[out.length - 1] = e;
      continue;
    }
    out.push(e);
  }
  return out;
}

// ── excursion ────────────────────────────────────────────────────────────────
/** Favourable / adverse travel in points over `horizon` minutes, in the event's direction. */
function excursion(events, horizon) {
  const mfe = [], mae = [];
  for (const e of events) {
    const entry = bars[e.i].c;
    const end = Math.min(N - 1, e.i + horizon);
    let f = 0, a = 0;
    for (let j = e.i + 1; j <= end; j++) {
      const up = (bars[j].h - entry) * e.dir / PU;
      const dn = (bars[j].l - entry) * e.dir / PU;
      if (e.dir === 1) { if (up > f) f = up; if (dn < a) a = dn; }
      else { const hi = (entry - bars[j].l) / PU, lo = (entry - bars[j].h) / PU; if (hi > f) f = hi; if (lo < a) a = lo; }
    }
    mfe.push(f); mae.push(-a);
  }
  const q = (arr, p) => { const s = arr.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
  return {
    n: events.length,
    mfe50: q(mfe, 0.5), mfe25: q(mfe, 0.25), mfe75: q(mfe, 0.75), mfe90: q(mfe, 0.9),
    mae50: q(mae, 0.5), mae75: q(mae, 0.75), mae90: q(mae, 0.9),
  };
}

/** Mean signed travel: how far price went the event's way minus how far it went against. */
function asymmetry(events, horizon) {
  let sf = 0, sa = 0, sd = 0, n = 0;
  for (const e of events) {
    const entry = bars[e.i].c;
    const end = Math.min(N - 1, e.i + horizon);
    if (end <= e.i) continue;
    let f = 0, a = 0;
    for (let j = e.i + 1; j <= end; j++) {
      const up = e.dir === 1 ? (bars[j].h - entry) / PU : (entry - bars[j].l) / PU;
      const dn = e.dir === 1 ? (bars[j].l - entry) / PU : (entry - bars[j].h) / PU;
      if (up > f) f = up;
      if (dn < a) a = dn;
    }
    sf += f; sa += -a; sd += (bars[end].c - entry) * e.dir / PU; n++;
  }
  return { n, mfe: sf / n, mae: sa / n, drift: sd / n, edge: (sf + sa) / n === 0 ? 0 : (sf - sa) / n };
}

// ── session ──────────────────────────────────────────────────────────────────
function sessionOf(t) {
  const h = new Date(t).getUTCHours();
  if (h >= 0 && h < 7) return 'asia';
  if (h >= 7 && h < 12) return 'london';
  if (h >= 12 && h < 17) return 'overlap';
  if (h >= 17 && h < 21) return 'ny-pm';
  return 'late';
}

// ── selection helpers ────────────────────────────────────────────────────────
const pick = (events, fn) => events.filter(fn);
const bounce = e => e.kind === 'reject';
const brk = e => e.kind === 'break';
const flip = events => events.map(e => ({ ...e, dir: -e.dir }));

const f = (x, d = 2) => Number.isFinite(x) ? (x > 0 && d > 0 ? '' : '') + x.toFixed(d) : '—';
const sgn = (x, d = 2) => Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) : '—';
const line = (n = 96) => console.log('─'.repeat(n));

// ═════════════════════════════════════════════════════════════════════════════
//  STAGES
// ═════════════════════════════════════════════════════════════════════════════

function stageProbe() {
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
  const a = atr1.filter(Number.isFinite).sort((x, y) => x - y);
  console.log(`bars ${N.toLocaleString()}  ${new Date(bars[0].t).toISOString().slice(0, 10)} → ${new Date(bars[N - 1].t).toISOString().slice(0, 10)}`);
  console.log(`price ${lo.toFixed(2)} → ${hi.toFixed(2)}   net ${((bars[N - 1].c - bars[0].c) / PU).toFixed(0)} pts`);
  console.log(`1m ATR14 usd: p10 ${a[Math.floor(a.length * 0.1)].toFixed(3)}  median ${a[Math.floor(a.length * 0.5)].toFixed(3)}  p90 ${a[Math.floor(a.length * 0.9)].toFixed(3)}`);
  console.log(`   → 0.20 ATR tolerance is ${(a[Math.floor(a.length * 0.5)] * 0.20 / PU).toFixed(1)} points at the median`);
  for (const m of [5, 15, 60, 240]) {
    const t = tf(m), s = t.atr.filter(Number.isFinite).sort((x, y) => x - y);
    console.log(`${TF_NAME[m].padStart(4)} bars ${String(t.bars.length).padStart(7)}   ATR14 median ${s[Math.floor(s.length / 2)].toFixed(3)} usd  (0.20 ATR = ${(s[Math.floor(s.length / 2)] * 0.2 / PU).toFixed(1)} pts)`);
  }
  console.log(`blind long ${sgn(blind(1, TP0, SL0, MAX_HOLD))}   blind short ${sgn(blind(-1, TP0, SL0, MAX_HOLD))}   (90/90, 1440m)`);
  for (const grid of [10, 25, 50, 100]) console.log(`grid $${grid}: ${roundGrid(grid).length} levels`);
}

function stageCurrent() {
  console.log('THE CURRENT CONSTRUCTION — levels.js roundNumberLevels (nearest round number to the close)');
  console.log(`scored exactly like tools/sweep_timeframes.js: 90 pt target, 90 pt stop, 1440 m hold, cost ${COST}`);
  line();
  console.log('step'.padEnd(8) + 'tests'.padStart(8) + 'respect%'.padStart(10) + 'short%'.padStart(9) + 'raw'.padStart(9) + 'alpha'.padStart(9));
  line();
  for (const step of [5, 10, 25, 50, 100]) {
    const s = score(levelTestEvents(bars, LV.roundNumberLevels(bars, { step }).line, atr1));
    console.log(`$${step}`.padEnd(8) + String(s.tests).padStart(8) + f(s.respect).padStart(10) +
      f(s.shortShare, 1).padStart(9) + sgn(s.raw).padStart(9) + sgn(s.alpha).padStart(9));
  }
  line();
  console.log('random level respect = 68.95%. Anything within a point of that is noise.');
}

function stageGrid() {
  console.log('THE FIXED GRID — every round number watched independently, one at a time. 90/90 scoring.');
  line(112);
  console.log('tf'.padEnd(5) + 'step'.padEnd(7) + 'tol'.padEnd(7) + 'appr'.padEnd(7) +
    'tests'.padStart(7) + 'resp%'.padStart(8) + 'short%'.padStart(8) +
    'alpha'.padStart(9) + 'bounceN'.padStart(9) + 'bounceA'.padStart(9) + 'breakN'.padStart(8) + 'breakA'.padStart(9));
  line(112);
  const rows = [];
  for (const m of [1, 5, 15, 60, 240]) {
    for (const step of [10, 25, 50, 100]) {
      for (const tolAtr of [0.10, 0.25, 0.50, 1.00]) {
        for (const approachAtr of [1.5, 3.0]) {
          const ev = gridEvents(step, { minutes: m, tolAtr, approachAtr });
          if (ev.length < 100) continue;
          const s = score(ev);
          const b = score(pick(ev, bounce));
          const k = score(pick(ev, brk));
          rows.push({ m, step, tolAtr, approachAtr, s, b, k });
          console.log(TF_NAME[m].padEnd(5) + `$${step}`.padEnd(7) + tolAtr.toFixed(2).padEnd(7) + approachAtr.toFixed(1).padEnd(7) +
            String(s.tests).padStart(7) + f(s.respect, 1).padStart(8) + f(s.shortShare, 1).padStart(8) +
            sgn(s.alpha).padStart(9) + String(b.tests).padStart(9) + sgn(b.alpha).padStart(9) +
            String(k.tests).padStart(8) + sgn(k.alpha).padStart(9));
        }
      }
    }
  }
  line(112);
  const byResp = rows.filter(r => r.s.tests >= 100).sort((a, b) => b.s.respect - a.s.respect).slice(0, 8);
  console.log('\ntop respect (vs 68.95 random):');
  for (const r of byResp) console.log(`  ${TF_NAME[r.m]} $${r.step} tol ${r.tolAtr} appr ${r.approachAtr}  respect ${f(r.s.respect, 1)}  (${sgn(r.s.respect - RANDOM_RESPECT, 1)})  ${r.s.tests} tests`);
  const byAlpha = rows.filter(r => r.s.tests >= 100).sort((a, b) => b.s.alpha - a.s.alpha).slice(0, 8);
  console.log('\ntop alpha at 90/90 (all events):');
  for (const r of byAlpha) console.log(`  ${TF_NAME[r.m]} $${r.step} tol ${r.tolAtr} appr ${r.approachAtr}  alpha ${sgn(r.s.alpha)}  ${r.s.tests} tests  respect ${f(r.s.respect, 1)}`);
}

function stageExcursion() {
  console.log('WHAT DOES A TEST ACTUALLY PRODUCE? median favourable / adverse travel, in points.');
  console.log('If MFE median is 20 points, a 90 point target is a losing bet by construction.\n');
  const cfgs = [];
  for (const m of [1, 15, 60, 240]) for (const step of [10, 50, 100]) cfgs.push({ m, step });
  line(104);
  console.log('tf'.padEnd(5) + 'step'.padEnd(7) + 'set'.padEnd(9) + 'n'.padStart(7) +
    'MFE25'.padStart(8) + 'MFE50'.padStart(8) + 'MFE75'.padStart(8) + 'MFE90'.padStart(8) +
    'MAE50'.padStart(8) + 'MAE75'.padStart(8) + 'MAE90'.padStart(8) + '  horizon');
  line(104);
  for (const { m, step } of cfgs) {
    const ev = gridEvents(step, { minutes: m, tolAtr: 0.25, approachAtr: 1.5 });
    if (ev.length < 100) continue;
    for (const [name, sel] of [['bounce', bounce], ['break', brk]]) {
      const set = pick(ev, sel);
      if (set.length < 100) continue;
      for (const h of [60, 240]) {
        const x = excursion(set, h);
        console.log(TF_NAME[m].padEnd(5) + `$${step}`.padEnd(7) + name.padEnd(9) + String(x.n).padStart(7) +
          f(x.mfe25, 0).padStart(8) + f(x.mfe50, 0).padStart(8) + f(x.mfe75, 0).padStart(8) + f(x.mfe90, 0).padStart(8) +
          f(x.mae50, 0).padStart(8) + f(x.mae75, 0).padStart(8) + f(x.mae90, 0).padStart(8) + `  ${h}m`);
      }
    }
  }
  line(104);
}

function stageTuned() {
  const TARGETS = [
    [10, 10], [15, 15], [20, 20], [30, 30], [45, 45],
    [15, 30], [20, 40], [30, 60], [20, 10], [30, 15], [40, 20], [60, 30],
  ];
  const HOLD = 240;
  console.log(`TARGET SIZING. hold ${HOLD}m. Every row is direction-adjusted against a blind baseline recomputed at that exact target/stop.`);
  line(104);
  console.log('cfg'.padEnd(26) + 'read'.padEnd(9) + 'n'.padStart(6) + '  tp/sl'.padEnd(10) + 'win%'.padStart(7) + 'raw'.padStart(9) + 'alpha'.padStart(9) + 'BLl'.padStart(8) + 'BLs'.padStart(8));
  line(104);
  const best = [];
  for (const m of [1, 15, 60, 240]) {
    for (const step of [10, 50, 100]) {
      for (const tolAtr of [0.25, 0.50]) {
        const ev = gridEvents(step, { minutes: m, tolAtr, approachAtr: 1.5 });
        if (ev.length < 100) continue;
        const sets = {
          'bounce': pick(ev, bounce),
          'bounce-inv': flip(pick(ev, bounce)),
          'break': pick(ev, brk),
          'break-inv': flip(pick(ev, brk)),
        };
        for (const [rname, set] of Object.entries(sets)) {
          if (set.length < 100) continue;
          for (const [tp, sl] of TARGETS) {
            const s = score(set, tp, sl, HOLD);
            if (s.traded < 100) continue;
            const rec = { m, step, tolAtr, rname, tp, sl, s };
            best.push(rec);
          }
        }
      }
    }
  }
  best.sort((a, b) => b.s.alpha - a.s.alpha);
  for (const r of best.slice(0, 30)) {
    console.log(`${TF_NAME[r.m]} $${r.step} tol${r.tolAtr}`.padEnd(26) + r.rname.padEnd(9) + String(r.s.traded).padStart(6) +
      `  ${r.tp}/${r.sl}`.padEnd(10) + f(r.s.winRate, 1).padStart(7) + sgn(r.s.raw).padStart(9) + sgn(r.s.alpha).padStart(9) +
      sgn(blind(1, r.tp, r.sl, HOLD)).padStart(8) + sgn(blind(-1, r.tp, r.sl, HOLD)).padStart(8));
  }
  line(104);
  console.log('\nworst 8 (the other side of the same coin — a strong negative is a real signal read backwards):');
  for (const r of best.slice(-8)) {
    console.log(`  ${TF_NAME[r.m]} $${r.step} tol${r.tolAtr} ${r.rname} ${r.tp}/${r.sl}  alpha ${sgn(r.s.alpha)}  n ${r.s.traded}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  THE CONTROL — the only thing that makes any of the above meaningful.
//
//  Shift the whole grid off the round values and re-run the identical
//  machinery. The control absorbs everything that is a property of the METHOD
//  rather than of roundness: the tolerance inflating the respect rate, the
//  approach requirement selecting for trending bars, the direction mix. What
//  survives the subtraction is the part that is actually about round numbers.
// ═════════════════════════════════════════════════════════════════════════════
const OFFSETS = [0.17, 0.37, 0.61, 0.83];   // fractions of step; none of these is a round price

function withControl(step, opts, sel, tp, sl, hold) {
  const ev = gridEvents(step, opts);
  const set = sel ? pick(ev, sel) : ev;
  const g = score(set, tp, sl, hold);
  let cTests = 0, cResp = 0, cAlpha = 0, cN = 0;
  const alphas = [];
  for (const o of OFFSETS) {
    const cev = gridEvents(step, { ...opts, offset: +(step * o).toFixed(4) });
    const cset = sel ? pick(cev, sel) : cev;
    if (cset.length < 30) continue;
    const c = score(cset, tp, sl, hold);
    cTests += c.tests; cResp += c.respect; cAlpha += c.alpha; cN++;
    alphas.push(c.alpha);
  }
  const ctl = cN ? { tests: cTests / cN, respect: cResp / cN, alpha: cAlpha / cN, spread: Math.max(...alphas) - Math.min(...alphas) } : null;
  return { g, ctl, dResp: ctl ? g.respect - ctl.respect : NaN, dAlpha: ctl ? g.alpha - ctl.alpha : NaN };
}

function stageAsym() {
  console.log('SIGNED TRAVEL after a test — mean favourable minus mean adverse, in points.');
  console.log('If this is ~0 at every horizon the level has no directional content and no target can rescue it.\n');
  line(108);
  console.log('tf'.padEnd(5) + 'step'.padEnd(7) + 'set'.padEnd(8) + 'grid?'.padEnd(8) + 'n'.padStart(7) +
    [5, 15, 30, 60, 240].map(h => `${h}m`.padStart(9)).join('') + '   (mfe-mae)');
  line(108);
  for (const m of [1, 5, 15, 60]) {
    for (const step of [10, 50]) {
      for (const [gname, off] of [['round', 0], ['offset', step * 0.37]]) {
        const ev = gridEvents(step, { minutes: m, tolAtr: 0.25, approachAtr: 1.5, offset: off });
        for (const [name, sel] of [['bounce', bounce], ['break', brk]]) {
          const set = pick(ev, sel);
          if (set.length < 100) continue;
          const cells = [5, 15, 30, 60, 240].map(h => sgn(asymmetry(set, h).edge, 1).padStart(9)).join('');
          console.log(TF_NAME[m].padEnd(5) + `$${step}`.padEnd(7) + name.padEnd(8) + gname.padEnd(8) + String(set.length).padStart(7) + cells);
        }
      }
    }
  }
  line(108);
}

function stageHonest() {
  const HOLD = 240;
  console.log('GRID MINUS CONTROL. Control = the same grid shifted to non-round prices, 4 offsets, averaged.');
  console.log(`hold ${HOLD}m; blind baselines recomputed per target.\n`);
  const CFG = [];
  for (const m of [1, 5, 15, 60]) for (const step of [10, 25, 50, 100]) for (const tolAtr of [0.10, 0.25, 0.50]) CFG.push({ minutes: m, step, tolAtr, approachAtr: 1.5 });
  line(118);
  console.log('tf'.padEnd(4) + 'step'.padEnd(6) + 'tol'.padEnd(6) + 'set'.padEnd(8) + 'tp/sl'.padEnd(8) +
    'n'.padStart(7) + 'resp'.padStart(7) + 'ctlR'.padStart(7) + 'dResp'.padStart(7) +
    'alpha'.padStart(8) + 'ctlA'.padStart(8) + 'dAlpha'.padStart(8) + 'ctlSpr'.padStart(8));
  line(118);
  const out = [];
  for (const c of CFG) {
    for (const [name, sel] of [['bounce', bounce], ['break', brk]]) {
      for (const [tp, sl] of [[90, 90], [30, 30], [60, 60]]) {
        const r = withControl(c.step, { minutes: c.minutes, tolAtr: c.tolAtr, approachAtr: c.approachAtr }, sel, tp, sl, HOLD);
        if (r.g.traded < 100 || !r.ctl) continue;
        out.push({ c, name, tp, sl, ...r });
        console.log(TF_NAME[c.minutes].padEnd(4) + `$${c.step}`.padEnd(6) + c.tolAtr.toFixed(2).padEnd(6) + name.padEnd(8) + `${tp}/${sl}`.padEnd(8) +
          String(r.g.traded).padStart(7) + f(r.g.respect, 1).padStart(7) + f(r.ctl.respect, 1).padStart(7) + sgn(r.dResp, 1).padStart(7) +
          sgn(r.g.alpha).padStart(8) + sgn(r.ctl.alpha).padStart(8) + sgn(r.dAlpha).padStart(8) + f(r.ctl.spread, 1).padStart(8));
      }
    }
  }
  line(118);
  out.sort((a, b) => b.dAlpha - a.dAlpha);
  console.log('\nbest grid-minus-control alpha:');
  for (const r of out.slice(0, 12)) console.log(`  ${TF_NAME[r.c.minutes]} $${r.c.step} tol${r.c.tolAtr} ${r.name} ${r.tp}/${r.sl}  dAlpha ${sgn(r.dAlpha)}  (grid ${sgn(r.g.alpha)}, ctl ${sgn(r.ctl.alpha)} +-${f(r.ctl.spread / 2, 1)})  n ${r.g.traded}`);
  console.log('\nbest grid-minus-control respect:');
  const byR = out.slice().sort((a, b) => b.dResp - a.dResp);
  for (const r of byR.slice(0, 8)) console.log(`  ${TF_NAME[r.c.minutes]} $${r.c.step} tol${r.c.tolAtr} ${r.name}  dResp ${sgn(r.dResp, 2)}  (grid ${f(r.g.respect, 1)}, ctl ${f(r.ctl.respect, 1)})  n ${r.g.tests}`);
}

/**
 * How round a price is, as a label. Built from ONE $5 grid so the strata are
 * cut out of the same sample and share the same detector — the cleanest
 * possible control, because a multiple of 10 and a multiple of 100 are found by
 * identical machinery and differ only in roundness.
 */
function rankOf(v) {
  const near = m => Math.abs(v / m - Math.round(v / m)) < 1e-6;
  if (near(500)) return '500';
  if (near(100)) return '100';
  if (near(50)) return '50';
  if (near(25)) return '25';
  if (near(10)) return '10';
  return '5';
}
const RANKS = ['5', '10', '25', '50', '100', '500'];

function stageRank() {
  const HOLD = 240;
  console.log('ROUNDNESS AS A DOSE. One $5 grid, one detector, events cut by how round the level is.');
  console.log('Multiples of 5 and multiples of 100 are found by identical machinery — only roundness differs,');
  console.log('so a rising alpha across the strata cannot be a method artifact.\n');
  for (const m of [1, 5, 15, 60]) {
    for (const tolAtr of [0.25]) {
      const ev = gridEvents(5, { minutes: m, tolAtr, approachAtr: 1.5 });
      const off = gridEvents(5, { minutes: m, tolAtr, approachAtr: 1.5, offset: 5 * 0.37 });
      console.log(`\n${TF_NAME[m]} detection, tol ${tolAtr} ATR, approach 1.5 ATR   (${ev.length} events)`);
      line(104);
      console.log('level is a multiple of'.padEnd(24) + 'set'.padEnd(9) + 'n'.padStart(7) +
        'resp%'.padStart(8) + 'a90/90'.padStart(9) + 'a60/60'.padStart(9) + 'a30/30'.padStart(9) + 'a60/30'.padStart(9) + '  mfe-mae@60m');
      line(104);
      for (const [setName, sel] of [['bounce', bounce], ['break', brk]]) {
        for (const r of RANKS) {
          const idx = RANKS.indexOf(r);
          const set = ev.filter(e => sel(e) && RANKS.indexOf(rankOf(e.level)) >= idx);
          if (set.length < 100) continue;
          const all = ev.filter(e => RANKS.indexOf(rankOf(e.level)) >= idx);
          const s90 = score(set, 90, 90, HOLD), s60 = score(set, 60, 60, HOLD);
          const s30 = score(set, 30, 30, HOLD), s63 = score(set, 60, 30, HOLD);
          console.log(`≥ $${r}`.padEnd(24) + setName.padEnd(9) + String(set.length).padStart(7) +
            f(respectRate(all).respect, 1).padStart(8) + sgn(s90.alpha).padStart(9) + sgn(s60.alpha).padStart(9) +
            sgn(s30.alpha).padStart(9) + sgn(s63.alpha).padStart(9) + sgn(asymmetry(set, 60).edge, 1).padStart(14));
        }
        const cset = off.filter(sel);
        if (cset.length >= 100) {
          const c90 = score(cset, 90, 90, HOLD), c60 = score(cset, 60, 60, HOLD);
          const c30 = score(cset, 30, 30, HOLD), c63 = score(cset, 60, 30, HOLD);
          console.log('CONTROL off-grid'.padEnd(24) + setName.padEnd(9) + String(cset.length).padStart(7) +
            f(respectRate(off).respect, 1).padStart(8) + sgn(c90.alpha).padStart(9) + sgn(c60.alpha).padStart(9) +
            sgn(c30.alpha).padStart(9) + sgn(c63.alpha).padStart(9) + sgn(asymmetry(cset, 60).edge, 1).padStart(14));
        }
      }
      line(104);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  THE DECISIVE TEST
//
//  Slide the identical grid to twelve non-round offsets. Same spacing, same
//  density, same detector, same sample, same everything — the only thing that
//  changes is whether the numbers are round. The round grid's alpha is then
//  read against the spread of its own twelve shadows. If it is not outside
//  them, roundness carries no information, and no amount of target tuning will
//  invent any.
// ═════════════════════════════════════════════════════════════════════════════
const OFF_FRACS = [0.07, 0.13, 0.19, 0.23, 0.31, 0.37, 0.41, 0.47, 0.59, 0.67, 0.79, 0.89];

function shadowStats(step, opts, sel, tp, sl, hold) {
  const vals = [], resp = [], ns = [];
  for (const fr of OFF_FRACS) {
    const ev = gridEvents(step, { ...opts, offset: +(step * fr).toFixed(4) });
    const set = sel ? ev.filter(sel) : ev;
    if (set.length < 50) continue;
    vals.push(score(set, tp, sl, hold).alpha);
    resp.push(respectRate(ev).respect);
    ns.push(set.length);
  }
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)); };
  return { n: vals.length, alphaMean: mean(vals), alphaSd: sd(vals), alphas: vals, respMean: mean(resp), respSd: sd(resp), nMean: mean(ns) };
}

function stageZ() {
  const HOLD = 240;
  console.log('ROUND GRID vs TWELVE SHADOW GRIDS AT THE SAME SPACING.');
  console.log('z is how many shadow-standard-deviations the round grid sits above its own controls.');
  console.log('|z| under about 2 is nothing. beat = how many of the 12 shadows it beat.\n');
  line(120);
  console.log('tf'.padEnd(4) + 'step'.padEnd(6) + 'tol'.padEnd(10) + 'set'.padEnd(8) + 'tp/sl'.padEnd(8) +
    'n'.padStart(7) + 'ctlN'.padStart(7) + 'resp'.padStart(7) + 'ctlR'.padStart(7) + 'zResp'.padStart(7) +
    'alpha'.padStart(8) + 'ctlA'.padStart(8) + 'sd'.padStart(7) + 'z'.padStart(7) + 'beat'.padStart(6));
  line(120);
  const TOLS = [{ tag: '0.25atr', o: { tolAtr: 0.25 } }, { tag: '$0.50', o: { tolUsd: 0.5, approachUsd: 6, resetUsd: 4, breakUsd: 0.6 } }];
  const rows = [];
  for (const m of [1, 5, 15]) {
    for (const step of [10, 50, 100]) {
      for (const T of TOLS) {
        const base = { minutes: m, approachAtr: 1.5, ...T.o };
        const ev = gridEvents(step, base);
        const gResp = respectRate(ev).respect;
        for (const [sname, sel] of [['bounce', bounce], ['break', brk]]) {
          const set = ev.filter(sel);
          if (set.length < 100) continue;
          for (const [tp, sl] of [[90, 90], [45, 45], [60, 30]]) {
            const g = score(set, tp, sl, HOLD);
            if (g.traded < 100) continue;
            const sh = shadowStats(step, base, sel, tp, sl, HOLD);
            if (sh.n < 6) continue;
            const z = sh.alphaSd > 0 ? (g.alpha - sh.alphaMean) / sh.alphaSd : NaN;
            const zr = sh.respSd > 0 ? (gResp - sh.respMean) / sh.respSd : NaN;
            const beat = sh.alphas.filter(v => g.alpha > v).length;
            rows.push({ m, step, tol: T.tag, sname, tp, sl, g, sh, z, zr, beat, gResp });
            console.log(TF_NAME[m].padEnd(4) + `$${step}`.padEnd(6) + T.tag.padEnd(10) + sname.padEnd(8) + `${tp}/${sl}`.padEnd(8) +
              String(g.traded).padStart(7) + f(sh.nMean, 0).padStart(7) +
              f(gResp, 1).padStart(7) + f(sh.respMean, 1).padStart(7) + sgn(zr, 1).padStart(7) +
              sgn(g.alpha).padStart(8) + sgn(sh.alphaMean).padStart(8) + f(sh.alphaSd, 1).padStart(7) +
              sgn(z, 1).padStart(7) + `${beat}/${sh.alphas.length}`.padStart(6));
          }
        }
      }
    }
  }
  line(120);
  rows.sort((a, b) => b.z - a.z);
  console.log('\nranked by z:');
  for (const r of rows.slice(0, 10)) console.log(`  ${TF_NAME[r.m]} $${r.step} ${r.tol} ${r.sname} ${r.tp}/${r.sl}  z ${sgn(r.z, 2)}  alpha ${sgn(r.g.alpha)} vs shadows ${sgn(r.sh.alphaMean)}+-${f(r.sh.alphaSd, 1)}  n ${r.g.traded}  beat ${r.beat}/12`);
  console.log('\nrespect z, best:');
  const byz = rows.filter(r => r.sname === 'bounce' && r.tp === 90).sort((a, b) => b.zr - a.zr);
  for (const r of byz.slice(0, 8)) console.log(`  ${TF_NAME[r.m]} $${r.step} ${r.tol}  respect ${f(r.gResp, 2)} vs shadows ${f(r.sh.respMean, 2)}+-${f(r.sh.respSd, 2)}  z ${sgn(r.zr, 2)}`);
}

function stageSession() {
  const HOLD = 240;
  console.log('DOES THE EFFECT LIVE IN ONE SESSION? round grid minus the mean of the 12 shadow grids, per session.\n');
  const SESS = ['asia', 'london', 'overlap', 'ny-pm', 'late'];
  for (const m of [1, 5]) {
    for (const step of [10, 50]) {
      const base = { minutes: m, tolAtr: 0.25, approachAtr: 1.5 };
      const ev = gridEvents(step, base);
      const shadows = OFF_FRACS.map(fr => gridEvents(step, { ...base, offset: +(step * fr).toFixed(4) }));
      console.log(`${TF_NAME[m]} $${step} tol 0.25 ATR, 90/90`);
      line(96);
      console.log('session'.padEnd(10) + 'set'.padEnd(9) + 'n'.padStart(7) + 'resp'.padStart(8) + 'ctlResp'.padStart(9) +
        'alpha'.padStart(9) + 'ctlAlpha'.padStart(10) + 'delta'.padStart(9));
      line(96);
      for (const s of SESS) {
        for (const [sname, sel] of [['bounce', bounce], ['break', brk]]) {
          const set = ev.filter(e => sel(e) && sessionOf(bars[e.i].t) === s);
          if (set.length < 100) continue;
          const g = score(set, 90, 90, HOLD);
          const cs = shadows.map(sh => sh.filter(e => sel(e) && sessionOf(bars[e.i].t) === s)).filter(x => x.length >= 40);
          const ca = cs.map(x => score(x, 90, 90, HOLD).alpha);
          const cr = cs.map(x => respectRate(x).respect);
          const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
          console.log(s.padEnd(10) + sname.padEnd(9) + String(g.traded).padStart(7) + f(respectRate(set).respect, 1).padStart(8) +
            f(mean(cr), 1).padStart(9) + sgn(g.alpha).padStart(9) + sgn(mean(ca)).padStart(10) + sgn(g.alpha - mean(ca)).padStart(9));
        }
      }
      line(96);
      console.log('');
    }
  }
}

module.exports = { loadBars, roundGrid, roundness, rankOf, constLevelEvents, gridEvents, excursion, asymmetry, score, race, blind, sessionOf, withControl, bounce, brk, flip, pick, bars, atr1, N, PU, COST, TF_NAME };

if (require.main === module) {
  const stage = process.argv[2] || 'probe';
  const S = { probe: stageProbe, current: stageCurrent, grid: stageGrid, excursion: stageExcursion, tuned: stageTuned, asym: stageAsym, honest: stageHonest, rank: stageRank, z: stageZ, session: stageSession };
  (S[stage] || stageProbe)();
}
