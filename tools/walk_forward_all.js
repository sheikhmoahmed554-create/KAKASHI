'use strict';
/*
 * Every level type, walked forward on its own.
 *
 * The earlier walk-forward let six families compete for three slots per fold,
 * which answers "what would a portfolio have done" and quietly buries whatever
 * lost the competition. Nothing here is discarded before it has had a fair
 * test, so each family gets its own walk-forward and its own out-of-sample
 * record — including the ones that looked hopeless in-sample, because
 * in-sample impressions are exactly what this whole exercise stopped trusting.
 *
 * Per family, per fold: search that family's own timeframes, readings and
 * targets on the months already seen, freeze the winner, trade the next month
 * blind. The record is those unseen months stitched together.
 *
 * The level lines are built over the whole series on purpose. They are causal —
 * a pivot needs its right-hand bars, a higher-timeframe level needs that candle
 * closed — so that is not leakage. What must respect the split is the CHOICE,
 * and the choice only ever sees training months.
 *
 * Usage: node tools/walk_forward_all.js
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
const lineOf = (m, fn) => { const r = project(m, fn); return Array.isArray(r) ? r : r.line; };

const raceCache = new Map();
function race(i, dir, tp, sl, hold) {
  const key = i * 64 + (dir === 1 ? 0 : 32) + (tp / 30) * 8 + (sl / 30) + hold / 1000;
  const ck = `${i}|${dir}|${tp}|${sl}|${hold}`;
  if (raceCache.has(ck)) return raceCache.get(ck);
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
  if (raceCache.size < 3e6) raceCache.set(ck, out);
  return out;
}
function rng(sd) {
  return () => { sd |= 0; sd = sd + 0x6D2B79F5 | 0; let t = Math.imul(sd ^ sd >>> 15, 1 | sd); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
/* Baselines are measured inside the window being scored. A falling March and a
   rising June are different markets, and one global baseline smuggles each
   into the other. */
const blindCache = new Map();
function blind(dir, tp, sl, hold, lo, hi) {
  const k = `${dir}|${tp}|${sl}|${hold}|${lo}|${hi}`;
  if (blindCache.has(k)) return blindCache.get(k);
  const r = rng(77 + dir * 13 + lo);
  let c = 0, net = 0;
  const top = Math.max(lo + 1, hi - hold - 1);
  for (let z = 0; z < 2500; z++) {
    const p = race(lo + Math.floor(r() * (top - lo)), dir, tp, sl, hold);
    if (p === null) continue;
    c++; net += p;
  }
  const v = c ? net / c : 0;
  blindCache.set(k, v);
  return v;
}

const READINGS = {
  bounce:  e => e.filter(x => x.kind === 'reject'),
  brk:     e => e.filter(x => x.kind === 'break'),
  fade:    e => e.filter(x => x.kind === 'reject').map(x => ({ ...x, dir: -x.dir })),
  brkFade: e => e.filter(x => x.kind === 'break').map(x => ({ ...x, dir: -x.dir })),
};
const RD = ['bounce', 'brk', 'fade', 'brkFade'];

const RT_OPTS = { left: 5, right: 5, minSpan: 6, maxSpan: 200, pierceAtr: 0.1, maxProject: 200, breakAtr: 0.4 };
const FIB_OPTS = { left: 5, right: 5, minLegAtr: 2.0, maxAge: 400, killBeyond: true };

