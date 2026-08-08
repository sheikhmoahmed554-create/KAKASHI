'use strict';
/*
 * Adversarial verification of the "rising trendline" claim.
 *
 * Claim under test: 15m candles, 5/5 pivot lows, ray through two confirmed
 * higher lows, brkDown reading only, 90 point target / 60 point stop / 240
 * minute cap, alpha +14.66 on 205 trades.
 *
 * Stages:
 *   repro    reproduce the headline with independently written scoring
 *   look     lookahead: perturb the FUTURE and check the past line is unchanged
 *   match    time-matched and momentum-matched baselines instead of a
 *            uniform-over-the-sample blind short
 *   cluster  overlap between trades, non-overlapping subset, day blocks
 *   oos      calendar split Jan-Apr derive / May-Jul judge, drop-one-month
 *   sig      t-stat, day-block bootstrap, trimmed means
 *   sel      how much of the answer is selection: reading x timeframe grid
 *            decided on the first four months only
 *   flat     placebo where the ray is replaced by a horizontal line at the
 *            second anchor (same births, same deaths)
 *
 * Usage: node --max-old-space-size=3500 tools/fixes/rising-trendline-verify.js <stage>
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('../ai963_engine');
const LV = require('../levels');
const { levelTestEvents, respectRate } = require('../level_events');

const PU = 0.10, COST = 0.5;

// ── loader, copied from tools/sweep_timeframes.js ────────────────────────────
function loadBars() {
  const html = fs.readFileSync(
    path.join(__dirname, '..', '..', 'KAKASHI_V16_TV_PARITY_AUDIT.html'), 'utf8');
  const csv = zlib.gunzipSync(
    Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1], 'base64')).toString('utf8');
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

function race(i, dir, tp, sl, hold) {
  const e = bars[i].c, tpx = e + dir * tp * PU, slx = e - dir * sl * PU;
  const end = Math.min(N - 1, i + hold);
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    const ht = dir === 1 ? b.h >= tpx : b.l <= tpx;
    const hs = dir === 1 ? b.l <= slx : b.h >= slx;
    if (ht && hs) return null;
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

const BL = new Map();
function blind(dir, tp, sl, hold, n = 40000, lo = 100, hi = null) {
  const key = `${dir}|${tp}|${sl}|${hold}|${n}|${lo}|${hi}`;
  if (BL.has(key)) return BL.get(key);
  const r = rng(dir === 1 ? 31337 : 73331);
  const HI = (hi === null ? N - hold - 2 : hi);
  let c = 0, net = 0;
  for (let k = 0; k < n; k++) {
    const p = race(lo + Math.floor(r() * (HI - lo)), dir, tp, sl, hold);
    if (p === null) continue;
    c++; net += p;
  }
  const v = net / c;
  BL.set(key, v);
  return v;
}

// ── the generator, transcribed from tools/fixes/rising-trendline.js ──────────
function risingTrendline(hbars, atr, o = {}) {
  const left = o.left ?? 10, right = o.right ?? 10;
  const minSpan = o.minSpan ?? 60, maxSpan = o.maxSpan ?? 3000;
  const pierceAtr = o.pierceAtr ?? 0.3;
  const maxSlopeAtr = o.maxSlopeAtr ?? Infinity, minSlopeAtr = o.minSlopeAtr ?? 0;
  const maxProject = o.maxProject ?? 2000;
  const breakAtr = o.breakAtr ?? 0.5;
  const killOnBreak = o.killOnBreak ?? true;
  const graceBars = o.graceBars ?? 0;
  const candCap = o.candCap ?? 60;
  const pick = o.pick ?? 'recent';
  const flatten = o.flatten ?? false;      // placebo: horizontal at 2nd anchor

  const n = hbars.length;
  const { lows } = LV.pivots(hbars, left, right);
  const byKnown = new Map();
  for (const p of lows) {
    if (!byKnown.has(p.knownAt)) byKnown.set(p.knownAt, []);
    byKnown.get(p.knownAt).push(p);
  }
  const line = new Array(n).fill(NaN);
  const id = new Array(n).fill(-1);
  const seen = [];
  let active = null, nextId = 0, deadUntil = -1;

  for (let i = 0; i < n; i++) {
    const born = byKnown.get(i);
    if (born) {
      for (const p of born) {
        if (i >= deadUntil) {
          let best = null, bestKey = Infinity, tried = 0;
          for (let k = seen.length - 1; k >= 0 && tried < candCap; k--) {
            const q = seen[k];
            const span = p.bar - q.bar;
            if (span < minSpan) continue;
            if (span > maxSpan) break;
            tried++;
            if (!(p.price > q.price)) continue;
            const slope = (p.price - q.price) / span;
            const aRef = atr[p.bar] || atr[q.bar] || 0;
            if (aRef > 0) {
              const sa = slope / aRef;
              if (sa > maxSlopeAtr || sa < minSlopeAtr) continue;
            }
            let clean = true;
            for (let j = q.bar; j <= p.bar; j++) {
              const y = q.price + slope * (j - q.bar);
              if (hbars[j].l < y - (atr[j] || 0) * pierceAtr) { clean = false; break; }
            }
            if (!clean) continue;
            const key = pick === 'flattest' ? Math.abs(slope) / (aRef || 1)
                      : pick === 'far' ? -span : 0;
            if (key < bestKey) { best = { q, slope }; bestKey = key; }
            if (pick === 'recent') break;
          }
          if (best) {
            let slope = best.slope;
            if (flatten) slope = 0;
            if (o.slopePool) slope = o.slopePool[Math.floor(o.slopeRng() * o.slopePool.length)] * (atr[p.bar] || 1);
            else if (o.collectSlopes) o.collectSlopes.push(best.slope / (atr[p.bar] || 1));
            active = { x0: p.bar, y0: p.price, slope, born: i, id: nextId++ };
          }
        }
        seen.push(p);
        if (seen.length > 400) seen.shift();
      }
    }
    if (!active) continue;
    const y = active.y0 + active.slope * (i - active.x0);
    const a = atr[i] || 0;
    if (i - active.born > maxProject) { active = null; continue; }
    if (hbars[i].c < y - a * breakAtr) {
      if (killOnBreak) { active = null; deadUntil = i + graceBars; continue; }
    }
    line[i] = y; id[i] = active.id;
  }
  return { line, id };
}

const TFC = new Map();
function tf(m) {
  if (!TFC.has(m)) {
    const { bars: b, index } = E.resample(bars, m);
    TFC.set(m, { bars: b, index, atr: E.atr(b, 14) });
  }
  return TFC.get(m);
}
function buildLine(m, opts) {
  const { bars: hb, index, atr: ha } = tf(m);
  const { line, id } = risingTrendline(hb, ha, opts);
  if (m === 1) return { line, id };
  return { line: E.projectConfirmed(line, index), id: E.projectConfirmed(id, index) };
}

const ONLY = {
  all: e => e,
  bounce: e => e.filter(x => x.kind === 'reject'),
  brk: e => e.filter(x => x.kind === 'break'),
  bounceUp: e => e.filter(x => x.kind === 'reject' && x.dir === 1),
  rejDown: e => e.filter(x => x.kind === 'reject' && x.dir === -1),
  brkDown: e => e.filter(x => x.kind === 'break' && x.dir === -1),
  brkUp: e => e.filter(x => x.kind === 'break' && x.dir === 1),
};

const BEST = {
  m: 15,
  opts: { left: 5, right: 5, minSpan: 6, maxSpan: 200, pierceAtr: 0.1,
          maxProject: 200, breakAtr: 0.4 },
  reading: 'brkDown', tp: 90, sl: 60, hold: 240,
};

function events(m = BEST.m, opts = BEST.opts, reading = BEST.reading) {
  const { line } = buildLine(m, opts);
  return ONLY[reading](levelTestEvents(bars, line, atr1));
}

function payoffs(list, tp = BEST.tp, sl = BEST.sl, hold = BEST.hold) {
  const out = [];
  for (const e of list) {
    const p = race(e.i, e.dir, tp, sl, hold);
    if (p === null) continue;
    out.push({ i: e.i, dir: e.dir, p });
  }
  return out;
}

function score(list, tp = BEST.tp, sl = BEST.sl, hold = BEST.hold) {
  const bl = blind(1, tp, sl, hold), bs = blind(-1, tp, sl, hold);
  const ps = payoffs(list, tp, sl, hold);
  let ln = 0, lnet = 0, sn = 0, snet = 0;
  for (const x of ps) { if (x.dir === 1) { ln++; lnet += x.p; } else { sn++; snet += x.p; } }
  const tot = ln + sn;
  const la = ln ? lnet / ln - bl : 0, sa = sn ? snet / sn - bs : 0;
  return { n: tot, longs: ln, shorts: sn, raw: tot ? (lnet + snet) / tot : NaN,
           alpha: tot ? (la * ln + sa * sn) / tot : NaN };
}

const f = (x, d = 2) => Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '—';
const fp = (x, d = 1) => Number.isFinite(x) ? x.toFixed(d) : '—';
const day = i => new Date(bars[i].t).toISOString().slice(0, 10);
const month = i => new Date(bars[i].t).toISOString().slice(0, 7);

// ═══ repro ═══════════════════════════════════════════════════════════════════
function stageRepro() {
  const { tp, sl, hold } = BEST;
  console.log(`${N.toLocaleString()} bars  ${day(0)} .. ${day(N - 1)}`);
  console.log(`blind long ${f(blind(1, tp, sl, hold))} / short ${f(blind(-1, tp, sl, hold))} at ${tp}/${sl}/${hold}`);
  console.log(`blind long ${f(blind(1, 90, 90, 1440))} / short ${f(blind(-1, 90, 90, 1440))} at 90/90/1440`);
  const { line } = buildLine(BEST.m, BEST.opts);
  const all = levelTestEvents(bars, line, atr1);
  console.log(`\nall events ${all.length}   respect ${fp(respectRate(all).respect)}%`);
  for (const r of ['all', 'bounceUp', 'rejDown', 'brkUp', 'brkDown']) {
    const l = ONLY[r](all);
    if (!l.length) continue;
    const s90 = score(l, 90, 90, 1440), s = score(l, tp, sl, hold);
    console.log(`  ${r.padEnd(9)} n=${String(l.length).padStart(4)}   alpha@90/90/1440 ${f(s90.alpha).padStart(8)}   alpha@${tp}/${sl}/${hold} ${f(s.alpha).padStart(8)}  (traded ${s.n})`);
  }
  // line coverage
  let cov = 0; for (let i = 0; i < N; i++) if (Number.isFinite(line[i])) cov++;
  console.log(`\nline defined on ${(100 * cov / N).toFixed(1)}% of 1m bars`);
}

// ═══ lookahead ═══════════════════════════════════════════════════════════════
function stageLook() {
  const m = BEST.m, opts = BEST.opts;
  const { bars: hb } = tf(m);
  const full = risingTrendline(hb, E.atr(hb, 14), opts);

  // (a) truncation: rebuild from bars[0..j] only.
  const r = rng(9001);
  let bad = 0, checked = 0, worst = 0;
  for (let k = 0; k < 300; k++) {
    const j = 200 + Math.floor(r() * (hb.length - 260));
    const cut = hb.slice(0, j + 1);
    const part = risingTrendline(cut, E.atr(cut, 14), opts);
    const a = full.line[j], b = part.line[j];
    const both = !Number.isFinite(a) && !Number.isFinite(b);
    if (!both) {
      const d = Math.abs((a || 0) - (b || 0));
      worst = Math.max(worst, d);
      if (!(d < 1e-9)) bad++;
    }
    checked++;
  }
  console.log(`(a) truncated rebuild: ${checked} points, ${bad} disagreements, max |diff| ${worst.toExponential(2)}`);

  // (b) future perturbation: scramble every bar AFTER j, rebuild, compare the
  //     whole prefix. Strictly stronger than truncation — it also catches a
  //     build that reads forward and then happens to agree by accident.
  const r2 = rng(4711);
  let pbad = 0, pchk = 0, pworst = 0;
  for (let k = 0; k < 12; k++) {
    const j = 400 + Math.floor(r2() * (hb.length - 500));
    const mut = hb.map((b, idx) => idx <= j ? b
      : { t: b.t, o: b.o * 1.05 + 37, h: b.h * 1.05 + 60, l: b.l * 1.05 + 5, c: b.c * 1.05 + 37, v: b.v });
    const pf = risingTrendline(mut, E.atr(mut, 14), opts);
    for (let q = 0; q <= j; q++) {
      const a = full.line[q], b = pf.line[q];
      const both = !Number.isFinite(a) && !Number.isFinite(b);
      if (both) { pchk++; continue; }
      const d = Math.abs((a || 0) - (b || 0));
      pworst = Math.max(pworst, Number.isFinite(d) ? d : Infinity);
      if (!(d < 1e-9)) pbad++;
      pchk++;
    }
  }
  console.log(`(b) future-perturbed rebuild: ${pchk} prefix values compared, ${pbad} disagreements, max |diff| ${pworst.toExponential(2)}`);

  // (c) projection alignment: the 15m bar supplying the visible value must have
  //     closed before the 1m bar opened.
  const { index } = tf(m);
  const proj = E.projectConfirmed(full.line, index);
  let leak = 0, sampled = 0;
  for (let i = 1; i < N; i++) {
    const j = index[i] - 1;
    if (j < 0) continue;
    sampled++;
    if (Number.isFinite(proj[i]) && proj[i] !== full.line[j]) leak++;
    if (hb[j].t + m * 60000 > bars[i].t) leak++;
  }
  console.log(`(c) projection: ${leak} leaks over ${sampled} 1m bars (every bar checked, not sampled)`);

  // (d) how stale is the published value? if the ray is published at bar j-1
  //     and read during bar j the level is one 15m bar behind the true ray.
  const { atr: ha } = tf(m);
  const slopes = [];
  risingTrendline(hb, ha, { ...opts, collectSlopes: slopes });
  const s = slopes.slice().sort((a, b) => a - b);
  console.log(`(d) slopes accepted: ${s.length}, median ${fp(s[s.length >> 1], 4)} ATR/15m bar ` +
    `(so the published level lags the true ray by ~${fp(Math.abs(s[s.length >> 1]), 3)} ATR — conservative, not lookahead)`);

  // (e) entry timing: the trade is taken at the close of the 1m bar that fired.
  //     Confirm no event uses a level built from a 15m bar that had not closed.
  const list = events();
  let bad2 = 0;
  const { line } = buildLine(m, opts);
  for (const e of list) {
    const j = index[e.i] - 1;
    if (j < 0 || hb[j].t + m * 60000 > bars[e.i].t) bad2++;
    if (Math.abs(line[e.i] - e.level) > 1e-9) bad2++;
  }
  console.log(`(e) ${list.length} traded events, ${bad2} with a level not fully closed before entry`);
}

// ═══ matched baselines ═══════════════════════════════════════════════════════
/*
 * The uniform blind short is a baseline over the WHOLE sample. If the events
 * cluster into the stretches where the market was falling hardest, beating a
 * uniform blind short proves nothing. Three tighter controls:
 *
 *   day     random shorts drawn from the same UTC calendar day
 *   4h      random shorts drawn from +/- 4 hours around the event
 *   mom     random shorts drawn from bars with a similar trailing 60m return,
 *           anywhere in the sample — asks whether "short after a fast drop"
 *           explains it without any line at all
 */
