'use strict';
// Per-signal numbers are a measure of rule quality, not of what a chart can
// trade — signals overlap. This runs the survivors the way they would actually
// run: one position at a time, first touch wins, no re-entry until flat. Each
// timeframe on its own slot (his indicator allows that), then all of them
// merged into a single slot for comparison.
const { parseCSVFast } = require('./harness.js');
const L = require('./lines.js');
const fs = require('fs');
const PU = 0.1;

function agg(rows, mins) {
  const out = [], idx = new Int32Array(rows.length);
  let cur = null, key = -1;
  for (let i = 0; i < rows.length; i++) {
    const kk = Math.floor(rows[i].time / (mins * 60000));
    if (kk !== key) { if (cur) out.push(cur); key = kk; cur = { h: rows[i].high, l: rows[i].low, c: rows[i].close }; }
    else { cur.h = Math.max(cur.h, rows[i].high); cur.l = Math.min(cur.l, rows[i].low); cur.c = rows[i].close; }
    idx[i] = out.length;
  }
  if (cur) out.push(cur);
  return { bars: out, idx };
}

// the four that kept a positive neighbourhood in all three years
const CFG = [
  { tf: '15m', m: 15, line: 'DEMA', len: 28, sig: 'REJ', tp: 90, sl: 120 },
  { tf: '2m',  m: 2,  line: 'LSMA', len: 40, sig: 'REJ', tp: 90, sl: 120 },
  { tf: '30m', m: 30, line: 'SSF',  len: 15, sig: 'REJ', tp: 120, sl: 60 },
  { tf: '1H',  m: 60, line: 'T3',   len: 34, sig: 'REJ', tp: 120, sl: 90 },
];

function masks(rows, c) {
  const N = rows.length, A = agg(rows, c.m), C = new Float64Array(A.bars.length);
  for (let i = 0; i < A.bars.length; i++) C[i] = A.bars[i].c;
  const line = L.BY_NAME[c.line](C, c.len);
  const Ld = new Float64Array(N).fill(NaN);
  for (let i = 0; i < N; i++) { const b = A.idx[i] - 1; if (b >= 0) Ld[i] = line[b]; }
  const B = new Uint8Array(N), S = new Uint8Array(N);
  for (let i = 61; i < N - 1; i++) {
    const Lv = Ld[i], Lp = Ld[i - 1];
    if (!Number.isFinite(Lv) || !Number.isFinite(Lp)) continue;
    const cl = rows[i].close, o = rows[i].open, h = rows[i].high, l = rows[i].low, cp = rows[i - 1].close;
    const uw = h - Math.max(cl, o), bl = Math.min(cl, o) - l;
    if (c.sig !== 'BRK') {
      if (cp > Lp && l <= Lv && cl > Lv && bl > 0) B[i] = 1;
      if (cp < Lp && h >= Lv && cl < Lv && uw > 0) S[i] = 1;
    }
    if (c.sig !== 'REJ') {
      if (cp <= Lp && l <= Lv && cl > Lv) B[i] = 1;
      if (cp >= Lp && h >= Lv && cl < Lv) S[i] = 1;
    }
  }
  return { B, S };
}

// Gold's minute-bar volatility is not comparable across these years: the median
// M1 ATR(14) is 23.2 points in 2026 but 4.3 in 2021 and 4.0 in 2023. A fixed
// 90-point target is 3.9x ATR in 2026 and 21x ATR in 2021 — a different trade
// wearing the same name. ATR mode converts every plan to the multiple it was in
// 2026, so the three years are finally being asked the same question.
function atr14(rows) {
  const n = rows.length, o = new Float64Array(n);
  let p = NaN;
  for (let i = 1; i < n; i++) {
    const tr = Math.max(rows[i].high - rows[i].low,
      Math.abs(rows[i].high - rows[i - 1].close), Math.abs(rows[i].low - rows[i - 1].close));
    p = Number.isFinite(p) ? (p * 13 + tr) / 14 : tr;
    o[i] = p / PU;
  }
  return o;
}
const ATR2026 = 23.2;   // median M1 ATR(14) in points, the scale the plans were found on

