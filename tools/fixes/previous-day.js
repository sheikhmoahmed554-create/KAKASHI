'use strict';
/*
 * Previous day high / low / close on XAUUSD — rebuilt from the definition up.
 *
 * WHAT WAS WRONG WITH THE OLD CONSTRUCTION
 *
 *   tools/levels.js:previousDayLevels walks the three values and returns
 *   whichever is nearest to the current close:
 *
 *       for (const px of [prev.h, prev.l, prev.c]) { ... nearest to bars[i].c }
 *
 *   That is not a level. It is a selector that re-points at whatever price is
 *   already closest to, so the series jumps between three prices as price
 *   drifts, and the jump happens precisely when price is midway between two of
 *   them — i.e. as far from any of them as it can be. tools/level_events.js
 *   treats a value change of more than half an ATR as a brand new level and
 *   wipes its approach/lock state, so the switching also destroys the very
 *   memory the engine needs. Two thirds of what it measured was the selector
 *   moving, not price arriving.
 *
 *   Yesterday's high is a constant for the whole of today. So is yesterday's
 *   low, and so is yesterday's close. They are three different objects with
 *   three different meanings and they must be watched separately, each as a
 *   fixed number, each tested one at a time.
 *
 * WHAT WAS FOUND — including the part that does not flatter the idea
 *
 *   1. THE THREE ARE NOT RESPECTED. Separated, fixed, and tested one at a
 *      time, yesterday's high is respected 65.1% of the time, the low 67.6%
 *      and the close 65.5%, against a random-price baseline of 68.95%. That
 *      holds at every timeframe from 5m to weekly and at every tolerance from
 *      $0.20 to $1.50. Widening the tolerance raises respect, but it raises it
 *      for shadow levels just as much. As a place where price turns, these
 *      three carry nothing.
 *
 *   2. THE AXIS THAT MATTERS IS WHICH SIDE PRICE ARRIVES FROM, not which of
 *      the three it is. Yesterday's high approached from BELOW (price still
 *      inside yesterday's range) loses; approached from ABOVE (price has left
 *      the range and comes back down to it) wins, and yesterday's low mirrors
 *      it. Pooling those two — the broken extreme retested from the far side —
 *      is the only cell in the whole grid that pays.
 *
 *   3. 90/90 IS NOT TOO WIDE HERE, IT IS FAR TOO NARROW. Gold's median daily
 *      range over this sample is 1,112 points. A test of a DAILY level
 *      produces median favourable travel of 180-350 points and median adverse
 *      travel of 130-500 within four hours. A 90 point bracket is $9 in a
 *      market that moves $111 a day, so it is resolved by noise within
 *      minutes. Every 90/90 number in the older tables is a coin toss, which
 *      is exactly why they all sit on their blind baselines. Sized to the
 *      travel, at 250/250 over 960 minutes, the same events give +51.4.
 *
 *   4. AND THE UNCOMFORTABLE PART. `matched` shifts the entry away from the
 *      moment of the retest, holding the day and the direction fixed. If the
 *      level were doing the work, alpha would peak at the retest and fall away
 *      on both sides. It does not: entering two hours EARLIER scores +77.3
 *      against the retest's +51.4, and a random minute of the same day in the
 *      same direction averages +38.3 (z of the retest over it = +1.0). The
 *      retest moment is worth little. What pays is being positioned on those
 *      days in that direction — and the direction comes from which side of
 *      yesterday's range price is on.
 *
 *      So the previous day's high and low are not a level. They are a
 *      BOUNDARY: while price is beyond one of them, leaning that way pays.
 *      `state` measures that directly and it is positive (+21.8 over 1,075
 *      hourly observations, t 2.89) — but it is not specific to yesterday.
 *      The range from three days ago scores +17.6 and from five days ago
 *      +30.7. The mechanism is a multi-day breakout state, and yesterday's
 *      range is one instance of it rather than the source of it.
 *
 *   The number reported for this level is therefore the number the chosen
 *   construction earned, with the attribution stated plainly: it is trend
 *   state, not level respect, and the level-specific increment over a
 *   same-day, same-direction random entry is not statistically significant.
 *
 * STAGES   node --max-old-space-size=3500 tools/fixes/previous-day.js <stage>
 *
 *   probe      data facts: session structure, ATR, blind baselines
 *   current    the old nearest-of-three selector, direction-adjusted
 *   split      the three levels separated, at the sweep's own settings
 *   tfsweep    previous-bar H/L/C across 1m 5m 15m 1H 4H D W
 *   detect     detector geometry: tolerance / approach / break width
 *   matched    THE DECIDING TEST: is it the level, or just the day + direction?
 *   state      the range read as a boundary rather than as a level
 *   stats      overlap, block bootstrap, and the shadow null distribution
 *   excursion  the travel a test actually produces (this sizes the target)
 *   asym       signed travel by cell — decides bounce vs break
 *   target     target/stop/hold grid on the surviving cells
 *   decay      does the level fade through the session? which touch pays?
 *   control    shadow levels built from the same day, not at the extreme
 *   verify     causality: prefix reproduction and entry timing
 *   final      the chosen configuration, stated so it can be reimplemented
 *   robust     bootstrap, monthly split, walk-forward, neighbourhood, cost
 *
 * CAUSALITY
 *   A level from bucket k-1 is published on the first 1m bar of bucket k, which
 *   is strictly after bucket k-1 closed. The bucket aggregate is built by a
 *   forward scan that never reads a bar it has not reached. An event at 1m bar
 *   i reads bars[i], bars[i-1].c and atr[i] only, and entry is the close of bar
 *   i. `verify` re-runs the whole pipeline on prefixes of the data and checks
 *   the events inside the prefix are identical.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('../ai963_engine');
const LV = require('../levels');
const { levelTestEvents, respectRate } = require('../level_events');

// ── constants, identical to tools/sweep_timeframes.js ────────────────────────
const PU = 0.10;            // 1 point = 0.10 USD
const COST = 0.5;           // points, round trip
const TP0 = 90, SL0 = 90;   // the legacy target everything was forced onto
const MAX_HOLD = 1440;
const RANDOM_RESPECT = 68.95;
const TF_NAME = { 1: '1m', 5: '5m', 15: '15m', 60: '1H', 240: '4H', 1440: 'D', 10080: 'W' };

// ── data ─────────────────────────────────────────────────────────────────────
function loadBars() {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'KAKASHI_V16_TV_PARITY_AUDIT.html'), 'utf8');
  const csv = zlib.gunzipSync(Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1], 'base64')).toString('utf8');
  const lines = csv.split('\n');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const a = lines[i].split(',');
    const t = Date.parse(a[0].replace(' ', 'T'));
    const c = +a[4];
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
    out.push({ t, o: +a[1], h: +a[2], l: +a[3], c, v: +a[5] });
  }
  return out.sort((x, y) => x.t - y.t);
}

const bars = loadBars();
const N = bars.length;
const atr1 = E.atr(bars, 14);

const TF = new Map();
function tf(m) {
  if (!TF.has(m)) {
    const { bars: b, index } = E.resample(bars, m);
    const lastOf = new Array(b.length).fill(-1);
    for (let i = 0; i < index.length; i++) if (index[i] >= 0) lastOf[index[i]] = i;
    TF.set(m, { bars: b, index, lastOf, atr: E.atr(b, 14) });
  }
  return TF.get(m);
}

// ── trade simulation (line-for-line the sweep's, with the target opened up) ──
function race(i, dir, tp, sl, maxHold) {
  const e = bars[i].c;
  const t = e + dir * tp * PU, s = e - dir * sl * PU;
  const end = Math.min(N - 1, i + maxHold);
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    const ht = dir === 1 ? b.h >= t : b.l <= t;
    const hs = dir === 1 ? b.l <= s : b.h >= s;
    if (ht && hs) return null;            // resolved inside one candle — unknowable
    if (ht) return tp - COST;
    if (hs) return -sl - COST;
  }
  return (bars[end].c - e) * dir / PU - COST;
}

/** Same race, but it also says when the position closed. */
function raceExit(i, dir, tp, sl, maxHold) {
  const e = bars[i].c;
  const t = e + dir * tp * PU, s = e - dir * sl * PU;
  const end = Math.min(N - 1, i + maxHold);
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    const ht = dir === 1 ? b.h >= t : b.l <= t;
    const hs = dir === 1 ? b.l <= s : b.h >= s;
    if (ht && hs) return { pnl: null, exit: j };
    if (ht) return { pnl: tp - COST, exit: j };
    if (hs) return { pnl: -sl - COST, exit: j };
  }
  return { pnl: (bars[end].c - e) * dir / PU - COST, exit: end };
}

/**
 * One position at a time. A 960-minute hold means events overlap heavily, and
 * 166 overlapping trades are nothing like 166 independent observations. This is
 * the sequence a single account could actually have traded.
 */
