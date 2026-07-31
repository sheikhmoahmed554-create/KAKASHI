import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
const [pine,out,bars,ovJson]=process.argv.slice(2);
const b=await chromium.launch({args:['--js-flags=--max-old-space-size=8192']});
const page=await b.newPage(); page.on('pageerror',e=>console.log('PAGEERROR:',e.message));
await page.goto('file:///home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html');
await page.waitForTimeout(6000);
const src=fs.readFileSync(pine,'utf8');
const csv=fs.readFileSync('vault.csv','utf8').split('\n').slice(0,Number(bars)+1).join('\n');
const ov=ovJson?JSON.parse(ovJson):{};
const r=await page.evaluate(async ({src,csv,ov})=>{
  const rows=PineLabJS.parseCSV(csv);
  let res;
  try{ res=new PineLabJS.PineEngine(src,ov).run(rows,['canEnterLong','canEnterShort','tradeTargetPts','tradeStopPts']); }
  catch(e){ return {error:e.message}; }
  const L=res.series.canEnterLong||[],S=res.series.canEnterShort||[];
  const T=res.series.tradeTargetPts||[],P=res.series.tradeStopPts||[];
  const ev=[];
  for(let i=1;i<res.bars;i++){
    const l=Boolean(L[i]),s=Boolean(S[i]);
    if(l===s) continue;
    if(Boolean(L[i-1])===l&&Boolean(S[i-1])===s) continue;
    ev.push([i,l?1:-1,Number(T[i])||0,Number(P[i])||0]);
  }
  return {bars:res.bars,entries:ev,diag:res.diagnostics.length?res.diagnostics[0].error:null};
},{src,csv,ov});
if(r.error){console.log('فشل:',r.error);await b.close();process.exit(1);}
console.log('شموع %d | دخولات %d | تشخيص %s',r.bars,r.entries.length,r.diag);
fs.writeFileSync(out,JSON.stringify(r));
await b.close();
