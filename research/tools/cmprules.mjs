import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
const b=await chromium.launch({args:['--js-flags=--max-old-space-size=8192']});
const page=await b.newPage(); page.on('pageerror',e=>console.log('PAGEERROR:',e.message));
await page.goto('file:///home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html');
await page.waitForTimeout(6000);
const src=fs.readFileSync(process.argv[2],'utf8');
const csv=fs.readFileSync('vault.csv','utf8').split('\n').slice(0,60001).join('\n');
const names=[]; for(let i=1;i<=20;i++) names.push('r'+String(i).padStart(3,'0'));
const r=await page.evaluate(async ({src,csv,names})=>{
  const rows=PineLabJS.parseCSV(csv);
  let res; try{ res=new PineLabJS.PineEngine(src).run(rows,names);}catch(e){return {error:e.message};}
  const out={};
  for(const k of names){ const a=res.series[k]||[]; let c=0; for(let i=1;i<res.bars;i++) if(a[i])c++; out[k]=c; }
  return {bars:res.bars,counts:out};
},{src,csv,names});
if(r.error){console.log('فشل:',r.error);await b.close();process.exit(1);}
fs.writeFileSync('/tmp/pine_rulecounts.json',JSON.stringify(r));
console.log('شموع',r.bars);
await b.close();