function serialise(events, tp, sl, hold) {
  const out = [];
  let free = -1;
  for (const e of events.slice().sort((a, b) => a.i - b.i)) {
    if (e.i <= free) continue;
    const r = raceExit(e.i, e.dir, tp, sl, hold);
    free = r.exit;
    out.push(e);
  }
  return out;
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
 * The blind baseline for this exact target / stop / hold. It has to be
 * recomputed for every target size: -4.8 and +4.3 are the 90/90 numbers and
 * mean nothing at 25/25.
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
  const adj = [];
  for (const e of events) {
    const p = race(e.i, e.dir, tp, sl, maxHold);
    if (p === null) continue;
    if (p > 0) wins++;
    if (e.dir === 1) { ln++; lnet += p; adj.push(p - BL); }
    else { sn++; snet += p; adj.push(p - BS); }
  }
  const tot = ln + sn;
  const la = ln ? lnet / ln - BL : 0;
  const sa = sn ? snet / sn - BS : 0;
  const alpha = tot ? (la * ln + sa * sn) / tot : NaN;
  let sd = NaN, t = NaN;
  if (tot > 2) {
    let v = 0; for (const x of adj) v += (x - alpha) * (x - alpha);
    sd = Math.sqrt(v / (tot - 1));
    t = alpha / (sd / Math.sqrt(tot));
  }
  return {
    ...respectRate(events),
    traded: tot, longs: ln, shorts: sn,
    shortShare: tot ? (100 * sn) / tot : NaN,
    winRate: tot ? (100 * wins) / tot : NaN,
    raw: tot ? (lnet + snet) / tot : NaN,
    alpha, sd, t,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  THE GENERATOR
//
//  A period's high, low, close, open or a fraction of its range, published on
//  the first 1m bar of the NEXT period and held fixed for the whole of it.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
// Epoch day 0 is a Thursday; Monday 5 Jan 1970 is +4 days. Weekly buckets are
// anchored there so a "week" is Mon-Fri, not Thu-Wed.
const WEEK_ANCHOR = 4 * DAY_MS;

/** Bucket key for bar time t. `minutes` 10080 means Monday-anchored weeks. */
function bucketKey(t, minutes, offsetMs) {
  if (minutes === 10080) return Math.floor((t - WEEK_ANCHOR - offsetMs) / WEEK_MS);
  return Math.floor((t - offsetMs) / (minutes * 60000));
}

/**
 * Forward scan producing, for each bucket, its 1m span and its OHLC. Nothing
 * here reads ahead: a bucket is closed the moment a bar with a different key
 * arrives.
 */
const BUCKETS = new Map();
function buckets(minutes, offsetMs = 0) {
  const key = `${minutes}|${offsetMs}`;
  if (BUCKETS.has(key)) return BUCKETS.get(key);
  const out = [];
  let cur = null;
  for (let i = 0; i < N; i++) {
    const k = bucketKey(bars[i].t, minutes, offsetMs);
    if (!cur || cur.k !== k) {
      if (cur) out.push(cur);
      cur = { k, a: i, b: i, o: bars[i].o, h: bars[i].h, l: bars[i].l, c: bars[i].c };
    } else {
      cur.b = i;
      if (bars[i].h > cur.h) cur.h = bars[i].h;
      if (bars[i].l < cur.l) cur.l = bars[i].l;
      cur.c = bars[i].c;
    }
  }
  if (cur) out.push(cur);
  BUCKETS.set(key, out);
  return out;
}

/** Pull one named value out of a closed bucket. `frac` gives range fractions. */
function bucketValue(bk, which) {
  if (which === 'h') return bk.h;
  if (which === 'l') return bk.l;
  if (which === 'c') return bk.c;
  if (which === 'o') return bk.o;
  if (which === 'mid') return (bk.h + bk.l) / 2;
  if (which === 'pp') return (bk.h + bk.l + bk.c) / 3;
  if (typeof which === 'number') return bk.l + (bk.h - bk.l) * which;   // fraction of range
  throw new Error('unknown which ' + which);
}

/**
 * Discrete test events against ONE fixed level value over a 1m index window.
 *
 * Identical semantics to tools/level_events.js:levelTestEvents — price has to
 * have been `approach` away, then arrive within `tol`, then react, and the
 * level locks until price walks `reset` off it. The level-changed reset is
 * removed because a constant cannot change. State is fresh per instance, so
 * yesterday's memory never leaks into today.
 */
function windowEvents(lo, hi, L, o) {
  const ev = [];
  let approached = false, locked = false, touch = 0;
  const start = Math.max(1, lo);
  for (let i = start; i <= hi; i++) {
    const a = atr1[i];
    if (!Number.isFinite(a) || a <= 0) continue;
    const bar = bars[i];
    const tol = o.tolUsd != null ? o.tolUsd : a * o.tolAtr;
    const appr = o.approachUsd != null ? o.approachUsd : a * o.approachAtr;
    const reset = o.resetUsd != null ? o.resetUsd : a * o.resetAtr;
    const brk = o.breakUsd != null ? o.breakUsd : a * o.breakAtr;

    const dist = Math.abs(bar.c - L);
    if (locked && dist > reset) locked = false;
    if (dist >= appr) approached = true;
    if (!approached || locked) continue;

    const fromAbove = bars[i - 1].c > L;
    const reached = fromAbove ? bar.l <= L + tol : bar.h >= L - tol;
    if (!reached) continue;

    let dir = 0, kind = null;
    if (fromAbove) {
      if (bar.c > L + tol * 0.5) { dir = 1; kind = 'reject'; }
      else if (bar.c < L - brk) { dir = -1; kind = 'break'; }
      else continue;
    } else {
      if (bar.c < L - tol * 0.5) { dir = -1; kind = 'reject'; }
      else if (bar.c > L + brk) { dir = 1; kind = 'break'; }
      else continue;
    }
    touch++;
    ev.push({ i, dir, kind, level: L, fromAbove, touch });
    locked = true;
    approached = false;
  }
  return ev;
}

const DEFAULT_DETECT = { tolAtr: 0.20, approachAtr: 1.5, breakAtr: 0.25, resetAtr: 1.0 };

/**
 * Every test of `which` taken from the previous bucket of `minutes`, over the
 * whole sample.
 *
 * opts.carry   how many buckets the level stays alive for (default 1 = today)
 * opts.fromMin / opts.toMin   restrict to a window of minutes into the bucket
 * opts.shift   move the level this many USD off its true value (the control)
 * opts.shiftR  move it this fraction of the previous bucket's range
 */
const EV_CACHE = new Map();
function levelEvents(minutes, which, opts = {}) {
  const o = Object.assign({}, DEFAULT_DETECT, opts);
  const key = JSON.stringify([minutes, which, o]);
  if (EV_CACHE.has(key)) return EV_CACHE.get(key);
  const v = levelEventsRaw(minutes, which, o);
  if (EV_CACHE.size < 600) EV_CACHE.set(key, v);
  return v;
}

function levelEventsRaw(minutes, which, o) {
  const offsetMs = (o.offsetHours || 0) * 3600000;
  const bk = buckets(minutes, offsetMs);
  const carry = o.carry || 1;
  const all = [];
  for (let k = 1; k < bk.length; k++) {
    const src = bk[k - 1];
    let L = bucketValue(src, which);
    if (!Number.isFinite(L)) continue;
    const rng0 = src.h - src.l;
    if (o.shift) L += o.shift;
    if (o.shiftR) L += o.shiftR * rng0;

    const first = bk[k].a;
    const last = bk[Math.min(bk.length - 1, k + carry - 1)].b;
    let lo = first, hi = last;
    if (o.fromMin != null) lo = Math.max(lo, first + o.fromMin);
    if (o.toMin != null) hi = Math.min(hi, first + o.toMin);
    if (hi <= lo) continue;

    for (const e of windowEvents(lo, hi, L, o)) {
      if (e.i < 1 || e.i >= N - 2) continue;
      all.push({
        ...e, which, k,
        mins: e.i - first,                      // minutes into the session
        prevRange: rng0 / PU,                   // previous bucket range, points
        openSide: Math.sign(bars[first].o - L), // did the session open above or below?
      });
    }
  }
  all.sort((x, y) => x.i - y.i);
  return all;
}

/** Two levels cannot honestly be tested by the same 1m candle: keep the nearer. */
function dedupe(events) {
  const s = events.slice().sort((a, b) => a.i - b.i);
  const out = [];
  for (const e of s) {
    const p = out[out.length - 1];
    if (p && p.i === e.i) {
      if (Math.abs(bars[e.i].c - e.level) < Math.abs(bars[p.i].c - p.level)) out[out.length - 1] = e;
      continue;
    }
    out.push(e);
  }
  return out;
}

// ── readings ─────────────────────────────────────────────────────────────────
const bounce = ev => ev.filter(e => e.kind === 'reject');
const brk = ev => ev.filter(e => e.kind === 'break');
const flip = ev => ev.map(e => ({ ...e, dir: -e.dir }));

// ── excursion ────────────────────────────────────────────────────────────────
/** Favourable and adverse travel in points over `horizon` minutes, in e.dir. */
function excursion(events, horizon) {
  const mfe = [], mae = [], end = [];
  for (const e of events) {
    const entry = bars[e.i].c;
    const stop = Math.min(N - 1, e.i + horizon);
    let f = 0, a = 0;
    for (let j = e.i + 1; j <= stop; j++) {
      const hi = (bars[j].h - entry) * e.dir / PU;
      const lo = (bars[j].l - entry) * e.dir / PU;
      const up = e.dir === 1 ? hi : -lo;      // favourable
      const dn = e.dir === 1 ? lo : -hi;      // adverse
      if (up > f) f = up;
      if (dn < a) a = dn;
    }
    mfe.push(f); mae.push(-a);
    end.push((bars[stop].c - entry) * e.dir / PU);
  }
  const q = (arr, p) => { const s = arr.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
  const mean = arr => arr.reduce((x, y) => x + y, 0) / (arr.length || 1);
  return {
    n: events.length,
    mfe25: q(mfe, 0.25), mfe50: q(mfe, 0.5), mfe75: q(mfe, 0.75), mfe90: q(mfe, 0.9),
    mae25: q(mae, 0.25), mae50: q(mae, 0.5), mae75: q(mae, 0.75), mae90: q(mae, 0.9),
    endMean: mean(end), endMed: q(end, 0.5),
  };
}

/**
 * Signed travel with no target at all: how far price goes up and down from the
 * test, regardless of which way the detector said to trade. This is what tells
 * you whether the level is a bounce or a break, before any target is imposed.
 */
function asymmetry(events, horizon) {
  const up = [], dn = [], net = [];
  for (const e of events) {
    const entry = bars[e.i].c;
    const stop = Math.min(N - 1, e.i + horizon);
    let u = 0, d = 0;
    for (let j = e.i + 1; j <= stop; j++) {
      const a = (bars[j].h - entry) / PU, b = (bars[j].l - entry) / PU;
      if (a > u) u = a;
      if (b < d) d = b;
    }
    up.push(u); dn.push(-d);
    net.push((bars[stop].c - entry) / PU);
  }
  const mean = arr => arr.reduce((x, y) => x + y, 0) / (arr.length || 1);
  return { n: events.length, up: mean(up), dn: mean(dn), net: mean(net) };
}

// ── formatting ───────────────────────────────────────────────────────────────
const f = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '—';
const sgn = (x, d = 2) => Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '—';
const line = n => console.log('─'.repeat(n));
const pad = (s, n) => String(s).padEnd(n);
const rp = (s, n) => String(s).padStart(n);

// ─────────────────────────────────────────────────────────────────────────────
//  STAGES
// ─────────────────────────────────────────────────────────────────────────────

function stageProbe() {
  console.log('DATA');
  line(78);
  console.log(`  ${N.toLocaleString()} 1m candles  ${new Date(bars[0].t).toISOString().slice(0, 16)} → ${new Date(bars[N - 1].t).toISOString().slice(0, 16)}`);
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
  console.log(`  price ${f(lo)} → ${f(hi)};  first close ${f(bars[0].c)}, last close ${f(bars[N - 1].c)}  (fell ${f((bars[0].c - bars[N - 1].c) / PU, 0)} points)`);

  const d = buckets(1440, 0);
  const lens = d.map(x => x.b - x.a + 1).sort((a, b) => a - b);
  const rngs = d.map(x => (x.h - x.l) / PU).sort((a, b) => a - b);
  console.log(`\nSESSIONS (UTC calendar days; the feed has a daily break 00:00-01:00 UTC, so the calendar day IS the session)`);
  console.log(`  ${d.length} days;  bars/day median ${lens[lens.length >> 1]}, min ${lens[0]}, max ${lens[lens.length - 1]}`);
  console.log(`  daily range points: p25 ${f(rngs[rngs.length >> 2], 0)}  median ${f(rngs[rngs.length >> 1], 0)}  p75 ${f(rngs[Math.floor(rngs.length * 0.75)], 0)}`);
  const w = buckets(10080, 0);
  console.log(`  ${w.length} Monday-anchored weeks`);

  const a = atr1.filter(Number.isFinite).sort((x, y) => x - y);
  console.log(`\nATR14 on 1m: median ${f(a[a.length >> 1])} USD → default tol ${f(a[a.length >> 1] * 0.20)} USD, default approach ${f(a[a.length >> 1] * 1.5)} USD`);
  const ad = E.atr(buckets(1440, 0).map(x => ({ h: x.h, l: x.l, c: x.c })), 14).filter(Number.isFinite).sort((x, y) => x - y);
  console.log(`ATR14 on D : median ${f(ad[ad.length >> 1])} USD`);

  console.log('\nBLIND BASELINES (40,000 random entries each)');
  line(78);
  console.log('  tp/sl'.padEnd(14) + 'hold'.padStart(8) + 'long'.padStart(10) + 'short'.padStart(10));
  for (const [tp, sl, h] of [[90, 90, 1440], [45, 45, 1440], [30, 30, 480], [25, 15, 240], [20, 20, 240], [15, 15, 120], [40, 20, 480]]) {
    console.log(`  ${tp}/${sl}`.padEnd(14) + rp(h, 8) + rp(f(blind(1, tp, sl, h)), 10) + rp(f(blind(-1, tp, sl, h)), 10));
  }
  console.log('\n  The 90/90/1440 row must reproduce the calibration numbers -4.8 and +4.3.');
}

function stageCurrent() {
  console.log('THE CURRENT CONSTRUCTION — tools/levels.js:previousDayLevels');
  console.log('nearest of {prev high, prev low, prev close} to the close, through tools/level_events.js, 90/90/1440.\n');
  const lineSeries = LV.previousDayLevels(bars).line;

  // How much of the "signal" is the selector moving rather than price arriving?
  let jumps = 0, defined = 0;
  for (let i = 1; i < N; i++) {
    if (!Number.isFinite(lineSeries[i]) || !Number.isFinite(lineSeries[i - 1])) continue;
    defined++;
    if (Math.abs(lineSeries[i] - lineSeries[i - 1]) > 0.05) jumps++;
  }
  const dayCount = buckets(1440, 0).length;
  console.log(`  the series changes value on ${jumps} of ${defined} bars.`);
  console.log(`  a genuine previous-day level changes ${dayCount - 1} times over this sample — once a day.`);
  console.log(`  so ${jumps - (dayCount - 1)} of those changes are the selector re-pointing, not new information.\n`);

  const ev = levelTestEvents(bars, lineSeries, atr1);
  const s = score(ev);
  line(78);
  console.log(`  tests ${s.tests}   respect ${f(s.respect, 1)}%  (random ${RANDOM_RESPECT}%, edge ${sgn(s.respect - RANDOM_RESPECT, 1)})`);
  console.log(`  traded ${s.traded}   shorts ${f(s.shortShare, 0)}%   raw ${sgn(s.raw)}   ALPHA ${sgn(s.alpha)}   t ${f(s.t)}`);
  line(78);
  for (const [name, set] of [['bounce only', bounce(ev)], ['break only', brk(ev)]]) {
    const q = score(set);
    console.log(`  ${pad(name, 14)} n ${rp(q.traded, 5)}   raw ${rp(sgn(q.raw), 8)}   alpha ${rp(sgn(q.alpha), 8)}`);
  }
  return s;
}

const CELLS = [
  ['PDH', 'h'], ['PDL', 'l'], ['PDC', 'c'], ['PDO', 'o'], ['PDMID', 'mid'],
];

function stageSplit() {
  console.log('THE THREE SEPARATED — each a fixed number, tested one at a time.');
  console.log('Detector and target are exactly the sweep\'s: tol 0.20 ATR, approach 1.5 ATR, break 0.25 ATR, 90/90/1440.\n');
  line(96);
  console.log(pad('level', 10) + rp('tests', 7) + rp('resp%', 8) + rp('edge', 7) + rp('n', 7) + rp('short%', 8) + rp('raw', 9) + rp('ALPHA', 9) + rp('t', 7));
  line(96);
  for (const [name, which] of CELLS) {
    const ev = levelEvents(1440, which);
    const s = score(ev);
    console.log(pad(name, 10) + rp(s.tests, 7) + rp(f(s.respect, 1), 8) + rp(sgn(s.respect - RANDOM_RESPECT, 1), 7) +
      rp(s.traded, 7) + rp(f(s.shortShare, 0), 8) + rp(sgn(s.raw), 9) + rp(sgn(s.alpha), 9) + rp(f(s.t), 7));
  }
  line(96);

  console.log('\nAll three pooled (dedup\'d where two levels are hit by the same candle):');
  const pooled = dedupe([...levelEvents(1440, 'h'), ...levelEvents(1440, 'l'), ...levelEvents(1440, 'c')]);
  const ps = score(pooled);
  console.log(`  tests ${ps.tests}  respect ${f(ps.respect, 1)}%  n ${ps.traded}  raw ${sgn(ps.raw)}  ALPHA ${sgn(ps.alpha)}  t ${f(ps.t)}`);

  console.log('\nSPLIT BY THE SIDE PRICE ARRIVED FROM — the axis the old code could not see at all.');
  line(96);
  console.log(pad('cell', 22) + rp('tests', 7) + rp('resp%', 8) + rp('n', 7) + rp('raw', 9) + rp('ALPHA', 9) + rp('t', 7));
  line(96);
  for (const [name, which] of CELLS) {
    const ev = levelEvents(1440, which);
    for (const fa of [true, false]) {
      const sub = ev.filter(e => e.fromAbove === fa);
      if (sub.length < 25) continue;
      const s = score(sub);
      console.log(pad(`${name} from ${fa ? 'above' : 'below'}`, 22) + rp(s.tests, 7) + rp(f(s.respect, 1), 8) +
        rp(s.traded, 7) + rp(sgn(s.raw), 9) + rp(sgn(s.alpha), 9) + rp(f(s.t), 7));
    }
  }
  line(96);
}

function stageTfsweep() {
  const TFS = [1, 5, 15, 60, 240, 1440, 10080];
  console.log('PREVIOUS-BAR HIGH / LOW / CLOSE ACROSS TIMEFRAMES');
  console.log('The level is the previous candle\'s value on that timeframe, published on the first 1m bar of the next candle');
  console.log('and held fixed for it. Detection is on 1m throughout, so the numbers sit alongside the sweep\'s.\n');
  for (const which of ['h', 'l', 'c']) {
    console.log(`\n  ${which === 'h' ? 'previous-bar HIGH' : which === 'l' ? 'previous-bar LOW' : 'previous-bar CLOSE'}`);
    line(82);
    console.log(pad('  tf', 8) + rp('tests', 8) + rp('resp%', 8) + rp('edge', 8) + rp('n', 7) + rp('raw', 9) + rp('ALPHA', 9) + rp('t', 7));
    line(82);
    for (const m of TFS) {
      let ev;
      try { ev = levelEvents(m, which); } catch (e) { continue; }
      const s = score(ev);
      const ok = s.tests >= 40;
      console.log(pad('  ' + TF_NAME[m], 8) + rp(s.tests, 8) + rp(ok ? f(s.respect, 1) : '—', 8) + rp(ok ? sgn(s.respect - RANDOM_RESPECT, 1) : '—', 8) +
        rp(s.traded, 7) + rp(ok ? sgn(s.raw) : '—', 9) + rp(ok ? sgn(s.alpha) : '—', 9) + rp(ok ? f(s.t) : '—', 7));
    }
    line(82);
  }

  console.log('\n\nSESSION ANCHOR — does it matter where the "day" is cut? (previous-day high, 90/90)');
  line(72);
  console.log(pad('  anchor', 16) + rp('tests', 8) + rp('resp%', 8) + rp('n', 7) + rp('ALPHA', 9));
  line(72);
  for (const oh of [0, 1, 13, 17, 21, 22]) {
    const ev = levelEvents(1440, 'h', { offsetHours: oh });
    const s = score(ev);
    console.log(pad(`  ${String(oh).padStart(2, '0')}:00 UTC`, 16) + rp(s.tests, 8) + rp(f(s.respect, 1), 8) + rp(s.traded, 7) + rp(sgn(s.alpha), 9));
  }
  line(72);
  console.log('  (the feed already breaks 00:00-01:00 UTC, so 0 and 1 are the same cut)');
}

function stageDetect() {
  console.log('DETECTOR GEOMETRY — how close is "at the level", how far away is "away"?');
  console.log('A daily level plausibly has a fixed dollar half-width rather than one scaled to the 1m ATR.');
  console.log('PDH and PDL pooled, 90/90/1440, so only the geometry moves.\n');
  line(92);
  console.log(pad('  tolUsd', 10) + pad('apprUsd', 10) + pad('brkUsd', 10) + rp('tests', 8) + rp('resp%', 8) + rp('n', 7) + rp('raw', 9) + rp('ALPHA', 9) + rp('t', 7));
  line(92);
  for (const tolUsd of [0.20, 0.40, 0.80, 1.50]) {
    for (const approachUsd of [2, 5, 10, 20]) {
      for (const breakUsd of [0.30, 0.60, 1.20]) {
        const o = { tolUsd, approachUsd, breakUsd, resetUsd: approachUsd * 0.7 };
        const ev = dedupe([...levelEvents(1440, 'h', o), ...levelEvents(1440, 'l', o)]);
        if (ev.length < 60) continue;
        const s = score(ev);
        console.log(pad('  ' + f(tolUsd), 10) + pad(approachUsd, 10) + pad(f(breakUsd), 10) +
          rp(s.tests, 8) + rp(f(s.respect, 1), 8) + rp(s.traded, 7) + rp(sgn(s.raw), 9) + rp(sgn(s.alpha), 9) + rp(f(s.t), 7));
      }
    }
  }
  line(92);
  console.log('\n  Respect climbs with tolerance for every level, real or not — a wide band catches wicks.');
  console.log('  Judge on alpha, and check the shadow controls in `control` before believing any of it.');
}

const DET = { tolUsd: 0.80, approachUsd: 5, breakUsd: 0.60, resetUsd: 3.5 };

/** The named cells: level, arrival side, reading. */
function cellEvents(which, fromAbove, kind, o = DET) {
  return levelEvents(1440, which, o).filter(e => e.fromAbove === fromAbove && e.kind === kind);
}

function stageExcursion() {
  console.log('WHAT TRAVEL DOES A TEST ACTUALLY PRODUCE?');
  console.log('Points of favourable and adverse travel in the detector\'s own direction, over 240 minutes.');
  console.log(`Detector: tol ${DET.tolUsd} USD, approach ${DET.approachUsd} USD, break ${DET.breakUsd} USD.\n`);
  line(104);
  console.log(pad('  cell', 30) + rp('n', 6) + rp('MFE25', 8) + rp('MFE50', 8) + rp('MFE75', 8) + rp('MAE25', 8) + rp('MAE50', 8) + rp('MAE75', 8) + rp('endMed', 9));
  line(104);
  const rows = [];
  for (const [name, which] of [['PDH', 'h'], ['PDL', 'l'], ['PDC', 'c']]) {
    for (const fa of [true, false]) {
      for (const kind of ['reject', 'break']) {
        const ev = cellEvents(which, fa, kind);
        if (ev.length < 20) continue;
        const x = excursion(ev, 240);
        rows.push([`${name} ${fa ? 'from above' : 'from below'} ${kind}`, x]);
      }
    }
  }
  for (const [n, x] of rows) {
    console.log(pad('  ' + n, 30) + rp(x.n, 6) + rp(f(x.mfe25, 0), 8) + rp(f(x.mfe50, 0), 8) + rp(f(x.mfe75, 0), 8) +
      rp(f(x.mae25, 0), 8) + rp(f(x.mae50, 0), 8) + rp(f(x.mae75, 0), 8) + rp(sgn(x.endMed, 0), 9));
  }
  line(104);
  console.log('\n  This is the surprise, and it runs the opposite way to the usual complaint about 90/90.');
  console.log('  Gold\'s daily range over this sample has a median of 1,112 points, so 90 points is $9 in a');
  console.log('  market that moves $111 a day. A test of a DAILY level produces median favourable travel of');
  console.log('  180-350 points inside four hours and median adverse travel of 130-500. A 90/90 bracket is');
  console.log('  therefore resolved almost immediately by whichever side of the noise arrives first — it is');
  console.log('  a coin toss taken at random inside the first few minutes, which is exactly why every 90/90');
  console.log('  number above sits on top of its blind baseline. The target has to be sized to the daily');
  console.log('  level\'s travel, not to a 1m level\'s travel.\n');

  console.log('  Travel by horizon, PDH+PDL rejections pooled:');
  const pool = dedupe([...cellEvents('h', false, 'reject'), ...cellEvents('l', true, 'reject')]);
  line(76);
  console.log(pad('  horizon', 12) + rp('n', 6) + rp('MFE50', 8) + rp('MFE75', 8) + rp('MAE50', 8) + rp('MAE75', 8) + rp('endMean', 10));
  line(76);
  for (const h of [30, 60, 120, 240, 480, 1440]) {
    const x = excursion(pool, h);
    console.log(pad('  ' + h + 'm', 12) + rp(x.n, 6) + rp(f(x.mfe50, 0), 8) + rp(f(x.mfe75, 0), 8) + rp(f(x.mae50, 0), 8) + rp(f(x.mae75, 0), 8) + rp(sgn(x.endMean, 1), 10));
  }
  line(76);
}

function stageAsym() {
  console.log('SIGNED TRAVEL — no target imposed, so nothing here depends on a target choice.');
  console.log('up / dn are mean points travelled above and below the entry within the horizon; net is the mean close.');
  console.log('A cell worth trading long has up > dn and net > 0 by more than the blind drift of the sample.\n');
  for (const H of [120, 480]) {
    console.log(`  horizon ${H} minutes`);
    line(86);
    console.log(pad('  cell', 32) + rp('n', 6) + rp('up', 9) + rp('dn', 9) + rp('net', 9) + rp('verdict', 16));
    line(86);
    for (const [name, which] of [['PDH', 'h'], ['PDL', 'l'], ['PDC', 'c']]) {
      for (const fa of [true, false]) {
        for (const kind of ['reject', 'break']) {
          const ev = cellEvents(which, fa, kind);
          if (ev.length < 20) continue;
          const a = asymmetry(ev, H);
          const dirLabel = a.net > 0 ? 'drifts up' : 'drifts down';
          const detDir = ev[0].dir;   // all events in a cell share a direction
          const agrees = (a.net > 0) === (detDir === 1);
          console.log(pad(`  ${name} ${fa ? 'above' : 'below'} ${kind}`, 32) + rp(a.n, 6) + rp(f(a.up, 1), 9) + rp(f(a.dn, 1), 9) +
            rp(sgn(a.net, 1), 9) + rp(`${dirLabel}${agrees ? '' : ' (flip)'}`, 16));
        }
      }
    }
    line(86);
    console.log();
  }
  console.log('  Reference: over this sample the mean 120-minute drift from a random bar is about');
  const r = rng(999);
  let s120 = 0, c120 = 0;
  for (let k = 0; k < 20000; k++) {
    const i = 100 + Math.floor(r() * (N - 2000));
    s120 += (bars[i + 120].c - bars[i].c) / PU; c120++;
  }
  console.log(`  ${sgn(s120 / c120, 2)} points, so any "net" must be judged against that, not against zero.`);
}

function stageTarget() {
  console.log('TARGET AND STOP, SIZED TO THE TRAVEL');
  console.log('Every cell of the grid is direction-adjusted against the blind baseline for THAT target,');
  console.log('so the numbers are comparable across the grid.\n');

  const sets = [
    ['PDH from below, reject (short)', dedupe(cellEvents('h', false, 'reject'))],
    ['PDL from above, reject (long)', dedupe(cellEvents('l', true, 'reject'))],
    ['range edge reject, pooled', dedupe([...cellEvents('h', false, 'reject'), ...cellEvents('l', true, 'reject')])],
    ['range edge break, pooled', dedupe([...cellEvents('h', false, 'break'), ...cellEvents('l', true, 'break')])],
    ['retest reject, pooled', dedupe([...cellEvents('h', true, 'reject'), ...cellEvents('l', false, 'reject')])],
    ['retest break, pooled', dedupe([...cellEvents('h', true, 'break'), ...cellEvents('l', false, 'break')])],
    ['PDC reject, pooled', dedupe([...cellEvents('c', true, 'reject'), ...cellEvents('c', false, 'reject')])],
    ['PDC break, pooled', dedupe([...cellEvents('c', true, 'break'), ...cellEvents('c', false, 'break')])],
  ];

  // Sized to the travel measured in `excursion`, which is 130-500 points, not 90.
  const GRID = [
    [90, 90, 1440],
    [60, 60, 240], [90, 90, 240], [150, 150, 240], [250, 250, 240],
    [90, 90, 480], [150, 150, 480], [250, 250, 480], [400, 400, 480],
    [150, 150, 960], [250, 250, 960], [400, 400, 960],
    [150, 300, 480], [300, 150, 480], [200, 100, 480], [100, 200, 480],
    [250, 125, 960], [125, 250, 960], [300, 600, 960], [600, 300, 960],
  ];

  for (const [name, ev] of sets) {
    if (ev.length < 40) { console.log(`\n${name}: only ${ev.length} events — skipped\n`); continue; }
    console.log(`\n${name}   (${ev.length} events, ${ev.filter(e => e.dir === 1).length} long / ${ev.filter(e => e.dir === -1).length} short)`);
    line(92);
    console.log(pad('  tp/sl/hold', 18) + rp('n', 6) + rp('win%', 8) + rp('raw', 9) + rp('ALPHA', 9) + rp('t', 7) + '     ' + pad('flipped alpha', 15));
    line(92);
    for (const [tp, sl, h] of GRID) {
      const s = score(ev, tp, sl, h);
      const sf = score(flip(ev), tp, sl, h);
      console.log(pad(`  ${tp}/${sl}/${h}`, 18) + rp(s.traded, 6) + rp(f(s.winRate, 0), 8) + rp(sgn(s.raw), 9) +
        rp(sgn(s.alpha), 9) + rp(f(s.t), 7) + '     ' + pad(sgn(sf.alpha), 15));
    }
    line(92);
  }
}

/**
 * Which arrival side a given level wants.
 *
 *   inside   price is still inside yesterday's range and comes out to the edge
 *            — PDH approached from below, PDL approached from above.
 *   outside  price has already left yesterday's range and comes back to the
 *            edge from the far side — PDH approached from above, PDL from
 *            below. This is the broken level being retested as the opposite
 *            kind of level, and it is a completely different trade.
 */
function wantSide(side, which) {
  if (side === 'inside') return which === 'l';
  if (side === 'outside') return which === 'h';
  if (side === 'above') return true;
  if (side === 'below') return false;
  return null;                      // both
}

/** Everything the final build depends on, in one place. */
const FINAL = {
  minutes: 1440,
  offsetHours: 0,
  which: ['h', 'l'],
  side: 'outside',         // PDH approached from above, PDL approached from below
  kind: 'reject',
  tolUsd: 0.80,
  approachUsd: 5,
  breakUsd: 0.60,
  resetUsd: 3.5,
  tp: 250, sl: 250, hold: 960,
};

/** Build the final event set, with any field overridden for a robustness probe. */
function finalEvents(over = {}) {
  const c = Object.assign({}, FINAL, over);
  const o = {
    tolUsd: c.tolUsd, approachUsd: c.approachUsd, breakUsd: c.breakUsd, resetUsd: c.resetUsd,
    offsetHours: c.offsetHours, carry: c.carry, fromMin: c.fromMin, toMin: c.toMin,
    shift: c.shift, shiftR: c.shiftR,
  };
  const parts = [];
  for (const w of c.which) {
    const ev = levelEvents(c.minutes, w, o);
    const wantAbove = wantSide(c.side, w);
    parts.push(ev.filter(e => (wantAbove === null || e.fromAbove === wantAbove) && (c.kind === 'any' || e.kind === c.kind)));
  }
  let ev = dedupe([].concat(...parts));
  if (c.flip) ev = flip(ev);
  return ev;
}

function stageDecay() {
  console.log('DOES THE LEVEL DECAY THROUGH THE SESSION?');
  console.log('The claim to check: a previous-day level matters early and fades. Events bucketed by minutes');
  console.log('into the session, then by which test of that level it is.\n');

  const build = k => dedupe([...cellEvents('h', false, k), ...cellEvents('l', true, k), ...cellEvents('h', true, k), ...cellEvents('l', false, k)]);
  for (const kind of ['reject', 'break']) {
    const ev = build(kind);
    console.log(`  ${kind}s, all four edge cells pooled  (${ev.length} events)   target ${FINAL.tp}/${FINAL.sl}/${FINAL.hold}`);
    line(72);
    console.log(pad('  minutes in', 16) + rp('n', 7) + rp('raw', 9) + rp('ALPHA', 9) + rp('t', 8));
    line(72);
    for (const [lo, hi, label] of [[0, 120, '0-2h'], [120, 300, '2-5h'], [300, 600, '5-10h'], [600, 1e9, '10h+']]) {
      const sub = ev.filter(e => e.mins >= lo && e.mins < hi);
      if (sub.length < 15) { console.log(pad('  ' + label, 16) + rp(sub.length, 7) + '   too few'); continue; }
      const s = score(sub, FINAL.tp, FINAL.sl, FINAL.hold);
      console.log(pad('  ' + label, 16) + rp(s.traded, 7) + rp(sgn(s.raw), 9) + rp(sgn(s.alpha), 9) + rp(f(s.t), 8));
    }
    line(72);
    console.log(pad('  1st touch', 16) + (() => { const s = score(ev.filter(e => e.touch === 1), FINAL.tp, FINAL.sl, FINAL.hold); return rp(s.traded, 7) + rp(sgn(s.raw), 9) + rp(sgn(s.alpha), 9) + rp(f(s.t), 8); })());
    console.log(pad('  2nd+', 16) + (() => { const sub = ev.filter(e => e.touch > 1); if (sub.length < 15) return rp(sub.length, 7) + '   too few'; const s = score(sub, FINAL.tp, FINAL.sl, FINAL.hold); return rp(s.traded, 7) + rp(sgn(s.raw), 9) + rp(sgn(s.alpha), 9) + rp(f(s.t), 8); })());
    line(72);
    console.log();
  }

  console.log('  Restricting the level\'s life to the first N minutes of the session:');
  line(72);
  console.log(pad('  window', 16) + rp('n', 7) + rp('raw', 9) + rp('ALPHA', 9) + rp('t', 8));
  line(72);
  for (const toMin of [120, 240, 480, 720, null]) {
    const ev = finalEvents({ toMin });
    if (ev.length < 30) continue;
    const s = score(ev, FINAL.tp, FINAL.sl, FINAL.hold);
    console.log(pad('  ' + (toMin ? `first ${toMin}m` : 'whole day'), 16) + rp(s.traded, 7) + rp(sgn(s.raw), 9) + rp(sgn(s.alpha), 9) + rp(f(s.t), 8));
  }
  line(72);

  console.log('\n  Carrying the level for more than one day (levels are still published one day late):');
  line(72);
  for (const carry of [1, 2, 3, 5]) {
    const ev = finalEvents({ carry });
    const s = score(ev, FINAL.tp, FINAL.sl, FINAL.hold);
    console.log(pad(`  alive ${carry} day(s)`, 16) + rp(s.traded, 7) + rp(sgn(s.raw), 9) + rp(sgn(s.alpha), 9) + rp(f(s.t), 8));
  }
  line(72);
}

// Shadow levels: same day, same machinery, same publication delay, but placed
// somewhere inside the previous day's range instead of at its extreme. If these
// score the same, the extreme carries nothing and the number is a detector
// artefact rather than a property of the level.
const SHADOW_FRACS = [0.15, 0.25, 0.35, 0.5, 0.65, 0.75, 0.85];

function stageControl() {
  console.log('THE HONESTY TEST — shadow levels built from the same information, not at the extreme.');
  console.log(`Reading under test: ${FINAL.which.join('+')} ${FINAL.side}, ${FINAL.kind}, ${FINAL.tp}/${FINAL.sl}/${FINAL.hold}.\n`);

  const real = finalEvents();
  const sr = score(real, FINAL.tp, FINAL.sl, FINAL.hold);
  console.log(`  REAL   n ${sr.traded}   respect ${f(sr.respect, 1)}%   raw ${sgn(sr.raw)}   ALPHA ${sgn(sr.alpha)}   t ${f(sr.t)}\n`);

  console.log('  1. Fractions of the previous day\'s range (a level with the same shape, no extremum):');
  line(78);
  console.log(pad('  level', 26) + rp('tests', 8) + rp('resp%', 8) + rp('n', 7) + rp('raw', 9) + rp('ALPHA', 9));
  line(78);
  const shadowAlphas = [];
  for (const fr of SHADOW_FRACS) {
    const o = { tolUsd: FINAL.tolUsd, approachUsd: FINAL.approachUsd, breakUsd: FINAL.breakUsd, resetUsd: FINAL.resetUsd };
    const ev = dedupe(levelEvents(1440, fr, o).filter(e => e.kind === FINAL.kind));
    if (ev.length < 40) continue;
    const s = score(ev, FINAL.tp, FINAL.sl, FINAL.hold);
    shadowAlphas.push(s.alpha);
    console.log(pad(`  prevLow + ${f(fr, 2)}·range`, 26) + rp(s.tests, 8) + rp(f(s.respect, 1), 8) + rp(s.traded, 7) + rp(sgn(s.raw), 9) + rp(sgn(s.alpha), 9));
  }
  line(78);

  console.log('\n  2. The real extremes pushed off by a fraction of the range (same day, wrong price):');
  line(78);
  for (const sh of [-0.30, -0.15, -0.06, 0.06, 0.15, 0.30]) {
    const ev = finalEvents({ shiftR: sh });
    if (ev.length < 40) continue;
    const s = score(ev, FINAL.tp, FINAL.sl, FINAL.hold);
    shadowAlphas.push(s.alpha);
    console.log(pad(`  extreme ${sgn(sh, 2)}·range`, 26) + rp(s.tests, 8) + rp(f(s.respect, 1), 8) + rp(s.traded, 7) + rp(sgn(s.raw), 9) + rp(sgn(s.alpha), 9));
  }
  line(78);

  const m = shadowAlphas.reduce((a, b) => a + b, 0) / (shadowAlphas.length || 1);
  let v = 0; for (const x of shadowAlphas) v += (x - m) * (x - m);
  const sd = Math.sqrt(v / Math.max(1, shadowAlphas.length - 1));
  console.log(`\n  shadows: n ${shadowAlphas.length}   mean alpha ${sgn(m)}   sd ${f(sd)}`);
  console.log(`  real beats ${shadowAlphas.filter(x => sr.alpha > x).length}/${shadowAlphas.length}   z = ${sgn((sr.alpha - m) / (sd || 1))}`);

  console.log('\n  3. Yesterday\'s extreme replaced by the extreme of a DIFFERENT, earlier day');
  console.log('     (same value distribution, link to today destroyed):');
  line(78);
  const perm = permutedControl(FINAL);
  for (const [lagName, s] of perm) {
    console.log(pad('  ' + lagName, 26) + rp(s.tests, 8) + rp(f(s.respect, 1), 8) + rp(s.traded, 7) + rp(sgn(s.raw), 9) + rp(sgn(s.alpha), 9));
  }
  line(78);
}

/**
 * Use the high/low of day k-1-LAG instead of k-1. Still strictly causal (it is
 * older information), same construction, but no longer "yesterday".
 */
function permutedControl(cfg, lags = [0, 1, 2, 3, 4, 5, 7, 10]) {
  const out = [];
  const bk = buckets(1440, 0);
  for (const lag of lags) {
    const parts = [];
    for (const w of cfg.which) {
      const wantAbove = wantSide(cfg.side, w);
      const ev = [];
      for (let k = lag + 1; k < bk.length; k++) {
        const src = bk[k - 1 - lag];
        const L = bucketValue(src, w);
        if (!Number.isFinite(L)) continue;
        for (const e of windowEvents(bk[k].a, bk[k].b, L, cfg)) {
          if (e.i < 1 || e.i >= N - 2) continue;
          if (e.fromAbove !== wantAbove || e.kind !== cfg.kind) continue;
          ev.push({ ...e, which: w });
        }
      }
      parts.push(ev);
    }
    const ev = dedupe([].concat(...parts));
    out.push([lag === 0 ? 'yesterday (real)' : `${lag + 1} days back`, score(ev, cfg.tp, cfg.sl, cfg.hold), ev]);
  }
  return out;
}

/**
 * The honest statistics for a set of overlapping trades on a large target.
 *
 * Three things inflate a naive t here and all three are dealt with:
 *   - trades overlap, so they are not independent  → block bootstrap over days
 *   - a 250 point target has a 244 point sd, so a handful of trades can carry
 *     the mean                                     → top-trade contribution
 *   - the configuration was chosen from a grid      → a shadow ensemble large
 *     enough to say what alpha looks like when the level is not the level
 */
function stageStats() {
  const { tp, sl, hold } = FINAL;
  const ev = finalEvents();
  const s = score(ev, tp, sl, hold);
  const BL = blind(1, tp, sl, hold), BS = blind(-1, tp, sl, hold);
  const adjOf = e => { const p = race(e.i, e.dir, tp, sl, hold); return p === null ? null : p - (e.dir === 1 ? BL : BS); };

  console.log(`HOW MUCH OF alpha ${sgn(s.alpha)} SURVIVES AN HONEST STANDARD ERROR?`);
  console.log(`(reading: ${FINAL.which.join('+')} ${FINAL.side}, ${FINAL.kind}, ${tp}/${sl}/${hold})\n`);

  console.log('1. OVERLAP. Trades held for 960 minutes on a market that produces a handful of events a');
  console.log('   week are not independent draws.');
  const ser = serialise(ev, tp, sl, hold);
  const ss = score(ser, tp, sl, hold);
  console.log(`   all events                 n ${rp(s.traded, 4)}   alpha ${sgn(s.alpha)}   naive t ${f(s.t)}`);
  console.log(`   one position at a time     n ${rp(ss.traded, 4)}   alpha ${sgn(ss.alpha)}   naive t ${f(ss.t)}`);
  const days = new Set(ev.map(e => new Date(bars[e.i].t).toISOString().slice(0, 10)));
  console.log(`   the ${s.traded} events fall on ${days.size} distinct days — that is closer to the real sample size.`);

  console.log('\n2. BLOCK BOOTSTRAP over calendar days (5,000 resamples, whole days drawn with replacement).');
  for (const [nm, set] of [['all events', ev], ['one at a time', ser]]) {
    const byDay = new Map();
    for (const e of set) {
      const d = new Date(bars[e.i].t).toISOString().slice(0, 10);
      const a = adjOf(e);
      if (a === null) continue;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(a);
    }
    const blocks = [...byDay.values()];
    const r = rng(20260808);
    const means = [];
    for (let b = 0; b < 5000; b++) {
      let sum = 0, n = 0;
      for (let k = 0; k < blocks.length; k++) {
        const blk = blocks[Math.floor(r() * blocks.length)];
        for (const x of blk) { sum += x; n++; }
      }
      means.push(sum / n);
    }
    means.sort((a, b) => a - b);
    console.log(`   ${pad(nm, 16)} blocks ${rp(blocks.length, 4)}   95% CI [${sgn(means[125])}, ${sgn(means[4874])}]   above zero ${f(100 * means.filter(x => x > 0).length / 5000, 1)}%`);
  }

  console.log('\n3. IS IT A FEW TRADES? Contribution of the extremes.');
  const adj = ev.map(adjOf).filter(x => x !== null).sort((a, b) => b - a);
  const total = adj.reduce((a, b) => a + b, 0);
  const mean = total / adj.length;
  for (const k of [1, 3, 5, 10]) {
    const top = adj.slice(0, k).reduce((a, b) => a + b, 0);
    console.log(`   top ${rp(k, 2)} trades carry ${rp(f(100 * top / total, 0), 4)}% of the total`);
  }
  const trim = adj.slice(Math.floor(adj.length * 0.05), Math.ceil(adj.length * 0.95));
  console.log(`   mean ${sgn(mean)}   median ${sgn(adj[adj.length >> 1])}   5% trimmed mean ${sgn(trim.reduce((a, b) => a + b, 0) / trim.length)}`);

  console.log('\n4. THE NULL DISTRIBUTION. The same construction, same detector, same target, but the level');
  console.log('   is not yesterday\'s extreme. 40 shadows: 20 shifts off the extreme and 20 fractions of');
  console.log('   the previous range, plus the older-day set. What does alpha look like when nothing is there?');
  const shadows = [];
  for (let k = 1; k <= 10; k++) {
    for (const sgnv of [-1, 1]) {
      const a = score(finalEvents({ shiftR: sgnv * k * 0.05 }), tp, sl, hold);
      if (a.traded >= 60) shadows.push({ nm: `extreme ${sgn(sgnv * k * 0.05, 2)}R`, a: a.alpha, n: a.traded });
    }
  }
  const o = { tolUsd: FINAL.tolUsd, approachUsd: FINAL.approachUsd, breakUsd: FINAL.breakUsd, resetUsd: FINAL.resetUsd };
  for (let k = 1; k <= 19; k++) {
    const fr = k / 20;
    const set = dedupe(levelEvents(1440, fr, o).filter(e => e.kind === FINAL.kind));
    if (set.length < 60) continue;
    const a = score(set, tp, sl, hold);
    shadows.push({ nm: `low+${f(fr, 2)}R`, a: a.alpha, n: a.traded });
  }
  for (const [nm, q] of permutedControl(FINAL, [1, 2, 3, 4, 5, 6, 7, 8, 10, 12])) {
    if (q.traded >= 50) shadows.push({ nm, a: q.alpha, n: q.traded });
  }
  const vals = shadows.map(x => x.a);
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  let v = 0; for (const x of vals) v += (x - m) * (x - m);
  const sd = Math.sqrt(v / (vals.length - 1));
  vals.sort((a, b) => a - b);
  console.log(`   ${vals.length} shadows: mean ${sgn(m)}   sd ${f(sd, 1)}   p5 ${sgn(vals[Math.floor(vals.length * 0.05)], 1)}   p95 ${sgn(vals[Math.floor(vals.length * 0.95)], 1)}   max ${sgn(vals[vals.length - 1], 1)}`);
  console.log(`   REAL ${sgn(s.alpha)} beats ${vals.filter(x => s.alpha > x).length}/${vals.length}   z = ${sgn((s.alpha - m) / sd)}`);
  console.log('   The spread of the shadows IS the standard error of this measurement. Compare against it,');
  console.log('   not against zero, and not against the naive t.');

  console.log('\n5. THE SAME QUESTION AT A SMALLER TARGET, where a trade resolves and the sd is smaller.');
  line(78);
  console.log(pad('  tp/sl/hold', 18) + rp('n', 6) + rp('nOverlapFree', 14) + rp('alpha', 9) + rp('t', 7) + rp('shadow sd', 11) + rp('z', 7));
  line(78);
  for (const [a, b, h] of [[60, 60, 240], [90, 90, 480], [120, 120, 480], [150, 150, 480], [200, 200, 720], [250, 250, 960], [350, 350, 960]]) {
    const q = score(ev, a, b, h);
    const nser = serialise(ev, a, b, h).length;
    const sh = [];
    for (let k = 1; k <= 8; k++) for (const g of [-1, 1]) {
      const z = score(finalEvents({ shiftR: g * k * 0.05 }), a, b, h);
      if (z.traded >= 60) sh.push(z.alpha);
    }
    const mm = sh.reduce((x, y) => x + y, 0) / sh.length;
    let vv = 0; for (const x of sh) vv += (x - mm) * (x - mm);
    const ssd = Math.sqrt(vv / (sh.length - 1));
    console.log(pad(`  ${a}/${b}/${h}`, 18) + rp(q.traded, 6) + rp(nser, 14) + rp(sgn(q.alpha), 9) + rp(f(q.t), 7) + rp(f(ssd, 1), 11) + rp(sgn((q.alpha - mm) / ssd), 7));
  }
  line(78);
}

/**
 * THE TEST THAT DECIDES WHETHER THIS IS A LEVEL AT ALL.
 *
 * The chosen reading says: on a day where price has left yesterday's range,
 * wait for it to come back to the broken extreme and trade the rejection. Two
 * cheaper things could produce the same number:
 *
 *   (a) the DAY and the DIRECTION are what pay, and the moment of entry is
 *       irrelevant — in which case entering two hours early or two hours late
 *       scores the same;
 *   (b) the BREAKOUT is what pays and the retest is decoration — in which case
 *       entering the moment price leaves the range, with no retest at all,
 *       scores the same or better.
 *
 * Both are measured here against the same target on the same days.
 */
function stageMatched() {
  const { tp, sl, hold } = FINAL;
  const ev = finalEvents();
  const base = score(ev, tp, sl, hold);
  console.log(`IS IT THE LEVEL, OR JUST THE DAY AND THE DIRECTION?   (${tp}/${sl}/${hold})\n`);
  console.log(`  the reading under test: n ${base.traded}   alpha ${sgn(base.alpha)}   t ${f(base.t)}\n`);

  console.log('1. SHIFT THE ENTRY IN TIME. Same day, same direction, entry moved by N minutes.');
  console.log('   If the level matters, alpha must peak at 0 and fall away on both sides.');
  line(70);
  console.log(pad('  shift', 14) + rp('n', 6) + rp('raw', 10) + rp('ALPHA', 10) + rp('t', 8));
  line(70);
  const bk = buckets(1440, 0);
  const dayEnd = new Array(N).fill(-1);
  for (const d of bk) for (let i = d.a; i <= d.b; i++) dayEnd[i] = d.b;
  const dayStart = new Array(N).fill(-1);
  for (const d of bk) for (let i = d.a; i <= d.b; i++) dayStart[i] = d.a;
  for (const delta of [-480, -240, -120, -60, -30, 0, 30, 60, 120, 240, 480]) {
    const moved = [];
    for (const e of ev) {
      const j = e.i + delta;
      if (j < 1 || j >= N - 2) continue;
      if (j < dayStart[e.i] || j > dayEnd[e.i]) continue;   // must stay inside the same session
      moved.push({ ...e, i: j });
    }
    if (moved.length < 40) continue;
    const q = score(moved, tp, sl, hold);
    console.log(pad(`  ${delta >= 0 ? '+' : ''}${delta}m`, 14) + rp(q.traded, 6) + rp(sgn(q.raw), 10) + rp(sgn(q.alpha), 10) + rp(f(q.t), 8));
  }
  line(70);

  console.log('\n2. RANDOM MINUTE ON THE SAME DAY, SAME DIRECTION (300 draws of the whole set).');
  const r = rng(88121);
  const rand = [];
  for (let k = 0; k < 300; k++) {
    const set = ev.map(e => {
      const a = dayStart[e.i], b = dayEnd[e.i];
      return { ...e, i: Math.max(1, Math.min(N - 3, a + Math.floor(r() * (b - a + 1)))) };
    });
    rand.push(score(set, tp, sl, hold).alpha);
  }
  rand.sort((a, b) => a - b);
  const rm = rand.reduce((a, b) => a + b, 0) / rand.length;
  let rv = 0; for (const x of rand) rv += (x - rm) * (x - rm);
  const rsd = Math.sqrt(rv / (rand.length - 1));
  console.log(`   same-day random entry: mean alpha ${sgn(rm)}   sd ${f(rsd, 1)}   p95 ${sgn(rand[284], 1)}`);
  console.log(`   the level's own entry ${sgn(base.alpha)}  →  z vs same-day random timing = ${sgn((base.alpha - rm) / rsd)}`);
  console.log('   This is the sharpest control available: it holds the day, the direction and the count');
  console.log('   fixed and varies only WHEN you enter. Whatever it leaves is what the level itself buys.');

  console.log('\n3. NO RETEST AT ALL. Enter the first time price closes 10 USD beyond yesterday\'s extreme,');
  console.log('   long above the high, short below the low, once per day per side.');
  const brko = [];
  for (let k = 1; k < bk.length; k++) {
    const src = bk[k - 1];
    for (const [w, dir] of [['h', 1], ['l', -1]]) {
      const L = bucketValue(src, w);
      for (let i = bk[k].a; i <= bk[k].b; i++) {
        const past = dir === 1 ? bars[i].c > L + 10 : bars[i].c < L - 10;
        if (past) { if (i < N - 2) brko.push({ i, dir, kind: 'reject', level: L, which: w }); break; }
      }
    }
  }
  const sb = score(dedupe(brko), tp, sl, hold);
  console.log(`   breakout entry, no retest:  n ${sb.traded}   raw ${sgn(sb.raw)}   ALPHA ${sgn(sb.alpha)}   t ${f(sb.t)}`);
  console.log(`   retest entry:               n ${base.traded}   raw ${sgn(base.raw)}   ALPHA ${sgn(base.alpha)}   t ${f(base.t)}`);

  console.log('\n4. THE SAME DAYS ONLY. Restrict the breakout entries to days that also produced a retest,');
  console.log('   so the two are measured over an identical set of sessions.');
  const retestDays = new Set(ev.map(e => new Date(bars[e.i].t).toISOString().slice(0, 10) + '|' + e.which));
  const matchedBrk = dedupe(brko.filter(e => retestDays.has(new Date(bars[e.i].t).toISOString().slice(0, 10) + '|' + e.which)));
  const smb = score(matchedBrk, tp, sl, hold);
  console.log(`   breakout on retest days:    n ${smb.traded}   raw ${sgn(smb.raw)}   ALPHA ${sgn(smb.alpha)}   t ${f(smb.t)}`);

  console.log('\n5. EACH LEG ON ITS OWN, against the same-day random-timing control.');
  line(78);
  console.log(pad('  leg', 26) + rp('n', 6) + rp('alpha', 10) + rp('rand mean', 12) + rp('rand sd', 10) + rp('z', 8));
  line(78);
  for (const [nm, sub] of [['PDH from above (long)', ev.filter(e => e.which === 'h')], ['PDL from below (short)', ev.filter(e => e.which === 'l')]]) {
    if (sub.length < 30) continue;
    const q = score(sub, tp, sl, hold);
    const r2 = rng(5150);
    const rs = [];
    for (let k = 0; k < 300; k++) {
      const set = sub.map(e => { const a = dayStart[e.i], b = dayEnd[e.i]; return { ...e, i: Math.max(1, Math.min(N - 3, a + Math.floor(r2() * (b - a + 1)))) }; });
      rs.push(score(set, tp, sl, hold).alpha);
    }
    const mm = rs.reduce((a, b) => a + b, 0) / rs.length;
    let vv = 0; for (const x of rs) vv += (x - mm) * (x - mm);
    const ssd = Math.sqrt(vv / (rs.length - 1));
    console.log(pad('  ' + nm, 26) + rp(q.traded, 6) + rp(sgn(q.alpha), 10) + rp(sgn(mm), 12) + rp(f(ssd, 1), 10) + rp(sgn((q.alpha - mm) / ssd), 8));
  }
  line(78);
}

/**
 * WHERE THE INFORMATION ACTUALLY IS.
 *
 * `matched` shows that entering at the retest is worth almost nothing over
 * entering at a random minute of the same day in the same direction. But the
 * direction in that control was not free — it came from which side of
 * yesterday's range price was on. So the previous day's high and low are not
 * behaving like a level that price turns at. They are behaving like a BOUNDARY
 * that says which way to lean while price is beyond it.
 *
 * That is a much better-powered thing to measure, because every bar carries the
 * state rather than only the handful of bars that happen to be a test. Here it
 * is measured directly, with the level's own value swapped out for controls of
 * the same shape.
 */
function stateEvents(opts = {}) {
  const every = opts.every ?? 60;          // sample the state this often, in minutes
  const marginUsd = opts.marginUsd ?? 0;   // how far beyond the edge counts as "beyond"
  const lag = opts.lag ?? 0;               // 0 = yesterday, 1 = the day before, ...
  const mode = opts.mode ?? 'range';       // range | closeBand | momentum | midBand
  const widthR = opts.widthR ?? 1;         // band width as a multiple of the previous range
  const bk = buckets(1440, 0);
  const out = [];
  for (let k = lag + 1; k < bk.length; k++) {
    const src = bk[k - 1 - lag];
    const R = src.h - src.l;
    let hi, lo;
    if (mode === 'range') { hi = src.h; lo = src.l; }
    else if (mode === 'closeBand') { hi = src.c + R * widthR / 2; lo = src.c - R * widthR / 2; }
    // NOTE: mid ± half the range IS the range, so widthR must differ from 1 for
    // midBand to be a control at all. `shiftR` slides the whole band instead.
    else if (mode === 'midBand') { const m = (src.h + src.l) / 2; hi = m + R * widthR / 2; lo = m - R * widthR / 2; }
    else if (mode === 'slid') { const d = R * (opts.shiftR ?? 0); hi = src.h + d; lo = src.l + d; }
    for (let i = bk[k].a; i <= bk[k].b; i += every) {
      if (i < 1 || i >= N - 2) continue;
      let dir = 0;
      if (mode === 'momentum') {
        // the cheapest possible substitute: is price above where it was 24h ago?
        const j = i - 1380;
        if (j < 1) continue;
        const d = bars[i].c - bars[j].c;
        if (Math.abs(d) < marginUsd) continue;
        dir = Math.sign(d);
      } else {
        if (bars[i].c > hi + marginUsd) dir = 1;
        else if (bars[i].c < lo - marginUsd) dir = -1;
        else continue;
      }
      out.push({ i, dir, kind: 'reject', level: dir === 1 ? hi : lo, which: dir === 1 ? 'h' : 'l', mins: i - bk[k].a });
    }
  }
  return out;
}

function stageState() {
  console.log('THE PREVIOUS DAY\'S RANGE AS A BOUNDARY, NOT AS A LEVEL');
  console.log('At every sampled bar: long if price is beyond yesterday\'s high, short if beyond yesterday\'s low,');
  console.log('nothing while inside. Direction-adjusted as always. Sampled hourly so the state, not one');
  console.log('lucky minute, is what is measured.\n');

  const TARGETS = [[90, 90, 240], [150, 150, 480], [250, 250, 960], [400, 400, 1440]];
  const ev = stateEvents({ every: 60, marginUsd: 0 });
  console.log(`  ${ev.length} hourly observations beyond the range  (${ev.filter(e => e.dir === 1).length} above the high, ${ev.filter(e => e.dir === -1).length} below the low)`);
  console.log(`  as a share of all hourly bars in the sample: ${f(100 * ev.length / (N / 60), 0)}%\n`);

  line(96);
  console.log(pad('  target', 18) + rp('n', 7) + rp('win%', 7) + rp('raw', 9) + rp('ALPHA', 9) + rp('naive t', 9) + rp('serial n', 10) + rp('serial a', 10));
  line(96);
  for (const [tp, sl, h] of TARGETS) {
    const s = score(ev, tp, sl, h);
    const ser = serialise(ev, tp, sl, h);
    const ss = score(ser, tp, sl, h);
    console.log(pad(`  ${tp}/${sl}/${h}`, 18) + rp(s.traded, 7) + rp(f(s.winRate, 0), 7) + rp(sgn(s.raw), 9) + rp(sgn(s.alpha), 9) +
      rp(f(s.t), 9) + rp(ss.traded, 10) + rp(sgn(ss.alpha), 10));
  }
  line(96);

  console.log('\nCONTROLS OF THE SAME SHAPE — a band of the same width, in the wrong place, and plain momentum.');
  console.log('All at 250/250/960, all hourly, all direction-adjusted.');
  line(88);
  console.log(pad('  boundary', 34) + rp('n', 8) + rp('raw', 10) + rp('ALPHA', 10) + rp('t', 8));
  line(88);
  const rows = [
    ['yesterday\'s range (the real thing)', { mode: 'range', lag: 0 }],
    ['the range 2 days ago', { mode: 'range', lag: 1 }],
    ['the range 3 days ago', { mode: 'range', lag: 2 }],
    ['the range 5 days ago', { mode: 'range', lag: 4 }],
    ['the range 10 days ago', { mode: 'range', lag: 9 }],
    ['yesterday\'s close ± half its range', { mode: 'closeBand', widthR: 1 }],
    ['yesterday\'s mid ± 0.35 range (tighter)', { mode: 'midBand', widthR: 0.7 }],
    ['yesterday\'s mid ± 0.75 range (wider)', { mode: 'midBand', widthR: 1.5 }],
    ['the whole range slid up 0.5·range', { mode: 'slid', shiftR: 0.5 }],
    ['the whole range slid down 0.5·range', { mode: 'slid', shiftR: -0.5 }],
    ['above / below the price 24h ago', { mode: 'momentum', marginUsd: 0 }],
  ];
  for (const [nm, o] of rows) {
    const set = stateEvents(Object.assign({ every: 60 }, o));
    if (set.length < 100) continue;
    const s = score(set, 250, 250, 960);
    console.log(pad('  ' + nm, 34) + rp(s.traded, 8) + rp(sgn(s.raw), 10) + rp(sgn(s.alpha), 10) + rp(f(s.t), 8));
  }
  line(88);

  console.log('\nHOW FAR BEYOND THE EDGE? (yesterday\'s range, 250/250/960, hourly)');
  line(70);
  console.log(pad('  margin', 14) + rp('n', 8) + rp('raw', 10) + rp('ALPHA', 10) + rp('t', 8));
  line(70);
  for (const marginUsd of [0, 2, 5, 10, 20, 40]) {
    const set = stateEvents({ every: 60, marginUsd });
    if (set.length < 100) continue;
    const s = score(set, 250, 250, 960);
    console.log(pad(`  ${marginUsd} USD`, 14) + rp(s.traded, 8) + rp(sgn(s.raw), 10) + rp(sgn(s.alpha), 10) + rp(f(s.t), 8));
  }
  line(70);

  console.log('\nBLOCK BOOTSTRAP over days for the real boundary at 250/250/960:');
  const BL = blind(1, 250, 250, 960), BS = blind(-1, 250, 250, 960);
  const byDay = new Map();
  for (const e of ev) {
    const p = race(e.i, e.dir, 250, 250, 960);
    if (p === null) continue;
    const d = new Date(bars[e.i].t).toISOString().slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(p - (e.dir === 1 ? BL : BS));
  }
  const blocks = [...byDay.values()];
  const r = rng(777);
  const means = [];
  for (let b = 0; b < 5000; b++) {
    let sum = 0, n = 0;
    for (let k = 0; k < blocks.length; k++) { const blk = blocks[Math.floor(r() * blocks.length)]; for (const x of blk) { sum += x; n++; } }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  console.log(`  ${blocks.length} day blocks   95% CI [${sgn(means[125])}, ${sgn(means[4874])}]   above zero ${f(100 * means.filter(x => x > 0).length / 5000, 1)}%`);
}

function stageVerify() {
  console.log('CAUSALITY');
  line(78);

  console.log('\n1. PUBLICATION DELAY. A level from day k-1 must not be visible before day k starts.');
  const bk = buckets(1440, 0);
  let bad = 0, checked = 0;
  for (const e of finalEvents()) {
    // find the bucket the event sits in and confirm the level came from the one before it
    let k = 0; while (k < bk.length && bk[k].b < e.i) k++;
    checked++;
    if (k === 0) { bad++; continue; }
    const src = bk[k - 1];
    const want = e.which === 'h' ? src.h : src.l;
    if (Math.abs(want - e.level) > 1e-9) bad++;
    if (src.b >= e.i) bad++;   // source bucket must have closed before the event bar
  }
  console.log(`   ${checked} events checked, ${bad} whose level did not come from a fully-closed earlier day.`);

  console.log('\n2. PREFIX REPRODUCTION. Rebuild everything from only the first K bars and compare the');
  console.log('   events that fall inside the prefix. A lookahead bug shows up here as a mismatch.');
  const full = finalEvents();
  for (const K of [40000, 100000, 150000]) {
    const sub = prefixEvents(K, FINAL);
    const want = full.filter(e => e.i < K - 1500).map(e => `${e.i}|${e.dir}|${e.kind}|${e.level.toFixed(4)}`);
    const got = new Set(sub.filter(e => e.i < K - 1500).map(e => `${e.i}|${e.dir}|${e.kind}|${e.level.toFixed(4)}`));
    const miss = want.filter(x => !got.has(x)).length;
    console.log(`   K=${String(K).padStart(6)}   full-sample events inside prefix ${String(want.length).padStart(4)}   missing from prefix run ${miss}`);
  }

  console.log('\n3. ENTRY TIMING. Entry is the close of the event bar; the race starts at bar i+1.');
  console.log('   Entering one bar later instead (a pessimistic slippage model):');
  const later = full.filter(e => e.i + 1 < N - 2).map(e => ({ ...e, i: e.i + 1 }));
  const s0 = score(full, FINAL.tp, FINAL.sl, FINAL.hold);
  const s1 = score(later, FINAL.tp, FINAL.sl, FINAL.hold);
  console.log(`   at signal close  alpha ${sgn(s0.alpha)}   (n ${s0.traded})`);
  console.log(`   one bar later    alpha ${sgn(s1.alpha)}   (n ${s1.traded})`);

  console.log('\n4. NO FUTURE IN THE ATR. atr1 is E.atr(bars,14), a backward RMA of true range; atr1[i]');
  console.log('   uses bars up to i only. The detector reads atr1[i], bars[i] and bars[i-1].c.');
}

/** Re-derive the final events using only bars[0..K-1]. */
function prefixEvents(K, cfg) {
  const sub = bars.slice(0, K);
  const subAtr = E.atr(sub, 14);
  // buckets over the prefix
  const bk = [];
  let cur = null;
  for (let i = 0; i < sub.length; i++) {
    const k = bucketKey(sub[i].t, cfg.minutes, (cfg.offsetHours || 0) * 3600000);
    if (!cur || cur.k !== k) { if (cur) bk.push(cur); cur = { k, a: i, b: i, o: sub[i].o, h: sub[i].h, l: sub[i].l, c: sub[i].c }; }
    else { cur.b = i; if (sub[i].h > cur.h) cur.h = sub[i].h; if (sub[i].l < cur.l) cur.l = sub[i].l; cur.c = sub[i].c; }
  }
  if (cur) bk.push(cur);

  const parts = [];
  for (const w of cfg.which) {
    const wantAbove = wantSide(cfg.side, w);
    const ev = [];
    for (let k = 1; k < bk.length; k++) {
      const L = bucketValue(bk[k - 1], w);
      if (!Number.isFinite(L)) continue;
      // inline copy of windowEvents against the prefix arrays
      let approached = false, locked = false;
      for (let i = Math.max(1, bk[k].a); i <= bk[k].b; i++) {
        const a = subAtr[i];
        if (!Number.isFinite(a) || a <= 0) continue;
        const bar = sub[i];
        const dist = Math.abs(bar.c - L);
        if (locked && dist > cfg.resetUsd) locked = false;
        if (dist >= cfg.approachUsd) approached = true;
        if (!approached || locked) continue;
        const fromAbove = sub[i - 1].c > L;
        const reached = fromAbove ? bar.l <= L + cfg.tolUsd : bar.h >= L - cfg.tolUsd;
        if (!reached) continue;
        let dir = 0, kind = null;
        if (fromAbove) {
          if (bar.c > L + cfg.tolUsd * 0.5) { dir = 1; kind = 'reject'; }
          else if (bar.c < L - cfg.breakUsd) { dir = -1; kind = 'break'; }
          else continue;
        } else {
          if (bar.c < L - cfg.tolUsd * 0.5) { dir = -1; kind = 'reject'; }
          else if (bar.c > L + cfg.breakUsd) { dir = 1; kind = 'break'; }
          else continue;
        }
        locked = true; approached = false;
        if (fromAbove !== wantAbove || kind !== cfg.kind) continue;
        ev.push({ i, dir, kind, level: L, which: w });
      }
    }
    parts.push(ev);
  }
  return dedupe([].concat(...parts));
}

function stageFinal() {
  console.log('THE CHOSEN CONSTRUCTION');
  line(90);
  console.log(`  period          previous UTC calendar day (the feed breaks 00:00-01:00 UTC, so this is the session)`);
  console.log(`  levels          yesterday's HIGH and yesterday's LOW, each a fixed number for the whole of today`);
  console.log(`  publication     first 1m bar of today; never revised`);
  console.log(`  arrival side    ${FINAL.side === 'inside' ? 'from inside yesterday\'s range (high from below, low from above)' : FINAL.side}`);
  console.log(`  reading         ${FINAL.kind}`);
  console.log(`  detector        arrive within ${FINAL.tolUsd} USD after being ${FINAL.approachUsd} USD away; ${FINAL.breakUsd} USD close-through counts as a break; unlock at ${FINAL.resetUsd} USD`);
  console.log(`  target/stop     ${FINAL.tp} / ${FINAL.sl} points, max hold ${FINAL.hold} minutes`);
  line(90);

  const ev = finalEvents();
  const s = score(ev, FINAL.tp, FINAL.sl, FINAL.hold);
  const BL = blind(1, FINAL.tp, FINAL.sl, FINAL.hold), BS = blind(-1, FINAL.tp, FINAL.sl, FINAL.hold);
  console.log(`\n  events ${s.tests}   traded ${s.traded}   longs ${s.longs} / shorts ${s.shorts}   win ${f(s.winRate, 1)}%`);
  console.log(`  raw ${sgn(s.raw)} points/trade`);
  console.log(`  blind baseline at this target: long ${f(BL)}, short ${f(BS)}`);
  console.log(`  DIRECTION-ADJUSTED ALPHA ${sgn(s.alpha)} points/trade   sd ${f(s.sd, 1)}   t ${f(s.t)}`);
  console.log(`  in USD: ${sgn(s.alpha * 0.10)} per trade per 1.0 lot-point, over ${s.traded} trades`);

  console.log('\n  The same events read the other way (a sanity check, not a second strategy):');
  const sf = score(flip(ev), FINAL.tp, FINAL.sl, FINAL.hold);
  console.log(`  flipped alpha ${sgn(sf.alpha)}   t ${f(sf.t)}`);

  console.log('\n  Long and short legs separately, each against its own baseline:');
  const L = ev.filter(e => e.dir === 1), S = ev.filter(e => e.dir === -1);
  if (L.length) { const q = score(L, FINAL.tp, FINAL.sl, FINAL.hold); console.log(`   longs   n ${q.traded}  raw ${sgn(q.raw)}  vs blind ${f(BL)}  alpha ${sgn(q.alpha)}  t ${f(q.t)}`); }
  if (S.length) { const q = score(S, FINAL.tp, FINAL.sl, FINAL.hold); console.log(`   shorts  n ${q.traded}  raw ${sgn(q.raw)}  vs blind ${f(BS)}  alpha ${sgn(q.alpha)}  t ${f(q.t)}`); }

  console.log('\n  Before and after, on the same measuring stick:');
  const before = score(levelTestEvents(bars, LV.previousDayLevels(bars).line, atr1));
  console.log(`   old nearest-of-three, 90/90/1440 : alpha ${sgn(before.alpha)}  over ${before.traded} trades`);
  console.log(`   this build                       : alpha ${sgn(s.alpha)}  over ${s.traded} trades`);

  console.log('\n\n  WHAT THIS NUMBER IS AND IS NOT — read this before trading it.');
  line(90);
  console.log('  It holds up internally: positive in 48 of 48 nearby detectors, in 6 of 7 months, in');
  console.log('  both halves of the sample, on both the long and the short leg, and at every target');
  console.log('  from 200/200 upward. Causality is verified in `verify` with zero prefix mismatches.');
  console.log();
  console.log('  It does NOT hold up as evidence that price respects yesterday\'s high or low:');
  const ser = serialise(ev, FINAL.tp, FINAL.sl, FINAL.hold);
  const ss = score(ser, FINAL.tp, FINAL.sl, FINAL.hold);
  console.log(`   - respect is ${f(score(levelEvents(1440, 'h')).respect, 1)}% for the high and ${f(score(levelEvents(1440, 'l')).respect, 1)}% for the low, against ${RANDOM_RESPECT}% for a random price;`);
  console.log(`   - 960-minute holds overlap, and one position at a time gives alpha ${sgn(ss.alpha)} over ${ss.traded} trades (t ${f(ss.t)});`);
  console.log('   - against 49 shadow levels of the same construction, z is only +1.6;');
  console.log('   - and `matched` shows a random minute of the same day in the same direction earns');
  console.log('     +38.3, so the retest moment itself buys about +13 with a z near 1.0.');
  console.log();
  console.log('  The honest reading: this is a multi-day breakout/trend state that yesterday\'s range');
  console.log('  happens to mark, not a level that price turns at. Size it as a trend trade.');
  line(90);
}

function stageRobust() {
  const ev = finalEvents();
  const { tp, sl, hold } = FINAL;
  const s = score(ev, tp, sl, hold);
  console.log(`ROBUSTNESS OF   alpha ${sgn(s.alpha)}  over ${s.traded} trades\n`);

  console.log('1. BOOTSTRAP over trades (5,000 resamples)');
  const BL = blind(1, tp, sl, hold), BS = blind(-1, tp, sl, hold);
  const adj = [];
  for (const e of ev) { const p = race(e.i, e.dir, tp, sl, hold); if (p === null) continue; adj.push(p - (e.dir === 1 ? BL : BS)); }
  const r = rng(4242);
  const means = [];
  for (let b = 0; b < 5000; b++) {
    let acc = 0;
    for (let k = 0; k < adj.length; k++) acc += adj[Math.floor(r() * adj.length)];
    means.push(acc / adj.length);
  }
  means.sort((a, b) => a - b);
  console.log(`   mean ${sgn(adj.reduce((a, b) => a + b, 0) / adj.length)}   95% CI [${sgn(means[125])}, ${sgn(means[4874])}]   share above zero ${f(100 * means.filter(x => x > 0).length / means.length, 1)}%`);

  console.log('\n2. BY MONTH — an edge that lives in one month is not an edge.');
  line(64);
  console.log(pad('  month', 12) + rp('n', 7) + rp('raw', 9) + rp('ALPHA', 9));
  line(64);
  const byM = new Map();
  for (const e of ev) {
    const m = new Date(bars[e.i].t).toISOString().slice(0, 7);
    if (!byM.has(m)) byM.set(m, []);
    byM.get(m).push(e);
  }
  let posM = 0, totM = 0;
  for (const m of [...byM.keys()].sort()) {
    const q = score(byM.get(m), tp, sl, hold);
    totM++; if (q.alpha > 0) posM++;
    console.log(pad('  ' + m, 12) + rp(q.traded, 7) + rp(sgn(q.raw), 9) + rp(sgn(q.alpha), 9));
  }
  line(64);
  console.log(`  positive in ${posM} of ${totM} months`);

  console.log('\n3. WALK FORWARD — first half chooses nothing, it is just an out-of-sample split.');
  const half = Math.floor(N / 2);
  for (const [nm, sub] of [['first half', ev.filter(e => e.i < half)], ['second half', ev.filter(e => e.i >= half)]]) {
    const q = score(sub, tp, sl, hold);
    console.log(`   ${pad(nm, 12)} n ${rp(q.traded, 5)}  raw ${rp(sgn(q.raw), 8)}  alpha ${rp(sgn(q.alpha), 8)}  t ${f(q.t)}`);
  }

  console.log('\n4. THE NEIGHBOURHOOD — every nearby detector, so a spike cannot pass as a plateau.');
  line(84);
  console.log(pad('  tolUsd', 10) + pad('apprUsd', 10) + pad('brkUsd', 10) + rp('n', 7) + rp('raw', 9) + rp('ALPHA', 9) + rp('t', 7));
  line(84);
  let pos = 0, tot = 0;
  for (const tolUsd of [0.40, 0.60, 0.80, 1.20]) {
    for (const approachUsd of [5, 10, 15, 20]) {
      for (const breakUsd of [0.30, 0.60, 1.00]) {
        const set = finalEvents({ tolUsd, approachUsd, breakUsd, resetUsd: approachUsd * 0.7 });
        if (set.length < 60) continue;
        const q = score(set, tp, sl, hold);
        tot++; if (q.alpha > 0) pos++;
        console.log(pad('  ' + f(tolUsd), 10) + pad(approachUsd, 10) + pad(f(breakUsd), 10) + rp(q.traded, 7) + rp(sgn(q.raw), 9) + rp(sgn(q.alpha), 9) + rp(f(q.t), 7));
      }
    }
  }
  line(84);
  console.log(`  positive in ${pos} of ${tot} nearby detectors`);

  console.log('\n5. THE TARGET NEIGHBOURHOOD');
  line(60);
  for (const [a, b, h] of [[35, 20, 480], [40, 25, 720], [45, 25, 720], [50, 25, 720], [45, 30, 720], [60, 30, 960], [45, 25, 480], [45, 25, 1440]]) {
    const q = score(ev, a, b, h);
    console.log(`   ${pad(`${a}/${b}/${h}`, 16)} n ${rp(q.traded, 5)}  raw ${rp(sgn(q.raw), 8)}  alpha ${rp(sgn(q.alpha), 8)}  t ${f(q.t)}`);
  }
  line(60);

  console.log('\n6. COST — alpha is a difference of two equally-costed numbers, so it barely moves.');
  console.log(`   raw at 0.5 pt round trip ${sgn(s.raw)};  at a realistic 3.0 pt round trip ${sgn(s.raw - 2.5)}.`);
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  FINAL, finalEvents, prefixEvents, permutedControl, wantSide,
  loadBars, buckets, bucketValue, bucketKey, windowEvents, levelEvents, dedupe,
  excursion, asymmetry, score, race, raceExit, serialise, blind, bounce, brk, flip, cellEvents,
  bars, atr1, N, PU, COST, TF_NAME,
};

if (require.main === module) {
  const stage = process.argv[2] || 'final';
  const S = {
    probe: stageProbe, current: stageCurrent, split: stageSplit, tfsweep: stageTfsweep,
    detect: stageDetect, excursion: stageExcursion, asym: stageAsym, target: stageTarget,
    decay: stageDecay, control: stageControl, stats: stageStats, matched: stageMatched, state: stageState,
    verify: stageVerify, final: stageFinal, robust: stageRobust,
  };
  (S[stage] || stageProbe)();
}
