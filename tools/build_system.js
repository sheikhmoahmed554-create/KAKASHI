'use strict';
/*
 * Assemble a full system from level constructions and measure it properly.
 *
 * The level study answers "is this level worth anything" one level at a time,
 * in isolation, with no slots and no cooldowns. That is the right way to judge
 * a level and the wrong way to judge a system: eight sources sharing a chart
 * compete for slots, block each other, and pay costs together, and a set of
 * individually-positive sources can still add up to nothing.
 *
 * This takes a list of constructions — each with its own level type, its own
 * timeframe, and its own target and stop sized to the move that level actually
 * produces — and runs them through the same trade engine the V12 port uses, so
 * the result is comparable to the 7,687-trade baseline.
 *
 * Two things it insists on:
 *   - Every source is scored on May-Jul as well as the whole period. A system
 *     tuned on Jan-Apr and judged on Jan-Apr is a story, not a measurement.
 *   - The direction split is always reported. Gold fell across this sample, so
 *     a short-heavy system looks clever for reasons that have nothing to do
 *     with skill.
 *
 * Usage: node tools/build_system.js [--config path.json]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('./ai963_engine');
const LV = require('./levels');
const { levelTestEvents } = require('./level_events');

const PU = 0.10;
const COST = 0.5;
const TRAIN_END = Date.parse('2026-05-01T00:00:00Z');

function loadBars() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'KAKASHI_V16_TV_PARITY_AUDIT.html'), 'utf8');
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

/**
 * Turn one construction into the buy/sell streams the trade engine consumes.
 * `mode` decides whether a test of the level is traded as a bounce off it or a
 * break through it — the two are opposite trades on the same event, and which
 * one a level rewards is a measured fact, not an assumption.
 */
function sourceFromConstruction(bars, atr1, cfg) {
  const { bars: tfBars, index, atr: tfAtr } = cfg._tf;
  const raw = cfg.build(tfBars, tfAtr);
  const line = cfg.timeframe === 1 ? raw : E.projectConfirmed(raw, index);
  const events = levelTestEvents(bars, line, atr1, cfg.eventOpts || {});

  const n = bars.length;
  const buy = new Uint8Array(n);
  const sell = new Uint8Array(n);
  const rejection = new Uint8Array(n);
  for (const e of events) {
    const wanted = cfg.mode === 'break' ? 'break' : 'reject';
    if (e.kind !== wanted) continue;
    if (e.dir === 1) buy[e.i] = 1; else sell[e.i] = 1;
    rejection[e.i] = e.kind === 'reject' ? 1 : 0;
  }
  return {
    name: cfg.name,
    tp: cfg.tp, sl: cfg.sl,
    respectOthers: cfg.respectOthers ?? false,
    cooldown: cfg.cooldown ?? 0,
    buyCooldown: 0, sellCooldown: 0,
    buy, sell, rejection,
    eventCount: events.length,
  };
}

function summarize(trades) {
  const s = E.summarize(trades);
  const longs = trades.filter(t => t.side === 'BUY');
  const shorts = trades.filter(t => t.side === 'SELL');
  return {
    ...s,
    longs: longs.length,
    shorts: shorts.length,
    shortShare: trades.length ? (100 * shorts.length) / trades.length : NaN,
    longNet: longs.reduce((a, t) => a + t.points, 0),
    shortNet: shorts.reduce((a, t) => a + t.points, 0),
  };
}

const f = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '—';

function report(title, trades) {
  const s = summarize(trades);
  console.log(`\n${title}`);
  console.log(`  صفقات ${s.trades}   نسبة ${f(s.winRate)}%   صافي ${(s.netPoints > 0 ? '+' : '') + f(s.netPoints, 0)}   PF ${f(s.profitFactor, 3)}   لكل صفقة ${f(s.expectancy)}`);
  console.log(`  أقصى تراجع ${f(s.maxDrawdownPoints, 0)}   أطول سلسلة خسارة ${s.maxLossStreak}`);
  console.log(`  شراء ${s.longs} (${(s.longNet > 0 ? '+' : '') + f(s.longNet, 0)})   بيع ${s.shorts} (${(s.shortNet > 0 ? '+' : '') + f(s.shortNet, 0)})   حصة البيع ${f(s.shortShare, 0)}%`);
  return s;
}

