// المرحلة الثانية: دمج الفائزين من كل قسم، وإعادة الاختبار.
//   node research/tools/tune_merge.mjs <الخرج.json>
//
// المرحلة الأولى غيّرت مدخلاً واحداً في كل مرة، فعرفنا أثر كل مدخل منفرداً.
// هنا نأخذ أفضل إعداد من كل قسم، ندمجها، ونعيد القياس — لأن أثر الدمج ليس
// مجموع الآثار المنفردة بالضرورة: قد يعزّز بعضها بعضاً وقد يلغي بعضها بعضاً.
import fs from 'node:fs';
import zlib from 'node:zlib';

const PAGE = 'KAKASHI_V16_TV_PARITY_AUDIT.html';
const PINE = 'research/variants/SYR30_USER_CURRENT.pine';
const SLICES = [
  { name: '2025-04', from: '2025-04-01T00:00', to: '2025-05-01T00:00' },
  { name: '2026-06', from: '2026-06-01T00:00', to: '2026-07-01T00:00' },
  { name: '2023-09', from: '2023-09-01T00:00', to: '2023-10-01T00:00' },  // مقطع ثالث للتثبيت
];

// نفس خريطة المدخلات المستعملة في المرحلة الأولى
const INPUTS = {
  'هدف أساسي 30': { daeBaseTargetPts: 30 },
  'هدف أساسي 40': { daeBaseTargetPts: 40 },
  'هدف أساسي 60': { daeBaseTargetPts: 60 },
  'أقصى هدف 40': { daeMaxTargetPts: 40 },
  'أقصى هدف 70': { daeMaxTargetPts: 70 },
  'أقل هدف 40': { daeMinTargetPts: 40 },
  'ستوب 45–50': { daeMinStopPts: 45, daeMaxStopPts: 50 },
  'ستوب 65–70': { daeMinStopPts: 65, daeMaxStopPts: 70 },
  'بلا ملفات R16': { daeUseContextProfiles: false },
  'بلا خروج تكيّفي': { useDirectionalAdaptiveExit: false },
  'هدف ثابت 30 ستوب 50': { useDirectionalAdaptiveExit: false, targetPoints: 30, stopPoints: 50 },
  'هدف ثابت 40 ستوب 55': { useDirectionalAdaptiveExit: false, targetPoints: 40, stopPoints: 55 },
  'سقف الهدف المعاكس 20': { daeCounterTargetCap: 20 },
  'سقف الهدف المتأخر 20': { daeLateTargetCap: 20 },
  'نافذة الستوب الهيكلي 20': { daeStopLookback: 20 },
  'نافذة سيولة الهدف 120': { daeLiquidityLookback: 120 },
  'أفضلية تصويت 2': { fusionMinVoteAdvantage: 2 },
  'أفضلية تصويت 3': { fusionMinVoteAdvantage: 3 },
  'إقفال BB/KC': { fusionUseBBKC: false },
  'إقفال إيتشيموكو': { fusionUseIchimoku: false },
  'إقفال طبقة المدارس': { useFinalSchoolFusion: false },
  'فتح المدارس المطفية': { syr30UseBalance: true, syr30UseAsia: true, syr30UseDeadAuction: true },
  'أصوات البحث 1': { minVotes: 1.0 },
  'أصوات البحث 3': { minVotes: 3.0 },
  'فريمات 1/3/15': { tfFast: '1', tfMid: '3', tfBig: '15' },
  'فريمات 1/1/1': { tfFast: '1', tfMid: '1', tfBig: '1' },
  'فريمات 1/5/15': { tfFast: '1', tfMid: '5', tfBig: '15' },
  'فيبوناتشي على الدقيقة': { hiddenFibTF: '1' },
  'خروج على الدقيقة': { daeM5TF: '1', daeM15TF: '1' },
  'خصم 5': { discountLevel: 5.0 },
  'خصم 20': { discountLevel: 20.0 },
  'علاوة 95': { premiumLevel: 95.0 },
  'علاوة 75': { premiumLevel: 75.0 },
  'نافذة السحب 12': { baseSweepLookback: 12 },
  'نافذة السحب 3': { baseSweepLookback: 3 },
  'تسامح إعادة الاختبار 0.1': { baseRetestToleranceATR: 0.1 },
  'تسامح إعادة الاختبار 0.5': { baseRetestToleranceATR: 0.5 },
};
const SECTIONS = {
  'الخروج': ['هدف أساسي 30', 'هدف أساسي 40', 'هدف أساسي 60', 'أقصى هدف 40', 'أقصى هدف 70',
             'أقل هدف 40', 'ستوب 45–50', 'ستوب 65–70', 'بلا ملفات R16', 'بلا خروج تكيّفي',
             'هدف ثابت 30 ستوب 50', 'هدف ثابت 40 ستوب 55', 'سقف الهدف المعاكس 20',
             'سقف الهدف المتأخر 20', 'نافذة الستوب الهيكلي 20', 'نافذة سيولة الهدف 120'],
  'الراوتر': ['أفضلية تصويت 2', 'أفضلية تصويت 3', 'إقفال BB/KC', 'إقفال إيتشيموكو',
              'إقفال طبقة المدارس', 'فتح المدارس المطفية', 'أصوات البحث 1', 'أصوات البحث 3'],
  'الفريمات': ['فريمات 1/3/15', 'فريمات 1/1/1', 'فريمات 1/5/15', 'فيبوناتشي على الدقيقة',
               'خروج على الدقيقة'],
  'الدخول': ['خصم 5', 'خصم 20', 'علاوة 95', 'علاوة 75', 'نافذة السحب 12', 'نافذة السحب 3',
             'تسامح إعادة الاختبار 0.1', 'تسامح إعادة الاختبار 0.5'],
};

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
  if (t.length < 30) return null;
  const wins = t.filter(x => x.outcome === 'WIN').length;
  const net = t.reduce((a, x) => a + (Number(x.points) || 0), 0);
  const days = new Set(t.map(x => x.entry_time.slice(0, 10))).size;
  return { trades: t.length, win_rate: +(100 * wins / t.length).toFixed(2),
           per_trade: +(net / t.length).toFixed(3), per_day: +(t.length / days).toFixed(1) };
};