function stageMatch() {
  const { tp, sl, hold } = BEST;
  const list = events();
  const ps = payoffs(list);
  const mean = ps.reduce((a, b) => a + b.p, 0) / ps.length;
  console.log(`${ps.length} traded events, raw mean ${f(mean)} points/trade`);
  console.log(`uniform blind short ${f(blind(-1, tp, sl, hold))}  ->  alpha ${f(mean - blind(-1, tp, sl, hold))}\n`);

  const K = 400;
  // day-matched
  const dayIdx = new Map();
  for (let i = 100; i < N - hold - 2; i++) {
    const d = day(i);
    if (!dayIdx.has(d)) dayIdx.set(d, []);
    dayIdx.get(d).push(i);
  }
  const r = rng(20260808);
  let dsum = 0, dn = 0, wins = 0;
  const perEvent = [];
  for (const x of ps) {
    const pool = dayIdx.get(day(x.i)) || [];
    if (pool.length < 30) continue;
    let s = 0, c = 0;
    for (let k = 0; k < K; k++) {
      const p = race(pool[Math.floor(r() * pool.length)], -1, tp, sl, hold);
      if (p === null) continue;
      s += p; c++;
    }
    if (!c) continue;
    const base = s / c;
    perEvent.push(x.p - base);
    dsum += x.p - base; dn++;
    if (x.p > base) wins++;
  }
  const dmean = dsum / dn;
  const dsd = Math.sqrt(perEvent.reduce((a, v) => a + (v - dmean) ** 2, 0) / (dn - 1));
  console.log(`day-matched   : n=${dn}  alpha ${f(dmean)}  sd ${fp(dsd)}  t ${fp(dmean / (dsd / Math.sqrt(dn)), 2)}  beat-own-day ${fp(100 * wins / dn)}%`);

  // +/- 4h matched
  const W = 240;
  let hsum = 0, hn = 0;
  const hEvent = [];
  for (const x of ps) {
    const lo = Math.max(100, x.i - W), hi = Math.min(N - hold - 2, x.i + W);
    if (hi - lo < 60) continue;
    let s = 0, c = 0;
    for (let k = 0; k < K; k++) {
      const p = race(lo + Math.floor(r() * (hi - lo)), -1, tp, sl, hold);
      if (p === null) continue;
      s += p; c++;
    }
    if (!c) continue;
    hEvent.push(x.p - s / c); hsum += x.p - s / c; hn++;
  }
  const hmean = hsum / hn;
  const hsd = Math.sqrt(hEvent.reduce((a, v) => a + (v - hmean) ** 2, 0) / (hn - 1));
  console.log(`+/-4h matched : n=${hn}  alpha ${f(hmean)}  sd ${fp(hsd)}  t ${fp(hmean / (hsd / Math.sqrt(hn)), 2)}`);

  // week-matched
  const weekIdx = new Map();
  const wkey = i => Math.floor((bars[i].t - bars[0].t) / (7 * 86400000));
  for (let i = 100; i < N - hold - 2; i++) {
    const k = wkey(i);
    if (!weekIdx.has(k)) weekIdx.set(k, []);
    weekIdx.get(k).push(i);
  }
  let wsum = 0, wn = 0; const wEvent = [];
  for (const x of ps) {
    const pool = weekIdx.get(wkey(x.i)) || [];
    if (pool.length < 100) continue;
    let s = 0, c = 0;
    for (let k = 0; k < K; k++) {
      const p = race(pool[Math.floor(r() * pool.length)], -1, tp, sl, hold);
      if (p === null) continue;
      s += p; c++;
    }
    if (!c) continue;
    wEvent.push(x.p - s / c); wsum += x.p - s / c; wn++;
  }
  const wmean = wsum / wn;
  const wsd = Math.sqrt(wEvent.reduce((a, v) => a + (v - wmean) ** 2, 0) / (wn - 1));
  console.log(`week-matched  : n=${wn}  alpha ${f(wmean)}  sd ${fp(wsd)}  t ${fp(wmean / (wsd / Math.sqrt(wn)), 2)}`);

  // momentum-matched: same trailing 60m return decile, drawn anywhere
  const trail = i => (bars[i].c - bars[i - 60].c) / PU;
  const sample = [];
  for (let i = 200; i < N - hold - 2; i += 7) sample.push({ i, r: trail(i) });
  sample.sort((a, b) => a.r - b.r);
  const B = 20, per = Math.floor(sample.length / B);
  const buckets = [];
  for (let b = 0; b < B; b++) buckets.push(sample.slice(b * per, (b + 1) * per).map(x => x.i));
  const cuts = [];
  for (let b = 1; b < B; b++) cuts.push(sample[b * per].r);
  const bucketOf = v => { let b = 0; while (b < cuts.length && v > cuts[b]) b++; return b; };
  let msum = 0, mn = 0; const mEvent = [];
  const bcount = new Array(B).fill(0);
  for (const x of ps) {
    const b = bucketOf(trail(x.i));
    bcount[b]++;
    const pool = buckets[b];
    let s = 0, c = 0;
    for (let k = 0; k < K; k++) {
      const p = race(pool[Math.floor(r() * pool.length)], -1, tp, sl, hold);
      if (p === null) continue;
      s += p; c++;
    }
    if (!c) continue;
    mEvent.push(x.p - s / c); msum += x.p - s / c; mn++;
  }
  const mmean = msum / mn;
  const msd = Math.sqrt(mEvent.reduce((a, v) => a + (v - mmean) ** 2, 0) / (mn - 1));
  console.log(`mom-matched   : n=${mn}  alpha ${f(mmean)}  sd ${fp(msd)}  t ${fp(mmean / (msd / Math.sqrt(mn)), 2)}   (trailing-60m-return decile)`);
  console.log(`  event distribution across 20 trailing-return buckets (5% each if unbiased):`);
  console.log('   ' + bcount.map(c => fp(100 * c / ps.length, 0)).join(' '));
}

