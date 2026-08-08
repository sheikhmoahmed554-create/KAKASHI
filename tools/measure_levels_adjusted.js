// Highs +6.69 and lows -7.98 is a mirror, and a resistance line sells while a
// support line buys. Gold fell over this sample, so that pattern is what the
// downtrend looks like, not what a good level looks like. Score each line's
// longs against a blind-long baseline and its shorts against a blind-short one;
// only what survives that is about the level.
const fs=require('fs'),path=require('path'),zlib=require('zlib');
const E=require('./ai963_engine');
const LV=require('./levels');
const PU=0.10,COST=0.5,TP=90,SL=90,MAXH=1440;
const html=fs.readFileSync(require('path').join(__dirname,'..','KAKASHI_V16_TV_PARITY_AUDIT.html'),'utf8');
const csv=zlib.gunzipSync(Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1],'base64')).toString('utf8');
const L=csv.split('\n');const bars=[];
for(let i=1;i<L.length;i++){if(!L[i])continue;const a=L[i].split(',');const t=Date.parse(a[0].replace(' ','T'));const c=+a[4];if(!Number.isFinite(t)||!Number.isFinite(c))continue;bars.push({t,o:+a[1],h:+a[2],l:+a[3],c,v:+a[5]});}
bars.sort((x,y)=>x.t-y.t);
const atr14=E.atr(bars,14);

function race(i,dir){const e=bars[i].c,tp=e+dir*TP*PU,sl=e-dir*SL*PU;
  const end=Math.min(bars.length-1,i+MAXH);
  for(let j=i+1;j<=end;j++){const b=bars[j];
    const ht=dir===1?b.h>=tp:b.l<=tp, hs=dir===1?b.l<=sl:b.h>=sl;
    if(ht&&hs)return null; if(ht)return TP-COST; if(hs)return -SL-COST;}
  return (bars[end].c-e)*dir/PU-COST;}

function rng(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function baseline(dir,n,seed){const r=rng(seed);let c=0,net=0;const lo=100,hi=bars.length-MAXH-2;
  for(let k=0;k<n;k++){const i=lo+Math.floor(r()*(hi-lo));const p=race(i,dir);if(p===null)continue;c++;net+=p;}return net/c;}
const BL=[baseline(1,50000,999),baseline(-1,50000,777)];

const CFG={useAtr:true,touchAtr:0.15,wickAtr:0.10,bufferAtr:0.10,bodySameSide:true,touchPts:0,wickPts:0,bufferPts:0};
function score(line){
  const s=E.signalSet(bars,line,atr14,CFG,PU);
  let ln=0,lnet=0,sn=0,snet=0;
  for(let i=0;i<bars.length;i++){
    const buy=s.buyRej[i]||s.buyBrk[i], sell=s.sellRej[i]||s.sellBrk[i];
    let dir=0; if(buy&&!sell)dir=1; else if(sell&&!buy)dir=-1; else continue;
    const p=race(i,dir); if(p===null)continue;
    if(dir===1){ln++;lnet+=p}else{sn++;snet+=p}}
  const lp=ln?lnet/ln:NaN, sp=sn?snet/sn:NaN;
  const la=ln?lp-BL[0]:NaN, sa=sn?sp-BL[1]:NaN;
  const tot=ln+sn;
  return {ln,sn,shortShare:tot?100*sn/tot:0,raw:tot?(lnet+snet)/tot:NaN,
    lAlpha:la,sAlpha:sa,alpha:tot?((ln?la*ln:0)+(sn?sa*sn:0))/tot:NaN};}

const C=[
 ['① القمم (لمستان+)',()=>LV.swingLevels(bars,{side:'high',left:20,right:20,minTouches:2,atr:atr14}).line],
 ['② القيعان (لمستان+)',()=>LV.swingLevels(bars,{side:'low',left:20,right:20,minTouches:2,atr:atr14}).line],
 ['③ فيبوناتشي',()=>LV.fibLevels(bars,{left:60,right:60}).line],
 ['④ فشل متكرر — قمة',()=>LV.failedRetestLevels(bars,{side:'high',atr:atr14}).line],
 ['④ فشل متكرر — قاع',()=>LV.failedRetestLevels(bars,{side:'low',atr:atr14}).line],
 ['⑤ اليوم السابق',()=>LV.previousDayLevels(bars).line],
 ['⑥ نطاق جلسة آسيا',()=>LV.sessionRangeLevels(bars,{startHour:0,endHour:7}).line],
 ['⑦ أرقام مستديرة $10',()=>LV.roundNumberLevels(bars,{step:10}).line],
 ['⑧ VWAP',()=>LV.vwapLevels(bars).line],
 ['⑨ فجوات FVG',()=>LV.fvgLevels(bars,{atr:atr14}).line],
 ['⑩ امتصاص (مؤسسات)',()=>LV.absorptionLevels(bars,{atr:atr14}).line],
 ['⑪ عقدة الحجم',()=>LV.volumeNodeLevels(bars).line],
 ['⑬ ترند هابط (قمم)',()=>LV.trendLineLevels(bars,{side:'down',atr:atr14}).line],
 ['⑬ ترند صاعد (قيعان)',()=>LV.trendLineLevels(bars,{side:'up',atr:atr14}).line],
 ['⑭ افتتاح اليوم',()=>LV.dailyOpenLevels(bars).line],
 ['⑮ بيفوت كلاسيكي',()=>LV.classicPivotLevels(bars).line],
 ['⑯ انقلاب الدور',()=>LV.roleReversalLevels(bars,{atr:atr14}).line],
 ['⑫ بلوك الأوامر',()=>LV.orderBlockLevels(bars,{atr:atr14}).line]];

const f=(x,d=2)=>Number.isFinite(x)?x.toFixed(d):'—';
console.log(`خط الأساس: شراء أعمى ${f(BL[0])}   بيع أعمى ${f(BL[1])}  نقطة/صفقة\n`);
console.log('الخط                  شراء    بيع  حصة البيع%     خام   ألفا الشراء  ألفا البيع  ألفا صافية');
console.log('─'.repeat(94));
const rows=[];
for(const [nm,b] of C){rows.push([nm,score(b())]);}
rows.sort((a,b)=>(b[1].alpha||-1e9)-(a[1].alpha||-1e9));
for(const [nm,r] of rows)
  console.log(nm.padEnd(20), String(r.ln).padStart(6), String(r.sn).padStart(6), f(r.shortShare,1).padStart(11),
    f(r.raw).padStart(8), ((r.lAlpha>0?'+':'')+f(r.lAlpha)).padStart(12), ((r.sAlpha>0?'+':'')+f(r.sAlpha)).padStart(11),
    ((r.alpha>0?'+':'')+f(r.alpha)).padStart(11));
