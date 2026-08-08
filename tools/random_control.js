// The missing control: what does a coin-flip entry do in this same market,
// with the same targets and the same cost? Without it, "50.8%" means nothing.
const fs=require('fs'),zlib=require('zlib');
const E=require('./ai963_engine');
const PU=0.10,COST=0.5,MAXH=1440;
const html=fs.readFileSync(require('path').join(__dirname,'..','KAKASHI_V16_TV_PARITY_AUDIT.html'),'utf8');
const csv=zlib.gunzipSync(Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1],'base64')).toString('utf8');
const L=csv.split('\n');const bars=[];
for(let i=1;i<L.length;i++){if(!L[i])continue;const a=L[i].split(',');const t=Date.parse(a[0].replace(' ','T'));const c=+a[4];if(!Number.isFinite(t)||!Number.isFinite(c))continue;bars.push({t,o:+a[1],h:+a[2],l:+a[3],c});}
bars.sort((x,y)=>x.t-y.t);

function race(i,dir,tp,sl){
  const e=bars[i].c,tpx=e+dir*tp*PU,spx=e-dir*sl*PU;
  let mfe=0,mae=0;const end=Math.min(bars.length-1,i+MAXH);
  for(let j=i+1;j<=end;j++){const b=bars[j];
    const up=(b.h-e)*dir/PU,dn=(b.l-e)*dir/PU;
    if(up>mfe)mfe=up; if(dn<mae)mae=dn;
    const ht=dir===1?b.h>=tpx:b.l<=tpx,hs=dir===1?b.l<=spx:b.h>=spx;
    if(ht&&hs)return{p:null,mfe,mae}; if(ht)return{p:tp-COST,mfe,mae}; if(hs)return{p:-sl-COST,mfe,mae};}
  return {p:(bars[end].c-e)*dir/PU-COST,mfe,mae};}

// mulberry32: reproducible pseudo-random so the control can be re-run
function rng(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

function control(n,seed,dirMode){
  const r=rng(seed);let wins=0,cnt=0,net=0,mfeS=[],maeS=[];
  const lo=100,hi=bars.length-MAXH-2;
  for(let k=0;k<n;k++){
    const i=lo+Math.floor(r()*(hi-lo));
    const dir=dirMode==='mix'?(r()<0.5?1:-1):dirMode==='long'?1:-1;
    const {p,mfe,mae}=race(i,dir,90,90);
    mfeS.push(mfe);maeS.push(-mae);
    if(p===null)continue;
    cnt++;if(p>0)wins++;net+=p;}
  mfeS.sort((a,b)=>a-b);maeS.sort((a,b)=>a-b);
  return{n:cnt,wr:100*wins/cnt,net,per:net/cnt,medMFE:mfeS[mfeS.length>>1],medMAE:maeS[maeS.length>>1]};}

const f=(x,d=2)=>x.toFixed(d);
console.log('ضابط الدخول العشوائي — نفس السوق، نفس الهدف/الوقف 90/90، نفس الكلفة\n');
console.log('  الاتجاه   محاولة   ربح%    نقطة/صفقة   MFE   MAE   MFE/MAE');
for(const mode of ['mix','long','short']){
  const runs=[];
  for(let s=1;s<=8;s++)runs.push(control(8000,s*7919,mode));
  const wr=runs.reduce((a,x)=>a+x.wr,0)/runs.length;
  const per=runs.reduce((a,x)=>a+x.per,0)/runs.length;
  const mfe=runs.reduce((a,x)=>a+x.medMFE,0)/runs.length;
  const mae=runs.reduce((a,x)=>a+x.medMAE,0)/runs.length;
  const sd=Math.sqrt(runs.reduce((a,x)=>a+(x.wr-wr)**2,0)/(runs.length-1));
  const label={mix:'عشوائي',long:'شراء دائمًا',short:'بيع دائمًا'}[mode];
  console.log('  '+label.padEnd(12), '8×8000', f(wr,2).padStart(6), '±'+f(sd,2), f(per,2).padStart(8), f(mfe,0).padStart(6), f(mae,0).padStart(5), f(mfe/mae,2).padStart(8));
}
console.log('\nللمقارنة — إشارات المؤشر (من الاختبار السابق، هدف/وقف 90/90):');
console.log('  15m         7723 إشارة   50.81%   +0.96 نقطة   MFE 56  MAE 56  1.00');
console.log('  3m         12029 إشارة   50.13%   -0.25 نقطة   MFE 53  MAE 57  0.92');
console.log('  CHART 1m    8939 إشارة   49.42%   -1.54 نقطة   MFE 50  MAE 56  0.90');
