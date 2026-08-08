'use strict';
/* ===========================================================================
 * REFUTATION PASS — "Session range high and low"
 *
 * Independent re-implementation.  Nothing is imported from session-range.js
 * except, at the very end, a cross-check that my level series is bit-identical
 * to theirs.  The loader, the outcome engine, the baselines, the event
 * pipeline and the statistics are all written fresh here so that a shared bug
 * cannot survive in both.
 *
 * Order of attack, per the brief:
 *   1. lookahead   — streaming replay of the level, bar by bar
 *   2. direction   — my own blind baselines at every box actually quoted
 *   3. selection   — derive on Jan-Apr, judge on May-Jul
 *   4. sample      — naive t, day-clustered t, and a day-block bootstrap
 *                    (events overlap: MAX_HOLD is 1440 bars = a full day, and
 *                     ~7.5 events fire per day, so the naive SE is a fiction)
 *
 * Usage: node --max-old-space-size=3500 tools/fixes/session-range-verify.js [stage]
 * =========================================================================== */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('../ai963_engine');
const { levelTestEvents, respectRate } = require('../level_events');

const PU = 0.10, COST = 0.5, MAX_HOLD = 1440;
const RANDOM_RESPECT = 68.95;

// ── data (copied verbatim from tools/sweep_timeframes.js) ───────────────────
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

// ── outcome engine — semantics identical to sweep_timeframes.js::race ───────
// Grid form so one forward walk serves every box I quote.
const TPS = [30, 50, 75, 90, 120, 150, 200, 250, 300];
const SLS = [30, 50, 75, 90, 120, 150, 200, 250, 300];
const NT = TPS.length, NS = SLS.length, NP = NT * NS;
const KI = (tp, sl) => TPS.indexOf(tp) * NS + SLS.indexOf(sl);
const _tp = new Int32Array(NT), _sl = new Int32Array(NS);

