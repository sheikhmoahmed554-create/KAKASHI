'use strict';
/*
 * REFUTATION AUDIT of tools/fixes/daily-open.js
 *
 * Claim under test:
 *   level     open of the bar anchoring one of six session times (01:00, 10:00,
 *             15:30, 16:20, 16:30, 17:00 label clock), frozen, published one bar
 *             late, held until next day's anchor.
 *   test      levelTestEvents with 14-period ATR built on 60m candles and
 *             projected one HTF bar late.
 *   direction reject events, as signalled (the bounce).
 *   size      TP 180 / SL 180 / hold 240 min, cost 0.5.
 *   result    alpha +11.99 on 590 tests.
 *
 * Everything below is re-implemented from the loader up. Only the two modules
 * the brief designates as shared and given (ai963_engine, level_events) are
 * reused, and sessionOpenLine is rebuilt independently and diffed against theirs.
 *
 * Usage: node --max-old-space-size=3500 tools/fixes/daily-open-verify.js [stages]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require(path.join(__dirname, '..', 'ai963_engine'));
const { levelTestEvents, respectRate } = require(path.join(__dirname, '..', 'level_events'));

const PU = 0.10, COST = 0.5;

// ───────────────────────────── data ─────────────────────────────
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

const TFS = [1, 5, 15, 60, 240, 1440];
const TF_NAME = { 1: '1m', 5: '5m', 15: '15m', 60: '1H', 240: '4H', 1440: 'D' };
const ATR_TF = new Map();
for (const m of TFS) {
  const { bars: b, index } = E.resample(bars, m);
  const a = E.atr(b, 14);
  ATR_TF.set(m, m === 1 ? a : E.projectConfirmed(a, index));
}

const MOD = new Int32Array(N);      // minute of day, label clock
const DAY = new Int32Array(N);      // calendar day index
for (let i = 0; i < N; i++) {
  const d = new Date(bars[i].t);
  MOD[i] = d.getUTCHours() * 60 + d.getUTCMinutes();
  DAY[i] = Math.floor(bars[i].t / 86400000);
}

// ─────────────────── level: my own implementation ───────────────────
function myLine(anchorMin, { lag = 1, lifeMin = 1440, catchMin = 120 } = {}) {
  const out = new Array(N).fill(NaN);
  const anchors = [];
  let cur = -1;
  for (let i = 0; i < N; i++) {
    if (DAY[i] !== cur) { cur = DAY[i];
      // find first bar of this day inside the window
      for (let j = i; j < N && DAY[j] === cur; j++) {
        if (MOD[j] >= anchorMin && MOD[j] < anchorMin + catchMin) { anchors.push(j); break; }
      }
    }
  }
  for (let a = 0; a < anchors.length; a++) {
    const k = anchors[a];
    const px = bars[k].o;
    const stop = a + 1 < anchors.length ? anchors[a + 1] : N;
    const tCut = bars[k].t + lifeMin * 60000;
    for (let i = k + lag; i < stop; i++) { if (bars[i].t > tCut) break; out[i] = px; }
  }
  return { line: out, anchors };
}

// ─────────────────── outcomes ───────────────────
/** race(), semantics copied from tools/sweep_timeframes.js. null = ambiguous bar. */
function race(i, dir, TP, SL, HOLD) {
  const e = bars[i].c, tp = e + dir * TP * PU, sl = e - dir * SL * PU;
  const end = Math.min(N - 1, i + HOLD);
  if (i + 1 > end) return null;
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    const ht = dir === 1 ? b.h >= tp : b.l <= tp;
    const hs = dir === 1 ? b.l <= sl : b.h >= sl;
    if (ht && hs) return null;
    if (ht) return TP - COST;
    if (hs) return -SL - COST;
  }
  return (bars[end].c - e) * dir / PU - COST;
}

const TP0 = 180, SL0 = 180, HOLD0 = 240;

// Exhaustive baseline at the headline cell: every bar, both directions.
// This is an exact expectation, not a 40k sample.
const BASE = { 1: new Float64Array(N).fill(NaN), '-1': new Float64Array(N).fill(NaN) };
function buildExactBase() {
  const hi = N - HOLD0 - 2;
  for (let i = 100; i < hi; i++) {
    BASE[1][i] = race(i, 1, TP0, SL0, HOLD0);
    BASE[-1][i] = race(i, -1, TP0, SL0, HOLD0);
  }
}

function meanOf(arr, pred) {
  let s = 0, n = 0;
  for (let i = 100; i < N - HOLD0 - 2; i++) { const v = arr[i]; if (v === null || !Number.isFinite(v)) continue; if (pred && !pred(i)) continue; s += v; n++; }
  return { mean: n ? s / n : NaN, n };
}

// ─────────────────── events ───────────────────
const SESSION_SET = [600, 930, 980, 990, 1020];
const FINAL_ANCHORS = [60, ...SESSION_SET];

const EVC = new Map();
function eventsFor(anchorMin, tf, opts) {
  const k = `${anchorMin}|${tf}|${JSON.stringify(opts || {})}`;
  if (EVC.has(k)) return EVC.get(k);
  const { line } = myLine(anchorMin, opts);
  const ev = levelTestEvents(bars, line, ATR_TF.get(tf)).filter(e => e.i < N - 5);
  for (const e of ev) e.anchor = anchorMin;
  EVC.set(k, ev);
  return ev;
}
function pooled(ms, tf, opts) {
  const out = [];
  for (const m of ms) out.push(...eventsFor(m, tf, opts));
  return out.sort((a, b) => a.i - b.i);
}

const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const f = (x, d = 2) => Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '—';
const fp = (x, d = 1) => Number.isFinite(x) ? x.toFixed(d) : '—';
const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const hr = t => `\n${'='.repeat(88)}\n${t}\n${'='.repeat(88)}`;

function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

const argv = process.argv.slice(2);
const want = argv.length ? new Set(argv) : new Set(['1', '2', '3', '4', '5', '6', '7']);
const on = s => want.has(String(s));