// ═══ clustering ══════════════════════════════════════════════════════════════
function stageCluster() {
  const { tp, sl, hold } = BEST;
  const list = events();
  const ps = payoffs(list);
  // overlap
  let overl = 0;
  for (let k = 1; k < ps.length; k++) if (ps[k].i - ps[k - 1].i < hold) overl++;
  console.log(`${ps.length} trades, ${overl} start while the previous is still open (${fp(100 * overl / ps.length)}%)`);
  const days = new Set(ps.map(x => day(x.i)));
  console.log(`spread over ${days.size} distinct UTC days; max trades in one day ${Math.max(...[...days].map(d => ps.filter(x => day(x.i) === d).length))}`);

  // non-overlapping subset: take the first, skip anything inside its hold
  const bs = blind(-1, tp, sl, hold);
  let last = -1e9, nsum = 0, nn = 0;
  for (const x of ps) {
    if (x.i - last < hold) continue;
    last = x.i; nsum += x.p; nn++;
  }
  console.log(`non-overlapping subset: n=${nn}  raw ${f(nsum / nn)}  alpha ${f(nsum / nn - bs)}`);

  // one trade per day, first only
  const seenD = new Set(); let dsum = 0, dn = 0;
  for (const x of ps) { const d = day(x.i); if (seenD.has(d)) continue; seenD.add(d); dsum += x.p; dn++; }
  console.log(`first trade of each day: n=${dn}  raw ${f(dsum / dn)}  alpha ${f(dsum / dn - bs)}`);
}

