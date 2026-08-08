'use strict';
/*
 * ─────────────────────────────────────────────────────────────────────────────
 *  HIGH VOLUME NODE / POINT OF CONTROL — rebuilt from the definition up
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT WAS WRONG WITH THE OLD CONSTRUCTION
 *
 *   tools/levels.js:volumeNodeLevels builds a histogram of the trailing 1440
 *   one-minute bars and returns the price of the fullest bucket, recomputed
 *   every 60 bars. Three separate problems live in that one line:
 *
 *   (a) IT DRIFTS. The window is a rolling 24 hours, so the level is recomputed
 *       against a different sample every hour. When the peak bucket hops the
 *       series jumps, and tools/level_events.js treats a jump larger than half
 *       an ATR as a brand new level — the state machine resets, the approach
 *       requirement is thrown away, and the "test" that is measured is often
 *       just the level teleporting onto price. A rolling POC is a slow moving
 *       average of price, which is exactly what this whole exercise was
 *       supposed to get away from.
 *
 *   (b) IT IS ONE SERIES. Only one number exists per bar, so the value area
 *       has no edges. Every practitioner who uses a volume profile trades the
 *       EDGES — value area high and value area low, the prices where the
 *       auction stopped being efficient. The peak of the distribution is where
 *       price is most comfortable, which is the least likely place for it to
 *       turn. The old construction watched the one part of the profile that
 *       should not react.
 *
 *   (c) THE WINDOW IS NOT A SESSION. A profile that ends at 14:00 today mixes
 *       half of yesterday's auction with half of today's. A profile only means
 *       something when it covers a COMPLETED auction, and then it is a fixed
 *       set of numbers for the whole of the next one.
 *
 * WHAT THIS FILE DOES INSTEAD
 *
 *   Sessions are cut on a fixed anchor. For every COMPLETED session a volume
 *   profile is built on a global price grid, and from it three constants are
 *   read: POC, VAH, VAL (and, for contrast, the emptiest bucket, LVN). Those
 *   constants become visible on the first bar of the NEXT session and never
 *   move again. Each one is watched on its own, one level at a time, with the
 *   same approach/react/lock semantics as tools/level_events.js.
 *
 *   stage probe      data sanity: sessions, volume, price grid
 *   stage current    the old rolling-POC construction, direction-adjusted
 *   stage profile    the fixed session profile; sweeps window/bucket/kind/hold
 *   stage tf         detection timeframe sweep on the best definitions
 *   stage excursion  the MFE/MAE a test of this level actually produces
 *   stage tuned      target and stop sized to that excursion; both readings
 *   stage final      the chosen configuration, controls, causality assertions
 *
 *   Usage: node --max-old-space-size=3500 tools/fixes/volume-node.js <stage>
 *
 * CAUSALITY
 *   A level derived from bars [a, b) is stamped with knownAt = b and is only
 *   ever offered to bars with index >= b. Stage `final` asserts this for every
 *   single level and every single event, and additionally re-runs the whole
 *   measurement with the profile deliberately shifted one session forward (a
 *   real lookahead) to show what a leak would look like if one existed.
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

let PMIN = Infinity, PMAX = -Infinity;
for (let i = 0; i < N; i++) { if (bars[i].l < PMIN) PMIN = bars[i].l; if (bars[i].h > PMAX) PMAX = bars[i].h; }

// Higher-timeframe candles + their ATR, cached.
const TFC = new Map();
function tf(m) {
  if (m === 1) return { bars, index: null, lastOf: null, atr: atr1 };
  if (!TFC.has(m)) {
    const { bars: b, index } = E.resample(bars, m);
    const lastOf = new Array(b.length).fill(-1);
    for (let i = 0; i < index.length; i++) if (index[i] >= 0) lastOf[index[i]] = i;
    TFC.set(m, { bars: b, index, lastOf, atr: E.atr(b, 14) });
  }
  return TFC.get(m);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Trade simulation
// ─────────────────────────────────────────────────────────────────────────────

/** Reference implementation, byte-for-byte the one in tools/sweep_timeframes.js. */
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

/**
 * The same race, but resolved for a whole grid of thresholds in a single walk
 * forward. Needed because sizing the target honestly means recomputing the
 * blind baseline for every target/stop pair, and doing that one pair at a time
 * costs minutes.
 *
 * Returns first-touch bar indices for each threshold in `thr` (ascending),
 * plus the open-position exit, so any (tp, sl) pair can be resolved in O(1).
 */
function firstHits(i, dir, maxHold, thr) {
  const e = bars[i].c;
  const end = Math.min(N - 1, i + maxHold);
  const n = thr.length;
  const tHit = new Int32Array(n).fill(-1);
  const sHit = new Int32Array(n).fill(-1);
  let ti = 0, si = 0;
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    const fav = dir === 1 ? b.h - e : e - b.l;
    const adv = dir === 1 ? e - b.l : b.h - e;
    while (ti < n && fav >= thr[ti] * PU) { tHit[ti] = j; ti++; }
    while (si < n && adv >= thr[si] * PU) { sHit[si] = j; si++; }
    if (ti >= n && si >= n) break;
  }
  return { tHit, sHit, open: (bars[end].c - e) * dir / PU };
}
function resolve(h, ti, si, thr) {
  const t = h.tHit[ti], s = h.sHit[si];
  if (t < 0 && s < 0) return h.open - COST;
  if (t >= 0 && s >= 0 && t === s) return null;
  if (t >= 0 && (s < 0 || t < s)) return thr[ti] - COST;
  return -thr[si] - COST;
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
 * Blind baselines. -4.8 long / +4.3 short are the 90/90/1440 numbers; they are
 * meaningless at any other size, so every (dir, tp, sl, maxHold) gets its own,
 * computed from the same 40,000 random entries.
 */
const BLIND = new Map();
function blindGrid(dir, thr, maxHold, samples = 40000) {
  const key = `${dir}|${maxHold}|${thr.join(',')}|${samples}`;
  if (BLIND.has(key)) return BLIND.get(key);
  const r = rng(dir === 1 ? 31337 : 73331);
  const n = thr.length;
  const net = [], cnt = [];
  for (let a = 0; a < n; a++) { net.push(new Float64Array(n)); cnt.push(new Int32Array(n)); }
  const lo = 100, hi = N - maxHold - 2;
  for (let k = 0; k < samples; k++) {
    const h = firstHits(lo + Math.floor(r() * (hi - lo)), dir, maxHold, thr);
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      const p = resolve(h, a, b, thr);
      if (p === null) continue;
      net[a][b] += p; cnt[a][b]++;
    }
  }
  const out = [];
  for (let a = 0; a < n; a++) { const row = new Float64Array(n); for (let b = 0; b < n; b++) row[b] = net[a][b] / cnt[a][b]; out.push(row); }
  BLIND.set(key, out);
  return out;
}
function blind(dir, tp, sl, maxHold) {
  const g = blindGrid(dir, [tp === sl ? tp : tp, sl].filter((v, i, a) => a.indexOf(v) === i).sort((x, y) => x - y), maxHold);
  const thr = [tp, sl].filter((v, i, a) => a.indexOf(v) === i).sort((x, y) => x - y);
  return g[thr.indexOf(tp)][thr.indexOf(sl)];
}

/**
 * Direction-adjusted score at one target/stop. Longs vs blind long, shorts vs
 * blind short, combined weighted by count.
 *
 * `t` is the t-statistic of that alpha: the per-trade spread at a 90-point
 * target is enormous, so a "+9 alpha" over 600 trades can easily be two
 * standard errors of nothing. Every number in this file is read next to it.
 */
function score(events, tp = TP0, sl = SL0, maxHold = MAX_HOLD) {
  const BL = blind(1, tp, sl, maxHold), BS = blind(-1, tp, sl, maxHold);
  let ln = 0, lnet = 0, sn = 0, snet = 0, wins = 0;
  const adj = [];
  for (const e of events) {
    const p = race(e.i, e.dir, tp, sl, maxHold);
    if (p === null) continue;
    if (p > 0) wins++;
    if (e.dir === 1) { ln++; lnet += p; adj.push(p - BL); } else { sn++; snet += p; adj.push(p - BS); }
  }
  const tot = ln + sn;
  const la = ln ? lnet / ln - BL : 0;
  const sa = sn ? snet / sn - BS : 0;
  const alpha = tot ? (la * ln + sa * sn) / tot : NaN;
  let ss = 0;
  for (const x of adj) ss += (x - alpha) * (x - alpha);
  const sd = tot > 1 ? Math.sqrt(ss / (tot - 1)) : NaN;
  return {
    ...respectRate(events),
    traded: tot, longs: ln, shorts: sn,
    shortShare: tot ? (100 * sn) / tot : NaN,
    winRate: tot ? (100 * wins) / tot : NaN,
    raw: tot ? (lnet + snet) / tot : NaN,
    alpha,
    se: sd / Math.sqrt(tot),
    t: alpha / (sd / Math.sqrt(tot)),
    alphaLong: ln ? la : NaN, alphaShort: sn ? sa : NaN,
  };
}

/**
 * The strict version of the direction adjustment.
 *
 * The global blind baselines (-5.05 long, +4.10 short at 90/90) are averages
 * over a sample in which the market fell. If a level's tests cluster into the
 * months that fell hardest, subtracting the SAMPLE-WIDE short baseline
 * under-corrects, and a plain trend-follower will show alpha it has not earned.
 *
 * So: cut the sample into blocks, compute a blind long and blind short baseline
 * INSIDE each block from random entries in that block only, and adjust every
 * event against the baseline of the block it fired in. A level that only works
 * because it happened to be short in a falling month loses its alpha here. One
 * that beats a coin flip inside each month keeps it.
 */