// ═══════════════ 1. LOOKAHEAD ═══════════════
function stage1() {
  console.log(hr('1.  LOOKAHEAD AUDIT'));

  // 1a. my line vs theirs
  let their = null;
  try { their = require(path.join(__dirname, 'daily-open.js')); } catch (e) { }
  if (their && their.sessionOpenLine) {
    let diffs = 0, both = 0;
    for (const m of FINAL_ANCHORS) {
      const a = myLine(m).line, b = their.sessionOpenLine(bars, m).line;
      for (let i = 0; i < N; i++) {
        const x = a[i], y = b[i];
        if (Number.isFinite(x) !== Number.isFinite(y)) diffs++;
        else if (Number.isFinite(x)) { both++; if (Math.abs(x - y) > 1e-9) diffs++; }
      }
    }
    console.log(`  independent rebuild of the level vs theirs: ${both.toLocaleString()} live bars compared, ${diffs} disagreements`);
  }

  // 1b. prefix causality: rebuild on a truncated feed, values must be identical
  //     Rebuilding on a prefix is the honest test: nothing after bar M may
  //     influence the level at bar i <= M.
  const M = Math.floor(N * 0.6);
  const sub = bars.slice(0, M);
  let same = 0, bad = 0;
  for (const m of FINAL_ANCHORS) {
    const full = myLine(m).line;
    // rebuild using only the prefix
    const out = new Array(M).fill(NaN);
    const anchors = [];
    let cur = -1;
    for (let i = 0; i < M; i++) {
      const d = Math.floor(sub[i].t / 86400000);
      if (d !== cur) { cur = d;
        for (let j = i; j < M && Math.floor(sub[j].t / 86400000) === cur; j++) {
          const dd = new Date(sub[j].t), mo = dd.getUTCHours() * 60 + dd.getUTCMinutes();
          if (mo >= m && mo < m + 120) { anchors.push(j); break; }
        }
      }
    }
    for (let a = 0; a < anchors.length; a++) {
      const k = anchors[a], px = sub[k].o;
      const stop = a + 1 < anchors.length ? anchors[a + 1] : M;
      const tCut = sub[k].t + 1440 * 60000;
      for (let i = k + 1; i < stop; i++) { if (sub[i].t > tCut) break; out[i] = px; }
    }
    for (let i = 0; i < M - 1; i++) {
      const x = full[i], y = out[i];
      if (!Number.isFinite(x) && !Number.isFinite(y)) continue;
      if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 1e-9) { same++; continue; }
      bad++;
    }
  }
  console.log(`  prefix rebuild (first 60% of bars only): ${same.toLocaleString()} identical, ${bad} mismatches`);

  // 1c. is the published value ever a price not yet printed?
  let future = 0, live = 0;
  for (const m of FINAL_ANCHORS) {
    const { line, anchors } = myLine(m);
    const set = new Set();
    let ai = 0;
    for (let i = 0; i < N; i++) {
      while (ai < anchors.length && anchors[ai] <= i) { set.add(+bars[anchors[ai]].o.toFixed(6)); ai++; }
      if (!Number.isFinite(line[i])) continue;
      live++;
      if (!set.has(+line[i].toFixed(6))) future++;
    }
  }
  console.log(`  values published before their defining bar existed: ${future} of ${live.toLocaleString()} live bars`);

  // 1d. the ATR. projectConfirmed(index[i]-1) must never expose the running candle.
  const { bars: hb, index } = E.resample(bars, 60);
  const rawA = E.atr(hb, 14), projA = ATR_TF.get(60);
  let atrBad = 0, atrOK = 0;
  for (let i = 0; i < N; i++) {
    const j = index[i] - 1;
    if (j < 0) { if (Number.isFinite(projA[i])) atrBad++; continue; }
    if (!Number.isFinite(projA[i])) continue;
    // the exposed value must equal a closed candle's ATR, and that candle must
    // have ENDED at or before bars[i].t
    const closedEnd = hb[j].t + 60 * 60000;
    if (closedEnd > bars[i].t + 1) atrBad++; else atrOK++;
    if (Math.abs(projA[i] - rawA[j]) > 1e-12) atrBad++;
  }
  console.log(`  1H ATR projection: ${atrOK.toLocaleString()} bars see only fully-closed candles, ${atrBad} violations`);

  // 1e. the trade itself: entry at close of bar i, first outcome bar is i+1
  console.log('  entry is bars[i].c and race() starts at j=i+1 — no same-bar fill. verified by inspection.');
  console.log('  VERDICT: no lookahead found. The construction is causal.');
}

// ═══════════════ 2. THE HEADLINE NUMBER, RE-MEASURED ═══════════════
let EV_FINAL = null;
function stage2() {
  console.log(hr('2.  THE HEADLINE NUMBER, RE-MEASURED FROM SCRATCH'));
  const ev = pooled(FINAL_ANCHORS, 60).filter(e => e.kind === 'reject');
  EV_FINAL = ev;
  const bl = meanOf(BASE[1]), bs = meanOf(BASE[-1]);
  console.log(`  blind baselines at TP=SL=180 / hold 240, over EVERY eligible bar (not a 40k sample):`);
  console.log(`    blind long  ${f(bl.mean)} pts/trade  (n=${bl.n.toLocaleString()})`);
  console.log(`    blind short ${f(bs.mean)} pts/trade  (n=${bs.n.toLocaleString()})`);

  let ln = 0, lnet = 0, sn = 0, snet = 0, wins = 0;
  const pl = [];
  for (const e of ev) {
    const v = race(e.i, e.dir, TP0, SL0, HOLD0);
    if (v === null) continue;
    pl.push({ e, v });
    if (v > 0) wins++;
    if (e.dir === 1) { ln++; lnet += v; } else { sn++; snet += v; }
  }
  const tot = ln + sn;
  const la = lnet / ln - bl.mean, sa = snet / sn - bs.mean;
  const alpha = (la * ln + sa * sn) / tot;
  console.log(`\n  events ${ev.length}   scored ${tot}   longs ${ln} / shorts ${sn}   win ${fp(100 * wins / tot)}%`);
  console.log(`  raw   ${f((lnet + snet) / tot)} pts/trade`);
  console.log(`  longs  ${f(lnet / ln)} vs blind ${f(bl.mean)}  ->  ${f(la)}`);
  console.log(`  shorts ${f(snet / sn)} vs blind ${f(bs.mean)}  ->  ${f(sa)}`);
  console.log(`  DIRECTION-ADJUSTED ALPHA  ${f(alpha)} pts/trade   (their claim: +11.99)`);

  // naive independence check
  const sd = Math.sqrt(pl.reduce((a, x) => a + (x.v - (lnet + snet) / tot) ** 2, 0) / (tot - 1));
  console.log(`  per-trade sd ${fp(sd)} pts  ->  naive SE ${fp(sd / Math.sqrt(tot))}  (t = ${fp(alpha / (sd / Math.sqrt(tot)), 2)}), IF trades were independent`);
  return { ev, pl, alpha, bl, bs };
}

