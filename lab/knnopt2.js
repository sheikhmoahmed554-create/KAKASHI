'use strict';
// Second pass at the navigator, with the flaw of the first pass fixed.
//
// 2026 fell 3,558 points in 197 days. Random entries with no rule at all pay
// SELL about 9 points a trade more than BUY on a 90/120 plan. Ranking by raw
// net therefore ranks the drift, not the rule — which is why every top config
// in pass one had a losing BUY side.
//
// Here each side is scored against the SAME year's random baseline for the SAME
// plan. edge = the rule's average minus what a coin flip would have earned on
// that side. A config only survives if BOTH sides beat their own baseline, in
// BOTH halves of the year.
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

const TFS = [{ n: '1m', m: 1, pLen: 5 }, { n: '2m', m: 2, pLen: 7 }, { n: '3m', m: 3, pLen: 5 },
  { n: '5m', m: 5, pLen: 5 }, { n: '10m', m: 10, pLen: 4 }, { n: '15m', m: 15, pLen: 4 },
  { n: '30m', m: 30, pLen: 3 }, { n: '1H', m: 60, pLen: 3 }];
const LINES = ['KNN', 'HMA', 'EMA', 'RMA', 'T3', 'ALMA', 'LSMA', 'KAMA', 'VIDYA', 'MCG', 'SSF', 'TEMA', 'DEMA', 'MEDIAN', 'WMA'];
const SMOOTH = [8, 12, 15, 19, 22, 28, 34, 40, 51, 70, 100];
const PLANS = [[90, 90], [120, 90], [90, 120], [60, 60], [150, 100], [120, 60], [60, 120], [50, 50], [70, 70]];

const rows = parseCSVFast(fs.readFileSync(process.argv[2] || 'data2026.csv', 'utf8'));
const N = rows.length, HALF = Math.floor(N / 2);
const days = (rows[N - 1].time - rows[0].time) / 86400000 * 5 / 7;
const MAXHOLD = 3000;

// ---------------------------------------------------------------- forward walk
function walk(bar, side, tp, sl) {
  const en = rows[bar].close;
  const T = side === 1 ? en + tp * PU : en - tp * PU;
  const S = side === 1 ? en - sl * PU : en + sl * PU;
  for (let q = bar + 1, e = Math.min(N - 1, bar + MAXHOLD); q <= e; q++) {
    const ht = side === 1 ? rows[q].high >= T : rows[q].low <= T;
    const hs = side === 1 ? rows[q].low <= S : rows[q].high >= S;
    if (ht && hs) return -sl;
    if (ht) return tp;
    if (hs) return -sl;
  }
  return null;
}

// ------------------------------------------------- the drift baseline per plan
// 30k random bars per side per plan; the same bars for both sides so the two
// baselines are drawn from an identical sample of the year.
const BASE = {};
{
  let s = 20260101 >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const bars = [];
  for (let k = 0; k < 30000; k++) bars.push(60 + Math.floor(rnd() * (N - 60 - MAXHOLD - 2)));
  for (const [tp, sl] of PLANS) {
    let bn = 0, bc = 0, sn = 0, sc = 0, bA = 0, bAc = 0, bB = 0, bBc = 0, sA = 0, sAc = 0, sB = 0, sBc = 0;
    for (const i of bars) {
      const b = walk(i, 1, tp, sl), q = walk(i, -1, tp, sl);
      if (b !== null) { bn += b; bc++; if (i < HALF) { bA += b; bAc++; } else { bB += b; bBc++; } }
      if (q !== null) { sn += q; sc++; if (i < HALF) { sA += q; sAc++; } else { sB += q; sBc++; } }
    }
    BASE[tp + '/' + sl] = {
      buy: bn / bc, sell: sn / sc,
      buyA: bA / bAc, buyB: bB / bBc, sellA: sA / sAc, sellB: sB / sBc,
    };
  }
  console.error('baseline (points per trade, no rule at all):');
  for (const k of Object.keys(BASE)) console.error('  ' + k + '  buy ' + BASE[k].buy.toFixed(2) + '  sell ' + BASE[k].sell.toFixed(2));
}

function evalSig(mask, side, tp, sl) {
  let w = 0, n = 0, net = 0, nA = 0, pA = 0, nB = 0, pB = 0;
  for (let i = 60; i < N - 1; i++) {
    if (!mask[i]) continue;
    const r = walk(i, side, tp, sl);
    if (r === null) continue;
    n++; net += r; if (r > 0) w++;
    if (i < HALF) { nA++; pA += r; } else { nB++; pB += r; }
  }
  return { n, net, wr: n ? 100 * w / n : 0, avg: n ? net / n : 0,
    avgA: nA ? pA / nA : 0, avgB: nB ? pB / nB : 0, nA, nB };
}

