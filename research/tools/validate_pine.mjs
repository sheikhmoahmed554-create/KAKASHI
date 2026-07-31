import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
const [pinePath, outPath, bars] = process.argv.slice(2);
const b = await chromium.launch({args:['--js-flags=--max-old-space-size=8192']});
const page = await b.newPage();
page.on('pageerror', e=>console.log('PAGEERROR:',e.message));
await page.goto('file:///home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html');
await page.waitForTimeout(6000);
const src = fs.readFileSync(pinePath,'utf8');
const csv = fs.readFileSync('vault.csv','utf8').split('\n').slice(0,Number(bars)+1).join('\n');
const r = await page.evaluate(async ({src,csv})=>{
  const rows = PineLabJS.parseCSV(csv);
  let res;
  try { res = new PineLabJS.PineEngine(src).run(rows,['canEnterLong','canEnterShort']); }
  catch(e){ return {error:e.message}; }
  const L=res.series.canEnterLong||[], S=res.series.canEnterShort||[];
  const ev=[];
  for(let i=1;i<res.bars;i++){
    const l=Boolean(L[i]), s=Boolean(S[i]);
    if(l===s) continue;
    ev.push([i, l?1:-1]);
  }
  return {bars:res.bars, entries:ev, diag:res.diagnostics.length?res.diagnostics[0].error:null};
},{src,csv});
if(r.error){ console.log('فشل:',r.error); await b.close(); process.exit(1); }
console.log('شموع %d | إشارات %d | تشخيص %s', r.bars, r.entries.length, r.diag);
fs.writeFileSync(outPath, JSON.stringify(r));
await b.close();
