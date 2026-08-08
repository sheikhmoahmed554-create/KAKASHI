'use strict';
/*
 * Fibonacci retracements — rebuilt.
 *
 * WHAT IS WRONG WITH THE CURRENT CONSTRUCTION
 *
 *   LV.fibLevels(bars, { left: 60, right: 60 })
 *
 * Two independent faults, and the second is the fatal one.
 *
 *   1. Timeframe. A pivot with sixty 1m bars either side is an hour-long
 *      wiggle. The leg it defines is not a swing anybody is measuring a
 *      retracement of.
 *
 *   2. Definition. The generator computes all four ratios and then publishes
 *      `whichever is nearest to the close`. That is not a level. It is a step
 *      function that jumps between four prices as price walks across them, so
 *      it is always close to price, it never gets genuinely approached, and
 *      the 0.618 result is contaminated by the 0.382 result and vice versa.
 *      This is the same flaw that made the KNN lines worthless.
 *
 *      It also silently mixes leg directions: `lastHigh` and `lastLow` are the
 *      two most recent confirmed pivots of each kind, which need not be
 *      consecutive and need not form a leg at all.
 *
 * The rebuild: alternating confirmed pivots on a higher timeframe form a leg;
 * each ratio of that leg is published as its own fixed price series; each ratio
 * is measured on its own; and the target and stop come from the excursion the
 * level actually produces rather than from the inherited 90/90.
 *
 * Everything below is written so the numbers are directly comparable to
 * tools/sweep_timeframes.js — same loader, same race(), same direction
 * adjustment, same levelTestEvents detector — except where a change is stated
 * explicitly and measured on both sides.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE MEASUREMENTS SAID
 *
 * BEFORE. LV.fibLevels on 1m, left/right 60, nearest ratio to the close, 90/90:
 *     2,713 tests   respect 70.1% (random 68.95%)   raw -1.48   ALPHA -1.10
 * The same generator run on other timeframes is no better: 5m -2.31, 15m +0.91,
 * 1H -2.11, 4H +1.53. Nothing there.
 *
 * TIMEFRAME. Rebuilt, one fixed level per ratio, alpha for the "level held"
 * reading at 60/100 with a 60 minute cap:
 *     1m -2.5   5m -0.3   15m +2.9   1H +10.2   4H +10.7   D —
 * 1m and 5m are dead. 1H and 4H agree with each other, which is worth more than
 * either of them alone.
 *
 * RATIO. This is where the interesting answer is. At 1H, alpha by ratio:
 *     0.236 +1.7   0.382 -3.8   0.5 +14.0   0.618 +5.9   0.786 -4.2
 * The shallow ratios lose and the golden zone pays, exactly the way the brief
 * guessed. But a fine scan in steps of 0.02 shows the edge is a contiguous BAND
 * rather than two magic numbers: every ratio from 0.50 to 0.72 is positive
 * (twelve cells in a row), 0.30 to 0.42 is uniformly negative, and 0.74 to 0.82
 * is negative. 0.56 (+9.6) and 0.70 (+7.5) pay as well as 0.618 (+4.8).
 * So the honest claim is about the DEPTH of the retracement — half to roughly
 * two thirds of the leg — and not about the number 0.618. Fibonacci's 0.5 and
 * 0.618 happen to bracket the middle of the band, which is why drawing them
 * works. Twelve adjacent cells all positive is also why the headline pair is
 * not a cherry-picked cell: it is the centre of a plateau.
 *
 * DIRECTION. Measured both ways rather than assumed. The textbook reading wins:
 * price comes back into the golden zone and HOLDS. Trading the break of it is
 * negative at 1H (0.5 +0.5, 0.618 -15.5), and the fade of the hold is the
 * mirror image of the hold (-13.8 where the hold is +14.0), which is what a
 * real directional signal looks like rather than a coin. Both leg directions
 * pay on their own: buying an up leg's held dip earns +8.76 over 420 trades,
 * selling a down leg's held rally +12.41 over 330.
 *
 * SIZE. Median favourable travel in the hour after a test is 94 points and
 * median adverse travel 74, so 90/90 was never absurd here — but a 60 point
 * target with a 100 point stop sits on the right side of both medians and is
 * where the surface peaks. Targets of 30-50 points are worth roughly half as
 * much: the level needs room. Long holds LOOK far better (240 minutes at 80/130
 * reads +19.0) and that is an illusion — see below.
 *
 * OVERLAP, the thing that nearly produced a wrong answer. 750 events each held
 * 240 minutes covers 180,000 of the sample's 192,081 minutes, so the trades are
 * almost continuously on top of each other and 750 is not 750 pieces of
 * evidence. Stripping to a non-overlapping subset:
 *     240m hold, 80/130:  all 750 -> +18.98   serial 210 -> +6.24
 *      60m hold, 60/100:  all 750 -> +10.21   serial 392 -> +9.97
 * The 240 minute number is an artefact of stacking correlated trades. At 60
 * minutes the overlapping and non-overlapping numbers agree, which is the only
 * reason the headline is believable.
 *
 * FINAL: 1H candles, 5/5 pivots, legs of at least 2 ATR, ratios 0.5 and 0.618
 * as two separate fixed levels, traded when the level holds, 60 point target,
 * 100 point stop, 60 minute cap.
 *     750 trades   hit 66.9%   raw +9.21   ALPHA +10.37
 *     non-overlapping subset: 392 trades   ALPHA +10.13   t = 2.79
 *     first half +10.57 (415)   second half +10.11 (335)
 *     six of seven months positive; only January negative (-4.27)
 *
 * Four attempts to break it:
 *   - 96 of 96 generator variants positive, mean +6.52, worst +1.77. The
 *     headline sits near the top of that spread, so +6.5 is the typical
 *     construction and +10.4 is the tuned one.
 *   - 27 of 27 event-detector settings positive, mean +8.68.
 *   - target tuned on the first half picks 80/200 and returns +7.76 on the
 *     untouched second half, LESS than the headline 60/100's +10.11 there.
 *     The size is not overfitted.
 *   - placebo keeping every pivot, leg, birth and death but drawing the leg
 *     HEIGHT at random from the observed pool: 12 runs, mean +3.91, 1 of 12
 *     at or above the real result. Supportive but not crushing — roughly a
 *     third of the alpha survives a wrong height, so part of what is being
 *     measured is "a level a few ATR from a recent 1H pivot", not the ratio.
 *
 * THE UNCOMFORTABLE PART, stated because it matters. Respect rate over all
 * 1,927 tests of these levels is 70.8% against a random-level baseline of
 * 68.95%. That is nothing. Price does not turn at the golden zone more often
 * than at an arbitrary price; when it does turn there, the hour that follows is
 * worth about ten points more than a random entry in the same direction. The
 * edge is in the follow-through, not in the bounce rate, and anyone selling
 * this as "the 0.618 holds 80% of the time" is selling something that is not in
 * this data.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Usage:
 *   node --max-old-space-size=3500 tools/fixes/fibonacci.js base       current construction
 *   node --max-old-space-size=3500 tools/fixes/fibonacci.js causal     lookahead checks
 *   node --max-old-space-size=3500 tools/fixes/fibonacci.js tf         tf x ratio, 90/90
 *   node --max-old-space-size=3500 tools/fixes/fibonacci.js grid [reading tp sl hold]
 *   node --max-old-space-size=3500 tools/fixes/fibonacci.js dir        eight readings
 *   node --max-old-space-size=3500 tools/fixes/fibonacci.js ratioscan  0.20..0.90 by 0.02
 *   node --max-old-space-size=3500 tools/fixes/fibonacci.js excursion  MFE/MAE after a test
 *   node --max-old-space-size=3500 tools/fixes/fibonacci.js targets    tp x sl surface
 *   node --max-old-space-size=3500 tools/fixes/fibonacci.js serial     overlap analysis
 *   node --max-old-space-size=3500 tools/fixes/fibonacci.js knobs      generator variants
 *   node --max-old-space-size=3500 tools/fixes/fibonacci.js detector   detector variants
 *   node --max-old-space-size=3500 tools/fixes/fibonacci.js placebo    wrong-height control
 *   node --max-old-space-size=3500 tools/fixes/fibonacci.js final      the headline
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('../ai963_engine');
const LV = require('../levels');
const { levelTestEvents, respectRate } = require('../level_events');

// ── constants, identical to tools/sweep_timeframes.js ────────────────────────
const PU = 0.10, COST = 0.5, MAX_HOLD = 1440;
const TP0 = 90, SL0 = 90;                 // the 90/90 everything was forced onto
const RANDOM_RESPECT = 68.95;
const TIMEFRAMES = [1, 5, 15, 60, 240, 1440];
const TF_NAME = { 1: '1m', 5: '5m', 15: '15m', 60: '1H', 240: '4H', 1440: 'D' };

// ── loader, copied from tools/sweep_timeframes.js ────────────────────────────
function loadBars() {
  const html = fs.readFileSync(
    path.join(__dirname, '..', '..', 'KAKASHI_V16_TV_PARITY_AUDIT.html'), 'utf8');
  const csv = zlib.gunzipSync(
    Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1], 'base64')).toString('utf8');
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
const atr1 = E.atr(bars, 14);
const N = bars.length;

// ── trade simulation, copied, but with the target/stop made a parameter ──────
function race(i, dir, tp, sl, maxHold) {
  const e = bars[i].c, tpx = e + dir * tp * PU, slx = e - dir * sl * PU;
  const end = Math.min(N - 1, i + maxHold);
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    const ht = dir === 1 ? b.h >= tpx : b.l <= tpx;
    const hs = dir === 1 ? b.l <= slx : b.h >= slx;
    if (ht && hs) return null;          // ambiguous inside one candle
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

/*
 * The blind baseline is a function of the target and the stop. A 25 point
 * target in a falling market has a different blind-short edge than a 90 point
 * one, so re-deriving it per (tp, sl, hold) is the only honest way to compare
 * results across target sizes.
 */