function run(constructions, opts = {}) {
  const bars = loadBars();
  const atr1 = E.atr(bars, 14);

  const tfCache = new Map();
  for (const c of constructions) {
    if (!tfCache.has(c.timeframe)) {
      const { bars: b, index } = E.resample(bars, c.timeframe);
      tfCache.set(c.timeframe, { bars: b, index, atr: E.atr(b, 14) });
    }
    c._tf = tfCache.get(c.timeframe);
  }

  const sources = constructions.map(c => sourceFromConstruction(bars, atr1, c));
  console.log('المصادر:\n');
  for (const s of sources) {
    console.log(`  ${s.name.padEnd(26)} أحداث ${String(s.eventCount).padStart(6)}   هدف/وقف ${s.tp}/${s.sl}   ${s.respectOthers ? 'يحترم الآخرين' : 'مستقل'}`);
  }

  const { trades } = E.runBacktest(bars, sources, {
    pointUnit: PU, sameCandleRule: 'Skip', costPoints: COST,
  });

  console.log('\n' + '═'.repeat(72));
  report('الفترة كاملة', trades);
  report('الضبط — يناير→أبريل', trades.filter(t => t.entryTime < TRAIN_END));
  report('التحقق — مايو→يوليو  ← هذا هو الحكم', trades.filter(t => t.entryTime >= TRAIN_END));

  console.log('\nلكل مصدر:');
  const byName = new Map();
  for (const t of trades) {
    if (!byName.has(t.source)) byName.set(t.source, []);
    byName.get(t.source).push(t);
  }
  const rows = [...byName.entries()].map(([k, v]) => ({ k, ...summarize(v) })).sort((a, b) => b.netPoints - a.netPoints);
  for (const r of rows) {
    console.log(`  ${r.k.padEnd(26)} ${String(r.trades).padStart(5)} صفقة  ${f(r.winRate, 1).padStart(5)}%  ${((r.netPoints > 0 ? '+' : '') + f(r.netPoints, 0)).padStart(7)}  PF ${f(r.profitFactor, 2)}`);
  }

  console.log('\nشهريًا:');
  const byMonth = new Map();
  for (const t of trades) {
    const k = new Date(t.entryTime).toISOString().slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(t);
  }
  let cum = 0;
  for (const k of [...byMonth.keys()].sort()) {
    const v = byMonth.get(k);
    const net = v.reduce((a, t) => a + t.points, 0);
    cum += net;
    const wr = (100 * v.filter(t => t.points > 0).length) / v.length;
    console.log(`  ${k}  ${String(v.length).padStart(5)} صفقة  ${f(wr, 1).padStart(5)}%  ${((net > 0 ? '+' : '') + f(net, 0)).padStart(7)}   تراكمي ${(cum > 0 ? '+' : '') + f(cum, 0)}`);
  }

  console.log('\nللمقارنة — الأساس V12: 7,687 صفقة، 52.02%، +837 نقطة، تراجع 10,839');
  return { trades, sources };
}

module.exports = { run, loadBars, sourceFromConstruction, summarize };

if (require.main === module) {
  const i = process.argv.indexOf('--config');
  if (i < 0) {
    console.log('لا يوجد ملف إعدادات. هذه الأداة تُستدعى بعد اكتمال دراسة المستويات.');
    console.log('الاستخدام: node tools/build_system.js --config tools/fixes/system.json');
    process.exit(0);
  }
  const raw = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
  const constructions = raw.map(c => ({
    ...c,
    build: new Function('LV', 'bars', 'atr', `return (${c.buildSrc})(LV, bars, atr)`).bind(null, LV),
  }));
  run(constructions);
}
