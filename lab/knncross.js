'use strict';
// Intersect the three sweeps. A config only counts if BOTH sides beat their own
// year's drift baseline, in BOTH halves, in ALL THREE years. 2026 alone is a
// fitting exercise; 426 survivors out of 35,640 is roughly what six independent
// coin flips would leave behind on their own.
const fs = require('fs');
const key = r => [r.tf, r.line, r.len, r.sig, r.plan].join('|');
const Y = {};
for (const [tag, file] of [['2026', 'knnopt2_2026.json'], ['2021', 'knnopt2_2021.json'], ['2023', 'knnopt2_2023.json']]) {
  if (!fs.existsSync(file)) { console.log('missing ' + file); continue; }
  const m = new Map();
  for (const r of JSON.parse(fs.readFileSync(file, 'utf8'))) m.set(key(r), r);
  Y[tag] = m;
  console.log(tag + ': ' + m.size + ' configs, ' + [...m.values()].filter(r => r.solid).length + ' solid');
}
const tags = Object.keys(Y);
if (tags.length < 3) { console.log('\nneed all three years'); process.exit(0); }

const rows = [];
for (const [k, a] of Y['2026']) {
  const b = Y['2021'].get(k), c = Y['2023'].get(k);
  if (!b || !c) continue;
  if (!(a.solid === 'Y' && b.solid === 'Y' && c.solid === 'Y')) continue;
  rows.push({ tf: a.tf, line: a.line, len: a.len, sig: a.sig, plan: a.plan,
    perDay: a.perDay,
    buyEdge26: a.buyEdge, sellEdge26: a.sellEdge, net26: a.rawNet,
    buyEdge21: b.buyEdge, sellEdge21: b.sellEdge, net21: b.rawNet,
    buyEdge23: c.buyEdge, sellEdge23: c.sellEdge, net23: c.rawNet,
    worstEdge: +Math.min(a.buyEdge, a.sellEdge, b.buyEdge, b.sellEdge, c.buyEdge, c.sellEdge).toFixed(2),
    edgeSum: +(a.edgeSum + b.edgeSum + c.edgeSum).toFixed(2) });
}
rows.sort((x, y) => y.worstEdge - x.worstEdge);
console.log('\nsurvived all three years on both sides in both halves: ' + rows.length + '\n');
console.table(rows.slice(0, 40));

const scalp = rows.filter(r => r.perDay >= 20).sort((x, y) => y.worstEdge - x.worstEdge);
console.log('\nof those, the ones that also carry scalping volume (>=20 signals/day): ' + scalp.length + '\n');
console.table(scalp.slice(0, 20));
