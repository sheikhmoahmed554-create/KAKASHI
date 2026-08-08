'use strict';
/*
 * Independent refutation attempt for the "previous day high/low/close" claim.
 *
 * Nothing here imports the claimed build. The bar loader, the day buckets, the
 * level values, the detector, the trade race, the blind baselines and the
 * direction adjustment are all rewritten from the spec so that agreement with
 * tools/fixes/previous-day.js is evidence, not tautology.
 *
 * Stages:
 *   repro    my own build of FINAL, my own blind baselines, my own alpha
 *   look     causality: streaming generator + prefix reproduction
 *   dir      direction adjustment recomputed, per leg, per month
 *   split    Jan-Apr derive / May-Jul judge, and month by month
 *   overlap  day-clustered t, one-position-at-a-time, day block bootstrap
 *   matched  same-day same-direction random minute: does the LEVEL add anything
 *   state    the boundary with no level test at all
 *   shadow   the same construction on levels that are not yesterday's extremes
 *   grid     how big was the search, and what does the grid look like around it
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PU = 0.10, COST = 0.5;

// ── data (loader copied from tools/sweep_timeframes.js, as instructed) ───────
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

const BARS = loadBars();
const N = BARS.length;

// ── trade race, written independently but to the same rules ─────────────────
function raceOn(bars, i, dir, tp, sl, hold) {
  const n = bars.length;
  const e = bars[i].c;
  const t = e + dir * tp * PU, s = e - dir * sl * PU;
  const end = Math.min(n - 1, i + hold);
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
const race = (i, dir, tp, sl, hold) => raceOn(BARS, i, dir, tp, sl, hold).pnl;

function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ── blind baselines, recomputed for every target ────────────────────────────
const BLIND = new Map();
function blind(dir, tp, sl, hold, draws = 60000) {
  const key = `${dir}|${tp}|${sl}|${hold}`;
  if (BLIND.has(key)) return BLIND.get(key);
  const r = rng(dir === 1 ? 991733 : 424243);   // deliberately different seeds
  let c = 0, net = 0;
  const lo = 100, hi = N - hold - 2;
  for (let k = 0; k < draws; k++) {
    const p = race(lo + Math.floor(r() * (hi - lo)), dir, tp, sl, hold);
    if (p === null) continue;
    c++; net += p;
  }
  const v = net / c;
  BLIND.set(key, v);
  return v;
}

/** Blind baseline restricted to an index window (for the split test). */
function blindWindow(dir, tp, sl, hold, lo, hi, draws = 40000) {
  const r = rng(dir === 1 ? 5150501 : 6160601);
  let c = 0, net = 0;
  const a = Math.max(100, lo), b = Math.max(a + 1, Math.min(hi, N - 2));
  for (let k = 0; k < draws; k++) {
    const p = race(a + Math.floor(r() * (b - a)), dir, tp, sl, hold);
    if (p === null) continue;
    c++; net += p;
  }
  return net / c;
}

/** Direction-adjusted score. Longs vs blind long, shorts vs blind short. */
function score(events, tp, sl, hold, bl, bs) {
  const BL = bl != null ? bl : blind(1, tp, sl, hold);
  const BS = bs != null ? bs : blind(-1, tp, sl, hold);
  let ln = 0, lnet = 0, sn = 0, snet = 0, wins = 0;
  const adj = [];
  for (const e of events) {
    const p = race(e.i, e.dir, tp, sl, hold);
    if (p === null) continue;
    if (p > 0) wins++;
    if (e.dir === 1) { ln++; lnet += p; adj.push({ x: p - BL, e }); }
    else { sn++; snet += p; adj.push({ x: p - BS, e }); }
  }
  const tot = ln + sn;
  const la = ln ? lnet / ln - BL : 0, sa = sn ? snet / sn - BS : 0;
  const alpha = tot ? (la * ln + sa * sn) / tot : NaN;
  let sd = NaN, t = NaN;
  if (tot > 2) {
    let v = 0; for (const d of adj) v += (d.x - alpha) * (d.x - alpha);
    sd = Math.sqrt(v / (tot - 1));
    t = alpha / (sd / Math.sqrt(tot));
  }
  return { n: events.length, traded: tot, longs: ln, shorts: sn,
    winRate: tot ? 100 * wins / tot : NaN,
    raw: tot ? (lnet + snet) / tot : NaN, alpha, sd, t, adj, BL, BS };
}

// ─────────────────────────────────────────────────────────────────────────────
//  MY OWN GENERATOR — strictly streaming, so causality is structural
//
//  One pass over the bars. At every bar the only state carried is:
//    prev  = {h,l,c} of the last COMPLETED day
//    cur   = running h/l of today
//  A level is therefore never available before the day that defines it closed.
//  Detector state is created fresh when a day opens and destroyed when it ends.
// ─────────────────────────────────────────────────────────────────────────────
const DAY = 86400000;
const dayOf = t => Math.floor(t / DAY);

const DEF = {
  tolUsd: 0.80, approachUsd: 5, breakUsd: 0.60, resetUsd: 3.5,
  which: ['h', 'l'], side: 'outside', kind: 'reject',
  tp: 250, sl: 250, hold: 960,
};

/**
 * Streaming event generator.
 * `which` entries: 'h' (yesterday's high), 'l' (low), 'c' (close).
 * Emits every event of every watched level; filtering by side/kind is done by
 * the caller so that all cells come from one pass.
 */
