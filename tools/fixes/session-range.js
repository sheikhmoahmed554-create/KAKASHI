'use strict';
/* ===========================================================================
 * SESSION RANGE HIGH / LOW  —  rebuilt and remeasured
 * ===========================================================================
 *
 * The starting construction (tools/levels.js :: sessionRangeLevels) is:
 *
 *     out[i] = |close - asiaHigh| < |close - asiaLow| ? asiaHigh : asiaLow
 *
 * That is not a level. It is a step function that flips to whichever edge
 * price happens to be nearest, so the "level" moves every time price crosses
 * the middle of the range. Half of every genuine test of the low is booked
 * against the high and vice versa. The first thing to fix is the definition:
 * the Asia high is one level and the Asia low is a different level, each a
 * fixed number for the whole day, each tested on its own.
 *
 * Four things get swept here, in the order the brief lists them:
 *
 *   1. TIMEFRAME.  For a session range the honest analogue of "timeframe" is
 *      the session window itself — which hours define the range, and how long
 *      the resulting level stays live.  The literal candle-timeframe sweep is
 *      run too (stage `tf`) but it can only ever hurt: a session high is
 *      max(high) over a window, which is identical whether you take it from
 *      1m or 15m candles, so resampling adds a projection lag and nothing else.
 *
 *   2. DEFINITION.  Each edge as its own fixed value (above), plus a causal
 *      width filter — a 20 point Asia range and a 120 point Asia range are not
 *      the same object.
 *
 *   3. TARGET SIZE.  The 90/90 box is replaced by a measured one: median
 *      favourable and adverse excursion after a test, then a target and stop
 *      sized to that.  Blind baselines are recomputed at every (target, stop)
 *      pair, because -4.8 / +4.3 are 90/90 numbers and mean nothing at 25/20.
 *
 *   4. DIRECTION.  Every event is scored five ways: fade the rejection, follow
 *      the break, fade the break (the liquidity-sweep reading), invert the
 *      rejection, and everything-as-generated.
 *
 * CAUSALITY.  A session range is published on the first bar that is outside
 * the session window, delayed one further bar, and it is built only from bars
 * whose timestamps are strictly earlier.  Stage `causal` proves this by
 * rebuilding every level from a truncated bar array and checking the value is
 * bit-identical.
 *
 * DATA NOTE.  This feed has no 00:00 UTC hour at all — it runs 01:00–23:59,
 * Monday to Friday, 140 days.  So the shipped `startHour: 0` window is really
 * 01:00–07:00.  Sessions below are stated in UTC and clipped by the data.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THE MEASUREMENT SAID  (stage `report` reproduces this table)
 *
 *   shipped: nearest edge, 90/90          n 1534   alpha  +0.95   t 0.41
 *   shipped line, box 150/120             n 1537   alpha  +4.11   t 1.20
 *   edges split, all events, 90/90        n 1539   alpha  +0.87   t 0.38
 *   edges split, bounce only, 90/90       n 1051   alpha  +1.58   t 0.57
 *   edges split, bounce only, 150/120     n 1053   alpha  +5.85   t 1.42
 *   + narrow sessions only, 150/120       n  412   alpha +11.38   t 1.73
 *
 * The definition fix is right and the number moves, but read the attribution
 * honestly: at the 90/90 box, splitting the edges is worth nothing (+0.95 ->
 * +0.87). Almost all of the apparent gain is the bigger box, and a bigger box
 * raises the standard error in exactly the same proportion — the t-statistic
 * barely moves. Nothing here reaches t = 2.
 *
 * Three independent checks say the session extremes are not the source:
 *
 *   RESPECT.  The Asia high is respected 68.8% of the time and the Asia low
 *   67.7%, against 68.95% for a random price level. Both edges are at or
 *   slightly below chance.
 *
 *   HEIGHT PLACEBO.  Lines drawn at low + q*(high-low) for q across the range
 *   score as well as the edges or better — q = 0.3 gives +22.2 at 150/120
 *   against +6.7 for the actual high. The alpha-versus-q curve has no peak at
 *   q = 0 or q = 1.
 *
 *   SHIFT PLACEBO.  Slide the whole range up or down by a fraction of its own
 *   width and trade it identically: the placebo family has mean +3.2 and sd
 *   6.2 while the real range scores +5.85, i.e. z = 0.43. Under the narrow
 *   width filter a placebo shifted +0.3 reaches t = 2.60, higher than the real
 *   range's 1.73.
 *
 *   EXCURSION.  Median favourable travel after a test is 91.8 points at one
 *   hour against 85.4 adverse, and 195.6 against 172.7 at four hours — a ratio
 *   of 1.07 to 1.13 that barely moves with horizon. There is no asymmetry for
 *   a target to exploit, which is why no box rescues this level.
 *
 * The best-looking thing found anywhere was London 08-13 sweep-and-reclaim
 * (poke through the edge, close back inside within 60 bars, fade it) at
 * +19.65 points over 162 events with both sides positive — but t = 1.85, the
 * 95% interval is -1.2 to +40.5, and a range shifted -0.3 of its width scores
 * +20.0 on the same trade. It is a real intraday mean-reversion effect at
 * those hours, not a property of the session high and low.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Usage:
 *   node --max-old-space-size=3500 tools/fixes/session-range.js <stage>
 *     recon      data shape, session widths
 *     baseline   reproduce the calibration numbers
 *     current    the shipped construction, direction-adjusted
 *     tf         literal candle-timeframe sweep of the shipped construction
 *     split      each edge as its own level, across session windows
 *     excursion  measured MFE / MAE after a test  -> target and stop
 *     grid       target x stop grid for the surviving readings
 *     width      range-width filter
 *     sides      long and short alpha separately, every window
 *     placebo    level height inside the range — the decisive control
 *     sweep      sweep-and-reclaim vs break-and-hold
 *     sweepall / sweepparams / sweepplacebo / sweepfinal
 *     firstbreak breakout as a directional signal, by width band
 *     combined   both edges pooled against a placebo distribution
 *     box        box size vs standard error
 *     verdict    full workup of a candidate
 *     chosen     the best build, stress-tested to destruction
 *     report     the before/after table
 *     all        recon + baseline + causal + current + tf + split
 * =========================================================================== */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('../ai963_engine');
const LV = require('../levels');
const { levelTestEvents, respectRate } = require('../level_events');

// ── constants, identical to tools/sweep_timeframes.js ───────────────────────
const PU = 0.10;            // 1 point = 0.10 USD
const COST = 0.5;           // points per round trip
const MAX_HOLD = 1440;      // bars
const RANDOM_RESPECT = 68.95;
const TF_NAME = { 1: '1m', 5: '5m', 15: '15m', 60: '1H', 240: '4H', 1440: 'D' };

// ── data ────────────────────────────────────────────────────────────────────
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

// ── outcome engine ──────────────────────────────────────────────────────────
// One forward walk per entry yields the first-touch bar of every candidate
// target and every candidate stop, so a whole (target, stop) grid comes out of
// a single pass.  Semantics are bit-identical to sweep_timeframes.js::race:
// same-bar ambiguity is discarded, otherwise whichever came first wins, and an
// entry that reaches neither is closed at the horizon.
// Grid extended well past 90 because the measured excursions demand it: median
// favourable travel four hours after a test is roughly 190 points, so a 90
// point target is inside the noise, not beyond it.
const TPS = [10, 15, 20, 25, 30, 40, 50, 60, 75, 90, 120, 150, 200, 250, 300, 400];
const SLS = [10, 15, 20, 25, 30, 40, 50, 60, 75, 90, 120, 150, 200, 250, 300, 400];
const NT = TPS.length, NS = SLS.length, NP = NT * NS;
const IDX90 = TPS.indexOf(90) * NS + SLS.indexOf(90);

const _tpBar = new Int32Array(NT);
const _slBar = new Int32Array(NS);

function walk(i, dir) {
  const e = bars[i].c;
  const end = Math.min(N - 1, i + MAX_HOLD);
  _tpBar.fill(-1); _slBar.fill(-1);
  let ti = 0, si = 0;
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    const fav = dir === 1 ? (b.h - e) / PU : (e - b.l) / PU;
    const adv = dir === 1 ? (e - b.l) / PU : (b.h - e) / PU;
    while (ti < NT && fav >= TPS[ti]) _tpBar[ti++] = j;
    while (si < NS && adv >= SLS[si]) _slBar[si++] = j;
    if (ti >= NT && si >= NS) break;
  }
  return (bars[end].c - e) * dir / PU;   // close-out in points, cost added later
}

/** Accumulate the result of one entry into every (target, stop) cell. */
function accumulate(sum, cnt, closeOut) {
  for (let a = 0; a < NT; a++) {
    const ta = _tpBar[a];
    for (let b = 0; b < NS; b++) {
      const sb = _slBar[b];
      let p;
      if (ta < 0 && sb < 0) p = closeOut - COST;
      else if (ta >= 0 && (sb < 0 || ta < sb)) p = TPS[a] - COST;
      else if (sb >= 0 && (ta < 0 || sb < ta)) p = -SLS[b] - COST;
      else continue;                       // same bar -> ambiguous, discarded
      const k = a * NS + b;
      sum[k] += p; cnt[k]++;
    }
  }
}

function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Blind entry at a uniformly random bar — the direction baseline, per cell. */
function blindGrid(dir, n, seed) {
  const r = rng(seed);
  const sum = new Float64Array(NP), cnt = new Int32Array(NP);
  const lo = 100, hi = N - MAX_HOLD - 2;
  for (let k = 0; k < n; k++) {
    const i = lo + Math.floor(r() * (hi - lo));
    accumulate(sum, cnt, walk(i, dir));
  }
  const out = new Float64Array(NP);
  for (let k = 0; k < NP; k++) out[k] = cnt[k] ? sum[k] / cnt[k] : NaN;
  return out;
}

let BL_LONG = null, BL_SHORT = null;
function baselines() {
  if (!BL_LONG) {
    BL_LONG = blindGrid(1, 40000, 31337);
    BL_SHORT = blindGrid(-1, 40000, 73331);
  }
  return { BL_LONG, BL_SHORT };
}