// ═══ out of sample ═══════════════════════════════════════════════════════════
function stageOos() {
  const { tp, sl, hold } = BEST;
  const list = events();
  const bs = blind(-1, tp, sl, hold);
  const cut = Date.parse('2026-05-01T00:00:00Z');
  const inS = list.filter(e => bars[e.i].t < cut), outS = list.filter(e => bars[e.i].t >= cut);
  console.log(`derive window Jan-Apr: ${inS.length} events    judge window May-Jul: ${outS.length} events\n`);

  // choose reading, timeframe, target and stop on Jan-Apr ONLY
  const READ = ['bounceUp', 'rejDown', 'brkUp', 'brkDown', 'all', 'brk', 'bounce'];
  const TFS = [5, 15, 60, 240];
  console.log('DERIVE (Jan-Apr only) — alpha at 90/60/240 per timeframe x reading, n in brackets');
  const head = 'tf   ' + READ.map(r => r.padStart(14)).join('');
  console.log(head); console.log('-'.repeat(head.length));
  let bestPick = null;
  for (const m of TFS) {
    const { line } = buildLine(m, BEST.opts);
    const ev = levelTestEvents(bars, line, atr1).filter(e => bars[e.i].t < cut);
    let row = String(m).padEnd(5);
    for (const rd of READ) {
      const l = ONLY[rd](ev);
      if (l.length < 50) { row += '—'.padStart(14); continue; }
      const s = score(l, tp, sl, hold);
      row += `${f(s.alpha, 1)}(${s.n})`.padStart(14);
      if (l.length >= 80 && (!bestPick || s.alpha > bestPick.alpha)) bestPick = { m, rd, alpha: s.alpha, n: s.n };
    }
    console.log(row);
  }
  console.log(`\n  in-sample pick (>=80 events): ${bestPick.m}m ${bestPick.rd}  alpha ${f(bestPick.alpha)} on ${bestPick.n}`);

  // target grid on Jan-Apr for the picked config
  const { line: pl } = buildLine(bestPick.m, BEST.opts);
  const pev = levelTestEvents(bars, pl, atr1);
  const pin = ONLY[bestPick.rd](pev).filter(e => bars[e.i].t < cut);
  const pout = ONLY[bestPick.rd](pev).filter(e => bars[e.i].t >= cut);
  let bt = -Infinity, btp = 0, bsl = 0, bh = 0;
  for (const t of [45, 60, 70, 80, 90, 100, 120, 150, 200])
    for (const s2 of [30, 45, 60, 90, 120])
      for (const h of [120, 240, 480, 1440]) {
        const a = score(pin, t, s2, h).alpha;
        if (a > bt) { bt = a; btp = t; bsl = s2; bh = h; }
      }
  console.log(`  target tuned on Jan-Apr -> ${btp}/${bsl} hold ${bh}   in-sample alpha ${f(bt)}`);
  const oo = score(pout, btp, bsl, bh);
  console.log(`  APPLIED TO MAY-JUL      -> alpha ${f(oo.alpha)} on ${oo.n} trades  (raw ${f(oo.raw)})`);
  const ooFixed = score(pout, tp, sl, hold);
  console.log(`  same window at the claimed 90/60/240 -> alpha ${f(ooFixed.alpha)} on ${ooFixed.n} trades`);
  const inFixed = score(inS, tp, sl, hold);
  console.log(`  Jan-Apr at the claimed 15m/brkDown/90/60/240 -> alpha ${f(inFixed.alpha)} on ${inFixed.n}`);

  // drop-one-month
  console.log('\ndrop-one-month on the claimed construction (15m brkDown 90/60/240):');
  const months = [...new Set(list.map(e => month(e.i)))].sort();
  for (const mo of months) {
    const keep = list.filter(e => month(e.i) !== mo);
    const only = list.filter(e => month(e.i) === mo);
    const sk = score(keep, tp, sl, hold), so = score(only, tp, sl, hold);
    console.log(`  without ${mo}: alpha ${f(sk.alpha).padStart(7)} on ${String(sk.n).padStart(4)}     ${mo} alone ${f(so.alpha).padStart(8)} on ${so.n}`);
  }
}