function streamEvents(bars, cfg = {}) {
  const o = Object.assign({}, DEF, cfg);
  const n = bars.length;
  const events = [];
  let prev = null;                 // last completed day {h,l,c}
  let curDay = null, curH = -Infinity, curL = Infinity, curC = NaN, dayStart = 0;
  let watch = [];                  // per-day watchers over fixed level values

  const openDay = i => {
    watch = [];
    if (!prev) return;
    for (const w of o.which) {
      let L = w === 'h' ? prev.h : w === 'l' ? prev.l : prev.c;
      if (o.shiftUsd) L += o.shiftUsd;
      if (o.shiftFrac) L += o.shiftFrac * (prev.h - prev.l);
      if (!Number.isFinite(L)) continue;
      watch.push({ w, L, approached: false, locked: false, touch: 0 });
    }
  };

  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const d = dayOf(b.t);
    if (curDay === null) { curDay = d; dayStart = i; openDay(i); }
    else if (d !== curDay) {
      if (Number.isFinite(curC)) prev = { h: curH, l: curL, c: curC };
      curDay = d; curH = -Infinity; curL = Infinity; dayStart = i;
      openDay(i);
    }

    // ---- detection uses ONLY bars[0..i] ----
    if (i >= 1) {
      for (const s of watch) {
        const dist = Math.abs(b.c - s.L);
        if (s.locked && dist > o.resetUsd) s.locked = false;
        if (dist >= o.approachUsd) s.approached = true;
        if (!s.approached || s.locked) continue;
        const fromAbove = bars[i - 1].c > s.L;
        const reached = fromAbove ? b.l <= s.L + o.tolUsd : b.h >= s.L - o.tolUsd;
        if (!reached) continue;
        let dir = 0, kind = null;
        if (fromAbove) {
          if (b.c > s.L + o.tolUsd * 0.5) { dir = 1; kind = 'reject'; }
          else if (b.c < s.L - o.breakUsd) { dir = -1; kind = 'break'; }
          else continue;
        } else {
          if (b.c < s.L - o.tolUsd * 0.5) { dir = -1; kind = 'reject'; }
          else if (b.c > s.L + o.breakUsd) { dir = 1; kind = 'break'; }
          else continue;
        }
        s.touch++;
        events.push({ i, dir, kind, which: s.w, level: s.L, fromAbove,
          touch: s.touch, day: curDay, dayStart, mins: i - dayStart, t: b.t });
        s.locked = true;
        s.approached = false;
      }
    }

    // ---- only after detection does today's bar join today's aggregate ----
    if (b.h > curH) curH = b.h;
    if (b.l < curL) curL = b.l;
    curC = b.c;
  }
  return events;
}

/** side/kind selection identical in meaning to the claim's `wantSide`. */
function selectCell(events, side, kind) {
  return events.filter(e => {
    if (kind !== 'any' && e.kind !== kind) return false;
    if (side === 'outside') return e.which === 'h' ? e.fromAbove : !e.fromAbove;
    if (side === 'inside') return e.which === 'h' ? !e.fromAbove : e.fromAbove;
    if (side === 'above') return e.fromAbove;
    if (side === 'below') return !e.fromAbove;
    return true;
  });
}

