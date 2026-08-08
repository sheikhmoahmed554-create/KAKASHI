'use strict';
/*
 * The three survivors, walked forward together.
 *
 * Each family picked its own configuration blind in tools/walk_forward_all.js,
 * but they were scored one at a time with unlimited concurrency. Trading them
 * together is a different question: they compete for slots, they pay costs
 * together, and fair value gaps fire roughly three times as often as either
 * trendline, so the mix decides the result and cannot be assumed.
 *
 * Same discipline as before. For each unseen month, every family re-runs its
 * own search over the months already closed, freezes, and then all three trade
 * that month through the shared engine — one position per source, its own
 * target, stop and time stop.
 *
 * Absorption is deliberately absent. It was shipped inside KAKASHI Levels V1
 * and is negative out of sample at -2.13 over 5,448 trades.
 *
 * Usage: node tools/portfolio_wf.js
 */
const E = require('./ai963_engine');
const { levelTestEvents } = require('./level_events');
const LV = require('./levels');
const RT = require('./fixes/rising-trendline.js');

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
function lineOf(m, build) {
  const { bars: b, index, atr } = tf(m);
  const raw = build(b, atr);
  const line = Array.isArray(raw) ? raw : raw.line;
  return m === 1 ? line : E.projectConfirmed(line, index);
}