// ═══ significance ════════════════════════════════════════════════════════════
function stageSig() {
  const { tp, sl, hold } = BEST;
  const list = events();
  const ps = payoffs(list);
  const bs = blind(-1, tp, sl, hold);
  const adj = ps.map(x => x.p - bs);
  const n = adj.length;
  const mean = adj.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(adj.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1));
  console.log(`n=${n}  alpha ${f(mean)}  per-trade sd ${fp(sd)}  se ${fp(sd / Math.sqrt(n), 2)}  t ${fp(mean / (sd / Math.sqrt(n)), 2)}`);

  // trimmed
  const s = adj.slice().sort((a, b) => a - b);
  for (const k of [1, 3, 5, 10, 20]) {
    const t = s.slice(0, s.length - k);
    console.log(`  drop ${String(k).padStart(2)} best trades: alpha ${f(t.reduce((a, b) => a + b, 0) / t.length)}  (n=${t.length})`);
  }
  const wins = adj.filter(x => x > 0).length;
  console.log(`  hit rate ${fp(100 * ps.filter(x => x.p > 0).length / n)}%  (breakeven ${fp(100 * (sl + COST) / (tp + sl))}%)`);

  // day-block bootstrap: resample whole UTC days, which keeps the clustering
  const byDay = new Map();
  ps.forEach((x, k) => { const d = day(x.i); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(adj[k]); });
  const dayKeys = [...byDay.keys()];
  const r = rng(555111);
  let pos = 0; const means = [];
  for (let b = 0; b < 4000; b++) {
    let t = 0, c = 0;
    for (let k = 0; k < dayKeys.length; k++) {
      const arr = byDay.get(dayKeys[Math.floor(r() * dayKeys.length)]);
      for (const v of arr) { t += v; c++; }
    }
    const mm = t / c; means.push(mm); if (mm > 0) pos++;
  }
  means.sort((a, b) => a - b);
  console.log(`  day-block bootstrap over ${dayKeys.length} days: alpha > 0 in ${fp(100 * pos / 4000)}% of 4000 resamples`);
  console.log(`  90% interval ${f(means[200])} .. ${f(means[3800])}   5th pct ${f(means[200])}`);

  // placebo: same number of shorts at random times, 4000 draws — how often does
  // a random pick of n shorts beat the observed alpha?
  const rr = rng(31415);
  let beat = 0;
  const lo = 100, hi = N - hold - 2;
  for (let b = 0; b < 4000; b++) {
    let t = 0, c = 0;
    for (let k = 0; k < n; k++) {
      const p = race(lo + Math.floor(rr() * (hi - lo)), -1, tp, sl, hold);
      if (p === null) continue;
      t += p - bs; c++;
    }
    if (t / c >= mean) beat++;
  }
  console.log(`  random-time short baskets of n=${n}: ${fp(100 * beat / 4000, 2)}% reach the observed alpha`);
}