/** one event per 1m bar; keep the level the close is nearest to */
function dedupe(events, bars = BARS) {
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

function finalSet(cfg = {}) {
  const o = Object.assign({}, DEF, cfg);
  return dedupe(selectCell(streamEvents(BARS, o), o.side, o.kind));
}

// ── formatting ──────────────────────────────────────────────────────────────
const f = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '—';
const sg = (x, d = 2) => Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '—';
const pad = (s, n) => String(s).padEnd(n);
const rp = (s, n) => String(s).padStart(n);
const hr = n => console.log('─'.repeat(n));
const iso = t => new Date(t).toISOString().slice(0, 10);
const mon = t => new Date(t).toISOString().slice(0, 7);

// ─────────────────────────────────────────────────────────────────────────────
function stageRepro() {
  console.log('INDEPENDENT REPRODUCTION OF THE CLAIM');
  console.log(`bars ${N.toLocaleString()}  ${iso(BARS[0].t)} → ${iso(BARS[N - 1].t)}`);
  const all = streamEvents(BARS, DEF);
  console.log(`raw events across both levels, all sides, all kinds: ${all.length}`);
  const ev = finalSet();
  const BL = blind(1, 250, 250, 960), BS = blind(-1, 250, 250, 960);
  console.log(`my blind baselines at 250/250/960:  long ${f(BL)}   short ${f(BS)}   (theirs: -15.89 / +13.22)`);
  const s = score(ev, 250, 250, 960);
  console.log(`\nFINAL cell (outside reject, PDH+PDL, 250/250/960)`);
  console.log(`  events ${s.n}  traded ${s.traded}  longs ${s.longs} shorts ${s.shorts}  win ${f(s.winRate, 1)}%`);
  console.log(`  raw ${sg(s.raw)}   ALPHA ${sg(s.alpha)}   sd ${f(s.sd, 1)}   naive t ${f(s.t)}`);
  console.log(`  claim: 341 events, alpha +51.38, t 3.88`);

  console.log('\nThe whole 2x2x2 grid on my own build, at 250/250/960 (alpha / n):');
  hr(76);
  console.log(pad('  level', 10) + pad('arrival', 14) + pad('reading', 10) + rp('n', 7) + rp('alpha', 10) + rp('t', 8));
  hr(76);
  for (const w of ['h', 'l', 'c']) {
    const evs = streamEvents(BARS, Object.assign({}, DEF, { which: [w] }));
    for (const fa of [true, false]) {
      for (const k of ['reject', 'break']) {
        const cell = evs.filter(e => e.fromAbove === fa && e.kind === k);
        if (cell.length < 25) continue;
        const q = score(cell, 250, 250, 960);
        console.log(pad('  ' + (w === 'h' ? 'PDH' : w === 'l' ? 'PDL' : 'PDC'), 10) +
          pad(fa ? 'from above' : 'from below', 14) + pad(k, 10) +
          rp(q.traded, 7) + rp(sg(q.alpha), 10) + rp(f(q.t), 8));
      }
    }
  }
  hr(76);
}

// ─────────────────────────────────────────────────────────────────────────────
function stageLook() {
  console.log('CAUSALITY AUDIT');
  hr(80);

  // 1. level values must equal the max/min of bars strictly before the day opens
  const ev = finalSet();
  const dayFirst = new Map();          // day -> first index
  for (let i = 0; i < N; i++) { const d = dayOf(BARS[i].t); if (!dayFirst.has(d)) dayFirst.set(d, i); }
  const days = [...dayFirst.keys()].sort((a, b) => a - b);
  const prevOf = new Map();
  for (let k = 1; k < days.length; k++) {
    const a = dayFirst.get(days[k - 1]), b = dayFirst.get(days[k]) - 1;
    let h = -Infinity, l = Infinity;
    for (let i = a; i <= b; i++) { if (BARS[i].h > h) h = BARS[i].h; if (BARS[i].l < l) l = BARS[i].l; }
    prevOf.set(days[k], { h, l, first: dayFirst.get(days[k]), prevLast: b });
  }
  let bad = 0, checked = 0;
  for (const e of ev) {
    const p = prevOf.get(e.day);
    if (!p) { bad++; continue; }
    const want = e.which === 'h' ? p.h : p.l;
    checked++;
    if (Math.abs(want - e.level) > 1e-9) bad++;
    if (e.i <= p.prevLast) bad++;          // event before the defining day closed
  }
  console.log(`  1. level value == extreme of the strictly previous session, and every event`);
  console.log(`     occurs after that session's last bar:  ${checked} checked, ${bad} violations`);

  // 2. prefix reproduction — rebuild from truncated data, events must match
  let mism = 0, cmp = 0;
  for (const frac of [0.25, 0.4, 0.55, 0.7, 0.85]) {
    const M = Math.floor(N * frac);
    const sub = BARS.slice(0, M);
    const pe = dedupe(selectCell(streamEvents(sub, DEF), DEF.side, DEF.kind), sub);
    // compare against full-sample events that lie safely inside the prefix
    const cut = M - 1;
    const A = ev.filter(e => e.i < cut - 1);
    const B = pe.filter(e => e.i < cut - 1);
    const key = e => `${e.i}|${e.dir}|${e.kind}|${e.which}|${e.level.toFixed(4)}`;
    const sa = new Set(A.map(key)), sb = new Set(B.map(key));
    let d = 0;
    for (const k of sa) if (!sb.has(k)) d++;
    for (const k of sb) if (!sa.has(k)) d++;
    cmp++; mism += d;
    console.log(`  2. prefix ${(frac * 100).toFixed(0)}%  full ${A.length} vs prefix ${B.length}  mismatches ${d}`);
  }
  console.log(`     total prefix mismatches over ${cmp} cuts: ${mism}`);

  // 3. does the trade read only bars after entry?
  //    shift the whole entry one bar later; if the result collapses, the event
  //    bar itself is being used as information it could not have.
  const later = ev.filter(e => e.i + 1 < N - 2).map(e => ({ ...e, i: e.i + 1 }));
  const s0 = score(ev, 250, 250, 960), s1 = score(later, 250, 250, 960);
  console.log(`  3. entry at the event bar's close      alpha ${sg(s0.alpha)}  n ${s0.traded}`);
  console.log(`     entry one bar later                 alpha ${sg(s1.alpha)}  n ${s1.traded}`);

  // 4. is the level itself ever "in the future"? i.e. does using TODAY's
  //    completed high/low (a genuine lookahead) beat it? If the claimed build
  //    scores like the lookahead build, something leaked.
  const todayLevels = [];
  for (let k = 1; k < days.length; k++) {
    const a = dayFirst.get(days[k]), b = (k + 1 < days.length ? dayFirst.get(days[k + 1]) : N) - 1;
    let h = -Infinity, l = Infinity;
    for (let i = a; i <= b; i++) { if (BARS[i].h > h) h = BARS[i].h; if (BARS[i].l < l) l = BARS[i].l; }
    todayLevels.push({ a, b, h, l });
  }
  console.log(`  4. (reference) a deliberate lookahead build using TODAY's own extremes is not`);
  console.log(`     run here; the prefix test above is the binding check.`);
  hr(80);
}

// ─────────────────────────────────────────────────────────────────────────────
function stageDir() {
  console.log('DIRECTION ADJUSTMENT, RECOMPUTED');
  const ev = finalSet();
  const BL = blind(1, 250, 250, 960), BS = blind(-1, 250, 250, 960);
  console.log(`  blind long ${f(BL)}   blind short ${f(BS)}   (sample drift shows up as the gap)`);
  const L = ev.filter(e => e.dir === 1), S = ev.filter(e => e.dir === -1);
  const sl = score(L, 250, 250, 960), ss = score(S, 250, 250, 960);
  console.log(`  longs   n ${sl.traded}  raw ${sg(sl.raw)}  alpha ${sg(sl.alpha)}  t ${f(sl.t)}`);
  console.log(`  shorts  n ${ss.traded}  raw ${sg(ss.raw)}  alpha ${sg(ss.alpha)}  t ${f(ss.t)}`);
  const s = score(ev, 250, 250, 960);
  console.log(`  combined alpha ${sg(s.alpha)}  short share ${f(100 * s.shorts / s.traded, 1)}%`);

  // a stricter adjustment: baseline drawn from the SAME calendar day as the
  // event, so any month-level drift is differenced out entirely.
  console.log('\n  Stricter baseline — random minute of the SAME day, same direction:');
  const r = rng(20260808);
  const dayIdx = new Map();
  for (let i = 0; i < N; i++) { const d = dayOf(BARS[i].t); if (!dayIdx.has(d)) dayIdx.set(d, [i, i]); else dayIdx.get(d)[1] = i; }
  let dn = 0, dsum = 0;
  const per = [];
  for (const e of ev) {
    const [a, b] = dayIdx.get(e.day);
    let acc = 0, cnt = 0;
    for (let k = 0; k < 40; k++) {
      const j = a + Math.floor(r() * (b - a + 1));
      if (j >= N - 2) continue;
      const p = race(j, e.dir, 250, 250, 960);
      if (p === null) continue;
      acc += p; cnt++;
    }
    const own = race(e.i, e.dir, 250, 250, 960);
    if (!cnt || own === null) continue;
    per.push(own - acc / cnt);
    dsum += own - acc / cnt; dn++;
  }
  const m = dsum / dn;
  let v = 0; for (const x of per) v += (x - m) * (x - m);
  const sd = Math.sqrt(v / (dn - 1)), t = m / (sd / Math.sqrt(dn));
  console.log(`  level increment over same-day same-direction random entry: ${sg(m)}  n ${dn}  t ${f(t)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
function stageSplit() {
  console.log('OUT-OF-SAMPLE SPLIT  (derive Jan-Apr, judge May-Jul)');
  const ev = finalSet();
  const cutT = Date.parse('2026-05-01T00:00:00Z');
  let cutI = N - 1;
  for (let i = 0; i < N; i++) if (BARS[i].t >= cutT) { cutI = i; break; }
  console.log(`  cut at bar ${cutI} (${iso(BARS[cutI].t)}) of ${N}`);

  const A = ev.filter(e => e.i < cutI), B = ev.filter(e => e.i >= cutI);
  const blA = blindWindow(1, 250, 250, 960, 100, cutI), bsA = blindWindow(-1, 250, 250, 960, 100, cutI);
  const blB = blindWindow(1, 250, 250, 960, cutI, N - 962), bsB = blindWindow(-1, 250, 250, 960, cutI, N - 962);
  const sA = score(A, 250, 250, 960, blA, bsA), sB = score(B, 250, 250, 960, blB, bsB);
  console.log(`  Jan-Apr  n ${sA.traded}  raw ${sg(sA.raw)}  blind L ${f(blA)} S ${f(bsA)}  ALPHA ${sg(sA.alpha)}  t ${f(sA.t)}`);
  console.log(`  May-Jul  n ${sB.traded}  raw ${sg(sB.raw)}  blind L ${f(blB)} S ${f(bsB)}  ALPHA ${sg(sB.alpha)}  t ${f(sB.t)}`);
  // also with the global baseline, so the two conventions can be compared
  const sA2 = score(A, 250, 250, 960), sB2 = score(B, 250, 250, 960);
  console.log(`  (with the whole-sample baseline instead: Jan-Apr ${sg(sA2.alpha)}, May-Jul ${sg(sB2.alpha)})`);

  console.log('\n  Month by month, global baseline:');
  hr(60);
  const byM = new Map();
  for (const e of ev) { const k = mon(BARS[e.i].t); if (!byM.has(k)) byM.set(k, []); byM.get(k).push(e); }
  for (const k of [...byM.keys()].sort()) {
    const q = score(byM.get(k), 250, 250, 960);
    console.log(`   ${k}  n ${rp(q.traded, 4)}  raw ${rp(sg(q.raw), 9)}  alpha ${rp(sg(q.alpha), 9)}`);
  }
  hr(60);

  console.log('\n  Target grid re-derived on Jan-Apr only, then judged on May-Jul:');
  hr(78);
  console.log(pad('  tp/sl/hold', 18) + rp('nA', 6) + rp('alphaA', 10) + rp('nB', 6) + rp('alphaB', 10));
  hr(78);
  let best = null;
  for (const [tp, sl, hold] of [[90, 90, 1440], [120, 120, 960], [150, 150, 960], [200, 200, 960],
    [250, 250, 960], [300, 300, 960], [400, 400, 960], [250, 250, 480], [250, 250, 1440], [500, 250, 960], [250, 500, 960]]) {
    const ba = blindWindow(1, tp, sl, hold, 100, cutI), sa = blindWindow(-1, tp, sl, hold, 100, cutI);
    const bb = blindWindow(1, tp, sl, hold, cutI, N - hold - 2), sb = blindWindow(-1, tp, sl, hold, cutI, N - hold - 2);
    const qa = score(A, tp, sl, hold, ba, sa), qb = score(B, tp, sl, hold, bb, sb);
    console.log(pad(`  ${tp}/${sl}/${hold}`, 18) + rp(qa.traded, 6) + rp(sg(qa.alpha), 10) + rp(qb.traded, 6) + rp(sg(qb.alpha), 10));
    if (!best || qa.alpha > best.a) best = { a: qa.alpha, tp, sl, hold, b: qb.alpha, nb: qb.traded };
  }
  hr(78);
  console.log(`  best on Jan-Apr: ${best.tp}/${best.sl}/${best.hold} (alpha ${sg(best.a)}) → May-Jul ${sg(best.b)} over ${best.nb} trades`);
}

// ─────────────────────────────────────────────────────────────────────────────
function stageOverlap() {
  console.log('HOW MANY INDEPENDENT OBSERVATIONS ARE THERE REALLY?');
  const ev = finalSet();
  const s = score(ev, 250, 250, 960);
  console.log(`  naive: n ${s.traded}  alpha ${sg(s.alpha)}  sd ${f(s.sd, 1)}  t ${f(s.t)}`);

  // day-clustered standard error
  const byDay = new Map();
  for (const d of s.adj) { const k = d.e.day; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(d.x); }
  const dayMeans = [...byDay.values()].map(a => a.reduce((x, y) => x + y, 0) / a.length);
  const nd = dayMeans.length;
  const mD = dayMeans.reduce((x, y) => x + y, 0) / nd;
  let vD = 0; for (const x of dayMeans) vD += (x - mD) * (x - mD);
  const sdD = Math.sqrt(vD / (nd - 1));
  console.log(`  clustered by day: ${nd} days, mean of day means ${sg(mD)}, t ${f(mD / (sdD / Math.sqrt(nd)))}`);

  // one position at a time
  const sorted = ev.slice().sort((a, b) => a.i - b.i);
  const ser = []; let free = -1;
  for (const e of sorted) {
    if (e.i <= free) continue;
    const r = raceOn(BARS, e.i, e.dir, 250, 250, 960);
    free = r.exit; ser.push(e);
  }
  const ss = score(ser, 250, 250, 960);
  console.log(`  one position at a time: n ${ss.traded}  alpha ${sg(ss.alpha)}  t ${f(ss.t)}`);

  // moving-block bootstrap over days
  const dayKeys = [...byDay.keys()].sort((a, b) => a - b);
  const B = 4000, blockDays = 10;
  const r = rng(777001);
  let ge = 0;
  const boots = [];
  for (let b = 0; b < B; b++) {
    let acc = 0, cnt = 0;
    for (let q = 0; q < Math.ceil(nd / blockDays); q++) {
      const st = Math.floor(r() * Math.max(1, dayKeys.length - blockDays));
      for (let z = 0; z < blockDays; z++) {
        const arr = byDay.get(dayKeys[st + z]);
        if (!arr) continue;
        for (const x of arr) { acc += x; cnt++; }
      }
    }
    const m = acc / cnt;
    boots.push(m);
    if (m <= 0) ge++;
  }
  boots.sort((a, b) => a - b);
  console.log(`  moving-block bootstrap (${blockDays}-day blocks, ${B} draws): mean ${sg(boots.reduce((x, y) => x + y, 0) / B)}`);
  console.log(`    5th pct ${sg(boots[Math.floor(0.05 * B)])}   95th pct ${sg(boots[Math.floor(0.95 * B)])}   P(alpha<=0) ${f(100 * ge / B, 1)}%`);
}

// ─────────────────────────────────────────────────────────────────────────────
function stageMatched() {
  console.log('DOES THE LEVEL ADD ANYTHING OVER THE DAY AND THE DIRECTION?');
  const ev = finalSet();
  const dayIdx = new Map();
  for (let i = 0; i < N; i++) { const d = dayOf(BARS[i].t); if (!dayIdx.has(d)) dayIdx.set(d, [i, i]); else dayIdx.get(d)[1] = i; }

  // 1. entry shifted in time, day and direction held fixed
  console.log('\n  Entry shifted in time (same event, same direction):');
  hr(50);
  for (const sh of [-480, -240, -120, -60, -30, 0, 30, 60, 120, 240, 480]) {
    const moved = ev.map(e => ({ ...e, i: e.i + sh })).filter(e => e.i > 100 && e.i < N - 2);
    const q = score(moved, 250, 250, 960);
    console.log(`   ${rp(sh, 5)} min   n ${rp(q.traded, 4)}   alpha ${rp(sg(q.alpha), 9)}   t ${rp(f(q.t), 6)}`);
  }
  hr(50);
  console.log('   If the level were the source, alpha would peak at 0 and fall away either side.');

  // 2. random minute of the same day, same direction, as a null distribution
  const r = rng(31415926);
  const DRAWS = 400;
  const nulls = [];
  for (let d = 0; d < DRAWS; d++) {
    let acc = 0, cnt = 0;
    for (const e of ev) {
      const [a, b] = dayIdx.get(e.day);
      const j = Math.min(N - 3, a + Math.floor(r() * (b - a + 1)));
      const p = race(j, e.dir, 250, 250, 960);
      if (p === null) continue;
      acc += p - (e.dir === 1 ? blind(1, 250, 250, 960) : blind(-1, 250, 250, 960));
      cnt++;
    }
    nulls.push(acc / cnt);
  }
  nulls.sort((a, b) => a - b);
  const s = score(ev, 250, 250, 960);
  const mu = nulls.reduce((x, y) => x + y, 0) / nulls.length;
  let v = 0; for (const x of nulls) v += (x - mu) * (x - mu);
  const sd = Math.sqrt(v / (nulls.length - 1));
  let ge = 0; for (const x of nulls) if (x >= s.alpha) ge++;
  console.log(`\n  Random minute of the same day, same direction (${DRAWS} draws of the whole set):`);
  console.log(`   null alpha mean ${sg(mu)}  sd ${f(sd)}  5th ${sg(nulls[Math.floor(0.05 * DRAWS)])}  95th ${sg(nulls[Math.floor(0.95 * DRAWS)])}`);
  console.log(`   observed at the retest ${sg(s.alpha)}   z ${f((s.alpha - mu) / sd)}   P(null >= observed) ${f(100 * ge / DRAWS, 1)}%`);
  console.log(`   the level's own contribution is the gap: ${sg(s.alpha - mu)} points/trade`);
}

// ─────────────────────────────────────────────────────────────────────────────
function stageState() {
  console.log('THE RANGE READ AS A BOUNDARY, WITH NO LEVEL TEST AT ALL');
  console.log('At a sampled minute: long if price is above yesterday\'s high, short if below yesterday\'s low.');
  const dayFirst = new Map();
  for (let i = 0; i < N; i++) { const d = dayOf(BARS[i].t); if (!dayFirst.has(d)) dayFirst.set(d, i); }
  const days = [...dayFirst.keys()].sort((a, b) => a - b);
  const lvl = new Map();
  for (let k = 1; k < days.length; k++) {
    const a = dayFirst.get(days[k - 1]), b = dayFirst.get(days[k]) - 1;
    let h = -Infinity, l = Infinity;
    for (let i = a; i <= b; i++) { if (BARS[i].h > h) h = BARS[i].h; if (BARS[i].l < l) l = BARS[i].l; }
    lvl.set(days[k], { h, l });
  }
  // sample every 60 minutes
  const obs = [];
  for (let i = 100; i < N - 962; i += 60) {
    const d = dayOf(BARS[i].t);
    const L = lvl.get(d);
    if (!L) continue;
    const c = BARS[i].c;
    let dir = 0;
    if (c > L.h) dir = 1; else if (c < L.l) dir = -1; else continue;
    obs.push({ i, dir, day: d });
  }
  const s = score(obs, 250, 250, 960);
  console.log(`  n ${s.traded}  longs ${s.longs} shorts ${s.shorts}  raw ${sg(s.raw)}  ALPHA ${sg(s.alpha)}  naive t ${f(s.t)}`);
  const byDay = new Map();
  for (const d of s.adj) { const k = d.e.day; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(d.x); }
  const dm = [...byDay.values()].map(a => a.reduce((x, y) => x + y, 0) / a.length);
  const m = dm.reduce((x, y) => x + y, 0) / dm.length;
  let v = 0; for (const x of dm) v += (x - m) * (x - m);
  const sd = Math.sqrt(v / (dm.length - 1));
  console.log(`  clustered by day: ${dm.length} days, alpha ${sg(m)}, t ${f(m / (sd / Math.sqrt(dm.length)))}`);

  // the same state built from the range of D days ago
  console.log('\n  Same reading, using the range of N sessions ago instead of yesterday:');
  hr(52);
  for (const lag of [1, 2, 3, 5, 8, 13, 21]) {
    const lv2 = new Map();
    for (let k = lag; k < days.length; k++) {
      const a = dayFirst.get(days[k - lag]), b = (k - lag + 1 < days.length ? dayFirst.get(days[k - lag + 1]) : N) - 1;
      let h = -Infinity, l = Infinity;
      for (let i = a; i <= b; i++) { if (BARS[i].h > h) h = BARS[i].h; if (BARS[i].l < l) l = BARS[i].l; }
      lv2.set(days[k], { h, l });
    }
    const o2 = [];
    for (let i = 100; i < N - 962; i += 60) {
      const L = lv2.get(dayOf(BARS[i].t));
      if (!L) continue;
      const c = BARS[i].c;
      let dir = 0;
      if (c > L.h) dir = 1; else if (c < L.l) dir = -1; else continue;
      o2.push({ i, dir });
    }
    const q = score(o2, 250, 250, 960);
    console.log(`   lag ${rp(lag, 2)} sessions   n ${rp(q.traded, 5)}   alpha ${rp(sg(q.alpha), 9)}   t ${rp(f(q.t), 6)}`);
  }
  hr(52);
}

// ─────────────────────────────────────────────────────────────────────────────
function stageShadow() {
  console.log('SHADOW LEVELS — the same construction on prices that are not the extremes');
  console.log('The level is displaced by a fraction of yesterday\'s range; everything else is identical.');
  const real = score(finalSet(), 250, 250, 960);
  hr(58);
  console.log(pad('  displacement', 18) + rp('n', 7) + rp('alpha', 10) + rp('t', 8));
  hr(58);
  const rows = [];
  for (const fr of [-0.30, -0.20, -0.12, -0.06, -0.03, 0, 0.03, 0.06, 0.12, 0.20, 0.30]) {
    const ev = finalSet({ shiftFrac: fr });
    if (ev.length < 40) { console.log(pad(`  ${fr >= 0 ? '+' : ''}${(fr * 100).toFixed(0)}% of range`, 18) + rp(ev.length, 7) + '   too few'); continue; }
    const q = score(ev, 250, 250, 960);
    if (fr !== 0) rows.push(q.alpha);
    console.log(pad(`  ${fr >= 0 ? '+' : ''}${(fr * 100).toFixed(0)}% of range`, 18) + rp(q.traded, 7) + rp(sg(q.alpha), 10) + rp(f(q.t), 8));
  }
  hr(58);
  const m = rows.reduce((x, y) => x + y, 0) / rows.length;
  let v = 0; for (const x of rows) v += (x - m) * (x - m);
  const sd = Math.sqrt(v / (rows.length - 1));
  console.log(`  shadow mean ${sg(m)}  sd ${f(sd)}   real ${sg(real.alpha)}   z of real over shadows ${f((real.alpha - m) / sd)}`);
  console.log('  A displaced level is still "beyond yesterday\'s range" most of the time, so this');
  console.log('  measures how much of the number is the boundary state rather than the exact price.');
}

// ─────────────────────────────────────────────────────────────────────────────
function stageGrid() {
  console.log('SIZE OF THE SEARCH');
  console.log('Every cell the claim had to look at before choosing one. Alpha at 250/250/960.');
  hr(70);
  const levels = [['h', 'PDH'], ['l', 'PDL'], ['c', 'PDC']];
  let pos = 0, tot = 0, mx = -1e9;
  const list = [];
  for (const [w, nm] of levels) {
    const evs = streamEvents(BARS, Object.assign({}, DEF, { which: [w] }));
    for (const fa of [true, false]) for (const k of ['reject', 'break']) {
      const cell = evs.filter(e => e.fromAbove === fa && e.kind === k);
      if (cell.length < 25) continue;
      const q = score(cell, 250, 250, 960);
      tot++; if (q.alpha > 0) pos++;
      if (q.alpha > mx) mx = q.alpha;
      list.push([`${nm} ${fa ? 'above' : 'below'} ${k}`, q.traded, q.alpha]);
    }
  }
  list.sort((a, b) => b[2] - a[2]);
  for (const [n, c, a] of list) console.log(pad('  ' + n, 28) + rp(c, 6) + rp(sg(a), 10));
  hr(70);
  console.log(`  ${tot} cells, ${pos} positive, best ${sg(mx)}.`);
  console.log('  With ~12 cells x 6 timeframes x 7 tolerances x ~10 targets the claim searched');
  console.log('  a space of order 5,000 configurations on one 7-month sample.');

  console.log('\n  Neighbourhood of the chosen detector (does it sit on a spike?):');
  hr(70);
  console.log(pad('  tol/appr/brk/reset', 26) + rp('n', 7) + rp('alpha', 10) + rp('t', 8));
  hr(70);
  for (const tol of [0.4, 0.8, 1.5]) for (const ap of [3, 5, 8]) {
    const ev = finalSet({ tolUsd: tol, approachUsd: ap });
    const q = score(ev, 250, 250, 960);
    console.log(pad(`  ${tol}/${ap}/0.6/3.5`, 26) + rp(q.traded, 7) + rp(sg(q.alpha), 10) + rp(f(q.t), 8));
  }
  hr(70);
}

// ─────────────────────────────────────────────────────────────────────────────
/** Cluster-robust standard error of the event-weighted mean. */
function clusterT(adj, keyOf) {
  const g = new Map();
  let sum = 0, n = 0;
  for (const d of adj) { const k = keyOf(d.e); if (!g.has(k)) g.set(k, []); g.get(k).push(d.x); sum += d.x; n++; }
  const m = sum / n;
  let v = 0;
  for (const arr of g.values()) { let s = 0; for (const x of arr) s += x - m; v += s * s; }
  const G = g.size;
  const se = Math.sqrt(v * (G / Math.max(1, G - 1))) / n;
  return { m, G, se, t: m / se };
}

function stagePower() {
  console.log('IS +50 DISTINGUISHABLE FROM NOISE ONCE THE DEPENDENCE IS HANDLED?');
  const ev = finalSet();
  const s = score(ev, 250, 250, 960);
  console.log(`  event-weighted alpha ${sg(s.alpha)} over ${s.traded} trades\n`);

  const week = e => Math.floor((BARS[e.i].t - 4 * DAY) / (7 * DAY));
  const d = clusterT(s.adj, e => e.day);
  const w = clusterT(s.adj, e => week(e));
  const half = clusterT(s.adj, e => Math.floor(week(e) / 2));
  console.log(`  iid (wrong, trades overlap)        t ${f(s.t)}`);
  console.log(`  clustered by day    ${rp(d.G, 3)} clusters   t ${f(d.t)}`);
  console.log(`  clustered by week   ${rp(w.G, 3)} clusters   t ${f(w.t)}`);
  console.log(`  clustered by 2 wks  ${rp(half.G, 3)} clusters   t ${f(half.t)}`);

  // day-level concentration
  const byDay = new Map();
  for (const x of s.adj) { const k = x.e.day; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(x.x); }
  const contrib = [...byDay.entries()].map(([k, a]) => [k, a.reduce((p, q) => p + q, 0), a.length]);
  contrib.sort((a, b) => b[1] - a[1]);
  const total = contrib.reduce((p, q) => p + q[1], 0);
  console.log(`\n  ${contrib.length} days carry the result. Top days by contribution:`);
  for (let i = 0; i < 6; i++) {
    const [k, c, n] = contrib[i];
    console.log(`   ${iso(k * DAY)}  ${rp(n, 3)} trades  contributes ${rp(sg(c, 0), 8)}  (${f(100 * c / total, 1)}% of total)`);
  }
  for (const drop of [1, 3, 5, 10]) {
    const keep = new Set(contrib.slice(drop).map(x => x[0]));
    const sub = ev.filter(e => keep.has(e.day));
    const q = score(sub, 250, 250, 960);
    const c2 = clusterT(q.adj, e => e.day);
    console.log(`   drop the best ${rp(drop, 2)} day(s): n ${rp(q.traded, 4)}  alpha ${rp(sg(q.alpha), 9)}  day-clustered t ${f(c2.t)}`);
  }

  // circular block bootstrap over calendar days
  const allDays = [...new Set(BARS.map(b => dayOf(b.t)))].sort((a, b) => a - b);
  const pos = new Map(); allDays.forEach((k, i) => pos.set(k, i));
  const perDay = new Map();
  for (const x of s.adj) { const k = x.e.day; if (!perDay.has(k)) perDay.set(k, []); perDay.get(k).push(x.x); }
  console.log('\n  Circular block bootstrap over calendar days (4000 draws):');
  const r = rng(90210);
  for (const bl of [1, 5, 10, 20]) {
    const nb = Math.ceil(allDays.length / bl);
    const draws = [];
    for (let b = 0; b < 4000; b++) {
      let acc = 0, cnt = 0;
      for (let q = 0; q < nb; q++) {
        const st = Math.floor(r() * allDays.length);
        for (let z = 0; z < bl; z++) {
          const arr = perDay.get(allDays[(st + z) % allDays.length]);
          if (!arr) continue;
          for (const x of arr) { acc += x; cnt++; }
        }
      }
      if (cnt) draws.push(acc / cnt);
    }
    draws.sort((a, b) => a - b);
    let le = 0; for (const x of draws) if (x <= 0) le++;
    console.log(`   block ${rp(bl, 2)}d   mean ${rp(sg(draws.reduce((a, b) => a + b, 0) / draws.length), 9)}   5th ${rp(sg(draws[Math.floor(0.05 * draws.length)]), 9)}   P(alpha<=0) ${f(100 * le / draws.length, 1)}%`);
  }

  // monthly, with a month-local blind baseline (drift removed inside the month)
  console.log('\n  Month by month with a MONTH-LOCAL blind baseline (drift differenced out):');
  hr(66);
  const mIdx = new Map();
  for (let i = 0; i < N; i++) { const k = mon(BARS[i].t); if (!mIdx.has(k)) mIdx.set(k, [i, i]); else mIdx.get(k)[1] = i; }
  const byM = new Map();
  for (const e of ev) { const k = mon(BARS[e.i].t); if (!byM.has(k)) byM.set(k, []); byM.get(k).push(e); }
  let posM = 0, totM = 0;
  for (const k of [...byM.keys()].sort()) {
    const [a, b] = mIdx.get(k);
    const bl = blindWindow(1, 250, 250, 960, a, b, 20000), bs = blindWindow(-1, 250, 250, 960, a, b, 20000);
    const q = score(byM.get(k), 250, 250, 960, bl, bs);
    totM++; if (q.alpha > 0) posM++;
    console.log(`   ${k}  n ${rp(q.traded, 4)}  local blind L ${rp(f(bl), 8)} S ${rp(f(bs), 8)}  alpha ${rp(sg(q.alpha), 9)}`);
  }
  hr(66);
  console.log(`   ${posM}/${totM} months positive against their own local baseline.`);
}

// ─────────────────────────────────────────────────────────────────────────────
function stageWhen() {
  console.log('WHERE IN THE DAY DOES THE MONEY COME FROM?');
  console.log('If the level mattered, the retest minute would beat a fixed minute of the same day.');
  const ev = finalSet();
  const dayIdx = new Map();
  for (let i = 0; i < N; i++) { const d = dayOf(BARS[i].t); if (!dayIdx.has(d)) dayIdx.set(d, [i, i]); else dayIdx.get(d)[1] = i; }

  const variants = {
    'at the retest bar': e => e.i,
    'at the day open (same dir)': e => dayIdx.get(e.day)[0],
    'at day open + 240m': e => Math.min(dayIdx.get(e.day)[1], dayIdx.get(e.day)[0] + 240),
    'at day open + 480m': e => Math.min(dayIdx.get(e.day)[1], dayIdx.get(e.day)[0] + 480),
    'at the day close (same dir)': e => dayIdx.get(e.day)[1],
  };
  hr(64);
  for (const [name, pick] of Object.entries(variants)) {
    const alt = ev.map(e => ({ ...e, i: Math.min(N - 3, Math.max(100, pick(e))) }));
    const q = score(alt, 250, 250, 960);
    const c = clusterT(q.adj, e => e.day);
    console.log(pad('  ' + name, 32) + rp(q.traded, 6) + rp(sg(q.alpha), 10) + rp('t ' + f(c.t), 10));
  }
  hr(64);
  console.log('  (day-clustered t in the last column; none of these are tradeable — they use the');
  console.log('   direction the retest later revealed. They are here only to attribute the alpha.)');

  console.log('\n  Alpha by which touch of the level it is, and by minutes into the session:');
  hr(64);
  for (const [lab, sel] of [['1st touch', e => e.touch === 1], ['2nd touch', e => e.touch === 2],
    ['3rd+', e => e.touch >= 3], ['first 4h of day', e => e.mins < 240], ['4-12h', e => e.mins >= 240 && e.mins < 720],
    ['12h+', e => e.mins >= 720]]) {
    const sub = ev.filter(sel);
    if (sub.length < 20) continue;
    const q = score(sub, 250, 250, 960);
    const c = clusterT(q.adj, e => e.day);
    console.log(pad('  ' + lab, 22) + rp(q.traded, 6) + rp(sg(q.alpha), 10) + rp('t ' + f(c.t), 10));
  }
  hr(64);
}

const STAGES = { repro: stageRepro, look: stageLook, dir: stageDir, split: stageSplit,
  overlap: stageOverlap, matched: stageMatched, state: stageState, shadow: stageShadow,
  grid: stageGrid, power: stagePower, when: stageWhen };

const want = process.argv[2] || 'repro';
if (want === 'all') { for (const k of Object.keys(STAGES)) { console.log(`\n${'='.repeat(80)}\n${k.toUpperCase()}\n${'='.repeat(80)}`); STAGES[k](); } }
else if (STAGES[want]) STAGES[want]();
else { console.log('stages: ' + Object.keys(STAGES).join(' ') + ' all'); }