const raceCache = new Map();
function race(i, dir, tp, sl, hold) {
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
const blindCache = new Map();
function blind(dir, tp, sl, hold, lo, hi) {
  const k = `${dir}|${tp}|${sl}|${hold}|${lo}|${hi}`;
  if (blindCache.has(k)) return blindCache.get(k);
  const r = rng(555 + dir * 11 + lo);
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

const FAMILIES = [
  { name: 'فجوات FVG', tfs: [1, 15, 60], build: m => levelTestEvents(bars, lineOf(m, (b, a) => LV.fvgLevels(b, { atr: a })), atr1) },
  { name: 'ترند هابط', tfs: [5, 15, 60], build: m => levelTestEvents(bars, lineOf(m, (b, a) => LV.trendLineLevels(b, { side: 'down', left: 10, right: 10, atr: a })), atr1) },
  { name: 'ترند صاعد', tfs: [5, 15, 60], build: m => levelTestEvents(bars, lineOf(m, (b, a) => RT.risingTrendline(b, a, RT_OPTS)), atr1) },
];

const TP_GRID = [60, 90, 120];
const SL_GRID = [60, 90, 120];
const HOLD_GRID = [240, 1440];
const MIN_TRAIN = 25;

console.log('بناء المجاري…');
const STREAMS = new Map();
for (const fam of FAMILIES) {
  const list = [];
  for (const m of fam.tfs) {
    let ev = [];
    try { ev = fam.build(m) || []; } catch (err) { continue; }
    if (ev.length < 40) continue;
    for (const rd of RD) {
      const s = READINGS[rd](ev).filter(x => Number.isFinite(x.i) && x.dir);
      if (s.length >= 40) list.push({ tf: m, reading: rd, events: s });
    }
  }
  STREAMS.set(fam.name, list);
  console.log(`  ${fam.name}: ${list.length} مجرى`);
}

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
  if (!n) return { n: 0, alpha: -1e9 };
  const bl = ln ? blind(1, tp, sl, hold, lo, hi) : 0;
  const bs = sn ? blind(-1, tp, sl, hold, lo, hi) : 0;
  return { n, alpha: ((lnet - bl * ln) + (snet - bs * sn)) / n };
}

const f = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '—';
const allTrades = [];

console.log('\nالاختبار الأمامي المشترك\n');
for (let k = 2; k < MONTHS.length; k++) {
  const testMonth = MONTHS[k];
  const trainHi = monthStart.get(testMonth);
  const testHi = k + 1 < MONTHS.length ? monthStart.get(MONTHS[k + 1]) : N;

  const sources = [];
  const picks = [];
  for (const fam of FAMILIES) {
    let best = null;
    for (const st of STREAMS.get(fam.name)) {
      for (const tp of TP_GRID) for (const sl of SL_GRID) for (const hold of HOLD_GRID) {
        const s = scoreWindow(st.events, tp, sl, hold, 0, trainHi);
        if (s.n < MIN_TRAIN) continue;
        if (!best || s.alpha > best.alpha) best = { st, tp, sl, hold, alpha: s.alpha };
      }
    }
    if (!best) continue;
    const buy = new Uint8Array(N), sell = new Uint8Array(N), rej = new Uint8Array(N);
    for (const e of best.st.events) {
      if (e.i < testHi && e.i >= 0) { if (e.dir === 1) buy[e.i] = 1; else sell[e.i] = 1; rej[e.i] = 1; }
    }
    sources.push({
      name: fam.name, tp: best.tp, sl: best.sl, maxHold: best.hold,
      respectOthers: false, cooldown: 0, buyCooldown: 0, sellCooldown: 0,
      buy, sell, rejection: rej,
    });
    picks.push(`${fam.name} → ${best.st.tf}m/${best.st.reading} ${best.tp}/${best.sl}/${best.hold}`);
  }

  const { trades } = E.runBacktest(bars, sources, { pointUnit: PU, sameCandleRule: 'Skip', costPoints: COST });
  const month = trades.filter(t => t.entryTime >= bars[trainHi].t && t.entryTime < (testHi < N ? bars[testHi].t : Infinity));
  allTrades.push(...month);
  const net = month.reduce((a, t) => a + t.points, 0);
  console.log(`${testMonth}  (اختير على ${MONTHS.slice(0, k).join(', ')})`);
  for (const p of picks) console.log(`   ${p}`);
  console.log(`   ${month.length} صفقة   صافي ${(net > 0 ? '+' : '') + f(net, 0)}\n`);
}

const s = E.summarize(allTrades);
const longs = allTrades.filter(t => t.side === 'BUY');
const shorts = allTrades.filter(t => t.side === 'SELL');
console.log('═'.repeat(66));
console.log('الحصيلة خارج العيّنة — خمسة أشهر، ولا شمعة منها استُخدمت في اختيار');
console.log(`  صفقات ${s.trades}   نسبة ${f(s.winRate)}%   صافي ${(s.netPoints > 0 ? '+' : '') + f(s.netPoints, 0)}   PF ${f(s.profitFactor, 3)}`);
console.log(`  لكل صفقة ${f(s.expectancy)}   أقصى تراجع ${f(s.maxDrawdownPoints, 0)}   أطول سلسلة خسارة ${s.maxLossStreak}`);
console.log(`  شراء ${longs.length} (${f(longs.reduce((a, t) => a + t.points, 0), 0)})   بيع ${shorts.length} (${f(shorts.reduce((a, t) => a + t.points, 0), 0)})`);

const by = new Map();
for (const t of allTrades) { if (!by.has(t.source)) by.set(t.source, []); by.get(t.source).push(t); }
console.log('\nلكل مصدر:');
for (const [k, v] of by) {
  const r = E.summarize(v);
  console.log(`  ${k.padEnd(14)} ${String(r.trades).padStart(4)} صفقة  ${f(r.winRate, 1).padStart(5)}%  ${((r.netPoints > 0 ? '+' : '') + f(r.netPoints, 0)).padStart(7)}  لكل صفقة ${f(r.expectancy)}`);
}

const SD = 110, OVERLAP = 2.2;
const t = s.expectancy / (SD / Math.sqrt(s.trades));
const te = s.expectancy / (SD / Math.sqrt(s.trades / OVERLAP));
console.log(`\n  t = ${f(t)}   بعد خصم التداخل ${f(te)}   ${Math.abs(te) >= 1.96 ? '★ دال' : 'غير دال'}`);