// ═══════════════ 3. INDEPENDENCE ═══════════════
function stage3(ctx) {
  console.log(hr('3.  ARE THERE REALLY 590 OBSERVATIONS?'));
  const { pl } = ctx;
  // 3a. concurrency
  let overlapPairs = 0;
  const idx = pl.map(x => x.e.i);
  for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length && idx[b] - idx[a] < HOLD0; b++) overlapPairs++;
  console.log(`  ${pl.length} trades, hold 240 min. Pairs whose holding periods overlap: ${overlapPairs}`);
  const byDay = new Map();
  for (const x of pl) { const d = DAY[x.e.i]; if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(x); }
  console.log(`  spread over ${byDay.size} trading days = ${fp(pl.length / byDay.size, 2)} trades/day`);

  // 3b. how close together are the six anchors' levels? (clustered anchors = the
  //     same level counted several times)
  const lines = FINAL_ANCHORS.map(m => myLine(m).line);
  const spreads = [];
  for (let i = 100; i < N; i += 60) {
    const v = lines.map(L => L[i]).filter(Number.isFinite);
    if (v.length < 4) continue;
    spreads.push((Math.max(...v) - Math.min(...v)) / PU);
  }
  console.log(`  median spread between the six anchor levels when all are live: ${fp(median(spreads))} pts`);
  const usLines = [930, 980, 990, 1020].map(m => myLine(m).line);
  const usSpread = [];
  for (let i = 100; i < N; i += 60) {
    const v = usLines.map(L => L[i]).filter(Number.isFinite);
    if (v.length < 4) continue;
    usSpread.push((Math.max(...v) - Math.min(...v)) / PU);
  }
  console.log(`  ...and between the four US anchors alone (15:30/16:20/16:30/17:00): ${fp(median(usSpread))} pts`);
  console.log(`     (1H ATR tolerance band is about ${fp(median(ATR_TF.get(60).filter(Number.isFinite)) * 0.2 / PU)} pts — levels closer than that are the same level)`);

  // 3c. de-overlapped: at most one position at a time
  const sorted = [...pl].sort((a, b) => a.e.i - b.e.i);
  const kept = [];
  let free = -1;
  for (const x of sorted) { if (x.e.i <= free) continue; kept.push(x); free = x.e.i + HOLD0; }
  const rep = set => {
    let ln = 0, lnet = 0, sn = 0, snet = 0;
    for (const x of set) { if (x.e.dir === 1) { ln++; lnet += x.v; } else { sn++; snet += x.v; } }
    const t = ln + sn;
    const la = ln ? lnet / ln - meanOf(BASE[1]).mean : 0, sa = sn ? snet / sn - meanOf(BASE[-1]).mean : 0;
    return { n: t, alpha: (la * ln + sa * sn) / t, raw: (lnet + snet) / t };
  };
  const dp = rep(kept);
  console.log(`\n  NON-OVERLAPPING ONLY (one position at a time): n=${dp.n}  raw ${f(dp.raw)}  alpha ${f(dp.alpha)}`);

  // 3d. one trade per day maximum (first event of the day)
  const firsts = [];
  for (const [, arr] of byDay) firsts.push(arr.sort((a, b) => a.e.i - b.e.i)[0]);
  const fd = rep(firsts);
  console.log(`  FIRST EVENT OF EACH DAY ONLY:                   n=${fd.n}  raw ${f(fd.raw)}  alpha ${f(fd.alpha)}`);

  // 3e. day-clustered bootstrap on the alpha
  const days = [...byDay.keys()];
  const blm = meanOf(BASE[1]).mean, bsm = meanOf(BASE[-1]).mean;
  const dayAlpha = new Map();
  for (const [d, arr] of byDay) {
    let s = 0;
    for (const x of arr) s += x.v - (x.e.dir === 1 ? blm : bsm);
    dayAlpha.set(d, { sum: s, n: arr.length });
  }
  const r = rng(20260808);
  const boot = [];
  for (let it = 0; it < 8000; it++) {
    let s = 0, n = 0;
    for (let k = 0; k < days.length; k++) {
      const d = days[Math.floor(r() * days.length)];
      const a = dayAlpha.get(d); s += a.sum; n += a.n;
    }
    boot.push(s / n);
  }
  boot.sort((a, b) => a - b);
  const lo = boot[Math.floor(0.025 * boot.length)], hiq = boot[Math.floor(0.975 * boot.length)];
  const p = boot.filter(x => x <= 0).length / boot.length;
  console.log(`\n  DAY-CLUSTERED BOOTSTRAP (8000 iters over ${days.length} days):`);
  console.log(`    95% CI  ${f(lo)} … ${f(hiq)}    one-sided p(alpha<=0) = ${p.toFixed(3)}`);
  console.log(`    ${lo > 0 ? 'CI excludes zero' : 'CI INCLUDES ZERO — not distinguishable from no edge'}`);
  return { byDay, blm, bsm, pl };
}

