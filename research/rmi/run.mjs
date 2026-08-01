/* تشغيل مؤشر Pine على محرك المنصة نفسه، داخل Node وبلا متصفح.
 *
 *   node run.mjs <indicator.pine> <bars.csv> [maxBars]
 *
 * المحرك مأخوذ من CORE_B64 داخل صفحة V16، وهو JavaScript صرف فلا يحتاج DOM.
 * نقرأ من المؤشر إشاراته وحالته الداخلية معاً، فنحصل على إحصاءاته هو
 * لا إحصاءات نعيد بناءها — وهذا ما يجعل التحقق ممكناً. */
import fs from 'fs';

const [pinePath, csvPath, maxBarsArg] = process.argv.slice(2);
const maxBars = maxBarsArg ? Number(maxBarsArg) : 0;

const page = fs.readFileSync('/home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html', 'utf8');
const m = page.match(/CORE_B64="([^"]+)"/);
if (!m) { console.error('CORE_B64 غير موجود في الصفحة'); process.exit(2); }
const core = Buffer.from(m[1], 'base64').toString('utf8');
globalThis.self = globalThis;
(0, eval)(core);
const { PineEngine, analyzeSource } = globalThis.PineLabJS;

const src = fs.readFileSync(pinePath, 'utf8');
const info = analyzeSource(src);
console.log(`ترجمة: ${info.stats.physical_lines} سطر • ${info.stats.inputs} input • `
  + `${info.stats.functions} function • أخطاء ${info.stats.parse_errors}`);
if (info.stats.parse_errors) {
  console.log(JSON.stringify(info.parse_errors.slice(0, 6), null, 1));
  process.exit(3);
}

let lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
const head = lines[0].split(',');
const ix = n => head.indexOf(n);
lines = lines.slice(1);
if (maxBars) lines = lines.slice(0, maxBars);
const rows = lines.map(l => {
  const p = l.split(',');
  return {
    time: Date.parse(p[ix('time')].replace(' ', 'T') + 'Z'),
    open: +p[ix('open')], high: +p[ix('high')],
    low: +p[ix('low')], close: +p[ix('close')],
    volume: +(p[ix('volume')] || 0),
  };
});
console.log(`شموع: ${rows.length.toLocaleString()} • `
  + `${new Date(rows[0].time).toISOString().slice(0, 16)} → `
  + `${new Date(rows[rows.length - 1].time).toISOString().slice(0, 16)}`);

const WANT = ['canEnterLong', 'canEnterShort', 'rmi', 'rmiSignal',
  'wins', 'losses', 'trades', 'netPts', 'buyWins', 'buyLosses',
  'sellWins', 'sellLosses', 'maxWin', 'maxLoss', 'buyZoneCount', 'sellZoneCount',
  'entryPrice', 'tpPrice', 'slPrice', 'active', 'side'];

const t0 = Date.now();
// المرئيات مطفأة: محرك المنصة لا يدعم yloc.price فيتوقف عند أول رسم.
// الرسم لا يمسّ منطق الدخول والخروج إطلاقاً، فإطفاؤه لا يغيّر أي نتيجة.
const engine = new PineEngine(src, {
  showTradeLines: false, showLineTags: false, showSignals: false, showTable: false,
});
const res = engine.run(rows, WANT);
const secs = (Date.now() - t0) / 1000;
if (res.diagnostics && res.diagnostics.length) {
  console.log(`\n!! المحرك سجّل ${res.diagnostics.length} خطأ — النتائج غير صالحة:`);
  for (const d of res.diagnostics.slice(0, 5)) console.log('  ', JSON.stringify(d));
  process.exit(4);
}
if (res.bars !== rows.length) {
  console.log(`\n!! المحرك عالج ${res.bars} شمعة من ${rows.length} — توقف مبكر.`);
  process.exit(5);
}

const S = {};
for (const k of WANT) S[k] = res.series[k] || engine.store.values.get('global:' + k) || [];
const last = a => a.length ? a[a.length - 1] : null;

const longs = [], shorts = [];
for (let i = 0; i < rows.length; i++) {
  if (S.canEnterLong[i]) longs.push(i);
  if (S.canEnterShort[i]) shorts.push(i);
}

const wins = last(S.wins), losses = last(S.losses), net = last(S.netPts);
const tr = last(S.trades);
console.log(`\n=== إحصاءات المؤشر الداخلية (من جدوله هو) ===`);
console.log(`  صفقات ${tr} • فوز ${wins} • خسارة ${losses} • `
  + `نسبة ${tr ? (100 * wins / tr).toFixed(2) : 0}% • صافي ${net}`);
console.log(`  BUY ${last(S.buyWins)}/${last(S.buyLosses)} • `
  + `SELL ${last(S.sellWins)}/${last(S.sellLosses)} • `
  + `أطول ربح ${last(S.maxWin)} • أطول خسارة ${last(S.maxLoss)}`);
console.log(`  مناطق تشبّع: شراء ${last(S.buyZoneCount)} • بيع ${last(S.sellZoneCount)}`);
console.log(`  إشارات دخول: ${longs.length} شراء • ${shorts.length} بيع `
  + `= ${longs.length + shorts.length}`);
console.log(`  زمن التشغيل ${secs.toFixed(1)} ثانية`);

const out = {
  bars: rows.length,
  first: new Date(rows[0].time).toISOString(),
  last: new Date(rows[rows.length - 1].time).toISOString(),
  runtime_seconds: secs,
  internal: {
    trades: tr, wins, losses, net_points: net,
    win_rate: tr ? 100 * wins / tr : 0,
    buy: [last(S.buyWins), last(S.buyLosses)],
    sell: [last(S.sellWins), last(S.sellLosses)],
    max_win_streak: last(S.maxWin), max_loss_streak: last(S.maxLoss),
    buy_zones: last(S.buyZoneCount), sell_zones: last(S.sellZoneCount),
  },
  signals: {
    long_bars: longs, short_bars: shorts,
  },
  times: longs.concat(shorts).sort((a, b) => a - b)
    .map(i => [new Date(rows[i].time).toISOString().slice(0, 19).replace('T', ' '),
               S.canEnterLong[i] ? 'BUY' : 'SELL', rows[i].close]),
};
const outPath = (process.env.OUT || 'run_out.json');
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`\nكُتب ${outPath}`);