// one position at a time; the stop wins a same-bar tie, as he requires
function slot(rows, entries, maxHold) {
  const N = rows.length, T = [];
  let live = null;
  for (let i = 61; i < N - 1; i++) {
    if (live) {
      const s = live.side;
      const ht = s === 1 ? rows[i].high >= live.tp : rows[i].low <= live.tp;
      const hs = s === 1 ? rows[i].low <= live.sl : rows[i].high >= live.sl;
      let r = null;
      if (ht && hs) r = -live.slP; else if (ht) r = live.tpP; else if (hs) r = -live.slP;
      else if (i - live.bar >= maxHold) r = (s === 1 ? rows[i].close - live.en : live.en - rows[i].close) / PU;
      if (r !== null) { T.push({ side: s, p: r, bar: live.bar, time: rows[live.bar].time }); live = null; }
      continue;
    }
    const e = entries[i];
    if (!e) continue;
    const en = rows[i].close;
    live = { side: e.side, en, bar: i, tpP: e.tp, slP: e.sl,
      tp: e.side === 1 ? en + e.tp * PU : en - e.tp * PU,
      sl: e.side === 1 ? en - e.sl * PU : en + e.sl * PU };
  }
  return T;
}

function stat(T, days) {
  let net = 0, w = 0, bn = 0, bw = 0, bN = 0, sn = 0, sw = 0, sN = 0;
  let eq = 0, peak = 0, dd = 0;
  for (const t of T) {
    net += t.p; if (t.p > 0) w++;
    if (t.side === 1) { bN++; bn += t.p; if (t.p > 0) bw++; } else { sN++; sn += t.p; if (t.p > 0) sw++; }
    eq += t.p; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq;
  }
  return { n: T.length, perDay: +(T.length / days).toFixed(1), wr: T.length ? +(100 * w / T.length).toFixed(1) : 0,
    net: Math.round(net), maxDD: Math.round(dd),
    buyN: bN, buyWR: bN ? +(100 * bw / bN).toFixed(1) : 0, buyNet: Math.round(bn),
    sellN: sN, sellWR: sN ? +(100 * sw / sN).toFixed(1) : 0, sellNet: Math.round(sn) };
}

const MODE = process.env.PLANMODE === 'fixed' ? 'fixed' : 'atr';
console.log('plan mode: ' + (MODE === 'atr'
  ? 'ATR-scaled (every plan expressed as the ATR multiple it was in 2026)'
  : 'fixed points (the raw sweep plans, not comparable across years)'));

for (const file of ['data2026.csv', 'data2021.csv', 'data2023.csv']) {
  const rows = parseCSVFast(fs.readFileSync(file, 'utf8'));
  const N = rows.length, days = (rows[N - 1].time - rows[0].time) / 86400000 * 5 / 7;
  const A = atr14(rows);
  console.log('\n════════════════ ' + file + '   ' + days.toFixed(0) + ' trading days ════════════════');

  const perTF = [], allEntries = new Array(N).fill(null);
  let months = days / 21;
  for (const c of CFG) {
    const m = masks(rows, c);
    const ent = new Array(N).fill(null);
    const sc = i => MODE === 'fixed' ? 1 : (A[i] > 0 ? A[i] / ATR2026 : 1);
    for (let i = 0; i < N; i++) {
      const k = sc(i);
      if (m.B[i] && !m.S[i]) ent[i] = { side: 1, tp: c.tp * k, sl: c.sl * k };
      else if (m.S[i] && !m.B[i]) ent[i] = { side: -1, tp: c.tp * k, sl: c.sl * k };
      if (ent[i] && !allEntries[i]) allEntries[i] = ent[i];
    }
    const s = stat(slot(rows, ent, 3000), days);
    perTF.push(Object.assign({ slot: c.tf + ' ' + c.line + ' ' + c.len + ' ' + c.sig + ' ' + c.tp + '/' + c.sl }, s,
      { perMonth: Math.round(s.net / months) }));
  }
  const merged = stat(slot(rows, allEntries, 3000), days);
  const sumAll = perTF.reduce((a, r) => ({ n: a.n + r.n, net: a.net + r.net, w: a.w + r.wr * r.n / 100 }), { n: 0, net: 0, w: 0 });
  perTF.push({ slot: '— four slots together —', n: sumAll.n, perDay: +(sumAll.n / days).toFixed(1),
    wr: +(100 * sumAll.w / sumAll.n).toFixed(1), net: Math.round(sumAll.net), maxDD: '',
    buyN: '', buyWR: '', buyNet: '', sellN: '', sellWR: '', sellNet: '', perMonth: Math.round(sumAll.net / months) });
  perTF.push(Object.assign({ slot: '— all merged into ONE slot —' }, merged, { perMonth: Math.round(merged.net / months) }));
  console.table(perTF);
}
