/* استخراج كل إشارات المصادر مرة واحدة لكل سنة.
 * المصادر شروط شمعة مستقلة عن حالة الصفقة، ومحرك RMI ينزع تسليحه بإشارته هو
 * لا بالإشارة المجمّعة — لذلك أي تركيبة منها تُحسب لاحقاً في بايثون بدقة تامة،
 * بلا إعادة تشغيل المحرك. */
import fs from 'fs';
const [pinePath, csvPath, outPath] = process.argv.slice(2);
const page = fs.readFileSync('/home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html','utf8');
const core = Buffer.from(page.match(/CORE_B64="([^"]+)"/)[1],'base64').toString('utf8');
globalThis.self = globalThis; (0,eval)(core);
const { PineEngine } = globalThis.PineLabJS;

const SOURCES = ['Rsi','Macd','Adx','Bb','Ichi','Sar','Pivot','Fib','Ma','Brt','Smb','Sr'];
const WANT = ['rmiRawBuy','rmiRawSell'];
for (const s of SOURCES) WANT.push(`mc${s}Buy`, `mc${s}Sell`, `mc${s}BuyOK`, `mc${s}SellOK`);

const src = fs.readFileSync(pinePath,'utf8');
const L = fs.readFileSync(csvPath,'utf8').trim().split('\n');
const rows = L.slice(1).map(l => { const p=l.split(','); return {
  time: Date.parse(p[0].replace(' ','T')+'Z'), open:+p[1], high:+p[2], low:+p[3], close:+p[4], volume:+p[5]||0 }; });

const t0 = Date.now();
const e = new PineEngine(src, { showTradeLines:false, showLineTags:false, showSignals:false, showTable:false });
const r = e.run(rows, WANT.concat(['wins','losses','trades','netPts']));
if (r.diagnostics?.length) { console.log('!!', JSON.stringify(r.diagnostics.slice(0,3))); process.exit(4); }
if (r.bars !== rows.length) { console.log(`!! عولج ${r.bars} من ${rows.length}`); process.exit(5); }
const g = n => r.series[n] || e.store.values.get('global:'+n) || [];
const bits = {};
for (const k of WANT) { const a=g(k); const out=[]; for(let i=0;i<rows.length;i++) if(a[i]) out.push(i); bits[k]=out; }
const last = a => a.length ? a[a.length-1] : null;
const out = {
  bars: rows.length,
  high: rows.map(x=>x.high), low: rows.map(x=>x.low), close: rows.map(x=>x.close), time: rows.map(x=>x.time),
  bits,
  engine_internal: { trades:last(g('trades')), wins:last(g('wins')), losses:last(g('losses')), net:last(g('netPts')) },
};
fs.writeFileSync(outPath, JSON.stringify(out));
const n = k => bits[k].length;
console.log(`${csvPath}: ${rows.length.toLocaleString()} شمعة • ${((Date.now()-t0)/1000).toFixed(0)}s`
  + ` • RMI ${n('rmiRawBuy')}/${n('rmiRawSell')} • محرك ${out.engine_internal.trades} صفقة`);
console.log('  ' + SOURCES.map(s=>`${s} ${n('mc'+s+'Buy')}/${n('mc'+s+'Sell')}`).join(' • '));
