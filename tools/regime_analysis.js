'use strict';
/*
 * Does the indicator's edge depend on the market's state?
 *
 * Six months of trades sit at breakeven overall while a two-week stretch runs
 * at 66% — so the average hides two different markets. This tags every trade
 * with the conditions at its entry candle and asks which conditions separate
 * the winning stretches from the bleeding ones.
 *
 * Conditions measured at entry:
 *   ATR      volatility in points
 *   ATRpct   the same, relative to its own recent history, so February's
 *            "normal" and July's "normal" are comparable
 *   ADX      trend strength, direction-blind
 *   ER       Kaufman efficiency: net travel over total travel
 *   EXPAND   short ATR over long ATR: is volatility rising or falling
 *
 * Any filter found here is then re-tested on months it was not derived from,
 * because a rule tuned on the same data it is judged by will always look good.
 *
 * Usage: node tools/regime_analysis.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('./ai963_engine');

const POINT_UNIT = 0.10;
const COST = 0.5;
const VAULT = path.join(__dirname, '..', 'KAKASHI_V16_TV_PARITY_AUDIT.html');
const TRAIN_END = Date.parse('2026-05-01T00:00:00Z');   // Jan-Apr derives, May-Jul judges
const WINDOW_END = Date.parse('2026-07-18T00:00:00Z');

const PRESET = [
  { name: 'CHART 1m', tf: 1, priceValue: 'hma', priceLen: 5, targetValue: 'Price Action', targetLen: 5, closest: 3, smoothing: 51, lineType: 'RMA (original)', signalLine: 'Average KNN', touchPts: 3, wickPts: 20, bufferPts: 4.5, useAtr: false, bodySameSide: true, tp: 90, sl: 90, respectOthers: false, cooldown: 7, buyCooldown: 0, sellCooldown: 0 },
  { name: '2m', tf: 2, priceValue: 'hma', priceLen: 7, targetValue: 'Price Action', targetLen: 5, closest: 3, smoothing: 40, lineType: 'RMA (original)', signalLine: 'Average KNN', touchPts: 0, wickPts: 2, bufferPts: 7, useAtr: false, bodySameSide: true, tp: 70, sl: 100, respectOthers: false, cooldown: 0, buyCooldown: 0, sellCooldown: 0 },
  { name: '3m', tf: 3, priceValue: 'hma', priceLen: 5, targetValue: 'Price Action', targetLen: 5, closest: 3, smoothing: 28, lineType: 'RMA (original)', signalLine: 'Average KNN', touchPts: 0, wickPts: 4, bufferPts: 2, useAtr: false, bodySameSide: true, tp: 105, sl: 90, respectOthers: false, cooldown: 21, buyCooldown: 0, sellCooldown: 0 },
  { name: '5m', tf: 5, priceValue: 'hma', priceLen: 5, targetValue: 'Price Action', targetLen: 5, closest: 3, smoothing: 28, lineType: 'RMA (original)', signalLine: 'Average KNN', touchPts: 0, wickPts: 0, bufferPts: 0, useAtr: false, bodySameSide: true, tp: 90, sl: 90, respectOthers: true, cooldown: 0, buyCooldown: 0, sellCooldown: 0 },
  { name: '10m', tf: 10, priceValue: 'hma', priceLen: 4, targetValue: 'Price Action', targetLen: 4, closest: 3, smoothing: 22, lineType: 'RMA (original)', signalLine: 'Average KNN', touchPts: 0, wickPts: 0, bufferPts: 0, useAtr: false, bodySameSide: true, tp: 90, sl: 90, respectOthers: true, cooldown: 0, buyCooldown: 0, sellCooldown: 0 },
  { name: '15m', tf: 15, priceValue: 'hma', priceLen: 4, targetValue: 'Price Action', targetLen: 4, closest: 3, smoothing: 19, lineType: 'RMA (original)', signalLine: 'Average KNN', touchPts: 0, wickPts: 0, bufferPts: 0, useAtr: false, bodySameSide: true, tp: 90, sl: 90, respectOthers: true, cooldown: 0, buyCooldown: 0, sellCooldown: 0 },
  { name: '30m', tf: 30, priceValue: 'hma', priceLen: 3, targetValue: 'Price Action', targetLen: 3, closest: 3, smoothing: 15, lineType: 'RMA (original)', signalLine: 'Average KNN', touchPts: 0, wickPts: 0, bufferPts: 0, useAtr: false, bodySameSide: true, tp: 90, sl: 90, respectOthers: true, cooldown: 400, buyCooldown: 0, sellCooldown: 0 },
  { name: '1H', tf: 60, priceValue: 'hma', priceLen: 3, targetValue: 'Price Action', targetLen: 3, closest: 3, smoothing: 12, lineType: 'RMA (original)', signalLine: 'Average KNN', touchPts: 1, wickPts: 20, bufferPts: 0, useAtr: false, bodySameSide: true, tp: 150, sl: 130, respectOthers: true, cooldown: 80, buyCooldown: 0, sellCooldown: 0 },
];

function loadBars() {
  const html = fs.readFileSync(VAULT, 'utf8');
  const csv = zlib.gunzipSync(Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1], 'base64')).toString('utf8');
  const lines = csv.split('\n');
  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const a = lines[i].split(',');
    const t = Date.parse(a[0].replace(' ', 'T'));
    const c = +a[4];
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
    bars.push({ t, o: +a[1], h: +a[2], l: +a[3], c });
  }
  return bars.sort((x, y) => x.t - y.t);
}

/** Rank each value against the previous `look` bars, expressed 0-100. */
function rollingPercentile(src, look, step = 60) {
  const out = new Array(src.length).fill(NaN);
  let ref = [];
  for (let i = 0; i < src.length; i++) {
    if (i % step === 0 && i >= look) {
      ref = src.slice(i - look, i).filter(Number.isFinite).sort((a, b) => a - b);
    }
    if (!ref.length || !Number.isFinite(src[i])) continue;
    let lo = 0, hi = ref.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ref[m] < src[i]) lo = m + 1; else hi = m; }
    out[i] = (100 * lo) / ref.length;
  }
  return out;
}

