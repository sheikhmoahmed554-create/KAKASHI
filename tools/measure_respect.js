'use strict';
/*
 * Does gold respect these levels?
 *
 * Two questions, answered separately, because mixing them is what produced the
 * useless first answer:
 *
 *   RESPECT   of every time price arrived at the level, how often was it
 *             pushed back rather than passing through? This says nothing about
 *             money. A level nobody watches sits at 50%.
 *
 *   MONEY     what a trade taken on those arrivals earns, scored against a
 *             blind long and a blind short so a falling market cannot make a
 *             resistance line look clever.
 *
 * A level can be respected and still untradeable — respected at 60% but only
 * by twelve points before turning again, against a ninety point stop. Keeping
 * the two apart is the only way to see which of those is happening.
 *
 * Every fixed-set level — round numbers, pivots, previous-day, Fibonacci — is
 * tested one value at a time as a constant. The earlier pass asked about "the
 * nearest level to price", which moves whenever price moves and is therefore
 * not a level at all.
 *
 * Usage: node tools/measure_respect.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('./ai963_engine');
const LV = require('./levels');
const { levelTestEvents, respectRate } = require('./level_events');

const PU = 0.10, COST = 0.5, TP = 90, SL = 90, MAX_HOLD = 1440;

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
const atr14 = E.atr(bars, 14);
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
const BL_LONG = blind(1, 50000, 4242), BL_SHORT = blind(-1, 50000, 2424);

/** Turn one constant level into a series that is only live while price is near it. */
function constantLine(level, maxDistAtr = 6) {
  const out = new Array(N).fill(NaN);
  for (let i = 0; i < N; i++) {
    const a = atr14[i];
    if (Number.isFinite(a) && Math.abs(bars[i].c - level) <= a * maxDistAtr) out[i] = level;
  }
  return out;
}

/** Fixed grid of levels spanning the data, each tested on its own. */
function gridEvents(step) {
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
  const events = [];
  for (let L = Math.ceil(lo / step) * step; L <= hi; L += step) {
    events.push(...levelTestEvents(bars, constantLine(L), atr14));
  }
  return events.sort((a, b) => a.i - b.i);
}

/** Per-day level sets — pivots, previous day, session range — one value at a time. */
function dailySetEvents(builder) {
  const dayOf = t => Math.floor(t / 86400000);
  const days = new Map();
  for (let i = 0; i < N; i++) {
    const d = dayOf(bars[i].t);
    if (!days.has(d)) days.set(d, { from: i, to: i });
    days.get(d).to = i;
  }
  const keys = [...days.keys()].sort((a, b) => a - b);
  const events = [];
  for (let k = 1; k < keys.length; k++) {
    const prev = days.get(keys[k - 1]), cur = days.get(keys[k]);
    let h = -Infinity, l = Infinity;
    for (let i = prev.from; i <= prev.to; i++) { if (bars[i].h > h) h = bars[i].h; if (bars[i].l < l) l = bars[i].l; }
    const c = bars[prev.to].c;
    for (const L of builder({ h, l, c })) {
      if (!Number.isFinite(L)) continue;
      const line = new Array(N).fill(NaN);
      for (let i = cur.from; i <= cur.to; i++) {
        const a = atr14[i];
        if (Number.isFinite(a) && Math.abs(bars[i].c - L) <= a * 6) line[i] = L;
      }
      events.push(...levelTestEvents(bars, line, atr14));
    }
  }
  return events.sort((a, b) => a.i - b.i);
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
  const la = ln ? lnet / ln - BL_LONG : NaN;
  const sa = sn ? snet / sn - BL_SHORT : NaN;
  return {
    ...r,
    shortShare: tot ? (100 * sn) / tot : NaN,
    raw: tot ? (lnet + snet) / tot : NaN,
    alpha: tot ? ((ln ? la * ln : 0) + (sn ? sa * sn : 0)) / tot : NaN,
  };
}

const f = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '—';