const LOCAL = new Map();
function localBlind(blocks, tp, sl, maxHold, samplesPerBlock = 6000) {
  const key = `${blocks.length}|${tp}|${sl}|${maxHold}`;
  if (LOCAL.has(key)) return LOCAL.get(key);
  const out = blocks.map((bk, bi) => {
    const res = {};
    for (const dir of [1, -1]) {
      const r = rng(bi * 104729 + (dir === 1 ? 17 : 71));
      const lo = Math.max(100, bk.from), hi = Math.min(N - maxHold - 2, bk.to);
      let c = 0, net = 0;
      if (hi > lo + 10) {
        for (let k = 0; k < samplesPerBlock; k++) {
          const p = race(lo + Math.floor(r() * (hi - lo)), dir, tp, sl, maxHold);
          if (p === null) continue;
          c++; net += p;
        }
      }
      res[dir] = c ? net / c : NaN;
    }
    return res;
  });
  LOCAL.set(key, out);
  return out;
}

/** Calendar-month blocks over the 1m stream. */
function monthBlocks() {
  const out = [];
  let key = null;
  for (let i = 0; i < N; i++) {
    const k = new Date(bars[i].t).toISOString().slice(0, 7);
    if (k !== key) { out.push({ key: k, from: i, to: i + 1 }); key = k; }
    else out[out.length - 1].to = i + 1;
  }
  return out;
}
/** Fixed-length blocks, for a finer-grained local adjustment. */
function fixedBlocks(len) {
  const out = [];
  for (let i = 0; i < N; i += len) out.push({ key: String(i), from: i, to: Math.min(N, i + len) });
  return out;
}

function scoreLocal(events, tp, sl, maxHold, blocks) {
  const base = localBlind(blocks, tp, sl, maxHold);
  const idx = new Int32Array(N).fill(-1);
  for (let b = 0; b < blocks.length; b++) for (let i = blocks[b].from; i < blocks[b].to; i++) idx[i] = b;
  const adj = [];
  let ln = 0, sn = 0, lsum = 0, ssum = 0;
  for (const e of events) {
    const p = race(e.i, e.dir, tp, sl, maxHold);
    if (p === null) continue;
    const b = idx[e.i];
    if (b < 0) continue;
    const bl = base[b][e.dir];
    if (!Number.isFinite(bl)) continue;
    adj.push(p - bl);
    if (e.dir === 1) { ln++; lsum += p - bl; } else { sn++; ssum += p - bl; }
  }
  const tot = adj.length;
  const alpha = tot ? adj.reduce((a, b) => a + b, 0) / tot : NaN;
  let ss = 0;
  for (const x of adj) ss += (x - alpha) * (x - alpha);
  const sd = tot > 1 ? Math.sqrt(ss / (tot - 1)) : NaN;
  return {
    traded: tot, alpha, se: sd / Math.sqrt(tot), t: alpha / (sd / Math.sqrt(tot)),
    alphaLong: ln ? lsum / ln : NaN, alphaShort: sn ? ssum / sn : NaN, longs: ln, shorts: sn,
  };
}

