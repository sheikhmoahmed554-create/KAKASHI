import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
const b = await chromium.launch({args:['--js-flags=--max-old-space-size=8192']});
const page = await b.newPage();
page.on('pageerror', e=>console.log('PAGEERROR:',e.message));
page.on('console', m=>{ if(m.text().startsWith('[')) console.log(m.text()); });
await page.goto('file:///home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html');
await page.waitForTimeout(6000);
const text = fs.readFileSync('vault.csv','utf8').split('\n').slice(0,60001).join('\n');
const r = await page.evaluate(async ({csvText})=>{
  const rows = PineLabJS.parseCSV(csvText);
  const names = ['pbPairSide','pbPairBuy','pbPairSell','tvAddonSide','m1BaseSide',
                 'sy8624BaseSide','sy8624SelectedSide','syCleanSelectedSide',
                 'syr30ReplacementSide','k3FusionSide','k3TVSide','k3BaseSide','syFinalSelectedSide'];
  let res;
  try { res = new PineLabJS.PineEngine(document.getElementById('source').value).run(rows,names); }
  catch(e){ return {error:e.message}; }
  const out={};
  for(const k of names){
    const a=res.series[k]||[];
    let nz=0, pos=0, neg=0;
    for(let i=1;i<a.length;i++){ const v=Number(a[i])||0; if(v!==0){nz++; v>0?pos++:neg++;} }
    out[k]={nonzero:nz,pos,neg,len:a.length};
  }
  return {bars:res.bars,out};
},{csvText:text});
if(r.error){ console.log('فشل:',r.error); await b.close(); process.exit(1); }
console.log('شموع %d\n', r.bars);
console.log('%-24s %10s %10s %10s','المتغير','غير صفري','شراء','بيع');
console.log('─'.repeat(58));
for(const [k,v] of Object.entries(r.out))
  console.log('%-24s %10d %10d %10d', k, v.nonzero, v.pos, v.neg);
await b.close();