function walk(i, dir) {
  const e = bars[i].c;
  const end = Math.min(N - 1, i + MAX_HOLD);
  _tp.fill(-1); _sl.fill(-1);
  let a = 0, b = 0;
  for (let j = i + 1; j <= end; j++) {
    const q = bars[j];
    const fav = dir === 1 ? (q.h - e) / PU : (e - q.l) / PU;
    const adv = dir === 1 ? (e - q.l) / PU : (q.h - e) / PU;
    while (a < NT && fav >= TPS[a]) _tp[a++] = j;
    while (b < NS && adv >= SLS[b]) _sl[b++] = j;
    if (a >= NT && b >= NS) break;
  }
  return (bars[end].c - e) * dir / PU;
}
/** points for one entry at one box; null when the bar is ambiguous. */
function pnlAt(tp, sl, closeOut) {
  const ta = _tp[TPS.indexOf(tp)], sb = _sl[SLS.indexOf(sl)];
  if (ta < 0 && sb < 0) return closeOut - COST;
  if (ta >= 0 && (sb < 0 || ta < sb)) return tp - COST;
  if (sb >= 0 && (ta < 0 || sb < ta)) return -sl - COST;
  return null;                                  // same bar: discarded
}
function accum(sum, cnt, closeOut) {
  for (let a = 0; a < NT; a++) {
    const ta = _tp[a];
    for (let b = 0; b < NS; b++) {
      const sb = _sl[b];
      let p;
      if (ta < 0 && sb < 0) p = closeOut - COST;
      else if (ta >= 0 && (sb < 0 || ta < sb)) p = TPS[a] - COST;
      else if (sb >= 0 && (ta < 0 || sb < ta)) p = -SLS[b] - COST;
      else continue;
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
function blind(dir, n, seed, hours = null) {
  const pool = [];
  const ok = hours ? new Set(hours) : null;
  for (let i = 100; i < N - MAX_HOLD - 2; i++) if (!ok || ok.has(new Date(bars[i].t).getUTCHours())) pool.push(i);
  const r = rng(seed);
  const sum = new Float64Array(NP), cnt = new Int32Array(NP);
  for (let k = 0; k < n; k++) accum(sum, cnt, walk(pool[Math.floor(r() * pool.length)], dir));
  const out = new Float64Array(NP);
  for (let k = 0; k < NP; k++) out[k] = cnt[k] ? sum[k] / cnt[k] : NaN;
  return out;
}
let BL = null;
function baselines() {
  if (!BL) BL = { L: blind(1, 40000, 20260808), S: blind(-1, 40000, 80620202) };
  return BL;
}

// ── per-trade direction-adjusted residuals, with honest standard errors ─────
/**
 * Every trade becomes (pnl - blind baseline for its own direction).  The mean
 * of that column IS the direction-adjusted alpha, weighted by count by
 * construction, so it and the t-statistic come from the same numbers.
 */
function residuals(events, tp, sl, bl) {
  const B = bl || baselines();
  const k = KI(tp, sl);
  const out = [];
  for (const ev of events) {
    const co = walk(ev.i, ev.dir);
    const p = pnlAt(tp, sl, co);
    if (p === null) continue;
    out.push({
      x: p - (ev.dir === 1 ? B.L[k] : B.S[k]),
      raw: p,
      dir: ev.dir,
      day: Math.floor(bars[ev.i].t / 86400000),
      t: bars[ev.i].t,
    });
  }
  return out;
}
function meanSd(a) {
  const n = a.length;
  if (n < 2) return { n, mean: NaN, sd: NaN };
  let m = 0; for (const v of a) m += v; m /= n;
  let s = 0; for (const v of a) s += (v - m) ** 2;
  return { n, mean: m, sd: Math.sqrt(s / (n - 1)) };
}
/**
 * Naive SE assumes 1053 independent draws.  They are not: MAX_HOLD is a full
 * trading day and roughly seven events fire per day, so the same 24 hours of
 * price is reused by every one of them.  The cluster-robust SE groups by
 * calendar day; the block bootstrap resamples whole days.
 */
function stats(res, seed = 777) {
  const xs = res.map(r => r.x);
  const { n, mean, sd } = meanSd(xs);
  const seNaive = sd / Math.sqrt(n);
  // cluster-robust by day
  const byDay = new Map();
  for (const r of res) { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day).push(r.x); }
  let ss = 0;
  for (const g of byDay.values()) { let s = 0; for (const v of g) s += (v - mean); ss += s * s; }
  const G = byDay.size;
  const seCluster = Math.sqrt(ss * (G / Math.max(1, G - 1))) / n;
  // day-block bootstrap
  const days = [...byDay.keys()];
  const r = rng(seed);
  const boots = [];
  for (let b = 0; b < 2000; b++) {
    let s = 0, c = 0;
    for (let d = 0; d < days.length; d++) {
      const g = byDay.get(days[Math.floor(r() * days.length)]);
      for (const v of g) { s += v; c++; }
    }
    if (c) boots.push(s / c);
  }
  boots.sort((a, b) => a - b);
  return {
    n, mean, sd, G,
    seNaive, tNaive: mean / seNaive,
    seCluster, tCluster: mean / seCluster,
    bootLo: boots[Math.floor(0.025 * boots.length)],
    bootHi: boots[Math.floor(0.975 * boots.length)],
    bootP: boots.filter(v => v <= 0).length / boots.length,
  };
}

// ── the level, written from scratch ─────────────────────────────────────────
/**
 * Two fixed daily values: the high and the low of a UTC window.  Published on
 * the (delay+1)-th bar after the window's last bar, retired after `holdMin`.
 * `minBars` throws away half-empty sessions.  Deliberately written differently
 * from theirs (explicit session list, then a paint pass) so a shared control
 * flow bug cannot hide.
 */
function sessionEdges(bs, opts = {}) {
  const s0 = Math.round((opts.startHour ?? 1) * 60);
  const s1 = Math.round((opts.endHour ?? 7) * 60);
  const wrap = s1 <= s0;
  const holdMin = opts.holdMin ?? 17 * 60;
  const delay = opts.delayBars ?? 1;
  const minBars = opts.minBars ?? 200;
  const n = bs.length;
  const inWin = i => {
    const d = new Date(bs[i].t), m = d.getUTCHours() * 60 + d.getUTCMinutes();
    return wrap ? (m >= s0 || m < s1) : (m >= s0 && m < s1);
  };
  const keyOf = i => {
    const d = new Date(bs[i].t), m = d.getUTCHours() * 60 + d.getUTCMinutes();
    const day = Math.floor(bs[i].t / 86400000);
    return wrap && m >= s0 ? day + 1 : day;
  };
  // pass 1 — collect sessions, remembering the index of the LAST in-window bar
  const sess = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    if (inWin(i)) {
      const k = keyOf(i);
      if (!cur || cur.key !== k) { if (cur) sess.push(cur); cur = { key: k, hi: -Infinity, lo: Infinity, cnt: 0, last: i }; }
      if (bs[i].h > cur.hi) cur.hi = bs[i].h;
      if (bs[i].l < cur.lo) cur.lo = bs[i].l;
      cur.cnt++; cur.last = i;
    }
  }
  if (cur) sess.push(cur);
  // pass 2 — paint, strictly forward of `last`
  const hi = new Array(n).fill(NaN), lo = new Array(n).fill(NaN), width = new Array(n).fill(NaN);
  const kept = [];
  for (const s of sess) {
    if (s.cnt < minBars || !(s.hi > s.lo)) continue;
    const first = s.last + 1 + delay;               // first bar allowed to see it
    if (first >= n) continue;
    const tEnd = bs[s.last + 1] ? bs[s.last + 1].t : bs[s.last].t;
    kept.push({ ...s, first, tEnd, w: (s.hi - s.lo) / PU });
    for (let i = first; i < n; i++) {
      if (bs[i].t - tEnd > holdMin * 60000) break;
      hi[i] = s.hi; lo[i] = s.lo; width[i] = (s.hi - s.lo) / PU;
    }
  }
  return { hi, lo, width, sessions: kept };
}

const ASIA = { startHour: 1, endHour: 7, holdMin: 17 * 60, minBars: 200 };

const bounce = ev => ev.filter(e => e.kind === 'reject');
const brk = ev => ev.filter(e => e.kind === 'break');
const flip = ev => ev.map(e => ({ ...e, dir: -e.dir }));
function pooled(L, pick = bounce) {
  return [...pick(levelTestEvents(bars, L.hi, atr1)), ...pick(levelTestEvents(bars, L.lo, atr1))]
    .sort((a, b) => a.i - b.i);
}

const f = (x, d = 2) => Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '   —';
const g = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '—';
const pad = (s, n) => String(s).padEnd(n);
const rp = (s, n) => String(s).padStart(n);
const hr = (n = 88) => console.log('─'.repeat(n));
const head = t => { console.log('\n' + t); hr(); };

// ═══════════════════════════════════════════════════════════════════════════
// 1. LOOKAHEAD
// ═══════════════════════════════════════════════════════════════════════════
function stageLookahead() {
  head('1. LOOKAHEAD — can the level be known when it is drawn?');
  const L = sessionEdges(bars, ASIA);

  // (a) streaming replay: rebuild from bars[0..i] only, at every 137th live bar
  let checked = 0, bad = 0, worst = 0;
  for (let i = 300; i < N; i += 137) {
    if (!Number.isFinite(L.hi[i])) continue;
    const t = sessionEdges(bars.slice(0, i + 1), ASIA);
    checked++;
    const dh = Math.abs(t.hi[i] - L.hi[i]), dl = Math.abs(t.lo[i] - L.lo[i]);
    if (!(dh < 1e-9) || !(dl < 1e-9)) { bad++; worst = Math.max(worst, dh || 0, dl || 0); }
  }
  console.log(`streaming rebuild at ${checked} live bars — mismatches ${bad}${bad ? `  worst ${g(worst, 4)}` : ''}`);

  // (b) the level must never be live while its own window is still open
  let live = 0;
  for (let i = 0; i < N; i++) {
    if (!Number.isFinite(L.hi[i])) continue;
    const h = new Date(bars[i].t).getUTCHours();
    if (h >= 1 && h < 7) live++;
  }
  console.log(`bars where a level is live during hours 01-07: ${live}   (must be 0)`);

  // (c) publication gap in bars, measured directly
  let minGap = Infinity;
  for (const s of L.sessions) minGap = Math.min(minGap, s.first - s.last);
  console.log(`smallest gap between the window's last bar and first visible bar: ${minGap} bars`);

  // (d) does the value ever equal an extreme made after publication?
  let viol = 0;
  for (const s of L.sessions) {
    for (let i = s.last + 1; i < Math.min(N, s.first); i++) {
      if (bars[i].h > s.hi + 1e-9 || bars[i].l < s.lo - 1e-9) { /* fine, that is future price */ }
    }
    // recompute the extreme from the window alone
    let h = -Infinity, l = Infinity;
    for (let i = s.last; i >= 0; i--) {
      const d = new Date(bars[i].t), m = d.getUTCHours() * 60 + d.getUTCMinutes();
      if (!(m >= 60 && m < 420)) break;
      h = Math.max(h, bars[i].h); l = Math.min(l, bars[i].l);
    }
    if (Math.abs(h - s.hi) > 1e-9 || Math.abs(l - s.lo) > 1e-9) viol++;
  }
  console.log(`sessions whose published value is not the window's own extreme: ${viol}`);

  // (e) events: entry uses only the signal bar's close, outcome starts next bar
  const ev = pooled(L);
  console.log(`\nevents ${ev.length}   sessions kept ${L.sessions.length}   first event ${new Date(bars[ev[0].i].t).toISOString().slice(0, 16)}`);
  const hrs = {};
  for (const e of ev) { const h = new Date(bars[e.i].t).getUTCHours(); hrs[h] = (hrs[h] || 0) + 1; }
  console.log('events by UTC hour: ' + Object.keys(hrs).sort((a, b) => a - b).map(h => `${h}:${hrs[h]}`).join(' '));
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. DIRECTION + the headline number, recomputed
// ═══════════════════════════════════════════════════════════════════════════
function stageDirection() {
  head('2. DIRECTION — my own blind baselines, then the headline recomputed');
  const B = baselines();
  console.log(pad('box', 12) + rp('blind long', 13) + rp('blind short', 13) + rp('their claim', 26));
  const claims = { '90/90': '-5.05 / +4.10', '150/120': '-8.55 / +7.75' };
  for (const [tp, sl] of [[90, 90], [120, 120], [150, 120], [200, 150], [250, 200]]) {
    const k = KI(tp, sl);
    console.log(pad(`${tp}/${sl}`, 12) + rp(f(B.L[k]), 13) + rp(f(B.S[k]), 13) + rp(claims[`${tp}/${sl}`] || '', 26));
  }
  console.log(`brief calibration: blind long about -4.8, blind short about +4.3 (at 90/90)`);

  const L = sessionEdges(bars, ASIA);
  const evH = bounce(levelTestEvents(bars, L.hi, atr1));
  const evL = bounce(levelTestEvents(bars, L.lo, atr1));
  const ev = [...evH, ...evL].sort((a, b) => a.i - b.i);
  const rH = respectRate(levelTestEvents(bars, L.hi, atr1));
  const rL = respectRate(levelTestEvents(bars, L.lo, atr1));
  console.log(`\nrespect  high ${g(rH.respect, 1)}% (${rH.tests} tests)   low ${g(rL.respect, 1)}% (${rL.tests})   random ${RANDOM_RESPECT}%`);

  head('THE CLAIMED CELL — asia 01-07, both edges, bounce, 150/120');
  const res = residuals(ev, 150, 120);
  const nL = res.filter(r => r.dir === 1).length, nS = res.length - nL;
  const raw = res.reduce((a, r) => a + r.raw, 0) / res.length;
  const s = stats(res);
  console.log(`events ${ev.length} (${evH.length} at the high, ${evL.length} at the low)   settled ${res.length}   longs ${nL} / shorts ${nS}`);
  console.log(`raw ${f(raw)} pts/trade    DIRECTION-ADJUSTED ALPHA ${f(s.mean)} pts/trade`);
  console.log(`their claim: raw +4.50, alpha +5.85, t 1.42, se 4.1, n 1053 (524L/529S)`);
  const bl = baselines(), k = KI(150, 120);
  console.log(`implied baseline of my mix: ${f((nL * bl.L[k] + nS * bl.S[k]) / res.length)}  ->  raw - baseline = ${f(raw - (nL * bl.L[k] + nS * bl.S[k]) / res.length)}`);

  // long and short alpha separately: a level has to work on both sides
  const rl = meanSd(res.filter(r => r.dir === 1).map(r => r.x));
  const rs = meanSd(res.filter(r => r.dir === -1).map(r => r.x));
  console.log(`\nalpha(long)  ${f(rl.mean)}  n ${rl.n}   se ${g(rl.sd / Math.sqrt(rl.n), 1)}`);
  console.log(`alpha(short) ${f(rs.mean)}  n ${rs.n}   se ${g(rs.sd / Math.sqrt(rs.n), 1)}`);

  // clock-matched baseline, recomputed by me
  const hours = [...new Set(ev.map(e => new Date(bars[e.i].t).getUTCHours()))].sort((a, b) => a - b);
  const cl = { L: blind(1, 20000, 5150001, hours), S: blind(-1, 20000, 5150002, hours) };
  const res2 = residuals(ev, 150, 120, cl);
  console.log(`\nclock-matched baseline (hours ${hours.join(',')}): blind long ${f(cl.L[k])} short ${f(cl.S[k])}`);
  console.log(`alpha against the clock-matched baseline: ${f(meanSd(res2.map(r => r.x)).mean)}   (they say +6.15)`);
  return { ev, L };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. SAMPLE — the standard error they quote assumes independence it does not
//    have.  Overlapping 24-hour holds, seven events a day.
// ═══════════════════════════════════════════════════════════════════════════
function stageSample(ev) {
  head('3. SAMPLE — is +5.85 distinguishable from zero once overlap is admitted?');
  console.log('MAX_HOLD is 1440 bars.  Events fire ~7 per day, so their 24h outcome');
  console.log('windows are the same 24 hours of price.  The naive SE treats them as');
  console.log('independent draws; the day-clustered SE and the day-block bootstrap do not.\n');
  console.log(pad('box', 12) + rp('n', 6) + rp('alpha', 9) + rp('se naive', 10) + rp('t naive', 9)
    + rp('se day', 9) + rp('t day', 8) + rp('boot 95%', 20) + rp('P(a<=0)', 9));
  hr();
  for (const [tp, sl] of [[90, 90], [120, 120], [150, 120], [150, 150], [200, 150], [200, 200], [250, 200]]) {
    const s = stats(residuals(ev, tp, sl));
    console.log(pad(`${tp}/${sl}`, 12) + rp(s.n, 6) + rp(f(s.mean, 1), 9) + rp(g(s.seNaive, 1), 10) + rp(g(s.tNaive), 9)
      + rp(g(s.seCluster, 1), 9) + rp(g(s.tCluster), 8) + rp(`${f(s.bootLo, 1)} .. ${f(s.bootHi, 1)}`, 20) + rp(g(s.bootP, 3), 9));
  }
  console.log(`\ntrading days containing at least one event: ${new Set(ev.map(e => Math.floor(bars[e.i].t / 86400000))).size}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. SELECTION — derive on Jan-Apr, judge on May-Jul.  Nothing re-tuned.
// ═══════════════════════════════════════════════════════════════════════════
const SPLIT = Date.parse('2026-05-01T00:00:00Z');
function stageSelection() {
  head('4. SELECTION — derive on Jan-Apr, judge on May-Jul (box fixed, never re-fit)');
  const L = sessionEdges(bars, ASIA);
  const ev = pooled(L);
  const inA = e => bars[e.i].t < SPLIT, inB = e => bars[e.i].t >= SPLIT;
  const A = ev.filter(inA), B = ev.filter(inB);
  console.log(`Jan-Apr ${A.length} events   May-Jul ${B.length} events\n`);
  console.log(pad('box', 12) + rp('derive a', 10) + rp('t', 7) + rp('judge a', 10) + rp('t', 7) + rp('n(judge)', 10));
  hr();
  let bestBox = null, bestA = -Infinity;
  for (const [tp, sl] of [[90, 90], [120, 90], [120, 120], [150, 120], [150, 150], [200, 150], [200, 200], [250, 200], [300, 200]]) {
    const a = stats(residuals(A, tp, sl)), b = stats(residuals(B, tp, sl));
    if (a.mean > bestA) { bestA = a.mean; bestBox = [tp, sl]; }
    console.log(pad(`${tp}/${sl}`, 12) + rp(f(a.mean, 1), 10) + rp(g(a.tCluster), 7) + rp(f(b.mean, 1), 10) + rp(g(b.tCluster), 7) + rp(b.n, 10));
  }
  console.log(`\nbox that maximises the DERIVE half: ${bestBox[0]}/${bestBox[1]}  (alpha ${f(bestA, 1)})`);
  const oos = stats(residuals(B, bestBox[0], bestBox[1]));
  console.log(`that box on the JUDGE half: alpha ${f(oos.mean, 1)}  n ${oos.n}  t(day) ${g(oos.tCluster)}  boot 95% ${f(oos.bootLo, 1)} .. ${f(oos.bootHi, 1)}`);

  head('the window itself is also a choice — every window at the claimed box 150/120');
  const WINDOWS = [
    ['asia 01-07 (claimed)', ASIA],
    ['asia 01-08', { startHour: 1, endHour: 8, holdMin: 16 * 60, minBars: 240 }],
    ['asia 01-06', { startHour: 1, endHour: 6, holdMin: 18 * 60, minBars: 170 }],
    ['asia 23-08 wrap', { startHour: 23, endHour: 8, holdMin: 16 * 60, minBars: 300 }],
    ['london 08-13', { startHour: 8, endHour: 13, holdMin: 11 * 60, minBars: 170 }],
    ['london 07-12', { startHour: 7, endHour: 12, holdMin: 12 * 60, minBars: 170 }],
    ['ny 13-21', { startHour: 13, endHour: 21, holdMin: 12 * 60, minBars: 240 }],
    ['ny 14-20', { startHour: 14, endHour: 20, holdMin: 13 * 60, minBars: 200 }],
  ];
  console.log(pad('window', 24) + rp('n', 6) + rp('alpha', 9) + rp('t naive', 9) + rp('t day', 8) + rp('Jan-Apr', 9) + rp('May-Jul', 9));
  hr();
  const all = [];
  for (const [nm, o] of WINDOWS) {
    const e2 = pooled(sessionEdges(bars, o));
    if (e2.length < 100) { console.log(pad(nm, 24) + rp(e2.length, 6) + '   too few'); continue; }
    const s = stats(residuals(e2, 150, 120));
    const a = stats(residuals(e2.filter(inA), 150, 120)), b = stats(residuals(e2.filter(inB), 150, 120));
    all.push(s.mean);
    console.log(pad(nm, 24) + rp(s.n, 6) + rp(f(s.mean, 1), 9) + rp(g(s.tNaive), 9) + rp(g(s.tCluster), 8) + rp(f(a.mean, 1), 9) + rp(f(b.mean, 1), 9));
  }
  const m = meanSd(all);
  console.log(`\nspread across windows: mean ${f(m.mean, 1)}  sd ${g(m.sd, 1)}  — the claimed window is one draw from this`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. PLACEBO — my own, built differently from theirs
// ═══════════════════════════════════════════════════════════════════════════
function qLine(L, q) {
  const out = new Array(N).fill(NaN);
  for (let i = 0; i < N; i++) if (Number.isFinite(L.hi[i])) out[i] = L.lo[i] + q * (L.hi[i] - L.lo[i]);
  return out;
}
function shifted(L, s) {
  const hi = L.hi.slice(), lo = L.lo.slice();
  for (let i = 0; i < N; i++) {
    if (!Number.isFinite(L.hi[i])) continue;
    const w = L.hi[i] - L.lo[i];
    hi[i] = L.hi[i] + s * w; lo[i] = L.lo[i] + s * w;
  }
  return { hi, lo, width: L.width, sessions: L.sessions };
}
/** A range of the same width, anchored to a random height around the session
 *  midpoint — draws the object's shape without its information. */
function jitterRange(L, seed) {
  const r = rng(seed);
  const hi = L.hi.slice(), lo = L.lo.slice();
  let cur = NaN, off = 0;
  for (let i = 0; i < N; i++) {
    if (!Number.isFinite(L.hi[i])) { cur = NaN; continue; }
    if (L.hi[i] !== cur) { cur = L.hi[i]; off = (r() - 0.5) * 1.2 * (L.hi[i] - L.lo[i]); }
    hi[i] = L.hi[i] + off; lo[i] = L.lo[i] + off;
  }
  return { hi, lo, width: L.width, sessions: L.sessions };
}
function stagePlacebo() {
  head('5. PLACEBO — does anything about the real extremes matter?  (box 150/120)');
  const L = sessionEdges(bars, ASIA);
  console.log('(a) HEIGHT: level(q) = low + q*(high-low).  If the extremes carry');
  console.log('    information alpha must PEAK at q=0 and q=1.\n');
  console.log('  ' + pad('q', 8) + rp('tests', 7) + rp('resp%', 8) + rp('n', 7) + rp('alpha', 9) + rp('t day', 8));
  for (const q of [-0.3, -0.15, 0, 0.15, 0.3, 0.5, 0.7, 0.85, 1, 1.15, 1.3]) {
    const line = qLine(L, q);
    const allE = levelTestEvents(bars, line, atr1);
    const e2 = bounce(allE);
    if (e2.length < 60) { console.log('  ' + pad(q, 8) + rp(allE.length, 7) + '   too few'); continue; }
    const s = stats(residuals(e2, 150, 120));
    const r = respectRate(allE);
    const tag = q === 0 ? '  <- session LOW' : q === 1 ? '  <- session HIGH' : '';
    console.log('  ' + pad(q, 8) + rp(r.tests, 7) + rp(g(r.respect, 1), 8) + rp(s.n, 7) + rp(f(s.mean, 1), 9) + rp(g(s.tCluster), 8) + tag);
  }

  console.log('\n(b) SHIFT and JITTER: the same two lines, the same width, the same');
  console.log('    publication instant, moved off the real extremes.\n');
  const real = stats(residuals(pooled(L), 150, 120));
  const pl = [];
  console.log('  ' + pad('range', 26) + rp('n', 7) + rp('alpha', 9));
  console.log('  ' + pad('REAL RANGE', 26) + rp(real.n, 7) + rp(f(real.mean, 1), 9));
  for (const s of [-0.5, -0.4, -0.3, -0.2, -0.1, 0.1, 0.2, 0.3, 0.4, 0.5]) {
    const x = stats(residuals(pooled(shifted(L, s)), 150, 120));
    pl.push(x.mean);
    console.log('  ' + pad(`shift ${s > 0 ? '+' : ''}${s} of width`, 26) + rp(x.n, 7) + rp(f(x.mean, 1), 9));
  }
  for (let k = 0; k < 8; k++) {
    const x = stats(residuals(pooled(jitterRange(L, 1000 + k * 7919)), 150, 120));
    pl.push(x.mean);
    console.log('  ' + pad(`random height draw #${k + 1}`, 26) + rp(x.n, 7) + rp(f(x.mean, 1), 9));
  }
  const m = meanSd(pl);
  console.log(`\n  placebo family: mean ${f(m.mean, 1)}  sd ${g(m.sd, 1)}  n=${m.n}`);
  console.log(`  real range z = ${g((real.mean - m.mean) / m.sd)}   (they report z = 0.43)`);
  console.log(`  placebos at or above the real range: ${pl.filter(v => v >= real.mean).length} / ${pl.length}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. DIRECTION READINGS — including the one they skipped: break-fade at an
//    asymmetric box, where it is NOT the mirror of break.
// ═══════════════════════════════════════════════════════════════════════════
function stageReadings() {
  head('6. READINGS — break and break-fade are mirrors only when target == stop');
  const L = sessionEdges(bars, ASIA);
  const evB = pooled(L, bounce), evK = pooled(L, brk);
  const sets = [
    ['bounce', evB], ['bounce-fade', flip(evB)],
    ['break', evK], ['break-fade', flip(evK)],
    ['all', [...evB, ...evK]],
  ];
  console.log(pad('reading', 14) + pad('box', 10) + rp('n', 6) + rp('raw', 9) + rp('alpha', 9) + rp('t naive', 9) + rp('t day', 8));
  hr();
  for (const [nm, e2] of sets) {
    if (e2.length < 100) continue;
    for (const [tp, sl] of [[90, 90], [150, 120], [200, 150]]) {
      const res = residuals(e2, tp, sl);
      const s = stats(res);
      const raw = res.reduce((a, r) => a + r.raw, 0) / res.length;
      console.log(pad(nm, 14) + pad(`${tp}/${sl}`, 10) + rp(s.n, 6) + rp(f(raw, 1), 9) + rp(f(s.mean, 1), 9) + rp(g(s.tNaive), 9) + rp(g(s.tCluster), 8));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. EXCURSION — measured myself
// ═══════════════════════════════════════════════════════════════════════════
function med(a) { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function stageExcursion() {
  head('7. EXCURSION — median favourable and adverse travel after a bounce test');
  const ev = pooled(sessionEdges(bars, ASIA));
  console.log('  ' + pad('horizon', 10) + rp('MFE med', 10) + rp('MAE med', 10) + rp('ratio', 9) + rp('MFE/MAE>1', 12));
  for (const H of [60, 120, 240, 480, 1440]) {
    const mfe = [], mae = []; let wins = 0;
    for (const e of ev) {
      const p = bars[e.i].c, end = Math.min(N - 1, e.i + H);
      let fv = 0, ad = 0;
      for (let j = e.i + 1; j <= end; j++) {
        const b = bars[j];
        const ff = e.dir === 1 ? (b.h - p) / PU : (p - b.l) / PU;
        const aa = e.dir === 1 ? (p - b.l) / PU : (b.h - p) / PU;
        if (ff > fv) fv = ff; if (aa > ad) ad = aa;
      }
      mfe.push(fv); mae.push(ad); if (fv > ad) wins++;
    }
    console.log('  ' + pad(H + 'm', 10) + rp(g(med(mfe), 1), 10) + rp(g(med(mae), 1), 10)
      + rp(g(med(mfe) / med(mae)), 9) + rp(`${(100 * wins / ev.length).toFixed(1)}%`, 12));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. CROSS-CHECK against their file
// ═══════════════════════════════════════════════════════════════════════════
function stageCross() {
  head('8. CROSS-CHECK — my level series vs theirs');
  const T = require('./session-range');
  const theirs = T.sessionRange(bars, { startHour: 1, endHour: 7, holdMin: 17 * 60, minBars: 200 });
  const mine = sessionEdges(bars, ASIA);
  let dh = 0, dl = 0;
  for (let i = 0; i < N; i++) {
    const a = mine.hi[i], b = theirs.hi[i];
    if (Number.isFinite(a) !== Number.isFinite(b) || (Number.isFinite(a) && Math.abs(a - b) > 1e-9)) dh++;
    const c = mine.lo[i], d = theirs.lo[i];
    if (Number.isFinite(c) !== Number.isFinite(d) || (Number.isFinite(c) && Math.abs(c - d) > 1e-9)) dl++;
  }
  console.log(`hi series differs on ${dh}/${N} bars, lo on ${dl}/${N}   sessions mine ${mine.sessions.length} theirs ${theirs.sessions.length}`);
}

const stage = process.argv[2] || 'all';
if (stage === 'lookahead' || stage === 'all') stageLookahead();
let CTX = null;
if (stage === 'direction' || stage === 'sample' || stage === 'all') CTX = stageDirection();
if (stage === 'sample' || stage === 'all') stageSample(CTX.ev);
if (stage === 'selection' || stage === 'all') stageSelection();
if (stage === 'placebo' || stage === 'all') stagePlacebo();
if (stage === 'readings' || stage === 'all') stageReadings();
if (stage === 'excursion' || stage === 'all') stageExcursion();
if (stage === 'cross' || stage === 'all') stageCross();

// ═══════════════════════════════════════════════════════════════════════════
// 9. STRESS — where the quoted +5.85 actually comes from
// ═══════════════════════════════════════════════════════════════════════════

/** The shipped nearest-edge step function, so the "before" number is mine too. */
function shippedLine(o = { startHour: 0, endHour: 7 }) {
  const out = new Array(N).fill(NaN);
  const dayOf = t => Math.floor(t / 86400000);
  let curDay = dayOf(bars[0].t), hi = -Infinity, lo = Infinity, ready = null;
  for (let i = 0; i < N; i++) {
    const hour = new Date(bars[i].t).getUTCHours(), day = dayOf(bars[i].t);
    if (day !== curDay) { curDay = day; hi = -Infinity; lo = Infinity; ready = null; }
    if (hour >= o.startHour && hour < o.endHour) { hi = Math.max(hi, bars[i].h); lo = Math.min(lo, bars[i].l); }
    else if (hour >= o.endHour && ready === null && hi > -Infinity) ready = { hi, lo };
    if (ready) out[i] = Math.abs(bars[i].c - ready.hi) < Math.abs(bars[i].c - ready.lo) ? ready.hi : ready.lo;
  }
  return out;
}

/** Assign session s's high/low to a randomly chosen OTHER session. Same object,
 *  same width distribution, same publication clock, wrong day. */
function shuffleRange(L, seed) {
  const r = rng(seed);
  const S = L.sessions;
  const perm = S.map((_, i) => i);
  for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  const hi = new Array(N).fill(NaN), lo = new Array(N).fill(NaN);
  for (let s = 0; s < S.length; s++) {
    const src = S[perm[s]], dst = S[s];
    // keep it in the neighbourhood of today's price, otherwise it is never
    // tested: re-centre the borrowed range on today's midpoint.
    const midToday = (dst.hi + dst.lo) / 2, w = src.hi - src.lo;
    for (let i = dst.first; i < N; i++) {
      if (bars[i].t - dst.tEnd > 17 * 60 * 60000) break;
      hi[i] = midToday + w / 2; lo[i] = midToday - w / 2;
    }
  }
  return { hi, lo, width: L.width, sessions: S };
}

/** Sequential book: never hold two positions at once. This is the number a
 *  person could actually have earned; the pooled average assumes 1053 parallel
 *  positions with 24h holds, which is not a strategy. */
function sequential(events, tp, sl) {
  const B = baselines(), k = KI(tp, sl);
  let busyUntil = -1;
  const out = [];
  for (const ev of events) {
    if (ev.i <= busyUntil) continue;
    const co = walk(ev.i, ev.dir);
    const ta = _tp[TPS.indexOf(tp)], sb = _sl[SLS.indexOf(sl)];
    const p = pnlAt(tp, sl, co);
    if (p === null) { busyUntil = Math.max(ta, sb); continue; }
    let exit;
    if (ta < 0 && sb < 0) exit = Math.min(N - 1, ev.i + MAX_HOLD);
    else if (ta >= 0 && (sb < 0 || ta < sb)) exit = ta; else exit = sb;
    busyUntil = exit;
    out.push({ x: p - (ev.dir === 1 ? B.L[k] : B.S[k]), raw: p, dir: ev.dir, day: Math.floor(bars[ev.i].t / 86400000), t: bars[ev.i].t });
  }
  return out;
}

function stageStress() {
  const L = sessionEdges(bars, ASIA);
  const ev = pooled(L);

  head('9a. HOW MUCH OF THE HEADLINE IS BASELINE MONTE-CARLO NOISE?');
  console.log('the baseline is itself an estimate from 40,000 random entries. its own');
  console.log('standard error lands straight on the reported alpha.\n');
  const alphas = [];
  for (let s = 0; s < 8; s++) {
    const b = { L: blind(1, 40000, 1000 + s * 104729), S: blind(-1, 40000, 900000 + s * 104729) };
    const k = KI(150, 120);
    const a = meanSd(residuals(ev, 150, 120, b).map(r => r.x)).mean;
    alphas.push(a);
    console.log(`  seed ${s}   blind long ${f(b.L[k])}  short ${f(b.S[k])}   ->  alpha ${f(a)}`);
  }
  const m = meanSd(alphas);
  console.log(`  alpha across baseline seeds: mean ${f(m.mean)}  sd ${g(m.sd)}  range ${f(Math.min(...alphas))} .. ${f(Math.max(...alphas))}`);
  console.log(`  their quoted +5.85 sits ${g((5.85 - m.mean) / m.sd)} baseline-noise sd above the centre of that`);

  head('9b. THE "BEFORE" NUMBER, MEASURED BY ME');
  for (const [nm, evx, tp, sl] of [
    ['shipped nearest-edge, 90/90', levelTestEvents(bars, shippedLine(), atr1), 90, 90],
    ['shipped nearest-edge, 150/120', levelTestEvents(bars, shippedLine(), atr1), 150, 120],
    ['edges split, all events, 90/90', pooled(L, e => e), 90, 90],
    ['edges split, bounce, 90/90', ev, 90, 90],
    ['edges split, bounce, 150/120', ev, 150, 120],
  ]) {
    const s = stats(residuals(evx, tp, sl));
    console.log(`  ${pad(nm, 34)} n ${rp(s.n, 5)}  alpha ${f(s.mean, 1)}  t naive ${g(s.tNaive)}  t day ${g(s.tCluster)}`);
  }

  head('9c. WHERE DOES THE +5 LIVE?  by month, by edge, by side');
  const res = residuals(ev, 150, 120);
  const bym = new Map();
  for (const r of res) { const k2 = new Date(r.t).toISOString().slice(0, 7); if (!bym.has(k2)) bym.set(k2, []); bym.get(k2).push(r.x); }
  for (const k2 of [...bym.keys()].sort()) { const s = meanSd(bym.get(k2)); console.log(`  ${k2}   n ${rp(s.n, 4)}  alpha ${f(s.mean, 1)}`); }
  const evH = bounce(levelTestEvents(bars, L.hi, atr1)), evL = bounce(levelTestEvents(bars, L.lo, atr1));
  for (const [nm, e2] of [['high edge', evH], ['low edge', evL]]) {
    const r2 = residuals(e2, 150, 120);
    const a = meanSd(r2.map(x => x.x)), lg = meanSd(r2.filter(x => x.dir === 1).map(x => x.x)), sh = meanSd(r2.filter(x => x.dir === -1).map(x => x.x));
    console.log(`  ${pad(nm, 12)} n ${rp(a.n, 5)} alpha ${f(a.mean, 1)}   long n ${rp(lg.n, 4)} ${f(lg.mean, 1)}   short n ${rp(sh.n, 4)} ${f(sh.mean, 1)}`);
  }
  // concentration: drop the best and worst days
  const byDay = new Map();
  for (const r of res) { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day).push(r.x); }
  const dayTot = [...byDay.entries()].map(([d, v]) => [d, v.reduce((a, b) => a + b, 0), v.length]).sort((a, b) => b[1] - a[1]);
  const total = res.reduce((a, r) => a + r.x, 0);
  for (const kDrop of [1, 3, 5, 10]) {
    const drop = new Set(dayTot.slice(0, kDrop).map(x => x[0]));
    const keep = res.filter(r => !drop.has(r.day));
    console.log(`  drop the ${kDrop} best day(s): n ${rp(keep.length, 5)}  alpha ${f(meanSd(keep.map(r => r.x)).mean, 1)}`);
  }
  console.log(`  top 5 days carry ${g(100 * dayTot.slice(0, 5).reduce((a, b) => a + b[1], 0) / total, 1)}% of the total alpha (of ${byDay.size} days)`);

  head('9d. SEQUENTIAL BOOK — one position at a time, no overlap');
  console.log('1053 events on 128 days with 24h holds are not 1053 tradeable positions.\n');
  for (const [tp, sl] of [[90, 90], [150, 120], [200, 150]]) {
    const q = sequential(ev, tp, sl);
    const s = stats(q);
    console.log(`  ${pad(`${tp}/${sl}`, 10)} trades ${rp(s.n, 5)}  alpha ${f(s.mean, 1)}  t naive ${g(s.tNaive)}  t day ${g(s.tCluster)}  boot95 ${f(s.bootLo, 1)} .. ${f(s.bootHi, 1)}`);
  }

  head('9e. DAY-SHUFFLED RANGES — the width and the clock, with the day scrambled');
  const real = stats(residuals(ev, 150, 120));
  const pl = [];
  for (let s = 0; s < 12; s++) {
    const x = stats(residuals(pooled(shuffleRange(L, 424242 + s * 7907)), 150, 120));
    pl.push(x.mean);
    console.log(`  shuffle #${rp(s + 1, 2)}   n ${rp(x.n, 5)}  alpha ${f(x.mean, 1)}`);
  }
  const mm = meanSd(pl);
  console.log(`  shuffled family: mean ${f(mm.mean, 1)}  sd ${g(mm.sd, 1)}    real range z = ${g((real.mean - mm.mean) / mm.sd)}`);
  console.log(`  shuffles at or above the real range: ${pl.filter(v => v >= real.mean).length} / ${pl.length}`);
}
if (stage === 'stress') stageStress();

// ═══════════════════════════════════════════════════════════════════════════
// 10. HOW BIG IS THE OVERLAP PROBLEM?  Consecutive events are 32 bars apart
//     while each holds for up to 1440.  Every trade shares ~45 neighbours'
//     price path.  Cluster at coarser blocks until the SE stops growing.
// ═══════════════════════════════════════════════════════════════════════════
function blockStats(res, blockDays, seed = 4242) {
  const xs = res.map(r => r.x);
  const { n, mean } = meanSd(xs);
  const g0 = Math.floor(Math.min(...res.map(r => r.day)) / blockDays);
  const by = new Map();
  for (const r of res) { const k = Math.floor(r.day / blockDays) - g0; if (!by.has(k)) by.set(k, []); by.get(k).push(r.x); }
  let ss = 0;
  for (const v of by.values()) { let s = 0; for (const q of v) s += (q - mean); ss += s * s; }
  const G = by.size;
  const se = Math.sqrt(ss * (G / Math.max(1, G - 1))) / n;
  const keys = [...by.keys()], r = rng(seed), boots = [];
  for (let b = 0; b < 2000; b++) {
    let s = 0, c = 0;
    for (let d = 0; d < keys.length; d++) { const v = by.get(keys[Math.floor(r() * keys.length)]); for (const q of v) { s += q; c++; } }
    if (c) boots.push(s / c);
  }
  boots.sort((a, b) => a - b);
  return { G, se, t: mean / se, p: boots.filter(v => v <= 0).length / boots.length,
    lo: boots[Math.floor(0.025 * boots.length)], hi: boots[Math.floor(0.975 * boots.length)] };
}
function stageOverlap() {
  head('10. OVERLAP — the standard error as the block gets honest (box 150/120)');
  const ev = pooled(sessionEdges(bars, ASIA));
  const res = residuals(ev, 150, 120);
  const { mean } = meanSd(res.map(r => r.x));
  console.log(`alpha ${f(mean)} points/trade, n ${res.length}\n`);
  console.log('  ' + pad('block', 12) + rp('blocks', 8) + rp('se', 8) + rp('t', 8) + rp('boot 95%', 22) + rp('P(a<=0)', 10));
  console.log('  ' + pad('iid (naive)', 12) + rp(res.length, 8) + rp(g(meanSd(res.map(r => r.x)).sd / Math.sqrt(res.length), 1), 8)
    + rp(g(mean / (meanSd(res.map(r => r.x)).sd / Math.sqrt(res.length))), 8) + rp('', 22) + rp('', 10));
  for (const bd of [1, 2, 3, 5, 7, 14, 21]) {
    const s = blockStats(res, bd);
    console.log('  ' + pad(`${bd} day${bd > 1 ? 's' : ''}`, 12) + rp(s.G, 8) + rp(g(s.se, 1), 8) + rp(g(s.t), 8)
      + rp(`${f(s.lo, 1)} .. ${f(s.hi, 1)}`, 22) + rp(g(s.p, 3), 10));
  }
  console.log('\n  events per day: median 8, max 29.  Median gap between consecutive');
  console.log('  events: 32 bars, against a 1440 bar hold — each trade shares its');
  console.log('  outcome window with roughly 45 others.');
}
if (stage === 'overlap') stageOverlap();