/** Time-of-day matched baseline: random entries drawn only at the hours the
 *  events actually fire, so the clock cannot masquerade as an edge. */
function blindGridAtHours(dir, hours, n, seed) {
  const pool = [];
  const ok = new Set(hours);
  for (let i = 100; i < N - MAX_HOLD - 2; i++) if (ok.has(new Date(bars[i].t).getUTCHours())) pool.push(i);
  const r = rng(seed);
  const sum = new Float64Array(NP), cnt = new Int32Array(NP);
  for (let k = 0; k < n; k++) accumulate(sum, cnt, walk(pool[Math.floor(r() * pool.length)], dir));
  const out = new Float64Array(NP);
  for (let k = 0; k < NP; k++) out[k] = cnt[k] ? sum[k] / cnt[k] : NaN;
  return out;
}

/**
 * Direction-adjusted score of a set of events over the whole (target, stop)
 * grid.  Longs are scored against the blind-long cell, shorts against the
 * blind-short cell, then combined weighted by count — an unadjusted number in
 * a sample that fell all year is worthless.
 */
function scoreGrid(events, blLong, blShort) {
  const { BL_LONG: dl, BL_SHORT: ds } = baselines();
  const bL = blLong || dl, bS = blShort || ds;
  const lsum = new Float64Array(NP), lcnt = new Int32Array(NP);
  const ssum = new Float64Array(NP), scnt = new Int32Array(NP);
  for (const ev of events) {
    const closeOut = walk(ev.i, ev.dir);
    if (ev.dir === 1) accumulate(lsum, lcnt, closeOut);
    else accumulate(ssum, scnt, closeOut);
  }
  const alpha = new Float64Array(NP), raw = new Float64Array(NP), tot = new Int32Array(NP);
  const alphaL = new Float64Array(NP), alphaS = new Float64Array(NP);
  for (let k = 0; k < NP; k++) {
    const ln = lcnt[k], sn = scnt[k], t = ln + sn;
    tot[k] = t;
    alphaL[k] = ln ? lsum[k] / ln - bL[k] : NaN;
    alphaS[k] = sn ? ssum[k] / sn - bS[k] : NaN;
    if (!t) { alpha[k] = NaN; raw[k] = NaN; continue; }
    const la = ln ? alphaL[k] : 0;
    const sa = sn ? alphaS[k] : 0;
    alpha[k] = (la * ln + sa * sn) / t;
    raw[k] = (lsum[k] + ssum[k]) / t;
  }
  return { alpha, raw, tot, alphaL, alphaS, lcnt, scnt, longs: lcnt[IDX90], shorts: scnt[IDX90] };
}
const cell = (g, tp, sl) => g[TPS.indexOf(tp) * NS + SLS.indexOf(sl)];

// ── the level itself ────────────────────────────────────────────────────────
/**
 * High and low of a session window, each as its own fixed value.
 *
 * The range is accumulated across the window, published on the first bar that
 * falls outside it, delayed a further `delayBars`, and retired `holdMin`
 * minutes after the session ended.  Windows may wrap midnight.  A session with
 * fewer than `minBars` observations is discarded rather than published, which
 * is what keeps a half-empty Friday night from inventing a level.
 *
 * Returns parallel series: hi, lo, mid, and per-bar width in points.
 */
function sessionRange(bars, opts = {}) {
  const startMin = Math.round((opts.startHour ?? 0) * 60);
  const endMin = Math.round((opts.endHour ?? 7) * 60);
  const wrap = endMin <= startMin;
  const holdMin = opts.holdMin ?? 16 * 60;
  const delayBars = opts.delayBars ?? 1;
  const minBars = opts.minBars ?? 0;
  const n = bars.length;
  const hi = new Array(n).fill(NaN);
  const lo = new Array(n).fill(NaN);
  const mid = new Array(n).fill(NaN);
  const width = new Array(n).fill(NaN);
  const sessions = [];
  let acc = null, ready = null;

  for (let i = 0; i < n; i++) {
    const d = new Date(bars[i].t);
    const m = d.getUTCHours() * 60 + d.getUTCMinutes();
    const day = Math.floor(bars[i].t / 86400000);
    const inS = wrap ? (m >= startMin || m < endMin) : (m >= startMin && m < endMin);
    const key = wrap && m >= startMin ? day + 1 : day;

    if (inS) {
      if (!acc || acc.key !== key) acc = { key, hi: -Infinity, lo: Infinity, cnt: 0 };
      if (bars[i].h > acc.hi) acc.hi = bars[i].h;
      if (bars[i].l < acc.lo) acc.lo = bars[i].l;
      acc.cnt++;
    } else if (acc && acc.key === key) {
      if (acc.cnt >= minBars && acc.hi > acc.lo) {
        ready = { hi: acc.hi, lo: acc.lo, tEnd: bars[i].t, from: i + delayBars, key: acc.key };
        sessions.push({ key: acc.key, hi: acc.hi, lo: acc.lo, w: (acc.hi - acc.lo) / PU, i, cnt: acc.cnt });
      } else ready = null;
      acc = null;
    }

    if (ready && bars[i].t - ready.tEnd > holdMin * 60000) ready = null;
    if (ready && i >= ready.from) {
      hi[i] = ready.hi; lo[i] = ready.lo;
      mid[i] = (ready.hi + ready.lo) / 2;
      width[i] = (ready.hi - ready.lo) / PU;
    }
  }
  return { hi, lo, mid, width, sessions };
}

/** The shipped construction, re-implemented so it can be measured verbatim. */
function shippedSessionRange(bars, opts = {}) {
  const startH = opts.startHour ?? 0, endH = opts.endHour ?? 7;
  const out = new Array(bars.length).fill(NaN);
  const dayOf = t => Math.floor(t / 86400000);
  let curDay = dayOf(bars[0].t);
  let hi = -Infinity, lo = Infinity, ready = null;
  for (let i = 0; i < bars.length; i++) {
    const d = new Date(bars[i].t);
    const day = dayOf(bars[i].t);
    const hour = d.getUTCHours();
    if (day !== curDay) { curDay = day; hi = -Infinity; lo = Infinity; ready = null; }
    if (hour >= startH && hour < endH) { hi = Math.max(hi, bars[i].h); lo = Math.min(lo, bars[i].l); }
    else if (hour >= endH && ready === null && hi > -Infinity) ready = { hi, lo };
    if (ready) out[i] = Math.abs(bars[i].c - ready.hi) < Math.abs(bars[i].c - ready.lo) ? ready.hi : ready.lo;
  }
  return { line: out };
}

/** Mask a level series to sessions whose width sits inside a causal band. */
function widthFilter(line, width, lowPct, highPct, lookback = 20) {
  const out = line.slice();
  const seen = [];           // widths of sessions already published — causal
  let curW = NaN;            // width of the session currently live
  for (let i = 0; i < line.length; i++) {
    const w = width[i];
    if (!Number.isFinite(w)) continue;   // gap between sessions: do NOT forget history
    if (w !== curW) {
      if (Number.isFinite(curW)) seen.push(curW);
      curW = w;
    }
    if (seen.length < 10) { out[i] = NaN; continue; }
    const hist = seen.slice(-lookback).slice().sort((a, b) => a - b);
    const q = p => hist[Math.min(hist.length - 1, Math.floor(p * hist.length))];
    if (w < q(lowPct) || w > q(highPct)) out[i] = NaN;
  }
  return out;
}

// ── event readings ──────────────────────────────────────────────────────────
const READINGS = {
  all: ev => ev,
  bounce: ev => ev.filter(e => e.kind === 'reject'),
  break: ev => ev.filter(e => e.kind === 'break'),
  breakFade: ev => ev.filter(e => e.kind === 'break').map(e => ({ ...e, dir: -e.dir })),
  bounceFade: ev => ev.filter(e => e.kind === 'reject').map(e => ({ ...e, dir: -e.dir })),
};

