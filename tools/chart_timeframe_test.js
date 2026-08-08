// Suspect 1: the chart timeframe. TradingView loads roughly 20k bars, which on
// 1m is about two weeks, not six months. Seeing six months means the chart is
// NOT 1m — and "CHART" is whatever timeframe the chart is on, with smoothing 51
// applied to those candles. That is a different indicator.
const fs=require('fs'),zlib=require('zlib');
const E=require('./ai963_engine');
const PU=0.10,COST=0.5;
const html=fs.readFileSync(require('path').join(__dirname,'..','KAKASHI_V16_TV_PARITY_AUDIT.html'),'utf8');
const csv=zlib.gunzipSync(Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1],'base64')).toString('utf8');
const L=csv.split('\n');const bars=[];
for(let i=1;i<L.length;i++){if(!L[i])continue;const a=L[i].split(',');const t=Date.parse(a[0].replace(' ','T'));const c=+a[4];if(!Number.isFinite(t)||!Number.isFinite(c))continue;bars.push({t,o:+a[1],h:+a[2],l:+a[3],c});}
bars.sort((x,y)=>x.t-y.t);
const UNTIL=Date.parse('2026-07-01T00:00:00Z');

const CHART={priceValue:'hma',priceLen:5,targetValue:'Price Action',targetLen:5,closest:3,smoothing:51,
  lineType:'RMA (original)',signalLine:'Average KNN',touchPts:3,wickPts:20,bufferPts:4.5,useAtr:false,bodySameSide:true};

function run(tfMin){
  const {bars:cb}=E.resample(bars,tfMin);           // the chart's own candles
  const atr14=E.atr(cb,14);
  const line=E.knnLine(cb,CHART);
  const s=E.signalSet(cb,line,atr14,CHART,PU);
  const src=[{name:'CHART',tp:90,sl:90,respectOthers:false,cooldown:7,buyCooldown:0,sellCooldown:0,
    buy:Uint8Array.from(cb.map((_,i)=>(s.buyRej[i]||s.buyBrk[i])?1:0)),
    sell:Uint8Array.from(cb.map((_,i)=>(s.sellRej[i]||s.sellBrk[i])?1:0)),
    rejection:Uint8Array.from(cb.map((_,i)=>(s.buyRej[i]||s.sellRej[i])?1:0))}];
  const {trades}=E.runBacktest(cb,src,{pointUnit:PU,sameCandleRule:'Skip',costPoints:COST});
  return E.summarize(trades.filter(t=>t.exitTime<UNTIL));
}
const f=(x,d=2)=>Number.isFinite(x)?x.toFixed(d):'—';
console.log('مصدر الشارت لحاله، بإعداداته (تنعيم 51، هدف/وقف 90/90) على فريمات شارت مختلفة');
console.log('ستة أشهر، يناير→يونيو 2026\n');
console.log('فريم الشارت   شموع    صفقات   ربح%    صافي نقاط     PF');
console.log('─'.repeat(56));
for(const tf of [1,2,3,5,15,30,60]){
  const {bars:cb}=E.resample(bars,tf);
  const r=run(tf);
  console.log(String(tf+'m').padStart(9), String(cb.length).padStart(8), String(r.trades??0).padStart(8),
    f(r.winRate,2).padStart(7), ((r.netPoints>0?'+':'')+f(r.netPoints,0)).padStart(11), f(r.profitFactor,3).padStart(7));
}
