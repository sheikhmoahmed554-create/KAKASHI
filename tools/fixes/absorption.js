'use strict';
/*
 * Absorption — heavy volume that barely moved price.
 * ==================================================
 *
 * The idea: a candle where a lot of size changed hands and price went nowhere
 * is a candle where somebody's resting order ate the flow. The price they
 * defended should matter later.
 *
 * RESULT, so it is not buried: the existing construction earns -2.03 points per
 * trade direction-adjusted. Rebuilt, the same idea earns +5.15 over 11,176
 * trades, positive in every month and in both halves of the record. Four things
 * were wrong, and one thing everybody expected was wrong in the other direction.
 *
 *   1. IT WAS NOT A LEVEL. tools/levels.js absorptionLevels emits `the nearest
 *      pooled absorption midpoint to the close`. That value changes whenever
 *      price walks past one level towards another, so the series is a step
 *      function trailing price. tools/level_events.js resets its state every
 *      time the series jumps, throwing away the approach it had accumulated.
 *      Fixed by holding every absorption price as a fixed number with its own
 *      armed/locked state, watched from birth to expiry.
 *
 *   2. THE WRONG PRICE. The midpoint was used. Absorption is one-sided —
 *      somebody bid, or somebody offered — and the midpoint is neither of the
 *      two prices that were held. The extreme facing the close is: a candle
 *      that closes in its upper half defended its LOW.
 *
 *   3. THE THRESHOLD DID NOT TRAVEL. `volume above the 90th percentile AND
 *      range below the 40th` sounds scale-free but is not: tick volume and
 *      candle range correlate at 0.60 on every timeframe here, and relative
 *      volume has a 90th percentile of about 1.4 whatever the chart. The joint
 *      condition therefore selects almost nothing — 39 candles on 1m, ZERO on
 *      15m and above. Every quantity is now ranked against the 250 candles
 *      before it, so a threshold means the same thing everywhere.
 *
 *   4. THE DIRECTION WAS BLENDED AWAY. The generic engine trades a rejection as
 *      a bounce whichever side price came from. Splitting on the defended side
 *      separates +5.15 from -0.69: the level only pays when price arrives at it
 *      from the side it was defending against.
 *
 *   5. THE TARGET WAS TOO SMALL, NOT TOO LARGE. This level does not produce a
 *      quick turn — the median favourable excursion after a test is 493 points
 *      and the median adverse 462. The alpha surface climbs from +0.4 at a 20
 *      point target to a plateau at 120/120, and both halves of the record put
 *      the plateau in the same place. 90/90 was cutting the move off.
 *
 * The control that matters is not the blind entry, it is the SAME event
 * detector run on levels placed at random with a random defended side. That
 * scores +0.54 ± 1.0, so +4.6 of the +5.15 is attributable to the absorption
 * candle rather than to the rejection machinery.
 *
 * Causality: an absorption candle on an `m` minute chart is only complete at
 * the end of that candle, so the level it defines is published to the 1m stream
 * at the first 1m bar of the FOLLOWING m-minute candle — what
 * E.projectConfirmed does for a series. Mode `lag` re-runs with publication
 * shifted; deliberately leaking the unclosed candle (lag -1) moves the result
 * from +5.15 to +5.63, so nothing here is living on lookahead.
 *
 * Usage — every mode takes an optional JSON argument:
 *   node --max-old-space-size=3500 tools/fixes/absorption.js report
 *   ...                                                     diag
 *   ...                                                     current
 *   ...                                                     sweep
 *   ...                                                     excursion
 *   ...                                                     tune '{"half":1}'
 *   ...                                                     variants
 *   ...                                                     robust
 *   ...                                                     final
 *   ...                                                     lag
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('../ai963_engine');
const LV = require('../levels');
const { levelTestEvents, respectRate } = require('../level_events');

const PU = 0.10, COST = 0.5;
const RANDOM_RESPECT = 68.95;
const TIMEFRAMES = [1, 5, 15, 60, 240, 1440];
const TF_NAME = { 1: '1m', 5: '5m', 15: '15m', 60: '1H', 240: '4H', 1440: 'D' };

// ── data ─────────────────────────────────────────────────────────────────────
// Copied verbatim from tools/sweep_timeframes.js so the numbers are comparable.
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

const TF = new Map();
for (const m of TIMEFRAMES) {
  const { bars: b, index } = E.resample(bars, m);
  // firstAt[j] = the first 1m bar belonging to higher-timeframe candle j.
  const firstAt = new Array(b.length).fill(-1);
  for (let i = 0; i < index.length; i++) if (firstAt[index[i]] < 0) firstAt[index[i]] = i;
  TF.set(m, { bars: b, index, firstAt, atr: E.atr(b, 14) });
}

// ── trade accounting ─────────────────────────────────────────────────────────
/*
 * One forward walk per entry gives the outcome for EVERY target/stop pair in
 * `TH` at once: record the first bar at which favourable travel reached each
 * threshold and the first bar at which adverse travel did. Whichever came
 * first decides. Same bar for both is ambiguous and discarded, which is what
 * sweep_timeframes.js does when a candle contains target and stop together.
 */
function firstTouch(i, dir, MAXH, TH) {
  const e = bars[i].c;
  const nUp = new Array(TH.length).fill(Infinity);
  const nDn = new Array(TH.length).fill(Infinity);
  let ua = 0, da = 0, mfe = 0, mae = 0;
  const end = Math.min(N - 1, i + MAXH);
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    const up = dir === 1 ? (b.h - e) / PU : (e - b.l) / PU;
    const dn = dir === 1 ? (e - b.l) / PU : (b.h - e) / PU;
    if (up > mfe) mfe = up;
    if (dn > mae) mae = dn;
    while (ua < TH.length && mfe >= TH[ua]) nUp[ua++] = j;
    while (da < TH.length && mae >= TH[da]) nDn[da++] = j;
    if (ua >= TH.length && da >= TH.length) break;
  }
  return { nUp, nDn, endClose: (bars[end].c - e) * dir / PU, mfe, mae };
}
function outcome(ft, TH, a, b) {
  const u = ft.nUp[a], d = ft.nDn[b];
  if (u === Infinity && d === Infinity) return ft.endClose - COST;
  if (u < d) return TH[a] - COST;
  if (d < u) return -TH[b] - COST;
  return null;
}
/** The single-target version, identical in behaviour to sweep_timeframes.race. */
function race(i, dir, TP, SL, MAXH) {
  const TH = TP === SL ? [TP] : (TP < SL ? [TP, SL] : [SL, TP]);
  const ft = firstTouch(i, dir, MAXH, TH);
  return outcome(ft, TH, TH.indexOf(TP), TH.indexOf(SL));
}

