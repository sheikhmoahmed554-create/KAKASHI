'use strict';
/*
 * Which timeframe suits which job?
 *
 * The previous sweep built every level on 1m candles, which is why "real swing
 * highs" were not real: a pivot with twenty bars either side of it is a
 * twenty-minute wiggle, not a top. A level that is supposed to represent
 * structure has to be measured on a timeframe where structure exists.
 *
 * So every level type is rebuilt on 1m, 5m, 15m, 1H, 4H and daily candles, and
 * then projected onto the 1m stream one higher-timeframe bar late — the signal
 * reaches the chart after that candle has closed, never during it. Tests are
 * still detected on 1m candles, so the results stay comparable to the random
 * control, which sits at 68.95%.
 *
 * Usage: node tools/sweep_timeframes.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('./ai963_engine');
const LV = require('./levels');
const { levelTestEvents, respectRate } = require('./level_events');

const PU = 0.10, COST = 0.5, TP = 90, SL = 90, MAX_HOLD = 1440;
const RANDOM_RESPECT = 68.95;   // tools/respect_control.js
const TIMEFRAMES = [1, 5, 15, 60, 240, 1440];
const TF_NAME = { 1: '1m', 5: '5m', 15: '15m', 60: '1H', 240: '4H', 1440: 'D' };

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

const bars = loadBars();
const atr1 = E.atr(bars, 14);
const N = bars.length;

function race(i, dir) {
  const e = bars[i].c, tp = e + dir * TP * PU, sl = e - dir * SL * PU;
  const end = Math.min(N - 1, i + MAX_HOLD);
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
function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function blind(dir, n, seed) {
  const r = rng(seed);
  let c = 0, net = 0;
  const lo = 100, hi = N - MAX_HOLD - 2;
  for (let k = 0; k < n; k++) { const p = race(lo + Math.floor(r() * (hi - lo)), dir); if (p === null) continue; c++; net += p; }
  return net / c;
}
const BL_LONG = blind(1, 40000, 31337), BL_SHORT = blind(-1, 40000, 73331);

// Cache the resampled candles and their ATR once per timeframe.
const TF = new Map();
for (const m of TIMEFRAMES) {
  const { bars: b, index } = E.resample(bars, m);
  TF.set(m, { bars: b, index, atr: E.atr(b, 14) });
}

/**
 * Build a level on `minutes` candles and expose it to the 1m stream only after
 * that candle has closed. At 1m there is nothing to wait for.
 */
function project(minutes, build) {
  const { bars: b, index, atr } = TF.get(minutes);
  const raw = build(b, atr);
  return minutes === 1 ? raw : E.projectConfirmed(raw, index);
}

function score(events) {
  const r = respectRate(events);
  let ln = 0, lnet = 0, sn = 0, snet = 0;
  for (const e of events) {
    const p = race(e.i, e.dir);
    if (p === null) continue;
    if (e.dir === 1) { ln++; lnet += p; } else { sn++; snet += p; }
  }
  const tot = ln + sn;
  const la = ln ? lnet / ln - BL_LONG : 0;
  const sa = sn ? snet / sn - BL_SHORT : 0;
  return {
    ...r,
    shortShare: tot ? (100 * sn) / tot : NaN,
    raw: tot ? (lnet + snet) / tot : NaN,
    alpha: tot ? (la * ln + sa * sn) / tot : NaN,
  };
}

const JOBS = [
  ['قمة حقيقية', (b, a) => LV.swingLevels(b, { side: 'high', left: 10, right: 10, minTouches: 2, atr: a }).line],
  ['قاع حقيقي', (b, a) => LV.swingLevels(b, { side: 'low', left: 10, right: 10, minTouches: 2, atr: a }).line],
  ['فشل متكرر — قمة', (b, a) => LV.failedRetestLevels(b, { side: 'high', left: 10, right: 10, atr: a }).line],
  ['فشل متكرر — قاع', (b, a) => LV.failedRetestLevels(b, { side: 'low', left: 10, right: 10, atr: a }).line],
  ['ترند هابط', (b, a) => LV.trendLineLevels(b, { side: 'down', left: 10, right: 10, atr: a }).line],
  ['ترند صاعد', (b, a) => LV.trendLineLevels(b, { side: 'up', left: 10, right: 10, atr: a }).line],
  ['فجوة FVG', (b, a) => LV.fvgLevels(b, { atr: a }).line],
  ['بلوك أوامر', (b, a) => LV.orderBlockLevels(b, { atr: a }).line],
  ['انقلاب الدور', (b, a) => LV.roleReversalLevels(b, { left: 10, right: 10, atr: a }).line],
  ['امتصاص', (b, a) => LV.absorptionLevels(b, { atr: a, look: 120 }).line],
];

const f = (x, d = 1) => Number.isFinite(x) ? x.toFixed(d) : '—';

function main() {
  console.log(`${N.toLocaleString()} شمعة   الاحترام العشوائي ${RANDOM_RESPECT}%   شراء أعمى ${f(BL_LONG, 2)}  بيع أعمى ${f(BL_SHORT, 2)}`);
  console.log('كل مستوى يُبنى على فريمه ثم يصل للدقيقة بعد إغلاق شمعة ذلك الفريم.\n');

  const results = [];
  for (const [job, build] of JOBS) {
    const row = { job, cells: {} };
    for (const m of TIMEFRAMES) {
      process.stdout.write(`  … ${job} على ${TF_NAME[m]}            \r`);
      let s;
      try { s = score(levelTestEvents(bars, project(m, build), atr1)); }
      catch (e) { s = { tests: 0 }; }
      row.cells[m] = s;
    }
    results.push(row);
  }
  console.log(' '.repeat(50) + '\r');

  const show = (title, pick, fmt) => {
    console.log(`\n${title}`);
    const head = 'المهمة'.padEnd(18) + TIMEFRAMES.map(m => TF_NAME[m].padStart(9)).join('');
    console.log(head);
    console.log('─'.repeat(head.length));
    for (const r of results) {
      const cells = TIMEFRAMES.map(m => {
        const s = r.cells[m];
        return (s && s.tests >= 40 ? fmt(pick(s)) : '—').padStart(9);
      }).join('');
      console.log(r.job.padEnd(18) + cells);
    }
  };

  show('الاحترام % (العشوائي 68.95 — الفرق هو ما يهم)', s => s.respect, v => f(v));
  show('عدد الاختبارات', s => s.tests, v => String(v));
  show('ألفا بعد فصل الاتجاه (نقطة/صفقة)', s => s.alpha, v => (v > 0 ? '+' : '') + f(v, 2));

  console.log('\n\nأفضل فريم لكل مهمة (بالاحترام، وبعينة ≥ 40 اختبارًا):\n');
  const best = [];
  for (const r of results) {
    let bm = null, bv = -Infinity;
    for (const m of TIMEFRAMES) {
      const s = r.cells[m];
      if (s && s.tests >= 40 && s.respect > bv) { bv = s.respect; bm = m; }
    }
    if (bm) best.push({ job: r.job, tf: TF_NAME[bm], respect: bv, edge: bv - RANDOM_RESPECT, s: r.cells[bm] });
  }
  best.sort((a, b) => b.edge - a.edge);
  for (const b of best) {
    console.log(`  ${b.job.padEnd(18)} ${b.tf.padStart(4)}   احترام ${f(b.respect)}%  (${b.edge > 0 ? '+' : ''}${f(b.edge)} عن العشوائي)   ${b.s.tests} اختبار   ألفا ${(b.s.alpha > 0 ? '+' : '') + f(b.s.alpha, 2)}`);
  }
}

main();