const results = [];
for (const tf of TFS) {
  const A = agg(rows, tf.m), C = new Float64Array(A.bars.length);
  for (let i = 0; i < A.bars.length; i++) C[i] = A.bars[i].c;
  const H = A.bars.map(b => b.h), Lo = A.bars.map(b => b.l);

  for (const lt of LINES) {
    for (const sm of SMOOTH) {
      let line;
      if (lt === 'KNN') line = L.knnLine(C, tf.pLen, sm, 5);
      else line = L.BY_NAME[lt](C, sm);
      if (!line) continue;

      // map the last CLOSED higher-timeframe bar down onto the 1m stream
      const Ld = new Float64Array(N).fill(NaN), Hd = new Float64Array(N).fill(NaN), Lod = new Float64Array(N).fill(NaN);
      for (let i = 0; i < N; i++) { const b = A.idx[i] - 1; if (b >= 0) { Ld[i] = line[b]; Hd[i] = H[b]; Lod[i] = Lo[b]; } }

      const rejB = new Uint8Array(N), rejS = new Uint8Array(N), brkB = new Uint8Array(N), brkS = new Uint8Array(N);
      for (let i = 61; i < N - 1; i++) {
        const Lv = Ld[i], Lp = Ld[i - 1];
        if (!Number.isFinite(Lv) || !Number.isFinite(Lp)) continue;
        const c = rows[i].close, o = rows[i].open, h = rows[i].high, l = rows[i].low, cp = rows[i - 1].close;
        const uw = h - Math.max(c, o), bl = Math.min(c, o) - l;
        if (cp > Lp && l <= Lv && c > Lv && bl > 0 && Lod[i] >= Lv * 0) rejB[i] = 1;
        if (cp < Lp && h >= Lv && c < Lv && uw > 0) rejS[i] = 1;
        if (cp <= Lp && l <= Lv && c > Lv) brkB[i] = 1;
        if (cp >= Lp && h >= Lv && c < Lv) brkS[i] = 1;
      }
      const bB = new Uint8Array(N), bS = new Uint8Array(N);
      for (let i = 0; i < N; i++) { bB[i] = rejB[i] || brkB[i]; bS[i] = rejS[i] || brkS[i]; }

      for (const [sn2, mb, ms] of [['REJ', rejB, rejS], ['BRK', brkB, brkS], ['BOTH', bB, bS]]) {
        for (const [tp, sl] of PLANS) {
          const key = tp + '/' + sl, base = BASE[key];
          const b = evalSig(mb, 1, tp, sl), s = evalSig(ms, -1, tp, sl);
          if (b.n < 120 || s.n < 120) continue;
          const eB = b.avg - base.buy, eS = s.avg - base.sell;
          const eBa = b.avgA - base.buyA, eBb = b.avgB - base.buyB;
          const eSa = s.avgA - base.sellA, eSb = s.avgB - base.sellB;
          const solid = eB > 0 && eS > 0 && eBa > 0 && eBb > 0 && eSa > 0 && eSb > 0;
          results.push({ tf: tf.n, line: lt, len: sm, sig: sn2, plan: key,
            n: b.n + s.n, perDay: +((b.n + s.n) / days).toFixed(1),
            buyN: b.n, buyWR: +b.wr.toFixed(1), buyEdge: +eB.toFixed(2),
            sellN: s.n, sellWR: +s.wr.toFixed(1), sellEdge: +eS.toFixed(2),
            edgeSum: +(eB + eS).toFixed(2), worstHalf: +Math.min(eBa, eBb, eSa, eSb).toFixed(2),
            rawNet: Math.round(b.net + s.net), solid: solid ? 'Y' : '' });
        }
      }
    }
  }
  console.error('done ' + tf.n);
}

fs.writeFileSync('knnopt2_' + (process.argv[2] || 'data2026.csv').replace(/\D/g, '') + '.json', JSON.stringify(results));
const solid = results.filter(r => r.solid).sort((a, b) => b.edgeSum - a.edgeSum);
console.log('\nconfigs tested: ' + results.length + '   both sides beat their own drift baseline in both halves: ' + solid.length + '\n');
console.log('TOP 30 drift-neutral (BUY and SELL each beat a coin flip, in both halves)\n');
console.table(solid.slice(0, 30));
console.log('\nfor contrast — TOP 10 by raw net, the way pass one ranked them:\n');
console.table(results.slice().sort((a, b) => b.rawNet - a.rawNet).slice(0, 10));
