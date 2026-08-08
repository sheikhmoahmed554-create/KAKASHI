'use strict';
/*
 * Measures the AI 963 V12 preset on the XAUUSD 1m history embedded in the
 * KAKASHI data vault, and breaks the result down by source, setup and session.
 *
 * Usage:  node tools/run_baseline.js [--cost <points>] [--json <out.json>]
 *
 * `--cost` charges a round-trip cost in indicator points (1 point = 0.10 USD by
 * default). The vault carries a real spread column; the default cost is taken
 * from its median so the headline number is not a frictionless fantasy.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('./ai963_engine');

const REPO = path.join(__dirname, '..');
const VAULT = path.join(REPO, 'KAKASHI_V16_TV_PARITY_AUDIT.html');
const POINT_UNIT = 0.10;

// ─────────────────────────────────────────────────────────────────────────────
//  The V12 preset, transcribed from AI_963_V12_BASE.pine.
// ─────────────────────────────────────────────────────────────────────────────
const PRESET = [
  { name: 'CHART 1m', tf: 1, priceValue: 'hma', priceLen: 5, targetValue: 'Price Action', targetLen: 5,
    closest: 3, smoothing: 51, lineType: 'RMA (original)', signalLine: 'Average KNN',
    touchPts: 3.0, wickPts: 20.0, bufferPts: 4.5, useAtr: false, touchAtr: 0.0, wickAtr: 0.05, bufferAtr: 0.08,
    bodySameSide: true, tp: 90, sl: 90, respectOthers: false, cooldown: 7, buyCooldown: 0, sellCooldown: 0 },

  { name: '2m', tf: 2, priceValue: 'hma', priceLen: 7, targetValue: 'Price Action', targetLen: 5,
    closest: 3, smoothing: 40, lineType: 'RMA (original)', signalLine: 'Average KNN',
    touchPts: 0.0, wickPts: 2.0, bufferPts: 7.0, useAtr: false, touchAtr: 0.0, wickAtr: 0.0, bufferAtr: 0.0,
    bodySameSide: true, tp: 70, sl: 100, respectOthers: false, cooldown: 0, buyCooldown: 0, sellCooldown: 0 },

  { name: '3m', tf: 3, priceValue: 'hma', priceLen: 5, targetValue: 'Price Action', targetLen: 5,
    closest: 3, smoothing: 28, lineType: 'RMA (original)', signalLine: 'Average KNN',
    touchPts: 0.0, wickPts: 4.0, bufferPts: 2.0, useAtr: false, touchAtr: 0.06, wickAtr: 0.05, bufferAtr: 0.50,
    bodySameSide: true, tp: 105, sl: 90, respectOthers: false, cooldown: 21, buyCooldown: 0, sellCooldown: 0 },

  { name: '5m', tf: 5, priceValue: 'hma', priceLen: 5, targetValue: 'Price Action', targetLen: 5,
    closest: 3, smoothing: 28, lineType: 'RMA (original)', signalLine: 'Average KNN',
    touchPts: 0.0, wickPts: 0.0, bufferPts: 0.0, useAtr: false, touchAtr: 0.08, wickAtr: 0.0, bufferAtr: 0.05,
    bodySameSide: true, tp: 90, sl: 90, respectOthers: true, cooldown: 0, buyCooldown: 0, sellCooldown: 0 },

  { name: '10m', tf: 10, priceValue: 'hma', priceLen: 4, targetValue: 'Price Action', targetLen: 4,
    closest: 3, smoothing: 22, lineType: 'RMA (original)', signalLine: 'Average KNN',
    touchPts: 0.0, wickPts: 0.0, bufferPts: 0.0, useAtr: false, touchAtr: 0.12, wickAtr: 0.10, bufferAtr: 0.50,
    bodySameSide: true, tp: 90, sl: 90, respectOthers: true, cooldown: 0, buyCooldown: 0, sellCooldown: 0 },

  { name: '15m', tf: 15, priceValue: 'hma', priceLen: 4, targetValue: 'Price Action', targetLen: 4,
    closest: 3, smoothing: 19, lineType: 'RMA (original)', signalLine: 'Average KNN',
    touchPts: 0.0, wickPts: 0.0, bufferPts: 0.0, useAtr: false, touchAtr: 0.20, wickAtr: 0.50, bufferAtr: 0.05,
    bodySameSide: true, tp: 90, sl: 90, respectOthers: true, cooldown: 0, buyCooldown: 0, sellCooldown: 0 },

  { name: '30m', tf: 30, priceValue: 'hma', priceLen: 3, targetValue: 'Price Action', targetLen: 3,
    closest: 3, smoothing: 15, lineType: 'RMA (original)', signalLine: 'Average KNN',
    touchPts: 0.0, wickPts: 0.0, bufferPts: 0.0, useAtr: false, touchAtr: 0.20, wickAtr: 0.50, bufferAtr: 0.50,
    bodySameSide: true, tp: 90, sl: 90, respectOthers: true, cooldown: 400, buyCooldown: 0, sellCooldown: 0 },

  { name: '1H', tf: 60, priceValue: 'hma', priceLen: 3, targetValue: 'Price Action', targetLen: 3,
    closest: 3, smoothing: 12, lineType: 'RMA (original)', signalLine: 'Average KNN',
    touchPts: 1.0, wickPts: 20.0, bufferPts: 0.0, useAtr: false, touchAtr: 0.009, wickAtr: 0.04, bufferAtr: 0.0,
    bodySameSide: true, tp: 150, sl: 130, respectOthers: true, cooldown: 80, buyCooldown: 0, sellCooldown: 0 },
];

// ─────────────────────────────────────────────────────────────────────────────
//  Data
// ─────────────────────────────────────────────────────────────────────────────
function loadBars() {
  const html = fs.readFileSync(VAULT, 'utf8');
  const m = html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/);
  if (!m) throw new Error('data vault not found in ' + VAULT);
  const csv = zlib.gunzipSync(Buffer.from(m[1], 'base64')).toString('utf8');
  const lines = csv.split('\n');
  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const a = l.split(',');
    const t = Date.parse(a[0].replace(' ', 'T'));
    const o = +a[1], h = +a[2], lo = +a[3], c = +a[4], sp = +a[6];
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
    bars.push({ t, o, h, l: lo, c, sp });
  }
  bars.sort((x, y) => x.t - y.t);
  return bars;
}

function medianSpreadPoints(bars) {
  // The spread column is in broker points (0.01 USD for gold). Convert to the
  // indicator's points, where 1 point = POINT_UNIT USD, and charge both sides.
  const s = bars.map(b => b.sp).filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return 0;
  const med = s[s.length >> 1];
  return (med * 0.01) / POINT_UNIT;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Build every source's signal streams on the 1m timeline
// ─────────────────────────────────────────────────────────────────────────────
function buildSources(bars) {
  const atr14 = E.atr(bars, 14);
  return PRESET.map(p => {
    const { bars: tfBars, index } = E.resample(bars, p.tf);
    const rawLine = E.knnLine(tfBars, p);
    const line = p.tf === 1 ? rawLine : E.projectConfirmed(rawLine, index);
    const sig = E.signalSet(bars, line, atr14, p, POINT_UNIT);

    const n = bars.length;
    const buy = new Uint8Array(n);
    const sell = new Uint8Array(n);
    const rejection = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const bR = sig.buyRej[i], bB = sig.buyBrk[i];
      const sR = sig.sellRej[i], sB = sig.sellBrk[i];
      buy[i] = (bR || bB) ? 1 : 0;
      sell[i] = (sR || sB) ? 1 : 0;
      rejection[i] = (bR || sR) ? 1 : 0;
    }
    return { ...p, line, buy, sell, rejection };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Reporting
// ─────────────────────────────────────────────────────────────────────────────
const fmt = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '—';

function table(rows, cols) {
  const widths = cols.map(c => Math.max(c.label.length, ...rows.map(r => String(c.get(r)).length)));
  const line = (cells) => cells.map((c, i) => String(c).padStart(widths[i])).join('  ');
  const out = [line(cols.map(c => c.label)), widths.map(w => '─'.repeat(w)).join('  ')];
  for (const r of rows) out.push(line(cols.map(c => c.get(r))));
  return out.join('\n');
}

function statRows(groups) {
  return [...groups.entries()]
    .map(([key, list]) => ({ key, ...E.summarize(list) }))
    .filter(r => r.trades > 0)
    .sort((a, b) => b.netPoints - a.netPoints);
}

const STAT_COLS = [
  { label: 'GROUP', get: r => r.key },
  { label: 'TRADES', get: r => r.trades },
  { label: 'W', get: r => r.wins },
  { label: 'L', get: r => r.losses },
  { label: 'WIN%', get: r => fmt(r.winRate, 1) },
  { label: 'NET pts', get: r => fmt(r.netPoints, 0) },
  { label: 'PF', get: r => fmt(r.profitFactor, 2) },
  { label: 'EXP', get: r => fmt(r.expectancy, 2) },
  { label: 'MAXDD', get: r => fmt(r.maxDrawdownPoints, 0) },
  { label: 'MAXL', get: r => r.maxLossStreak },
];

function groupBy(trades, fn) {
  const m = new Map();
  for (const t of trades) {
    const k = fn(t);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return m;
}

function sessionOf(ms) {
  const h = new Date(ms).getUTCHours();
  if (h < 7) return 'ASIA 00-07';
  if (h < 12) return 'LONDON 07-12';
  if (h < 17) return 'OVERLAP 12-17';
  if (h < 21) return 'NY 17-21';
  return 'LATE 21-24';
}

function main() {
  const argv = process.argv.slice(2);
  const costArg = argv.indexOf('--cost');
  const jsonArg = argv.indexOf('--json');
  const fromArg = argv.indexOf('--from');
  const untilArg = argv.indexOf('--until');

  // A window trims which trades are counted, never which candles are loaded:
  // the lines still warm up on the full history, so a restricted report is not
  // a differently-warmed indicator.
  const from = fromArg >= 0 ? Date.parse(argv[fromArg + 1] + 'T00:00:00Z') : -Infinity;
  const until = untilArg >= 0 ? Date.parse(argv[untilArg + 1] + 'T00:00:00Z') : Infinity;

  console.log('Loading XAUUSD 1m history from the data vault...');
  const bars = loadBars();
  const spreadCost = medianSpreadPoints(bars);
  const cost = costArg >= 0 ? Number(argv[costArg + 1]) : spreadCost;

  console.log(`bars           : ${bars.length.toLocaleString()}`);
  console.log(`period         : ${new Date(bars[0].t).toISOString().slice(0, 16)} → ${new Date(bars[bars.length - 1].t).toISOString().slice(0, 16)} UTC`);
  console.log(`median spread  : ${fmt(spreadCost, 2)} points round trip`);
  console.log(`cost charged   : ${fmt(cost, 2)} points per trade\n`);

  console.log('Building the eight KNN lines and their signals...');
  const t0 = Date.now();
  const sources = buildSources(bars);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const signalCounts = sources.map(s => {
    let b = 0, sl = 0;
    for (let i = 0; i < s.buy.length; i++) { b += s.buy[i]; sl += s.sell[i]; }
    return { key: s.name, buy: b, sell: sl, total: b + sl };
  });
  console.log('RAW SIGNALS BEFORE SLOT AND COOLDOWN RULES');
  console.log(table(signalCounts, [
    { label: 'SOURCE', get: r => r.key },
    { label: 'BUY', get: r => r.buy },
    { label: 'SELL', get: r => r.sell },
    { label: 'TOTAL', get: r => r.total },
  ]));
  console.log();

  const run = E.runBacktest(bars, sources, {
    pointUnit: POINT_UNIT, sameCandleRule: 'Skip', costPoints: cost,
  });
  const openAtEnd = run.openAtEnd;
  const trades = run.trades.filter(t => t.entryTime >= from && t.entryTime < until);
  if (Number.isFinite(from) || Number.isFinite(until)) {
    console.log(`counting window : ${Number.isFinite(from) ? new Date(from).toISOString().slice(0, 10) : 'start'} → ${Number.isFinite(until) ? new Date(until).toISOString().slice(0, 10) : 'end'}  (${trades.length} of ${run.trades.length} trades)\n`);
  }

  const all = E.summarize(trades);
  console.log('═'.repeat(72));
  console.log('BASELINE — AI 963 V12 preset, all eight sources');
  console.log('═'.repeat(72));
  console.log(`trades            : ${all.trades}`);
  console.log(`wins / losses     : ${all.wins} / ${all.losses}`);
  console.log(`win rate          : ${fmt(all.winRate, 2)}%`);
  console.log(`net points        : ${fmt(all.netPoints, 0)}   (${fmt(all.netPoints * POINT_UNIT, 2)} USD per 1.0 lot-point)`);
  console.log(`profit factor     : ${fmt(all.profitFactor, 3)}`);
  console.log(`expectancy        : ${fmt(all.expectancy, 2)} points per trade`);
  console.log(`avg win / avg loss: ${fmt(all.avgWin, 1)} / ${fmt(all.avgLoss, 1)}`);
  console.log(`max loss streak   : ${all.maxLossStreak}`);
  console.log(`max drawdown      : ${fmt(all.maxDrawdownPoints, 0)} points`);
  console.log(`still open at end : ${openAtEnd}\n`);

  console.log('BY SOURCE');
  console.log(table(statRows(groupBy(trades, t => t.source)), STAT_COLS));
  console.log('\nBY SETUP');
  console.log(table(statRows(groupBy(trades, t => t.type)), STAT_COLS));
  console.log('\nBY SIDE');
  console.log(table(statRows(groupBy(trades, t => t.side)), STAT_COLS));
  console.log('\nBY SESSION (UTC)');
  console.log(table(statRows(groupBy(trades, t => sessionOf(t.entryTime))), STAT_COLS));
  console.log('\nBY MONTH');
  console.log(table(statRows(groupBy(trades, t => new Date(t.entryTime).toISOString().slice(0, 7))), STAT_COLS));

  if (jsonArg >= 0) {
    fs.writeFileSync(argv[jsonArg + 1], JSON.stringify({ summary: all, trades }, null, 1));
    console.log(`\ntrades written to ${argv[jsonArg + 1]}`);
  }
}

main();
