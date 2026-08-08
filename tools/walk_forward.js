'use strict';
/*
 * Walk-forward validation. The only honest number in this repository.
 *
 * Everything reported before this was fitted with the whole period visible and
 * then split into "train" and "test" after the fact, which proves nothing: the
 * configuration already knew what was in the test half. That is not a holdout,
 * it is a rehearsal.
 *
 * Here the choice is made blind, every time:
 *
 *   fold 1   choose on Jan-Feb        →  trade March, unseen
 *   fold 2   choose on Jan-March      →  trade April, unseen
 *   fold 3   choose on Jan-April      →  trade May, unseen
 *   fold 4   choose on Jan-May        →  trade June, unseen
 *   fold 5   choose on Jan-June       →  trade July, unseen
 *
 * The out-of-sample record is those five test months stitched together. Nothing
 * in it was ever used to pick anything.
 *
 * One thing deliberately is computed over the whole series: the level lines
 * themselves. Those are causal — a pivot needs its right-hand bars, a
 * higher-timeframe level needs that candle closed — so building them once is
 * not leakage. What must respect the split is the CHOICE of timeframe, reading
 * and target, and that is made on training months only.
 *
 * Usage: node tools/walk_forward.js
 */
const E = require('./ai963_engine');
const { levelTestEvents } = require('./level_events');
const LV = require('./levels');
const RT = require('./fixes/rising-trendline.js');
const FIB = require('./fixes/fibonacci.js');
const ABS = require('./fixes/absorption.js');

const PU = 0.10;
const COST = 0.5;

const bars = RT.loadBars();
const atr1 = E.atr(bars, 14);
const N = bars.length;

const tfc = new Map();
function tf(m) {
  if (!tfc.has(m)) {
    const { bars: b, index } = E.resample(bars, m);
    tfc.set(m, { bars: b, index, atr: E.atr(b, 14) });
  }
  return tfc.get(m);
}
function project(m, build) {
  const { bars: b, index, atr } = tf(m);
  const raw = build(b, atr);
  if (m === 1) return raw;
  if (Array.isArray(raw)) return E.projectConfirmed(raw, index);
  const o = {};
  for (const k of Object.keys(raw)) o[k] = Array.isArray(raw[k]) ? E.projectConfirmed(raw[k], index) : raw[k];
  return o;
}

/* ── outcome of one signal, cached per (bar, dir, tp, sl, hold) ───────────── */
const raceCache = new Map();
function race(i, dir, tp, sl, hold) {
  const key = `${i}|${dir}|${tp}|${sl}|${hold}`;
  if (raceCache.has(key)) return raceCache.get(key);
  const e = bars[i].c, t = e + dir * tp * PU, s = e - dir * sl * PU;
  const end = Math.min(N - 1, i + hold);
  let out = (bars[end].c - e) * dir / PU - COST;
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    const ht = dir === 1 ? b.h >= t : b.l <= t;
    const hs = dir === 1 ? b.l <= s : b.h >= s;
    if (ht && hs) { out = null; break; }
    if (ht) { out = tp - COST; break; }
    if (hs) { out = -sl - COST; break; }
  }
  if (raceCache.size < 4e6) raceCache.set(key, out);
  return out;
}

