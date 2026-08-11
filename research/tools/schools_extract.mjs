// يستخرج إشارات المدارس الخام مرة واحدة على الست شهور، وكل المفاتيح مفتوحة.
//   node research/tools/schools_extract.mjs <ملف.pine> <الخرج.json>
// بعد هذه المرة الواحدة يصير تقييم أي تركيبة مدارس عملية مصفوفات في أجزاء من الثانية،
// بدل ثلاث عشرة دقيقة لكل تركيبة لو شغّلنا المحرك في كل مرة.
import fs from 'node:fs';
import zlib from 'node:zlib';

const [pinePath, outPath] = process.argv.slice(2);
const page = fs.readFileSync('KAKASHI_V16_TV_PARITY_AUDIT.html', 'utf8');
(0, eval)(Buffer.from(page.match(/const CORE_B64="([^"]*)"/)[1], 'base64').toString('utf8'));

// كل مدرسة بجهتيها الخام، قبل أي مفتاح تشغيل أو تصويت.
const SIGNALS = [
  'capMomUltraBuy', 'capMomUltraSell',          // ٠٦ الزخم
  'bbkcBuy', 'bbkcSell',                        // ٠٩ بولنجر + كلتنر، الجهتان معاً
  'capQVUltraBuy', 'capQVUltraSell',            // ١١ QQE + فورتكس
  'syr30BalanceBuy', 'syr30BalanceSell',        // ١٢ إعادة التوازن
  'syr30DeadAuctionBuy', 'syr30DeadAuctionSell',// ١٧ المزاد الميت
  'capIchiUltraBuy', 'capIchiMidSell',          // ١٨ إيتشيموكو
  'cap331UltraBuy', 'cap331MidSell',            // ١٩ حزمة الجهة
  'capLiqExactBuy', 'capLiqExactSell',          // ٢٢ السيولة
  'syr30AsiaBuy', 'syr30AsiaSell',              // ٢٣ كسر آسيا وإعادة الاختبار
];
// مصادر الراوتر الأخرى، للمقارنة ولتركيب بدائل معها.
const SIDES = ['k3BaseSide', 'k3TVSide', 'syFinalSelectedSide', 'tradeableBase'];

// نفتح كل المفاتيح حتى تُنتج المدارس المطفية إشاراتها الخام.
const ALL_ON = {
  fusionUseMomentum: true, fusionUseBBKC: true, fusionUseQQEVortex: true,
  fusionUseIchimoku: true, fusionUseSidePack: true, fusionUseLiquidity: true,
  syr30UseSchoolRouter: true, syr30UseBalance: true, syr30UseAsia: true,
  syr30UseDeadAuction: true, useFinalSchoolFusion: true,
};

const rows = PineLabJS.parseCSV(
  zlib.gunzipSync(Buffer.from(page.match(/BUILTIN_2026_GZ_B64='([^']*)'/)[1], 'base64')).toString('utf8'));
console.error(`${rows.length} شمعة، كل المفاتيح مفتوحة، جاري التشغيل…`);

const t0 = Date.now();
const r = new PineLabJS.PineEngine(fs.readFileSync(pinePath, 'utf8'), ALL_ON)
  .run(rows, [...SIGNALS, ...SIDES], true, info => {
    if (info.bar % 10000 < 1500) {
      console.error(`  ${new Date(info.time).toISOString().slice(0, 10)}  ` +
        `${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  });
if (r.diagnostics.length) {
  console.error('خطأ:', r.diagnostics[0].error);
  process.exit(1);
}

// تخزين متناثر: أرقام الشموع التي أطلقت فيها كل إشارة.
const out = { pine: pinePath, bars: r.bars, runtime_seconds: +((Date.now() - t0) / 1000).toFixed(1), fired: {} };
for (const name of SIGNALS) {
  const s = r.series[name] || [];
  const idx = [];
  for (let i = 0; i < r.bars; i++) if (s[i]) idx.push(i);
  out.fired[name] = idx;
  console.error(`  ${name}: ${idx.length}`);
}
for (const name of SIDES) {
  const s = r.series[name] || [];
  const buy = [], sell = [];
  for (let i = 0; i < r.bars; i++) {
    const v = Number(s[i]);
    if (v === 1) buy.push(i); else if (v === -1) sell.push(i);
  }
  if (name === 'tradeableBase') {
    const ok = [];
    for (let i = 0; i < r.bars; i++) if (s[i]) ok.push(i);
    out.fired[name] = ok;
    console.error(`  ${name}: ${ok.length}`);
  } else {
    out.fired[name + 'Buy'] = buy;
    out.fired[name + 'Sell'] = sell;
    console.error(`  ${name}: ${buy.length} شراء / ${sell.length} بيع`);
  }
}
fs.writeFileSync(outPath, zlib.gzipSync(JSON.stringify(out)));
console.error(`تم في ${((Date.now() - t0) / 1000).toFixed(0)}s → ${outPath}`);
