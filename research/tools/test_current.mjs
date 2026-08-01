// اختبار على السوق الحالي فقط: النصف الثاني من ٢٠٢٥ و٢٠٢٦ كاملة.
//   node research/tools/test_current.mjs <فترة> <من> <إلى> <الخرج.json>
//
// قرار منهجي من صاحب المشروع: لا نضبط المؤشر على أنظمة سوقية لن تعود
// (ATR ٤ نقاط في ٢٠٢١ مقابل ٢٣ اليوم). نضبطه على ما نتداوله فعلاً.
// ولا بوابة إسكات: المؤشر يتكلّم، لكن بحكمة — نبحث عن أسباب الدخول لا عن منعه.
//
// نمشي شهراً شهراً: تمرير سنة كاملة دفعة واحدة يستنفد ذاكرة المحرك. الشهر
// وحده مع ١٢ يوم إحماء يعطي نفس الصفقات لأن حالة المؤشر تُبنى في الإحماء.
import fs from 'node:fs';
import zlib from 'node:zlib';

const PAGE = 'KAKASHI_V16_TV_PARITY_AUDIT.html';
const PINE = 'research/variants/SYR30_PLUS.pine';

const MONTHS = {
  '2025-H2': ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12'],
  '2026': ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'],
};

const DEFAULT_CONFIGS = [
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

// الموجة الثانية تُمرَّر كملف، فلا يُنسخ المشغّل مرة لكل موجة
const [period, a, b, out, cfgFile] = process.argv.slice(2);
const CONFIGS = cfgFile
  ? Object.entries(JSON.parse(fs.readFileSync(cfgFile, 'utf8')))
  : DEFAULT_CONFIGS;
const months = MONTHS[period];

// الحاوية تُعاد كل عشر دقائق، فكلفة الإقلاع تتكرّر. فكّ ضغط الخزنة كاملةً
// (١.٢ مليون شمعة) وقصّها كان يأكل دقيقتين من كل عمر — فالمقاطع تُجهَّز مرة
// واحدة على القرص، والإقلاع بعدها ثوانٍ.
const slicePath = `research/data/slice_${period}.csv`;
const vaultText = fs.existsSync(slicePath)
  ? fs.readFileSync(slicePath, 'utf8')
  : zlib.gunzipSync(fs.readFileSync('research/data/vault_utc.csv.gz')).toString('utf8');

const headLine = vaultText.slice(0, vaultText.indexOf('\n'));
const lo = new Date(Date.parse(months[0] + '-01T00:00Z') - 12 * 86400000).toISOString().slice(0, 10);
const hi = months[months.length - 1] + '-32';
const lines = [];
{
  let p = vaultText.indexOf('\n') + 1;
  while (p < vaultText.length) {
    let e = vaultText.indexOf('\n', p);
    if (e < 0) e = vaultText.length;
    const d = vaultText.slice(p, p + 10);
    if (d >= lo && d <= hi) lines.push(vaultText.slice(p, e));
    p = e + 1;
  }
}
console.error(`${period}: ${lines.length} سطر محفوظ`);

const monthRows = m => {
  const from = new Date(Date.parse(m + '-01T00:00Z') - 12 * 86400000).toISOString().slice(0, 10);
  const to = new Date(Date.parse(m + '-01T00:00Z') + 32 * 86400000).toISOString().slice(0, 7) + '-01';
  const kept = [headLine];
  for (const ln of lines) {
    const d = ln.slice(0, 10);
    if (d >= from && d < to) kept.push(ln);
  }
  return { rows: PineLabJS.parseCSV(kept.join('\n')), start: m + '-01T00:00', end: to + 'T00:00' };
};

// الحاوية تُعاد فتُقتل العمليات، فنستأنف من الشهر الذي وقفنا عنده بدل البدء من الصفر
let res = {};
try {
  res = JSON.parse(fs.readFileSync(out, 'utf8'));
  const done = Object.values(res).reduce((n, e) => n + Object.keys(e.months || {}).length, 0);
  if (done) console.error(`استئناف: ${done} شهراً محسوباً من قبل`);
} catch { res = {}; }

for (const m of months) {
  const need = [];
  for (let i = Number(a); i < Math.min(Number(b), CONFIGS.length); i++) {
    if (!res[CONFIGS[i][0]]?.months?.[m]) need.push(i);
  }
  if (!need.length) { console.error(`${m} محسوب سلفاً`); continue; }
  const { rows, start, end } = monthRows(m);
  for (const i of need) {
    const [name, inputs] = CONFIGS[i];
    messages.length = 0;
    self.onmessage({ data: {
      source, rows, inputs, lot: 0.02, dpp: 20,
      profile: 'TV_SESSION_22_23', fragileThreshold: 0.5,
      start, end, warmup: 5000,
    } });
    const done = messages.find(x => x.type === 'done');
    messages.length = 0;
    if (!done || !done.ok) { console.error(`${m} ${name}: فشل`); continue; }
    const t = done.trades.filter(x => Number.isFinite(Date.parse(x.entry_time))
                                      && x.entry_time.slice(0, 7) === m);
    // صفقات الأساس تُحفظ كاملة: مسح آلاف الإعدادات لاحقاً يتم عليها بلا محرك
    if (i === 0 && cfgFile) {
      fs.appendFileSync(out.replace(/\.json$/, '_trades.jsonl'),
        t.map(x => JSON.stringify([x.entry_time, x.side, x.outcome, x.points,
                                   x.target, x.stop, x.source])).join('\n') + '\n');
    }
    const e = res[name] || (res[name] = { months: {} });
    let w = 0, net = 0;
    const days = new Set();
    for (const x of t) {
      if (x.outcome === 'WIN') w++;
      net += Number(x.points) || 0;
      days.add(x.entry_time.slice(0, 10));
    }
    // المجاميع تُشتقّ من الشهور لا من عدّادات جارية، فالاستئناف لا يضاعف ولا ينقص
    e.months[m] = { trades: t.length, wins: w, losses: t.length - w,
                    net: Math.round(net), days: days.size };
    // الحفظ بعد كل تكوين لا بعد الشهر: عمر الحاوية أقصر من الشهر الكامل،
    // فالحفظ المتأخّر كان يضيّع كل ما حُسب قبل الإعادة.
    fs.writeFileSync(out, JSON.stringify(res, null, 1));
    console.error(`${m} ${name.padEnd(24)} ${t.length} صفقة  ${w}ر/${t.length - w}خ  `
      + `${t.length ? (100 * w / t.length).toFixed(2) : '0'}%  ${Math.round(net)} نقطة`);
  }
}

for (const [name, e] of Object.entries(res)) {
  const ms = Object.values(e.months);
  e.trades = ms.reduce((n, x) => n + x.trades, 0);
  e.wins = ms.reduce((n, x) => n + x.wins, 0);
  e.losses = ms.reduce((n, x) => n + x.losses, 0);
  e.net_points = ms.reduce((n, x) => n + x.net, 0);
  const nd = ms.reduce((n, x) => n + (x.days || 0), 0);
  e.win_rate = +(100 * e.wins / Math.max(e.trades, 1)).toFixed(2);
  e.per_day = +(e.trades / Math.max(nd, 1)).toFixed(1);
  e.months_won = ms.filter(x => x.net > 0).length;
  e.months_total = ms.length;
  console.error(`\n${period} ${name.padEnd(24)} ${e.trades} صفقة  ${e.wins}ر/${e.losses}خ  `
    + `${e.win_rate}%  ${e.months_won}/${e.months_total} شهر  ${e.net_points} نقطة`);
}
fs.writeFileSync(out, JSON.stringify(res, null, 1));
