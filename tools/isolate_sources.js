'use strict';
/*
 * Why did 15m finish positive while the others bled?
 *
 * The headline backtest runs all eight sources against each other, so a
 * source's result mixes three different things: the quality of its line, the
 * subsample of signals the slot rules let it take, and its target geometry.
 * This script separates them.
 *
 *   TEST A  every raw signal traded on its own, no slots, no cooldowns, each
 *           source keeping its own targets. Maximum sample, so the line's own
 *           hit rate is measurable instead of inferred.
 *   TEST B  the same, but every source forced onto identical 90/90 targets, so
 *           the lines are compared on equal terms.
 *   TEST C  excursion profile — how far each signal ran in favour before it ran
 *           against, which is what decides whether a target is reachable.
 *   TEST D  the horizon question: is 15m special because of its timeframe, or
 *           because 19 bars of 15m is 285 minutes of lookback? Re-runs the 1m
 *           line at matching horizons to find out.
 *
 * Usage: node tools/isolate_sources.js [--horizon]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('./ai963_engine');

const REPO = path.join(__dirname, '..');
const VAULT = path.join(REPO, 'KAKASHI_V16_TV_PARITY_AUDIT.html');
const POINT_UNIT = 0.10;
const COST = 0.5;           // round-trip spread, in points, from the vault median
const MAX_HOLD = 1440;      // give a trade one day of 1m bars to resolve

const PRESET = [
  { name: 'CHART 1m', tf: 1, priceValue: 'hma', priceLen: 5, targetValue: 'Price Action', targetLen: 5,
    closest: 3, smoothing: 51, lineType: 'RMA (original)', signalLine: 'Average KNN',
    touchPts: 3.0, wickPts: 20.0, bufferPts: 4.5, useAtr: false, touchAtr: 0, wickAtr: 0.05, bufferAtr: 0.08,
    bodySameSide: true, tp: 90, sl: 90 },
  { name: '2m', tf: 2, priceValue: 'hma', priceLen: 7, targetValue: 'Price Action', targetLen: 5,
    closest: 3, smoothing: 40, lineType: 'RMA (original)', signalLine: 'Average KNN',
    touchPts: 0, wickPts: 2.0, bufferPts: 7.0, useAtr: false, touchAtr: 0, wickAtr: 0, bufferAtr: 0,
    bodySameSide: true, tp: 70, sl: 100 },
  { name: '3m', tf: 3, priceValue: 'hma', priceLen: 5, targetValue: 'Price Action', targetLen: 5,
    closest: 3, smoothing: 28, lineType: 'RMA (original)', signalLine: 'Average KNN',
    touchPts: 0, wickPts: 4.0, bufferPts: 2.0, useAtr: false, touchAtr: 0.06, wickAtr: 0.05, bufferAtr: 0.5,
    bodySameSide: true, tp: 105, sl: 90 },
  { name: '5m', tf: 5, priceValue: 'hma', priceLen: 5, targetValue: 'Price Action', targetLen: 5,
    closest: 3, smoothing: 28, lineType: 'RMA (original)', signalLine: 'Average KNN',
    touchPts: 0, wickPts: 0, bufferPts: 0, useAtr: false, touchAtr: 0.08, wickAtr: 0, bufferAtr: 0.05,
    bodySameSide: true, tp: 90, sl: 90 },
  { name: '10m', tf: 10, priceValue: 'hma', priceLen: 4, targetValue: 'Price Action', targetLen: 4,
    closest: 3, smoothing: 22, lineType: 'RMA (original)', signalLine: 'Average KNN',
    touchPts: 0, wickPts: 0, bufferPts: 0, useAtr: false, touchAtr: 0.12, wickAtr: 0.10, bufferAtr: 0.5,
    bodySameSide: true, tp: 90, sl: 90 },
  { name: '15m', tf: 15, priceValue: 'hma', priceLen: 4, targetValue: 'Price Action', targetLen: 4,
    closest: 3, smoothing: 19, lineType: 'RMA (original)', signalLine: 'Average KNN',
    touchPts: 0, wickPts: 0, bufferPts: 0, useAtr: false, touchAtr: 0.20, wickAtr: 0.50, bufferAtr: 0.05,
    bodySameSide: true, tp: 90, sl: 90 },
  { name: '30m', tf: 30, priceValue: 'hma', priceLen: 3, targetValue: 'Price Action', targetLen: 3,
    closest: 3, smoothing: 15, lineType: 'RMA (original)', signalLine: 'Average KNN',
    touchPts: 0, wickPts: 0, bufferPts: 0, useAtr: false, touchAtr: 0.20, wickAtr: 0.50, bufferAtr: 0.5,
    bodySameSide: true, tp: 90, sl: 90 },
  { name: '1H', tf: 60, priceValue: 'hma', priceLen: 3, targetValue: 'Price Action', targetLen: 3,
    closest: 3, smoothing: 12, lineType: 'RMA (original)', signalLine: 'Average KNN',
    touchPts: 1.0, wickPts: 20.0, bufferPts: 0, useAtr: false, touchAtr: 0.009, wickAtr: 0.04, bufferAtr: 0,
    bodySameSide: true, tp: 150, sl: 130 },
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

/**
 * Trade one signal in isolation: enter at the close of bar `i`, then walk
 * forward until the target or the stop is touched. Also records how far price
 * ran each way, which is what TEST C reads.
 */