function buildSources(bars, atr14) {
  return PRESET.map(p => {
    const { bars: tf, index } = E.resample(bars, p.tf);
    const raw = E.knnLine(tf, p);
    const line = p.tf === 1 ? raw : E.projectConfirmed(raw, index);
    const s = E.signalSet(bars, line, atr14, p, POINT_UNIT);
    const n = bars.length;
    const buy = new Uint8Array(n), sell = new Uint8Array(n), rej = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const bR = s.buyRej[i], bB = s.buyBrk[i], sR = s.sellRej[i], sB = s.sellBrk[i];
      buy[i] = (bR || bB) ? 1 : 0;
      sell[i] = (sR || sB) ? 1 : 0;
      rej[i] = (bR || sR) ? 1 : 0;
    }
    return { ...p, buy, sell, rejection: rej };
  });
}

const f = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '—';
function render(rows, cols) {
  const w = cols.map(c => Math.max(c.label.length, ...rows.map(r => String(c.get(r)).length)));
  const line = cells => cells.map((c, i) => String(c).padStart(w[i])).join('  ');
  console.log(line(cols.map(c => c.label)));
  console.log(w.map(x => '─'.repeat(x)).join('  '));
  for (const r of rows) console.log(line(cols.map(c => c.get(r))));
}

function stats(list) {
  if (!list.length) return { n: 0, wr: 0, net: 0, exp: 0 };
  const wins = list.filter(t => t.points > 0).length;
  const net = list.reduce((a, t) => a + t.points, 0);
  return { n: list.length, wr: (100 * wins) / list.length, net, exp: net / list.length };
}

/** Split trades into five equal-count buckets by a tagged feature. */
function quintiles(trades, key) {
  const ok = trades.filter(t => Number.isFinite(t[key])).sort((a, b) => a[key] - b[key]);
  const size = Math.floor(ok.length / 5);
  const out = [];
  for (let q = 0; q < 5; q++) {
    const slice = ok.slice(q * size, q === 4 ? ok.length : (q + 1) * size);
    out.push({
      q: `Q${q + 1}`,
      lo: slice.length ? slice[0][key] : NaN,
      hi: slice.length ? slice[slice.length - 1][key] : NaN,
      ...stats(slice),
    });
  }
  return out;
}