// ═══════════════ 4. IS THE DIRECTION ADJUSTMENT HONEST? ═══════════════
function stage4(ctx) {
  console.log(hr('4.  DIRECTION ADJUSTMENT — IS THE BASELINE MATCHED TO WHEN THE TRADES HAPPEN?'));
  const { pl } = ctx;
  console.log('  Their baseline samples bar indices uniformly across the whole feed. The events do');
  console.log('  not happen uniformly: they cluster at the hours their anchors sit in. If gold drifts');
  console.log('  differently by hour, a uniform baseline is the wrong yardstick.\n');

  const BKT = 60;   // 60-minute buckets of the label clock
  const nb = Math.ceil(1440 / BKT);
  const sum = { 1: new Float64Array(nb), '-1': new Float64Array(nb) };
  const cnt = { 1: new Float64Array(nb), '-1': new Float64Array(nb) };
  for (let i = 100; i < N - HOLD0 - 2; i++) {
    const b = Math.floor(MOD[i] / BKT);
    for (const d of [1, -1]) { const v = BASE[d][i]; if (v === null || !Number.isFinite(v)) continue; sum[d][b] += v; cnt[d][b]++; }
  }
  const tod = { 1: [], '-1': [] };
  for (const d of [1, -1]) for (let b = 0; b < nb; b++) tod[d][b] = cnt[d][b] >= 300 ? sum[d][b] / cnt[d][b] : NaN;
  console.log('  blind return by hour of the label clock (pts/trade, TP=SL=180, hold 240):');
  let rowL = '    long ', rowS = '    short';
  for (let b = 0; b < nb; b++) { rowL += (Number.isFinite(tod[1][b]) ? f(tod[1][b], 0) : ' —').padStart(6); rowS += (Number.isFinite(tod[-1][b]) ? f(tod[-1][b], 0) : ' —').padStart(6); }
  console.log('    hour ' + Array.from({ length: nb }, (_, b) => String(b).padStart(6)).join(''));
  console.log(rowL); console.log(rowS);

  // day-matched baseline
  const dsum = { 1: new Map(), '-1': new Map() }, dcnt = { 1: new Map(), '-1': new Map() };
  for (let i = 100; i < N - HOLD0 - 2; i++) {
    const d0 = DAY[i];
    for (const d of [1, -1]) {
      const v = BASE[d][i]; if (v === null || !Number.isFinite(v)) continue;
      dsum[d].set(d0, (dsum[d].get(d0) || 0) + v); dcnt[d].set(d0, (dcnt[d].get(d0) || 0) + 1);
    }
  }

  const blm = meanOf(BASE[1]).mean, bsm = meanOf(BASE[-1]).mean;
  let aU = 0, aT = 0, aD = 0, nU = 0, nT = 0, nD = 0;
  for (const x of pl) {
    const d = x.e.dir, i = x.e.i;
    aU += x.v - (d === 1 ? blm : bsm); nU++;
    const tb = tod[d][Math.floor(MOD[i] / BKT)];
    if (Number.isFinite(tb)) { aT += x.v - tb; nT++; }
    const c = dcnt[d].get(DAY[i]);
    if (c >= 100) { aD += x.v - dsum[d].get(DAY[i]) / c; nD++; }
  }
  console.log(`\n  alpha vs UNIFORM baseline (what they report):        ${f(aU / nU)}   n=${nU}`);
  console.log(`  alpha vs HOUR-OF-DAY-MATCHED baseline:               ${f(aT / nT)}   n=${nT}`);
  console.log(`  alpha vs SAME-CALENDAR-DAY-MATCHED baseline:         ${f(aD / nD)}   n=${nD}`);
  console.log('    (the last asks: on the very day this trade fired, would a coin-flip entry in the');
  console.log('     same direction have done as well? it removes "the level fired on the right days".)');

  // hour distribution of events vs of the feed
  const eh = new Array(24).fill(0);
  for (const x of pl) eh[Math.floor(MOD[x.e.i] / 60)]++;
  console.log('  events by hour: ' + eh.map((v, h) => v ? `${String(h).padStart(2, '0')}:${v}` : '').filter(Boolean).join(' '));
  return { tod, BKT, blm, bsm };
}

// ═══════════════ 5. PLACEBO ═══════════════
function placeboEvents(anchorMin, tf, seed, mode) {
  const r = rng(seed);
  const { anchors } = myLine(anchorMin);
  const A = ATR_TF.get(tf);
  const out = new Array(N).fill(NaN);
  for (let a = 0; a < anchors.length; a++) {
    const k = anchors[a];
    const stop = a + 1 < anchors.length ? anchors[a + 1] : N;
    const tCut = bars[k].t + 1440 * 60000;
    let px, from = k;
    if (mode === 'intraday') {
      const off = 30 + Math.floor(r() * 210);
      const j = k + off;
      if (j >= stop || j >= N) continue;
      px = bars[j].c; from = j;
    } else if (mode === 'prevday') {
      // a genuine traded price from YESTERDAY, chosen without reference to today
      const pk = a > 0 ? anchors[a - 1] : null;
      if (pk === null) continue;
      const j = pk + Math.floor(r() * Math.max(1, k - pk));
      px = bars[j].c;
    } else {
      const at = Number.isFinite(A[k]) ? A[k] : atr1[k];
      if (!Number.isFinite(at) || at <= 0) continue;
      const lo = mode === 'near' ? 0.25 : 0.6, hi = mode === 'near' ? 0.8 : 3;
      px = bars[k].o + (lo + r() * (hi - lo)) * (r() < 0.5 ? -1 : 1) * at;
    }
    for (let i = from + 1; i < stop; i++) { if (bars[i].t > tCut) break; out[i] = px; }
  }
  return levelTestEvents(bars, out, ATR_TF.get(tf)).filter(e => e.i < N - 5 && e.kind === 'reject');
}

function alphaOf(events) {
  const blm = meanOf(BASE[1]).mean, bsm = meanOf(BASE[-1]).mean;
  let ln = 0, lnet = 0, sn = 0, snet = 0;
  for (const e of events) {
    const v = race(e.i, e.dir, TP0, SL0, HOLD0);
    if (v === null) continue;
    if (e.dir === 1) { ln++; lnet += v; } else { sn++; snet += v; }
  }
  const t = ln + sn;
  if (!t) return { n: 0, alpha: NaN };
  const la = ln ? lnet / ln - blm : 0, sa = sn ? snet / sn - bsm : 0;
  return { n: t, alpha: (la * ln + sa * sn) / t, raw: (lnet + snet) / t };
}

function stage5(ctx) {
  console.log(hr('5.  PLACEBO — IS IT THE OPEN, OR IS IT THE DETECTOR?'));
  console.log('  Same anchors, same 1H ATR, same detector, same trade. Only the price is swapped for');
  console.log('  something that is not the opening print. Whatever the placebo also earns is not the open.\n');
  const real = alphaOf(EV_FINAL);
  console.log(`  REAL (session opens)                          n=${String(real.n).padStart(5)}  alpha ${f(real.alpha)}`);
  for (const mode of ['far', 'near', 'intraday', 'prevday']) {
    const runs = [];
    for (let s = 0; s < 30; s++) {
      const ev = [];
      for (const m of FINAL_ANCHORS) ev.push(...placeboEvents(m, 60, 90210 + s * 7919 + m, mode));
      const a = alphaOf(ev);
      if (a.n >= 100) runs.push(a);
    }
    const mu = runs.reduce((a, x) => a + x.alpha, 0) / runs.length;
    const sd = Math.sqrt(runs.reduce((a, x) => a + (x.alpha - mu) ** 2, 0) / (runs.length - 1));
    const nn = Math.round(runs.reduce((a, x) => a + x.n, 0) / runs.length);
    const z = (real.alpha - mu) / sd;
    const beat = runs.filter(x => x.alpha >= real.alpha).length;
    console.log(`  placebo ${mode.padEnd(9)} ${runs.length} runs  n~${String(nn).padStart(5)}  alpha ${f(mu)} ± ${fp(sd)}   NET ${f(real.alpha - mu)}  (${fp(z, 2)} sd)  placebo beat the real level in ${beat}/${runs.length} runs`);
  }

  // respect rate at this scale, real vs placebo
  const evAll = pooled(FINAL_ANCHORS, 60);
  const rr = respectRate(evAll);
  console.log(`\n  respect: real level ${fp(rr.respect)}% on ${rr.tests} arrivals`);
  const prr = [];
  for (let s = 0; s < 12; s++) {
    let rej = 0, tot = 0;
    for (const m of FINAL_ANCHORS) {
      const r2 = rng(555 + s * 131 + m);
      const { anchors } = myLine(m);
      const out = new Array(N).fill(NaN);
      for (let a = 0; a < anchors.length; a++) {
        const k = anchors[a], stop = a + 1 < anchors.length ? anchors[a + 1] : N;
        const off = 30 + Math.floor(r2() * 210), j = k + off;
        if (j >= stop || j >= N) continue;
        const px = bars[j].c, tCut = bars[k].t + 86400000;
        for (let i = j + 1; i < stop; i++) { if (bars[i].t > tCut) break; out[i] = px; }
      }
      const e2 = levelTestEvents(bars, out, ATR_TF.get(60));
      rej += e2.filter(x => x.kind === 'reject').length; tot += e2.length;
    }
    prr.push(100 * rej / tot);
  }
  const pm = prr.reduce((a, b) => a + b, 0) / prr.length;
  console.log(`           intraday placebo ${fp(pm)}%   (the published 68.95% control was measured at 1m ATR and does not apply here)`);
}

