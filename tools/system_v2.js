'use strict';
/*
 * The system, assembled from the verified level constructions.
 *
 * The level study judged each construction alone, with unlimited concurrency
 * and no competition. That is the right way to ask "is this level worth
 * anything" and a misleading way to ask "what would this have earned", because
 * two things get lost.
 *
 *   Overlap. Absorption alone produces 11,176 trades holding 3.7 positions at
 *   once. Nobody trades that. Collapsing to one position per source is what
 *   took previous-day from +50 to +31 in its own verifier's hands.
 *
 *   Competition. Sources on one chart take each other's slots and pay costs
 *   together, and a set of individually-positive sources can still add up to
 *   nothing — which is precisely what V12's eight KNN lines did.
 *
 * Each construction is reproduced here exactly as its agent specified it,
 * calling that agent's own generator rather than a reimplementation: those are
 * the functions the verify pass attacked, and rewriting them would mean
 * shipping something nobody checked. The configurations below are copied from
 * the BEST/CHOSEN objects in those files.
 *
 * Scored against the baseline: 7,687 trades, 52.02%, +837 points, 10,839 drawdown.
 *
 * Usage: node tools/system_v2.js
 */
const E = require('./ai963_engine');
const { levelTestEvents } = require('./level_events');

const RT = require('./fixes/rising-trendline.js');
const FIB = require('./fixes/fibonacci.js');
const ABS = require('./fixes/absorption.js');

const PU = 0.10;
const COST = 0.5;
const TRAIN_END = Date.parse('2026-05-01T00:00:00Z');

const bars = RT.loadBars();
const atr1 = E.atr(bars, 14);
const N = bars.length;

const tfCache = new Map();
function tf(minutes) {
  if (!tfCache.has(minutes)) {
    const { bars: b, index } = E.resample(bars, minutes);
    tfCache.set(minutes, { bars: b, index, atr: E.atr(b, 14) });
  }
  return tfCache.get(minutes);
}
/** Build on `minutes` candles, expose to 1m only after that candle closed. */
function project(minutes, build) {
  const { bars: b, index, atr } = tf(minutes);
  const raw = build(b, atr);
  if (minutes === 1) return raw;
  if (Array.isArray(raw)) return E.projectConfirmed(raw, index);
  const out = {};
  for (const k of Object.keys(raw)) {
    out[k] = Array.isArray(raw[k]) ? E.projectConfirmed(raw[k], index) : raw[k];
  }
  return out;
}

/* ── the three constructions, verbatim from their agents' final configs ────── */

// rising-trendline BEST: 15m, reading 'brkDown', 90/60, hold 240
const RT_OPTS = { left: 5, right: 5, minSpan: 6, maxSpan: 200, pierceAtr: 0.1, maxProject: 200, breakAtr: 0.4 };
function risingTrendlineEvents() {
  const { line } = project(15, (b, a) => RT.risingTrendline(b, a, RT_OPTS));
  const ev = levelTestEvents(bars, line, atr1);
  // 'brkDown' — the rising line giving way downwards. One direction only.
  return ev.filter(x => x.kind === 'break' && x.dir === -1);
}

// fibonacci BEST: 1H, ratios 0.5 and 0.618, reading 'hold', 60/100, hold 60
const FIB_OPTS = { left: 5, right: 5, minLegAtr: 2.0, maxAge: 400, killBeyond: true };
const FIB_RATIOS = [0.5, 0.618];
function fibonacciEvents() {
  const { bars: hb, index, atr } = tf(60);
  const p = FIB.fibLines(hb, atr, FIB_OPTS);
  const legDir1 = E.projectConfirmed(p.legDir, index);
  let ev = [];
  for (const r of FIB_RATIOS) {
    const line1 = E.projectConfirmed(p.lines[r], index);
    ev = ev.concat(FIB.tag(levelTestEvents(bars, line1, atr1), legDir1).map(e => ({ ...e, ratio: r })));
  }
  ev.sort((a, b) => a.i - b.i);
  const seen = new Set();
  ev = ev.filter(e => (seen.has(e.i) ? false : (seen.add(e.i), true)));
  return FIB.only(ev, 'hold');
}

// absorption CHOSEN: 1m, reading 'defence', 120/120, hold 1440
function absorptionEvents() {
  const levels = ABS.absorption(1, ABS.CHOSEN);
  return ABS.apply(ABS.multiEvents(levels, {}), 'defence');
}

const CONSTRUCTIONS = [
  { name: 'ترند صاعد 15m', confidence: 'medium', tp: 90, sl: 60, maxHold: 240, events: risingTrendlineEvents },
  { name: 'فيبوناتشي 1H', confidence: 'medium', tp: 60, sl: 100, maxHold: 60, events: fibonacciEvents },
  { name: 'امتصاص 1m', confidence: 'low', tp: 120, sl: 120, maxHold: 1440, events: absorptionEvents },
];