function main() {
  console.log(`${N.toLocaleString()} شمعة   خط الأساس: شراء أعمى ${f(BL_LONG)}  بيع أعمى ${f(BL_SHORT)}`);
  console.log('احترام 50% = المستوى لا يعني شيئًا. أعلى من ذلك = السوق يتعامل معه كحاجز.\n');

  const cases = [
    ['أرقام مستديرة $10', () => gridEvents(10)],
    ['أرقام مستديرة $25', () => gridEvents(25)],
    ['أرقام مستديرة $50', () => gridEvents(50)],
    ['أرقام مستديرة $100', () => gridEvents(100)],
    ['اليوم السابق H/L/C', () => dailySetEvents(d => [d.h, d.l, d.c])],
    ['بيفوت كلاسيكي', () => dailySetEvents(d => {
      const pp = (d.h + d.l + d.c) / 3;
      return [pp, 2 * pp - d.l, 2 * pp - d.h, pp + (d.h - d.l), pp - (d.h - d.l)];
    })],
    ['فيبوناتشي اليومي', () => dailySetEvents(d => {
      const s = d.h - d.l;
      return [d.h - s * 0.382, d.h - s * 0.5, d.h - s * 0.618, d.h - s * 0.786];
    })],
    ['قمم حقيقية (لمستان+)', () => levelTestEvents(bars, LV.swingLevels(bars, { side: 'high', left: 20, right: 20, minTouches: 2, atr: atr14 }).line, atr14)],
    ['قيعان حقيقية (لمستان+)', () => levelTestEvents(bars, LV.swingLevels(bars, { side: 'low', left: 20, right: 20, minTouches: 2, atr: atr14 }).line, atr14)],
    ['فشل متكرر — قمة', () => levelTestEvents(bars, LV.failedRetestLevels(bars, { side: 'high', atr: atr14 }).line, atr14)],
    ['فشل متكرر — قاع', () => levelTestEvents(bars, LV.failedRetestLevels(bars, { side: 'low', atr: atr14 }).line, atr14)],
    ['ترند هابط', () => levelTestEvents(bars, LV.trendLineLevels(bars, { side: 'down', atr: atr14 }).line, atr14)],
    ['ترند صاعد', () => levelTestEvents(bars, LV.trendLineLevels(bars, { side: 'up', atr: atr14 }).line, atr14)],
    ['VWAP', () => levelTestEvents(bars, LV.vwapLevels(bars).line, atr14)],
    ['افتتاح اليوم', () => levelTestEvents(bars, LV.dailyOpenLevels(bars).line, atr14)],
    ['نطاق جلسة آسيا', () => levelTestEvents(bars, LV.sessionRangeLevels(bars, { startHour: 0, endHour: 7 }).line, atr14)],
    ['فجوات FVG', () => levelTestEvents(bars, LV.fvgLevels(bars, { atr: atr14 }).line, atr14)],
    ['بلوك الأوامر', () => levelTestEvents(bars, LV.orderBlockLevels(bars, { atr: atr14 }).line, atr14)],
    ['امتصاص (مؤسسات)', () => levelTestEvents(bars, LV.absorptionLevels(bars, { atr: atr14 }).line, atr14)],
    ['عقدة الحجم', () => levelTestEvents(bars, LV.volumeNodeLevels(bars).line, atr14)],
    ['انقلاب الدور', () => levelTestEvents(bars, LV.roleReversalLevels(bars, { atr: atr14 }).line, atr14)],
  ];

  const rows = [];
  for (const [name, build] of cases) {
    process.stdout.write(`  … ${name}          \r`);
    rows.push({ name, ...score(build()) });
  }
  console.log(' '.repeat(46) + '\r');

  rows.sort((a, b) => (b.respect || 0) - (a.respect || 0));
  const cols = [
    { label: 'المستوى', get: r => r.name },
    { label: 'اختبارات', get: r => r.tests },
    { label: 'ارتد', get: r => r.rejects },
    { label: 'اخترق', get: r => r.breaks },
    { label: 'احترام%', get: r => f(r.respect, 1) },
    { label: 'حصة البيع%', get: r => f(r.shortShare, 0) },
    { label: 'نقطة/صفقة', get: r => (r.raw > 0 ? '+' : '') + f(r.raw) },
    { label: 'ألفا', get: r => (r.alpha > 0 ? '+' : '') + f(r.alpha) },
  ];
  const w = cols.map(c => Math.max(c.label.length, ...rows.map(r => String(c.get(r)).length)));
  const line = cells => cells.map((c, i) => String(c).padStart(w[i])).join('  ');
  console.log(line(cols.map(c => c.label)));
  console.log(w.map(x => '─'.repeat(x)).join('  '));
  for (const r of rows) console.log(line(cols.map(c => c.get(r))));

  console.log('\nمستويات يحترمها السوق فعليًا (احترام > 55% وعينة ≥ 100):');
  const good = rows.filter(r => r.respect > 55 && r.tests >= 100);
  if (!good.length) console.log('  لا شيء.');
  for (const r of good) console.log(`  ✔ ${r.name}  احترام ${f(r.respect, 1)}% على ${r.tests} اختبار`);
}

main();