// ═══ flat placebo ════════════════════════════════════════════════════════════
function stageFlat() {
  const { m, opts, tp, sl, hold } = BEST;
  const real = score(events(), tp, sl, hold);
  console.log(`real  (sloping ray)     alpha ${f(real.alpha)}  n=${real.n}`);
  const { line } = buildLine(m, { ...opts, flatten: true });
  const ev = ONLY.brkDown(levelTestEvents(bars, line, atr1));
  const s = score(ev, tp, sl, hold);
  console.log(`flat  (horizontal at 2nd anchor, same births/deaths)  alpha ${f(s.alpha)}  n=${s.n}`);

  // random-slope placebo, re-run independently
  const { bars: hb, atr: ha } = tf(m);
  const pool = [];
  risingTrendline(hb, ha, { ...opts, collectSlopes: pool });
  const out = [];
  for (let k = 0; k < 10; k++) {
    const r = rng(777 + k * 1013);
    const { line: L } = buildLine(m, { ...opts, slopePool: pool, slopeRng: r });
    const e2 = ONLY.brkDown(levelTestEvents(bars, L, atr1));
    const ss = score(e2, tp, sl, hold);
    out.push(ss.alpha);
    console.log(`  random-slope ${String(k).padStart(2)}  alpha ${f(ss.alpha)}  n=${ss.n}`);
  }
  console.log(`  random-slope mean ${f(out.reduce((a, b) => a + b, 0) / out.length)}`);
}

const stage = process.argv[2] || 'repro';
({ repro: stageRepro, look: stageLook, match: stageMatch, cluster: stageCluster,
   oos: stageOos, sig: stageSig, flat: stageFlat }[stage] || stageRepro)();