function main() {
  const bars = loadBars();
  const atr14 = E.atr(bars, 14);
  const atrSlow = E.atr(bars, 240);
  const { adx } = E.dmi(bars, 14, 14);
  const er = E.efficiencyRatio(bars.map(b => b.c), 60);
  const atrPct = rollingPercentile(atr14, 5000);

  const sources = buildSources(bars, atr14);
  const { trades: raw } = E.runBacktest(bars, sources, {
    pointUnit: POINT_UNIT, sameCandleRule: 'Skip', costPoints: COST,
  });

  const trades = raw.filter(t => t.exitTime < WINDOW_END).map(t => {
    const i = t.entryBar;
    return {
      ...t,
      ATR: atr14[i] / POINT_UNIT,
      ATRpct: atrPct[i],
      ADX: adx[i],
      ER: er[i],
      EXPAND: Number.isFinite(atrSlow[i]) && atrSlow[i] > 0 ? atr14[i] / atrSlow[i] : NaN,
    };
  });

  const base = stats(trades);
  console.log(`الأساس: ${base.n} صفقة   نسبة ${f(base.wr)}%   صافي ${f(base.net, 0)}   لكل صفقة ${f(base.exp)}\n`);

  const COLS = [
    { label: 'الشريحة', get: r => r.q },
    { label: 'من', get: r => f(r.lo, 2) },
    { label: 'إلى', get: r => f(r.hi, 2) },
    { label: 'صفقات', get: r => r.n },
    { label: 'نسبة%', get: r => f(r.wr, 1) },
    { label: 'صافي', get: r => (r.net > 0 ? '+' : '') + f(r.net, 0) },
    { label: 'نقطة/صفقة', get: r => (r.exp > 0 ? '+' : '') + f(r.exp, 2) },
  ];

  for (const [key, title] of [
    ['ATR', 'التذبذب — ATR بالنقاط لحظة الدخول'],
    ['ATRpct', 'التذبذب النسبي — ترتيب ATR مقابل تاريخه (0-100)'],
    ['ADX', 'قوة الاتجاه — ADX'],
    ['ER', 'كفاءة الحركة — Efficiency Ratio'],
    ['EXPAND', 'اتساع التذبذب — ATR سريع ÷ ATR بطيء'],
  ]) {
    console.log(`\n${title}`);
    render(quintiles(trades, key), COLS);
  }

  // Two dimensions at once: a filter that needs both conditions is stricter
  // than either alone, and the grid shows whether that is worth the lost trades.
  console.log('\n\nالتذبذب × قوة الاتجاه — صافي النقاط في كل خانة');
  const atrCuts = quintiles(trades, 'ATR').map(q => q.hi);
  const adxCuts = quintiles(trades, 'ADX').map(q => q.hi);
  const bucket = (v, cuts) => { for (let i = 0; i < cuts.length; i++) if (v <= cuts[i]) return i; return cuts.length - 1; };
  const grid = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => []));
  for (const t of trades) {
    if (!Number.isFinite(t.ATR) || !Number.isFinite(t.ADX)) continue;
    grid[bucket(t.ATR, atrCuts)][bucket(t.ADX, adxCuts)].push(t);
  }
  console.log('صفوف = ATR منخفض←عالٍ   أعمدة = ADX منخفض←عالٍ\n');
  console.log('          ADX Q1      Q2      Q3      Q4      Q5');
  for (let a = 0; a < 5; a++) {
    const cells = grid[a].map(list => {
      const s = stats(list);
      return (s.net > 0 ? '+' : '') + f(s.net, 0);
    });
    console.log(`ATR Q${a + 1}  ` + cells.map(c => String(c).padStart(8)).join(''));
  }

  // Candidate rules, derived on Jan-Apr and then judged on May-Jul only.
  console.log('\n\nاختبار فلاتر — تُشتق من يناير→أبريل وتُحكم على مايو→يوليو\n');
  const rules = [
    { name: 'بلا فلتر', fn: () => true },
    { name: 'ADX ≥ 25', fn: t => t.ADX >= 25 },
    { name: 'ADX ≥ 30', fn: t => t.ADX >= 30 },
    { name: 'ADX ≤ 20', fn: t => t.ADX <= 20 },
    { name: 'ER ≥ 0.30', fn: t => t.ER >= 0.30 },
    { name: 'ATR نسبي ≤ 50', fn: t => t.ATRpct <= 50 },
    { name: 'ATR نسبي ≥ 50', fn: t => t.ATRpct >= 50 },
    { name: 'ATR ≤ 30 نقطة', fn: t => t.ATR <= 30 },
    { name: 'تذبذب هابط (EXPAND ≤ 1)', fn: t => t.EXPAND <= 1 },
    { name: 'ADX ≥ 25 و ATR نسبي ≤ 50', fn: t => t.ADX >= 25 && t.ATRpct <= 50 },
    { name: 'ADX ≥ 25 و تذبذب هابط', fn: t => t.ADX >= 25 && t.EXPAND <= 1 },
  ];
  const train = trades.filter(t => t.entryTime < TRAIN_END);
  const test = trades.filter(t => t.entryTime >= TRAIN_END);
  render(rules.map(r => {
    const a = stats(train.filter(r.fn));
    const b = stats(test.filter(r.fn));
    return { name: r.name, a, b };
  }), [
    { label: 'الفلتر', get: r => r.name },
    { label: 'ضبط: صفقات', get: r => r.a.n },
    { label: 'نسبة%', get: r => f(r.a.wr, 1) },
    { label: 'صافي', get: r => (r.a.net > 0 ? '+' : '') + f(r.a.net, 0) },
    { label: '│ تحقق: صفقات', get: r => '│ ' + r.b.n },
    { label: 'نسبة%', get: r => f(r.b.wr, 1) },
    { label: 'صافي', get: r => (r.b.net > 0 ? '+' : '') + f(r.b.net, 0) },
    { label: 'نقطة/صفقة', get: r => (r.b.exp > 0 ? '+' : '') + f(r.b.exp, 2) },
  ]);
  console.log();
}

main();
