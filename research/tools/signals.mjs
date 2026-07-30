// يستخرج إشارات SYR30 الخام مرة واحدة لكل الست شهور.
//   node research/tools/signals.mjs <ملف.pine> <الخرج.json>
// نأخذ buySignal و sellSignal لأنهما قبل قيد «صفقة مفتوحة» — فلا يتغيران بتغير خطة الخروج.
// أما canEnterLong/canEnterShort فتحتوي `not active`، فاستعمالها في مسح الخطط يخلط النتيجة
// بتوقيت الخطة الحالية.
import fs from 'node:fs';
import zlib from 'node:zlib';

const [pinePath, outPath] = process.argv.slice(2);
const page = fs.readFileSync('KAKASHI_V16_TV_PARITY_AUDIT.html', 'utf8');
(0, eval)(Buffer.from(page.match(/const CORE_B64="([^"]*)"/)[1], 'base64').toString('utf8'));

const rows = PineLabJS.parseCSV(
  zlib.gunzipSync(Buffer.from(page.match(/BUILTIN_2026_GZ_B64='([^']*)'/)[1], 'base64')).toString('utf8'));
console.error(`${rows.length} شمعة، جاري التشغيل…`);

const t0 = Date.now();
const engine = new PineLabJS.PineEngine(pinePath ? fs.readFileSync(pinePath, 'utf8') : '', {});
const r = engine.run(rows, ['buySignal', 'sellSignal'], true,
  info => { if (info.bar % 20000 < 1300) console.error(`  ${new Date(info.time).toISOString().slice(0, 10)}`); });
if (r.diagnostics.length) {
  console.error('خطأ:', r.diagnostics[0].error);
  process.exit(1);
}

const buy = [], sell = [];
for (let i = 0; i < r.bars; i++) {
  if (r.series.buySignal[i]) buy.push(i);
  if (r.series.sellSignal[i]) sell.push(i);
}
fs.writeFileSync(outPath, JSON.stringify({
  pine: pinePath, bars: r.bars, runtime_seconds: +((Date.now() - t0) / 1000).toFixed(1),
  first_time: rows[0].time, buy, sell,
}));
console.error(`تم في ${((Date.now() - t0) / 1000).toFixed(0)}s — ${buy.length} إشارة شراء، ${sell.length} إشارة بيع`);