// ═══ extra stages appended during verification ═══════════════════════════════
function stageMore() {
  const { tp, sl, hold } = BEST;
  const list = events();
  const cut = Date.parse('2026-05-01T00:00:00Z');
  const inS = list.filter(e => bars[e.i].t < cut), outS = list.filter(e => bars[e.i].t >= cut);
  console.log('CLAIMED construction 15m/brkDown at 90/60/240');
  console.log(`  Jan-Apr  alpha ${f(score(inS, tp, sl, hold).alpha)} on ${score(inS, tp, sl, hold).n}`);
  console.log(`  May-Jul  alpha ${f(score(outS, tp, sl, hold).alpha)} on ${score(outS, tp, sl, hold).n}`);

  // equal weight by month, so one hot month cannot carry the answer
  const bs = blind(-1, tp, sl, hold);
  const by = new Map();
  for (const x of payoffs(list)) {
    const k = month(x.i);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(x.p - bs);
  }
  const ms = [...by.entries()].sort();
  const mm = ms.map(([k, v]) => v.reduce((a, b) => a + b, 0) / v.length);
  console.log(`\n  equal-weight-by-month alpha ${f(mm.reduce((a, b) => a + b, 0) / mm.length)}   months positive ${mm.filter(x => x > 0).length}/${mm.length}`);
  console.log(`  median month ${f(mm.slice().sort((a, b) => a - b)[mm.length >> 1])}`);

  // TP/SL surface: spike or plateau?
  console.log('\nTP/SL surface on the FULL sample (alpha, brkDown, hold 240)');
  const SLS = [30, 45, 60, 75, 90, 120];
  console.log('TP    ' + SLS.map(s => ('SL' + s).padStart(8)).join(''));
  for (const t of [45, 60, 70, 80, 90, 100, 110, 120, 150, 200, 250]) {
    console.log(String(t).padEnd(6) + SLS.map(s2 => f(score(list, t, s2, hold).alpha, 1).padStart(8)).join(''));
  }
  console.log('\nhold sensitivity at 90/60: ' + [60, 120, 240, 480, 720, 1440]
    .map(h => `${h}m ${f(score(list, 90, 60, h).alpha, 1)}`).join('   '));

  // detector settings
  console.log('\ndetector sensitivity (tol / approach / break), alpha (n)');
  const { line } = buildLine(BEST.m, BEST.opts);
  for (const tolAtr of [0.1, 0.2, 0.35])
    for (const approachAtr of [1.0, 1.5, 2.5]) {
      let row = `tol ${tolAtr} appr ${approachAtr}: `;
      for (const breakAtr of [0.15, 0.25, 0.5]) {
        const ev = ONLY.brkDown(levelTestEvents(bars, line, atr1, { tolAtr, approachAtr, breakAtr }));
        const s = score(ev, tp, sl, hold);
        row += `${f(s.alpha, 1)}(${s.n})`.padStart(14);
      }
      console.log(row);
    }
}

function stageFam() {
  const { tp, sl, hold } = BEST;
  const cut = Date.parse('2026-05-01T00:00:00Z');
  const rows = [];
  for (const m of [5, 15, 60]) {
    for (const lr of [3, 4, 5, 6, 8, 10]) {
      for (const pierce of [0, 0.05, 0.1, 0.3]) {
        for (const brk of [0.25, 0.4, 0.7, 1.0]) {
          for (const span of [[4, 60], [6, 200], [6, 400]]) {
            for (const proj of [60, 200, 600]) {
              const o = { left: lr, right: lr, minSpan: Math.max(span[0], lr), maxSpan: span[1],
                          pierceAtr: pierce, maxProject: proj, breakAtr: brk };
              let ev;
              try { const { line } = buildLine(m, o); ev = ONLY.brkDown(levelTestEvents(bars, line, atr1)); }
              catch (e) { continue; }
              if (ev.length < 100) continue;
              const s = score(ev, tp, sl, hold);
              const so = score(ev.filter(e => bars[e.i].t >= cut), tp, sl, hold);
              rows.push({ m, o, a: s.alpha, n: s.n, ao: so.alpha, no: so.n });
            }
          }
        }
      }
    }
  }
  const byTf = new Map();
  for (const r of rows) { if (!byTf.has(r.m)) byTf.set(r.m, []); byTf.get(r.m).push(r); }
  console.log(`${rows.length} generator variants with >=100 brkDown events, scored at 90/60/240\n`);
  for (const [m, rs] of [...byTf.entries()].sort((a, b) => a[0] - b[0])) {
    const a = rs.map(x => x.a).sort((x, y) => x - y);
    const ao = rs.map(x => x.ao).sort((x, y) => x - y);
    console.log(`  ${m}m  ${String(rs.length).padStart(3)} variants   full-sample mean ${f(a.reduce((x, y) => x + y, 0) / a.length)}  median ${f(a[a.length >> 1])}  min ${f(a[0])}  max ${f(a[a.length - 1])}  ${fp(100 * a.filter(x => x > 0).length / a.length, 0)}% positive`);
    console.log(`         ${' '.repeat(12)}   May-Jul only  mean ${f(ao.reduce((x, y) => x + y, 0) / ao.length)}  median ${f(ao[ao.length >> 1])}  ${fp(100 * ao.filter(x => x > 0).length / ao.length, 0)}% positive`);
  }
  rows.sort((x, y) => y.a - x.a);
  console.log('\n  claimed config rank: ' + (1 + rows.findIndex(r => r.m === 15 && r.o.left === 5 && r.o.pierceAtr === 0.1 && r.o.breakAtr === 0.4 && r.o.maxSpan === 200 && r.o.maxProject === 200)) + ` of ${rows.length}`);
  console.log('  best 5:');
  for (const r of rows.slice(0, 5)) console.log(`    ${r.m}m ${f(r.a)} n=${r.n}  ${JSON.stringify(r.o)}`);
  console.log('  worst 5:');
  for (const r of rows.slice(-5)) console.log(`    ${r.m}m ${f(r.a)} n=${r.n}  ${JSON.stringify(r.o)}`);
}

if (process.argv[2] === 'more') stageMore();
if (process.argv[2] === 'fam') stageFam();

/*
 * The sharpest remaining alternative explanation: the ray is incidental and
 * ANY downside breakout short works in this sample. Controls that use the
 * IDENTICAL detector, sizing and baseline, but a level with no trendline in it
 * at all:
 *   donchian K   the lowest low of the previous K 15m bars
 *   flatAnchor   horizontal at the most recent confirmed 5/5 pivot low
 */