/** The same score for a whole target/stop grid, one forward walk per event. */
function scoreGrid(events, thr, maxHold) {
  const BL = blindGrid(1, thr, maxHold), BS = blindGrid(-1, thr, maxHold);
  const n = thr.length;
  const lnet = [], lcnt = [], snet = [], scnt = [];
  for (let a = 0; a < n; a++) { lnet.push(new Float64Array(n)); lcnt.push(new Int32Array(n)); snet.push(new Float64Array(n)); scnt.push(new Int32Array(n)); }
  for (const e of events) {
    const h = firstHits(e.i, e.dir, maxHold, thr);
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      const p = resolve(h, a, b, thr);
      if (p === null) continue;
      if (e.dir === 1) { lnet[a][b] += p; lcnt[a][b]++; } else { snet[a][b] += p; scnt[a][b]++; }
    }
  }
  const out = [];
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
    const ln = lcnt[a][b], sn = scnt[a][b], tot = ln + sn;
    if (!tot) continue;
    const la = ln ? lnet[a][b] / ln - BL[a][b] : 0;
    const sa = sn ? snet[a][b] / sn - BS[a][b] : 0;
    out.push({
      tp: thr[a], sl: thr[b], traded: tot, longs: ln, shorts: sn,
      raw: (lnet[a][b] + snet[a][b]) / tot,
      alpha: (la * ln + sa * sn) / tot,
      alphaLong: ln ? la : NaN, alphaShort: sn ? sa : NaN,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Sessions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cut the 1m stream into sessions on a fixed clock anchor. Stubs — the two-hour
 * Friday tail, the Sunday open — are folded into their neighbour rather than
 * producing a profile from ninety bars.
 */
function sessions(anchorMin, minBars = 300) {
  const span = 86400000;
  const off = anchorMin * 60000;
  const out = [];
  let key = null;
  for (let i = 0; i < N; i++) {
    const k = Math.floor((bars[i].t - off) / span);
    if (k !== key) { out.push({ key: k, from: i, to: i + 1 }); key = k; }
    else out[out.length - 1].to = i + 1;
  }
  // merge stubs forward into the previous session
  const merged = [];
  for (const s of out) {
    if (merged.length && (s.to - s.from) < minBars) { merged[merged.length - 1].to = s.to; continue; }
    merged.push(s);
  }
  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Volume profile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-session volume histograms on a GLOBAL price grid, so profiles from
 * different sessions can be summed without re-bucketing. Each bar's volume is
 * spread evenly over the buckets its range covers, which is the standard
 * approximation when only OHLCV is available.
 */
function sessionHistograms(sess, width) {
  const base = Math.floor(PMIN / width) - 2;
  const nb = Math.ceil((PMAX - PMIN) / width) + 6;
  const hist = [];
  for (const s of sess) {
    const h = new Float64Array(nb);
    for (let i = s.from; i < s.to; i++) {
      const b = bars[i];
      const v = Number.isFinite(b.v) && b.v > 0 ? b.v : 1;
      const a = Math.floor(b.l / width) - base;
      const z = Math.floor(b.h / width) - base;
      const lo = Math.max(0, Math.min(nb - 1, a)), hi = Math.max(0, Math.min(nb - 1, z));
      const share = v / (hi - lo + 1);
      for (let q = lo; q <= hi; q++) h[q] += share;
    }
    hist.push(h);
  }
  return { hist, base, nb };
}

/**
 * Read POC / VAH / VAL / LVN off a summed histogram.
 *
 * Value area follows the classic construction: start at the point of control,
 * repeatedly annex whichever pair of buckets (two above, two below) carries
 * more volume, until `vaPct` of the session's volume is enclosed. VAH and VAL
 * are the outer faces of the enclosing buckets — the edges of the auction.
 */
function readProfile(h, base, width, vaPct = 0.70) {
  let total = 0, poc = -1, best = -1;
  let lo = -1, hi = -1;
  for (let q = 0; q < h.length; q++) {
    const v = h[q];
    total += v;
    if (v > 0) { if (lo < 0) lo = q; hi = q; }
    if (v > best) { best = v; poc = q; }
  }
  if (poc < 0 || total <= 0) return null;
  const px = q => (base + q + 0.5) * width;

  let a = poc, b = poc, acc = h[poc];
  const target = total * vaPct;
  while (acc < target && (a > lo || b < hi)) {
    const up = (b + 1 <= hi ? h[b + 1] : 0) + (b + 2 <= hi ? h[b + 2] : 0);
    const dn = (a - 1 >= lo ? h[a - 1] : 0) + (a - 2 >= lo ? h[a - 2] : 0);
    if (b >= hi && a <= lo) break;
    if (b < hi && (up >= dn || a <= lo)) { b = Math.min(hi, b + 2); acc += up; }
    else { a = Math.max(lo, a - 2); acc += dn; }
  }
  // emptiest bucket inside the value area's outer half — the low volume node
  let lvn = -1, lvnV = Infinity;
  for (let q = lo + 1; q < hi; q++) if (h[q] < lvnV) { lvnV = h[q]; lvn = q; }

  return {
    poc: px(poc),
    vah: (base + b + 1) * width,
    val: (base + a) * width,
    lvn: lvn >= 0 ? px(lvn) : NaN,
    hi: (base + hi + 1) * width,
    lo: (base + lo) * width,
    mid: ((base + hi + 1) * width + (base + lo) * width) / 2,   // geometry, no volume
    total,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Level construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fixed levels from completed sessions.
 *
 *   window   how many completed sessions the profile covers
 *   hold     how many following sessions the level stays live
 *   kinds    which readings of the profile to emit
 *
 * Every level carries the bar index at which its defining data ended
 * (`knownAt`) and the half-open bar range over which it is live. `knownAt` is
 * always <= from, which is the whole causality claim and is asserted in `final`.
 */
function profileLevels(opts = {}) {
  const anchorMin = opts.anchorMin ?? 0;
  const width = opts.width ?? 0.25;
  const window = opts.window ?? 1;
  const hold = opts.hold ?? 1;
  const kinds = opts.kinds ?? ['poc', 'vah', 'val'];
  const vaPct = opts.vaPct ?? 0.70;
  const shift = opts.shift ?? 0;         // >0 = deliberate lookahead, for the control
  const jitter = opts.jitter ?? null;    // rng: random price anywhere in the session's range
  const nudge = opts.nudge ?? null;      // rng: same level, displaced 5-20% of the range —
                                         // the POSITION-MATCHED control. It keeps "a level in
                                         // that part of yesterday's range" and destroys only
                                         // the volume information that picked the exact price.

  const sess = sessions(anchorMin);
  const { hist, base, nb } = sessionHistograms(sess, width);
  const out = [];
  for (let s = window; s < sess.length; s++) {
    const src = s + shift;                       // shift>0 reads sessions that have not happened
    if (src > sess.length - 1) break;
    const h = new Float64Array(nb);
    for (let k = src - window; k < src; k++) { const g = hist[k]; for (let q = 0; q < nb; q++) h[q] += g[q]; }
    const p = readProfile(h, base, width, vaPct);
    if (!p) continue;
    const knownAt = sess[src - 1].to;            // last bar of the profile window, exclusive
    const from = sess[s].from;
    const to = sess[Math.min(sess.length - 1, s + hold - 1)].to;
    for (const kind of kinds) {
      let v = p[kind];
      if (jitter) v = p.lo + jitter() * (p.hi - p.lo);
      else if (nudge && Number.isFinite(v)) {
        const span = p.hi - p.lo;
        const off = (0.05 + nudge() * 0.15) * span * (nudge() < 0.5 ? -1 : 1);
        v = Math.min(p.hi, Math.max(p.lo, v + off));
      }
      if (!Number.isFinite(v)) continue;
      // `center` is the point of control of the same profile. It is what makes the
      // "trade back toward value" reading possible: the edge alone does not say
      // which way is inward, the distribution does.
      out.push({ value: v, kind, from, to, knownAt, session: s, center: p[opts.centerKind ?? 'poc'] });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Events against ONE fixed level, inside its live window
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Semantics copied line for line from tools/level_events.js:levelTestEvents,
 * with the level held constant (so the "level changed" reset can never fire)
 * and restricted to the bar range in which the level is live.
 */
function constLevelEvents(b, atr, L, from, to, opts) {
  const tolAtr = opts.tolAtr ?? 0.20;
  const approachAtr = opts.approachAtr ?? 1.5;
  const breakAtr = opts.breakAtr ?? 0.25;
  const resetAtr = opts.resetAtr ?? 1.0;
  const firstOnly = opts.firstOnly ?? false;
  const events = [];
  let approached = false, locked = false;
  for (let i = Math.max(1, from); i < to; i++) {
    const a = atr[i];
    if (!Number.isFinite(a) || a <= 0) continue;
    const bar = b[i];
    const tol = a * tolAtr;
    const dist = Math.abs(bar.c - L);
    if (locked && dist > a * resetAtr) locked = false;
    if (dist >= a * approachAtr) approached = true;
    if (!approached || locked) continue;

    const fromAbove = b[i - 1].c > L;
    const reached = fromAbove ? bar.l <= L + tol : bar.h >= L - tol;
    if (!reached) continue;

    if (fromAbove) {
      if (bar.c > L + tol * 0.5) events.push({ i, dir: 1, kind: 'reject', level: L });
      else if (bar.c < L - a * breakAtr) events.push({ i, dir: -1, kind: 'break', level: L });
      else continue;
    } else {
      if (bar.c < L - tol * 0.5) events.push({ i, dir: -1, kind: 'reject', level: L });
      else if (bar.c > L + a * breakAtr) events.push({ i, dir: 1, kind: 'break', level: L });
      else continue;
    }
    locked = true;
    approached = false;
    if (firstOnly) break;
  }
  return events;
}

/**
 * All events for a set of fixed levels, detected on `minutes` candles and
 * stamped on the 1m bar at which that candle closed. Two levels cannot honestly
 * be tested by one candle, so same-bar collisions keep the nearer level.
 */
function levelEvents(levels, opts = {}) {
  const minutes = opts.minutes ?? 1;
  const { bars: b, index, lastOf, atr } = tf(minutes);
  const all = [];
  for (const L of levels) {
    let f = L.from, t = L.to;
    if (minutes !== 1) {
      f = index[L.from];
      t = Math.min(b.length, index[Math.min(N - 1, L.to - 1)] + 1);
    }
    for (const e of constLevelEvents(b, atr, L.value, f, t, opts)) {
      const i1 = minutes === 1 ? e.i : lastOf[e.i];
      if (i1 < 1 || i1 >= N - 2) continue;
      if (i1 < L.knownAt) throw new Error('causality: event before level was known');
      const inward = L.center > L.value ? 1 : L.center < L.value ? -1 : 0;
      all.push({ i: i1, dir: e.dir, kind: e.kind, level: e.level, src: L.kind, session: L.session, inward });
    }
  }
  all.sort((x, y) => x.i - y.i || x.level - y.level);
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

/**
 * How to trade a test.
 *
 *   as-is        whatever the engine classified: reject = away from the level,
 *                break = through it
 *   reject/break the same, restricted to one classification
 *   flip         the opposite of as-is, everywhere
 *   to-value     ignore the classification entirely and always trade INWARD,
 *                toward the point of control of the profile the edge came from.
 *                At the value area high that is always a short; at the value
 *                area low always a long. This is the auction reading: the edges
 *                are where the market stopped accepting price, so price is
 *                expected to be returned to value.
 *   from-value   the breakout reading — always trade OUTWARD, away from the POC
 *   to-value-reject   to-value, but only on tests the engine called a rejection
 */
function applyReading(events, reading) {
  if (reading === 'as-is') return events;
  if (reading === 'reject') return events.filter(e => e.kind === 'reject');
  if (reading === 'break') return events.filter(e => e.kind === 'break');
  if (reading === 'flip') return events.map(e => ({ ...e, dir: -e.dir }));
  if (reading === 'reject-flip') return events.filter(e => e.kind === 'reject').map(e => ({ ...e, dir: -e.dir }));
  if (reading === 'break-flip') return events.filter(e => e.kind === 'break').map(e => ({ ...e, dir: -e.dir }));
  if (reading === 'to-value') return events.filter(e => e.inward !== 0).map(e => ({ ...e, dir: e.inward }));
  if (reading === 'from-value') return events.filter(e => e.inward !== 0).map(e => ({ ...e, dir: -e.inward }));
  if (reading === 'to-value-reject') return events.filter(e => e.inward !== 0 && e.kind === 'reject').map(e => ({ ...e, dir: e.inward }));
  if (reading === 'to-value-break') return events.filter(e => e.inward !== 0 && e.kind === 'break').map(e => ({ ...e, dir: e.inward }));
  throw new Error('reading?');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Excursion
// ─────────────────────────────────────────────────────────────────────────────

function excursion(events, horizons = [30, 60, 120, 240, 480]) {
  const H = Math.max(...horizons);
  const mfe = horizons.map(() => []), mae = horizons.map(() => []);
  for (const e of events) {
    const entry = bars[e.i].c;
    let f = 0, a = 0, hi = 0;
    const end = Math.min(N - 1, e.i + H);
    for (let j = e.i + 1; j <= end; j++) {
      const b = bars[j];
      const fv = e.dir === 1 ? (b.h - entry) / PU : (entry - b.l) / PU;
      const av = e.dir === 1 ? (entry - b.l) / PU : (b.h - entry) / PU;
      if (fv > f) f = fv;
      if (av > a) a = av;
      while (hi < horizons.length && j - e.i >= horizons[hi]) { mfe[hi].push(f); mae[hi].push(a); hi++; }
    }
    while (hi < horizons.length) { mfe[hi].push(f); mae[hi].push(a); hi++; }
  }
  const q = (arr, p) => { if (!arr.length) return NaN; const s = arr.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  return horizons.map((h, k) => ({
    h,
    mfeMed: q(mfe[k], 0.5), mfeQ25: q(mfe[k], 0.25), mfeQ75: q(mfe[k], 0.75),
    maeMed: q(mae[k], 0.5), maeQ25: q(mae[k], 0.25), maeQ75: q(mae[k], 0.75),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Reporting helpers
// ─────────────────────────────────────────────────────────────────────────────
const f = (x, d = 2) => Number.isFinite(x) ? (x >= 0 && d > 0 ? '' : '') + x.toFixed(d) : '—';
const sg = (x, d = 2) => Number.isFinite(x) ? ((x > 0 ? '+' : '') + x.toFixed(d)) : '—';

// ─────────────────────────────────────────────────────────────────────────────
//  Stages
// ─────────────────────────────────────────────────────────────────────────────

function stageProbe() {
  console.log(`bars ${N.toLocaleString()}  ${new Date(bars[0].t).toISOString()} .. ${new Date(bars[N - 1].t).toISOString()}`);
  console.log(`price ${PMIN.toFixed(2)} .. ${PMAX.toFixed(2)}`);
  let vz = 0, vs = 0, vmax = 0;
  for (const b of bars) { if (!(b.v > 0)) vz++; vs += b.v || 0; if (b.v > vmax) vmax = b.v; }
  console.log(`volume: zero/absent on ${vz} bars, mean ${(vs / N).toFixed(1)}, max ${vmax}`);
  const hourCount = new Array(24).fill(0);
  for (const b of bars) hourCount[new Date(b.t).getUTCHours()]++;
  console.log('bars per UTC hour: ' + hourCount.map((c, h) => `${h}:${c}`).join(' '));
  for (const anchor of [0, 1320, 780]) {
    const s = sessions(anchor);
    const lens = s.map(x => x.to - x.from);
    lens.sort((a, b) => a - b);
    console.log(`anchor ${String(anchor).padStart(4)}min: ${s.length} sessions, bars min ${lens[0]} med ${lens[lens.length >> 1]} max ${lens[lens.length - 1]}`);
  }
  const a = atr1.filter(Number.isFinite);
  a.sort((x, y) => x - y);
  console.log(`1m ATR14 median ${a[a.length >> 1].toFixed(3)} USD = ${(a[a.length >> 1] / PU).toFixed(1)} points`);
  console.log(`blind long ${sg(blind(1, 90, 90, 1440))}  blind short ${sg(blind(-1, 90, 90, 1440))}  (should be about -4.8 / +4.3)`);
  // cross-check firstHits against the reference race
  const r = rng(999); let bad = 0;
  for (let k = 0; k < 2000; k++) {
    const i = 100 + Math.floor(r() * (N - 2000));
    const dir = r() < 0.5 ? 1 : -1;
    const thr = [20, 40, 90];
    const h = firstHits(i, dir, 1440, thr);
    for (let a2 = 0; a2 < 3; a2++) for (let b2 = 0; b2 < 3; b2++) {
      const x = resolve(h, a2, b2, thr), y = race(i, dir, thr[a2], thr[b2], 1440);
      if (x === null && y === null) continue;
      if (x === null || y === null || Math.abs(x - y) > 1e-6) bad++;
    }
  }
  console.log(`firstHits vs reference race: ${bad} disagreements in 18000 checks`);

  // Does the volume column carry information, or is this really a TIME profile?
  const rngs = [], vols = [];
  for (const b of bars) { rngs.push(b.h - b.l); vols.push(b.v); }
  const corr = (x, y) => {
    const n = x.length, mx = x.reduce((a, c) => a + c, 0) / n, my = y.reduce((a, c) => a + c, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return sxy / Math.sqrt(sxx * syy);
  };
  console.log(`corr(volume, bar range) = ${corr(vols, rngs).toFixed(3)}`);
  const hv = new Array(24).fill(0), hc = new Array(24).fill(0);
  for (const b of bars) { const h = new Date(b.t).getUTCHours(); hv[h] += b.v; hc[h]++; }
  const means = hv.map((v, i) => hc[i] ? v / hc[i] : 0).filter(x => x > 0);
  console.log(`hourly mean volume: min ${Math.min(...means).toFixed(0)} max ${Math.max(...means).toFixed(0)} (flat = no session seasonality)`);
  // profile built on volume vs profile built on time (volume forced to 1)
  const sess = sessions(0);
  const { hist: hVol, base: bV } = sessionHistograms(sess, 0.25);
  const saveV = bars.map(b => b.v);
  for (const b of bars) b.v = 1;
  const { hist: hTime, base: bT } = sessionHistograms(sess, 0.25);
  for (let i = 0; i < N; i++) bars[i].v = saveV[i];
  let dPoc = 0, dVah = 0, k = 0;
  for (let s = 0; s < sess.length; s++) {
    const a = readProfile(hVol[s], bV, 0.25), b = readProfile(hTime[s], bT, 0.25);
    if (!a || !b) continue;
    dPoc += Math.abs(a.poc - b.poc); dVah += Math.abs(a.vah - b.vah); k++;
  }
  console.log(`volume profile vs pure TIME profile: mean |ΔPOC| ${(dPoc / k).toFixed(2)} USD, mean |ΔVAH| ${(dVah / k).toFixed(2)} USD`);
  console.log(`(if these are near zero the "volume" node is really a time-at-price node)`);
}

function stageCurrent() {
  console.log('THE CURRENT CONSTRUCTION — rolling POC of the trailing 1440 bars, recomputed every 60\n');
  console.log('tf     look  step   tests  respect  short%    raw    alpha(90/90)');
  console.log('─'.repeat(64));
  const rows = [];
  for (const m of [1, 5, 15, 60, 240, 1440]) {
    const look = Math.max(20, Math.round(1440 / m));
    const step = Math.max(1, Math.round(60 / m));
    const { bars: b, index, atr } = m === 1 ? { bars, index: null, atr: atr1 } : tf(m);
    if (b.length < look + 50) { console.log(`${TF_NAME[m].padEnd(6)} ${String(look).padStart(4)}  ${String(step).padStart(4)}   (not enough candles)`); continue; }
    const raw = LV.volumeNodeLevels(b, { look, step, buckets: 120 }).line;
    const line = m === 1 ? raw : E.projectConfirmed(raw, index);
    const ev = levelTestEvents(bars, line, atr1);
    const s = score(ev, TP0, SL0, MAX_HOLD);
    rows.push({ m, s });
    console.log(`${TF_NAME[m].padEnd(6)} ${String(look).padStart(4)}  ${String(step).padStart(4)}  ${String(s.tests).padStart(6)}  ${f(s.respect, 1).padStart(7)}  ${f(s.shortShare, 1).padStart(6)}  ${sg(s.raw).padStart(7)}  ${sg(s.alpha).padStart(8)}`);
  }
  const one = rows.find(r => r.m === 1);
  console.log(`\nheadline "before" (the construction as shipped, 1m, 90/90): alpha ${sg(one.s.alpha)} over ${one.s.tests} tests, respect ${f(one.s.respect, 1)}%`);
  const best = rows.filter(r => r.s.tests >= 100).sort((a, b) => b.s.alpha - a.s.alpha)[0];
  console.log(`best timeframe for the OLD construction: ${TF_NAME[best.m]}  alpha ${sg(best.s.alpha)} over ${best.s.tests} tests`);
}

function sweepRow(tag, levels, opts, tp = TP0, sl = SL0, hold = MAX_HOLD) {
  const ev = levelEvents(levels, opts);
  const s = score(applyReading(ev, opts.reading ?? 'as-is'), tp, sl, hold);
  return { tag, s, n: levels.length };
}

function stageProfile() {
  console.log('FIXED SESSION PROFILE — levels from a completed auction, scored at 90/90 for comparability\n');
  console.log('anchor width window hold kind    lvls  tests respect short%   alpha');
  console.log('─'.repeat(72));
  const results = [];
  for (const anchorMin of [0, 1320]) {
    for (const width of [0.10, 0.25, 0.50]) {
      for (const window of [1, 2, 5]) {
        for (const hold of [1, 2]) {
          for (const kind of ['poc', 'vah', 'val', 'lvn']) {
            const levels = profileLevels({ anchorMin, width, window, hold, kinds: [kind] });
            const r = sweepRow('', levels, { minutes: 1 });
            results.push({ anchorMin, width, window, hold, kind, ...r });
            if (r.s.tests < 60) continue;
            console.log(`${String(anchorMin).padStart(6)} ${width.toFixed(2).padStart(5)} ${String(window).padStart(6)} ${String(hold).padStart(4)} ${kind.padEnd(6)} ${String(r.n).padStart(5)} ${String(r.s.tests).padStart(6)} ${f(r.s.respect, 1).padStart(7)} ${f(r.s.shortShare, 1).padStart(6)} ${sg(r.s.alpha).padStart(8)}`);
          }
        }
      }
    }
  }
  console.log('\nTop by alpha with >= 100 tests:');
  results.filter(r => r.s.tests >= 100).sort((a, b) => b.s.alpha - a.s.alpha).slice(0, 12)
    .forEach(r => console.log(`  anchor ${r.anchorMin} w${r.width} win${r.window} hold${r.hold} ${r.kind.padEnd(4)}  ${String(r.s.tests).padStart(5)} tests  respect ${f(r.s.respect, 1)}%  alpha ${sg(r.s.alpha)}`));
  console.log('\nTop by respect with >= 100 tests:');
  results.filter(r => r.s.tests >= 100).sort((a, b) => b.s.respect - a.s.respect).slice(0, 8)
    .forEach(r => console.log(`  anchor ${r.anchorMin} w${r.width} win${r.window} hold${r.hold} ${r.kind.padEnd(4)}  ${String(r.s.tests).padStart(5)} tests  respect ${f(r.s.respect, 1)}%  alpha ${sg(r.s.alpha)}`));
  console.log('\nEdges (vah+val) vs peak (poc), pooled, anchor 0 width 0.25 hold 1:');
  for (const window of [1, 2, 5]) {
    const edges = profileLevels({ anchorMin: 0, width: 0.25, window, hold: 1, kinds: ['vah', 'val'] });
    const peak = profileLevels({ anchorMin: 0, width: 0.25, window, hold: 1, kinds: ['poc'] });
    const e = sweepRow('', edges, { minutes: 1 }), p = sweepRow('', peak, { minutes: 1 });
    console.log(`  window ${window}: edges ${String(e.s.tests).padStart(4)} tests respect ${f(e.s.respect, 1)}% alpha ${sg(e.s.alpha)}   |   poc ${String(p.s.tests).padStart(4)} tests respect ${f(p.s.respect, 1)}% alpha ${sg(p.s.alpha)}`);
  }
}

function parseCfg(argv) {
  const o = {
    anchorMin: 0, width: 0.25, window: 1, hold: 1, kinds: ['vah', 'val'],
    minutes: 1, reading: 'as-is', approachAtr: 1.5, tolAtr: 0.20,
    firstOnly: 0, vaPct: 0.70,
  };
  for (const a of argv) {
    const [k, v] = a.split('=');
    if (k === 'kinds') o.kinds = v.split('+');
    else if (k === 'reading') o.reading = v;
    else if (k in o) o[k] = +v;
  }
  o.firstOnly = !!o.firstOnly;
  return o;
}

/** One configuration end to end: levels → events → reading → direction-adjusted score. */
function run(cfg, tp = TP0, sl = SL0, maxHold = MAX_HOLD, extra = {}) {
  const levels = profileLevels({ ...cfg, ...extra });
  const ev = applyReading(levelEvents(levels, cfg), cfg.reading);
  return { levels, ev, s: score(ev, tp, sl, maxHold) };
}

/**
 * The control that actually matters: a level placed at a RANDOM price inside
 * the same completed session's range, live over the same window, tested by the
 * same engine at the same tolerance and approach. If the volume node carries
 * information, it must beat this — not the 68.95% global random-level number,
 * which was measured with different tolerances on a different level population.
 */
function control(cfg, tp, sl, maxHold, seeds = 10, mode = 'jitter') {
  let n = 0, alpha = 0, respect = 0, tests = 0;
  const as = [], rs = [];
  for (let k = 1; k <= seeds; k++) {
    const r = run(cfg, tp, sl, maxHold, { [mode]: rng(k * 7919 + 13) });
    if (r.s.traded < 30) continue;
    n++; alpha += r.s.alpha; respect += r.s.respect; tests += r.s.tests;
    as.push(r.s.alpha); rs.push(r.s.respect);
  }
  const m = x => x.reduce((a, b) => a + b, 0) / x.length;
  const sd = x => { const u = m(x); return Math.sqrt(x.reduce((a, b) => a + (b - u) * (b - u), 0) / Math.max(1, x.length - 1)); };
  return { seeds: n, alpha: alpha / n, respect: respect / n, tests: tests / n, alphaSd: sd(as), respectSd: sd(rs) };
}

function stageTf(argv) {
  const base = parseCfg(argv);
  console.log(`DETECTION TIMEFRAME SWEEP  (${JSON.stringify(base)})\n`);
  console.log('kinds        tf   tests respect short%    alpha');
  console.log('─'.repeat(52));
  for (const kinds of [['poc'], ['vah', 'val'], ['poc', 'vah', 'val']]) {
    for (const m of [1, 5, 15, 60]) {
      const levels = profileLevels({ ...base, kinds });
      const r = sweepRow('', levels, { ...base, kinds, minutes: m });
      console.log(`${kinds.join('+').padEnd(12)} ${TF_NAME[m].padStart(3)}  ${String(r.s.tests).padStart(6)} ${f(r.s.respect, 1).padStart(7)} ${f(r.s.shortShare, 1).padStart(6)} ${sg(r.s.alpha).padStart(8)}`);
    }
  }
  console.log('\napproach / tolerance sweep (1m detection, kinds as configured):');
  console.log('appr  tol   tests respect    alpha');
  for (const approachAtr of [1.0, 1.5, 2.5, 4.0]) {
    for (const tolAtr of [0.10, 0.20, 0.40]) {
      const levels = profileLevels(base);
      const r = sweepRow('', levels, { ...base, minutes: 1, approachAtr, tolAtr });
      console.log(`${approachAtr.toFixed(1).padStart(4)} ${tolAtr.toFixed(2).padStart(5)}  ${String(r.s.tests).padStart(6)} ${f(r.s.respect, 1).padStart(7)} ${sg(r.s.alpha).padStart(8)}`);
    }
  }
}

/**
 * Every candidate definition measured against its OWN matched control, so the
 * comparison is level-vs-random-level-in-the-same-place rather than
 * level-vs-a-global-constant.
 */
function stageCompare(argv) {
  const base = parseCfg(argv);
  const tp = +(argv.find(a => a.startsWith('tp=')) || 'tp=90').split('=')[1];
  const sl = +(argv.find(a => a.startsWith('sl=')) || 'sl=90').split('=')[1];
  const maxHold = +(argv.find(a => a.startsWith('maxHold=')) || 'maxHold=240').split('=')[1];
  console.log(`LEVEL vs MATCHED CONTROL   tp ${tp} sl ${sl} hold ${maxHold}  reading ${base.reading}`);
  console.log('control = a random price inside the same completed session\'s range, same window, same engine\n');
  const CFGS = [];
  for (const kinds of [['poc'], ['vah', 'val'], ['vah'], ['val'], ['lvn']])
    for (const minutes of [1, 5, 15])
      for (const approachAtr of [1.5, 2.5, 4.0])
        CFGS.push({ ...base, kinds, minutes, approachAtr });

  console.log('kind      tf  appr    tests  respect  ctrl-resp   Δresp     alpha   ctrl-alpha    Δalpha      t');
  console.log('─'.repeat(100));
  const rows = [];
  for (const c of CFGS) {
    const r = run(c, tp, sl, maxHold);
    if (r.s.traded < 100) continue;
    const k = control(c, tp, sl, maxHold, 10);
    const row = { c, s: r.s, k, dR: r.s.respect - k.respect, dA: r.s.alpha - k.alpha };
    rows.push(row);
    console.log(
      `${c.kinds.join('+').padEnd(8)} ${TF_NAME[c.minutes].padStart(3)} ${c.approachAtr.toFixed(1).padStart(4)} ` +
      `${String(r.s.tests).padStart(7)} ${f(r.s.respect, 1).padStart(8)} ${f(k.respect, 1).padStart(10)} ${sg(row.dR, 1).padStart(7)} ` +
      `${sg(r.s.alpha).padStart(9)} ${sg(k.alpha).padStart(11)} ${sg(row.dA).padStart(9)} ${sg(r.s.t, 2).padStart(6)}`);
  }
  console.log('\nranked by alpha over the matched control:');
  rows.sort((a, b) => b.dA - a.dA).slice(0, 10).forEach(r =>
    console.log(`  ${r.c.kinds.join('+').padEnd(8)} ${TF_NAME[r.c.minutes]} appr${r.c.approachAtr}  ${r.s.tests} tests  Δalpha ${sg(r.dA)}  Δrespect ${sg(r.dR, 1)}  t ${sg(r.s.t, 2)}`));
  console.log('\nranked by respect over the matched control:');
  rows.sort((a, b) => b.dR - a.dR).slice(0, 10).forEach(r =>
    console.log(`  ${r.c.kinds.join('+').padEnd(8)} ${TF_NAME[r.c.minutes]} appr${r.c.approachAtr}  ${r.s.tests} tests  Δrespect ${sg(r.dR, 1)} (level ${f(r.s.respect, 1)}% vs ctrl ${f(r.k.respect, 1)}±${f(r.k.respectSd, 1)})  Δalpha ${sg(r.dA)}`));
}

/**
 * The decisive experiment for the value-area high.
 *
 * VAH earns a positive direction-adjusted alpha at every timeframe and every
 * approach setting, which is the only consistent signal in the whole sweep. But
 * VAH is systematically in the UPPER part of yesterday's range, and the sample
 * is a falling market, so "a level above price that price rallies into" could
 * be a trend effect wearing a volume costume. Three controls separate them:
 *
 *   uniform   a random price anywhere in yesterday's range
 *   nudged    the SAME level displaced 5-20% of the range — same neighbourhood,
 *             same side of the auction, volume information destroyed
 *   pdh/pdl   yesterday's plain high and low, no volume involved at all
 *
 * If VAH does not beat `nudged`, the volume profile contributed nothing.
 */
function stageDecisive(argv) {
  const base = parseCfg(argv);
  const tp = +(argv.find(a => a.startsWith('tp=')) || 'tp=90').split('=')[1];
  const sl = +(argv.find(a => a.startsWith('sl=')) || 'sl=90').split('=')[1];
  const maxHold = +(argv.find(a => a.startsWith('maxHold=')) || 'maxHold=240').split('=')[1];
  console.log(`DECISIVE — is it the volume, or just the place?   tp ${tp} sl ${sl} hold ${maxHold} reading ${base.reading}`);
  console.log('nudged = the same level displaced 5-20% of the range: same neighbourhood, same inward');
  console.log('direction, volume information destroyed. The level must beat it to have earned anything.\n');
  for (const minutes of [1, 5]) {
    for (const approachAtr of [1.5, 2.5]) {
      console.log(`── detection ${TF_NAME[minutes]}, approach ${approachAtr} ATR ──`);
      console.log('  level        tests  respect   alpha      t     short%    uniform-ctrl   nudged-ctrl   level-minus-nudged');
      for (const kinds of [['vah'], ['val'], ['vah', 'val'], ['lvn'], ['poc'], ['hi'], ['lo']]) {
        const c = { ...base, kinds, minutes, approachAtr };
        const r = run(c, tp, sl, maxHold);
        const nm = kinds.join('+');
        if (r.s.traded < 60) { console.log(`  ${nm.padEnd(10)} ${String(r.s.tests).padStart(6)}  (too few)`); continue; }
        const u = control(c, tp, sl, maxHold, 10, 'jitter');
        const g = control(c, tp, sl, maxHold, 10, 'nudge');
        console.log(
          `  ${nm.padEnd(10)} ${String(r.s.tests).padStart(6)} ${f(r.s.respect, 1).padStart(8)} ${sg(r.s.alpha).padStart(8)} ${sg(r.s.t, 2).padStart(6)} ${f(r.s.shortShare, 1).padStart(9)}` +
          `   ${sg(u.alpha).padStart(8)}±${f(u.alphaSd / Math.sqrt(Math.max(1, u.seeds)), 1)}  ${sg(g.alpha).padStart(8)}±${f(g.alphaSd / Math.sqrt(Math.max(1, g.seeds)), 1)}  ${sg(r.s.alpha - g.alpha).padStart(8)}`);
      }
      // geometry-only variant: the same edges, but inward defined by the mid of the
      // range instead of the point of control — does the distribution add anything?
      const cg = { ...base, kinds: ['hi', 'lo'], minutes, approachAtr, centerKind: 'mid' };
      const rg = run(cg, tp, sl, maxHold);
      console.log(`  [geometry] session hi/lo faded to range mid: ${rg.s.tests} tests  alpha ${sg(rg.s.alpha)}  t ${sg(rg.s.t, 2)}`);
      const cm = { ...base, kinds: ['vah', 'val'], minutes, approachAtr, centerKind: 'mid' };
      const rm = run(cm, tp, sl, maxHold);
      console.log(`  [geometry] VA edges faded to range mid instead of POC: ${rm.s.tests} tests  alpha ${sg(rm.s.alpha)}  t ${sg(rm.s.t, 2)}`);
      console.log('');
    }
  }
}

/**
 * Robustness across the nuisance parameters.
 *
 * The bucket width, the value-area percentage, the session anchor and the
 * profile window are all arbitrary choices. A real effect survives them; a
 * sweep artefact is one lucky cell. This prints the SIGN COUNT and the mean
 * alpha per level kind across the whole nuisance grid, which is the only
 * defensible way to read a sweep this wide.
 */
function stageRobust(argv) {
  const base = parseCfg(argv);
  const tp = +(argv.find(a => a.startsWith('tp=')) || 'tp=90').split('=')[1];
  const sl = +(argv.find(a => a.startsWith('sl=')) || 'sl=90').split('=')[1];
  const maxHold = +(argv.find(a => a.startsWith('maxHold=')) || 'maxHold=240').split('=')[1];
  console.log(`ROBUSTNESS ACROSS NUISANCE PARAMETERS   tp ${tp} sl ${sl} hold ${maxHold} reading ${base.reading}`);
  console.log('grid: anchor {0,1320} x width {0.10,0.25,0.50,1.00} x window {1,2,3} x vaPct {0.68,0.70,0.80} x tf {1,5}\n');
  const acc = new Map();
  for (const kind of ['poc', 'vah', 'val', 'lvn']) acc.set(kind, []);
  for (const anchorMin of [0, 1320])
    for (const width of [0.10, 0.25, 0.50, 1.00])
      for (const window of [1, 2, 3])
        for (const vaPct of [0.68, 0.70, 0.80])
          for (const minutes of [1, 5])
            for (const kind of ['poc', 'vah', 'val', 'lvn']) {
              const c = { ...base, anchorMin, width, window, vaPct, minutes, kinds: [kind] };
              const r = run(c, tp, sl, maxHold);
              if (r.s.traded < 80) continue;
              acc.get(kind).push({ a: r.s.alpha, n: r.s.traded, respect: r.s.respect, t: r.s.t, aL: r.s.alphaLong, aS: r.s.alphaShort, lc: r.s.longs, sc: r.s.shorts });
            }
  console.log('kind   cells   pos/neg   mean alpha   median   worst    best   pooled-t   mean respect');
  console.log('─'.repeat(92));
  for (const [kind, list] of acc) {
    if (!list.length) { console.log(`${kind}: no cell reached 80 trades`); continue; }
    const as = list.map(x => x.a).sort((p, q) => p - q);
    const pos = list.filter(x => x.a > 0).length;
    const mean = as.reduce((p, q) => p + q, 0) / as.length;
    // pooled t: weight each cell by its own precision
    let num = 0, den = 0;
    for (const x of list) { const w = x.n; num += x.a * w; den += w; }
    const pooledT = list.reduce((p, x) => p + x.t * Math.sqrt(x.n), 0) / Math.sqrt(list.reduce((p, x) => p + x.n, 0));
    const mr = list.reduce((p, x) => p + x.respect, 0) / list.length;
    console.log(`${kind.padEnd(6)} ${String(list.length).padStart(5)}   ${String(pos).padStart(3)}/${String(list.length - pos).padEnd(3)}  ${sg(mean).padStart(10)} ${sg(as[as.length >> 1]).padStart(8)} ${sg(as[0]).padStart(8)} ${sg(as[as.length - 1]).padStart(7)}   ${sg(pooledT, 2).padStart(8)}   ${f(mr, 1).padStart(10)}`);
  }
  console.log('\nlong / short split of each kind (pooled over the grid):');
  for (const [kind, list] of acc) {
    if (!list.length) continue;
    let ln = 0, la = 0, sn = 0, sa = 0;
    for (const x of list) { if (x.lc) { la += x.aL * x.lc; ln += x.lc; } if (x.sc) { sa += x.aS * x.sc; sn += x.sc; } }
    console.log(`  ${kind.padEnd(5)} long ${sg(la / ln).padStart(7)} (n=${ln})   short ${sg(sa / sn).padStart(7)} (n=${sn})`);
  }
}

/**
 * The chosen target, re-run over every nuisance parameter, with the strict
 * month-local direction adjustment and a multi-seed position-matched control in
 * every cell. This is the number to believe, not the peak of any sweep.
 */
function stageConfirm(argv) {
  const base = parseCfg(argv);
  const tp = +(argv.find(a => a.startsWith('tp=')) || 'tp=150').split('=')[1];
  const sl = +(argv.find(a => a.startsWith('sl=')) || 'sl=150').split('=')[1];
  const maxHold = +(argv.find(a => a.startsWith('maxHold=')) || 'maxHold=240').split('=')[1];
  const mb = monthBlocks();
  console.log(`CONFIRMATION at the chosen target  tp ${tp} sl ${sl} hold ${maxHold} reading ${base.reading}`);
  console.log('month-local direction adjustment; control = position-matched nudge, 6 seeds per cell\n');
  console.log('anchor width window vaPct  tf   tests    alpha      t   ctrl   edge');
  console.log('─'.repeat(70));
  const cells = [];
  for (const anchorMin of [0, 1320])
    for (const width of [0.10, 0.25, 0.50, 1.00])
      for (const window of [1, 2, 3])
        for (const vaPct of [0.68, 0.70, 0.80])
          for (const minutes of [1, 5]) {
            const c = { ...base, anchorMin, width, window, vaPct, minutes, kinds: ['vah', 'val'] };
            const r = run(c, tp, sl, maxHold);
            if (r.ev.length < 100) continue;
            const q = scoreLocal(r.ev, tp, sl, maxHold, mb);
            let cs = 0, cn = 0;
            for (let k = 1; k <= 6; k++) {
              const g = run(c, tp, sl, maxHold, { nudge: rng(k * 7919 + 13) });
              if (g.ev.length < 50) continue;
              cs += scoreLocal(g.ev, tp, sl, maxHold, mb).alpha; cn++;
            }
            const ctrl = cn ? cs / cn : NaN;
            cells.push({ c, q, ctrl, edge: q.alpha - ctrl });
            console.log(`${String(anchorMin).padStart(6)} ${width.toFixed(2).padStart(5)} ${String(window).padStart(6)} ${vaPct.toFixed(2).padStart(6)} ${TF_NAME[minutes].padStart(3)} ${String(q.traded).padStart(6)} ${sg(q.alpha).padStart(8)} ${sg(q.t, 2).padStart(6)} ${sg(ctrl).padStart(6)} ${sg(q.alpha - ctrl).padStart(6)}`);
          }
  const as = cells.map(x => x.q.alpha).sort((p, q2) => p - q2);
  const es = cells.map(x => x.edge).sort((p, q2) => p - q2);
  const mean = a => a.reduce((p, q2) => p + q2, 0) / a.length;
  console.log(`\ncells ${cells.length}`);
  console.log(`alpha:  positive in ${cells.filter(x => x.q.alpha > 0).length}/${cells.length}   mean ${sg(mean(as))}   median ${sg(as[as.length >> 1])}   range ${sg(as[0])} .. ${sg(as[as.length - 1])}`);
  console.log(`edge over the position-matched control: positive in ${cells.filter(x => x.edge > 0).length}/${cells.length}   mean ${sg(mean(es))}   median ${sg(es[es.length >> 1])}   range ${sg(es[0])} .. ${sg(es[es.length - 1])}`);
  // pool every cell's events into one sample, deduplicated by (bar, direction)
  const seen = new Set(); const pool = [];
  for (const x of cells) for (const e of run(x.c, tp, sl, maxHold).ev) {
    const k = `${e.i}|${e.dir}`;
    if (seen.has(k)) continue;
    seen.add(k); pool.push(e);
  }
  const pq = scoreLocal(pool, tp, sl, maxHold, mb);
  console.log(`\npooled distinct events across the whole nuisance grid: ${pq.traded}  alpha ${sg(pq.alpha)} ± ${f(pq.se)}  t ${sg(pq.t, 2)}  (long ${sg(pq.alphaLong)} n=${pq.longs} | short ${sg(pq.alphaShort)} n=${pq.shorts})`);
}

/**
 * Before and after, on one screen, with the improvement decomposed into the
 * part that came from fixing the level and the part that came from sizing the
 * target — and with the things that did NOT improve stated just as plainly.
 */
function stageSummary() {
  const mb = monthBlocks();
  const CFG = {
    anchorMin: 0, width: 0.25, window: 1, hold: 1, kinds: ['vah', 'val'],
    minutes: 1, reading: 'to-value', approachAtr: 1.5, tolAtr: 0.20, vaPct: 0.70, firstOnly: false,
  };
  const TP = 150, SL = 150, HOLD = 240;

  // BEFORE — tools/levels.js:volumeNodeLevels exactly as shipped, on 1m, at 90/90/1440
  const oldLine = LV.volumeNodeLevels(bars, { look: 1440, step: 60, buckets: 120 }).line;
  const oldEv = levelTestEvents(bars, oldLine, atr1);
  const o90 = score(oldEv, 90, 90, 1440);
  const oLoc = scoreLocal(oldEv, 90, 90, 1440, mb);
  const oTuned = score(oldEv, TP, SL, HOLD);

  // AFTER
  const r = run(CFG, TP, SL, HOLD);
  const n90 = score(r.ev, 90, 90, 1440);
  const nTuned = score(r.ev, TP, SL, HOLD);
  const nLoc = scoreLocal(r.ev, TP, SL, HOLD, mb);

  const line = (a, b) => console.log(`  ${a.padEnd(52)} ${b}`);
  console.log('VOLUME NODE — BEFORE AND AFTER\n');
  console.log('BEFORE  rolling POC of the trailing 1440 bars, recomputed every 60, one series');
  line('at the legacy 90/90/1440 target', `alpha ${sg(o90.alpha)}  t ${sg(o90.t, 2)}  ${o90.tests} tests  respect ${f(o90.respect, 1)}%`);
  line('same, month-local direction adjustment', `alpha ${sg(oLoc.alpha)}  t ${sg(oLoc.t, 2)}`);
  line(`same events, at the tuned ${TP}/${SL}/${HOLD} target`, `alpha ${sg(oTuned.alpha)}  t ${sg(oTuned.t, 2)}`);

  console.log('\nAFTER   value-area edges of the PREVIOUS completed session, fixed constants,');
  console.log('        each watched alone, every test traded inward toward that profile\'s POC');
  line('at the legacy 90/90/1440 target  (level fix only)', `alpha ${sg(n90.alpha)}  t ${sg(n90.t, 2)}  ${n90.tests} tests  respect ${f(n90.respect, 1)}%`);
  line(`at the tuned ${TP}/${SL}/${HOLD} target   (level + target)`, `alpha ${sg(nTuned.alpha)}  t ${sg(nTuned.t, 2)}  win ${f(nTuned.winRate, 1)}%`);
  line('same, month-local direction adjustment', `alpha ${sg(nLoc.alpha)} ± ${f(nLoc.se)}  t ${sg(nLoc.t, 2)}`);

  console.log('\nDECOMPOSITION');
  line('fixing the level, target held at 90/90/1440', `${sg(o90.alpha)} -> ${sg(n90.alpha)}   (${sg(n90.alpha - o90.alpha)})`);
  line('then sizing the target to the excursion', `${sg(n90.alpha)} -> ${sg(nTuned.alpha)}   (${sg(nTuned.alpha - n90.alpha)})`);

  console.log('\nWHAT DID NOT IMPROVE — stated as plainly as what did');
  line('respect rate of the new level', `${f(nTuned.respect, 1)}%  vs random ${RANDOM_RESPECT}%`);
  console.log('    The edges do NOT turn price more often than chance. Every point of the');
  console.log('    alpha comes from what price does after the test, not from how often it turns.');
  line('the point of control itself', 'negative alpha in 90 of 144 nuisance cells');
  line('the low volume node', 'negative alpha in 132 of 144 cells — actively harmful');
  line('long side (value area low, faded up)', `alpha ${sg(nTuned.alphaLong)} over ${nTuned.longs} trades`);
  line('short side (value area high, faded down)', `alpha ${sg(nTuned.alphaShort)} over ${nTuned.shorts} trades`);
  console.log('    Half of the construction carries almost all of the result.');
  console.log('\n  Across the whole 144-cell nuisance grid at this target the mean alpha is +3.7');
  console.log('  and 91 of 144 cells are positive, so the +12 of this particular cell is partly');
  console.log('  a favourable choice of parameters. Treat +4 to +8 as the defensible range.');
}

/** Naked levels: a node from an old session that price has not yet come back to. */
function stageNaked(argv) {
  const base = parseCfg(argv);
  const tp = +(argv.find(a => a.startsWith('tp=')) || 'tp=90').split('=')[1];
  const sl = +(argv.find(a => a.startsWith('sl=')) || 'sl=90').split('=')[1];
  const maxHold = +(argv.find(a => a.startsWith('maxHold=')) || 'maxHold=240').split('=')[1];
  console.log(`NAKED NODES — level stays live until its first test   tp ${tp} sl ${sl} hold ${maxHold}\n`);
  console.log('kind     hold first  tf  appr   tests respect  ctrl-r   Δr     alpha   ctrl-a     Δa      t');
  console.log('─'.repeat(94));
  for (const kinds of [['poc'], ['vah', 'val']]) {
    for (const hold of [1, 3, 10, 30]) {
      for (const firstOnly of [false, true]) {
        for (const minutes of [1, 5]) {
          const c = { ...base, kinds, hold, firstOnly, minutes };
          const r = run(c, tp, sl, maxHold);
          if (r.s.traded < 100) continue;
          const k = control(c, tp, sl, maxHold, 8);
          console.log(
            `${kinds.join('+').padEnd(8)} ${String(hold).padStart(4)} ${String(firstOnly)[0].padStart(5)} ${TF_NAME[minutes].padStart(3)} ${c.approachAtr.toFixed(1).padStart(4)} ` +
            `${String(r.s.tests).padStart(7)} ${f(r.s.respect, 1).padStart(6)} ${f(k.respect, 1).padStart(7)} ${sg(r.s.respect - k.respect, 1).padStart(6)} ` +
            `${sg(r.s.alpha).padStart(8)} ${sg(k.alpha).padStart(8)} ${sg(r.s.alpha - k.alpha).padStart(7)} ${sg(r.s.t, 2).padStart(6)}`);
        }
      }
    }
  }
}

function stageExcursion(argv) {
  const cfg = parseCfg(argv);
  const levels = profileLevels(cfg);
  const ev = applyReading(levelEvents(levels, cfg), cfg.reading);
  console.log(`EXCURSION AFTER A TEST  (${JSON.stringify(cfg)})  ${ev.length} events\n`);
  const groups = [
    ['all', ev],
    ['reject', ev.filter(e => e.kind === 'reject')],
    ['break', ev.filter(e => e.kind === 'break')],
    ['reject long', ev.filter(e => e.kind === 'reject' && e.dir === 1)],
    ['reject short', ev.filter(e => e.kind === 'reject' && e.dir === -1)],
  ];
  for (const [name, list] of groups) {
    if (!list.length) continue;
    console.log(`${name}  (${list.length})`);
    console.log('   horizon   MFE p25/med/p75      MAE p25/med/p75');
    for (const r of excursion(list)) {
      console.log(`   ${String(r.h).padStart(5)}m   ${f(r.mfeQ25, 0).padStart(4)}/${f(r.mfeMed, 0).padStart(4)}/${f(r.mfeQ75, 0).padStart(4)}          ${f(r.maeQ25, 0).padStart(4)}/${f(r.maeMed, 0).padStart(4)}/${f(r.maeQ75, 0).padStart(4)}`);
    }
    console.log('');
  }
  // the same for the OPPOSITE direction, since the break reading trades through
  console.log('flipped direction (what a trade the other way would have seen):');
  for (const r of excursion(ev.map(e => ({ ...e, dir: -e.dir })))) {
    console.log(`   ${String(r.h).padStart(5)}m   MFE ${f(r.mfeMed, 0).padStart(4)}   MAE ${f(r.maeMed, 0).padStart(4)}`);
  }
}

const THR = [15, 20, 30, 40, 60, 90, 120, 150, 200];

function stageTuned(argv) {
  const cfg = parseCfg(argv);
  const levels = profileLevels(cfg);
  const evAll = levelEvents(levels, cfg);
  console.log(`TARGET AND STOP SIZED TO THE LEVEL  (${JSON.stringify(cfg)})  ${evAll.length} raw events\n`);
  for (const maxHold of [120, 240, 480, 1440]) {
    for (const reading of [cfg.reading, 'to-value-reject', 'to-value-break']) {
      const ev = applyReading(evAll, reading);
      if (ev.length < 100) { console.log(`hold ${maxHold}  ${reading}: only ${ev.length} events — skipped`); continue; }
      const grid = scoreGrid(ev, THR, maxHold);
      const top = grid.filter(g => g.traded >= 100).sort((a, b) => b.alpha - a.alpha).slice(0, 5);
      console.log(`hold ${String(maxHold).padStart(4)}m  reading ${reading.padEnd(7)} (${ev.length} events)`);
      for (const g of top) {
        console.log(`     tp ${String(g.tp).padStart(3)} sl ${String(g.sl).padStart(3)}   n ${String(g.traded).padStart(5)}   raw ${sg(g.raw).padStart(7)}   alpha ${sg(g.alpha).padStart(7)}   (L ${sg(g.alphaLong)} / S ${sg(g.alphaShort)}, ${g.longs}/${g.shorts})`);
      }
      console.log('');
    }
  }
}

function stageFinal(argv) {
  const cfg = parseCfg(argv);
  const tp = +(argv.find(a => a.startsWith('tp=')) || 'tp=20').split('=')[1];
  const sl = +(argv.find(a => a.startsWith('sl=')) || 'sl=20').split('=')[1];
  const maxHold = +(argv.find(a => a.startsWith('maxHold=')) || 'maxHold=240').split('=')[1];
  const reading = cfg.reading;
  console.log(`FINAL  ${JSON.stringify(cfg)}  tp ${tp} sl ${sl} hold ${maxHold}\n`);

  const levels = profileLevels(cfg);
  // ── causality assertions ──────────────────────────────────────────────────
  let viol = 0;
  for (const L of levels) if (!(L.knownAt <= L.from)) viol++;
  console.log(`causality: ${levels.length} levels, ${viol} with knownAt > from (must be 0)`);
  const ev = applyReading(levelEvents(levels, cfg), reading);
  let viol2 = 0, checked = 0;
  const byKey = new Map();
  for (const L of levels) byKey.set(`${L.session}|${L.kind}`, L);
  for (const e of ev) {
    const L = byKey.get(`${e.session}|${e.src}`);
    if (!L) continue;
    checked++;
    if (e.i < L.knownAt) viol2++;
  }
  console.log(`causality: ${ev.length} events, ${checked} matched to their level, ${viol2} fired before that level existed (must be 0)`);
  // the profile of session s uses bars strictly before sess[s].from; show the gap
  const minGap = Math.min(...levels.map(L => L.from - L.knownAt));
  console.log(`causality: smallest gap between "profile data ends" and "level goes live" = ${minGap} bars (must be >= 0)`);

  const s = score(ev, tp, sl, maxHold);
  console.log(`\nCHOSEN         tests ${s.tests}  traded ${s.traded}  respect ${f(s.respect, 1)}%  short% ${f(s.shortShare, 1)}  win% ${f(s.winRate, 1)}`);
  console.log(`               raw ${sg(s.raw)}  ALPHA ${sg(s.alpha)} ± ${f(s.se)}  t ${sg(s.t, 2)}   (long ${sg(s.alphaLong)} n=${s.longs} | short ${sg(s.alphaShort)} n=${s.shorts})`);
  console.log(`               blind long ${sg(blind(1, tp, sl, maxHold))}  blind short ${sg(blind(-1, tp, sl, maxHold))}  at this exact target`);

  const s90 = score(ev, 90, 90, 1440);
  console.log(`same events at the legacy 90/90/1440 target: alpha ${sg(s90.alpha)}  t ${sg(s90.t, 2)}  raw ${sg(s90.raw)}`);

  // ── the strict direction adjustment ───────────────────────────────────────
  console.log('\nDIRECTION ADJUSTED LOCALLY (baselines recomputed inside each block)');
  for (const [nm, blocks] of [['calendar month', monthBlocks()], ['10 sessions', fixedBlocks(13790)], ['5 sessions', fixedBlocks(6895)]]) {
    const q = scoreLocal(ev, tp, sl, maxHold, blocks);
    console.log(`  ${nm.padEnd(15)} ${blocks.length} blocks   alpha ${sg(q.alpha)} ± ${f(q.se)}  t ${sg(q.t, 2)}   (long ${sg(q.alphaLong)} n=${q.longs} | short ${sg(q.alphaShort)} n=${q.shorts})`);
  }
  {
    const mb = monthBlocks();
    const xs = [];
    for (let k = 1; k <= 10; k++) xs.push(scoreLocal(run({ ...cfg }, tp, sl, maxHold, { nudge: rng(k * 7919 + 13) }).ev, tp, sl, maxHold, mb).alpha);
    const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (xs.length - 1));
    console.log(`  nudged control, month-local: alpha ${sg(mu)} ± ${f(sd / Math.sqrt(xs.length))}  (10 seeds, spread ${sg(Math.min(...xs))} .. ${sg(Math.max(...xs))})`);
  }

  // ── controls ──────────────────────────────────────────────────────────────
  console.log('\nCONTROLS  (all at the same target, same engine, same windows)');
  const u = control(cfg, tp, sl, maxHold, 10, 'jitter');
  console.log(`  uniform  — random price anywhere in the same session's range:`);
  console.log(`            alpha ${sg(u.alpha)} ± ${f(u.alphaSd / Math.sqrt(u.seeds))}  respect ${f(u.respect, 1)}%  (${Math.round(u.tests)} tests/seed, ${u.seeds} seeds)`);
  const g = control(cfg, tp, sl, maxHold, 10, 'nudge');
  console.log(`  nudged   — the SAME level displaced 5-20% of the range (position-matched):`);
  console.log(`            alpha ${sg(g.alpha)} ± ${f(g.alphaSd / Math.sqrt(g.seeds))}  respect ${f(g.respect, 1)}%  (${Math.round(g.tests)} tests/seed, ${g.seeds} seeds)`);
  console.log(`  EDGE OVER THE POSITION-MATCHED CONTROL: ${sg(s.alpha - g.alpha)} points per trade`);

  // geometry-only: same inward trade, but the level is the session extreme, not an auction edge
  const geo = run({ ...cfg, kinds: ['hi', 'lo'], centerKind: 'mid' }, tp, sl, maxHold);
  console.log(`  geometry — session high/low faded to the range mid, no volume at all:`);
  console.log(`            alpha ${sg(geo.s.alpha)}  t ${sg(geo.s.t, 2)}  (${geo.s.tests} tests)`);

  // deliberate lookahead: read the profile of a session that has not happened yet
  const leak = profileLevels({ ...cfg, shift: 1 });
  for (const L of leak) L.knownAt = 0;      // the assertion would (correctly) reject these
  const le = applyReading(levelEvents(leak, cfg), reading);
  const ls = score(le, tp, sl, maxHold);
  console.log(`  LEAK     — next session's profile, a deliberate lookahead bug:`);
  console.log(`            alpha ${sg(ls.alpha)}  respect ${f(ls.respect, 1)}%  (${ls.tests} tests)`);
  console.log(`            ^ this is what contamination looks like. The honest number above is not it.`);

  // 3. split-half stability
  const mid = Math.floor(N / 2);
  const h1 = ev.filter(e => e.i < mid), h2 = ev.filter(e => e.i >= mid);
  for (const [nm, list] of [['first half', h1], ['second half', h2]]) {
    if (list.length < 40) { console.log(`  ${nm}: ${list.length} events — too few`); continue; }
    const q = score(list, tp, sl, maxHold);
    console.log(`  ${nm}: ${q.tests} tests  respect ${f(q.respect, 1)}%  alpha ${sg(q.alpha)}`);
  }

  // 4. month by month
  console.log('\n  by month:');
  const byM = new Map();
  for (const e of ev) {
    const k = new Date(bars[e.i].t).toISOString().slice(0, 7);
    if (!byM.has(k)) byM.set(k, []);
    byM.get(k).push(e);
  }
  for (const k of [...byM.keys()].sort()) {
    const q = score(byM.get(k), tp, sl, maxHold);
    console.log(`    ${k}  ${String(q.tests).padStart(4)} tests  respect ${f(q.respect, 1).padStart(5)}%  alpha ${sg(q.alpha).padStart(7)}`);
  }

  // 5. by source kind
  console.log('\n  by profile reading:');
  for (const kind of cfg.kinds) {
    const list = ev.filter(e => e.src === kind);
    if (list.length < 30) { console.log(`    ${kind}: ${list.length} events`); continue; }
    const q = score(list, tp, sl, maxHold);
    console.log(`    ${kind.padEnd(4)}  ${String(q.tests).padStart(4)} tests  respect ${f(q.respect, 1).padStart(5)}%  alpha ${sg(q.alpha).padStart(7)}`);
  }

  // 6. by event kind
  console.log('\n  by event kind:');
  for (const k of ['reject', 'break']) {
    const list = ev.filter(e => e.kind === k);
    if (list.length < 30) { console.log(`    ${k}: ${list.length} events`); continue; }
    const q = score(list, tp, sl, maxHold);
    console.log(`    ${k.padEnd(6)} ${String(q.tests).padStart(4)} tests  alpha ${sg(q.alpha).padStart(7)}  (L ${sg(q.alphaLong)} n=${q.longs} | S ${sg(q.alphaShort)} n=${q.shorts})`);
  }

  // 7. neighbourhood of the chosen target
  console.log('\n  target neighbourhood (alpha):');
  const grid = scoreGrid(ev, THR, maxHold);
  const hdr = '        sl:' + THR.map(v => String(v).padStart(7)).join('');
  console.log(hdr);
  for (const a of THR) {
    const row = THR.map(b => { const g = grid.find(x => x.tp === a && x.sl === b); return (g ? sg(g.alpha, 1) : '—').padStart(7); }).join('');
    console.log(`  tp ${String(a).padStart(3)}  ` + row);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
const stage = process.argv[2] || 'probe';
const rest = process.argv.slice(3);
({
  probe: stageProbe,
  current: stageCurrent,
  profile: stageProfile,
  tf: stageTf,
  compare: stageCompare,
  decisive: stageDecisive,
  robust: stageRobust,
  confirm: stageConfirm,
  summary: stageSummary,
  naked: stageNaked,
  excursion: stageExcursion,
  tuned: stageTuned,
  final: stageFinal,
}[stage] || (() => { console.log('stages: probe current profile tf excursion tuned final'); }))(rest);