const BLIND = new Map();
function blind(dir, tp, sl, maxHold, n = 40000) {
  const key = `${dir}|${tp}|${sl}|${maxHold}|${n}`;
  if (BLIND.has(key)) return BLIND.get(key);
  const r = rng(dir === 1 ? 31337 : 73331);
  let c = 0, net = 0;
  const lo = 100, hi = N - maxHold - 2;
  for (let k = 0; k < n; k++) {
    const p = race(lo + Math.floor(r() * (hi - lo)), dir, tp, sl, maxHold);
    if (p === null) continue;
    c++; net += p;
  }
  const v = net / c;
  BLIND.set(key, v);
  return v;
}

function score(events, tp = TP0, sl = SL0, maxHold = MAX_HOLD, blindN = 40000) {
  const r = respectRate(events);
  const bl = blind(1, tp, sl, maxHold, blindN);
  const bs = blind(-1, tp, sl, maxHold, blindN);
  let ln = 0, lnet = 0, sn = 0, snet = 0, nulls = 0, wins = 0;
  const adj = [];   // per-trade result with its own blind baseline removed
  for (const e of events) {
    const p = race(e.i, e.dir, tp, sl, maxHold);
    if (p === null) { nulls++; continue; }
    if (p > 0) wins++;
    adj.push(p - (e.dir === 1 ? bl : bs));
    if (e.dir === 1) { ln++; lnet += p; } else { sn++; snet += p; }
  }
  const tot = ln + sn;
  // Spread of the direction-adjusted result, so the headline can be quoted
  // with a t-statistic instead of being taken on faith. Only meaningful on a
  // non-overlapping sample; on the full overlapping list it is optimistic.
  const mu = adj.reduce((a, b) => a + b, 0) / (adj.length || 1);
  const sd = Math.sqrt(adj.reduce((a, b) => a + (b - mu) * (b - mu), 0) / Math.max(1, adj.length - 1));
  const la = ln ? lnet / ln - bl : 0;
  const sa = sn ? snet / sn - bs : 0;
  return {
    ...r, nulls, longs: ln, shorts: sn, traded: tot,
    hit: tot ? (100 * wins) / tot : NaN,
    longAlpha: ln ? lnet / ln - bl : NaN,
    shortAlpha: sn ? snet / sn - bs : NaN,
    shortShare: tot ? (100 * sn) / tot : NaN,
    raw: tot ? (lnet + snet) / tot : NaN,
    alpha: tot ? (la * ln + sa * sn) / tot : NaN,
    sd, t: sd > 0 ? mu / (sd / Math.sqrt(adj.length)) : NaN,
  };
}