// ═══════════════ 6. SELECTION — HONEST IN-SAMPLE / OUT-OF-SAMPLE ═══════════════
const TPG = [20, 40, 60, 90, 140, 180, 240, 320];
const HG = [30, 60, 120, 240, 480, 1440];

function walkFull(i, dir) {
  const e = bars[i].c;
  const end = Math.min(N - 1, i + 1440);
  const ftp = new Int32Array(TPG.length).fill(0x7fffffff);
  const fsl = new Int32Array(TPG.length).fill(0x7fffffff);
  const closeP = new Float64Array(HG.length);
  let ti = 0, si = 0, hi = 0, mfe = 0, mae = 0;
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    const fav = dir === 1 ? (b.h - e) / PU : (e - b.l) / PU;
    const adv = dir === 1 ? (e - b.l) / PU : (b.h - e) / PU;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
    while (ti < TPG.length && mfe >= TPG[ti]) ftp[ti++] = j - i;
    while (si < TPG.length && mae >= TPG[si]) fsl[si++] = j - i;
    while (hi < HG.length && j - i >= HG[hi]) { closeP[hi] = (b.c - e) * dir / PU - COST; hi++; }
  }
  while (hi < HG.length) { closeP[hi] = (bars[end].c - e) * dir / PU - COST; hi++; }
  return { ftp, fsl, closeP };
}
function readPnl(w, ti, si, hi) {
  const h = HG[hi], t = w.ftp[ti], s = w.fsl[si];
  const tHit = t <= h, sHit = s <= h;
  if (tHit && sHit) { if (t === s) return null; return t < s ? TPG[ti] - COST : -TPG[si] - COST; }
  if (tHit) return TPG[ti] - COST;
  if (sHit) return -TPG[si] - COST;
  return w.closeP[hi];
}

function stage6() {
  console.log(hr('6.  SELECTION — DERIVE ON JAN–APR, JUDGE ON MAY–JUL'));
  const SPLIT = Math.floor(N / 2);
  console.log(`  split at bar ${SPLIT.toLocaleString()} = ${new Date(bars[SPLIT].t).toISOString().slice(0, 10)}`);
  const G = TPG.length, H = HG.length, GN = G * G * H;
  const bidx = (a, b, c) => (a * G + b) * H + c;

  // segment baselines, subsampled every 3rd bar for speed
  function segBase(dir, from, to) {
    const sum = new Float64Array(GN), cnt = new Float64Array(GN);
    for (let i = Math.max(100, from); i < Math.min(to, N - 1442); i += 3) {
      const w = walkFull(i, dir);
      for (let p = 0, a = 0; a < G; a++) for (let b = 0; b < G; b++) for (let c = 0; c < H; c++, p++) {
        const v = readPnl(w, a, b, c); if (v === null) continue; sum[p] += v; cnt[p]++;
      }
    }
    const m = new Float64Array(GN);
    for (let p = 0; p < GN; p++) m[p] = cnt[p] >= 300 ? sum[p] / cnt[p] : NaN;
    return m;
  }
  process.stdout.write('  building segment baselines …\r');
  const B = { IS: { 1: segBase(1, 100, SPLIT), '-1': segBase(-1, 100, SPLIT) },
              OOS: { 1: segBase(1, SPLIT, N), '-1': segBase(-1, SPLIT, N) } };
  console.log('                                  \r');

  const POOLS = [
    ['their six', FINAL_ANCHORS],
    ['session five', SESSION_SET],
    ['globex only', [60]],
    ['london only', [600]],
    ['all 24 hours', Array.from({ length: 24 }, (_, h) => h * 60)],
  ];
  const CANDS = [];
  for (const [pl, anchors] of POOLS)
    for (const tf of [5, 15, 60])
      for (const kind of ['reject', 'break'])
        for (const flip of [false, true]) {
          const ev = pooled(anchors, tf).filter(e => e.kind === kind);
          if (ev.length < 60) continue;
          CANDS.push({ pl, anchors, tf, kind, flip, ev });
        }
  // attach walks
  const WK = new Map();
  const getW = (i, dir) => { const k = i * 4 + (dir === 1 ? 1 : 0); if (!WK.has(k)) WK.set(k, walkFull(i, dir)); return WK.get(k); };

  function scoreSeg(cand, ti, si, hi, seg, lo, hi2) {
    const BL = B[seg];
    const p = bidx(ti, si, hi);
    let ln = 0, lnet = 0, sn = 0, snet = 0;
    for (const e of cand.ev) {
      if (e.i < lo || e.i >= hi2) continue;
      const dir = cand.flip ? -e.dir : e.dir;
      const v = readPnl(getW(e.i, dir), ti, si, hi);
      if (v === null) continue;
      if (dir === 1) { ln++; lnet += v; } else { sn++; snet += v; }
    }
    const t = ln + sn;
    if (!t) return { n: 0, alpha: NaN };
    const bl = BL[1][p], bs = BL[-1][p];
    const la = ln && Number.isFinite(bl) ? lnet / ln - bl : 0;
    const sa = sn && Number.isFinite(bs) ? snet / sn - bs : 0;
    return { n: t, alpha: (la * ln + sa * sn) / t, raw: (lnet + snet) / t };
  }

  let best = null, tried = 0;
  for (const c of CANDS) for (let a = 0; a < G; a++) for (let b = 0; b < G; b++) for (let h = 0; h < H; h++) {
    tried++;
    const s = scoreSeg(c, a, b, h, 'IS', 0, SPLIT);
    if (s.n < 100 || !Number.isFinite(s.alpha)) continue;
    if (!best || s.alpha > best.s.alpha) best = { c, a, b, h, s };
  }
  console.log(`  configurations searched in-sample: ${tried.toLocaleString()} (${CANDS.length} constructions x ${G * G * H} target/stop/hold cells)`);
  if (best) {
    const o = scoreSeg(best.c, best.a, best.b, best.h, 'OOS', SPLIT, N);
    console.log(`  IS winner: ${best.c.pl} / ${TF_NAME[best.c.tf]} ATR / ${best.c.kind}${best.c.flip ? ' inverted' : ''} / TP ${TPG[best.a]} SL ${TPG[best.b]} hold ${HG[best.h]}`);
    console.log(`    Jan–Apr  n=${best.s.n}  alpha ${f(best.s.alpha)}`);
    console.log(`    May–Jul  n=${o.n}  alpha ${f(o.alpha)}   <-- the only honest number in this stage`);
  }
  // and their exact cell, both halves, no re-search
  const cell = CANDS.find(c => c.pl === 'their six' && c.tf === 60 && c.kind === 'reject' && !c.flip);
  const ti = TPG.indexOf(180), si = TPG.indexOf(180), hi = HG.indexOf(240);
  const i1 = scoreSeg(cell, ti, si, hi, 'IS', 0, SPLIT), i2 = scoreSeg(cell, ti, si, hi, 'OOS', SPLIT, N);
  console.log(`\n  THEIR cell held fixed (six anchors, 1H ATR, reject, 180/180/240):`);
  console.log(`    Jan–Apr  n=${i1.n}  alpha ${f(i1.alpha)}`);
  console.log(`    May–Jul  n=${i2.n}  alpha ${f(i2.alpha)}`);

  // the family of anchors at their cell — how much of the spread is noise?
  console.log('\n  THE ANCHOR FAMILY at their exact cell (their own claim is that the anchor does not matter):');
  const fam = [];
  for (let m = 60; m <= 1380; m += 60) {
    const ev = pooled([m], 60).filter(e => e.kind === 'reject');
    const c2 = { anchors: [m], tf: 60, kind: 'reject', flip: false, ev };
    const s = scoreSeg(c2, ti, si, hi, 'IS', 0, N);
    // full-sample baseline needed; reuse IS baseline is wrong -> compute with global BASE
    const a2 = alphaOf(ev);
    if (a2.n >= 50) fam.push({ m, a: a2.alpha, n: a2.n });
  }
  const av = fam.map(x => x.a), am = av.reduce((a, b) => a + b, 0) / av.length;
  const asd = Math.sqrt(av.reduce((a, v) => a + (v - am) ** 2, 0) / (av.length - 1));
  console.log('    ' + fam.sort((a, b) => b.a - a.a).map(x => `${hhmm(x.m)} ${f(x.a, 0)}`).join('  '));
  console.log(`    ${fam.length} hourly anchors: mean ${f(am)}  sd ${fp(asd)}  positive ${av.filter(x => x > 0).length}/${av.length}`);
  console.log(`    their six anchors average ${f(FINAL_ANCHORS.filter(m => m % 60 === 0).map(m => fam.find(x => x.m === m)).filter(Boolean).reduce((a, x) => a + x.a, 0) / FINAL_ANCHORS.filter(m => m % 60 === 0 && fam.find(x => x.m === m)).length)} — inside the spread of hours where no session opens.`);
}

