'use strict';
/*
 * WHERE do the trades actually land?
 *
 * The portfolio numbers say the frozen configuration made money out of sample.
 * That is a statement about the sum of 776 rows. It says nothing about whether
 * any individual entry looks like something a person would take, and the chart
 * is where that shows: an entry in the middle of a range, an entry three
 * candles into a vertical move, an entry against a level that stopped existing
 * an hour ago. A positive expectancy assembled out of entries like that is a
 * warning, not a result — it means the edge is coming from somewhere other
 * than the story the indicator tells, and it will not survive contact with a
 * different sample.
 *
 * So: reproduce V2's frozen configuration exactly as it ships, then describe
 * every entry it takes with the measurements that would show a bad location.
 *
 *   levelGap      how far the entry price sat from the level that fired it
 *   levelAge      how long that level had existed when it fired
 *   projected     how far the line was extrapolated past its second anchor
 *   rangePos      where the entry sat inside the last 240 minutes of range
 *   momentum      the move over the previous 15 minutes, in ATR
 *   htfSlope      60-minute direction at the moment of entry
 *   atrPct        volatility percentile of the moment
 *   hour          UTC hour
 *   sincePrev     minutes since this source last entered — clustering
 *   mfe / mae     how far it ran for and against, in points
 *
 * Nothing here is a filter yet. This file only describes; anything it suggests
 * has to be chosen on closed months and tested on unseen ones before it counts.
 *
 * Usage: node tools/entry_placement.js [--csv out.csv]
 */
const fs = require('fs');
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

const RT_OPTS = { left: 5, right: 5, minSpan: 6, maxSpan: 200, pierceAtr: 0.1, maxProject: 200, breakAtr: 0.4 };

// ── the three sources exactly as KAKASHI_LEVELS_V2.pine ships them ───────────
const dnLine = lineOf(15, (b, a) => LV.trendLineLevels(b, { side: 'down', left: 10, right: 10, atr: a }));
const upLine = lineOf(15, (b, a) => RT.risingTrendline(b, a, RT_OPTS));
const fvLine = lineOf(60, (b, a) => LV.fvgLevels(b, { atr: a }));

const dnEv = levelTestEvents(bars, dnLine, atr1).filter(e => e.kind === 'reject');
const upEv = levelTestEvents(bars, upLine, atr1).filter(e => e.kind === 'break');
const fvEv = levelTestEvents(bars, fvLine, atr1)
  .filter(e => e.kind === 'break')
  .map(e => ({ ...e, dir: -e.dir }));

const SPECS = [
  { name: 'ترند هابط', key: 'DN', line: dnLine, events: dnEv, tp: 120, sl: 120, maxHold: 1440 },
  { name: 'فجوة',     key: 'FV', line: fvLine, events: fvEv, tp: 120, sl: 60,  maxHold: 1440 },
  { name: 'ترند صاعد', key: 'UP', line: upLine, events: upEv, tp: 90,  sl: 60,  maxHold: 1440 },
];

const evAt = new Map();       // "KEY|i" -> event, so a trade can find its trigger
const sources = SPECS.map(sp => {
  const buy = new Uint8Array(N), sell = new Uint8Array(N), rej = new Uint8Array(N);
  for (const e of sp.events) {
    if (!Number.isFinite(e.i) || !e.dir) continue;
    if (e.dir === 1) buy[e.i] = 1; else sell[e.i] = 1;
    rej[e.i] = 1;
    evAt.set(`${sp.key}|${e.i}`, e);
  }
  return {
    name: sp.name, tp: sp.tp, sl: sp.sl, maxHold: sp.maxHold,
    respectOthers: false, cooldown: 0, buyCooldown: 0, sellCooldown: 0,
    buy, sell, rejection: rej,
  };
});
const keyOf = new Map(SPECS.map(s => [s.name, s.key]));

const { trades } = E.runBacktest(bars, sources, { pointUnit: PU, sameCandleRule: 'Skip', costPoints: COST });

// ── context measurements ─────────────────────────────────────────────────────
const atrSorted = atr1.filter(Number.isFinite).slice().sort((a, b) => a - b);
function atrPct(v) {
  if (!Number.isFinite(v) || !atrSorted.length) return NaN;
  let lo = 0, hi = atrSorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (atrSorted[m] < v) lo = m + 1; else hi = m; }
  return (100 * lo) / atrSorted.length;
}

