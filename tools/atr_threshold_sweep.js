// Apply the veto where Pine applies it — at the entry gate, per bar — and see
// whether the earlier post-hoc numbers survive.
const fs=require('fs'),zlib=require('zlib');
const E=require('./ai963_engine');
const PU=0.10,COST=0.5,UNTIL=Date.parse('2026-07-18T00:00:00Z');
const html=fs.readFileSync(require('path').join(__dirname,'..','KAKASHI_V16_TV_PARITY_AUDIT.html'),'utf8');
const csv=zlib.gunzipSync(Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1],'base64')).toString('utf8');
const L=csv.split('\n');const bars=[];
for(let i=1;i<L.length;i++){if(!L[i])continue;const a=L[i].split(',');const t=Date.parse(a[0].replace(' ','T'));const c=+a[4];if(!Number.isFinite(t)||!Number.isFinite(c))continue;bars.push({t,o:+a[1],h:+a[2],l:+a[3],c});}
bars.sort((x,y)=>x.t-y.t);
const atr14=E.atr(bars,14);
const PRESET=[
 {name:'CHART 1m',tf:1,priceValue:'hma',priceLen:5,targetValue:'Price Action',targetLen:5,closest:3,smoothing:51,lineType:'RMA (original)',signalLine:'Average KNN',touchPts:3,wickPts:20,bufferPts:4.5,useAtr:false,bodySameSide:true,tp:90,sl:90,respectOthers:false,cooldown:7,buyCooldown:0,sellCooldown:0},
 {name:'2m',tf:2,priceValue:'hma',priceLen:7,targetValue:'Price Action',targetLen:5,closest:3,smoothing:40,lineType:'RMA (original)',signalLine:'Average KNN',touchPts:0,wickPts:2,bufferPts:7,useAtr:false,bodySameSide:true,tp:70,sl:100,respectOthers:false,cooldown:0,buyCooldown:0,sellCooldown:0},
 {name:'3m',tf:3,priceValue:'hma',priceLen:5,targetValue:'Price Action',targetLen:5,closest:3,smoothing:28,lineType:'RMA (original)',signalLine:'Average KNN',touchPts:0,wickPts:4,bufferPts:2,useAtr:false,bodySameSide:true,tp:105,sl:90,respectOthers:false,cooldown:21,buyCooldown:0,sellCooldown:0},
 {name:'5m',tf:5,priceValue:'hma',priceLen:5,targetValue:'Price Action',targetLen:5,closest:3,smoothing:28,lineType:'RMA (original)',signalLine:'Average KNN',touchPts:0,wickPts:0,bufferPts:0,useAtr:false,bodySameSide:true,tp:90,sl:90,respectOthers:true,cooldown:0,buyCooldown:0,sellCooldown:0},
 {name:'10m',tf:10,priceValue:'hma',priceLen:4,targetValue:'Price Action',targetLen:4,closest:3,smoothing:22,lineType:'RMA (original)',signalLine:'Average KNN',touchPts:0,wickPts:0,bufferPts:0,useAtr:false,bodySameSide:true,tp:90,sl:90,respectOthers:true,cooldown:0,buyCooldown:0,sellCooldown:0},
 {name:'15m',tf:15,priceValue:'hma',priceLen:4,targetValue:'Price Action',targetLen:4,closest:3,smoothing:19,lineType:'RMA (original)',signalLine:'Average KNN',touchPts:0,wickPts:0,bufferPts:0,useAtr:false,bodySameSide:true,tp:90,sl:90,respectOthers:true,cooldown:0,buyCooldown:0,sellCooldown:0},
 {name:'30m',tf:30,priceValue:'hma',priceLen:3,targetValue:'Price Action',targetLen:3,closest:3,smoothing:15,lineType:'RMA (original)',signalLine:'Average KNN',touchPts:0,wickPts:0,bufferPts:0,useAtr:false,bodySameSide:true,tp:90,sl:90,respectOthers:true,cooldown:400,buyCooldown:0,sellCooldown:0},
 {name:'1H',tf:60,priceValue:'hma',priceLen:3,targetValue:'Price Action',targetLen:3,closest:3,smoothing:12,lineType:'RMA (original)',signalLine:'Average KNN',touchPts:1,wickPts:20,bufferPts:0,useAtr:false,bodySameSide:true,tp:150,sl:130,respectOthers:true,cooldown:80,buyCooldown:0,sellCooldown:0}];
const sources=PRESET.map(p=>{
  const {bars:tb,index}=E.resample(bars,p.tf);
  const raw=E.knnLine(tb,p);
  const line=p.tf===1?raw:E.projectConfirmed(raw,index);
  const s=E.signalSet(bars,line,atr14,p,PU);
  const n=bars.length,buy=new Uint8Array(n),sell=new Uint8Array(n),rej=new Uint8Array(n);
  for(let i=0;i<n;i++){const bR=s.buyRej[i],bB=s.buyBrk[i],sR=s.sellRej[i],sB=s.sellBrk[i];
    buy[i]=(bR||bB)?1:0;sell[i]=(sR||sB)?1:0;rej[i]=(bR||sR)?1:0;}
  return {...p,buy,sell,rejection:rej};});
const f=(x,d=2)=>Number.isFinite(x)?x.toFixed(d):'—';
const mk=t=>new Date(t).toISOString().slice(0,7);
console.log('الفلتر مطبَّق عند بوابة الدخول (كما في Pine)\n');
console.log('  الحد      صفقات   نسبة%    صافي    PF   لكل صفقة  أقصى تراجع');
console.log('  '+'─'.repeat(62));
const keep={};
for(const cut of [0,18,20,22,24,25,26,27,28,29,30,32,34,38,45]){
  const allow=cut===0?null:Uint8Array.from(bars,(_,i)=>(Number.isFinite(atr14[i])&&atr14[i]/PU<=cut)?1:0);
  const {trades}=E.runBacktest(bars,sources,{pointUnit:PU,sameCandleRule:'Skip',costPoints:COST,entryAllowed:allow});
  const t=trades.filter(x=>x.exitTime<UNTIL);
  const s=E.summarize(t);
  if(cut===26)keep.t=t;
  console.log('  '+(cut===0?'بلا فلتر':'ATR ≤ '+cut).padEnd(10), String(s.trades).padStart(6), f(s.winRate).padStart(7),
    ((s.netPoints>0?'+':'')+f(s.netPoints,0)).padStart(8), f(s.profitFactor,3).padStart(6), f(s.expectancy).padStart(9), f(s.maxDrawdownPoints,0).padStart(11));
}
console.log('\nشهريًا عند ATR ≤ 26:');
const M={};for(const t of keep.t)(M[mk(t.entryTime)]??=[]).push(t);
let cum=0;
for(const k of Object.keys(M).sort()){const v=M[k],w=v.filter(t=>t.points>0).length,net=v.reduce((a,t)=>a+t.points,0);cum+=net;
  console.log('  '+k, String(v.length).padStart(5)+' صفقة ', f(100*w/v.length,1).padStart(5)+'%', ((net>0?'+':'')+f(net,0)).padStart(7), '  تراكمي '+((cum>0?'+':'')+f(cum,0)));}