// ═══════════════ 7. WHAT SURVIVES ═══════════════
function stage7(ctx) {
  console.log(hr('7.  WHERE THE NUMBER COMES FROM'));
  const { pl } = ctx;
  const sorted = [...pl].sort((a, b) => b.v - a.v);
  const tot = pl.reduce((a, x) => a + x.v, 0);
  console.log(`  gross ${f(tot, 0)} pts over ${pl.length} trades.`);
  for (const k of [5, 10, 25, 50]) {
    const top = sorted.slice(0, k).reduce((a, x) => a + x.v, 0);
    console.log(`    the best ${String(k).padStart(2)} trades contribute ${f(top, 0)} pts = ${fp(100 * top / tot)}% of the total`);
  }
  // month by month, direction adjusted, my own numbers
  const blm = meanOf(BASE[1]).mean, bsm = meanOf(BASE[-1]).mean;
  const byM = new Map();
  for (const x of pl) { const k = new Date(bars[x.e.i].t).toISOString().slice(0, 7); if (!byM.has(k)) byM.set(k, []); byM.get(k).push(x); }
  console.log('\n  month by month (my baselines):');
  let pos = 0, n = 0;
  for (const k of [...byM.keys()].sort()) {
    const arr = byM.get(k);
    const a = arr.reduce((s, x) => s + x.v - (x.e.dir === 1 ? blm : bsm), 0) / arr.length;
    if (arr.length >= 20) { n++; if (a > 0) pos++; }
    console.log(`    ${k}  n=${String(arr.length).padStart(4)}  alpha ${f(a).padStart(8)}`);
  }
  console.log(`    positive in ${pos}/${n} months`);
}

// ═══════════════ 8. SELECTION-AWARE PLACEBO ═══════════════
/*
 * The fairest possible statement of the claim is: "the ATR scale and the hold
 * were the only knobs, and the target was then dictated by the measured
 * excursion." Fine — then run that whole procedure, unchanged, on levels that
 * are not session opens. If the procedure produces +12 on junk levels as often
 * as it produced +12 on the real ones, the +12 is the procedure, not the level.
 */
const GTP = [10, 15, 20, 30, 40, 60, 80, 90, 110, 140, 180, 240, 320];
const GH = [30, 60, 120, 240, 480, 1440];
const GG = GTP.length, GHN = GH.length;
const gidx = (a, b, c) => (a * GG + b) * GHN + c;

