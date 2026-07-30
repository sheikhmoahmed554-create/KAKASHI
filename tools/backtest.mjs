// تشغيل المؤشر خارج المتصفح لاختبار أي تعديل بسرعة.
//   node tools/backtest.mjs <lab.html> <file.pine> [عدد الأيام] [YYYY-MM-DD البداية]
// يقرأ المحرك وداتا 2026 المدمجة من صفحة المختبر نفسها، ويشغّل نفس كود الـ worker،
// فأي نتيجة هنا هي نفس نتيجة الصفحة.
import fs from 'node:fs';
import zlib from 'node:zlib';

const [pagePath, pinePath, daysArg, startArg] = process.argv.slice(2);
if (!pagePath || !pinePath) {
  console.error('الاستخدام: node tools/backtest.mjs <lab.html> <file.pine> [أيام] [YYYY-MM-DD]');
  process.exit(1);
}

const page = fs.readFileSync(pagePath, 'utf8');
const core = Buffer.from(page.match(/const CORE_B64="([^"]*)"/)[1], 'base64').toString('utf8');
const workerBody = page
  .slice(page.indexOf('function makeWorker(){const code=`') + 'function makeWorker(){const code=`'.length,
         page.indexOf('`;return new Worker'))
  .replace('${b64Text(CORE_B64)}', '');

const messages = [];
globalThis.self = { onmessage: null, postMessage: m => messages.push(m) };
(0, eval)(core);
(0, eval)(workerBody);

const csv = zlib.gunzipSync(Buffer.from(page.match(/BUILTIN_2026_GZ_B64='([^']*)'/)[1], 'base64')).toString('utf8');
const all = PineLabJS.parseCSV(csv);
const day = ms => Math.floor(ms / 86400000);
const from = startArg ? day(Date.parse(startArg + 'T00:00:00Z')) : day(all[0].time);
const span = Number(daysArg || 5);
const rows = all.filter(r => day(r.time) >= from && day(r.time) < from + span);
if (!rows.length) {
  console.error('لا توجد شموع في هذا النطاق.');
  process.exit(1);
}

console.log(`${rows.length} شمعة • ${new Date(rows[0].time).toISOString()} → ${new Date(rows[rows.length - 1].time).toISOString()}`);
self.onmessage({ data: {
  source: fs.readFileSync(pinePath, 'utf8'), rows, inputs: {},
  lot: 0.02, dpp: 20, warmup: 0, profile: 'TV_SESSION_22_23', fragileThreshold: 0.5,
} });

for (const p of messages.filter(m => m.type === 'progress')) {
  console.log(`  ${p.day}  ${p.day_index}/${p.total_days}  صفقات ${String(p.daily.trades).padStart(3)}  ` +
    `${p.daily.wins}W/${p.daily.losses}L  WR ${p.daily.win_rate.toFixed(1)}%  ` +
    `صافي اليوم ${p.daily.net_points}  التراكمي ${p.cumulative.net_points}`);
}
const done = messages.find(m => m.type === 'done');
if (!done.ok) {
  console.error('خطأ:', done.error);
  process.exit(1);
}
console.log('الملخص:', JSON.stringify(done.summary));
console.log(`صفقات مسجلة ${done.trades.length} • شموع ${done.bars_processed} • ${done.runtime_seconds}s • هش ${done.fragile_wins}`);
