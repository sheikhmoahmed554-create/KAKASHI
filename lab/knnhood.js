'use strict';
// Survivor counts at every level came out at chance, so a single winning cell
// proves nothing on its own. What separates a real edge from a lucky cell is the
// NEIGHBOURHOOD: if the length that won is real, the lengths either side of it
// and the plans either side of it should lean positive too. Noise has no
// neighbours.
const fs = require('fs');
const key = r => [r.tf, r.line, r.len, r.sig, r.plan].join('|');
const Y = {};
for (const [tag, f] of [['2026', 'knnopt2_2026.json'], ['2021', 'knnopt2_2021.json'], ['2023', 'knnopt2_2023.json']]) {
  const m = new Map();
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) m.set(key(r), r);
  Y[tag] = m;
}
const YRS = ['2026', '2021', '2023'];
const SMOOTH = [8, 12, 15, 19, 22, 28, 34, 40, 51, 70, 100];
const PLANS = ['90/90', '120/90', '90/120', '60/60', '150/100', '120/60', '60/120', '50/50', '70/70'];

// the global positive rate, so a neighbourhood can be judged against it
let gPos = 0, gTot = 0;
for (const [k, a] of Y['2026']) {
  for (const y of YRS) { const r = Y[y].get(k); if (!r) continue; gTot += 2; if (r.buyEdge > 0) gPos++; if (r.sellEdge > 0) gPos++; }
}
const GLOBAL = gPos / gTot;
console.log('across all 35,640 configs x 3 years x 2 sides, an edge is positive ' +
  (100 * GLOBAL).toFixed(1) + '% of the time. That is the number to beat.\n');

function hood(tf, line, sig, len, plan) {
  // every length and every plan around the candidate, all three years, both sides
  const li = SMOOTH.indexOf(len), pi = PLANS.indexOf(plan);
  const lens = SMOOTH.slice(Math.max(0, li - 1), li + 2);
  const plans = PLANS.slice();               // the plan axis has no natural order
  let pos = 0, tot = 0, sum = 0;
  for (const L of lens) for (const P of plans) {
    const k = [tf, line, L, sig, P].join('|');
    for (const y of YRS) {
      const r = Y[y].get(k); if (!r) continue;
      tot += 2; sum += r.buyEdge + r.sellEdge;
      if (r.buyEdge > 0) pos++; if (r.sellEdge > 0) pos++;
    }
  }
  return { cells: tot / 2, posRate: tot ? +(100 * pos / tot).toFixed(1) : 0, avgEdge: tot ? +(sum / tot).toFixed(2) : 0 };
}

const CANDIDATES = [
  ['1H', 'T3', 'REJ', 34, '120/90'],
  ['1H', 'T3', 'BOTH', 34, '120/90'],
  ['15m', 'DEMA', 'REJ', 28, '90/120'],
  ['15m', 'VIDYA', 'REJ', 40, '120/60'],
  ['2m', 'LSMA', 'REJ', 40, '90/120'],
  ['30m', 'T3', 'BOTH', 8, '120/60'],
  ['30m', 'SSF', 'REJ', 15, '120/60'],
  ['3m', 'TEMA', 'REJ', 22, '90/120'],
  ['30m', 'VIDYA', 'REJ', 51, '150/100'],   // the 2026-only champion, as a control
  ['15m', 'KNN', 'REJ', 51, '90/90'],       // the indicator's own line
];
const rows = [];
for (const [tf, line, sig, len, plan] of CANDIDATES) {
  const h = hood(tf, line, sig, len, plan);
  const a = Y['2026'].get([tf, line, len, sig, plan].join('|'));
  const b = Y['2021'].get([tf, line, len, sig, plan].join('|'));
  const c = Y['2023'].get([tf, line, len, sig, plan].join('|'));
  rows.push({ config: tf + ' ' + line + ' ' + len + ' ' + sig + ' ' + plan,
    perDay: a.perDay,
    worstEdge: +Math.min(a.buyEdge, a.sellEdge, b.buyEdge, b.sellEdge, c.buyEdge, c.sellEdge).toFixed(2),
    hoodCells: h.cells, hoodPosRate: h.posRate, hoodAvgEdge: h.avgEdge,
    net26: a.rawNet, net21: b.rawNet, net23: c.rawNet,
    lift: +(h.posRate - 100 * GLOBAL).toFixed(1) });
}
rows.sort((x, y) => y.hoodPosRate - x.hoodPosRate);
console.log('neighbourhood test — lengths either side x all nine plans x three years x both sides:\n');
console.table(rows);

// and the same question asked the other way: which (tf,line,sig) family has the
// best neighbourhood overall, regardless of which single cell won?
const fam = new Map();
for (const [k, a] of Y['2026']) {
  const [tf, line, len, sig] = k.split('|');
  const fk = tf + ' ' + line + ' ' + sig;
  if (!fam.has(fk)) fam.set(fk, { pos: 0, tot: 0, sum: 0, perDay: 0, nc: 0 });
  const f = fam.get(fk);
  for (const y of YRS) {
    const r = Y[y].get(k); if (!r) continue;
    f.tot += 2; f.sum += r.buyEdge + r.sellEdge;
    if (r.buyEdge > 0) f.pos++; if (r.sellEdge > 0) f.pos++;
  }
  f.perDay += a.perDay; f.nc++;
}
const frows = [...fam.entries()].filter(([, f]) => f.tot >= 300)
  .map(([k, f]) => ({ family: k, cells: f.tot / 2, posRate: +(100 * f.pos / f.tot).toFixed(1),
    avgEdge: +(f.sum / f.tot).toFixed(2), avgPerDay: +(f.perDay / f.nc).toFixed(1) }))
  .sort((a, b) => b.posRate - a.posRate);
console.log('\nbest families by neighbourhood positive rate (all lengths, all plans, all three years):\n');
console.table(frows.slice(0, 20));
console.log('\nworst five, for scale:\n');
console.table(frows.slice(-5));
