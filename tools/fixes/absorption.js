'use strict';
/*
 * Absorption — heavy volume that barely moved price.
 * ==================================================
 *
 * The idea: a candle where a lot of size changed hands and price went nowhere
 * is a candle where somebody's resting order ate the flow. The price they
 * defended should matter later.
 *
 * What was wrong with the existing construction (tools/levels.js
 * absorptionLevels):
 *
 *   1. The line is `the nearest pooled absorption midpoint to the close`. That
 *      value changes whenever price moves past one level towards another, so
 *      the series is a step function trailing price, not a level. The event
 *      detector in tools/level_events.js then resets its state every time the
 *      series jumps, which throws away the approach it had accumulated.
 *   2. The defended price is taken as the candle midpoint. Absorption is
 *      one-sided: somebody bid, or somebody offered. The midpoint is neither
 *      of the two prices that were actually held.
 *   3. Volume is compared against a percentile of a trailing window, but the
 *      range condition uses a percentile of the same window, so on a quiet
 *      stretch every ordinary candle passes and on a violent stretch nothing
 *      does. A ratio to the window's own mean is the stable version.
 *   4. Direction was left to the generic engine, which trades a rejection as a
 *      bounce whichever side it came from. A defended level has a side.
 *   5. Everything was scored at a 90 point target and a 90 point stop.
 *
 * This file rebuilds the level as a set of fixed prices, each watched
 * independently, sweeps the timeframe it is built on, measures the excursion
 * the level actually produces, and scores every reading of the test (bounce,
 * break, and both reversed) direction-adjusted against the blind baselines for
 * the same target and stop.
 *
 * Causality: an absorption candle on an `m` minute chart is only complete at
 * the end of that candle, so the level it defines is published to the 1m stream
 * at the first 1m bar of the FOLLOWING m-minute candle — exactly what
 * E.projectConfirmed does for a series. Mode `lag` verifies this by shifting
 * publication forwards and backwards and showing the result degrades one way
 * and improves the other.
 *
 * Usage:
 *   node --max-old-space-size=3500 tools/fixes/absorption.js current
 *   node --max-old-space-size=3500 tools/fixes/absorption.js sweep
 *   node --max-old-space-size=3500 tools/fixes/absorption.js excursion
 *   node --max-old-space-size=3500 tools/fixes/absorption.js tune
 *   node --max-old-space-size=3500 tools/fixes/absorption.js final
 *   node --max-old-space-size=3500 tools/fixes/absorption.js lag
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
function absorption(minutes, cfg = {}) {
  const look = cfg.look ?? 60;
  const volMult = cfg.volMult ?? 1.8;     // 0 disables the volume condition
  const rngMult = cfg.rngMult ?? 0.8;     // Infinity disables the range condition
  const effMult = cfg.effMult ?? 0;       // relVol / relRange, 0 disables
  const vprMult = cfg.vprMult ?? 0;       // volume per point of range, vs its own trailing mean
  const progMult = cfg.progMult ?? Infinity; // |close-open| / mean range: effort without result
  const priceMode = cfg.priceMode ?? 'extreme';
  const ageMin = cfg.ageMin ?? Math.max(1440, minutes * 40);
  const publishLag = cfg.publishLag ?? 0; // extra higher-timeframe candles of delay (mode `lag`)

  const { bars: hb, firstAt } = TF.get(minutes);
  const n = hb.length;
  const out = [];
  if (n < look + 3) return out;

  // Prefix sums for the trailing means.
  const cv = new Float64Array(n + 1), cr = new Float64Array(n + 1), cp = new Float64Array(n + 1);
  for (let j = 0; j < n; j++) {
    const rg = hb[j].h - hb[j].l;
    cv[j + 1] = cv[j] + (Number.isFinite(hb[j].v) ? hb[j].v : 0);
    cr[j + 1] = cr[j] + rg;
    cp[j + 1] = cp[j] + (rg > 0 ? (Number.isFinite(hb[j].v) ? hb[j].v : 0) / rg : 0);
  }

  for (let j = look; j < n - 1; j++) {
    const b = hb[j];
    const range = b.h - b.l;
    if (!(range > 0)) continue;
    const mv = (cv[j] - cv[j - look]) / look;
    const mr = (cr[j] - cr[j - look]) / look;
    const mp = (cp[j] - cp[j - look]) / look;
    if (!(mr > 0)) continue;
    const v = Number.isFinite(b.v) ? b.v : 0;
    const relVol = mv > 0 ? v / mv : 0;
    const relRng = range / mr;
    const relVpr = mp > 0 ? (v / range) / mp : 0;
    const relProg = Math.abs(b.c - b.o) / mr;

    if (volMult > 0 && !(relVol >= volMult)) continue;
    if (Number.isFinite(rngMult) && !(relRng <= rngMult)) continue;
    if (effMult > 0 && !(relVol / relRng >= effMult)) continue;
    if (vprMult > 0 && !(relVpr >= vprMult)) continue;
    if (Number.isFinite(progMult) && !(relProg <= progMult)) continue;
    if (cfg.bodyMax != null && !(Math.abs(b.c - b.o) / range <= cfg.bodyMax)) continue;

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
    out.push({ price: px, dir0, visibleAt, expire: visibleAt + ageMin, relVol, relRng, relVpr, relProg, htf: j });
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
function modeCurrent() {
  console.log(`bars ${N.toLocaleString()}   blind long ${f(blind(1, 90, 90, 1440))}  blind short ${f(blind(-1, 90, 90, 1440))}   (target 90 / stop 90 / hold 1440)`);
  console.log('\nCURRENT construction: LV.absorptionLevels — nearest pooled midpoint to the close\n');
  console.log('tf'.padEnd(6) + 'tests'.padStart(8) + 'respect%'.padStart(10) + 'short%'.padStart(9) + 'raw'.padStart(9) + 'alpha'.padStart(9));
  for (const m of TIMEFRAMES) {
    const { bars: hb, index, atr } = TF.get(m);
    let line;
    try { line = LV.absorptionLevels(hb, { atr, look: 120 }).line; } catch (err) { console.log(TF_NAME[m].padEnd(6) + '  error'); continue; }
    const proj = m === 1 ? line : E.projectConfirmed(line, index);
    const ev = levelTestEvents(bars, proj, atr1);
    const r = respectRate(ev);
    const s = score(ev, 90, 90, 1440);
    console.log(TF_NAME[m].padEnd(6) + String(r.tests).padStart(8) + f0(r.respect).padStart(10) +
      f0(100 * s.shorts / Math.max(1, s.n)).padStart(9) + f(s.raw).padStart(9) + f(s.alpha).padStart(9));
  }
}

const SWEEP_CFGS = [
  ['vol1.8 rng0.8 extreme', { volMult: 1.8, rngMult: 0.8, priceMode: 'extreme' }],
  ['vol1.8 rng0.8 mid    ', { volMult: 1.8, rngMult: 0.8, priceMode: 'mid' }],
  ['vol1.8 rng0.8 close  ', { volMult: 1.8, rngMult: 0.8, priceMode: 'close' }],
  ['vol1.8 rng0.8 wick   ', { volMult: 1.8, rngMult: 0.8, priceMode: 'wick' }],
  ['vol1.8 rng0.8 arrival', { volMult: 1.8, rngMult: 0.8, priceMode: 'arrival' }],
  ['vol2.5 rng0.7 extreme', { volMult: 2.5, rngMult: 0.7, priceMode: 'extreme' }],
  ['eff  3.0      extreme', { volMult: 0, rngMult: Infinity, effMult: 3.0, priceMode: 'extreme' }],
  ['range only 0.5 (no v)', { volMult: 0, rngMult: 0.5, priceMode: 'extreme' }],
  ['range only 0.35(no v)', { volMult: 0, rngMult: 0.35, priceMode: 'extreme' }],
];

function modeSweep() {
  const readings = ['engine', 'bounce', 'bounceRev', 'breakGo', 'breakRev', 'polarity', 'contra'];
  console.log(`blind long ${f(blind(1, 90, 90, 1440))}  blind short ${f(blind(-1, 90, 90, 1440))}   target 90 / stop 90 / hold 1440`);
  console.log('alpha = direction-adjusted points per trade. n<100 shown in brackets.\n');
  for (const [name, cfg] of SWEEP_CFGS) {
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
        const s = score(sub, 90, 90, 1440, 40000);
        const txt = `${f(s.alpha)}/${s.n}`;
        return (sub.length >= 100 ? txt : `[${txt}]`).padStart(12);
      });
      console.log('  ' + TF_NAME[m].padEnd(5) + String(lv.length).padStart(7) + String(r.tests).padStart(7) + f0(r.respect).padStart(7) + cells.join(''));
    }
  }
}

/* what travel does a test of this level actually produce? */
function modeExcursion(cfgName, tfList) {
  const cfg = SWEEP_CFGS.find(c => c[0].trim().startsWith(cfgName))[1];
  console.log(`excursion after a test — ${cfgName}\n`);
  for (const m of tfList) {
    const ev = multiEvents(absorption(m, cfg));
    for (const rd of ['bounce', 'bounceRev', 'breakGo', 'breakRev']) {
      const sub = apply(ev, rd);
      if (sub.length < 60) continue;
      for (const H of [120, 360, 1440]) {
        const x = excursion(sub, H);
        console.log(`  ${TF_NAME[m].padEnd(4)} ${rd.padEnd(10)} hold ${String(H).padStart(4)}  n=${String(x.n).padStart(5)}  MFE p25/50/75 ${f0(x.mfe25).padStart(6)}/${f0(x.mfe50).padStart(6)}/${f0(x.mfe75).padStart(6)}   MAE p50/75/90 ${f0(x.mae50).padStart(6)}/${f0(x.mae75).padStart(6)}/${f0(x.mae90).padStart(6)}`);
      }
    }
  }
}