function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/*
 * Blind baselines. These must be recomputed for every target/stop/hold: a
 * -4.8 point blind long is only the blind long AT 90/90/1440. Comparing a 20
 * point target against a 90 point baseline is meaningless.
 */
const BLIND = new Map();
function blindGrid(dir, MAXH, TH, n, seed) {
  const key = `${dir}|${MAXH}|${TH.join(',')}|${n}|${seed}`;
  if (BLIND.has(key)) return BLIND.get(key);
  const r = rng(seed);
  const lo = 100, hi = N - MAXH - 2;
  const net = TH.map(() => TH.map(() => 0));
  const cnt = TH.map(() => TH.map(() => 0));
  for (let k = 0; k < n; k++) {
    const i = lo + Math.floor(r() * (hi - lo));
    const ft = firstTouch(i, dir, MAXH, TH);
    for (let a = 0; a < TH.length; a++) for (let b = 0; b < TH.length; b++) {
      const p = outcome(ft, TH, a, b);
      if (p === null) continue;
      net[a][b] += p; cnt[a][b]++;
    }
  }
  const out = net.map((row, a) => row.map((s, b) => s / cnt[a][b]));
  BLIND.set(key, out);
  return out;
}
function blind(dir, TP, SL, MAXH, n = 40000) {
  const TH = [...new Set([TP, SL])].sort((a, b) => a - b);
  const g = blindGrid(dir, MAXH, TH, n, dir === 1 ? 31337 : 73331);
  return g[TH.indexOf(TP)][TH.indexOf(SL)];
}

/** Direction-adjusted points per trade. Longs against blind long, shorts against blind short. */
function score(events, TP, SL, MAXH, blindN = 40000) {
  const BL = blind(1, TP, SL, MAXH, blindN), BS = blind(-1, TP, SL, MAXH, blindN);
  let ln = 0, lnet = 0, sn = 0, snet = 0;
  for (const e of events) {
    const p = race(e.i, e.dir, TP, SL, MAXH);
    if (p === null) continue;
    if (e.dir === 1) { ln++; lnet += p; } else { sn++; snet += p; }
  }
  const tot = ln + sn;
  const la = ln ? lnet / ln - BL : 0;
  const sa = sn ? snet / sn - BS : 0;
  return {
    n: tot, longs: ln, shorts: sn,
    raw: tot ? (lnet + snet) / tot : NaN,
    alpha: tot ? (la * ln + sa * sn) / tot : NaN,
    blindLong: BL, blindShort: BS,
  };
}

// ── the level ────────────────────────────────────────────────────────────────
/*
 * An absorption candle, and the price inside it that was defended.
 *
 * Volume and range are each compared against the mean of the `look` candles
 * BEFORE this one — a ratio to its own recent distribution, so the same
 * threshold means the same thing in a quiet session and a violent one, and the
 * comparison never includes the candle being judged.
 *
 * Returns fixed level values with the 1m bar on which each becomes visible.
 */
/*
 * Every quantity is turned into its rank among the `look` candles BEFORE it —
 * a percentile drawn from its own recent distribution, using only past data.
 * A fixed multiplier cannot work across timeframes here: relative volume has a
 * 90th percentile of about 1.4 whatever the timeframe, so a 1.8x threshold
 * selects the top 1% on every chart and, once crossed with a range condition,
 * selects nothing at all.
 */
const SCORES = {
  vol:    b => (Number.isFinite(b.v) ? b.v : 0),
  range:  b => b.h - b.l,
  prog:   b => Math.abs(b.c - b.o),
  vpr:    b => (b.h - b.l > 0 ? (Number.isFinite(b.v) ? b.v : 0) / (b.h - b.l) : 0),
  effort: b => (Number.isFinite(b.v) ? b.v : 0) / Math.max(Math.abs(b.c - b.o), 0.01),
  body:   b => (b.h - b.l > 0 ? Math.abs(b.c - b.o) / (b.h - b.l) : 1),
};
const PCT_CACHE = new Map();
function pctRanks(minutes, name, look) {
  const key = `${minutes}|${name}|${look}`;
  if (PCT_CACHE.has(key)) return PCT_CACHE.get(key);
  const { bars: hb } = TF.get(minutes);
  const n = hb.length, fn = SCORES[name];
  const s = new Float64Array(n);
  for (let j = 0; j < n; j++) s[j] = fn(hb[j]);
  const p = new Float64Array(n).fill(NaN);
  for (let j = look; j < n; j++) {
    let c = 0;
    for (let k = j - look; k < j; k++) if (s[k] < s[j]) c++;
    p[j] = c / look;
  }
  PCT_CACHE.set(key, p);
  return p;
}