/* Every family that was ever built, none dropped on a hunch. */
const FAMILIES = [
  ['ترند صاعد', [5, 15, 60], m => levelTestEvents(bars, project(m, (b, a) => RT.risingTrendline(b, a, RT_OPTS)).line ?? project(m, (b, a) => RT.risingTrendline(b, a, RT_OPTS)), atr1)],
  ['ترند هابط', [5, 15, 60], m => levelTestEvents(bars, lineOf(m, (b, a) => LV.trendLineLevels(b, { side: 'down', left: 10, right: 10, atr: a })), atr1)],
  ['فيبوناتشي', [15, 60, 240], m => {
    const { bars: hb, index, atr } = tf(m);
    const p = FIB.fibLines(hb, atr, FIB_OPTS);
    const ld = E.projectConfirmed(p.legDir, index);
    let ev = [];
    for (const r of [0.5, 0.618]) ev = ev.concat(FIB.tag(levelTestEvents(bars, E.projectConfirmed(p.lines[r], index), atr1), ld));
    ev.sort((a, b) => a.i - b.i);
    const seen = new Set();
    return ev.filter(e => (seen.has(e.i) ? false : (seen.add(e.i), true)));
  }],
  ['قمم حقيقية', [15, 60, 240], m => levelTestEvents(bars, lineOf(m, (b, a) => LV.swingLevels(b, { side: 'high', left: 10, right: 10, minTouches: 2, atr: a })), atr1)],
  ['قيعان حقيقية', [15, 60, 240], m => levelTestEvents(bars, lineOf(m, (b, a) => LV.swingLevels(b, { side: 'low', left: 10, right: 10, minTouches: 2, atr: a })), atr1)],
  ['فشل متكرر — قمة', [5, 15, 60], m => levelTestEvents(bars, lineOf(m, (b, a) => LV.failedRetestLevels(b, { side: 'high', left: 10, right: 10, atr: a })), atr1)],
  ['فشل متكرر — قاع', [5, 15, 60], m => levelTestEvents(bars, lineOf(m, (b, a) => LV.failedRetestLevels(b, { side: 'low', left: 10, right: 10, atr: a })), atr1)],
  ['امتصاص', [1], () => ABS.multiEvents(ABS.absorption(1, ABS.CHOSEN), {})],
  ['عقدة الحجم', [1], () => levelTestEvents(bars, LV.volumeNodeLevels(bars).line, atr1)],
  ['اليوم السابق', [1], () => levelTestEvents(bars, LV.previousDayLevels(bars).line, atr1)],
  ['افتتاح اليوم', [1], () => levelTestEvents(bars, LV.dailyOpenLevels(bars).line, atr1)],
  ['بيفوت كلاسيكي', [1], () => levelTestEvents(bars, LV.classicPivotLevels(bars).line, atr1)],
  ['نطاق آسيا', [1], () => levelTestEvents(bars, LV.sessionRangeLevels(bars, { startHour: 0, endHour: 7 }).line, atr1)],
  ['أرقام مستديرة', [1], () => levelTestEvents(bars, LV.roundNumberLevels(bars, { step: 10 }).line, atr1)],
  ['فجوات FVG', [1, 15, 60], m => levelTestEvents(bars, lineOf(m, (b, a) => LV.fvgLevels(b, { atr: a })), atr1)],
  ['بلوك أوامر', [1, 15, 60], m => levelTestEvents(bars, lineOf(m, (b, a) => LV.orderBlockLevels(b, { atr: a })), atr1)],
  ['انقلاب الدور', [1, 15, 60], m => levelTestEvents(bars, lineOf(m, (b, a) => LV.roleReversalLevels(b, { left: 10, right: 10, atr: a })), atr1)],
];

const TP_GRID = [60, 90, 120];
const SL_GRID = [60, 90, 120];
const HOLD_GRID = [240, 1440];
const MIN_TRAIN = 25;

const monthOf = i => new Date(bars[i].t).toISOString().slice(0, 7);
const monthStart = new Map();
for (let i = 0; i < N; i++) { const m = monthOf(i); if (!monthStart.has(m)) monthStart.set(m, i); }
const MONTHS = [...monthStart.keys()].sort();

