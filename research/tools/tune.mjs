// نافذة ضبط SYR30: تغيير مدخل واحد في كل مرة، وقياس أثره.
//   node research/tools/tune.mjs <من> <إلى> <الخرج.json>
// المدى للتوازي: عدة عمليات تأخذ شرائح مختلفة من قائمة الإعدادات.
//
// يُقاس على مقطعين من نظامين سوقيين مختلفين حتى لا يُضبط المؤشر على شهر واحد:
// أبريل ٢٠٢٥ (تذبذب متوسط) ويونيو ٢٠٢٦ (تذبذب مرتفع). كل مقطع بإحماء ٥٠٠٠ شمعة.
import fs from 'node:fs';
import zlib from 'node:zlib';

const PAGE = 'KAKASHI_V16_TV_PARITY_AUDIT.html';
const PINE = 'research/variants/SYR30_USER_CURRENT.pine';
const SLICES = [
  { name: '2025-04', from: '2025-04-01T00:00', to: '2025-05-01T00:00' },
  { name: '2026-06', from: '2026-06-01T00:00', to: '2026-07-01T00:00' },
];

// مدخل واحد يتغيّر في كل إعداد — لنعرف أيّها يحرّك النتيجة أصلاً
const TUNE = [
  ['الأساس — بلا تغيير', {}],
  // خطة الخروج
  ['هدف أساسي 30', { daeBaseTargetPts: 30 }],
  ['هدف أساسي 40', { daeBaseTargetPts: 40 }],
  ['هدف أساسي 60', { daeBaseTargetPts: 60 }],
  ['أقصى هدف 40', { daeMaxTargetPts: 40 }],
  ['أقصى هدف 70', { daeMaxTargetPts: 70 }],
  ['أقل هدف 40', { daeMinTargetPts: 40 }],
  ['ستوب 45–50', { daeMinStopPts: 45, daeMaxStopPts: 50 }],
  ['ستوب 65–70', { daeMinStopPts: 65, daeMaxStopPts: 70 }],
  ['بلا ملفات R16', { daeUseContextProfiles: false }],
  ['بلا خروج تكيّفي', { useDirectionalAdaptiveExit: false }],
  ['هدف ثابت 30 ستوب 50', { useDirectionalAdaptiveExit: false, targetPoints: 30, stopPoints: 50 }],
  ['هدف ثابت 40 ستوب 55', { useDirectionalAdaptiveExit: false, targetPoints: 40, stopPoints: 55 }],
  ['سقف الهدف المعاكس 20', { daeCounterTargetCap: 20 }],
  ['سقف الهدف المتأخر 20', { daeLateTargetCap: 20 }],
  ['نافذة الستوب الهيكلي 20', { daeStopLookback: 20 }],
  ['نافذة سيولة الهدف 120', { daeLiquidityLookback: 120 }],
  // التصويت والراوتر
  ['أفضلية تصويت 2', { fusionMinVoteAdvantage: 2 }],
  ['أفضلية تصويت 3', { fusionMinVoteAdvantage: 3 }],
  ['إقفال BB/KC', { fusionUseBBKC: false }],
  ['إقفال إيتشيموكو', { fusionUseIchimoku: false }],
  ['إقفال طبقة المدارس', { useFinalSchoolFusion: false }],
  ['فتح المدارس المطفية', { syr30UseBalance: true, syr30UseAsia: true, syr30UseDeadAuction: true }],
  ['أصوات البحث 1', { minVotes: 1.0 }],
  ['أصوات البحث 3', { minVotes: 3.0 }],
  // الفريمات
  ['فريمات 1/3/15', { tfFast: '1', tfMid: '3', tfBig: '15' }],
  ['فريمات 1/1/1', { tfFast: '1', tfMid: '1', tfBig: '1' }],
  ['فريمات 1/5/15', { tfFast: '1', tfMid: '5', tfBig: '15' }],
  ['فيبوناتشي على الدقيقة', { hiddenFibTF: '1' }],
  ['خروج على الدقيقة', { daeM5TF: '1', daeM15TF: '1' }],
  // مناطق الدخول
  ['خصم 5', { discountLevel: 5.0 }],
  ['خصم 20', { discountLevel: 20.0 }],
  ['علاوة 95', { premiumLevel: 95.0 }],
  ['علاوة 75', { premiumLevel: 75.0 }],
  ['نافذة السحب 12', { baseSweepLookback: 12 }],
  ['نافذة السحب 3', { baseSweepLookback: 3 }],
  ['تسامح إعادة الاختبار 0.1', { baseRetestToleranceATR: 0.1 }],
  ['تسامح إعادة الاختبار 0.5', { baseRetestToleranceATR: 0.5 }],
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
const rowsFor = years => {
  const kept = [vault[0]];
  for (let i = 1; i < vault.length; i++) if (years.some(y => vault[i].startsWith(y))) kept.push(vault[i]);
  return PineLabJS.parseCSV(kept.join('\n'));
};
const cache = {};
for (const s of SLICES) cache[s.name] = rowsFor([s.from.slice(0, 4)]);

const run = (rows, inputs, slice) => {
  messages.length = 0;
  self.onmessage({ data: {
    source, rows, inputs, lot: 0.02, dpp: 20, profile: 'TV_SESSION_22_23',
    fragileThreshold: 0.5, start: slice.from, end: slice.to, warmup: 5000,
  } });
  const done = messages.find(m => m.type === 'done');
  if (!done || !done.ok) return null;
  const t = done.trades.filter(x => Number.isFinite(Date.parse(x.entry_time)));
  if (t.length < 30) return null;
  const wins = t.filter(x => x.outcome === 'WIN').length;
  const net = t.reduce((a, x) => a + (Number(x.points) || 0), 0);
  const days = new Set(t.map(x => x.entry_time.slice(0, 10))).size;
  return { trades: t.length, win_rate: +(100 * wins / t.length).toFixed(2),
           per_trade: +(net / t.length).toFixed(3), net_points: Math.round(net),
           per_day: +(t.length / days).toFixed(1) };
};

const [a, b, out] = process.argv.slice(2);
const res = {};
for (let i = Number(a); i < Math.min(Number(b), TUNE.length); i++) {
  const [name, inputs] = TUNE[i];
  const e = {};
  for (const s of SLICES) {
    const r = run(cache[s.name], inputs, s);
    if (r) e[s.name] = r;
  }
  if (Object.keys(e).length === SLICES.length) {
    res[name] = e;
    const p = SLICES.map(s => e[s.name].per_trade);
    const w = SLICES.map(s => e[s.name].win_rate);
    console.error(`${name.padEnd(30)} ` +
      SLICES.map((s, k) => `${w[k].toFixed(1)}% ${p[k] >= 0 ? '+' : ''}${p[k].toFixed(2)}`).join('  |  ') +
      `  ${e[SLICES[1].name].per_day}/يوم`);
  }
}
fs.writeFileSync(out, JSON.stringify(res, null, 1));
