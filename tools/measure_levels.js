'use strict';
/*
 * Which kinds of level does gold actually respect?
 *
 * Every candidate line runs through the same rejection/breakout engine the
 * indicator already uses, with the same tolerances and the same targets, so
 * the only thing that differs between them is what is being watched. Each
 * signal is then traded on its own — no slots, no cooldowns, no competition —
 * because the question here is the quality of the level, not the plumbing.
 *
 * The number that matters is the last column. A random entry in this market,
 * with these targets and this cost, earns -0.64 points per trade. Anything
 * that does not clearly beat that is not a level, it is a coin flip with extra
 * steps — which is exactly what the eight KNN lines turned out to be.
 *
 * Usage: node tools/measure_levels.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('./ai963_engine');
const LV = require('./levels');

const PU = 0.10;
const COST = 0.5;
const TP = 90, SL = 90;
const MAX_HOLD = 1440;
const RANDOM_BASELINE = -0.64;   // measured in tools/random_control.js

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

/** Trade one signal alone: enter at its close, walk forward to target or stop. */
function race(bars, i, dir) {
  const e = bars[i].c;
  const tp = e + dir * TP * PU;
  const sl = e - dir * SL * PU;
  const end = Math.min(bars.length - 1, i + MAX_HOLD);
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    const hitTP = dir === 1 ? b.h >= tp : b.l <= tp;
    const hitSL = dir === 1 ? b.l <= sl : b.h >= sl;
    if (hitTP && hitSL) return null;
    if (hitTP) return TP - COST;
    if (hitSL) return -SL - COST;
  }
  return (bars[end].c - e) * dir / PU - COST;
}

function evaluate(bars, line, atr14) {
  const cfg = {
    useAtr: true, touchAtr: 0.15, wickAtr: 0.10, bufferAtr: 0.10,
    bodySameSide: true, touchPts: 0, wickPts: 0, bufferPts: 0,
  };
  const s = E.signalSet(bars, line, atr14, cfg, PU);
  let n = 0, wins = 0, net = 0, rej = 0, brk = 0, rejNet = 0, brkNet = 0, rejN = 0, brkN = 0;
  for (let i = 0; i < bars.length; i++) {
    const buy = s.buyRej[i] || s.buyBrk[i];
    const sell = s.sellRej[i] || s.sellBrk[i];
    let dir = 0;
    if (buy && !sell) dir = 1; else if (sell && !buy) dir = -1; else continue;
    const p = race(bars, i, dir);
    if (p === null) continue;
    n++; net += p;
    if (p > 0) wins++;
    const isRej = s.buyRej[i] || s.sellRej[i];
    if (isRej) { rej++; rejNet += p; rejN++; } else { brk++; brkNet += p; brkN++; }
  }
  return {
    n, wr: n ? (100 * wins) / n : 0, net, per: n ? net / n : 0,
    rejPer: rejN ? rejNet / rejN : NaN, rejN,
    brkPer: brkN ? brkNet / brkN : NaN, brkN,
  };
}

const f = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '—';

function main() {
  const bars = loadBars();
  const atr14 = E.atr(bars, 14);
  console.log(`${bars.length.toLocaleString()} شمعة   هدف/وقف ${TP}/${SL}   كلفة ${COST} نقطة`);
  console.log(`مرجع الدخول العشوائي: ${RANDOM_BASELINE} نقطة/صفقة\n`);

  const t0 = Date.now();
  const candidates = [
    ['① القمم (لمستان+)', () => LV.swingLevels(bars, { side: 'high', left: 20, right: 20, minTouches: 2, atr: atr14 }).line],
    ['① القمم (3 لمسات)', () => LV.swingLevels(bars, { side: 'high', left: 20, right: 20, minTouches: 3, atr: atr14 }).line],
    ['② القيعان (لمستان+)', () => LV.swingLevels(bars, { side: 'low', left: 20, right: 20, minTouches: 2, atr: atr14 }).line],
    ['② القيعان (3 لمسات)', () => LV.swingLevels(bars, { side: 'low', left: 20, right: 20, minTouches: 3, atr: atr14 }).line],
    ['③ فيبوناتشي', () => LV.fibLevels(bars, { left: 60, right: 60 }).line],
    ['④ فشل متكرر — قمة', () => LV.failedRetestLevels(bars, { side: 'high', atr: atr14 }).line],
    ['④ فشل متكرر — قاع', () => LV.failedRetestLevels(bars, { side: 'low', atr: atr14 }).line],
    ['⑤ اليوم السابق', () => LV.previousDayLevels(bars).line],
    ['⑥ نطاق جلسة آسيا', () => LV.sessionRangeLevels(bars, { startHour: 0, endHour: 7 }).line],
    ['⑦ أرقام مستديرة $10', () => LV.roundNumberLevels(bars, { step: 10 }).line],
    ['⑦ أرقام مستديرة $25', () => LV.roundNumberLevels(bars, { step: 25 }).line],
    ['⑧ VWAP', () => LV.vwapLevels(bars).line],
    ['⑨ فجوات FVG', () => LV.fvgLevels(bars, { atr: atr14 }).line],
    ['⑩ امتصاص (مؤسسات)', () => LV.absorptionLevels(bars, { atr: atr14 }).line],
    ['⑪ عقدة الحجم', () => LV.volumeNodeLevels(bars).line],
    ['⑫ بلوك الأوامر', () => LV.orderBlockLevels(bars, { atr: atr14 }).line],
  ];

  const rows = [];
  for (const [name, build] of candidates) {
    process.stdout.write(`  … ${name}\r`);
    const line = build();
    const r = evaluate(bars, line, atr14);
    rows.push({ name, ...r, edge: r.per - RANDOM_BASELINE });
  }
  console.log(' '.repeat(40) + `\rانتهى في ${((Date.now() - t0) / 1000).toFixed(0)} ثانية\n`);

  rows.sort((a, b) => b.per - a.per);
  const cols = [
    { label: 'الخط', get: r => r.name },
    { label: 'إشارات', get: r => r.n },
    { label: 'ربح%', get: r => f(r.wr, 1) },
    { label: 'صافي', get: r => (r.net > 0 ? '+' : '') + f(r.net, 0) },
    { label: 'نقطة/صفقة', get: r => (r.per > 0 ? '+' : '') + f(r.per) },
    { label: 'مقابل العشوائي', get: r => (r.edge > 0 ? '+' : '') + f(r.edge) },
    { label: 'ارتداد', get: r => f(r.rejPer) },
    { label: 'اختراق', get: r => f(r.brkPer) },
  ];
  const w = cols.map(c => Math.max(c.label.length, ...rows.map(r => String(c.get(r)).length)));
  const line = cells => cells.map((c, i) => String(c).padStart(w[i])).join('  ');
  console.log(line(cols.map(c => c.label)));
  console.log(w.map(x => '─'.repeat(x)).join('  '));
  for (const r of rows) console.log(line(cols.map(c => c.get(r))));

  const good = rows.filter(r => r.per > 0 && r.n >= 200);
  console.log(`\nخطوط رابحة فعليًا (وبعينة ≥ 200 إشارة): ${good.length} من ${rows.length}`);
  if (good.length) for (const r of good) console.log(`  ✔ ${r.name}  ${f(r.per)} نقطة/صفقة على ${r.n} إشارة`);
}

main();