// How far the line was extrapolated past the anchor that defined it: count back
// while the level keeps moving on the same straight slope.
function projectedBars(line, i) {
  if (!Number.isFinite(line[i]) || !Number.isFinite(line[i - 1])) return 0;
  const step = line[i] - line[i - 1];
  let k = i - 1;
  while (k > 1 && Number.isFinite(line[k - 1])
         && Math.abs((line[k] - line[k - 1]) - step) < 1e-9) k--;
  return i - k;
}
function levelAge(line, i) {
  let k = i;
  while (k > 0 && Number.isFinite(line[k - 1])) k--;
  return i - k;
}

const lastEntryOf = new Map();
const rows = [];
for (const t of trades) {
  const i = t.entryBar;
  const key = keyOf.get(t.source);
  const spec = SPECS.find(s => s.key === key);
  const a = atr1[i];
  const ev = evAt.get(`${key}|${i}`);
  const lvl = ev ? ev.level : spec.line[i];

  // range position over the previous 240 candles
  let hi = -Infinity, lo = Infinity;
  for (let j = Math.max(0, i - 240); j <= i; j++) { if (bars[j].h > hi) hi = bars[j].h; if (bars[j].l < lo) lo = bars[j].l; }
  const rangePos = hi > lo ? (bars[i].c - lo) / (hi - lo) : 0.5;

  const mom15 = i >= 15 ? (bars[i].c - bars[i - 15].c) / a : NaN;
  const htf = i >= 60 ? (bars[i].c - bars[i - 60].c) / a : NaN;

  // excursion over the life of the trade
  let mfe = 0, mae = 0;
  const dir = t.side === 'BUY' ? 1 : -1;
  for (let j = i + 1; j <= t.exitBar; j++) {
    const up = (bars[j].h - t.entryPrice) * dir / PU;
    const dn = (bars[j].l - t.entryPrice) * dir / PU;
    mfe = Math.max(mfe, dir === 1 ? up : -dn * -1);
    const adv = dir === 1 ? (bars[j].h - t.entryPrice) / PU : (t.entryPrice - bars[j].l) / PU;
    const opp = dir === 1 ? (t.entryPrice - bars[j].l) / PU : (bars[j].h - t.entryPrice) / PU;
    mfe = Math.max(mfe, adv);
    mae = Math.max(mae, opp);
  }

  const prev = lastEntryOf.get(key);
  lastEntryOf.set(key, i);

  rows.push({
    src: key,
    source: t.source,
    side: t.side,
    time: new Date(t.entryTime).toISOString().slice(0, 16).replace('T', ' '),
    month: new Date(t.entryTime).toISOString().slice(0, 7),
    hour: new Date(t.entryTime).getUTCHours(),
    entry: t.entryPrice,
    level: lvl,
    levelGapAtr: Number.isFinite(lvl) ? Math.abs(t.entryPrice - lvl) / a : NaN,
    levelAge: levelAge(spec.line, i),
    projected: projectedBars(spec.line, i),
    rangePos,
    mom15,
    htf,
    atrPct: atrPct(a),
    sincePrev: prev === undefined ? NaN : i - prev,
    mfe, mae,
    barsHeld: t.barsHeld,
    reason: t.reason,
    points: t.points,
  });
}

// ── reporting ────────────────────────────────────────────────────────────────
const f = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '—';
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const med = a => { const b = a.filter(Number.isFinite).slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };

const s = E.summarize(trades);
console.log('KAKASHI Levels V2 — الإعداد المجمّد، كامل العيّنة');
console.log(`  ${s.trades} صفقة   ${f(s.winRate)}%   صافي ${(s.netPoints > 0 ? '+' : '') + f(s.netPoints, 0)}   PF ${f(s.profitFactor, 3)}\n`);

