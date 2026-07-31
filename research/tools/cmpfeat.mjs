import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
const NAMES=['vwap_dist_atr','or_pos','mfi14','stoch21','bb_z','rsi14','dist_swing_lo',
             'piv_dist','piv_r1_dist','kelt_z','pos20','atr_ratio','atr14','vol_ratio',
             'ichi_price_kij_atr','htf15_slope','willr5','donch55_pos','sar_dist','or_brk_up'];
const b=await chromium.launch({args:['--js-flags=--max-old-space-size=8192']});
const page=await b.newPage(); page.on('pageerror',e=>console.log('PAGEERROR:',e.message));
await page.goto('file:///home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html');
await page.waitForTimeout(6000);
const src=fs.readFileSync(process.argv[2],'utf8');
const csv=fs.readFileSync('vault.csv','utf8').split('\n').slice(0,20001).join('\n');
const r=await page.evaluate(async ({src,csv,names})=>{
  const rows=PineLabJS.parseCSV(csv);
  let res;
  try{ res=new PineLabJS.PineEngine(src).run(rows,names); }catch(e){ return {error:e.message}; }
  const out={};
  for(const k of names){
    const a=res.series[k]||[];
    out[k]=[];
    for(let i=15000;i<Math.min(15200,a.length);i++) out[k].push(Number(a[i]));
  }
  return {bars:res.bars,vals:out};
},{src,csv,names:NAMES});
if(r.error){console.log('فشل:',r.error);await b.close();process.exit(1);}
fs.writeFileSync('/tmp/pine_feats.json',JSON.stringify(r));
console.log('اتحفظ — شموع',r.bars);
await b.close();