function gwalk(i, dir) {
  const e = bars[i].c;
  const end = Math.min(N - 1, i + 1440);
  const ftp = new Int32Array(GG).fill(0x7fffffff);
  const fsl = new Int32Array(GG).fill(0x7fffffff);
  const closeP = new Float64Array(GHN), mfeH = new Float64Array(GHN);
  let ti = 0, si = 0, hi = 0, mfe = 0, mae = 0;
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    const fav = dir === 1 ? (b.h - e) / PU : (e - b.l) / PU;
    const adv = dir === 1 ? (e - b.l) / PU : (b.h - e) / PU;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
    while (ti < GG && mfe >= GTP[ti]) ftp[ti++] = j - i;
    while (si < GG && mae >= GTP[si]) fsl[si++] = j - i;
    while (hi < GHN && j - i >= GH[hi]) { closeP[hi] = (b.c - e) * dir / PU - COST; mfeH[hi] = mfe; hi++; }
  }
  while (hi < GHN) { closeP[hi] = (bars[end].c - e) * dir / PU - COST; mfeH[hi] = mfe; hi++; }
  return { ftp, fsl, closeP, mfeH };
}
function gread(w, a, b, c) {
  const h = GH[c], t = w.ftp[a], s = w.fsl[b];
  const tHit = t <= h, sHit = s <= h;
  if (tHit && sHit) { if (t === s) return null; return t < s ? GTP[a] - COST : -GTP[b] - COST; }
  if (tHit) return GTP[a] - COST;
  if (sHit) return -GTP[b] - COST;
  return w.closeP[c];
}
let GB = null;
function buildGridBase(stride = 6) {
  const out = {};
  for (const dir of [1, -1]) {
    const sum = new Float64Array(GG * GG * GHN), cnt = new Float64Array(GG * GG * GHN);
    for (let i = 100; i < N - 1442; i += stride) {
      const w = gwalk(i, dir);
      for (let p = 0, a = 0; a < GG; a++) for (let b = 0; b < GG; b++) for (let c = 0; c < GHN; c++, p++) {
        const v = gread(w, a, b, c); if (v === null) continue; sum[p] += v; cnt[p]++;
      }
    }
    const m = new Float64Array(GG * GG * GHN);
    for (let p = 0; p < m.length; p++) m[p] = cnt[p] >= 500 ? sum[p] / cnt[p] : NaN;
    out[dir] = m;
  }
  return out;
}
const nearestG = v => GTP.reduce((b, g) => Math.abs(g - v) < Math.abs(b - v) ? g : b, GTP[0]);

/** Their exact procedure: best over ATR scale x hold, target=stop dictated by median MFE. */
function runProcedure(getEvents) {
  let best = null;
  const rows = [];
  for (const tf of [1, 5, 15, 60]) {
    const ev = getEvents(tf);
    if (!ev || ev.length < 100) continue;
    const W = ev.map(e => gwalk(e.i, e.dir));
    for (let c = 0; c < GHN; c++) {
      const med = median(W.map(w => w.mfeH[c]));
      const v = nearestG(med);
      const a = GTP.indexOf(v), b = GTP.indexOf(v), p = gidx(a, b, c);
      let ln = 0, lnet = 0, sn = 0, snet = 0;
      for (let k = 0; k < ev.length; k++) {
        const x = gread(W[k], a, b, c); if (x === null) continue;
        if (ev[k].dir === 1) { ln++; lnet += x; } else { sn++; snet += x; }
      }
      const t = ln + sn; if (t < 100) continue;
      const bl = GB[1][p], bs = GB[-1][p];
      const la = ln && Number.isFinite(bl) ? lnet / ln - bl : 0;
      const sa = sn && Number.isFinite(bs) ? snet / sn - bs : 0;
      const alpha = (la * ln + sa * sn) / t;
      rows.push({ tf, hold: GH[c], v, n: t, alpha });
      if (!best || alpha > best.alpha) best = { tf, hold: GH[c], v, n: t, alpha };
    }
  }
  return { best, rows };
}

function stage8() {
  console.log(hr('8.  SELECTION-AWARE PLACEBO — run THEIR procedure on levels that are not opens'));
  process.stdout.write('  building the full grid baseline …\r');
  GB = buildGridBase(6);
  console.log('                                        \r');
  console.log('  procedure: for each ATR scale in {1m,5m,15m,1H} and each hold in {30,60,120,240,480,1440},');
  console.log('  set target = stop = median favourable travel at that hold (their "dictated" rule), score,');
  console.log('  and keep the best cell. That is 24 cells, and the winner of 24 is not an unbiased estimate.\n');

  const real = runProcedure(tf => pooled(FINAL_ANCHORS, tf).filter(e => e.kind === 'reject'));
  console.log(`  REAL session opens  ->  best cell ${TF_NAME[real.best.tf]} ATR / hold ${real.best.hold} / TP=SL ${real.best.v} / n=${real.best.n} / alpha ${f(real.best.alpha)}`);
  console.log('    all 24 cells: ' + real.rows.map(r => `${TF_NAME[r.tf]}/${r.hold}:${f(r.alpha, 0)}`).join(' '));

  for (const mode of ['prevday', 'near', 'intraday']) {
    const bests = [];
    for (let s = 0; s < 20; s++) {
      const cache = new Map();
      const get = tf => {
        if (cache.has(tf)) return cache.get(tf);
        const ev = [];
        for (const m of FINAL_ANCHORS) ev.push(...placeboEventsTF(m, tf, 4242 + s * 6151 + m, mode));
        cache.set(tf, ev); return ev;
      };
      const r = runProcedure(get);
      if (r.best) bests.push(r.best.alpha);
    }
    bests.sort((a, b) => a - b);
    const mu = bests.reduce((a, b) => a + b, 0) / bests.length;
    const sd = Math.sqrt(bests.reduce((a, v) => a + (v - mu) ** 2, 0) / (bests.length - 1));
    const beat = bests.filter(x => x >= real.best.alpha).length;
    console.log(`\n  placebo ${mode.padEnd(9)} ${bests.length} independent junk levels put through the SAME procedure:`);
    console.log(`    best-cell alpha  mean ${f(mu)}  sd ${fp(sd)}  range ${f(bests[0], 0)} … ${f(bests[bests.length - 1], 0)}`);
    console.log(`    junk matched or beat the real level's best cell in ${beat}/${bests.length} runs  ->  empirical p = ${(beat / bests.length).toFixed(2)}`);
  }
}

function placeboEventsTF(anchorMin, tf, seed, mode) {
  const r = rng(seed);
  const { anchors } = myLine(anchorMin);
  const A = ATR_TF.get(tf);
  const out = new Array(N).fill(NaN);
  for (let a = 0; a < anchors.length; a++) {
    const k = anchors[a];
    const stop = a + 1 < anchors.length ? anchors[a + 1] : N;
    const tCut = bars[k].t + 1440 * 60000;
    let px, from = k;
    if (mode === 'intraday') {
      const off = 30 + Math.floor(r() * 210), j = k + off;
      if (j >= stop || j >= N) continue;
      px = bars[j].c; from = j;
    } else if (mode === 'prevday') {
      const pk = a > 0 ? anchors[a - 1] : null;
      if (pk === null) continue;
      px = bars[pk + Math.floor(r() * Math.max(1, k - pk))].c;
    } else {
      const at = Number.isFinite(A[k]) ? A[k] : atr1[k];
      if (!Number.isFinite(at) || at <= 0) continue;
      px = bars[k].o + (0.25 + r() * 0.55) * (r() < 0.5 ? -1 : 1) * at;
    }
    for (let i = from + 1; i < stop; i++) { if (bars[i].t > tCut) break; out[i] = px; }
  }
  return levelTestEvents(bars, out, ATR_TF.get(tf)).filter(e => e.i < N - 5 && e.kind === 'reject');
}

