// The decisive test. Blind shorting earned +3.99 pts/trade in this sample and
// blind buying lost 4.99, so any source that happens to lean short looks smart.
// Score each source's longs against the always-long baseline and its shorts
// against the always-short baseline. Skill is what survives that adjustment.
const fs=require('fs'),zlib=require('zlib');
const E=require('./ai963_engine');
const PU=0.10,COST=0.5,MAXH=1440;
const html=fs.readFileSync(require('path').join(__dirname,'..','KAKASHI_V16_TV_PARITY_AUDIT.html'),'utf8');
const csv=zlib.gunzipSync(Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1],'base64')).toString('utf8');
const L=csv.split('\n');const bars=[];
for(let i=1;i<L.length;i++){if(!L[i])continue;const a=L[i].split(',');const t=Date.parse(a[0].replace(' ','T'));const c=+a[4];if(!Number.isFinite(t)||!Number.isFinite(c))continue;bars.push({t,o:+a[1],h:+a[2],l:+a[3],c});}
bars.sort((x,y)=>x.t-y.t);
const atr14=E.atr(bars,14);

function race(i,dir,tp,sl){const e=bars[i].c,tpx=e+dir*tp*PU,spx=e-dir*sl*PU;
  const end=Math.min(bars.length-1,i+MAXH);
  for(let j=i+1;j<=end;j++){const b=bars[j];
    const ht=dir===1?b.h>=tpx:b.l<=tpx,hs=dir===1?b.l<=spx:b.h>=spx;
    if(ht&&hs)return null; if(ht)return tp-COST; if(hs)return -sl-COST;}
  return (bars[end].c-e)*dir/PU-COST;}

const PRESET=[
 ['CHART 1m',1,5,5,51,3,20,4.5],['2m',2,7,5,40,0,2,7],['3m',3,5,5,28,0,4,2],['5m',5,5,5,28,0,0,0],
 ['10m',10,4,4,22,0,0,0],['15m',15,4,4,19,0,0,0],['30m',30,3,3,15,0,0,0],['1H',60,3,3,12,1,20,0]];

function sigs(nm,tf,pl,tl,sm,tp_,wk,bf){
  const p={priceValue:'hma',priceLen:pl,targetValue:'Price Action',targetLen:tl,closest:3,smoothing:sm,
    lineType:'RMA (original)',signalLine:'Average KNN',touchPts:tp_,wickPts:wk,bufferPts:bf,useAtr:false,bodySameSide:true};
  const {bars:tb,index}=E.resample(bars,tf);const raw=E.knnLine(tb,p);
  const line=tf===1?raw:E.projectConfirmed(raw,index);
  const s=E.signalSet(bars,line,atr14,p,PU);const out=[];
  for(let i=0;i<bars.length;i++){const b=s.buyRej[i]||s.buyBrk[i],se=s.sellRej[i]||s.sellBrk[i];
    if(b&&!se)out.push({i,dir:1});else if(se&&!b)out.push({i,dir:-1});}
  return out;}

function rng(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function baseline(dir,n,seed){const r=rng(seed);let c=0,net=0;const lo=100,hi=bars.length-MAXH-2;
  for(let k=0;k<n;k++){const i=lo+Math.floor(r()*(hi-lo));const p=race(i,dir,90,90);if(p===null)continue;c++;net+=p;}
  return net/c;}
const BL_LONG=baseline(1,40000,12345), BL_SHORT=baseline(-1,40000,54321);

function score(list){
  let ln=0,lnet=0,sn=0,snet=0;
  for(const s of list){const p=race(s.i,s.dir,90,90);if(p===null)continue;
    if(s.dir===1){ln++;lnet+=p}else{sn++;snet+=p}}
  const lper=ln?lnet/ln:0, sper=sn?snet/sn:0;
  return {ln,sn,shortShare:100*sn/(ln+sn),lper,sper,
    lAlpha:lper-BL_LONG, sAlpha:sper-BL_SHORT,
    alpha:((lper-BL_LONG)*ln+(sper-BL_SHORT)*sn)/(ln+sn),
    raw:(lnet+snet)/(ln+sn)};}

const f=(x,d=2)=>x.toFixed(d);
console.log(`خط الأساس للاتجاه (40 ألف دخول عشوائي لكل جهة، هدف/وقف 90/90):`);
console.log(`  شراء أعمى : ${f(BL_LONG)} نقطة/صفقة`);
console.log(`  بيع أعمى  : ${f(BL_SHORT)} نقطة/صفقة\n`);
console.log('المصدر     شراء    بيع   نسبة البيع%   خام    ألفا الشراء   ألفا البيع   ألفا صافية');
console.log('─'.repeat(88));
const rows=[];
for(const P of PRESET){const r=score(sigs(...P));rows.push([P[0],r]);}
rows.sort((a,b)=>b[1].alpha-a[1].alpha);
for(const [nm,r] of rows){
  console.log(nm.padEnd(9),String(r.ln).padStart(6),String(r.sn).padStart(6),f(r.shortShare,1).padStart(11),
    f(r.raw,2).padStart(8),(r.lAlpha>0?'+':'')+f(r.lAlpha,2).padStart(11),
    (r.sAlpha>0?'+':'')+f(r.sAlpha,2).padStart(12),(r.alpha>0?'+':'')+f(r.alpha,2).padStart(11));}
