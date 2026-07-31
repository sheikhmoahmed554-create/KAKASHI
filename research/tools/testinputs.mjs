import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
const b=await chromium.launch({args:['--js-flags=--max-old-space-size=8192']});
const page=await b.newPage(); page.on('pageerror',e=>console.log('PAGEERROR:',e.message));
await page.goto('file:///home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html');
await page.waitForTimeout(6000);
const src=fs.readFileSync(process.argv[2],'utf8');
const csv=fs.readFileSync('vault.csv','utf8').split('\n').slice(0,20001).join('\n');
const CASES=[
  ['الافتراضي', {}],
  ['شراء فقط',  {useSells:false}],
  ['بيع فقط',   {useBuys:false}],
  ['بدون فلتر جلسة', {useSession:false}],
  ['فلتر اتجاه 50', {useTrendFilter:true, trendThresh:50}],
  ['فلتر اتجاه 20', {useTrendFilter:true, trendThresh:20}],
  ['جودة >= 72%',  {minQuality:72}],
  ['جودة >= 75%',  {minQuality:75}],
  ['هدف 40 وقف 60', {tradeTargetPts:40, tradeStopPts:60}],
];
const out=await page.evaluate(async ({src,csv,cases})=>{
  const rows=PineLabJS.parseCSV(csv); const res=[];
  for(const [name,ov] of cases){
    try{
      const r=new PineLabJS.PineEngine(src,ov).run(rows,['canEnterLong','canEnterShort']);
      const L=r.series.canEnterLong||[],S=r.series.canEnterShort||[];
      let nl=0,ns=0; for(let i=1;i<r.bars;i++){ if(L[i])nl++; if(S[i])ns++; }
      res.push([name,nl,ns,r.diagnostics.length?r.diagnostics[0].error:null]);
    }catch(e){ res.push([name,-1,-1,e.message]); }
  }
  return res;
},{src,csv,cases:CASES});
console.log('%-20s %8s %8s  %s','الحالة','شراء','بيع','خطأ');
console.log('─'.repeat(52));
for(const [n,l,s,e] of out) console.log('%-20s %8d %8d  %s',n,l,s,e||'');
await b.close();