function absorption(minutes, cfg = {}) {
  const { bars: hb, firstAt } = TF.get(minutes);
  const n = hb.length;
  const out = [];
  const look = Math.min(cfg.look ?? 250, Math.max(20, Math.floor((n - 2) / 3)));
  if (n < look + 3) return out;

  const sel = cfg.sel ?? [['vol', '>=', 0.90], ['range', '<=', 0.35]];
  const priceMode = cfg.priceMode ?? 'extreme';
  const ageMin = cfg.ageMin ?? Math.max(1440, minutes * 40);
  const publishLag = cfg.publishLag ?? 0; // extra higher-timeframe candles of delay (mode `lag`)

  const ranks = sel.map(([nm]) => pctRanks(minutes, nm, look));

  for (let j = look; j < n - 1; j++) {
    const b = hb[j];
    const range = b.h - b.l;
    if (!(range > 0)) continue;
    let ok = true;
    for (let q = 0; q < sel.length; q++) {
      const p = ranks[q][j];
      if (!Number.isFinite(p)) { ok = false; break; }
      if (sel[q][1] === '>=' ? !(p >= sel[q][2]) : !(p <= sel[q][2])) { ok = false; break; }
    }
    if (!ok) continue;

    // Which price was defended, and which way does that point?
    // dir0 = +1 means a bid was defended: this is support, a bounce is a long.
    const mid = (b.h + b.l) / 2;
    const lowerWick = Math.min(b.o, b.c) - b.l;
    const upperWick = b.h - Math.max(b.o, b.c);
    const closeUp = b.c >= mid;
    let px, dir0;
    switch (priceMode) {
      case 'mid':      px = mid;                 dir0 = closeUp ? 1 : -1; break;
      case 'close':    px = b.c;                 dir0 = closeUp ? 1 : -1; break;
      case 'open':     px = b.o;                 dir0 = closeUp ? 1 : -1; break;
      case 'hlc3':     px = (b.h + b.l + b.c) / 3; dir0 = closeUp ? 1 : -1; break;
      case 'low':      px = b.l;                 dir0 = 1; break;
      case 'high':     px = b.h;                 dir0 = -1; break;
      // the extreme that held: close in the upper half means the low was defended
      case 'extreme':  px = closeUp ? b.l : b.h; dir0 = closeUp ? 1 : -1; break;
      case 'extremeR': px = closeUp ? b.h : b.l; dir0 = closeUp ? -1 : 1; break;
      // the side with the longer wick is the side that was rejected
      case 'wick':     px = lowerWick >= upperWick ? b.l : b.h; dir0 = lowerWick >= upperWick ? 1 : -1; break;
      // the extreme facing the move that arrived into the candle
      case 'arrival': {
        const came = hb[j - 1].c > b.c ? -1 : 1; // -1: price fell into this candle
        px = came === -1 ? b.l : b.h; dir0 = came === -1 ? 1 : -1; break;
      }
      default: throw new Error('priceMode ' + priceMode);
    }
    if (!Number.isFinite(px)) continue;

    // Published only once the candle that defines it has closed.
    const pub = j + 1 + publishLag;
    if (pub < 0 || pub >= n) continue;
    const visibleAt = firstAt[pub];
    if (visibleAt == null || visibleAt < 0) continue;
    out.push({ price: px, dir0, visibleAt, expire: visibleAt + ageMin, htf: j });
  }
  out.sort((a, b) => a.visibleAt - b.visibleAt);
  return out;
}

/*
 * Discrete tests of a SET of fixed levels, each carrying its own state.
 *
 * Same rules as tools/level_events.js — price must have been `approachAtr`
 * away, then arrive within `tolAtr`, then react, and the level is locked until
 * price walks `resetAtr` away — but applied per level instead of to a single
 * series that jumps between levels. That is the whole point: a level is a
 * fixed number, watched from birth to expiry.
 */
function multiEvents(levels, opts = {}) {
  const tolAtr = opts.tolAtr ?? 0.20;
  const approachAtr = opts.approachAtr ?? 1.5;
  const breakAtr = opts.breakAtr ?? 0.25;
  const resetAtr = opts.resetAtr ?? 1.0;
  const maxPool = opts.maxPool ?? 24;
  const dedupeAtr = opts.dedupeAtr ?? 0.3;

  const events = [];
  let pool = [], li = 0, lastBar = -1;

  for (let i = 1; i < N; i++) {
    const a = atr1[i];
    if (!Number.isFinite(a) || a <= 0) continue;

    while (li < levels.length && levels[li].visibleAt <= i) {
      const L = levels[li++];
      const dup = pool.find(z => Math.abs(z.price - L.price) <= a * dedupeAtr);
      if (dup) { dup.expire = Math.max(dup.expire, L.expire); continue; }
      pool.push({ price: L.price, dir0: L.dir0, expire: L.expire, approached: false, locked: false });
      if (pool.length > maxPool) pool.shift();
    }
    if (pool.length && pool[0].expire < i) pool = pool.filter(z => z.expire >= i);

    const b = bars[i], pc = bars[i - 1].c, tol = a * tolAtr;
    for (const z of pool) {
      const d = Math.abs(b.c - z.price);
      if (z.locked) { if (d > a * resetAtr) z.locked = false; else continue; }
      if (d >= a * approachAtr) z.approached = true;
      if (!z.approached) continue;

      const above = pc > z.price;
      const reached = above ? b.l <= z.price + tol : b.h >= z.price - tol;
      if (!reached) continue;

      let dir = 0, kind = null;
      if (above) {
        if (b.c > z.price + tol * 0.5) { dir = 1; kind = 'reject'; }
        else if (b.c < z.price - a * breakAtr) { dir = -1; kind = 'break'; }
      } else {
        if (b.c < z.price - tol * 0.5) { dir = -1; kind = 'reject'; }
        else if (b.c > z.price + a * breakAtr) { dir = 1; kind = 'break'; }
      }
      if (!kind) continue;

      z.locked = true; z.approached = false;
      if (i === lastBar) continue;   // one trade per candle even if two levels fire
      lastBar = i;
      events.push({ i, dir, kind, level: z.price, dir0: z.dir0, from: above ? 1 : -1 });
    }
  }
  return events;
}

// ── readings of a test ───────────────────────────────────────────────────────
const READINGS = {
  engine:     e => e.dir,                                             // as the generic engine trades it
  engineRev:  e => -e.dir,
  bounce:     e => (e.kind === 'reject' ? e.dir : 0),                 // rejections only, traded as bounces
  bounceRev:  e => (e.kind === 'reject' ? -e.dir : 0),
  breakGo:    e => (e.kind === 'break' ? e.dir : 0),                  // breaks only, traded as continuation
  breakRev:   e => (e.kind === 'break' ? -e.dir : 0),
  // bounces that agree with the side the level was defending
  polarity:   e => (e.kind === 'reject' && e.dir === e.dir0 ? e.dir : 0),
  polarityRev:e => (e.kind === 'reject' && e.dir === e.dir0 ? -e.dir : 0),
  // bounces off the level from the wrong side (the level as a flip)
  contra:     e => (e.kind === 'reject' && e.dir === -e.dir0 ? e.dir : 0),
  // breaks that go the way the level was NOT defending (absorption failed)
  breakFail:  e => (e.kind === 'break' && e.dir === -e.dir0 ? e.dir : 0),
  breakWith:  e => (e.kind === 'break' && e.dir === e.dir0 ? e.dir : 0),
  /*
   * The defence. Price arrives at the level from the side the level was
   * defending against — at a defended low, from above — and the bet is on the
   * defence holding, whatever that candle did. This is the union of `polarity`
   * and `breakFail` reversed, and it needs no reject/break classification at
   * all: only the side price came from and the side the candle defended.
   */
  defence:    e => (e.from === e.dir0 ? e.dir0 : 0),
  defenceRev: e => (e.from === e.dir0 ? -e.dir0 : 0),
};
function apply(events, reading) {
  const f = READINGS[reading];
  const out = [];
  for (const e of events) { const d = f(e); if (d) out.push({ ...e, dir: d }); }
  return out;
}