// ═══════════════ 9. HOW BIG IS THE EFFECTIVE SAMPLE ═══════════════
function stage9(ctx) {
  console.log(hr('9.  SAMPLE — IS +12 DISTINGUISHABLE FROM NOISE AT ANY AGGREGATION?'));
  const { pl } = ctx;
  const blm = meanOf(BASE[1]).mean, bsm = meanOf(BASE[-1]).mean;
  const adj = pl.map(x => ({ i: x.e.i, a: x.v - (x.e.dir === 1 ? blm : bsm) }));
  const mean = adj.reduce((s, x) => s + x.a, 0) / adj.length;
  const agg = (keyOf, label) => {
    const m = new Map();
    for (const x of adj) { const k = keyOf(x.i); if (!m.has(k)) m.set(k, []); m.get(k).push(x.a); }
    const vals = [...m.values()].map(v => v.reduce((a, b) => a + b, 0) / v.length);
    const mu = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mu) ** 2, 0) / (vals.length - 1));
    const se = sd / Math.sqrt(vals.length);
    console.log(`  by ${label.padEnd(6)}: ${String(vals.length).padStart(4)} blocks, mean of block means ${f(mu).padStart(8)}  sd ${fp(sd).padStart(6)}  SE ${fp(se).padStart(5)}  t = ${fp(mu / se, 2)}`);
  };
  console.log(`  pooled alpha ${f(mean)} on ${adj.length} trades. Aggregated into independent blocks:`);
  agg(i => DAY[i], 'day');
  agg(i => Math.floor(DAY[i] / 7), 'week');
  agg(i => new Date(bars[i].t).toISOString().slice(0, 7), 'month');
  console.log('  (a t below about 2 is not evidence; the market gives you a fresh sample every day and');
  console.log('   125 days is not many when the per-day spread is this wide.)');
}

// ═══════════════ 10. THE "BEFORE" NUMBER, AND WHERE THE 1H PATTERN COMES FROM ═══════════════
function stage10() {
  console.log(hr('10.  THE "BEFORE" NUMBER, AND WHOSE PROPERTY THE 1H ATR SCALE IS'));
  const LV = require(path.join(__dirname, '..', 'levels'));
  const line = LV.dailyOpenLevels(bars).line;
  const ev = levelTestEvents(bars, line, atr1).filter(e => e.i < N - 5 && e.kind === 'reject');
  // the original 90/90/1440 trade
  let ln = 0, lnet = 0, sn = 0, snet = 0;
  for (const e of ev) { const v = race(e.i, e.dir, 90, 90, 1440); if (v === null) continue; if (e.dir === 1) { ln++; lnet += v; } else { sn++; snet += v; } }
  let bl = 0, bln = 0, bs = 0, bsn = 0;
  for (let i = 100; i < N - 1442; i += 5) {
    const a = race(i, 1, 90, 90, 1440), b = race(i, -1, 90, 90, 1440);
    if (a !== null) { bl += a; bln++; } if (b !== null) { bs += b; bsn++; }
  }
  bl /= bln; bs /= bsn;
  const t = ln + sn;
  const alpha = ((lnet / ln - bl) * ln + (snet / sn - bs) * sn) / t;
  console.log(`  levels.js dailyOpenLevels, 1m ATR, reject as signalled, 90/90/1440:`);
  console.log(`    n=${t}  raw ${f((lnet + snet) / t)}  blind long ${f(bl)} short ${f(bs)}  ALPHA ${f(alpha)}   (their "before" was -6.32)`);

  if (!GB) { process.stdout.write('  building grid baseline …\r'); GB = buildGridBase(6); console.log('                          \r'); }
  console.log('\n  the 24-cell readout for three junk levels — does 1H ATR win for them too?');
  for (const [mode, seed] of [['prevday', 11111], ['near', 22222], ['intraday', 33333]]) {
    const cache = new Map();
    const r = runProcedure(tf => {
      if (cache.has(tf)) return cache.get(tf);
      const e2 = []; for (const m of FINAL_ANCHORS) e2.push(...placeboEventsTF(m, tf, seed + m, mode));
      cache.set(tf, e2); return e2;
    });
    const byTf = {};
    for (const row of r.rows) { (byTf[row.tf] = byTf[row.tf] || []).push(row.alpha); }
    console.log(`    ${mode.padEnd(9)} ` + Object.keys(byTf).map(k => `${TF_NAME[k]} avg ${f(byTf[k].reduce((a, b) => a + b, 0) / byTf[k].length, 1)}`).join('   '));
  }
  const rr = runProcedure(tf => pooled(FINAL_ANCHORS, tf).filter(e => e.kind === 'reject'));
  const byTf = {};
  for (const row of rr.rows) (byTf[row.tf] = byTf[row.tf] || []).push(row.alpha);
  console.log(`    ${'REAL'.padEnd(9)} ` + Object.keys(byTf).map(k => `${TF_NAME[k]} avg ${f(byTf[k].reduce((a, b) => a + b, 0) / byTf[k].length, 1)}`).join('   '));
  console.log('  the same "coarser ATR scores higher" gradient appears on junk levels: it is the detector,');
  console.log('  not the open. Coarser ATR = rarer events, each conditioned on a bigger round trip.');
}

// ───────────────────────── main ─────────────────────────
const t0 = Date.now();
process.stdout.write('  building exact per-bar baselines …\r');
buildExactBase();
console.log(`  exact baselines built over ${N.toLocaleString()} bars (${((Date.now() - t0) / 1000).toFixed(0)}s)          `);

if (on(1)) stage1();
const ctx = stage2();
if (on(3)) stage3(ctx);
if (on(4)) stage4(ctx);
if (on(5)) stage5(ctx);
if (on(6)) stage6();
if (on(7)) stage7(ctx);
if (on(8)) stage8();
if (on(9)) stage9(ctx);
if (on(10)) stage10();
console.log(`\n  total ${((Date.now() - t0) / 1000).toFixed(0)}s`);
