/* استخراج تيار الإشارات الخام + الشموع، لتُمسح خطط الخروج لاحقاً بلا إعادة تشغيل.
 *   node extract.mjs <pine> <bars.csv> <out.json> [flags.json]
 * rawBuyEntry / rawSellEntry لا يعتمدان على حالة الصفقة إطلاقاً في هذا المؤشر،
 * فالتيار ثابت مهما تغيّر الهدف والوقف — وهذا ما يجعل المسح السريع ممكناً. */
import fs from 'fs';
const [pinePath, csvPath, outPath, flagsPath] = process.argv.slice(2);
const page = fs.readFileSync('/home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html','utf8');
const core = Buffer.from(page.match(/CORE_B64="([^"]+)"/)[1],'base64').toString('utf8');
globalThis.self = globalThis; (0,eval)(core);
const { PineEngine } = globalThis.PineLabJS;

const src = fs.readFileSync(pinePath,'utf8');
const L = fs.readFileSync(csvPath,'utf8').trim().split('\n');
const rows = L.slice(1).map(l => { const p = l.split(','); return {
  time: Date.parse(p[0].replace(' ','T')+'Z'), open:+p[1], high:+p[2], low:+p[3], close:+p[4], volume:+p[5]||0 }; });

const flags = flagsPath ? JSON.parse(fs.readFileSync(flagsPath,'utf8')) : {};
const over = { showTradeLines:false, showLineTags:false, showSignals:false, showTable:false, ...flags };
const WANT = ['rawBuyEntry','rawSellEntry','canEnterLong','canEnterShort','rmi',
              'wins','losses','trades','netPts','buyWins','buyLosses','sellWins','sellLosses'];
const e = new PineEngine(src, over);
const r = e.run(rows, WANT);
if (r.diagnostics?.length) { console.log('!! تشخيص:', JSON.stringify(r.diagnostics.slice(0,3))); process.exit(4); }
if (r.bars !== rows.length) { console.log(`!! عولج ${r.bars} من ${rows.length}`); process.exit(5); }
const g = n => r.series[n] || e.store.values.get('global:'+n) || [];
const last = a => a.length ? a[a.length-1] : null;

const rb = [], rs = [];
for (let i=0;i<rows.length;i++){ if (g('rawBuyEntry')[i]) rb.push(i); if (g('rawSellEntry')[i]) rs.push(i); }
const out = {
  bars: rows.length,
  flags,
  time: rows.map(x => x.time),
  high: rows.map(x => x.high), low: rows.map(x => x.low), close: rows.map(x => x.close),
  raw_buy: rb, raw_sell: rs,
  engine_internal: { trades:last(g('trades')), wins:last(g('wins')), losses:last(g('losses')),
                     net:last(g('netPts')), buy:[last(g('buyWins')),last(g('buyLosses'))],
                     sell:[last(g('sellWins')),last(g('sellLosses'))] },
};
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`${csvPath}: ${rows.length.toLocaleString()} شمعة • إشارات خام ${rb.length} شراء / ${rs.length} بيع`
  + ` • المحرك: ${out.engine_internal.trades} صفقة، ${out.engine_internal.wins}W/${out.engine_internal.losses}L، صافي ${out.engine_internal.net}`);