function raceForward(bars, i, dir, tp, sl) {
  const entry = bars[i].c;
  const tpPx = entry + dir * tp * POINT_UNIT;
  const slPx = entry - dir * sl * POINT_UNIT;
  let mfe = 0, mae = 0;
  const end = Math.min(bars.length - 1, i + MAX_HOLD);
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    const up = (b.h - entry) * dir / POINT_UNIT;
    const dn = (b.l - entry) * dir / POINT_UNIT;
    if (up > mfe) mfe = up;
    if (dn < mae) mae = dn;
    const hitTP = dir === 1 ? b.h >= tpPx : b.l <= tpPx;
    const hitSL = dir === 1 ? b.l <= slPx : b.h >= slPx;
    if (hitTP && hitSL) return { outcome: 'SKIP', points: 0, bars: j - i, mfe, mae };
    if (hitTP) return { outcome: 'TP', points: tp - COST, bars: j - i, mfe, mae };
    if (hitSL) return { outcome: 'SL', points: -sl - COST, bars: j - i, mfe, mae };
  }
  return { outcome: 'TIMEOUT', points: (bars[end].c - entry) * dir / POINT_UNIT - COST, bars: end - i, mfe, mae };
}

function buildSignals(bars, p, atr14) {
  const { bars: tfBars, index } = E.resample(bars, p.tf);
  const raw = E.knnLine(tfBars, p);
  const line = p.tf === 1 ? raw : E.projectConfirmed(raw, index);
  const s = E.signalSet(bars, line, atr14, p, POINT_UNIT);
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    const buy = s.buyRej[i] || s.buyBrk[i];
    const sell = s.sellRej[i] || s.sellBrk[i];
    if (buy && !sell) out.push({ i, dir: 1, type: s.buyRej[i] ? 'REJ' : 'BRK' });
    else if (sell && !buy) out.push({ i, dir: -1, type: s.sellRej[i] ? 'REJ' : 'BRK' });
  }
  return out;
}

function evaluate(bars, signals, tp, sl) {
  const res = [];
  for (const s of signals) res.push({ ...s, ...raceForward(bars, s.i, s.dir, tp, sl) });
  const graded = res.filter(r => r.outcome === 'TP' || r.outcome === 'SL');
  const wins = graded.filter(r => r.outcome === 'TP').length;
  const n = graded.length;
  const be = (100 * sl) / (tp + sl);
  const wr = n ? (100 * wins) / n : 0;
  const se = Math.sqrt(((be / 100) * (1 - be / 100)) / Math.max(1, n)) * 100;
  const net = res.reduce((a, r) => a + r.points, 0);
  const mfe = res.map(r => r.mfe).sort((a, b) => a - b);
  const mae = res.map(r => -r.mae).sort((a, b) => a - b);
  const med = arr => (arr.length ? arr[arr.length >> 1] : 0);
  return {
    signals: res.length, graded: n, wr, be, edge: wr - be, z: se > 0 ? (wr - be) / se : 0,
    net, perTrade: res.length ? net / res.length : 0,
    medMFE: med(mfe), medMAE: med(mae),
    medBars: med(res.map(r => r.bars).sort((a, b) => a - b)),
    reachTP: res.length ? (100 * res.filter(r => r.mfe >= tp).length) / res.length : 0,
  };
}

