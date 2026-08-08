// A 130k-point gap has to come from somewhere. The prime suspect is the higher
// timeframe line: read it with a one-bar lag and it is the last CLOSED value;
// read it without, and every 1m bar inside a 15m candle already knows where
// that candle finished. The second version cannot be traded, but it backtests
// beautifully. This runs both and prints the difference.
const fs=require('fs'),path=require('path'),zlib=require('zlib');
const E=require('./ai963_engine');
const PU=0.10;
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

// lag=1 -> last fully closed higher-timeframe value (honest)
// lag=0 -> the value of the candle the current bar is still inside (future)
function project(series,index,lag){const o=new Array(index.length).fill(NaN);
  for(let i=0;i<index.length;i++){const j=index[i]-lag;o[i]=j>=0?series[j]:NaN;}return o;}

function build(lag){
  return PRESET.map(p=>{
    const {bars:tb,index}=E.resample(bars,p.tf);
    const raw=E.knnLine(tb,p);
    const line=p.tf===1?raw:project(raw,index,lag);
    const s=E.signalSet(bars,line,atr14,p,PU);
    const n=bars.length,buy=new Uint8Array(n),sell=new Uint8Array(n),rej=new Uint8Array(n);
    for(let i=0;i<n;i++){const bR=s.buyRej[i],bB=s.buyBrk[i],sR=s.sellRej[i],sB=s.sellBrk[i];
      buy[i]=(bR||bB)?1:0;sell[i]=(sR||sB)?1:0;rej[i]=(bR||sR)?1:0;}
    return {...p,buy,sell,rejection:rej};});
}

const UNTIL=Date.parse('2026-07-01T00:00:00Z');
const f=(x,d=0)=>x.toFixed(d);
console.log('نفس المؤشر تمامًا — الفرق الوحيد: هل خط الفريم الأعلى يُقرأ بعد إغلاقه أم أثناءه\n');
for(const [lag,label] of [[1,'بتأخير شمعة (الشمعة مغلقة فعلًا) — ما فعلته'],[0,'بلا تأخير (يقرأ شمعة لم تُغلق بعد)']]){
  for(const cost of [0.5,0]){
    const {trades}=E.runBacktest(bars,build(lag),{pointUnit:PU,sameCandleRule:'Skip',costPoints:cost});
    const t6=trades.filter(x=>x.exitTime<UNTIL);
    const s=E.summarize(t6);
    console.log(`${label}${cost===0?'  [بدون سبريد]':''}`);
    console.log(`   صفقات ${String(s.trades).padStart(5)}   ربح% ${f(s.winRate,2)}   صافي ${(s.netPoints>0?'+':'')+f(s.netPoints)} نقطة   PF ${f(s.profitFactor,3)}\n`);
  }
}
