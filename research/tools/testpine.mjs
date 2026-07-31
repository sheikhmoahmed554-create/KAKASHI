import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
const [pinePath, barsArg] = process.argv.slice(2);
const b = await chromium.launch({args:['--js-flags=--max-old-space-size=8192']});
const page = await b.newPage();
page.on('pageerror', e=>console.log('PAGEERROR:',e.message));
await page.goto('file:///home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html');
await page.waitForTimeout(6000);
const src = fs.readFileSync(pinePath,'utf8');
const rows = fs.readFileSync('vault.csv','utf8').split('\n').slice(0, Number(barsArg||20000)+1).join('\n');
const r = await page.evaluate(async ({src,csv})=>{
  let c;
  try { c = PineLabJS.analyzeSource(src); } catch(e){ return {stage:'parse', error:e.message}; }
  const rows = PineLabJS.parseCSV(csv);
  let res;
  try { res = new PineLabJS.PineEngine(src).run(rows, ['canEnterLong','canEnterShort','tpPrice','slPrice']); }
  catch(e){ return {stage:'run', error:e.message, stats:c.stats}; }
  const L=res.series.canEnterLong||[], S=res.series.canEnterShort||[];
  let nl=0,ns=0;
  for(let i=1;i<res.bars;i++){ if(L[i]&&!L[i-1])nl++; if(S[i]&&!S[i-1])ns++; }
  return {stage:'ok', stats:c.stats, bars:res.bars, longs:nl, shorts:ns,
          diag: res.diagnostics.length?res.diagnostics[0].error:null};
},{src,csv:rows});
console.log(JSON.stringify(r,null,1));
await b.close();
