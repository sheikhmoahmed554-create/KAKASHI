// اختبار A/B على مفاتيح SYR30 نفسه، بنفس كود الـ worker الموجود في صفحة V16.
//   node research/tools/abtest.mjs <اسم النسخة> <ملف الخرج.json> [ملف .pine بديل]
// النسخ معرّفة في VARIANTS تحت. الخرج: ملخص الست شهور + تقسيم تدريب/اختبار.
import fs from 'node:fs';
import zlib from 'node:zlib';

const PAGE = 'KAKASHI_V16_TV_PARITY_AUDIT.html';
const TRAIN_END = Date.parse('2026-05-01T00:00:00Z'); // تدريب: يناير–أبريل، اختبار: مايو–يوليو

// المدارس المطفية بالافتراضي، ومفتاح بولنجر+كلتنر الذي أثبتت التجربة ٠١٦ خسارته.
const OFF_SCHOOLS = {
  fusionUseMomentum: true, fusionUseQQEVortex: true,
  syr30UseBalance: true, syr30UseAsia: true, syr30UseDeadAuction: true,
};
// قيد صاحب المشروع: أقل هدف ٣٠ نقطة، والوقف لا يتجاوز الهدف + ٢٠.
// خطة ٣٠/٥٠ هي الوحيدة التي أعطت حافة موجبة في التجربة ٠٠٢، والوقف فيها = الهدف + ٢٠ بالضبط.
const FIX_30_50 = {
  daeUseContextProfiles: false,
  daeMinTargetPts: 30, daeMaxTargetPts: 30, daeBaseTargetPts: 30,
  daeMinStopPts: 50, daeMaxStopPts: 50,
  daeRangeTargetCap: 30, daeCounterTargetCap: 30, daeLateTargetCap: 30,
};
// نفس السقف لكن مع إبقاء بنية الخطة التكيّفية شغالة — تضييق ملفات R16 فقط.
const CONTEXT_30_50 = {
  daeBuyAlignedTargetPts: 30, daeBuyAlignedStopPts: 50,
  daeSellAlignedTargetPts: 30, daeSellAlignedStopPts: 50,
  daeBuyLateTargetPts: 30, daeBuyLateStopPts: 50,
  daeSellLateTargetPts: 30, daeSellLateStopPts: 50,
};
const VARIANTS = {
  A_baseline: {},
  B_no_bbkc: { fusionUseBBKC: false },
  C_schools_on: { ...OFF_SCHOOLS },
  G_context_30_50: { ...CONTEXT_30_50 },
  H_fixed_30_50: { ...FIX_30_50 },
  I_fixed_no_bbkc: { ...FIX_30_50, fusionUseBBKC: false },
  J_fixed_no_bbkc_schools: { ...FIX_30_50, fusionUseBBKC: false, ...OFF_SCHOOLS },
  D_s09_fixed: {},          // يحتاج ملف pine معدّل، بلا تغيير مدخلات
};

const [variant, outPath, pineOverride] = process.argv.slice(2);
if (!VARIANTS[variant]) {
  console.error('النسخ المتاحة: ' + Object.keys(VARIANTS).join(', '));
  process.exit(1);
}

const page = fs.readFileSync(PAGE, 'utf8');
const core = Buffer.from(page.match(/const CORE_B64="([^"]*)"/)[1], 'base64').toString('utf8');
const head = 'function makeWorker(){const code=`';
const workerBody = page.slice(page.indexOf(head) + head.length, page.indexOf('`;return new Worker'))
  .replace('${b64Text(CORE_B64)}', '');
const source = pineOverride
  ? fs.readFileSync(pineOverride, 'utf8')
  : Buffer.from(page.match(/const SOURCE_B64="([^"]*)"/)[1], 'base64').toString('utf8');

const messages = [];
globalThis.self = { onmessage: null, postMessage: m => messages.push(m) };
(0, eval)(core);
(0, eval)(workerBody);

let rows = PineLabJS.parseCSV(
  zlib.gunzipSync(Buffer.from(page.match(/BUILTIN_2026_GZ_B64='([^']*)'/)[1], 'base64')).toString('utf8'));
if (process.env.DAYS) { // اختبار سريع أثناء التطوير فقط
  const d0 = Math.floor(rows[0].time / 86400000);
  rows = rows.filter(r => Math.floor(r.time / 86400000) < d0 + Number(process.env.DAYS));
}
console.error(`[${variant}] ${rows.length} شمعة، بدأ التشغيل…`);

const t0 = Date.now();
self.onmessage({ data: {
  source, rows, inputs: VARIANTS[variant],
  lot: 0.02, dpp: 20, warmup: 0, profile: 'TV_SESSION_22_23', fragileThreshold: 0.5,
} });
const done = messages.find(m => m.type === 'done');
if (!done.ok) {
  console.error(`[${variant}] خطأ: ${done.error}`);
  process.exit(1);
}

// نقسم الصفقات المسجّلة على فترتي التدريب والاختبار ونحسب كل فترة وحدها.
const split = t => Date.parse(t.entry_time) < TRAIN_END ? 'train' : 'test';
const half = list => {
  const wins = list.filter(t => t.outcome === 'WIN').length;
  const net = list.reduce((a, t) => a + (Number(t.points) || 0), 0);
  const days = new Set(list.map(t => t.entry_time.slice(0, 10))).size;
  return {
    trades: list.length, wins, losses: list.length - wins,
    win_rate: list.length ? +(100 * wins / list.length).toFixed(2) : 0,
    net_points: +net.toFixed(1),
    per_trade: list.length ? +(net / list.length).toFixed(3) : 0,
    per_day: days ? +(list.length / days).toFixed(1) : 0,
  };
};
const out = {
  variant, inputs: VARIANTS[variant], pine: pineOverride || 'embedded',
  runtime_seconds: +((Date.now() - t0) / 1000).toFixed(1),
  bars: done.bars_processed, summary: done.summary,
  train: half(done.trades.filter(t => split(t) === 'train')),
  test: half(done.trades.filter(t => split(t) === 'test')),
};
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.error(`[${variant}] تم في ${out.runtime_seconds}s — ` +
  `تدريب ${out.train.trades}/${out.train.win_rate}% • اختبار ${out.test.trades}/${out.test.win_rate}%`);