function toSource(c) {
  let events = [];
  try { events = c.events() || []; }
  catch (err) { console.log(`  ! ${c.name}: ${err.message}`); }
  const buy = new Uint8Array(N), sell = new Uint8Array(N), rej = new Uint8Array(N);
  let used = 0;
  for (const e of events) {
    const i = e.i, d = e.dir;
    if (!Number.isFinite(i) || !d) continue;
    if (d === 1) buy[i] = 1; else sell[i] = 1;
    rej[i] = 1;
    used++;
  }
  return {
    name: c.name, tp: c.tp, sl: c.sl, maxHold: c.maxHold,
    respectOthers: false, cooldown: 0, buyCooldown: 0, sellCooldown: 0,
    buy, sell, rejection: rej, eventCount: used, confidence: c.confidence,
  };
}

const f = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '—';

function report(title, trades) {
  const s = E.summarize(trades);
  console.log(`\n${title}`);
  if (!trades.length) { console.log('  لا صفقات'); return s; }
  const longs = trades.filter(t => t.side === 'BUY');
  const shorts = trades.filter(t => t.side === 'SELL');
  console.log(`  صفقات ${s.trades}   نسبة ${f(s.winRate)}%   صافي ${(s.netPoints > 0 ? '+' : '') + f(s.netPoints, 0)}   PF ${f(s.profitFactor, 3)}   لكل صفقة ${f(s.expectancy)}`);
  console.log(`  أقصى تراجع ${f(s.maxDrawdownPoints, 0)}   أطول سلسلة خسارة ${s.maxLossStreak}`);
  console.log(`  شراء ${longs.length} (${f(longs.reduce((a, t) => a + t.points, 0), 0)})   بيع ${shorts.length} (${f(shorts.reduce((a, t) => a + t.points, 0), 0)})`);
  return s;
}

function main() {
  console.log(`${N.toLocaleString()} شمعة   كلفة ${COST} نقطة/صفقة\n`);
  const sources = CONSTRUCTIONS.map(toSource);
  console.log('المصادر:');
  for (const s of sources) {
    console.log(`  ${s.name.padEnd(18)} أحداث ${String(s.eventCount).padStart(6)}   ${s.tp}/${s.sl}   حيازة ${s.maxHold}د   ثقة ${s.confidence}`);
  }
  const live = sources.filter(s => s.eventCount > 0);
  if (!live.length) { console.log('\nلا مصدر أنتج أحداثًا.'); return; }

  // Each source alone first — this is what the level study measured, and the
  // gap between it and the combined run is the cost of sharing a chart.
  console.log('\nكل مصدر وحده (خانة واحدة، صفقة بالمرة):');
  for (const s of live) {
    const { trades } = E.runBacktest(bars, [s], { pointUnit: PU, sameCandleRule: 'Skip', costPoints: COST });
    const r = E.summarize(trades);
    console.log(`  ${s.name.padEnd(18)} ${String(r.trades).padStart(5)} صفقة  ${f(r.winRate, 1).padStart(5)}%  ${((r.netPoints > 0 ? '+' : '') + f(r.netPoints, 0)).padStart(8)}  لكل صفقة ${f(r.expectancy).padStart(6)}  PF ${f(r.profitFactor, 2)}`);
  }

  const { trades } = E.runBacktest(bars, live, { pointUnit: PU, sameCandleRule: 'Skip', costPoints: COST });
  console.log('\n' + '═'.repeat(70));
  report('الثلاثة معًا — الفترة كاملة', trades);
  report('الضبط — يناير→أبريل', trades.filter(t => t.entryTime < TRAIN_END));
  report('التحقق — مايو→يوليو   ← الحكم', trades.filter(t => t.entryTime >= TRAIN_END));

  console.log('\nشهريًا:');
  const bm = new Map();
  for (const t of trades) { const k = new Date(t.entryTime).toISOString().slice(0, 7); if (!bm.has(k)) bm.set(k, []); bm.get(k).push(t); }
  let cum = 0;
  for (const k of [...bm.keys()].sort()) {
    const v = bm.get(k), net = v.reduce((a, t) => a + t.points, 0);
    cum += net;
    console.log(`  ${k}  ${String(v.length).padStart(4)} صفقة  ${f(100 * v.filter(t => t.points > 0).length / v.length, 1).padStart(5)}%  ${((net > 0 ? '+' : '') + f(net, 0)).padStart(7)}   تراكمي ${(cum > 0 ? '+' : '') + f(cum, 0)}`);
  }
  console.log('\nالأساس V12: 7,687 صفقة، 52.02%، +837 نقطة، تراجع 10,839');
}

main();
