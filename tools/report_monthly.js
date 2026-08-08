'use strict';
/*
 * Month-by-month breakdown of a backtest run.
 *
 * Usage: node tools/report_monthly.js <trades.json> [--lot 0.02] [--usd-per-point 20]
 *
 * The dollar column uses the convention carried in the older KAKASHI builds —
 * 0.02 lots and 20 USD per point at 1.0 lot. Points are the ground truth; the
 * dollar figure only rescales them, so correct the two flags if your broker's
 * contract size differs.
 */
const fs = require('fs');

const argv = process.argv.slice(2);
const file = argv[0];
if (!file) { console.error('usage: node tools/report_monthly.js <trades.json>'); process.exit(1); }
const flag = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? Number(argv[i + 1]) : def; };
const LOT = flag('--lot', 0.02);
const USD_PER_POINT_LOT1 = flag('--usd-per-point', 20);
const usd = pts => pts * LOT * USD_PER_POINT_LOT1;

const { trades } = JSON.parse(fs.readFileSync(file, 'utf8'));
const fmt = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '—';
const month = t => new Date(t.entryTime).toISOString().slice(0, 7);

function stats(list) {
  let wins = 0, gw = 0, gl = 0, net = 0, peak = 0, eq = 0, dd = 0, curL = 0, maxL = 0;
  for (const t of list) {
    net += t.points; eq += t.points;
    if (eq > peak) peak = eq;
    if (peak - eq > dd) dd = peak - eq;
    if (t.points > 0) { wins++; gw += t.points; curL = 0; }
    else { gl += Math.abs(t.points); curL++; if (curL > maxL) maxL = curL; }
  }
  return {
    n: list.length, wins, losses: list.length - wins,
    wr: list.length ? (100 * wins) / list.length : 0,
    net, pf: gl > 0 ? gw / gl : Infinity, dd, maxL,
  };
}

function render(rows, cols) {
  const w = cols.map(c => Math.max(c.label.length, ...rows.map(r => String(c.get(r)).length)));
  const line = cells => cells.map((c, i) => String(c).padStart(w[i])).join('  ');
  console.log(line(cols.map(c => c.label)));
  console.log(w.map(x => '─'.repeat(x)).join('  '));
  for (const r of rows) console.log(line(cols.map(c => c.get(r))));
}

// ── month by month ───────────────────────────────────────────────────────────
const byMonth = new Map();
for (const t of trades) {
  const k = month(t);
  if (!byMonth.has(k)) byMonth.set(k, []);
  byMonth.get(k).push(t);
}
const months = [...byMonth.keys()].sort();

let cum = 0;
const rows = months.map(m => {
  const s = stats(byMonth.get(m));
  cum += s.net;
  return { m, ...s, cum };
});

console.log('\nنتيجة كل شهر — AI 963 V12 على XAUUSD 1m\n');
render(rows, [
  { label: 'الشهر', get: r => r.m },
  { label: 'صفقات', get: r => r.n },
  { label: 'ربح', get: r => r.wins },
  { label: 'خسارة', get: r => r.losses },
  { label: 'نسبة%', get: r => fmt(r.wr, 1) },
  { label: 'صافي نقاط', get: r => (r.net > 0 ? '+' : '') + fmt(r.net, 0) },
  { label: 'دولار', get: r => (r.net > 0 ? '+' : '') + fmt(usd(r.net), 0) },
  { label: 'PF', get: r => fmt(r.pf, 2) },
  { label: 'تراجع', get: r => fmt(r.dd, 0) },
  { label: 'سلسلة خسارة', get: r => r.maxL },
  { label: 'تراكمي', get: r => (r.cum > 0 ? '+' : '') + fmt(r.cum, 0) },
]);

const total = stats(trades);
console.log('\n' + '─'.repeat(40));
console.log(`الإجمالي   : ${total.n} صفقة`);
console.log(`صافي النقاط: ${total.net > 0 ? '+' : ''}${fmt(total.net, 0)}  (${fmt(usd(total.net), 0)} دولار عند لوت ${LOT})`);
console.log(`أشهر رابحة : ${rows.filter(r => r.net > 0).length} من ${rows.length}`);

// ── source by month, net points ──────────────────────────────────────────────
const sources = [...new Set(trades.map(t => t.source))];
const grid = new Map();
for (const t of trades) {
  const k = t.source + '|' + month(t);
  grid.set(k, (grid.get(k) || 0) + t.points);
}

console.log('\n\nصافي نقاط كل مصدر في كل شهر\n');
const srcRows = sources.map(s => {
  const row = { src: s, total: 0 };
  for (const m of months) {
    const v = grid.get(s + '|' + m) || 0;
    row[m] = v;
    row.total += v;
  }
  return row;
}).sort((a, b) => b.total - a.total);

render(srcRows, [
  { label: 'المصدر', get: r => r.src },
  ...months.map(m => ({ label: m.slice(5), get: r => (r[m] > 0 ? '+' : '') + r[m].toFixed(0) })),
  { label: 'المجموع', get: r => (r.total > 0 ? '+' : '') + r.total.toFixed(0) },
]);

// ── how many months each source was positive: consistency beats one lucky run ─
console.log('\n\nثبات كل مصدر — كم شهر كان رابحًا\n');
render(srcRows.map(r => {
  const wins = months.filter(m => r[m] > 0).length;
  const vals = months.map(m => r[m]);
  const best = Math.max(...vals), worst = Math.min(...vals);
  return { src: r.src, wins, n: months.length, best, worst, total: r.total };
}), [
  { label: 'المصدر', get: r => r.src },
  { label: 'أشهر رابحة', get: r => `${r.wins}/${r.n}` },
  { label: 'أفضل شهر', get: r => '+' + r.best.toFixed(0) },
  { label: 'أسوأ شهر', get: r => r.worst.toFixed(0) },
  { label: 'المجموع', get: r => (r.total > 0 ? '+' : '') + r.total.toFixed(0) },
]);
console.log();