function bucketReport(title, rows, keyFn, edges) {
  console.log(title);
  const buckets = new Map();
  for (const r of rows) {
    const v = keyFn(r);
    if (!Number.isFinite(v)) continue;
    let b = edges.length;
    for (let k = 0; k < edges.length; k++) if (v < edges[k]) { b = k; break; }
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(r);
  }
  const labels = [];
  for (let k = 0; k <= edges.length; k++) {
    labels.push(k === 0 ? `< ${edges[0]}` : k === edges.length ? `≥ ${edges[edges.length - 1]}` : `${edges[k - 1]} … ${edges[k]}`);
  }
  for (let k = 0; k <= edges.length; k++) {
    const v = buckets.get(k) || [];
    if (!v.length) continue;
    const net = v.reduce((a, r) => a + r.points, 0);
    const wr = 100 * v.filter(r => r.points > 0).length / v.length;
    console.log(`   ${labels[k].padStart(12)}  ${String(v.length).padStart(4)} صفقة  ${f(wr, 1).padStart(5)}%  لكل صفقة ${f(net / v.length).padStart(7)}`);
  }
  console.log('');
}

for (const sp of SPECS) {
  const v = rows.filter(r => r.src === sp.key);
  if (!v.length) continue;
  const net = v.reduce((a, r) => a + r.points, 0);
  console.log(`── ${sp.name} — ${v.length} صفقة، لكل صفقة ${f(net / v.length)}`);
  console.log(`   بُعد الدخول عن المستوى: وسيط ${f(med(v.map(r => r.levelGapAtr)))} ATR   أقصى ${f(Math.max(...v.map(r => r.levelGapAtr).filter(Number.isFinite)))} ATR`);
  console.log(`   عمر المستوى: وسيط ${f(med(v.map(r => r.levelAge)), 0)} شمعة   امتداد بعد المرتكز: وسيط ${f(med(v.map(r => r.projected)), 0)} شمعة`);
  console.log(`   موقع الدخول داخل مدى 4 ساعات: وسيط ${f(med(v.map(r => r.rangePos)))}`);
  console.log(`   زخم آخر 15 دقيقة: وسيط ${f(med(v.map(r => r.mom15)))} ATR   اتجاه الساعة: وسيط ${f(med(v.map(r => r.htf)))} ATR`);
  console.log(`   الفاصل عن الصفقة السابقة لنفس المصدر: وسيط ${f(med(v.map(r => r.sincePrev)), 0)} دقيقة   أقل ${Math.min(...v.map(r => r.sincePrev).filter(Number.isFinite))}`);
  console.log(`   MFE وسيط ${f(med(v.map(r => r.mfe)), 0)}   MAE وسيط ${f(med(v.map(r => r.mae)), 0)}\n`);
}

bucketReport('حسب موقع الدخول داخل المدى (0 = القاع، 1 = القمة)', rows, r => r.rangePos, [0.2, 0.4, 0.6, 0.8]);
bucketReport('حسب امتداد الخط بعد مرتكزه (شمعة)', rows, r => r.projected, [20, 50, 100, 200]);
bucketReport('حسب زخم آخر 15 دقيقة (ATR، بإشارة اتجاه الصفقة)', rows, r => (r.side === 'BUY' ? 1 : -1) * r.mom15, [-1, -0.4, 0, 0.4, 1]);
bucketReport('حسب اتجاه الساعة (ATR، بإشارة اتجاه الصفقة)', rows, r => (r.side === 'BUY' ? 1 : -1) * r.htf, [-2, -0.8, 0, 0.8, 2]);
bucketReport('حسب دقائق منذ صفقة المصدر السابقة', rows, r => r.sincePrev, [30, 120, 480, 1440]);
bucketReport('حسب مئين التذبذب', rows, r => r.atrPct, [20, 40, 60, 80]);
bucketReport('حسب ساعة UTC', rows, r => r.hour, [4, 8, 12, 16, 20]);

const csvArg = process.argv.indexOf('--csv');
if (csvArg > -1 && process.argv[csvArg + 1]) {
  const cols = Object.keys(rows[0]);
  fs.writeFileSync(process.argv[csvArg + 1],
    cols.join(',') + '\n' + rows.map(r => cols.map(c => r[c]).join(',')).join('\n'));
  console.log(`كُتب ${rows.length} صفًا إلى ${process.argv[csvArg + 1]}`);
}

module.exports = { rows, trades, SPECS, bars, atr1 };
