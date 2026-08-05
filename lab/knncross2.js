'use strict';
// The strict gate (both sides, both halves, all three years = 18 conditions)
// left nothing. Step the bar down one notch at a time and record exactly where
// the survivors run out — and check every level against what chance alone would
// have produced, so a "survivor" is not mistaken for an edge.
const fs = require('fs');
const key = r => [r.tf, r.line, r.len, r.sig, r.plan].join('|');
const Y = {};
for (const [tag, f] of [['2026', 'knnopt2_2026.json'], ['2021', 'knnopt2_2021.json'], ['2023', 'knnopt2_2023.json']]) {
  const m = new Map();
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) m.set(key(r), r);
  Y[tag] = m;
}
const YRS = ['2026', '2021', '2023'];
const keys = [...Y['2026'].keys()].filter(k => Y['2021'].has(k) && Y['2023'].has(k));
console.log('configs present in all three years: ' + keys.length + '\n');

// per-year pass rates, so every level below can be compared with chance
function rate(test) {
  return YRS.map(y => { let c = 0; for (const k of keys) if (test(Y[y].get(k))) c++; return c / keys.length; });
}
const LEVELS = [
  { name: 'both sides + both halves beat baseline', t: r => r.solid === 'Y' },
  { name: 'both sides beat baseline (halves ignored)', t: r => r.buyEdge > 0 && r.sellEdge > 0 },
  { name: 'BUY side alone beats baseline', t: r => r.buyEdge > 0 },
  { name: 'the pair, summed, beats baseline', t: r => r.buyEdge + r.sellEdge > 0 },
];
const out = [];
for (const L of LEVELS) {
  const pr = rate(L.t);
  const surv = keys.filter(k => YRS.every(y => L.t(Y[y].get(k))));
  out.push({ level: L.name,
    p2026: +(100 * pr[0]).toFixed(2), p2021: +(100 * pr[1]).toFixed(2), p2023: +(100 * pr[2]).toFixed(2),
    survivors: surv.length,
    expectedByChance: +(keys.length * pr[0] * pr[1] * pr[2]).toFixed(1) });
}
console.table(out);

// where does the best config actually stand? rank by the worst of its six edges
const scored = keys.map(k => {
  const a = Y['2026'].get(k), b = Y['2021'].get(k), c = Y['2023'].get(k);
  const e = [a.buyEdge, a.sellEdge, b.buyEdge, b.sellEdge, c.buyEdge, c.sellEdge];
  return { tf: a.tf, line: a.line, len: a.len, sig: a.sig, plan: a.plan, perDay: a.perDay,
    b26: a.buyEdge, s26: a.sellEdge, b21: b.buyEdge, s21: b.sellEdge, b23: c.buyEdge, s23: c.sellEdge,
    worst: +Math.min(...e).toFixed(2), sum: +e.reduce((x, y) => x + y, 0).toFixed(2) };
}).sort((x, y) => y.worst - x.worst);
console.log('\nranked by the WEAKEST of the six side-year edges — the honest measure:\n');
console.table(scored.slice(0, 20));

console.log('\nsame ranking, restricted to scalping volume (>=25 signals/day):\n');
console.table(scored.filter(r => r.perDay >= 25).slice(0, 15));
