// اختبار على السوق الحالي فقط: النصف الثاني من ٢٠٢٥ و٢٠٢٦ كاملة.
//   node research/tools/test_current.mjs <من> <إلى> <الخرج.json>
//
// قرار منهجي من صاحب المشروع: لا نضبط المؤشر على أنظمة سوقية لن تعود
// (ATR ٤ نقاط في ٢٠٢١ مقابل ٢٣ اليوم). نضبطه على ما نتداوله فعلاً.
// ولا بوابة إسكات: المؤشر يتكلّم، لكن بحكمة — نبحث عن أسباب الدخول لا عن منعه.
import fs from 'node:fs';
import zlib from 'node:zlib';

const PAGE = 'KAKASHI_V16_TV_PARITY_AUDIT.html';
const PINE = 'research/variants/SYR30_PLUS.pine';
const PERIODS = [
  { name: '2025-H2', year: '2025', from: '2025-07-01T00:00', to: '2026-01-01T00:00' },
  { name: '2026', year: '2026', from: '2026-01-01T00:00', to: '2026-07-18T00:00' },
];

const CONFIGS = [
  ['بلا إضافات', {}],
  ['مسار الشمعة', { kkUsePath: true }],
  ['موضع الإغلاق ≤40٪', { kkUseClosePos: true, kkCloseMaxPct: 40 }],
  ['أربع شموع متتالية', { kkUseRunFilter: true, kkMinRedRun: 4 }],
  ['سحب نافذة 20', { kkUseLongSweep: true }],
  ['ستوب أكبر من الهدف', { kkUseStopGap: true }],
  ['مسار + إغلاق40', { kkUsePath: true, kkUseClosePos: true, kkCloseMaxPct: 40 }],
  ['مسار + ستوب', { kkUsePath: true, kkUseStopGap: true }],
  ['مسار + إغلاق40 + ستوب', { kkUsePath: true, kkUseClosePos: true, kkCloseMaxPct: 40, kkUseStopGap: true }],
  ['مسار + سحب20 + ستوب', { kkUsePath: true, kkUseLongSweep: true, kkUseStopGap: true }],
];

const page = fs.readFileSync(PAGE, 'utf8');
const core = Buffer.from(page.match(/const CORE_B64="([^"]*)"/)[1], 'base64').toString('utf8');
const head = 'function makeWorker(){const code=`';
const workerBody = page.slice(page.indexOf(head) + head.length, page.indexOf('`;return new Worker'))
  .replace('${b64Text(CORE_B64)}', '');
const source = fs.readFileSync(PINE, 'utf8');
const messages = [];
globalThis.self = { onmessage: null, postMessage: m => messages.push(m) };
(0, eval)(core);
(0, eval)(workerBody);

const vault = zlib.gunzipSync(fs.readFileSync('research/data/vault_utc.csv.gz')).toString('utf8').split('\n');
const cache = {};
for (const p of PERIODS) {
  const from = new Date(Date.parse(p.from + 'Z') - 12 * 86400000).toISOString().slice(0, 10);
  const kept = [vault[0]];
  for (let i = 1; i < vault.length; i++) {
    const d = vault[i].slice(0, 10);
    if (d >= from && d < p.to.slice(0, 10)) kept.push(vault[i]);
  }
  cache[p.name] = PineLabJS.parseCSV(kept.join('\n'));
}
console.error('الشموع: ' + PERIODS.map(p => `${p.name}:${cache[p.name].length}`).join(' '));

const run = (inputs, p) => {
  messages.length = 0;
  self.onmessage({ data: {
    source, rows: cache[p.name], inputs, lot: 0.02, dpp: 20,
    profile: 'TV_SESSION_22_23', fragileThreshold: 0.5,
    start: p.from, end: p.to, warmup: 5000,
  } });
  const done = messages.find(m => m.type === 'done');
  if (!done || !done.ok) return null;
  const t = done.trades.filter(x => Number.isFinite(Date.parse(x.entry_time)));
  if (!t.length) return null;
  const wins = t.filter(x => x.outcome === 'WIN').length;
  const net = t.reduce((a, x) => a + (Number(x.points) || 0), 0);
  const days = new Set(t.map(x => x.entry_time.slice(0, 10))).size;
  // الشهور الرابحة: مقياس المتانة الحقيقي داخل النظام الحالي
  const bym = {};
  for (const x of t) {
    const k = x.entry_time.slice(0, 7);
    bym[k] = (bym[k] || 0) + (Number(x.points) || 0);
  }
  const months = Object.values(bym);
  return { trades: t.length, wins, losses: t.length - wins,
           win_rate: +(100 * wins / t.length).toFixed(2),
           net_points: Math.round(net), per_trade: +(net / t.length).toFixed(3),
           per_day: +(t.length / days).toFixed(1),
           months_won: months.filter(x => x > 0).length, months: months.length };
};

const [a, b, out] = process.argv.slice(2);
const res = {};
for (let i = Number(a); i < Math.min(Number(b), CONFIGS.length); i++) {
  const [name, inputs] = CONFIGS[i];
  const e = {};
  for (const p of PERIODS) {
    const r = run(inputs, p);
    if (r) e[p.name] = r;
  }
  res[name] = e;
  const cell = p => e[p.name]
    ? `${e[p.name].trades} صفقة ${e[p.name].wins}ر/${e[p.name].losses}خ ${e[p.name].win_rate}% ${e[p.name].months_won}/${e[p.name].months} شهر`
    : '—';
  console.error(`${name.padEnd(24)} ${PERIODS.map(cell).join('  |  ')}`);
}
fs.writeFileSync(out, JSON.stringify(res, null, 1));
