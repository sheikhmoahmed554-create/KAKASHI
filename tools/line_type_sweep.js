// The chart table reads "RMA +mix", so at least one source is not on RMA.
// Sweep the line types the port implements across all eight sources.
const fs=require('fs'),zlib=require('zlib');
const E=require('./ai963_engine');
const PU=0.10,COST=0.5,UNTIL=Date.parse('2026-07-01T00:00:00Z');
const html=fs.readFileSync(require('path').join(__dirname,'..','KAKASHI_V16_TV_PARITY_AUDIT.html'),'utf8');
const csv=zlib.gunzipSync(Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1],'base64')).toString('utf8');
const L=csv.split('\n');const bars=[];
for(let i=1;i<L.length;i++){if(!L[i])continue;const a=L[i].split(',');const t=Date.parse(a[0].replace(' ','T'));const c=+a[4];if(!Number.isFinite(t)||!Number.isFinite(c))continue;bars.push({t,o:+a[1],h:+a[2],l:+a[3],c});}
bars.sort((x,y)=>x.t-y.t);
const atr14=E.atr(bars,14);

const PRESET=[
 {name:'CHART 1m',tf:1,priceValue:'hma',priceLen:5,targetValue:'Price Action',targetLen:5,closest:3,smoothing:51,signalLine:'Average KNN',touchPts:3,wickPts:20,bufferPts:4.5,useAtr:false,bodySameSide:true,tp:90,sl:90,respectOthers:false,cooldown:7,buyCooldown:0,sellCooldown:0},
 {name:'2m',tf:2,priceValue:'hma',priceLen:7,targetValue:'Price Action',targetLen:5,closest:3,smoothing:40,signalLine:'Average KNN',touchPts:0,wickPts:2,bufferPts:7,useAtr:false,bodySameSide:true,tp:70,sl:100,respectOthers:false,cooldown:0,buyCooldown:0,sellCooldown:0},
 {name:'3m',tf:3,priceValue:'hma',priceLen:5,targetValue:'Price Action',targetLen:5,closest:3,smoothing:28,signalLine:'Average KNN',touchPts:0,wickPts:4,bufferPts:2,useAtr:false,bodySameSide:true,tp:105,sl:90,respectOthers:false,cooldown:21,buyCooldown:0,sellCooldown:0},
 {name:'5m',tf:5,priceValue:'hma',priceLen:5,targetValue:'Price Action',targetLen:5,closest:3,smoothing:28,signalLine:'Average KNN',touchPts:0,wickPts:0,bufferPts:0,useAtr:false,bodySameSide:true,tp:90,sl:90,respectOthers:true,cooldown:0,buyCooldown:0,sellCooldown:0},
 {name:'10m',tf:10,priceValue:'hma',priceLen:4,targetValue:'Price Action',targetLen:4,closest:3,smoothing:22,signalLine:'Average KNN',touchPts:0,wickPts:0,bufferPts:0,useAtr:false,bodySameSide:true,tp:90,sl:90,respectOthers:true,cooldown:0,buyCooldown:0,sellCooldown:0},
 {name:'15m',tf:15,priceValue:'hma',priceLen:4,targetValue:'Price Action',targetLen:4,closest:3,smoothing:19,signalLine:'Average KNN',touchPts:0,wickPts:0,bufferPts:0,useAtr:false,bodySameSide:true,tp:90,sl:90,respectOthers:true,cooldown:0,buyCooldown:0,sellCooldown:0},
 {name:'30m',tf:30,priceValue:'hma',priceLen:3,targetValue:'Price Action',targetLen:3,closest:3,smoothing:15,signalLine:'Average KNN',touchPts:0,wickPts:0,bufferPts:0,useAtr:false,bodySameSide:true,tp:90,sl:90,respectOthers:true,cooldown:400,buyCooldown:0,sellCooldown:0},
 {name:'1H',tf:60,priceValue:'hma',priceLen:3,targetValue:'Price Action',targetLen:3,closest:3,smoothing:12,signalLine:'Average KNN',touchPts:1,wickPts:20,bufferPts:0,useAtr:false,bodySameSide:true,tp:150,sl:130,respectOthers:true,cooldown:80,buyCooldown:0,sellCooldown:0}];

function build(lineType){
  return PRESET.map(p=>{
    const cfg={...p,lineType};
    const {bars:tb,index}=E.resample(bars,p.tf);
    const raw=E.knnLine(tb,cfg);
    const line=p.tf===1?raw:E.projectConfirmed(raw,index);
    const s=E.signalSet(bars,line,atr14,cfg,PU);
    const n=bars.length,buy=new Uint8Array(n),sell=new Uint8Array(n),rej=new Uint8Array(n);
    for(let i=0;i<n;i++){const bR=s.buyRej[i],bB=s.buyBrk[i],sR=s.sellRej[i],sB=s.sellBrk[i];
      buy[i]=(bR||bB)?1:0;sell[i]=(sR||sB)?1:0;rej[i]=(bR||sR)?1:0;}
    return {...cfg,buy,sell,rejection:rej};});
}
const f=(x,d=2)=>Number.isFinite(x)?x.toFixed(d):'—';
console.log('نوع الخط على كل المصادر — ستة أشهر، يناير→يونيو 2026\n');
console.log('النوع            صفقات    ربح%   صافي نقاط     PF   أقصى تراجع');
console.log('─'.repeat(62));
const out=[];
for(const lt of ['RMA (original)','TEMA','HMA','DEMA','EMA','WMA','SMA']){
  const {trades}=E.runBacktest(bars,build(lt),{pointUnit:PU,sameCandleRule:'Skip',costPoints:COST});
  const s=E.summarize(trades.filter(t=>t.exitTime<UNTIL));
  out.push({lt,s});
}
out.sort((a,b)=>b.s.netPoints-a.s.netPoints);
for(const {lt,s} of out)
  console.log(lt.padEnd(16), String(s.trades).padStart(6), f(s.winRate).padStart(7),
    ((s.netPoints>0?'+':'')+f(s.netPoints,0)).padStart(11), f(s.profitFactor,3).padStart(7), f(s.maxDrawdownPoints,0).padStart(11));
