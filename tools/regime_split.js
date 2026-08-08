// 15m's shorts beat blind shorting by 6.6 points while its longs trailed blind
// buying by 2.7. If that split is skill it should hold in rising months too; if
// it is the downtrend speaking, it inverts. Month by month is the test.
const fs=require('fs'),zlib=require('zlib');
const E=require('./ai963_engine');
const PU=0.10,COST=0.5,MAXH=1440;
const html=fs.readFileSync(require('path').join(__dirname,'..','KAKASHI_V16_TV_PARITY_AUDIT.html'),'utf8');
const csv=zlib.gunzipSync(Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1],'base64')).toString('utf8');
const L=csv.split('\n');const bars=[];
for(let i=1;i<L.length;i++){if(!L[i])continue;const a=L[i].split(',');const t=Date.parse(a[0].replace(' ','T'));const c=+a[4];if(!Number.isFinite(t)||!Number.isFinite(c))continue;bars.push({t,o:+a[1],h:+a[2],l:+a[3],c});}
bars.sort((x,y)=>x.t-y.t);
const atr14=E.atr(bars,14);
const mk=t=>new Date(t).toISOString().slice(0,7);

function race(i,dir){const e=bars[i].c,tpx=e+dir*9,spx=e-dir*9;
  const end=Math.min(bars.length-1,i+MAXH);
  for(let j=i+1;j<=end;j++){const b=bars[j];
    const ht=dir===1?b.h>=tpx:b.l<=tpx,hs=dir===1?b.l<=spx:b.h>=spx;
    if(ht&&hs)return null; if(ht)return 90-COST; if(hs)return -90-COST;}
  return (bars[end].c-e)*dir/PU-COST;}

const p={priceValue:'hma',priceLen:4,targetValue:'Price Action',targetLen:4,closest:3,smoothing:19,
  lineType:'RMA (original)',signalLine:'Average KNN',touchPts:0,wickPts:0,bufferPts:0,useAtr:false,bodySameSide:true};
const {bars:tb,index}=E.resample(bars,15);
const line=E.projectConfirmed(E.knnLine(tb,p),index);
const s=E.signalSet(bars,line,atr14,p,PU);

const M={};
for(let i=0;i<bars.length;i++){
  const b=s.buyRej[i]||s.buyBrk[i],se=s.sellRej[i]||s.sellBrk[i];
  let dir=0; if(b&&!se)dir=1; else if(se&&!b)dir=-1; else continue;
  const pt=race(i,dir); if(pt===null)continue;
  const k=mk(bars[i].t);(M[k]??={ln:0,lnet:0,sn:0,snet:0});
  if(dir===1){M[k].ln++;M[k].lnet+=pt}else{M[k].sn++;M[k].snet+=pt}}

// how gold itself moved each month
const px={};for(const b of bars){const k=mk(b.t);(px[k]??={first:b.c});px[k].last=b.c;}

const f=(x,d=2)=>x.toFixed(d);
console.log('15m — أداء الشراء مقابل البيع في كل شهر (هدف/وقف 90/90)\n');
console.log('الشهر     حركة الذهب   صفقات شراء  نقطة/شراء   صفقات بيع  نقطة/بيع   الفرق');
console.log('─'.repeat(78));
for(const k of Object.keys(M).sort()){
  const m=M[k],mv=px[k].last-px[k].first;
  const lp=m.ln?m.lnet/m.ln:0, sp=m.sn?m.snet/m.sn:0;
  console.log(k, (mv>0?'+':'')+f(mv,0).padStart(10), String(m.ln).padStart(12), (lp>0?'+':'')+f(lp,2).padStart(10),
    String(m.sn).padStart(11), (sp>0?'+':'')+f(sp,2).padStart(9), (sp-lp>0?'+':'')+f(sp-lp,2).padStart(8));}

console.log('\nالارتباط بين حركة الذهب الشهرية وأفضلية البيع على الشراء:');
const ks=Object.keys(M).sort();
const X=ks.map(k=>px[k].last-px[k].first);
const Y=ks.map(k=>{const m=M[k];return (m.sn?m.snet/m.sn:0)-(m.ln?m.lnet/m.ln:0)});
const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
const mx=mean(X),my=mean(Y);
const r=X.reduce((a,_,i)=>a+(X[i]-mx)*(Y[i]-my),0)/Math.sqrt(X.reduce((a,v)=>a+(v-mx)**2,0)*Y.reduce((a,v)=>a+(v-my)**2,0));
console.log(`  r = ${f(r,3)}   (‑1 يعني: كل ما نزل الذهب، تفوّق البيع — أي أن النتيجة انعكاس للسوق لا مهارة)`);