function render(rows, cols) {
  const w = cols.map(c => Math.max(c.label.length, ...rows.map(r => String(c.get(r)).length)));
  const line = cells => cells.map((c, i) => String(c).padStart(w[i])).join('  ');
  console.log(line(cols.map(c => c.label)));
  console.log(w.map(x => '─'.repeat(x)).join('  '));
  for (const r of rows) console.log(line(cols.map(c => c.get(r))));
}
const f = (x, d = 1) => Number.isFinite(x) ? x.toFixed(d) : '—';

function main() {
  const bars = loadBars();
  const atr14 = E.atr(bars, 14);
  console.log(`bars: ${bars.length.toLocaleString()}  cost: ${COST} points\n`);

  const sigs = PRESET.map(p => ({ p, list: buildSignals(bars, p, atr14) }));

  console.log('TEST A — every raw signal traded alone, each source keeping its own targets');
  console.log('(no slot competition, no cooldown: this is the line\'s own hit rate)\n');
  render(sigs.map(({ p, list }) => ({ p, r: evaluate(bars, list, p.tp, p.sl) })), [
    { label: 'SOURCE', get: x => x.p.name },
    { label: 'HORIZON min', get: x => x.p.smoothing * x.p.tf },
    { label: 'SIGNALS', get: x => x.r.signals },
    { label: 'TP/SL', get: x => `${x.p.tp}/${x.p.sl}` },
    { label: 'WIN%', get: x => f(x.r.wr) },
    { label: 'BREAKEVEN%', get: x => f(x.r.be) },
    { label: 'EDGE%', get: x => (x.r.edge > 0 ? '+' : '') + f(x.r.edge, 2) },
    { label: 'z', get: x => f(x.r.z, 2) },
    { label: 'pts/trade', get: x => f(x.r.perTrade, 2) },
  ]);

  console.log('\n\nTEST B — same signals, every source forced onto 90/90 (lines on equal terms)\n');
  render(sigs.map(({ p, list }) => ({ p, r: evaluate(bars, list, 90, 90) })), [
    { label: 'SOURCE', get: x => x.p.name },
    { label: 'HORIZON min', get: x => x.p.smoothing * x.p.tf },
    { label: 'SIGNALS', get: x => x.r.signals },
    { label: 'WIN%', get: x => f(x.r.wr, 2) },
    { label: 'EDGE% vs 50', get: x => (x.r.edge > 0 ? '+' : '') + f(x.r.edge, 2) },
    { label: 'z', get: x => f(x.r.z, 2) },
    { label: 'pts/trade', get: x => f(x.r.perTrade, 2) },
    { label: 'NET', get: x => f(x.r.net, 0) },
  ]);

  console.log('\n\nTEST C — excursion profile at 90/90: how far a signal runs each way\n');
  render(sigs.map(({ p, list }) => ({ p, r: evaluate(bars, list, 90, 90) })), [
    { label: 'SOURCE', get: x => x.p.name },
    { label: 'med MFE', get: x => f(x.r.medMFE, 0) },
    { label: 'med MAE', get: x => f(x.r.medMAE, 0) },
    { label: 'MFE/MAE', get: x => f(x.r.medMFE / Math.max(1, x.r.medMAE), 2) },
    { label: 'reached 90 %', get: x => f(x.r.reachTP, 1) },
    { label: 'med bars held', get: x => x.r.medBars },
  ]);

  if (process.argv.includes('--horizon')) {
    console.log('\n\nTEST D — is it the timeframe, or the lookback horizon?');
    console.log('The 1m line re-run at smoothing lengths that match each source\'s horizon.\n');
    const base = PRESET[0];
    const rows = [];
    for (const len of [51, 80, 84, 140, 220, 285, 450, 720]) {
      const p = { ...base, smoothing: len, tf: 1, touchPts: 0, wickPts: 0, bufferPts: 0 };
      const list = buildSignals(bars, p, atr14);
      rows.push({ len, r: evaluate(bars, list, 90, 90) });
    }
    render(rows, [
      { label: '1m smoothing', get: x => x.len },
      { label: 'HORIZON min', get: x => x.len },
      { label: 'SIGNALS', get: x => x.r.signals },
      { label: 'WIN%', get: x => f(x.r.wr, 2) },
      { label: 'EDGE%', get: x => (x.r.edge > 0 ? '+' : '') + f(x.r.edge, 2) },
      { label: 'z', get: x => f(x.r.z, 2) },
      { label: 'pts/trade', get: x => f(x.r.perTrade, 2) },
    ]);
  }
  console.log();
}

main();