// ── excursion ───────────────────────────────────────────────────────────────
function median(a) {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pct(a, p) {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

/** Median favourable and adverse travel after an event, in points. */
function excursion(events, horizons = [60, 120, 240, 480, 1440]) {
  const res = {};
  for (const H of horizons) {
    const mfe = [], mae = [];
    for (const ev of events) {
      const e = bars[ev.i].c, end = Math.min(N - 1, ev.i + H);
      let f = 0, a = 0;
      for (let j = ev.i + 1; j <= end; j++) {
        const b = bars[j];
        const ff = ev.dir === 1 ? (b.h - e) / PU : (e - b.l) / PU;
        const aa = ev.dir === 1 ? (e - b.l) / PU : (b.h - e) / PU;
        if (ff > f) f = ff;
        if (aa > a) a = aa;
      }
      mfe.push(f); mae.push(a);
    }
    res[H] = {
      n: events.length,
      mfeMed: median(mfe), mfeQ1: pct(mfe, 0.25), mfeQ3: pct(mfe, 0.75),
      maeMed: median(mae), maeQ1: pct(mae, 0.25), maeQ3: pct(mae, 0.75),
    };
  }
  return res;
}

// ── session windows to sweep ────────────────────────────────────────────────
const SESSIONS = [
  ['asia 01-07  (shipped window)', { startHour: 1, endHour: 7, holdMin: 17 * 60, minBars: 200 }],
  ['asia 01-08', { startHour: 1, endHour: 8, holdMin: 16 * 60, minBars: 240 }],
  ['asia 01-06', { startHour: 1, endHour: 6, holdMin: 18 * 60, minBars: 170 }],
  ['asia 23-08 (wrap)', { startHour: 23, endHour: 8, holdMin: 16 * 60, minBars: 300 }],
  ['london 08-13', { startHour: 8, endHour: 13, holdMin: 11 * 60, minBars: 170 }],
  ['london 07-12', { startHour: 7, endHour: 12, holdMin: 12 * 60, minBars: 170 }],
  ['ny 13-21', { startHour: 13, endHour: 21, holdMin: 12 * 60, minBars: 240 }],
  ['ny 14-20', { startHour: 14, endHour: 20, holdMin: 13 * 60, minBars: 200 }],
  ['prev full day 01-23', { startHour: 1, endHour: 23, holdMin: 24 * 60, minBars: 900 }],
];

// ── printing helpers ────────────────────────────────────────────────────────
const f = (x, d = 2) => Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '   —';
const g = (x, d = 1) => Number.isFinite(x) ? x.toFixed(d) : '—';
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
function hr(c = '─', n = 92) { console.log(c.repeat(n)); }
function head(t) { console.log('\n' + t); hr(); }

// ═══════════════════════════════════════════════════════════════════════════
//  STAGES
// ═══════════════════════════════════════════════════════════════════════════

function stageRecon() {
  head('DATA');
  const hh = new Array(24).fill(0);
  for (const b of bars) hh[new Date(b.t).getUTCHours()]++;
  console.log(`bars ${N.toLocaleString()}   ${new Date(bars[0].t).toISOString().slice(0, 16)} → ${new Date(bars[N - 1].t).toISOString().slice(0, 16)}`);
  console.log('hours with no data: ' + hh.map((v, i) => v === 0 ? i : null).filter(x => x !== null).join(',') + '   (so "startHour 0" is really 01:00)');
  const days = new Set(bars.map(b => Math.floor(b.t / 86400000)));
  console.log(`trading days ${days.size}   median 1m ATR ${g(median(atr1.filter(Number.isFinite)) / PU)} points`);

  head('SESSION RANGE WIDTHS (points)');
  console.log(pad('window', 26) + rpad('sessions', 9) + rpad('median', 9) + rpad('q1', 8) + rpad('q3', 8) + rpad('min', 8) + rpad('max', 8));
  for (const [name, o] of SESSIONS) {
    const s = sessionRange(bars, o).sessions;
    const w = s.map(x => x.w);
    console.log(pad(name, 26) + rpad(s.length, 9) + rpad(g(median(w)), 9) + rpad(g(pct(w, 0.25)), 8) + rpad(g(pct(w, 0.75)), 8) + rpad(g(Math.min(...w)), 8) + rpad(g(Math.max(...w)), 8));
  }
}

function stageBaseline() {
  head('CALIBRATION — reproducing the numbers everything is scored against');
  const { BL_LONG: bl, BL_SHORT: bs } = baselines();
  console.log(`blind long  @ 90/90 : ${f(bl[IDX90])} points/trade   (brief says about -4.8)`);
  console.log(`blind short @ 90/90 : ${f(bs[IDX90])} points/trade   (brief says about +4.3)`);
  console.log('\nblind baselines at other boxes — this is why 90/90 numbers cannot be reused:');
  console.log(pad('target/stop', 14) + rpad('blind long', 13) + rpad('blind short', 13));
  for (const [tp, sl] of [[15, 15], [20, 20], [25, 20], [30, 30], [40, 25], [50, 50], [90, 90]]) {
    console.log(pad(`${tp}/${sl}`, 14) + rpad(f(cell(bl, tp, sl)), 13) + rpad(f(cell(bs, tp, sl)), 13));
  }
}

function stageCurrent() {
  head('STAGE 2 — THE SHIPPED CONSTRUCTION, MEASURED');
  const mine = shippedSessionRange(bars, { startHour: 0, endHour: 7 }).line;
  const theirs = LV.sessionRangeLevels(bars, { startHour: 0, endHour: 7 }).line;
  let diff = 0;
  for (let i = 0; i < N; i++) {
    const a = mine[i], b = theirs[i];
    if (Number.isFinite(a) !== Number.isFinite(b) || (Number.isFinite(a) && Math.abs(a - b) > 1e-9)) diff++;
  }
  console.log(`re-implementation matches tools/levels.js on ${N - diff}/${N} bars (differences: ${diff})`);

  const ev = levelTestEvents(bars, mine, atr1);
  const r = respectRate(ev);
  const s = scoreGrid(ev);
  console.log(`\nnearest-edge line, 90/90 box, MAX_HOLD ${MAX_HOLD}`);
  console.log(`  tests ${r.tests}   rejects ${r.rejects}   breaks ${r.breaks}   respect ${g(r.respect)}%  (random ${RANDOM_RESPECT}%, edge ${f(r.respect - RANDOM_RESPECT, 1)})`);
  console.log(`  longs ${s.longs}  shorts ${s.shorts}   raw ${f(cell(s.raw, 90, 90))} pts/trade   DIRECTION-ADJUSTED ALPHA ${f(cell(s.alpha, 90, 90))} pts/trade`);

  console.log('\nhow much of that is the nearest-edge flip? the same window, each edge fixed:');
  const sr = sessionRange(bars, { startHour: 1, endHour: 7, holdMin: 17 * 60, minBars: 200 });
  for (const [nm, line] of [['high edge', sr.hi], ['low edge', sr.lo]]) {
    const e2 = levelTestEvents(bars, line, atr1);
    const r2 = respectRate(e2), s2 = scoreGrid(e2);
    console.log(`  ${pad(nm, 11)} tests ${rpad(r2.tests, 4)}  respect ${rpad(g(r2.respect), 5)}%  alpha@90/90 ${f(cell(s2.alpha, 90, 90))}`);
  }
}

function stageTf() {
  head('STAGE 1 — LITERAL CANDLE-TIMEFRAME SWEEP (shipped construction)');
  console.log('a session high is max(high) over a window, so resampling cannot change the');
  console.log('value — only add projection lag. shown because the brief asks for it.\n');
  console.log(pad('timeframe', 12) + rpad('tests', 8) + rpad('respect%', 11) + rpad('alpha@90/90', 14));
  for (const m of [1, 5, 15, 60, 240, 1440]) {
    const { bars: b, index } = E.resample(bars, m);
    const raw = shippedSessionRange(b, { startHour: 0, endHour: 7 }).line;
    const line = m === 1 ? raw : E.projectConfirmed(raw, index);
    const ev = levelTestEvents(bars, line, atr1);
    const r = respectRate(ev);
    const s = ev.length ? scoreGrid(ev) : null;
    console.log(pad(TF_NAME[m], 12) + rpad(r.tests, 8) + rpad(g(r.respect), 11) + rpad(s ? f(cell(s.alpha, 90, 90)) : '—', 14));
  }
}

function edgeLines(o) {
  const sr = sessionRange(bars, o);
  return { high: sr.hi, low: sr.lo, width: sr.width, sessions: sr.sessions };
}

function stageSplit() {
  head('STAGE 3a — EACH EDGE AS ITS OWN FIXED LEVEL, ACROSS SESSION WINDOWS  (90/90 box)');
  console.log(pad('window', 24) + pad('edge', 6) + rpad('tests', 7) + rpad('resp%', 8) + rpad('rej', 6) + rpad('brk', 6)
    + rpad('bounce', 9) + rpad('break', 9) + rpad('brkFade', 9) + rpad('all', 9));
  hr();
  const rows = [];
  for (const [name, o] of SESSIONS) {
    const L = edgeLines(o);
    for (const edge of ['high', 'low']) {
      const ev = levelTestEvents(bars, L[edge], atr1);
      const r = respectRate(ev);
      const out = { name, edge, tests: r.tests, respect: r.respect, rej: r.rejects, brk: r.breaks, a: {} };
      for (const k of ['bounce', 'break', 'breakFade', 'all']) {
        const sub = READINGS[k](ev);
        out.a[k] = sub.length >= 30 ? cell(scoreGrid(sub).alpha, 90, 90) : NaN;
        out[k + 'N'] = sub.length;
      }
      rows.push(out);
      console.log(pad(name, 24) + pad(edge, 6) + rpad(r.tests, 7) + rpad(g(r.respect), 8) + rpad(r.rejects, 6) + rpad(r.breaks, 6)
        + rpad(f(out.a.bounce), 9) + rpad(f(out.a.break), 9) + rpad(f(out.a.breakFade), 9) + rpad(f(out.a.all), 9));
    }
  }
  return rows;
}

function stageExcursion(cfgs) {
  head('STAGE 3b — WHAT TRAVEL DOES A TEST ACTUALLY PRODUCE?  (points)');
  console.log('median favourable / adverse travel after the event, by horizon.');
  console.log('the 90 point box was never sized to this.\n');
  for (const { name, o, edge, reading } of cfgs) {
    const L = edgeLines(o);
    const ev = READINGS[reading](levelTestEvents(bars, L[edge], atr1));
    if (ev.length < 30) continue;
    const x = excursion(ev);
    console.log(`${name} — ${edge} — ${reading}   n=${ev.length}`);
    console.log('  ' + pad('horizon', 10) + rpad('MFE med', 10) + rpad('(q1/q3)', 14) + rpad('MAE med', 10) + rpad('(q1/q3)', 14) + rpad('MFE/MAE', 9));
    for (const H of [60, 120, 240, 480, 1440]) {
      const e = x[H];
      console.log('  ' + pad(H + 'm', 10) + rpad(g(e.mfeMed), 10) + rpad(`${g(e.mfeQ1)}/${g(e.mfeQ3)}`, 14)
        + rpad(g(e.maeMed), 10) + rpad(`${g(e.maeQ1)}/${g(e.maeQ3)}`, 14) + rpad(g(e.mfeMed / e.maeMed, 2), 9));
    }
    console.log('');
  }
}

function printGrid(alpha, tot, tps, sls, minN) {
  console.log('  ' + pad('tp\\sl', 8) + sls.map(s => rpad(s, 9)).join(''));
  for (const tp of tps) {
    let row = '  ' + pad(tp, 8);
    for (const sl of sls) {
      const k = TPS.indexOf(tp) * NS + SLS.indexOf(sl);
      row += rpad(tot[k] >= minN ? f(alpha[k], 1) : '·', 9);
    }
    console.log(row);
  }
}

function stageGrid(cfgs) {
  head('STAGE 3c — TARGET x STOP GRID, DIRECTION-ADJUSTED ALPHA (points/trade)');
  const TPS_S = [10, 15, 20, 25, 30, 40, 50, 75, 90];
  const SLS_S = [10, 15, 20, 25, 30, 40, 50, 75, 90];
  for (const { name, o, edge, reading } of cfgs) {
    const L = edgeLines(o);
    const ev = READINGS[reading](levelTestEvents(bars, L[edge], atr1));
    if (ev.length < 100) { console.log(`\n${name} — ${edge} — ${reading}: only ${ev.length} events, skipped`); continue; }
    const s = scoreGrid(ev);
    console.log(`\n${name} — ${edge} — ${reading}   n=${ev.length}  (longs ${s.longs} / shorts ${s.shorts})`);
    printGrid(s.alpha, s.tot, TPS_S, SLS_S, 100);
  }
}

function stageWidth(cfg, tp, sl) {
  head('STAGE 3d — DOES RANGE WIDTH MATTER?  (causal terciles of the last 20 sessions)');
  const { name, o, edge, reading } = cfg;
  const L = edgeLines(o);
  console.log(`${name} — ${edge} — ${reading} @ ${tp}/${sl}\n`);
  console.log('  ' + pad('band', 22) + rpad('tests', 8) + rpad('resp%', 9) + rpad('n traded', 10) + rpad('alpha', 9));
  const bands = [['all widths', 0, 1], ['narrow (bottom 33%)', 0, 0.34], ['middle', 0.33, 0.67], ['wide (top 33%)', 0.66, 1]];
  for (const [bn, a, b] of bands) {
    const line = (a === 0 && b === 1) ? L[edge] : widthFilter(L[edge], L.width, a, b);
    const all = levelTestEvents(bars, line, atr1);
    const ev = READINGS[reading](all);
    const r = respectRate(all);
    const s = ev.length >= 20 ? scoreGrid(ev) : null;
    console.log('  ' + pad(bn, 22) + rpad(r.tests, 8) + rpad(g(r.respect), 9) + rpad(ev.length, 10)
      + rpad(s ? f(cell(s.alpha, tp, sl)) : '—', 9));
  }
}

function stageCausal() {
  head('CAUSALITY CHECK — is the level visible before the information exists?');
  const o = { startHour: 1, endHour: 7, holdMin: 17 * 60, minBars: 200 };
  const full = sessionRange(bars, o);
  // Rebuild from truncated data at 40 random bars; the value at that bar must
  // be identical when the future does not exist.
  const r = rng(4242);
  let checked = 0, bad = 0;
  for (let k = 0; k < 40; k++) {
    const i = 5000 + Math.floor(r() * (N - 6000));
    if (!Number.isFinite(full.hi[i])) continue;
    const trunc = sessionRange(bars.slice(0, i + 1), o);
    checked++;
    if (Math.abs(trunc.hi[i] - full.hi[i]) > 1e-9 || Math.abs(trunc.lo[i] - full.lo[i]) > 1e-9) bad++;
  }
  console.log(`rebuilt from truncated history at ${checked} random live bars — mismatches: ${bad}`);

  // The level must never equal an extreme that only later bars produced.
  let insideSession = 0;
  for (let i = 1; i < N; i++) {
    if (!Number.isFinite(full.hi[i])) continue;
    const h = new Date(bars[i].t).getUTCHours();
    if (h >= 1 && h < 7) insideSession++;
  }
  console.log(`bars where a level is live while its own session is still running: ${insideSession} (must be 0)`);
  console.log(`publication delay: 1 bar after the first out-of-session bar`);
}

function halves() {
  const mid = bars[Math.floor(N / 2)].t;
  return mid;
}

// ═══════════════════════════════════════════════════════════════════════════
//  THE PLACEBO THAT DECIDES THIS
//
//  A high-edge test is nearly always a short and a low-edge test nearly always
//  a long, so in a sample that fell all year the two edges cannot be compared
//  to each other — the direction adjustment removes the average drift but not
//  whatever drift is left inside the hours these events fire in.
//
//  So build the identical object at every height inside the range:
//
//      level(q) = low + q * (high - low)
//
//  q = 0 is the session low, q = 1 the session high, q = 0.5 the midpoint, and
//  q < 0 / q > 1 are outside it.  Every one of these is a fixed daily value
//  published at the same instant with the same hold, and every one is tested
//  by the same event detector.  If the extremes carry information, alpha has
//  to PEAK at q = 0 and q = 1.  If the curve is flat, or if the interior lines
//  score as well as the edges, then what is being measured is the clock and
//  the trend, not the level.
// ═══════════════════════════════════════════════════════════════════════════
function qLevel(sr, q) {
  const out = new Array(sr.hi.length).fill(NaN);
  for (let i = 0; i < out.length; i++) {
    const h = sr.hi[i], l = sr.lo[i];
    if (Number.isFinite(h) && Number.isFinite(l)) out[i] = l + q * (h - l);
  }
  return out;
}

function stagePlacebo(o, name, tp, sl) {
  head(`PLACEBO — LEVEL HEIGHT INSIDE THE RANGE (${name}, box ${tp}/${sl})`);
  console.log('q=0 is the session low, q=1 the session high. the edges have to beat the');
  console.log('interior, otherwise "session range level" is just a clock.\n');
  const sr = sessionRange(bars, o);
  console.log('  ' + pad('q', 7) + rpad('tests', 7) + rpad('resp%', 8) + rpad('bounce n', 10)
    + rpad('alpha', 9) + rpad('longs', 7) + rpad('a(long)', 10) + rpad('shorts', 8) + rpad('a(short)', 10));
  for (const q of [-0.25, 0, 0.15, 0.3, 0.5, 0.7, 0.85, 1, 1.25]) {
    const line = qLevel(sr, q);
    const all = levelTestEvents(bars, line, atr1);
    const ev = READINGS.bounce(all);
    const r = respectRate(all);
    if (ev.length < 30) { console.log('  ' + pad(q, 7) + rpad(r.tests, 7) + '  too few'); continue; }
    const s = scoreGrid(ev);
    const k = TPS.indexOf(tp) * NS + SLS.indexOf(sl);
    const tag = q === 0 ? '  <- LOW' : q === 1 ? '  <- HIGH' : '';
    console.log('  ' + pad(q, 7) + rpad(r.tests, 7) + rpad(g(r.respect), 8) + rpad(ev.length, 10)
      + rpad(f(s.alpha[k], 1), 9) + rpad(s.lcnt[k], 7) + rpad(f(s.alphaL[k], 1), 10)
      + rpad(s.scnt[k], 8) + rpad(f(s.alphaS[k], 1), 10) + tag);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SWEEP AND RECLAIM
//
//  The single-bar reject/break classification is not how anyone actually
//  trades a session range.  The trade people mean is two-legged: price pushes
//  through the edge, takes the stops resting beyond it, then closes back
//  inside — the break failed, and the failure is the signal.  The opposite
//  reading is break-and-hold: through the edge and still beyond it N bars
//  later.  Both are built here, both are causal, both fire at most once per
//  edge per session.
// ═══════════════════════════════════════════════════════════════════════════
/**
 * @param mode 'reclaim' fade the failed break, 'hold' follow the sustained one
 * @param pokeAtr how far beyond the edge counts as a genuine poke
 * @param backAtr how far back inside counts as a reclaim
 * @param windowBars how long the sweep has to resolve
 */
function sweepEvents(sr, opts = {}) {
  const mode = opts.mode ?? 'reclaim';
  const pokeAtr = opts.pokeAtr ?? 0.3;
  const backAtr = opts.backAtr ?? 0.1;
  const windowBars = opts.windowBars ?? 60;
  const events = [];
  const state = { high: null, low: null };   // {level, pokeBar} per edge
  let curHi = NaN, curLo = NaN;

  for (let i = 1; i < N; i++) {
    const h = sr.hi[i], l = sr.lo[i], a = atr1[i];
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(a) || a <= 0) continue;
    if (h !== curHi || l !== curLo) { curHi = h; curLo = l; state.high = null; state.low = null; state.doneH = false; state.doneL = false; }
    const b = bars[i];

    // ── upper edge ──
    if (!state.doneH) {
      if (!state.high) {
        if (b.h > h + a * pokeAtr) state.high = { at: i, ext: b.h };
      } else {
        if (b.h > state.high.ext) state.high.ext = b.h;
        const age = i - state.high.at;
        if (mode === 'reclaim' && b.c < h - a * backAtr) { events.push({ i, dir: -1, kind: 'sweep', level: h }); state.doneH = true; }
        else if (mode === 'hold' && age >= windowBars && b.c > h + a * backAtr) { events.push({ i, dir: 1, kind: 'hold', level: h }); state.doneH = true; }
        else if (age > windowBars) state.doneH = true;
      }
    }
    // ── lower edge ──
    if (!state.doneL) {
      if (!state.low) {
        if (b.l < l - a * pokeAtr) state.low = { at: i, ext: b.l };
      } else {
        if (b.l < state.low.ext) state.low.ext = b.l;
        const age = i - state.low.at;
        if (mode === 'reclaim' && b.c > l + a * backAtr) { events.push({ i, dir: 1, kind: 'sweep', level: l }); state.doneL = true; }
        else if (mode === 'hold' && age >= windowBars && b.c < l - a * backAtr) { events.push({ i, dir: -1, kind: 'hold', level: l }); state.doneL = true; }
        else if (age > windowBars) state.doneL = true;
      }
    }
  }
  return events;
}

function stageSweep(tp, sl) {
  head(`SWEEP-AND-RECLAIM vs BREAK-AND-HOLD (box ${tp}/${sl})`);
  const k = TPS.indexOf(tp) * NS + SLS.indexOf(sl);
  console.log(pad('window', 22) + pad('mode', 10) + rpad('win', 6) + rpad('n', 6)
    + rpad('alpha', 9) + rpad('longs', 7) + rpad('a(long)', 10) + rpad('shorts', 8) + rpad('a(short)', 10));
  hr();
  for (const [name, o] of SESSIONS.slice(0, 5)) {
    const sr = sessionRange(bars, o);
    for (const mode of ['reclaim', 'hold']) {
      for (const w of [30, 60, 120]) {
        const ev = sweepEvents(sr, { mode, windowBars: w });
        if (ev.length < 40) continue;
        const s = scoreGrid(ev);
        console.log(pad(name, 22) + pad(mode, 10) + rpad(w, 6) + rpad(ev.length, 6)
          + rpad(f(s.alpha[k], 1), 9) + rpad(s.lcnt[k], 7) + rpad(f(s.alphaL[k], 1), 10)
          + rpad(s.scnt[k], 8) + rpad(f(s.alphaS[k], 1), 10));
      }
    }
  }
}

// ── controls for the sweep construction ─────────────────────────────────────
/** Slide the whole range up or down by a fraction of its own width. Same width,
 *  same times, same trade logic — only the anchoring to the real extremes goes. */
function shiftRange(sr, s) {
  const hi = sr.hi.slice(), lo = sr.lo.slice();
  for (let i = 0; i < hi.length; i++) {
    if (!Number.isFinite(sr.hi[i])) continue;
    const w = sr.hi[i] - sr.lo[i];
    hi[i] = sr.hi[i] + s * w; lo[i] = sr.lo[i] + s * w;
  }
  return { hi, lo, sessions: sr.sessions };
}

/** Trade today's window against a range from `k` sessions ago. Still causal,
 *  still the same object with the same width distribution, but disconnected
 *  from where price actually is — the strongest placebo available. */
function lagRange(sr, k) {
  const n = sr.hi.length;
  const hi = sr.hi.slice(), lo = sr.lo.slice();
  const ord = new Array(n).fill(-1);
  let cur = -1, ptr = 0;
  for (let i = 0; i < n; i++) {
    while (ptr < sr.sessions.length && sr.sessions[ptr].i <= i) { cur = ptr; ptr++; }
    ord[i] = cur;
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(sr.hi[i])) continue;
    const j = ord[i] - k;
    if (j < 0) { hi[i] = NaN; lo[i] = NaN; continue; }
    hi[i] = sr.sessions[j].hi; lo[i] = sr.sessions[j].lo;
  }
  return { hi, lo, sessions: sr.sessions };
}

const MORE_SESSIONS = [
  ...SESSIONS,
  ['london 08-12', { startHour: 8, endHour: 12, holdMin: 12 * 60, minBars: 140 }],
  ['london 08-14', { startHour: 8, endHour: 14, holdMin: 10 * 60, minBars: 200 }],
  ['london 09-13', { startHour: 9, endHour: 13, holdMin: 11 * 60, minBars: 140 }],
  ['london 08-16', { startHour: 8, endHour: 16, holdMin: 8 * 60, minBars: 260 }],
  ['euro 07-13', { startHour: 7, endHour: 13, holdMin: 11 * 60, minBars: 200 }],
];

function line1(s, k, ev) {
  return rpad(ev.length, 6) + rpad(f(s.alpha[k], 1), 9) + rpad(s.lcnt[k], 7)
    + rpad(f(s.alphaL[k], 1), 10) + rpad(s.scnt[k], 8) + rpad(f(s.alphaS[k], 1), 10);
}

function stageSweepAll(tp, sl) {
  head(`SWEEP-AND-RECLAIM ACROSS EVERY WINDOW (box ${tp}/${sl}, resolve window 60 bars)`);
  const k = TPS.indexOf(tp) * NS + SLS.indexOf(sl);
  console.log(pad('window', 22) + rpad('n', 6) + rpad('alpha', 9) + rpad('longs', 7) + rpad('a(long)', 10) + rpad('shorts', 8) + rpad('a(short)', 10));
  hr();
  for (const [name, o] of MORE_SESSIONS) {
    const sr = sessionRange(bars, o);
    const ev = sweepEvents(sr, { mode: 'reclaim', windowBars: 60 });
    if (ev.length < 40) continue;
    console.log(pad(name, 22) + line1(scoreGrid(ev), k, ev));
  }
}

function stageSweepParams(o, name, tp, sl) {
  head(`SWEEP-AND-RECLAIM PARAMETER NEIGHBOURHOOD — ${name} (box ${tp}/${sl})`);
  const k = TPS.indexOf(tp) * NS + SLS.indexOf(sl);
  const sr = sessionRange(bars, o);
  console.log(pad('poke/back/win', 20) + rpad('n', 6) + rpad('alpha', 9) + rpad('longs', 7) + rpad('a(long)', 10) + rpad('shorts', 8) + rpad('a(short)', 10));
  hr();
  for (const poke of [0.1, 0.2, 0.3, 0.5, 0.8]) {
    for (const back of [0, 0.1, 0.25]) {
      for (const w of [30, 60, 120, 240]) {
        const ev = sweepEvents(sr, { mode: 'reclaim', pokeAtr: poke, backAtr: back, windowBars: w });
        if (ev.length < 40) continue;
        console.log(pad(`${poke}/${back}/${w}`, 20) + line1(scoreGrid(ev), k, ev));
      }
    }
  }
}

function stageSweepPlacebo(o, name, tp, sl) {
  head(`SWEEP-AND-RECLAIM PLACEBOS — ${name} (box ${tp}/${sl})`);
  console.log('the same trade against ranges that are not the real one. if these score');
  console.log('like the real range, the construction is trading the clock and the width,');
  console.log('not the session high and low.\n');
  const k = TPS.indexOf(tp) * NS + SLS.indexOf(sl);
  const sr = sessionRange(bars, o);
  console.log(pad('range used', 30) + rpad('n', 6) + rpad('alpha', 9) + rpad('longs', 7) + rpad('a(long)', 10) + rpad('shorts', 8) + rpad('a(short)', 10));
  hr();
  const cases = [['real range', sr]];
  for (const s of [-0.3, -0.15, 0.15, 0.3]) cases.push([`shifted by ${s > 0 ? '+' : ''}${s} of width`, shiftRange(sr, s)]);
  for (const kk of [1, 2, 3, 5, 10]) cases.push([`range from ${kk} session(s) ago`, lagRange(sr, kk)]);
  for (const [nm, r] of cases) {
    const ev = sweepEvents(r, { mode: 'reclaim', windowBars: 60 });
    if (ev.length < 30) { console.log(pad(nm, 30) + rpad(ev.length, 6) + '  too few'); continue; }
    console.log(pad(nm, 30) + line1(scoreGrid(ev), k, ev));
  }
}

function stageSweepFinal(o, name, sweepOpts, tp, sl) {
  head(`FINAL — ${name} sweep-and-reclaim, box ${tp}/${sl}`);
  const k = TPS.indexOf(tp) * NS + SLS.indexOf(sl);
  const sr = sessionRange(bars, o);
  const ev = sweepEvents(sr, sweepOpts);
  const s = scoreGrid(ev);
  console.log(`events ${ev.length}   settled ${s.tot[k]}   longs ${s.lcnt[k]} / shorts ${s.scnt[k]}`);
  console.log(`raw ${f(s.raw[k])} pts/trade   DIRECTION-ADJUSTED ALPHA ${f(s.alpha[k])}   (long ${f(s.alphaL[k])} / short ${f(s.alphaS[k])})`);
  console.log(`same events in the 90/90 box: ${f(cell(s.alpha, 90, 90))}`);

  head('excursion of these events');
  const x = excursion(ev);
  console.log('  ' + pad('horizon', 10) + rpad('MFE med', 10) + rpad('MAE med', 10) + rpad('ratio', 9));
  for (const H of [60, 120, 240, 480, 1440]) console.log('  ' + pad(H + 'm', 10) + rpad(g(x[H].mfeMed), 10) + rpad(g(x[H].maeMed), 10) + rpad(g(x[H].mfeMed / x[H].maeMed, 2), 9));

  head('target x stop grid (direction-adjusted alpha)');
  printGrid(s.alpha, s.tot, [30, 50, 75, 90, 120, 150, 200, 250], [30, 50, 75, 90, 120, 150, 200, 250], 80);

  head('clock-matched control');
  const hours = [...new Set(ev.map(e => new Date(bars[e.i].t).getUTCHours()))].sort((a, b) => a - b);
  const hl = blindGridAtHours(1, hours, 20000, 909091), hs = blindGridAtHours(-1, hours, 20000, 191919);
  const s2 = scoreGrid(ev, hl, hs);
  console.log(`random entries restricted to hours ${hours.join(',')}: alpha ${f(s2.alpha[k])} (long ${f(s2.alphaL[k])} / short ${f(s2.alphaS[k])})`);

  head('split sample and months (no re-tuning)');
  const mt = halves();
  for (const [nm, sub] of [['first half', ev.filter(e => bars[e.i].t < mt)], ['second half', ev.filter(e => bars[e.i].t >= mt)]]) {
    const ss = scoreGrid(sub);
    console.log(`  ${pad(nm, 14)} n=${rpad(sub.length, 4)}  raw ${f(ss.raw[k])}  alpha ${f(ss.alpha[k])}`);
  }
  const bym = new Map();
  for (const e of ev) { const m = new Date(bars[e.i].t).toISOString().slice(0, 7); if (!bym.has(m)) bym.set(m, []); bym.get(m).push(e); }
  for (const m of [...bym.keys()].sort()) { const sub = bym.get(m), ss = scoreGrid(sub); console.log(`  ${m}      n=${rpad(sub.length, 4)}  raw ${f(ss.raw[k])}  alpha ${f(ss.alpha[k])}`); }

  head('is the mean distinguishable from zero?');
  const outs = [];
  for (const e of ev) {
    const co = walk(e.i, e.dir);
    const ta = _tpBar[TPS.indexOf(tp)], sb = _slBar[SLS.indexOf(sl)];
    let p;
    if (ta < 0 && sb < 0) p = co - COST;
    else if (ta >= 0 && (sb < 0 || ta < sb)) p = tp - COST;
    else if (sb >= 0 && (ta < 0 || sb < ta)) p = -sl - COST;
    else continue;
    const { BL_LONG: bl, BL_SHORT: bs2 } = baselines();
    outs.push(p - (e.dir === 1 ? bl[k] : bs2[k]));
  }
  const mean = outs.reduce((a, b) => a + b, 0) / outs.length;
  const sd = Math.sqrt(outs.reduce((a, b) => a + (b - mean) ** 2, 0) / (outs.length - 1));
  const se = sd / Math.sqrt(outs.length);
  console.log(`  n ${outs.length}   mean alpha ${f(mean)}   sd ${g(sd)}   standard error ${g(se)}   t ${g(mean / se, 2)}`);
  console.log(`  95% interval  ${f(mean - 1.96 * se)} .. ${f(mean + 1.96 * se)} points/trade`);
  return { alpha: s.alpha[k], raw: s.raw[k], n: ev.length, t: mean / se, se };
}

// ── the breakout, as a directional signal, with a width filter ──────────────
/**
 * First close beyond each edge after the session has published — at most one
 * long and one short per session, so a day that chops across the high all
 * afternoon contributes one trade, not forty.
 *
 * `wLow`/`wHigh` select a causal width band: the session's own width is ranked
 * against the previous 20 published widths, which are all known before the
 * trade. The idea being tested is the one every breakout trader states out
 * loud — a coiled session breaks and runs, a already-wide session does not.
 */
function firstBreakEvents(sr, opts = {}) {
  const buf = opts.bufAtr ?? 0.25;
  const wLow = opts.wLow ?? 0, wHigh = opts.wHigh ?? 1;
  const flip = opts.flip ? -1 : 1;
  const confirm = opts.confirmBars ?? 0;
  const events = [];
  let curHi = NaN, curLo = NaN, doneH = false, doneL = false, band = true;
  const seen = [];
  for (let i = 1; i < N; i++) {
    const h = sr.hi[i], l = sr.lo[i], a = atr1[i];
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(a) || a <= 0) continue;
    if (h !== curHi || l !== curLo) {
      if (Number.isFinite(curHi)) seen.push((curHi - curLo) / PU);
      curHi = h; curLo = l; doneH = false; doneL = false;
      const w = (h - l) / PU;
      if (seen.length < 10) band = false;
      else {
        const hist = seen.slice(-20).slice().sort((x, y) => x - y);
        const q = p => hist[Math.min(hist.length - 1, Math.floor(p * hist.length))];
        band = w >= q(wLow) && w <= q(Math.min(0.999, wHigh));
      }
    }
    if (!band) continue;
    const b = bars[i];
    if (!doneH && b.c > h + a * buf) {
      if (confirm === 0) { events.push({ i, dir: 1 * flip, kind: 'firstbreak', level: h }); doneH = true; }
      else {
        const j = i + confirm;
        if (j < N && bars[j].c > h) { events.push({ i: j, dir: 1 * flip, kind: 'firstbreak', level: h }); doneH = true; }
        else if (j < N) doneH = true;
      }
    }
    if (!doneL && b.c < l - a * buf) {
      if (confirm === 0) { events.push({ i, dir: -1 * flip, kind: 'firstbreak', level: l }); doneL = true; }
      else {
        const j = i + confirm;
        if (j < N && bars[j].c < l) { events.push({ i: j, dir: -1 * flip, kind: 'firstbreak', level: l }); doneL = true; }
        else if (j < N) doneL = true;
      }
    }
  }
  return events;
}

function stageFirstBreak(tp, sl) {
  head(`FIRST BREAK OF THE SESSION RANGE, BY WIDTH BAND (box ${tp}/${sl})`);
  console.log('one long and one short per session at most. "follow" trades the breakout,');
  console.log('"fade" trades against it. width bands are ranked causally against the');
  console.log('previous 20 sessions.\n');
  const k = TPS.indexOf(tp) * NS + SLS.indexOf(sl);
  console.log(pad('window', 22) + pad('band', 12) + pad('dir', 8) + rpad('n', 6) + rpad('alpha', 9) + rpad('longs', 7) + rpad('a(long)', 10) + rpad('shorts', 8) + rpad('a(short)', 10));
  hr();
  const bands = [['all', 0, 1], ['narrow 33%', 0, 0.34], ['wide 33%', 0.66, 1]];
  for (const [name, o] of MORE_SESSIONS) {
    const sr = sessionRange(bars, o);
    for (const [bn, a, b] of bands) {
      for (const flip of [false, true]) {
        const ev = firstBreakEvents(sr, { wLow: a, wHigh: b, flip });
        if (ev.length < 60) continue;
        console.log(pad(name, 22) + pad(bn, 12) + pad(flip ? 'fade' : 'follow', 8) + line1(scoreGrid(ev), k, ev));
      }
    }
  }
}

/** Per-trade alpha with its standard error, so "better" can be told from "noisier". */
function tstat(events, tp, sl) {
  const k = TPS.indexOf(tp) * NS + SLS.indexOf(sl);
  const { BL_LONG: bl, BL_SHORT: bs } = baselines();
  const outs = [];
  for (const e of events) {
    const co = walk(e.i, e.dir);
    const ta = _tpBar[TPS.indexOf(tp)], sb = _slBar[SLS.indexOf(sl)];
    let p;
    if (ta < 0 && sb < 0) p = co - COST;
    else if (ta >= 0 && (sb < 0 || ta < sb)) p = tp - COST;
    else if (sb >= 0 && (ta < 0 || sb < ta)) p = -sl - COST;
    else continue;
    outs.push(p - (e.dir === 1 ? bl[k] : bs[k]));
  }
  const n = outs.length;
  if (n < 2) return { n, mean: NaN, se: NaN, t: NaN };
  const mean = outs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(outs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  return { n, mean, sd, se, t: mean / se };
}

/**
 * The whole question in one table.
 *
 * Both edges of a window are traded as one strategy — the high and the low are
 * different levels but the same idea, and pooling them is the only way to get
 * a sample large enough to say anything. Beside every real range sits the
 * distribution of eight placebo ranges: the same width, the same publication
 * time, the same hold, the same trade logic, slid up or down by a fraction of
 * the range's own width so that the lines are no longer the session's actual
 * extremes. The real range has to stand outside that distribution.
 */
function stageCombined(tp, sl) {
  head(`BOTH EDGES POOLED, AGAINST A PLACEBO DISTRIBUTION (box ${tp}/${sl})`);
  console.log('z is how many placebo standard deviations the real range sits above the');
  console.log('placebo mean. t is the real range against zero. neither is worth anything');
  console.log('below about 2.\n');
  console.log(pad('window', 22) + pad('reading', 9) + rpad('n', 6) + rpad('alpha', 9) + rpad('t', 7)
    + rpad('placebo mu', 12) + rpad('placebo sd', 12) + rpad('z', 7));
  hr();
  const SHIFTS = [-0.4, -0.3, -0.2, -0.1, 0.1, 0.2, 0.3, 0.4];
  for (const [name, o] of MORE_SESSIONS) {
    const sr = sessionRange(bars, o);
    for (const reading of ['bounce', 'break']) {
      const real = [
        ...READINGS[reading](levelTestEvents(bars, sr.hi, atr1)),
        ...READINGS[reading](levelTestEvents(bars, sr.lo, atr1)),
      ];
      if (real.length < 100) continue;
      const st = tstat(real, tp, sl);
      const pl = [];
      for (const s of SHIFTS) {
        const r = shiftRange(sr, s);
        const ev = [
          ...READINGS[reading](levelTestEvents(bars, r.hi, atr1)),
          ...READINGS[reading](levelTestEvents(bars, r.lo, atr1)),
        ];
        if (ev.length >= 100) pl.push(tstat(ev, tp, sl).mean);
      }
      const mu = pl.reduce((a, b) => a + b, 0) / pl.length;
      const sd = Math.sqrt(pl.reduce((a, b) => a + (b - mu) ** 2, 0) / (pl.length - 1));
      console.log(pad(name, 22) + pad(reading, 9) + rpad(st.n, 6) + rpad(f(st.mean, 1), 9) + rpad(g(st.t, 2), 7)
        + rpad(f(mu, 1), 12) + rpad(g(sd, 1), 12) + rpad(g((st.mean - mu) / sd, 2), 7));
    }
  }
}

function stageBox(o, name) {
  head(`BOX SIZE, BOTH EDGES POOLED, BOUNCE — ${name}`);
  console.log('the excursion said the honest box is around target 200 / stop 170, not');
  console.log('90/90. this is whether that actually buys anything.\n');
  const sr = sessionRange(bars, o);
  const ev = [
    ...READINGS.bounce(levelTestEvents(bars, sr.hi, atr1)),
    ...READINGS.bounce(levelTestEvents(bars, sr.lo, atr1)),
  ];
  console.log(`n = ${ev.length}`);
  console.log('  ' + pad('target/stop', 14) + rpad('alpha', 9) + rpad('t', 8) + rpad('se', 8));
  for (const [t, s] of [[30, 30], [50, 50], [90, 90], [120, 90], [120, 120], [150, 120], [150, 150], [200, 150], [200, 200], [250, 200]]) {
    const st = tstat(ev, t, s);
    console.log('  ' + pad(`${t}/${s}`, 14) + rpad(f(st.mean, 1), 9) + rpad(g(st.t, 2), 8) + rpad(g(st.se, 1), 8));
  }
}

/** Everything that can be asked of one construction, in one place. */
function stageVerdict(o, name, tp, sl) {
  head(`VERDICT — ${name}, both edges as separate fixed levels, bounce, box ${tp}/${sl}`);
  const sr = sessionRange(bars, o);
  const evH = READINGS.bounce(levelTestEvents(bars, sr.hi, atr1));
  const evL = READINGS.bounce(levelTestEvents(bars, sr.lo, atr1));
  const ev = [...evH, ...evL].sort((a, b) => a.i - b.i);
  const k = TPS.indexOf(tp) * NS + SLS.indexOf(sl);
  const s = scoreGrid(ev), st = tstat(ev, tp, sl);
  const rH = respectRate(levelTestEvents(bars, sr.hi, atr1));
  const rL = respectRate(levelTestEvents(bars, sr.lo, atr1));
  console.log(`high edge: ${rH.tests} tests, respect ${g(rH.respect)}%   low edge: ${rL.tests} tests, respect ${g(rL.respect)}%   (random ${RANDOM_RESPECT}%)`);
  console.log(`traded ${ev.length}  (${evH.length} at the high, ${evL.length} at the low)   longs ${s.lcnt[k]} / shorts ${s.scnt[k]}`);
  console.log(`raw ${f(s.raw[k])} pts/trade   DIRECTION-ADJUSTED ALPHA ${f(s.alpha[k])}   long ${f(s.alphaL[k])} / short ${f(s.alphaS[k])}`);
  console.log(`t ${g(st.t, 2)}   standard error ${g(st.se, 1)}   95% interval ${f(st.mean - 1.96 * st.se, 1)} .. ${f(st.mean + 1.96 * st.se, 1)}`);
  console.log(`same events in the 90/90 box: ${f(cell(s.alpha, 90, 90))}`);

  console.log('\nplacebo ranges (same width, same hours, slid off the real extremes):');
  const pl = [];
  for (const sh of [-0.4, -0.3, -0.2, -0.1, 0.1, 0.2, 0.3, 0.4]) {
    const r = shiftRange(sr, sh);
    const e2 = [...READINGS.bounce(levelTestEvents(bars, r.hi, atr1)), ...READINGS.bounce(levelTestEvents(bars, r.lo, atr1))];
    const a = tstat(e2, tp, sl).mean;
    pl.push(a);
    console.log(`  shift ${sh > 0 ? '+' : ''}${sh}   n ${rpad(e2.length, 5)}  alpha ${f(a, 1)}`);
  }
  const mu = pl.reduce((a, b) => a + b, 0) / pl.length;
  const sd = Math.sqrt(pl.reduce((a, b) => a + (b - mu) ** 2, 0) / (pl.length - 1));
  console.log(`  placebo mean ${f(mu, 1)}  sd ${g(sd, 1)}   real range is z = ${g((st.mean - mu) / sd, 2)}`);

  console.log('\nclock-matched control:');
  const hours = [...new Set(ev.map(e => new Date(bars[e.i].t).getUTCHours()))].sort((a, b) => a - b);
  const hl = blindGridAtHours(1, hours, 20000, 909091), hs = blindGridAtHours(-1, hours, 20000, 191919);
  const s2 = scoreGrid(ev, hl, hs);
  console.log(`  random entries at hours ${hours.join(',')}: alpha ${f(s2.alpha[k])} (long ${f(s2.alphaL[k])} / short ${f(s2.alphaS[k])})`);

  console.log('\nwidth bands (causal rank against the previous 20 sessions):');
  for (const [bn, a, b] of [['narrow 33%', 0, 0.34], ['middle 33%', 0.33, 0.67], ['wide 33%', 0.66, 1]]) {
    const hiF = widthFilter(sr.hi, sr.width, a, b), loF = widthFilter(sr.lo, sr.width, a, b);
    const e2 = [...READINGS.bounce(levelTestEvents(bars, hiF, atr1)), ...READINGS.bounce(levelTestEvents(bars, loF, atr1))];
    if (e2.length < 60) { console.log(`  ${pad(bn, 12)} n=${e2.length} too few`); continue; }
    const t2 = tstat(e2, tp, sl);
    console.log(`  ${pad(bn, 12)} n=${rpad(e2.length, 5)} alpha ${f(t2.mean, 1)}  t ${g(t2.t, 2)}`);
  }

  console.log('\nsplit sample and months, no re-tuning:');
  const mt = halves();
  for (const [nm, sub] of [['first half', ev.filter(e => bars[e.i].t < mt)], ['second half', ev.filter(e => bars[e.i].t >= mt)]]) {
    const t2 = tstat(sub, tp, sl);
    console.log(`  ${pad(nm, 13)} n=${rpad(t2.n, 5)} alpha ${f(t2.mean, 1)}  t ${g(t2.t, 2)}`);
  }
  const bym = new Map();
  for (const e of ev) { const m = new Date(bars[e.i].t).toISOString().slice(0, 7); if (!bym.has(m)) bym.set(m, []); bym.get(m).push(e); }
  for (const m of [...bym.keys()].sort()) { const t2 = tstat(bym.get(m), tp, sl); console.log(`  ${m}       n=${rpad(t2.n, 5)} alpha ${f(t2.mean, 1)}`); }
  return { alpha: st.mean, t: st.t, n: ev.length, z: (st.mean - mu) / sd };
}

/** Both edges, bounce, restricted to a causal width band. The chosen build. */
function chosenEvents(o, band) {
  const sr = sessionRange(bars, o);
  const hiF = band ? widthFilter(sr.hi, sr.width, band[0], band[1]) : sr.hi;
  const loF = band ? widthFilter(sr.lo, sr.width, band[0], band[1]) : sr.lo;
  return [
    ...READINGS.bounce(levelTestEvents(bars, hiF, atr1)),
    ...READINGS.bounce(levelTestEvents(bars, loF, atr1)),
  ].sort((a, b) => a.i - b.i);
}

function stageChosen(o, name, band, tp, sl) {
  head(`CHOSEN BUILD — ${name}, both edges fixed, bounce, narrow sessions only`);
  const ev = chosenEvents(o, band);
  const st = tstat(ev, tp, sl);
  const s = scoreGrid(ev);
  const k = TPS.indexOf(tp) * NS + SLS.indexOf(sl);
  console.log(`n ${ev.length}   longs ${s.lcnt[k]} / shorts ${s.scnt[k]}`);
  console.log(`raw ${f(s.raw[k])}   ALPHA ${f(st.mean)} pts/trade   t ${g(st.t, 2)}   se ${g(st.se, 1)}   95% ${f(st.mean - 1.96 * st.se, 1)} .. ${f(st.mean + 1.96 * st.se, 1)}`);
  console.log(`long ${f(s.alphaL[k])} / short ${f(s.alphaS[k])}      in the 90/90 box: ${f(cell(s.alpha, 90, 90))}`);

  head('box grid for these events — is 150/120 a peak or a plateau?');
  console.log('  ' + pad('target/stop', 14) + rpad('alpha', 9) + rpad('t', 8));
  for (const [t, q] of [[50, 50], [90, 90], [120, 90], [120, 120], [150, 120], [150, 150], [200, 150], [200, 200], [250, 200]]) {
    const x = tstat(ev, t, q);
    console.log('  ' + pad(`${t}/${q}`, 14) + rpad(f(x.mean, 1), 9) + rpad(g(x.t, 2), 8));
  }

  head('does the same width filter flatter the placebo ranges too?');
  const sr = sessionRange(bars, o);
  const pl = [];
  for (const sh of [-0.4, -0.3, -0.2, -0.1, 0.1, 0.2, 0.3, 0.4]) {
    const r = shiftRange(sr, sh);
    r.width = sr.width;
    const hiF = widthFilter(r.hi, sr.width, band[0], band[1]);
    const loF = widthFilter(r.lo, sr.width, band[0], band[1]);
    const e2 = [...READINGS.bounce(levelTestEvents(bars, hiF, atr1)), ...READINGS.bounce(levelTestEvents(bars, loF, atr1))];
    const x = tstat(e2, tp, sl);
    pl.push(x.mean);
    console.log(`  shift ${sh > 0 ? '+' : ''}${sh}  n ${rpad(x.n, 5)}  alpha ${f(x.mean, 1)}   t ${g(x.t, 2)}`);
  }
  const mu = pl.reduce((a, b) => a + b, 0) / pl.length;
  const sd = Math.sqrt(pl.reduce((a, b) => a + (b - mu) ** 2, 0) / (pl.length - 1));
  console.log(`  placebo mean ${f(mu, 1)}  sd ${g(sd, 1)}   real range z = ${g((st.mean - mu) / sd, 2)}`);

  head('split sample and months, no re-tuning');
  const mt = halves();
  for (const [nm, sub] of [['first half', ev.filter(e => bars[e.i].t < mt)], ['second half', ev.filter(e => bars[e.i].t >= mt)]]) {
    const x = tstat(sub, tp, sl);
    console.log(`  ${pad(nm, 13)} n=${rpad(x.n, 5)} alpha ${f(x.mean, 1)}  t ${g(x.t, 2)}`);
  }
  const bym = new Map();
  for (const e of ev) { const m = new Date(bars[e.i].t).toISOString().slice(0, 7); if (!bym.has(m)) bym.set(m, []); bym.get(m).push(e); }
  for (const m of [...bym.keys()].sort()) { const x = tstat(bym.get(m), tp, sl); console.log(`  ${m}       n=${rpad(x.n, 5)} alpha ${f(x.mean, 1)}`); }

  head('the same filter and box on every other window — is asia special?');
  console.log('  ' + pad('window', 22) + rpad('n', 6) + rpad('alpha', 9) + rpad('t', 8));
  for (const [nm, oo] of MORE_SESSIONS) {
    const e2 = chosenEvents(oo, band);
    if (e2.length < 100) continue;
    const x = tstat(e2, tp, sl);
    console.log('  ' + pad(nm, 22) + rpad(x.n, 6) + rpad(f(x.mean, 1), 9) + rpad(g(x.t, 2), 8));
  }
  return st;
}

/** The before / after, with each fix isolated so credit lands where it belongs. */
function stageReport() {
  head('SUMMARY — WHAT EACH FIX WAS WORTH');
  const shipped = levelTestEvents(bars, shippedSessionRange(bars, { startHour: 0, endHour: 7 }).line, atr1);
  const sr = sessionRange(bars, SESSIONS[0][1]);
  const pooled = [
    ...READINGS.bounce(levelTestEvents(bars, sr.hi, atr1)),
    ...READINGS.bounce(levelTestEvents(bars, sr.lo, atr1)),
  ];
  const pooledAll = [
    ...levelTestEvents(bars, sr.hi, atr1),
    ...levelTestEvents(bars, sr.lo, atr1),
  ];
  const rows = [
    ['shipped: nearest edge, 90/90', shipped, 90, 90],
    ['shipped line, box 150/120', shipped, 150, 120],
    ['edges split, all events, 90/90', pooledAll, 90, 90],
    ['edges split, bounce only, 90/90', pooled, 90, 90],
    ['edges split, bounce only, 150/120', pooled, 150, 120],
    ['+ narrow sessions only, 150/120', chosenEvents(SESSIONS[0][1], [0, 0.34]), 150, 120],
  ];
  console.log(pad('construction', 36) + rpad('n', 7) + rpad('raw', 9) + rpad('alpha', 9) + rpad('t', 7));
  hr();
  for (const [nm, ev, t, q] of rows) {
    const x = tstat(ev, t, q);
    const s = scoreGrid(ev);
    const k = TPS.indexOf(t) * NS + SLS.indexOf(q);
    console.log(pad(nm, 36) + rpad(x.n, 7) + rpad(f(s.raw[k], 1), 9) + rpad(f(x.mean, 1), 9) + rpad(g(x.t, 2), 7));
  }
  console.log('\nrespect, against the 68.95% random control:');
  for (const [nm, line] of [['asia high edge', sr.hi], ['asia low edge', sr.lo], ['shipped nearest-edge line', shippedSessionRange(bars, { startHour: 0, endHour: 7 }).line]]) {
    const r = respectRate(levelTestEvents(bars, line, atr1));
    console.log(`  ${pad(nm, 28)} ${rpad(r.tests, 5)} tests   ${g(r.respect)}%   ${f(r.respect - RANDOM_RESPECT, 1)} vs random`);
  }
  console.log('\nnone of the t-statistics reach 2. the definition fix is correct and the');
  console.log('numbers move, but the placebo tests say the movement is not coming from');
  console.log('the session extremes themselves.');
}

function stageSides(tp, sl) {
  head(`LONG AND SHORT ALPHA SEPARATELY (box ${tp}/${sl})`);
  console.log('a level that carries information has to work on both sides. if every');
  console.log('positive number is a short and every negative one a long, the number is');
  console.log('the downtrend leaking past the adjustment, not the level.\n');
  const k = TPS.indexOf(tp) * NS + SLS.indexOf(sl);
  console.log(pad('window', 22) + pad('edge', 6) + pad('reading', 11) + rpad('n', 6)
    + rpad('alpha', 9) + rpad('longs', 7) + rpad('a(long)', 10) + rpad('shorts', 8) + rpad('a(short)', 10));
  hr();
  for (const [name, o] of SESSIONS) {
    const L = edgeLines(o);
    for (const edge of ['high', 'low']) {
      const all = levelTestEvents(bars, L[edge], atr1);
      for (const reading of ['bounce', 'break']) {
        const ev = READINGS[reading](all);
        if (ev.length < 40) continue;
        const s = scoreGrid(ev);
        console.log(pad(name, 22) + pad(edge, 6) + pad(reading, 11) + rpad(ev.length, 6)
          + rpad(f(s.alpha[k], 1), 9) + rpad(s.lcnt[k], 7) + rpad(f(s.alphaL[k], 1), 10)
          + rpad(s.scnt[k], 8) + rpad(f(s.alphaS[k], 1), 10));
      }
    }
  }
}

function stageFinal(cfg, tp, sl) {
  const { name, o, edge, reading } = cfg;
  head(`STAGE 4 — CHOSEN CONSTRUCTION:  ${name} / ${edge} edge / ${reading} / target ${tp} stop ${sl}`);
  const L = edgeLines(o);
  const all = levelTestEvents(bars, L[edge], atr1);
  const ev = READINGS[reading](all);
  const r = respectRate(all);
  const s = scoreGrid(ev);
  const k = TPS.indexOf(tp) * NS + SLS.indexOf(sl);
  console.log(`tests ${r.tests}   respect ${g(r.respect)}%  (random ${RANDOM_RESPECT})`);
  console.log(`traded events ${ev.length}   settled ${s.tot[k]}   longs ${ev.filter(e => e.dir === 1).length} / shorts ${ev.filter(e => e.dir === -1).length}`);
  console.log(`raw ${f(s.raw[k])} pts/trade    DIRECTION-ADJUSTED ALPHA ${f(s.alpha[k])} pts/trade`);
  console.log(`same events in the 90/90 box: alpha ${f(cell(s.alpha, 90, 90))} — the box, not the level, was the problem`);

  // time-of-day matched control
  const hours = [...new Set(ev.map(e => new Date(bars[e.i].t).getUTCHours()))].sort((a, b) => a - b);
  const hl = blindGridAtHours(1, hours, 20000, 909091);
  const hs = blindGridAtHours(-1, hours, 20000, 191919);
  const s2 = scoreGrid(ev, hl, hs);
  console.log(`\nagainst a clock-matched blind baseline (random entries at hours ${hours.join(',')}): alpha ${f(s2.alpha[k])}`);

  // out of sample halves
  const mt = halves();
  const h1 = ev.filter(e => bars[e.i].t < mt), h2 = ev.filter(e => bars[e.i].t >= mt);
  console.log(`\nsplit-sample (no re-tuning, same target and stop):`);
  for (const [nm, sub] of [['first half  Jan–Apr', h1], ['second half Apr–Jul', h2]]) {
    if (sub.length < 20) { console.log(`  ${pad(nm, 20)} n=${sub.length} too few`); continue; }
    const ss = scoreGrid(sub);
    console.log(`  ${pad(nm, 20)} n=${rpad(sub.length, 4)}  raw ${f(ss.raw[k])}  alpha ${f(ss.alpha[k])}`);
  }

  // monthly
  console.log(`\nby month:`);
  const bym = new Map();
  for (const e of ev) {
    const m = new Date(bars[e.i].t).toISOString().slice(0, 7);
    if (!bym.has(m)) bym.set(m, []);
    bym.get(m).push(e);
  }
  for (const m of [...bym.keys()].sort()) {
    const sub = bym.get(m), ss = scoreGrid(sub);
    console.log(`  ${m}  n=${rpad(sub.length, 4)}  raw ${f(ss.raw[k])}  alpha ${f(ss.alpha[k])}`);
  }

  // neighbourhood robustness
  console.log(`\nneighbourhood of the chosen box (is it a peak or a plateau?):`);
  const near = t => TPS.filter(x => Math.abs(x - t) <= t * 0.45);
  console.log('  ' + pad('tp\\sl', 8) + near(sl).map(x => rpad(x, 9)).join(''));
  for (const t of near(tp)) {
    let row = '  ' + pad(t, 8);
    for (const q of near(sl)) row += rpad(f(cell(s.alpha, t, q), 1), 9);
    console.log(row);
  }
  return { events: ev, alpha: s.alpha[k], raw: s.raw[k], n: s.tot[k], respect: r.respect, tests: r.tests };
}

// ═══════════════════════════════════════════════════════════════════════════
const stage = require.main === module ? (process.argv[2] || 'all') : 'none';
const CAND = [
  { name: 'asia 01-07', o: SESSIONS[0][1], edge: 'high', reading: 'bounce' },
  { name: 'asia 01-07', o: SESSIONS[0][1], edge: 'low', reading: 'bounce' },
  { name: 'asia 01-07', o: SESSIONS[0][1], edge: 'high', reading: 'break' },
  { name: 'asia 01-07', o: SESSIONS[0][1], edge: 'low', reading: 'break' },
];

if (stage === 'recon' || stage === 'all') stageRecon();
if (stage === 'baseline' || stage === 'all') stageBaseline();
if (stage === 'causal' || stage === 'all') stageCausal();
if (stage === 'current' || stage === 'all') stageCurrent();
if (stage === 'tf' || stage === 'all') stageTf();
if (stage === 'split' || stage === 'all') stageSplit();
if (stage === 'excursion') stageExcursion(CAND);
if (stage === 'grid') stageGrid(CAND);
if (stage === 'placebo') { stagePlacebo(SESSIONS[0][1], 'asia 01-07', 90, 90); stagePlacebo(SESSIONS[0][1], 'asia 01-07', 150, 120); }
if (stage === 'sweep') { stageSweep(90, 90); stageSweep(150, 120); }
if (stage === 'sides') { stageSides(90, 90); stageSides(150, 120); }
if (stage === 'width') stageWidth(CAND[0], 90, 90);
const LDN = { startHour: 8, endHour: 13, holdMin: 11 * 60, minBars: 170 };
if (stage === 'sweepall') { stageSweepAll(90, 90); stageSweepAll(150, 120); }
if (stage === 'sweepparams') { stageSweepParams(LDN, 'london 08-13', 90, 90); stageSweepParams(LDN, 'london 08-13', 150, 120); }
if (stage === 'sweepplacebo') { stageSweepPlacebo(LDN, 'london 08-13', 90, 90); stageSweepPlacebo(LDN, 'london 08-13', 150, 120); }
if (stage === 'sweepfinal') stageSweepFinal(LDN, 'london 08-13', { mode: 'reclaim', windowBars: 60 }, 150, 120);
if (stage === 'firstbreak') { stageFirstBreak(90, 90); stageFirstBreak(150, 120); }
if (stage === 'combined') { stageCombined(90, 90); stageCombined(200, 150); }
if (stage === 'box') { stageBox(SESSIONS[0][1], 'asia 01-07'); stageBox(LDN, 'london 08-13'); }
if (stage === 'verdict') {
  stageVerdict(SESSIONS[0][1], 'asia 01-07', 150, 120);
  stageVerdict(LDN, 'london 08-13', 120, 120);
}
if (stage === 'chosen') stageChosen(SESSIONS[0][1], 'asia 01-07', [0, 0.34], 150, 120);
if (stage === 'report') stageReport();

module.exports = {
  bars, atr1, N, PU, COST, MAX_HOLD, TPS, SLS, NS, NT, cell,
  sessionRange, shippedSessionRange, widthFilter, edgeLines,
  READINGS, scoreGrid, baselines, excursion, levelTestEvents, respectRate,
  SESSIONS, stageExcursion, stageGrid, stageWidth, stageFinal, median, pct,
  blindGridAtHours, printGrid, head, f, g, pad, rpad,
};