/* size the target and the stop to the travel that is really there */
function modeTune(cfgName, m, reading) {
  const cfg = SWEEP_CFGS.find(c => c[0].trim().startsWith(cfgName))[1];
  const ev = apply(multiEvents(absorption(m, cfg)), reading);
  console.log(`${cfgName} on ${TF_NAME[m]}, reading ${reading}, ${ev.length} trades\n`);
  const TH = [6, 10, 14, 18, 24, 30, 40, 55, 75, 90];
  for (const MAXH of [120, 360, 1440]) {
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
  const cfgName = opt.cfg ?? 'vol1.8 rng0.8 extreme';
  const cfg = SWEEP_CFGS.find(c => c[0].trim().startsWith(cfgName.trim()))[1];
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

  // control: the same number of levels at random prices, same lifetimes
  const r2 = rng(90210);
  const ctrl = lv.map(L => {
    const i = L.visibleAt;
    const a = atr1[i] || 1;
    return { ...L, price: bars[i].c + (r2() * 2 - 1) * a * 6 };
  }).sort((a, b) => a.visibleAt - b.visibleAt);
  const cev = apply(multiEvents(ctrl), reading);
  const cs = score(cev, TP, SL, MAXH, 40000);
  console.log(`  RANDOM levels, same count/lifetime: n ${cs.n}  respect ${f0(respectRate(multiEvents(ctrl)).respect)}%  alpha ${f(cs.alpha)}`);
}

/* causality: publication one candle earlier must help, one later must hurt */
function modeLag(opt = {}) {
  const cfg = SWEEP_CFGS.find(c => c[0].trim().startsWith((opt.cfg ?? 'vol1.8 rng0.8 extreme').trim()))[1];
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

const MODE = process.argv[2] || 'current';
const ARG = JSON.parse(process.argv[3] || '{}');
if (MODE === 'diag') modeDiag();
else if (MODE === 'current') modeCurrent();
else if (MODE === 'sweep') modeSweep();
else if (MODE === 'excursion') modeExcursion(ARG.cfg ?? 'vol1.8 rng0.8 extreme', ARG.tfs ?? [15, 60, 240]);
else if (MODE === 'tune') modeTune(ARG.cfg ?? 'vol1.8 rng0.8 extreme', ARG.tf ?? 15, ARG.reading ?? 'bounce');
else if (MODE === 'final') modeFinal(ARG);
else if (MODE === 'lag') modeLag(ARG);
else console.log('modes: current sweep excursion tune final lag');

module.exports = { absorption, multiEvents, apply, score, excursion, loadBars };
