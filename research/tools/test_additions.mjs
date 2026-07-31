// يختبر إضافات KAKASHI على المؤشر: كل إضافة وحدها، ثم مجتمعة.
//   node research/tools/test_additions.mjs <من> <إلى> <الخرج.json>
//
// كل الإضافات مطفأة افتراضياً، فأول صف («بلا إضافات») يجب أن يطابق النسخة
// النظيفة تماماً — وهو تحقق ذاتي: لو اختلف فالإضافة تسرّبت إلى المسار الافتراضي.
import fs from 'node:fs';
import zlib from 'node:zlib';

const PAGE = 'KAKASHI_V16_TV_PARITY_AUDIT.html';
const PINE = 'research/variants/SYR30_PLUS.pine';
const SLICES = [
  { name: '2025-04', from: '2025-04-01T00:00', to: '2025-05-01T00:00' },
  { name: '2026-06', from: '2026-06-01T00:00', to: '2026-07-01T00:00' },
  { name: '2023-09', from: '2023-09-01T00:00', to: '2023-10-01T00:00' },
];

const ONE = {
  'بوابة التذبذب ATR≥30': { kkUseSpeedGate: true },
  'بوابة التذبذب ATR≥20': { kkUseSpeedGate: true, kkMinAtrPts: 20 },
  'بوابة التذبذب ATR≥40': { kkUseSpeedGate: true, kkMinAtrPts: 40 },
  'موضع الإغلاق ≤20٪': { kkUseClosePos: true },
  'موضع الإغلاق ≤40٪': { kkUseClosePos: true, kkCloseMaxPct: 40 },
  'شمعتان متتاليتان': { kkUseRunFilter: true, kkMinRedRun: 2 },
  'ثلاث شموع متتالية': { kkUseRunFilter: true, kkMinRedRun: 3 },
  'أربع شموع متتالية': { kkUseRunFilter: true, kkMinRedRun: 4 },
  'مسار الشمعة': { kkUsePath: true },
  'بركة سيولة متساوية': { kkUsePool: true },
  'سحب نافذة 20': { kkUseLongSweep: true },
  'سحب نافذة 60': { kkUseLongSweep: true, kkSweepLen: 60 },
  'سحب نافذة 20 عمق 1.3': { kkUseLongSweep: true, kkSweepMinATR: 1.3 },
  'كفاءة الحركة ≤0.20': { kkUseER: true },
  'كفاءة الحركة ≤0.35': { kkUseER: true, kkERMax: 0.35 },
};
const CONFIGS = [['بلا إضافات', {}], ...Object.entries(ONE)];

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
for (const s of SLICES) {
  const y = s.from.slice(0, 4);
  const kept = [vault[0]];
  for (let i = 1; i < vault.length; i++) if (vault[i].startsWith(y)) kept.push(vault[i]);
  cache[s.name] = PineLabJS.parseCSV(kept.join('\n'));
}

const run = (inputs, slice) => {
  messages.length = 0;
  self.onmessage({ data: {
    source, rows: cache[slice.name], inputs, lot: 0.02, dpp: 20,
    profile: 'TV_SESSION_22_23', fragileThreshold: 0.5,
    start: slice.from, end: slice.to, warmup: 5000,
  } });
  const done = messages.find(m => m.type === 'done');
  if (!done || !done.ok) return null;
  const t = done.trades.filter(x => Number.isFinite(Date.parse(x.entry_time)));
  if (t.length < 25) return { trades: t.length, thin: true };
  const wins = t.filter(x => x.outcome === 'WIN').length;
  const net = t.reduce((a, x) => a + (Number(x.points) || 0), 0);
  const days = new Set(t.map(x => x.entry_time.slice(0, 10))).size;
  return { trades: t.length, win_rate: +(100 * wins / t.length).toFixed(2),
           per_trade: +(net / t.length).toFixed(3), per_day: +(t.length / days).toFixed(1) };
};

const [a, b, out] = process.argv.slice(2);
const res = {};
for (let i = Number(a); i < Math.min(Number(b), CONFIGS.length); i++) {
  const [name, inputs] = CONFIGS[i];
  const e = {};
  for (const s of SLICES) {
    const r = run(inputs, s);
    if (r) e[s.name] = r;
  }
  res[name] = e;
  const cell = s => e[s.name] ? (e[s.name].thin
    ? `${e[s.name].trades} صفقة فقط`
    : `${e[s.name].win_rate.toFixed(1)}% ${e[s.name].per_trade >= 0 ? '+' : ''}${e[s.name].per_trade.toFixed(2)} ${e[s.name].per_day}/ي`) : '—';
  console.error(`${name.padEnd(26)} ${SLICES.map(cell).join('  |  ')}`);
}
fs.writeFileSync(out, JSON.stringify(res, null, 1));