// ── resample cache ───────────────────────────────────────────────────────────
const TF = new Map();
function tf(m) {
  if (!TF.has(m)) {
    const { bars: b, index } = E.resample(bars, m);
    TF.set(m, { bars: b, index, atr: E.atr(b, 14) });
  }
  return TF.get(m);
}
/** Build a plain series on `minutes` candles, expose it one HTF bar late. */
function project(minutes, build) {
  const { bars: b, index, atr } = tf(minutes);
  const raw = build(b, atr);
  return minutes === 1 ? raw : E.projectConfirmed(raw, index);
}

/**
 * The fib build, projected. Every published series — one per ratio plus the
 * two bookkeeping series — has to make the same one-candle-late journey, or
 * the level and the leg direction attached to it come from different moments.
 * `legs` is metadata about the HTF build and is passed through untouched.
 */
function projectFib(minutes, opts) {
  const { bars: b, index, atr } = tf(minutes);
  const raw = fibLines(b, atr, opts);
  if (minutes === 1) return raw;
  const lines = {};
  for (const k of Object.keys(raw.lines)) lines[k] = E.projectConfirmed(raw.lines[k], index);
  return {
    lines,
    legDir: E.projectConfirmed(raw.legDir, index),
    legId: E.projectConfirmed(raw.legId, index),
    legs: raw.legs,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  The rebuilt generator.
// ═════════════════════════════════════════════════════════════════════════════
/*
 * A retracement needs a leg, and a leg needs two consecutive swings of
 * OPPOSITE kind. The construction:
 *
 *   1. Confirmed pivots on the higher timeframe (left/right bars either side).
 *      A pivot at bar b is invisible until bar b + right — that is the whole
 *      of the causality claim and it is checked numerically by `causal`.
 *
 *   2. Pivots are walked in confirmation order and reduced to an alternating
 *      zigzag: a new high replaces the previous high if it is higher, a new
 *      low replaces the previous low if it is lower, and a pivot of the
 *      opposite kind closes the leg.
 *
 *   3. A leg is kept only if it spans at least `minLegAtr` ATR. This is what
 *      separates a swing from a wiggle, independently of the timeframe.
 *
 *   4. For each ratio r the level is a single FIXED price:
 *        up leg   (low -> high):  high - span * r     support under the high
 *        down leg (high -> low):  low  + span * r     resistance over the low
 *      One ratio, one series, measured on its own. No "nearest to close".
 *
 *   5. The leg dies when a new leg replaces it, when it is older than
 *      `maxAge` candles, or — optionally — when price closes beyond the leg
 *      origin, which is a retracement of more than 100% and means the leg is
 *      no longer the thing price is retracing.
 *
 * Returns one series per ratio plus two bookkeeping series (leg direction and
 * leg identity) that let the readings be split without touching the detector.
 */
const RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786, 1.0];

function fibLines(hbars, atr, o = {}) {
  const left = o.left ?? 5;
  const right = o.right ?? 5;
  const ratios = o.ratios ?? RATIOS;
  const minLegAtr = o.minLegAtr ?? 2.0;    // leg height in ATR of the HTF candle
  const maxAge = o.maxAge ?? 400;          // HTF candles a leg stays publishable
  const killBeyond = o.killBeyond ?? true; // close past 100% retrace kills it
  const minSpanBars = o.minSpanBars ?? 1;  // candles between the two anchors
  const slopeShuffle = o.slopeShuffle || null;   // placebo hook, see stagePlacebo

  const n = hbars.length;
  const { highs, lows } = LV.pivots(hbars, left, right);
  const byKnown = new Map();
  const push = (p, kind) => {
    if (!byKnown.has(p.knownAt)) byKnown.set(p.knownAt, []);
    byKnown.get(p.knownAt).push({ ...p, kind });
  };
  for (const p of highs) push(p, 'h');
  for (const p of lows) push(p, 'l');

  const lines = {};
  for (const r of ratios) lines[r] = new Array(n).fill(NaN);
  const legDir = new Array(n).fill(0);
  const legId = new Array(n).fill(-1);
  const legs = [];                       // for the excursion / placebo stages

  let last = null;      // most recent zigzag extreme {bar, price, kind}
  let active = null;
  let nextId = 0;

  for (let i = 0; i < n; i++) {
    const born = byKnown.get(i);
    if (born) {
      for (const p of born) {
        if (!last) { last = p; continue; }
        if (p.kind === last.kind) {
          // Same kind: keep the more extreme one, the leg has not turned yet.
          if (p.kind === 'h' ? p.price > last.price : p.price < last.price) last = p;
          continue;
        }
        // Opposite kind: a leg is complete.
        const a = last, b = p;
        last = p;
        const spanBars = b.bar - a.bar;
        if (spanBars < minSpanBars) continue;
        const height = Math.abs(b.price - a.price);
        const aRef = atr[b.bar];
        if (!Number.isFinite(aRef) || aRef <= 0) continue;
        if (height < aRef * minLegAtr) continue;
        const dir = b.kind === 'h' ? 1 : -1;   // up leg ends at a high
        let hgt = height;
        if (slopeShuffle) hgt = slopeShuffle() * aRef;   // placebo: same anchors, wrong height
        const lv = {};
        for (const r of ratios) lv[r] = b.price - dir * hgt * r;
        active = {
          id: nextId++, dir, born: i, anchorA: a.price, anchorB: b.price,
          height: hgt, lv,
        };
        legs.push(active);
      }
    }
    if (!active) continue;
    if (i - active.born > maxAge) { active = null; continue; }
    if (killBeyond) {
      // A close beyond the origin is a >100% retracement: the leg is spent.
      const c = hbars[i].c;
      if (active.dir === 1 ? c < active.anchorA : c > active.anchorA) { active = null; continue; }
    }
    for (const r of ratios) lines[r][i] = active.lv[r];
    legDir[i] = active.dir;
    legId[i] = active.id;
  }
  return { lines, legDir, legId, legs };
}

// ── excursion: what does a test of this level actually pay? ──────────────────
function excursion(events, horizons = [60, 240, 1440]) {
  const out = {};
  for (const H of horizons) {
    const mfe = [], mae = [];
    for (const e of events) {
      const entry = bars[e.i].c;
      const end = Math.min(N - 1, e.i + H);
      let f = 0, adv = 0;
      for (let j = e.i + 1; j <= end; j++) {
        const b = bars[j];
        const up = (b.h - entry) / PU, dn = (entry - b.l) / PU;
        if (e.dir === 1) { f = Math.max(f, up); adv = Math.max(adv, dn); }
        else { f = Math.max(f, dn); adv = Math.max(adv, up); }
      }
      mfe.push(f); mae.push(adv);
    }
    out[H] = { mfe: quant(mfe), mae: quant(mae), n: mfe.length };
  }
  return out;
}
function quant(a) {
  const s = a.slice().sort((x, y) => x - y);
  const q = p => s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
  return { p25: q(0.25), med: q(0.50), p75: q(0.75), p90: q(0.90) };
}

// ── readings ─────────────────────────────────────────────────────────────────
/*
 * The eight ways a fib test can be read, kept apart on purpose.
 *
 * `dir` from the detector says which way the trade would go if the reaction
 * were traded as it stands; `legDir` says whether the level is a retracement
 * support beneath a rally (up leg) or a retracement resistance above a
 * sell-off (down leg). Only the pairs marked textbook are what a chartist
 * means by "the 0.618 held".
 *
 *   upHold    up leg,   price above, came down, held        long   textbook
 *   upLose    up leg,   price above, came down, closed thru short
 *   upReclaim up leg,   price below, came up,   closed thru long
 *   upReject  up leg,   price below, came up,   turned away short
 *   dnHold    down leg, price below, came up,   turned away short  textbook
 *   dnLose    down leg, price below, came up,   closed thru long
 *   dnSupport down leg, price above, came down, held        long
 *   dnBreak   down leg, price above, came down, closed thru short
 */
function tag(events, legDirP) {
  return events.map(e => {
    const L = legDirP[e.i];
    const up = L === 1;
    const kind = e.kind;
    let name;
    if (up) name = kind === 'reject' ? (e.dir === 1 ? 'upHold' : 'upReject')
                                     : (e.dir === -1 ? 'upLose' : 'upReclaim');
    else    name = kind === 'reject' ? (e.dir === -1 ? 'dnHold' : 'dnSupport')
                                     : (e.dir === 1 ? 'dnLose' : 'dnBreak');
    return { ...e, legDir: L, name };
  });
}
const READINGS = ['upHold', 'upLose', 'upReclaim', 'upReject',
                  'dnHold', 'dnLose', 'dnSupport', 'dnBreak'];

const only = (ev, name) => name === 'all' ? ev
  : name === 'hold' ? ev.filter(e => e.name === 'upHold' || e.name === 'dnHold')
  : name === 'holdFade' ? ev.filter(e => e.name === 'upHold' || e.name === 'dnHold').map(e => ({ ...e, dir: -e.dir }))
  : name === 'lose' ? ev.filter(e => e.name === 'upLose' || e.name === 'dnLose')
  : name === 'loseFade' ? ev.filter(e => e.name === 'upLose' || e.name === 'dnLose').map(e => ({ ...e, dir: -e.dir }))
  : ev.filter(e => e.name === name);

const f = (x, d = 2) => Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '—';
const fp = (x, d = 1) => Number.isFinite(x) ? x.toFixed(d) : '—';

// current construction, exactly as tools/measure_levels.js builds it
const CURRENT = (b, a) => LV.fibLevels(b, { left: 60, right: 60 }).line;

// ═════════════════════════════════════════════════════════════════════════════
//  Stages
// ═════════════════════════════════════════════════════════════════════════════
function stageBase() {
  console.log(`${N.toLocaleString()} bars   random respect ${RANDOM_RESPECT}%   ` +
    `blind long ${f(blind(1, TP0, SL0, MAX_HOLD))}  blind short ${f(blind(-1, TP0, SL0, MAX_HOLD))}`);
  console.log('\nCURRENT construction — LV.fibLevels left/right 60, nearest ratio to close, 90/90\n');
  console.log('tf     tests  rejects  respect%   longs  shorts     raw    ALPHA');
  console.log('─'.repeat(66));
  for (const m of TIMEFRAMES) {
    let s;
    try { s = score(levelTestEvents(bars, project(m, CURRENT), atr1)); }
    catch (err) { s = { tests: 0 }; }
    if (!s.tests) { console.log(TF_NAME[m].padEnd(6) + '     0'); continue; }
    console.log(
      TF_NAME[m].padEnd(6) + String(s.tests).padStart(6) + String(s.rejects).padStart(9) +
      fp(s.respect).padStart(10) + String(s.longs).padStart(8) + String(s.shorts).padStart(8) +
      f(s.raw).padStart(8) + f(s.alpha).padStart(9));
  }
  console.log('\nThe headline current number is the 1m row: that is what the level is today.');
}

// The configuration the rest of the file converges on; set after `tf`/`knobs`.
const BEST = {
  m: 60,                       // 1H candles
  ratio: [0.5, 0.618],         // the golden zone, each ratio its own fixed level
  reading: 'hold',             // the level held: buy an up leg's dip, sell a down leg's rally
  opts: { left: 5, right: 5, minLegAtr: 2.0, maxAge: 400, killBeyond: true },
  tp: 60, sl: 100, hold: 60,
};

function stageCausal() {
  /*
   * A lookahead bug is the one failure mode that produces beautiful numbers,
   * so it is tested directly rather than argued about. The lines are rebuilt
   * from a truncated history — only candles up to and including j — and the
   * values published at j are compared with what the full-history build
   * published at the same j. If any future bar leaks in, they disagree.
   */
  const m = BEST.m;
  const { bars: hb, atr: ha, index } = tf(m);
  const full = fibLines(hb, ha, BEST.opts);
  const rr = rng(4242);
  let checked = 0, bad = 0, worst = 0;
  for (let k = 0; k < 40; k++) {
    const j = 300 + Math.floor(rr() * (hb.length - 400));
    const cut = hb.slice(0, j + 1);
    const part = fibLines(cut, E.atr(cut, 14), BEST.opts);
    for (const r of RATIOS) {
      const a = full.lines[r][j], b = part.lines[r][j];
      const bothNaN = !Number.isFinite(a) && !Number.isFinite(b);
      if (!bothNaN) {
        const d = Math.abs((a || 0) - (b || 0));
        worst = Math.max(worst, Number.isFinite(d) ? d : Infinity);
        if (!(d < 1e-9)) bad++;
      }
      checked++;
    }
  }
  console.log(`causality: ${checked} truncated comparisons, ${bad} disagreements, ` +
    `max |diff| ${worst.toExponential(2)}`);

  // The 1m projection must never show a value from an HTF candle still open.
  const proj = E.projectConfirmed(full.lines[0.618], index);
  let leak = 0, sampled = 0;
  for (let i = 1; i < N; i += 997) {
    sampled++;
    const j = index[i] - 1;
    if (j < 0) continue;
    if (Number.isFinite(proj[i]) && proj[i] !== full.lines[0.618][j]) leak++;
    if (hb[j].t + m * 60000 > bars[i].t) leak++;   // that candle must have closed
  }
  console.log(`projection: ${leak} leaks across ${sampled} sampled 1m bars`);

  // And the pivot lag itself: a pivot must not be visible before right bars.
  const { highs } = LV.pivots(hb, BEST.opts.left, BEST.opts.right);
  const badLag = highs.filter(p => p.knownAt - p.bar !== BEST.opts.right).length;
  console.log(`pivot lag: ${badLag} of ${highs.length} highs published early`);
}

// ── one run: build, project, detect, tag, filter, score ──────────────────────
/*
 * `ratio` may be a single number or a list. A list runs each ratio as its own
 * independent level series and pools the events — the ratios are still tested
 * one at a time, they are simply traded together, which is what a chartist
 * drawing a fib grid actually does. Events are deduplicated by 1m bar so two
 * ratios firing on the same candle count once.
 */
function run(m, opts, ratio, reading = 'all',
             tp = TP0, sl = SL0, hold = MAX_HOLD, blindN = 40000, detOpts = undefined) {
  const p = projectFib(m, opts);
  const rs = Array.isArray(ratio) ? ratio : [ratio];
  let ev = [];
  for (const r of rs) {
    ev = ev.concat(tag(levelTestEvents(bars, p.lines[r], atr1, detOpts), p.legDir)
      .map(e => ({ ...e, ratio: r })));
  }
  ev.sort((a, b) => a.i - b.i);
  if (rs.length > 1) {
    const seen = new Set();
    ev = ev.filter(e => (seen.has(e.i) ? false : (seen.add(e.i), true)));
  }
  const list = only(ev, reading);
  return { s: score(list, tp, sl, hold, blindN), list, all: ev };
}

function stageTf() {
  console.log('REBUILT construction — one fixed level per ratio, 90/90, all readings pooled\n');
  const opts = { left: 5, right: 5, minLegAtr: 2.0, maxAge: 400, killBeyond: true };
  const head = 'ratio '.padEnd(8) + TIMEFRAMES.map(x => TF_NAME[x].padStart(16)).join('');
  for (const what of ['tests', 'respect', 'alpha']) {
    console.log(`\n${what}`);
    console.log(head);
    console.log('─'.repeat(head.length));
    for (const r of RATIOS) {
      let row = String(r).padEnd(8);
      for (const m of TIMEFRAMES) {
        let cell = '—';
        try {
          const { s } = run(m, opts, r);
          if (s.tests >= 30) {
            cell = what === 'tests' ? String(s.tests)
                 : what === 'respect' ? fp(s.respect)
                 : f(s.alpha);
          } else cell = `(${s.tests})`;
        } catch (e) { cell = 'err'; }
        row += cell.padStart(16);
      }
      console.log(row);
    }
  }
}

function stageDir() {
  const opts = { left: 5, right: 5, minLegAtr: 2.0, maxAge: 400, killBeyond: true };
  const tfs = (process.argv[3] || '5,15,60,240').split(',').map(Number);
  console.log('Reading split — 90/90, alpha (n)\n');
  const head = 'tf   ratio'.padEnd(12) + READINGS.map(x => x.padStart(15)).join('');
  console.log(head);
  console.log('─'.repeat(head.length));
  for (const m of tfs) {
    for (const r of RATIOS) {
      let row = (TF_NAME[m] + ' ' + r).padEnd(12);
      const p = projectFib(m, opts);
      const ev = tag(levelTestEvents(bars, p.lines[r], atr1), p.legDir);
      for (const name of READINGS) {
        const list = only(ev, name);
        const cell = list.length >= 25
          ? `${f(score(list).alpha)} (${list.length})` : `(${list.length})`;
        row += cell.padStart(15);
      }
      console.log(row);
    }
    console.log('');
  }
}

/*
 * The same size applied to every timeframe and every ratio, so the cells are
 * comparable and the shape of the surface is visible rather than one lucky
 * cell. Picking the best cell of a 90-cell target grid is overfitting; seeing
 * a whole region positive is not.
 */
function stageGrid() {
  const reading = process.argv[3] || 'hold';
  const tp = Number(process.argv[4] || 80), sl = Number(process.argv[5] || 80);
  const hold = Number(process.argv[6] || 240);
  const opts = { left: 5, right: 5, minLegAtr: 2.0, maxAge: 400, killBeyond: true };
  console.log(`reading ${reading}   ${tp}/${sl}   hold ${hold}m   ` +
    `blind long ${f(blind(1, tp, sl, hold))}  blind short ${f(blind(-1, tp, sl, hold))}\n`);
  const head = 'ratio'.padEnd(8) + TIMEFRAMES.map(x => TF_NAME[x].padStart(15)).join('');
  console.log(head);
  console.log('─'.repeat(head.length));
  for (const r of RATIOS) {
    let row = String(r).padEnd(8);
    for (const m of TIMEFRAMES) {
      let cell = '—';
      try {
        const { s } = run(m, opts, r, reading, tp, sl, hold, 20000);
        cell = s.traded >= 40 ? `${f(s.alpha, 1)} (${s.traded})` : `(${s.traded})`;
      } catch (e) { cell = 'err'; }
      row += cell.padStart(15);
    }
    console.log(row);
  }
  // pooled deep and shallow, the two halves of the grid a chartist draws
  for (const [name, rs] of [['0.5+0.618', [0.5, 0.618]], ['0.236+0.382', [0.236, 0.382]],
                            ['0.618+0.786', [0.618, 0.786]]]) {
    let row = name.padEnd(8);
    for (const m of TIMEFRAMES) {
      let cell = '—';
      try {
        const { s } = run(m, opts, rs, reading, tp, sl, hold, 20000);
        cell = s.traded >= 40 ? `${f(s.alpha, 1)} (${s.traded})` : `(${s.traded})`;
      } catch (e) { cell = 'err'; }
      row += cell.padStart(15);
    }
    console.log(row);
  }
}

/*
 * Is it Fibonacci, or is it "somewhere in the middle of the leg"?
 *
 * The honest control for a ratio-based level is not a random price, it is a
 * neighbouring ratio that no one draws. If 0.55 and 0.65 pay exactly what
 * 0.618 pays, the number 0.618 is decoration and the finding is about depth
 * of retracement, not about Fibonacci. This scan walks the ratio finely and
 * reports the shape.
 */
function stageRatioScan() {
  const m = Number(process.argv[3] || 60);
  const reading = process.argv[4] || 'hold';
  const tp = Number(process.argv[5] || BEST.tp), sl = Number(process.argv[6] || BEST.sl);
  const hold = Number(process.argv[7] || BEST.hold);
  const scan = [];
  for (let r = 0.20; r <= 0.92; r += 0.02) scan.push(Math.round(r * 1000) / 1000);
  const opts = { ...BEST.opts, ratios: scan };
  const p = projectFib(m, opts);
  console.log(`ratio scan — ${TF_NAME[m]} ${reading} ${tp}/${sl} hold ${hold}   ` +
    `(fib ratios marked *)\n`);
  console.log('ratio      n   respect%     ALPHA');
  console.log('─'.repeat(40));
  const fib = new Set([0.236, 0.382, 0.5, 0.618, 0.786]);
  for (const r of scan) {
    const ev = tag(levelTestEvents(bars, p.lines[r], atr1), p.legDir);
    const list = only(ev, reading);
    const s = score(list, tp, sl, hold, 20000);
    const all = score(ev, tp, sl, hold, 20000);
    console.log(`${(fib.has(r) ? '*' : ' ')}${String(r).padStart(5)}` +
      `${String(s.traded).padStart(7)}${fp(all.respect).padStart(10)}${f(s.alpha).padStart(11)}`);
  }
}

function stageExcursion() {
  const opts = BEST.opts;
  const combos = (process.argv[3] || '60:0.618:dnHold,60:0.618:upHold,15:0.618:dnHold')
    .split(',').map(x => x.split(':'));
  for (const [ms, rs, reading] of combos) {
    const m = Number(ms), r = rs.split('+').map(Number);
    const { list } = run(m, opts, r.length > 1 ? r : r[0], reading);
    console.log(`\n${TF_NAME[m]}  ratio ${rs}  ${reading}   ${list.length} events`);
    const x = excursion(list);
    console.log('  horizon      MFE p25/med/p75/p90        MAE p25/med/p75/p90');
    for (const H of [60, 240, 1440]) {
      const a = x[H].mfe, b = x[H].mae;
      console.log(`  ${String(H).padStart(5)}m   ` +
        `${fp(a.p25, 0).padStart(5)}${fp(a.med, 0).padStart(6)}${fp(a.p75, 0).padStart(6)}${fp(a.p90, 0).padStart(6)}   ` +
        `      ${fp(b.p25, 0).padStart(5)}${fp(b.med, 0).padStart(6)}${fp(b.p75, 0).padStart(6)}${fp(b.p90, 0).padStart(6)}`);
    }
  }
}

function stageTargets() {
  const opts = BEST.opts;
  const combos = (process.argv[3] || '60:0.618:dnHold').split(',').map(x => x.split(':'));
  const TPS = (process.argv[5] || '15,20,25,30,40,50,60,80,100,130').split(',').map(Number);
  const SLS = (process.argv[6] || '15,20,25,30,40,50,60,80,100').split(',').map(Number);
  const HOLD = Number(process.argv[4] || 240);
  for (const [ms, rs, reading] of combos) {
    const m = Number(ms), r = rs.split('+').map(Number);
    const { list } = run(m, opts, r.length > 1 ? r : r[0], reading);
    console.log(`\n${TF_NAME[m]}  ratio ${rs}  ${reading}   ${list.length} events   hold ${HOLD}m`);
    console.log('  tp\\sl' + SLS.map(x => String(x).padStart(8)).join(''));
    for (const tp of TPS) {
      let row = String(tp).padStart(6);
      for (const sl of SLS) {
        const s = score(list, tp, sl, HOLD, 12000);
        row += (s.traded >= 60 ? f(s.alpha, 1) : '—').padStart(8);
      }
      console.log(row);
    }
  }
}

function stageKnobs() {
  const m = Number(process.argv[3] || 60);
  const rArg = (process.argv[4] || '0.5+0.618').split('+').map(Number);
  const r = rArg.length > 1 ? rArg : rArg[0];
  const reading = process.argv[5] || 'hold';
  const tp = Number(process.argv[6] || BEST.tp), sl = Number(process.argv[7] || BEST.sl);
  const hold = Number(process.argv[8] || BEST.hold);
  console.log(`Generator robustness — ${TF_NAME[m]} ratio ${rArg.join('+')} ${reading} ${tp}/${sl} hold ${hold}\n`);
  console.log('left/right  minLegAtr  maxAge  killBeyond    n     respect%     ALPHA');
  console.log('─'.repeat(74));
  const vals = [];
  for (const lr of [3, 5, 8, 12]) {
    for (const mla of [1.0, 1.5, 2.0, 3.0]) {
      for (const age of [200, 400, 800]) {
        for (const kb of [true, false]) {
          const opts = { left: lr, right: lr, minLegAtr: mla, maxAge: age, killBeyond: kb };
          const { s } = run(m, opts, r, reading, tp, sl, hold, 12000);
          if (s.traded < 40) continue;
          vals.push(s.alpha);
          console.log(`${String(lr).padStart(6)}    ${String(mla).padStart(8)}` +
            `${String(age).padStart(9)}${String(kb).padStart(11)}` +
            `${String(s.traded).padStart(7)}${fp(s.respect).padStart(11)}${f(s.alpha).padStart(11)}`);
        }
      }
    }
  }
  const pos = vals.filter(v => v > 0).length;
  const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
  console.log(`\n${pos}/${vals.length} positive   mean ${f(mean)}   ` +
    `worst ${f(Math.min(...vals))}   best ${f(Math.max(...vals))}`);
}

function stageDetector() {
  const { m, ratio: r, reading, opts, tp, sl, hold } = BEST;
  console.log(`Detector robustness — ${TF_NAME[m]} ratio ${r} ${reading} ${tp}/${sl} hold ${hold}\n`);
  console.log('tolAtr  approachAtr  breakAtr  resetAtr      n     ALPHA');
  console.log('─'.repeat(58));
  const vals = [];
  for (const tol of [0.12, 0.20, 0.30]) {
    for (const app of [1.0, 1.5, 2.5]) {
      for (const brk of [0.15, 0.25, 0.40]) {
        const d = { tolAtr: tol, approachAtr: app, breakAtr: brk, resetAtr: 1.0 };
        const { s } = run(m, opts, r, reading, tp, sl, hold, 12000, d);
        if (s.traded < 40) continue;
        vals.push(s.alpha);
        console.log(`${String(tol).padStart(6)}${String(app).padStart(13)}` +
          `${String(brk).padStart(10)}${String(1.0).padStart(10)}` +
          `${String(s.traded).padStart(7)}${f(s.alpha).padStart(10)}`);
      }
    }
  }
  const pos = vals.filter(v => v > 0).length;
  console.log(`\n${pos}/${vals.length} positive   mean ` +
    f(vals.reduce((a, b) => a + b, 0) / (vals.length || 1)));
}

function stagePlacebo() {
  /*
   * Keep every pivot, every leg, every birth and death, and replace only the
   * leg HEIGHT with a random draw from the observed height distribution. The
   * level then sits at a plausible but wrong price on the same schedule. If
   * the real number survives and the placebo does not, the ratio of the leg is
   * doing the work rather than the timing or the market drift.
   */
  const { m, ratio: r, reading, opts, tp, sl, hold } = BEST;
  const { bars: hb, atr: ha } = tf(m);
  const real = fibLines(hb, ha, opts);
  const pool = real.legs.map(l => l.height / (ha[l.born] || 1)).filter(Number.isFinite);
  console.log(`placebo — ${TF_NAME[m]} ratio ${r} ${reading} ${tp}/${sl} hold ${hold}, ` +
    `${pool.length} leg heights in the pool\n`);
  const { s: s0 } = run(m, opts, r, reading, tp, sl, hold, 12000);
  console.log(`real          n ${String(s0.traded).padStart(5)}   alpha ${f(s0.alpha)}`);
  const out = [];
  for (let k = 0; k < 12; k++) {
    const rr = rng(9000 + k * 77);
    const o2 = { ...opts, slopeShuffle: () => pool[Math.floor(rr() * pool.length)] };
    const { s } = run(m, o2, r, reading, tp, sl, hold, 12000);
    out.push(s.alpha);
    console.log(`placebo ${String(k).padStart(2)}    n ${String(s.traded).padStart(5)}   alpha ${f(s.alpha)}`);
  }
  const mean = out.reduce((a, b) => a + b, 0) / out.length;
  console.log(`\nplacebo mean ${f(mean)}   best ${f(Math.max(...out))}   ` +
    `${out.filter(v => v >= s0.alpha).length}/12 at or above the real result`);
}

function monthly(list, tp, sl, hold) {
  const bl = blind(1, tp, sl, hold), bs = blind(-1, tp, sl, hold);
  const byM = new Map();
  for (const e of list) {
    const k = new Date(bars[e.i].t).toISOString().slice(0, 7);
    const p = race(e.i, e.dir, tp, sl, hold);
    if (p === null) continue;
    if (!byM.has(k)) byM.set(k, { n: 0, net: 0, adj: 0 });
    const o = byM.get(k);
    o.n++; o.net += p; o.adj += p - (e.dir === 1 ? bl : bs);
  }
  return [...byM.entries()].sort();
}

/*
 * Trades that overlap in time are not independent observations. `serial` keeps
 * a greedy non-overlapping subset: once a trade is taken, every event inside
 * its holding window is discarded. It is also the honest account of what one
 * position-limited trader could actually have taken.
 */
function serial(list, hold) {
  const out = [];
  let free = -1;
  for (const e of list) {
    if (e.i <= free) continue;
    out.push(e);
    free = e.i + hold;
  }
  return out;
}

/*
 * How much of the sample is actually independent?
 *
 * 750 events over 192,081 minutes, each held 240 minutes, covers 180,000
 * minutes of tape. The trades are almost continuously overlapping, so 750 is
 * not 750 pieces of evidence and the per-trade standard error computed from it
 * is a fantasy. This stage strips the sample down to non-overlapping trades
 * several ways — greedy from the front, greedy from a random offset, and one
 * trade per leg — and reports what survives at each holding time.
 */
function stageSerial() {
  const { m, ratio: r, reading, opts } = BEST;
  const HOLDS = (process.argv[3] || '60,120,240,480').split(',').map(Number);
  const SIZES = (process.argv[4] || '40/60,60/100,80/130,130/200').split(',')
    .map(x => x.split('/').map(Number));
  const combos = [];
  for (const hold of HOLDS) for (const [tp, sl] of SIZES) combos.push([hold, tp, sl]);
  console.log(`${TF_NAME[m]}  ratios ${[].concat(r).join('+')}  ${reading}\n`);
  console.log('hold    tp/sl      all n    all ALPHA      serial n   serial ALPHA      t   rand-offset mean (min..max)');
  console.log('─'.repeat(116));
  for (const [hold, tp, sl] of combos) {
    const { list, s } = run(m, opts, r, reading, tp, sl, hold, 20000);
    const ss = score(serial(list, hold), tp, sl, hold, 20000);
    // Greedy from the front favours whichever event happens to come first in a
    // cluster. Dropping a random prefix and re-greedying removes that bias.
    const rr = rng(555);
    const alts = [];
    for (let k = 0; k < 15; k++) {
      const drop = Math.floor(rr() * Math.min(20, list.length));
      const sub = score(serial(list.slice(drop), hold), tp, sl, hold, 20000);
      if (sub.traded >= 40) alts.push(sub.alpha);
    }
    const mean = alts.reduce((a, b) => a + b, 0) / (alts.length || 1);
    console.log(`${String(hold).padStart(4)}m ${(tp + '/' + sl).padStart(9)}` +
      `${String(s.traded).padStart(10)}${f(s.alpha).padStart(13)}` +
      `${String(ss.traded).padStart(14)}${f(ss.alpha).padStart(15)}${fp(ss.t, 2).padStart(7)}` +
      `   ${f(mean)} (${f(Math.min(...alts))}..${f(Math.max(...alts))})`);
  }
}

function stageFinal() {
  const { m, ratio: r, reading, opts, tp, sl, hold } = BEST;
  console.log(`${N.toLocaleString()} bars   random respect ${RANDOM_RESPECT}%\n`);

  // before
  let before = { tests: 0, alpha: NaN };
  try { before = score(levelTestEvents(bars, project(1, CURRENT), atr1)); } catch (e) {}
  console.log('BEFORE — LV.fibLevels 1m, left/right 60, nearest ratio to close, 90/90');
  console.log(`  ${before.tests} tests   respect ${fp(before.respect)}%   ` +
    `raw ${f(before.raw)}   ALPHA ${f(before.alpha)}\n`);

  const { s, list, all } = run(m, opts, r, reading, tp, sl, hold);
  const allS = score(all, tp, sl, hold);
  console.log(`AFTER — ${TF_NAME[m]} candles, ${opts.left}/${opts.right} pivots, ` +
    `minLeg ${opts.minLegAtr} ATR, ratios ${[].concat(r).join(' and ')}, reading ${reading}, ` +
    `${tp}/${sl}, hold ${hold}m`);
  console.log(`  blind long ${f(blind(1, tp, sl, hold))}   blind short ${f(blind(-1, tp, sl, hold))}`);
  console.log(`  ${s.traded} trades (${s.longs}L / ${s.shorts}S)   hit ${fp(s.hit)}%   ` +
    `raw ${f(s.raw)}   ALPHA ${f(s.alpha)}`);
  console.log(`  long alpha ${f(s.longAlpha)}   short alpha ${f(s.shortAlpha)}`);
  console.log(`  respect over ALL ${allS.tests} tests of these levels: ${fp(allS.respect)}% ` +
    `(random ${RANDOM_RESPECT}%) — the edge is not in the respect rate\n`);

  const ser = serial(list, hold);
  const ss = score(ser, tp, sl, hold);
  console.log(`non-overlapping subset (one position at a time): ${ss.traded} trades   ` +
    `ALPHA ${f(ss.alpha)}   raw ${f(ss.raw)}\n`);

  console.log('month     n      raw   adjusted');
  for (const [k, o] of monthly(list, tp, sl, hold)) {
    console.log(`${k}  ${String(o.n).padStart(4)}  ${f(o.net / o.n).padStart(8)}  ${f(o.adj / o.n).padStart(9)}`);
  }

  // holdout: tune the target on the first half, spend it on the second
  const mid = Math.floor(N / 2);
  const first = list.filter(e => e.i < mid), second = list.filter(e => e.i >= mid);
  let bt = null, bv = -Infinity;
  for (const t of [20, 30, 40, 50, 60, 80, 100, 130, 160, 200]) {
    for (const l of [20, 30, 40, 50, 60, 80, 100, 130, 160, 200]) {
      const sc = score(first, t, l, hold, 12000);
      if (sc.traded >= 40 && sc.alpha > bv) { bv = sc.alpha; bt = [t, l]; }
    }
  }
  if (bt) {
    const sc2 = score(second, bt[0], bt[1], hold, 40000);
    const scFixed = score(second, tp, sl, hold, 40000);
    console.log(`\nholdout: target tuned on the first half -> ${bt[0]}/${bt[1]} ` +
      `(alpha ${f(bv)} in-sample, n ${first.length})`);
    console.log(`         spent on the untouched second half: ${sc2.traded} trades   ALPHA ${f(sc2.alpha)}`);
    console.log(`         the headline ${tp}/${sl} on the same second half: ` +
      `${scFixed.traded} trades   ALPHA ${f(scFixed.alpha)}`);
    const sc1 = score(first, tp, sl, hold, 40000);
    console.log(`         the headline ${tp}/${sl} on the first half:       ` +
      `${sc1.traded} trades   ALPHA ${f(sc1.alpha)}`);
  }
}

const stage = process.argv[2] || 'final';
({ base: stageBase, causal: stageCausal, tf: stageTf, dir: stageDir,
   excursion: stageExcursion, targets: stageTargets, knobs: stageKnobs,
   detector: stageDetector, placebo: stagePlacebo, grid: stageGrid,
   ratioscan: stageRatioScan, serial: stageSerial,
   final: stageFinal }[stage] || stageFinal)();

module.exports = { fibLines, excursion, score, race, blind, loadBars, tag, only };