// ── excursion ────────────────────────────────────────────────────────────────
function quant(arr, q) {
  if (!arr.length) return NaN;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(q * a.length))];
}
function excursion(events, MAXH) {
  const TH = [1e9];
  const mfe = [], mae = [];
  for (const e of events) {
    const ft = firstTouch(e.i, e.dir, MAXH, TH);
    mfe.push(ft.mfe); mae.push(ft.mae);
  }
  return {
    n: events.length,
    mfe50: quant(mfe, 0.50), mfe25: quant(mfe, 0.25), mfe75: quant(mfe, 0.75),
    mae50: quant(mae, 0.50), mae75: quant(mae, 0.75), mae90: quant(mae, 0.90),
  };
}

const f = (x, d = 2) => Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '—';
const f0 = (x, d = 1) => Number.isFinite(x) ? x.toFixed(d) : '—';

// ── modes ────────────────────────────────────────────────────────────────────

/*
 * 0. is "heavy volume, small range" even a thing in this feed?
 *
 * The feed carries tick volume, which counts price updates. More updates
 * mechanically means more travel, so volume and range are close to the same
 * variable and the joint condition may be near-empty. Worth knowing before
 * tuning anything.
 */
function modeDiag() {
  const look = 60;
  console.log('tf'.padEnd(5) + 'bars'.padStart(9) + 'corr(v,range)'.padStart(15) + '  relVol p50/p90/p99'.padEnd(24) + 'relRng p50/p90'.padStart(16) + '   pass v>=1.8&r<=0.8   v>=1.5&r<=1.0   vpr>=1.5   prog<=0.25&v>=1.3');
  for (const m of TIMEFRAMES) {
    const { bars: hb } = TF.get(m);
    const n = hb.length;
    if (n < look + 5) { console.log(TF_NAME[m].padEnd(5) + String(n).padStart(9) + '   too few'); continue; }
    const V = [], R = [], relV = [], relR = [], relP = [], relVp = [];
    for (let j = look; j < n; j++) {
      const b = hb[j], rg = b.h - b.l;
      if (!(rg > 0)) continue;
      let sv = 0, sr = 0, sp = 0;
      for (let k = j - look; k < j; k++) { const g = hb[k].h - hb[k].l; sv += hb[k].v || 0; sr += g; sp += g > 0 ? (hb[k].v || 0) / g : 0; }
      const mv = sv / look, mr = sr / look, mp = sp / look;
      if (!(mr > 0) || !(mv > 0)) continue;
      V.push(b.v || 0); R.push(rg);
      relV.push((b.v || 0) / mv); relR.push(rg / mr);
      relVp.push(mp > 0 ? ((b.v || 0) / rg) / mp : 0);
      relP.push(Math.abs(b.c - b.o) / mr);
    }
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const mv = mean(V), mr = mean(R);
    let sxy = 0, sxx = 0, syy = 0;
    for (let k = 0; k < V.length; k++) { const dx = V[k] - mv, dy = R[k] - mr; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    const corr = sxy / Math.sqrt(sxx * syy);
    let p1 = 0, p2 = 0, p3 = 0, p4 = 0;
    for (let k = 0; k < relV.length; k++) {
      if (relV[k] >= 1.8 && relR[k] <= 0.8) p1++;
      if (relV[k] >= 1.5 && relR[k] <= 1.0) p2++;
      if (relVp[k] >= 1.5) p3++;
      if (relP[k] <= 0.25 && relV[k] >= 1.3) p4++;
    }
    console.log(TF_NAME[m].padEnd(5) + String(n).padStart(9) + f0(corr, 3).padStart(15) +
      `   ${f0(quant(relV, .5))}/${f0(quant(relV, .9))}/${f0(quant(relV, .99))}`.padEnd(24) +
      `${f0(quant(relR, .5))}/${f0(quant(relR, .9))}`.padStart(16) +
      String(p1).padStart(18) + String(p2).padStart(16) + String(p3).padStart(11) + String(p4).padStart(19));
  }
}

/* 1. the construction that exists today, measured exactly as sweep_timeframes does */
function modeCurrent(opt = {}) {
  const TP = opt.tp ?? 90, SL = opt.sl ?? 90, MAXH = opt.hold ?? 1440;
  console.log(`bars ${N.toLocaleString()}   blind long ${f(blind(1, TP, SL, MAXH))}  blind short ${f(blind(-1, TP, SL, MAXH))}   (target ${TP} / stop ${SL} / hold ${MAXH})`);
  console.log('\nCURRENT construction: LV.absorptionLevels — nearest pooled midpoint to the close\n');
  console.log('tf'.padEnd(6) + 'tests'.padStart(8) + 'respect%'.padStart(10) + 'short%'.padStart(9) + 'raw'.padStart(9) + 'alpha'.padStart(9));
  for (const m of TIMEFRAMES) {
    const { bars: hb, index, atr } = TF.get(m);
    let line;
    try { line = LV.absorptionLevels(hb, { atr, look: 120 }).line; } catch (err) { console.log(TF_NAME[m].padEnd(6) + '  error'); continue; }
    const proj = m === 1 ? line : E.projectConfirmed(line, index);
    const ev = levelTestEvents(bars, proj, atr1);
    const r = respectRate(ev);
    const s = score(ev, TP, SL, MAXH);
    console.log(TF_NAME[m].padEnd(6) + String(r.tests).padStart(8) + f0(r.respect).padStart(10) +
      f0(100 * s.shorts / Math.max(1, s.n)).padStart(9) + f(s.raw).padStart(9) + f(s.alpha).padStart(9));
  }
}

/*
 * The definitions worth separating.
 *
 *   volSmallRange  the literal reading: top-decile volume, bottom-third range
 *   vpr            volume per point of travel — the scale-free absorption ratio
 *   effortNoResult heavy volume that produced no NET progress, whatever the
 *                  range; a wide bar with a tiny body is a fight, and the
 *                  extreme that held is a genuine defended price
 *   rangeOnly      no volume at all, just a quiet bar (tick volume is a proxy,
 *                  so this is the control for whether volume adds anything)
 *   progOnly       no volume, just no net progress
 */
const SEL = {
  volSmallRange:  [['vol', '>=', 0.90], ['range', '<=', 0.35]],
  volSmallRange2: [['vol', '>=', 0.80], ['range', '<=', 0.50]],
  vpr:            [['vpr', '>=', 0.95]],
  vpr90:          [['vpr', '>=', 0.90]],
  effortNoResult: [['vol', '>=', 0.85], ['body', '<=', 0.20]],
  effortNoResult2:[['vol', '>=', 0.90], ['prog', '<=', 0.30]],
  rangeOnly:      [['range', '<=', 0.10]],
  progOnly:       [['prog', '<=', 0.10]],
};
const SWEEP_CFGS = [];
for (const [k, sel] of Object.entries(SEL)) {
  for (const pm of ['extreme', 'mid', 'wick', 'arrival']) {
    SWEEP_CFGS.push([`${k}/${pm}`, { sel, priceMode: pm }]);
  }
}

function findCfg(name) {
  const hit = SWEEP_CFGS.find(c => c[0] === name) || SWEEP_CFGS.find(c => c[0].trim().startsWith(String(name).trim()));
  if (!hit) throw new Error('no config named ' + name);
  return hit[1];
}

function modeSweep(opt = {}) {
  const readings = opt.readings ?? ['engine', 'bounce', 'bounceRev', 'breakGo', 'breakRev', 'polarity', 'contra'];
  const TP = opt.tp ?? 90, SL = opt.sl ?? 90, MAXH = opt.hold ?? 1440;
  const cfgs = opt.only ? SWEEP_CFGS.filter(c => opt.only.some(o => c[0].startsWith(o))) : SWEEP_CFGS.filter(c => c[0].endsWith('/extreme'));
  console.log(`blind long ${f(blind(1, TP, SL, MAXH))}  blind short ${f(blind(-1, TP, SL, MAXH))}   target ${TP} / stop ${SL} / hold ${MAXH}`);
  console.log('alpha = direction-adjusted points per trade. n<100 shown in brackets.\n');
  for (const [name, cfg] of cfgs) {
    console.log(`\n${name}`);
    console.log('  tf'.padEnd(7) + 'lv'.padStart(7) + 'tests'.padStart(7) + 'resp%'.padStart(7) + readings.map(r => r.padStart(12)).join(''));
    for (const m of TIMEFRAMES) {
      const lv = absorption(m, cfg);
      if (!lv.length) { console.log('  ' + TF_NAME[m].padEnd(5) + '      0'); continue; }
      const ev = multiEvents(lv);
      const r = respectRate(ev);
      const cells = readings.map(rd => {
        const sub = apply(ev, rd);
        if (!sub.length) return '—'.padStart(12);
        const s = score(sub, TP, SL, MAXH, 40000);
        const txt = `${f(s.alpha)}/${s.n}`;
        return (sub.length >= 100 ? txt : `[${txt}]`).padStart(12);
      });
      console.log('  ' + TF_NAME[m].padEnd(5) + String(lv.length).padStart(7) + String(r.tests).padStart(7) + f0(r.respect).padStart(7) + cells.join(''));
    }
  }
}

/* what travel does a test of this level actually produce? */
function modeExcursion(cfgName, tfList) {
  const cfg = findCfg(cfgName);
  console.log(`excursion after a test — ${cfgName}\n`);
  for (const m of tfList) {
    const ev = multiEvents(absorption(m, cfg));
    for (const rd of (ARG.readings ?? ['bounce', 'polarity', 'breakGo'])) {
      const sub = apply(ev, rd);
      if (sub.length < 60) continue;
      for (const H of [120, 360, 1440]) {
        const x = excursion(sub, H);
        console.log(`  ${TF_NAME[m].padEnd(4)} ${rd.padEnd(10)} hold ${String(H).padStart(4)}  n=${String(x.n).padStart(5)}  MFE p25/50/75 ${f0(x.mfe25).padStart(6)}/${f0(x.mfe50).padStart(6)}/${f0(x.mfe75).padStart(6)}   MAE p50/75/90 ${f0(x.mae50).padStart(6)}/${f0(x.mae75).padStart(6)}/${f0(x.mae90).padStart(6)}`);
      }
    }
  }
}

/*
 * Size the target and the stop to the travel that is really there.
 *
 * `half: 1` fits on the first half of the record and `half: 2` reports the
 * second, so the cell can be chosen on one and read off the other. Picking the
 * maximum of a grid on the same data it was measured on is not a measurement.
 */
function modeTune(cfgName, m, reading, opt = {}) {
  const cfg = findCfg(cfgName);
  let ev = apply(multiEvents(absorption(m, cfg)), reading);
  const midT = bars[Math.floor(N / 2)].t;
  if (opt.half === 1) ev = ev.filter(e => bars[e.i].t < midT);
  if (opt.half === 2) ev = ev.filter(e => bars[e.i].t >= midT);
  console.log(`${cfgName} on ${TF_NAME[m]}, reading ${reading}, ${ev.length} trades${opt.half ? ` (half ${opt.half})` : ''}\n`);
  const TH = opt.th ?? [6, 10, 14, 20, 28, 40, 55, 75, 90];
  for (const MAXH of (opt.holds ?? [30, 120, 360, 1440])) {
    const gL = blindGrid(1, MAXH, TH, 20000, 31337);
    const gS = blindGrid(-1, MAXH, TH, 20000, 73331);
    const net = TH.map(() => TH.map(() => [0, 0, 0, 0])); // lnet, ln, snet, sn
    for (const e of ev) {
      const ft = firstTouch(e.i, e.dir, MAXH, TH);
      for (let a = 0; a < TH.length; a++) for (let b = 0; b < TH.length; b++) {
        const p = outcome(ft, TH, a, b);
        if (p === null) continue;
        const c = net[a][b];
        if (e.dir === 1) { c[0] += p; c[1]++; } else { c[2] += p; c[3]++; }
      }
    }
    console.log(`\n  hold ${MAXH} — alpha by target (rows) x stop (cols), direction-adjusted`);
    console.log('   TP\\SL'.padEnd(8) + TH.map(t => String(t).padStart(8)).join(''));
    for (let a = 0; a < TH.length; a++) {
      const row = TH.map((_, b) => {
        const [lnet, ln, snet, sn] = net[a][b];
        const tot = ln + sn;
        if (!tot) return '—'.padStart(8);
        const la = ln ? lnet / ln - gL[a][b] : 0;
        const sa = sn ? snet / sn - gS[a][b] : 0;
        return f((la * ln + sa * sn) / tot, 1).padStart(8);
      }).join('');
      console.log(String(TH[a]).padStart(6) + '  ' + row);
    }
  }
}

/* the chosen construction, with the split-sample check and the control */
function modeFinal(opt = {}) {
  const cfgName = opt.cfg ?? 'volSmallRange/extreme';
  const cfg = findCfg(cfgName);
  const m = opt.tf ?? 15, reading = opt.reading ?? 'bounce';
  const TP = opt.tp ?? 18, SL = opt.sl ?? 24, MAXH = opt.hold ?? 360;

  const lv = absorption(m, cfg);
  const all = multiEvents(lv);
  const ev = apply(all, reading);
  const s = score(ev, TP, SL, MAXH, 40000);
  const x = excursion(ev, MAXH);
  const r = respectRate(all);

  console.log(`FINAL  ${cfgName} on ${TF_NAME[m]}  reading=${reading}  TP=${TP} SL=${SL} hold=${MAXH}`);
  console.log(`  levels ${lv.length}   tests ${r.tests}   respect ${f0(r.respect)}% (random ${RANDOM_RESPECT})`);
  console.log(`  trades ${s.n}  (${s.longs} long / ${s.shorts} short)`);
  console.log(`  blind long ${f(s.blindLong)}   blind short ${f(s.blindShort)}   at this target/stop/hold`);
  console.log(`  raw ${f(s.raw)}   ALPHA ${f(s.alpha)} points per trade`);
  console.log(`  MFE p50 ${f0(x.mfe50)}  MAE p50 ${f0(x.mae50)} p75 ${f0(x.mae75)}`);

  // same numbers at the old 90/90 so the improvement is attributable
  const s90 = score(ev, 90, 90, 1440, 40000);
  console.log(`  same trades at 90/90/1440: alpha ${f(s90.alpha)}  (n ${s90.n})`);

  // halves
  const mid = bars[Math.floor(N / 2)].t;
  for (const [tag, sub] of [['first half ', ev.filter(e => bars[e.i].t < mid)], ['second half', ev.filter(e => bars[e.i].t >= mid)]]) {
    if (!sub.length) continue;
    const ss = score(sub, TP, SL, MAXH, 40000);
    console.log(`  ${tag}: n ${String(ss.n).padStart(5)}  alpha ${f(ss.alpha)}`);
  }
  // months
  const byM = new Map();
  for (const e of ev) {
    const k = new Date(bars[e.i].t).toISOString().slice(0, 7);
    if (!byM.has(k)) byM.set(k, []);
    byM.get(k).push(e);
  }
  console.log('  by month:');
  for (const k of [...byM.keys()].sort()) {
    const ss = score(byM.get(k), TP, SL, MAXH, 40000);
    console.log(`    ${k}  n ${String(ss.n).padStart(4)}  alpha ${f(ss.alpha)}`);
  }

  /*
   * Control. The same number of levels, born at the same moments, alive for
   * the same length of time, carrying the same implied direction — but at a
   * price drawn at random near the close instead of at the defended price.
   * If this scores the same, the absorption candle contributed nothing and all
   * that is being measured is the reading policy plus the direction adjustment.
   */
  const SEEDS = [778899, 121212, 313131, 606060, 909090];
  const runCtl = (label, make) => {
    const as = [], ns = [];
    for (const seed of SEEDS) {
      const r = rng(seed);
      const c = lv.map(L => make(L, r)).sort((a, b) => a.visibleAt - b.visibleAt);
      const s2 = score(apply(multiEvents(c), reading), TP, SL, MAXH, 40000);
      as.push(s2.alpha); ns.push(s2.n);
    }
    const mu = as.reduce((a, b) => a + b, 0) / as.length;
    const sd = Math.sqrt(as.reduce((a, b) => a + (b - mu) ** 2, 0) / (as.length - 1));
    console.log(`  ${label.padEnd(34)} n ~${String(Math.round(ns.reduce((a, b) => a + b, 0) / ns.length)).padStart(5)}  alpha ${f(mu)} ± ${f0(sd)}   (${SEEDS.length} draws)`);
    return mu;
  };
  const randPx = (L, r) => { const i = L.visibleAt, a = atr1[i] || 1; return { ...L, price: bars[i].c + (r() * 2 - 1) * a * 6 }; };
  runCtl('CONTROL random price, real side', randPx);
  runCtl('CONTROL real price, scrambled side', (L, r) => ({ ...L, dir0: r() < 0.5 ? 1 : -1 }));
  const floor = runCtl('CONTROL random price AND side', (L, r) => ({ ...randPx(L, r), dir0: r() < 0.5 ? 1 : -1 }));
  console.log(`  attributable to the absorption candle: ${f(s.alpha - floor)} points per trade`);

  /*
   * Honest error bar. These trades overlap heavily — a 1440 bar hold with
   * thousands of entries means dozens are open at once — so the ordinary
   * standard error over n trades is far too small. Resample whole calendar
   * days with replacement instead, which keeps trades that share the same
   * market move together.
   */
  const byDay = new Map();
  for (const e of ev) {
    const k = Math.floor(bars[e.i].t / 86400000);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(e);
  }
  const days = [...byDay.values()];
  const BL = blind(1, TP, SL, MAXH), BS = blind(-1, TP, SL, MAXH);
  const pnl = new Map();
  for (const e of ev) {
    const p = race(e.i, e.dir, TP, SL, MAXH);
    if (p !== null) pnl.set(e, p - (e.dir === 1 ? BL : BS));
  }
  const r3 = rng(555001);
  const boot = [];
  for (let b = 0; b < 2000; b++) {
    let s2 = 0, c2 = 0;
    for (let k = 0; k < days.length; k++) {
      for (const e of days[Math.floor(r3() * days.length)]) {
        const p = pnl.get(e);
        if (p !== undefined) { s2 += p; c2++; }
      }
    }
    if (c2) boot.push(s2 / c2);
  }
  boot.sort((a, b) => a - b);
  console.log(`  day-block bootstrap over ${days.length} trading days: alpha 5th ${f(boot[Math.floor(0.05 * boot.length)])}  50th ${f(boot[Math.floor(0.5 * boot.length)])}  95th ${f(boot[Math.floor(0.95 * boot.length)])}`);
  const share = boot.filter(v => v > 0).length / boot.length;
  console.log(`  share of bootstrap samples above zero: ${(100 * share).toFixed(1)}%`);
}

/*
 * Variants, each next to its own control.
 *
 * The control that matters is not the blind entry, it is the SAME event
 * detector run on levels placed at random with a random defended side. That
 * measures what the rejection-and-bounce machinery earns on its own. Anything
 * a real absorption level is worth has to show up as the gap between the two
 * columns, and that gap is the only number worth optimising.
 */
function modeVariants(opt = {}) {
  const TP = opt.tp ?? 120, SL = opt.sl ?? 120, MAXH = opt.hold ?? 1440;
  const reading = opt.reading ?? 'polarity';
  const list = opt.variants ?? [
    ['vol>=.90 prog<=.30  extreme', 1, { sel: [['vol', '>=', 0.90], ['prog', '<=', 0.30]], priceMode: 'extreme' }],
    ['vol>=.95 prog<=.20  extreme', 1, { sel: [['vol', '>=', 0.95], ['prog', '<=', 0.20]], priceMode: 'extreme' }],
    ['vol>=.98 prog<=.15  extreme', 1, { sel: [['vol', '>=', 0.98], ['prog', '<=', 0.15]], priceMode: 'extreme' }],
    ['vol>=.85 body<=.20  extreme', 1, { sel: [['vol', '>=', 0.85], ['body', '<=', 0.20]], priceMode: 'extreme' }],
    ['prog<=.30 only      extreme', 1, { sel: [['prog', '<=', 0.30]], priceMode: 'extreme' }],
    ['vol>=.90 only       extreme', 1, { sel: [['vol', '>=', 0.90]], priceMode: 'extreme' }],
    ['vpr>=.95            extreme', 1, { sel: [['vpr', '>=', 0.95]], priceMode: 'extreme' }],
    ['5m vol>=.90 prog<=.30      ', 5, { sel: [['vol', '>=', 0.90], ['prog', '<=', 0.30]], priceMode: 'extreme' }],
    ['15m vol>=.90 prog<=.30     ', 15, { sel: [['vol', '>=', 0.90], ['prog', '<=', 0.30]], priceMode: 'extreme' }],
    ['1H vol>=.90 prog<=.30      ', 60, { sel: [['vol', '>=', 0.90], ['prog', '<=', 0.30]], priceMode: 'extreme' }],
  ];
  console.log(`variants at TP ${TP} / SL ${SL} / hold ${MAXH}, reading ${reading}`);
  console.log(`blind long ${f(blind(1, TP, SL, MAXH))}  blind short ${f(blind(-1, TP, SL, MAXH))}\n`);
  console.log('variant'.padEnd(30) + 'lv'.padStart(7) + 'n'.padStart(7) + 'resp%'.padStart(7) + 'ctlResp'.padStart(8) + 'alpha'.padStart(9) + 'control'.padStart(13) + 'gap'.padStart(9));
  for (const [name, m, cfg] of list) {
    const lv = absorption(m, { ...cfg, ...(opt.evOpts ? {} : {}) });
    if (lv.length < 5) { console.log(name.padEnd(30) + String(lv.length).padStart(7)); continue; }
    const all = multiEvents(lv, opt.evOpts || {});
    const ev = apply(all, reading);
    if (ev.length < 60) { console.log(name.padEnd(30) + String(lv.length).padStart(7) + String(ev.length).padStart(7)); continue; }
    const s = score(ev, TP, SL, MAXH, 40000);
    // The control is itself noisy, so average several draws before believing the gap.
    const cAlphas = [], cResp = [];
    for (const seed of (opt.seeds ?? [778899, 121212, 313131, 606060, 909090])) {
      const r = rng(seed);
      const ctl = lv.map(L => {
        const i = L.visibleAt, a = atr1[i] || 1;
        return { ...L, price: bars[i].c + (r() * 2 - 1) * a * 6, dir0: r() < 0.5 ? 1 : -1 };
      }).sort((a, b) => a.visibleAt - b.visibleAt);
      const cAll = multiEvents(ctl, opt.evOpts || {});
      cAlphas.push(score(apply(cAll, reading), TP, SL, MAXH, 40000).alpha);
      cResp.push(respectRate(cAll).respect);
    }
    const cMean = cAlphas.reduce((a, b) => a + b, 0) / cAlphas.length;
    const cSd = Math.sqrt(cAlphas.reduce((a, b) => a + (b - cMean) ** 2, 0) / Math.max(1, cAlphas.length - 1));
    const rMean = cResp.reduce((a, b) => a + b, 0) / cResp.length;
    console.log(name.padEnd(30) + String(lv.length).padStart(7) + String(s.n).padStart(7) +
      f0(respectRate(all).respect).padStart(7) + f0(rMean).padStart(8) + f(s.alpha).padStart(9) +
      (f(cMean) + '±' + f0(cSd)).padStart(13) + f(s.alpha - cMean).padStart(9));
  }
}

/*
 * Robustness of the machinery rather than the idea: how much of the result
 * depends on the arbitrary constants in the event detector — how close price
 * has to come, how far away it must have been, how long a level lives, how
 * many may be watched at once.
 */
function modeRobust(opt = {}) {
  const cfg = findCfg(opt.cfg ?? 'effortNoResult2/extreme');
  const m = opt.tf ?? 1, reading = opt.reading ?? 'defence';
  const TP = opt.tp ?? 120, SL = opt.sl ?? 120, MAXH = opt.hold ?? 1440;
  const rows = [
    ['as chosen', {}, {}],
    ['tolAtr 0.10', { tolAtr: 0.10 }, {}],
    ['tolAtr 0.35', { tolAtr: 0.35 }, {}],
    ['approachAtr 1.0', { approachAtr: 1.0 }, {}],
    ['approachAtr 2.5', { approachAtr: 2.5 }, {}],
    ['resetAtr 2.0', { resetAtr: 2.0 }, {}],
    ['maxPool 8', { maxPool: 8 }, {}],
    ['maxPool 60', { maxPool: 60 }, {}],
    ['dedupeAtr 0.0', { dedupeAtr: 0 }, {}],
    ['dedupeAtr 1.0', { dedupeAtr: 1.0 }, {}],
    ['level lives 360m', {}, { ageMin: 360 }],
    ['level lives 4320m', {}, { ageMin: 4320 }],
    ['rank window 120', {}, { look: 120 }],
    ['rank window 500', {}, { look: 500 }],
  ];
  console.log(`robustness — ${TF_NAME[m]}, ${reading}, ${TP}/${SL}/${MAXH}\n`);
  console.log('setting'.padEnd(22) + 'levels'.padStart(8) + 'trades'.padStart(8) + 'resp%'.padStart(8) + 'alpha'.padStart(9));
  for (const [name, ev0, cf0] of rows) {
    const lv = absorption(m, { ...cfg, ...cf0 });
    const all = multiEvents(lv, ev0);
    const ev = apply(all, reading);
    if (ev.length < 60) { console.log(name.padEnd(22) + String(lv.length).padStart(8) + String(ev.length).padStart(8)); continue; }
    const s = score(ev, TP, SL, MAXH, 40000);
    console.log(name.padEnd(22) + String(lv.length).padStart(8) + String(s.n).padStart(8) +
      f0(respectRate(all).respect).padStart(8) + f(s.alpha).padStart(9));
  }
}

/* causality: publication one candle earlier must help, one later must hurt */
function modeLag(opt = {}) {
  const cfg = findCfg(opt.cfg ?? 'volSmallRange/extreme');
  const m = opt.tf ?? 15, reading = opt.reading ?? 'bounce';
  const TP = opt.tp ?? 18, SL = opt.sl ?? 24, MAXH = opt.hold ?? 360;
  console.log(`causality check — ${TF_NAME[m]}, ${reading}, ${TP}/${SL}/${MAXH}`);
  console.log('  publishLag -1 uses the candle before it closed (a lookahead bug on purpose).\n');
  for (const lag of [-1, 0, 1, 2, 4]) {
    const ev = apply(multiEvents(absorption(m, { ...cfg, publishLag: lag })), reading);
    if (!ev.length) { console.log(`  lag ${String(lag).padStart(2)}   none`); continue; }
    const s = score(ev, TP, SL, MAXH, 40000);
    console.log(`  lag ${String(lag).padStart(2)}   n ${String(s.n).padStart(5)}   alpha ${f(s.alpha)}`);
  }
}

/* THE CHOSEN CONSTRUCTION — everything the result depends on, in one place. */
const CHOSEN = {
  timeframe: 1,                                       // 1m candles
  sel: [['vol', '>=', 0.90], ['prog', '<=', 0.30]],   // ranks over the previous 250 candles
  look: 250,
  priceMode: 'extreme',                               // the extreme facing the close
  ageMin: 1440,                                       // a level is watched for one day
  reading: 'defence',                                 // bet on the defence when price arrives at it
  tp: 120, sl: 120, hold: 1440,                       // points, points, minutes
};

/* before and after, in one run */
function modeReport() {
  console.log('ABSORPTION — heavy volume that barely moved price');
  console.log(`${N.toLocaleString()} XAUUSD 1m candles, ${new Date(bars[0].t).toISOString().slice(0, 10)} to ${new Date(bars[N - 1].t).toISOString().slice(0, 10)}`);
  console.log(`cost ${COST} points per round trip, 1 point = 0.10 USD, random level respect ${RANDOM_RESPECT}%\n`);
  console.log('─── BEFORE — tools/levels.js absorptionLevels, scored exactly as tools/sweep_timeframes.js does ───\n');
  modeCurrent();
  console.log('\n\n─── AFTER — the construction in this file ───\n');
  console.log(`  built on ${TF_NAME[CHOSEN.timeframe]} candles`);
  console.log(`  a candle qualifies when its volume ranks in the top 10% and its |close-open|`);
  console.log(`  in the bottom 30% of the previous ${CHOSEN.look} candles`);
  console.log(`  the level is the extreme facing the close (close in the upper half -> the low)`);
  console.log(`  published on the next candle, watched for ${CHOSEN.ageMin} minutes as a fixed price`);
  console.log(`  traded when price arrives from the side the candle defended, betting on the defence`);
  console.log(`  target ${CHOSEN.tp} / stop ${CHOSEN.sl} / hold ${CHOSEN.hold}\n`);
  modeFinal({ cfg: 'effortNoResult2/extreme', tf: CHOSEN.timeframe, reading: CHOSEN.reading, tp: CHOSEN.tp, sl: CHOSEN.sl, hold: CHOSEN.hold });
}

const MODE = process.argv[2] || 'current';
const ARG = JSON.parse(process.argv[3] || '{}');
if (MODE === 'diag') modeDiag();
else if (MODE === 'current') modeCurrent(ARG);
else if (MODE === 'sweep') modeSweep(ARG);
else if (MODE === 'excursion') modeExcursion(ARG.cfg ?? 'volSmallRange/extreme', ARG.tfs ?? [15, 60, 240]);
else if (MODE === 'tune') modeTune(ARG.cfg ?? 'volSmallRange/extreme', ARG.tf ?? 15, ARG.reading ?? 'bounce', ARG);
else if (MODE === 'final') modeFinal(ARG);
else if (MODE === 'variants') modeVariants(ARG);
else if (MODE === 'robust') modeRobust(ARG);
else if (MODE === 'lag') modeLag(ARG);
else if (MODE === 'report') modeReport();
else console.log('modes: report diag current sweep excursion tune variants robust final lag');

module.exports = { CHOSEN, absorption, multiEvents, apply, score, excursion, loadBars, SEL };