function rng(sd) {
  return () => { sd |= 0; sd = sd + 0x6D2B79F5 | 0; let t = Math.imul(sd ^ sd >>> 15, 1 | sd); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
/* Blind baselines are measured inside the window being scored, never globally:
   a falling March and a rising June are different markets and a single
   whole-period baseline would smuggle one into the other. */
const blindCache = new Map();
function blind(dir, tp, sl, hold, lo, hi) {
  const key = `${dir}|${tp}|${sl}|${hold}|${lo}|${hi}`;
  if (blindCache.has(key)) return blindCache.get(key);
  const r = rng(1234 + dir * 7 + lo);
  let c = 0, net = 0;
  const top = Math.max(lo + 1, hi - hold - 1);
  for (let k = 0; k < 4000; k++) {
    const i = lo + Math.floor(r() * (top - lo));
    const p = race(i, dir, tp, sl, hold);
    if (p === null) continue;
    c++; net += p;
  }
  const v = c ? net / c : 0;
  blindCache.set(key, v);
  return v;
}

/* ── candidate event streams, built once, causally ───────────────────────── */
const READINGS = {
  bounce: e => e.filter(x => x.kind === 'reject'),
  brk: e => e.filter(x => x.kind === 'break'),
  brkDown: e => e.filter(x => x.kind === 'break' && x.dir === -1),
  brkUp: e => e.filter(x => x.kind === 'break' && x.dir === 1),
  fade: e => e.filter(x => x.kind === 'reject').map(x => ({ ...x, dir: -x.dir })),
};

const RT_OPTS = { left: 5, right: 5, minSpan: 6, maxSpan: 200, pierceAtr: 0.1, maxProject: 200, breakAtr: 0.4 };
const FIB_OPTS = { left: 5, right: 5, minLegAtr: 2.0, maxAge: 400, killBeyond: true };

function eventsRisingTrendline(m) {
  const { line } = project(m, (b, a) => RT.risingTrendline(b, a, RT_OPTS));
  return levelTestEvents(bars, line, atr1);
}
function eventsFalling(m) {
  const line = project(m, (b, a) => LV.trendLineLevels(b, { side: 'down', left: 10, right: 10, atr: a }).line);
  return levelTestEvents(bars, line, atr1);
}
function eventsFib(m) {
  const { bars: hb, index, atr } = tf(m);
  const p = FIB.fibLines(hb, atr, FIB_OPTS);
  const ld = E.projectConfirmed(p.legDir, index);
  let ev = [];
  for (const r of [0.5, 0.618]) {
    ev = ev.concat(FIB.tag(levelTestEvents(bars, E.projectConfirmed(p.lines[r], index), atr1), ld));
  }
  ev.sort((a, b) => a.i - b.i);
  const seen = new Set();
  return ev.filter(e => (seen.has(e.i) ? false : (seen.add(e.i), true)));
}
function eventsSwing(m, side) {
  const line = project(m, (b, a) => LV.swingLevels(b, { side, left: 10, right: 10, minTouches: 2, atr: a }).line);
  return levelTestEvents(bars, line, atr1);
}
function eventsAbsorption() {
  return ABS.multiEvents(ABS.absorption(1, ABS.CHOSEN), {});
}

const FAMILIES = [
  { name: 'ترند صاعد', tfs: [5, 15, 60], build: eventsRisingTrendline, readings: ['bounce', 'brk', 'brkDown', 'fade'] },
  { name: 'ترند هابط', tfs: [5, 15, 60], build: eventsFalling, readings: ['bounce', 'brk', 'brkUp', 'fade'] },
  { name: 'فيبوناتشي', tfs: [15, 60, 240], build: eventsFib, readings: ['bounce', 'brk', 'fade'] },
  { name: 'قمم', tfs: [15, 60], build: m => eventsSwing(m, 'high'), readings: ['bounce', 'brk', 'fade'] },
  { name: 'قيعان', tfs: [15, 60], build: m => eventsSwing(m, 'low'), readings: ['bounce', 'brk', 'fade'] },
  { name: 'امتصاص', tfs: [1], build: eventsAbsorption, readings: ['bounce', 'brk', 'fade'] },
];

const TP_GRID = [60, 90, 120];
const SL_GRID = [60, 90, 120];
const HOLD_GRID = [60, 240, 1440];

console.log('بناء مجاري الأحداث…');
const STREAMS = [];
for (const fam of FAMILIES) {
  for (const m of fam.tfs) {
    let ev = [];
    try { ev = fam.build(m) || []; } catch (err) { continue; }
    if (ev.length < 40) continue;
    for (const rd of fam.readings) {
      const list = READINGS[rd](ev).filter(x => Number.isFinite(x.i) && x.dir);
      if (list.length >= 40) STREAMS.push({ family: fam.name, tf: m, reading: rd, events: list });
    }
  }
}
console.log(`  ${STREAMS.length} مجرى\n`);

/* ── scoring a stream inside a window ────────────────────────────────────── */
function scoreWindow(stream, tp, sl, hold, lo, hi) {
  let ln = 0, lnet = 0, sn = 0, snet = 0;
  for (const e of stream.events) {
    if (e.i < lo || e.i >= hi) continue;
    const p = race(e.i, e.dir, tp, sl, hold);
    if (p === null) continue;
    if (e.dir === 1) { ln++; lnet += p; } else { sn++; snet += p; }
  }
  const n = ln + sn;
  if (!n) return { n: 0, alpha: -1e9, net: 0 };
  const bl = ln ? blind(1, tp, sl, hold, lo, hi) : 0;
  const bs = sn ? blind(-1, tp, sl, hold, lo, hi) : 0;
  return { n, net: lnet + snet, alpha: ((lnet - bl * ln) + (snet - bs * sn)) / n };
}

/* ── folds by month ──────────────────────────────────────────────────────── */
const monthOf = i => new Date(bars[i].t).toISOString().slice(0, 7);
const monthStart = new Map();
for (let i = 0; i < N; i++) { const m = monthOf(i); if (!monthStart.has(m)) monthStart.set(m, i); }
const MONTHS = [...monthStart.keys()].sort();

const MIN_TRADES = 25;      // a config chosen on fewer than this is noise
const PICK_PER_FOLD = 3;    // how many streams the fold is allowed to trade

const f = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '—';
const oos = [];

console.log('الاختبار الأمامي — كل شهر يُتداول بإعداد اختير قبل رؤيته\n');
for (let k = 2; k < MONTHS.length; k++) {
  const testMonth = MONTHS[k];
  const trainLo = 0;
  const trainHi = monthStart.get(testMonth);
  const testLo = trainHi;
  const testHi = k + 1 < MONTHS.length ? monthStart.get(MONTHS[k + 1]) : N;

  // choose, seeing only what came before
  const ranked = [];
  for (const st of STREAMS) {
    let best = null;
    for (const tp of TP_GRID) for (const sl of SL_GRID) for (const hold of HOLD_GRID) {
      const s = scoreWindow(st, tp, sl, hold, trainLo, trainHi);
      if (s.n < MIN_TRADES) continue;
      if (!best || s.alpha > best.alpha) best = { ...s, tp, sl, hold };
    }
    if (best) ranked.push({ st, ...best });
  }
  ranked.sort((a, b) => b.alpha - a.alpha);
  const picks = ranked.slice(0, PICK_PER_FOLD);

  // trade the unseen month with those frozen choices
  let netMonth = 0, nMonth = 0, alphaSum = 0;
  const detail = [];
  for (const p of picks) {
    const s = scoreWindow(p.st, p.tp, p.sl, p.hold, testLo, testHi);
    netMonth += s.net;
    nMonth += s.n;
    alphaSum += s.alpha * s.n;
    detail.push(`${p.st.family}/${p.st.tf}m/${p.st.reading} ${p.tp}/${p.sl}/${p.hold} → ${s.n} صفقة ${(s.net > 0 ? '+' : '') + f(s.net, 0)}`);
  }
  oos.push({ month: testMonth, n: nMonth, net: netMonth, alpha: nMonth ? alphaSum / nMonth : 0 });
  console.log(`${testMonth}  اختير على ${MONTHS.slice(0, k).join(',')}`);
  for (const d of detail) console.log(`   ${d}`);
  console.log(`   الشهر: ${nMonth} صفقة   صافي ${(netMonth > 0 ? '+' : '') + f(netMonth, 0)}   ألفا ${f(nMonth ? alphaSum / nMonth : 0)}\n`);
}

const totN = oos.reduce((a, x) => a + x.n, 0);
const totNet = oos.reduce((a, x) => a + x.net, 0);
const up = oos.filter(x => x.net > 0).length;
console.log('═'.repeat(64));
console.log('الحصيلة خارج العيّنة — لا شيء منها استُخدم في أي اختيار');
console.log(`  صفقات ${totN}   صافي ${(totNet > 0 ? '+' : '') + f(totNet, 0)} نقطة   لكل صفقة ${f(totN ? totNet / totN : 0)}`);
console.log(`  أشهر رابحة ${up} من ${oos.length}`);
let cum = 0;
for (const x of oos) { cum += x.net; console.log(`    ${x.month}  ${String(x.n).padStart(4)} صفقة  ${((x.net > 0 ? '+' : '') + f(x.net, 0)).padStart(7)}   تراكمي ${(cum > 0 ? '+' : '') + f(cum, 0)}`); }
console.log('\nللمقارنة، ما ادّعيته سابقًا بتقسيم شكلي: +12,883 نقطة على الفترة كاملة.');