function scoreWindow(events, tp, sl, hold, lo, hi) {
  let ln = 0, lnet = 0, sn = 0, snet = 0;
  for (const e of events) {
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

const f = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '—';

console.log(`${N.toLocaleString()} شمعة   ${MONTHS.length} أشهر   كلفة ${COST} نقطة\n`);
console.log('بناء المجاري…');
const BY_FAMILY = new Map();
for (const [name, tfs, build] of FAMILIES) {
  const streams = [];
  for (const m of tfs) {
    let ev = [];
    try { ev = build(m) || []; } catch (err) { continue; }
    if (ev.length < 40) continue;
    for (const rd of RD) {
      const list = READINGS[rd](ev).filter(x => Number.isFinite(x.i) && x.dir);
      if (list.length >= 40) streams.push({ tf: m, reading: rd, events: list });
    }
  }
  if (streams.length) BY_FAMILY.set(name, streams);
  process.stdout.write(`  ${name}: ${streams.length} مجرى            \r`);
}
console.log(' '.repeat(50) + `\r  ${BY_FAMILY.size} عائلة جاهزة\n`);

const results = [];
for (const [name, streams] of BY_FAMILY) {
  const oos = [];
  for (let k = 2; k < MONTHS.length; k++) {
    const testMonth = MONTHS[k];
    const trainHi = monthStart.get(testMonth);
    const testHi = k + 1 < MONTHS.length ? monthStart.get(MONTHS[k + 1]) : N;

    let best = null;
    for (const st of streams) {
      for (const tp of TP_GRID) for (const sl of SL_GRID) for (const hold of HOLD_GRID) {
        const s = scoreWindow(st.events, tp, sl, hold, 0, trainHi);
        if (s.n < MIN_TRAIN) continue;
        if (!best || s.alpha > best.alpha) best = { st, tp, sl, hold, alpha: s.alpha };
      }
    }
    if (!best) { oos.push({ month: testMonth, n: 0, net: 0 }); continue; }
    const out = scoreWindow(best.st.events, best.tp, best.sl, best.hold, trainHi, testHi);
    oos.push({ month: testMonth, n: out.n, net: out.net, pick: `${best.st.tf}m/${best.st.reading} ${best.tp}/${best.sl}/${best.hold}` });
  }
  const n = oos.reduce((a, x) => a + x.n, 0);
  const net = oos.reduce((a, x) => a + x.net, 0);
  const up = oos.filter(x => x.net > 0).length;
  results.push({ name, n, net, per: n ? net / n : 0, up, folds: oos.length, oos });
  process.stdout.write(`  … ${name}              \r`);
}
console.log(' '.repeat(50) + '\r');

results.sort((a, b) => b.per - a.per);
console.log('نتيجة كل عائلة خارج العيّنة — خمسة أشهر لم تُرَ قبل تداولها\n');
const cols = [
  { l: 'المستوى', g: r => r.name },
  { l: 'صفقات', g: r => r.n },
  { l: 'صافي', g: r => (r.net > 0 ? '+' : '') + f(r.net, 0) },
  { l: 'نقطة/صفقة', g: r => (r.per > 0 ? '+' : '') + f(r.per) },
  { l: 'أشهر رابحة', g: r => `${r.up}/${r.folds}` },
];
const w = cols.map(c => Math.max(c.l.length, ...results.map(r => String(c.g(r)).length)));
console.log(cols.map((c, i) => c.l.padStart(w[i])).join('  '));
console.log(w.map(x => '─'.repeat(x)).join('  '));
for (const r of results) console.log(cols.map((c, i) => String(c.g(r)).padStart(w[i])).join('  '));

console.log('\nالتفصيل الشهري لأفضل ثلاثة:\n');
for (const r of results.slice(0, 3)) {
  console.log(`  ${r.name}`);
  for (const o of r.oos) console.log(`    ${o.month}  ${String(o.n).padStart(4)} صفقة  ${((o.net > 0 ? '+' : '') + f(o.net, 0)).padStart(7)}   ${o.pick || '—'}`);
}
const alive = results.filter(r => r.net > 0 && r.n >= 50);
console.log(`\nعائلات موجبة خارج العيّنة بعينة ≥ 50 صفقة: ${alive.length} من ${results.length}`);