// المرحلة الأولى: نقرأ نتائجها ونختار فائز كل قسم بأضعف مقطع لا بمتوسطه
const stage1 = {};
for (const f of fs.readdirSync('research/results/tune')) {
  if (!f.endsWith('.json') || f.startsWith('merge')) continue;
  Object.assign(stage1, JSON.parse(fs.readFileSync(`research/results/tune/${f}`, 'utf8')));
}
const worst = e => Math.min(...Object.values(e).map(x => x.per_trade));
const baseline = stage1['الأساس — بلا تغيير'];
const baseWorst = baseline ? worst(baseline) : -Infinity;
console.error(`الأساس: أضعف مقطع ${baseWorst.toFixed(2)} نقطة/صفقة\n`);

const winners = {};
for (const [sec, names] of Object.entries(SECTIONS)) {
  const cand = names.filter(n => stage1[n]).map(n => [n, worst(stage1[n])])
    .filter(([, w]) => w > baseWorst).sort((a, b) => b[1] - a[1]);
  if (cand.length) {
    winners[sec] = cand[0][0];
    console.error(`${sec}: أفضل مفرد = ${cand[0][0]} (${cand[0][1].toFixed(2)})`);
  } else {
    console.error(`${sec}: لا مفرد يتفوق على الأساس`);
  }
}

// المرحلة الثانية: الدمج التدريجي — نضيف قسماً في كل خطوة ونعيد القياس
const order = Object.keys(winners);
const res = { stage1_winners: winners, merged: {} };
let acc = {};
const label = [];
for (let k = 0; k <= order.length; k++) {
  if (k > 0) {
    Object.assign(acc, INPUTS[winners[order[k - 1]]]);
    label.push(order[k - 1]);
  }
  const name = k === 0 ? 'الأساس' : label.join(' + ');
  const e = {};
  for (const s of SLICES) {
    const r = run({ ...acc }, s);
    if (r) e[s.name] = r;
  }
  res.merged[name] = e;
  console.error(`${name.padEnd(46)} ` +
    SLICES.map(s => e[s.name] ? `${e[s.name].win_rate.toFixed(1)}% ${e[s.name].per_trade >= 0 ? '+' : ''}${e[s.name].per_trade.toFixed(2)}` : '—').join('  |  '));
}
fs.writeFileSync(process.argv[2], JSON.stringify(res, null, 1));