function stageAlt() {
  const { tp, sl, hold } = BEST;
  const cut = Date.parse('2026-05-01T00:00:00Z');
  const real = events();
  console.log(`REAL rising ray, brkDown: alpha ${f(score(real, tp, sl, hold).alpha)} n=${score(real).n}\n`);

  const { bars: hb, index } = tf(15);
  const show = (name, hline) => {
    const line = E.projectConfirmed(hline, index);
    const ev = ONLY.brkDown(levelTestEvents(bars, line, atr1));
    if (ev.length < 60) { console.log(`  ${name.padEnd(26)} only ${ev.length} events`); return; }
    const s = score(ev, tp, sl, hold);
    const so = score(ev.filter(e => bars[e.i].t >= cut), tp, sl, hold);
    console.log(`  ${name.padEnd(26)} alpha ${f(s.alpha).padStart(8)}  n=${String(s.n).padStart(4)}   May-Jul ${f(so.alpha).padStart(8)} n=${so.n}`);
  };

  for (const K of [10, 20, 40, 80, 160]) {
    const l = new Array(hb.length).fill(NaN);
    for (let i = K; i < hb.length; i++) {
      let m = Infinity;
      for (let j = i - K; j < i; j++) m = Math.min(m, hb[j].l);
      l[i] = m;
    }
    show(`donchian low ${K} x15m`, l);
  }

  // horizontal at the most recent confirmed pivot low, same 5/5 pivots
  const { lows } = LV.pivots(hb, 5, 5);
  const l2 = new Array(hb.length).fill(NaN);
  let k = 0, cur = NaN;
  for (let i = 0; i < hb.length; i++) {
    while (k < lows.length && lows[k].knownAt <= i) { cur = lows[k].price; k++; }
    l2[i] = cur;
  }
  show('flat at last pivot low', l2);

  // sloping ray flattened to horizontal at its own second anchor
  const { line: fl } = buildLine(15, { ...BEST.opts, flatten: true });
  const fev = ONLY.brkDown(levelTestEvents(bars, fl, atr1));
  const fs2 = score(fev, tp, sl, hold);
  const fso = score(fev.filter(e => bars[e.i].t >= cut), tp, sl, hold);
  console.log(`  ${'flatten same births'.padEnd(26)} alpha ${f(fs2.alpha).padStart(8)}  n=${String(fs2.n).padStart(4)}   May-Jul ${f(fso.alpha).padStart(8)} n=${fso.n}`);

  // random-slope placebo, independently re-run
  const { atr: ha } = tf(15);
  const pool = [];
  risingTrendline(hb, ha, { ...BEST.opts, collectSlopes: pool });
  const out = [];
  for (let q = 0; q < 10; q++) {
    const r = rng(777 + q * 1013);
    const { line: L } = buildLine(15, { ...BEST.opts, slopePool: pool, slopeRng: r });
    const e2 = ONLY.brkDown(levelTestEvents(bars, L, atr1));
    out.push(score(e2, tp, sl, hold).alpha);
  }
  out.sort((a, b) => a - b);
  console.log(`  ${'random-slope placebo x10'.padEnd(26)} mean ${f(out.reduce((a, b) => a + b, 0) / out.length)}  min ${f(out[0])}  max ${f(out[9])}`);

  // falling-market sanity: what does a plain "short every 15m bar close that is
  // a 20-bar low" give, no level machinery at all?
  console.log('');
  const bs = blind(-1, tp, sl, hold);
  for (const K of [20, 80]) {
    let n = 0, net = 0, last = -1e9;
    for (let i = K + 5; i < hb.length; i++) {
      let m = Infinity;
      for (let j = i - K; j < i; j++) m = Math.min(m, hb[j].l);
      if (!(hb[i].c < m)) continue;
      // enter on the first 1m bar of the NEXT 15m candle
      let e1 = -1;
      for (let x = 0; x < N; x++) { if (index[x] === i + 1) { e1 = x; break; } }
      if (e1 < 0 || e1 - last < hold) continue;
      const p = race(e1, -1, tp, sl, hold);
      if (p === null) continue;
      last = e1; n++; net += p;
    }
    console.log(`  plain ${K}-bar-low breakdown short (no line): n=${n} alpha ${f(net / n - bs)}`);
  }
}
if (process.argv[2] === 'alt') stageAlt();

/*
 * The +/-4h control is contaminated: half its draws land AFTER the event and
 * inside the very move the trade is trying to catch, so it understates the
 * edge. A clean local control draws only from BEFORE the signal — "was this
 * neighbourhood already a good place to be short, without the signal?"
 */
function stagePre() {
  const { tp, sl, hold } = BEST;
  const ps = payoffs(events());
  const r = rng(8181);
  for (const W of [120, 240, 480, 1440]) {
    let sum = 0, n = 0; const per = [];
    for (const x of ps) {
      const lo = Math.max(100, x.i - W), hi = x.i - 1;
      if (hi - lo < 30) continue;
      let s = 0, c = 0;
      for (let k = 0; k < 400; k++) {
        const p = race(lo + Math.floor(r() * (hi - lo)), -1, tp, sl, hold);
        if (p === null) continue;
        s += p; c++;
      }
      if (!c) continue;
      per.push(x.p - s / c); sum += x.p - s / c; n++;
    }
    const m = sum / n;
    const sd = Math.sqrt(per.reduce((a, v) => a + (v - m) ** 2, 0) / (n - 1));
    console.log(`prior-${String(W).padStart(4)}m-only matched: n=${n}  alpha ${f(m)}  t ${fp(m / (sd / Math.sqrt(n)), 2)}`);
  }
  // and the symmetric one for reference
  const bs = blind(-1, tp, sl, hold);
  console.log(`uniform blind short baseline ${f(bs)}   raw mean ${f(ps.reduce((a, b) => a + b.p, 0) / ps.length)}`);
}
if (process.argv[2] === 'pre') stagePre();
