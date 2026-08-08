// Does entering at the candle close explain the wrong-footedness?
// Compare three entry methods on the same signals.
const fs=require('fs'),path=require('path'),zlib=require('zlib');
const E=require('./ai963_engine');
const PU=0.10, COST=0.5, MAXH=1440;
const html=fs.readFileSync(require('path').join(__dirname,'..','KAKASHI_V16_TV_PARITY_AUDIT.html'),'utf8');
const csv=zlib.gunzipSync(Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1],'base64')).toString('utf8');
const L=csv.split('\n');const bars=[];
for(let i=1;i<L.length;i++){if(!L[i])continue;const a=L[i].split(',');const t=Date.parse(a[0].replace(' ','T'));const c=+a[4];if(!Number.isFinite(t)||!Number.isFinite(c))continue;bars.push({t,o:+a[1],h:+a[2],l:+a[3],c});}
bars.sort((x,y)=>x.t-y.t);
const atr14=E.atr(bars,14);

const P={name:'15m',tf:15,priceValue:'hma',priceLen:4,targetValue:'Price Action',targetLen:4,closest:3,smoothing:19,lineType:'RMA (original)',signalLine:'Average KNN',touchPts:0,wickPts:0,bufferPts:0,useAtr:false,touchAtr:.20,wickAtr:.50,bufferAtr:.05,bodySameSide:true};
const P3={...P,name:'3m',tf:3,priceLen:5,targetLen:5,smoothing:28,wickPts:4,bufferPts:2};
const P1={...P,name:'CHART 1m',tf:1,priceLen:5,targetLen:5,smoothing:51,touchPts:3,wickPts:20,bufferPts:4.5};

function sigs(p){const {bars:tb,index}=E.resample(bars,p.tf);const raw=E.knnLine(tb,p);
  const line=p.tf===1?raw:E.projectConfirmed(raw,index);
  const s=E.signalSet(bars,line,atr14,p,PU);const out=[];
  for(let i=0;i<bars.length;i++){const b=s.buyRej[i]||s.buyBrk[i],se=s.sellRej[i]||s.sellBrk[i];
    if(b&&!se)out.push({i,dir:1,line:line[i]});else if(se&&!b)out.push({i,dir:-1,line:line[i]});}
  return out;}

function race(startBar,entry,dir,tp,sl){
  const tpx=entry+dir*tp*PU, spx=entry-dir*sl*PU;
  const end=Math.min(bars.length-1,startBar+MAXH);
  for(let j=startBar;j<=end;j++){const b=bars[j];
    const ht=dir===1?b.h>=tpx:b.l<=tpx, hs=dir===1?b.l<=spx:b.h>=spx;
    if(ht&&hs)return 0; if(ht)return tp-COST; if(hs)return -sl-COST;}
  return (bars[end].c-entry)*dir/PU-COST;}

// method: 'close' = market at signal close, 'open' = next bar open,
// 'limit' = resting order back at the line, valid for N bars
function run(list,method,tp,sl,limitWait=30){
  let n=0,w=0,net=0,filled=0;
  for(const s of list){
    let entry,start;
    if(method==='close'){entry=bars[s.i].c;start=s.i+1;}
    else if(method==='open'){if(s.i+1>=bars.length)continue;entry=bars[s.i+1].o;start=s.i+1;}
    else{ // limit back at the line
      if(!Number.isFinite(s.line))continue;
      let hit=-1;
      for(let j=s.i+1;j<=Math.min(bars.length-1,s.i+limitWait);j++){
        const b=bars[j];
        if(s.dir===1? b.l<=s.line : b.h>=s.line){hit=j;break;}}
      if(hit<0)continue;
      entry=s.line;start=hit+1;}
    filled++;
    const p=race(start,entry,s.dir,tp,sl);
    if(p===0)continue;
    n++;if(p>0)w++;net+=p;}
  return {n,wr:n?100*w/n:0,net,per:n?net/n:0,filled,fillRate:100*filled/list.length};
}

const f=(x,d=2)=>Number.isFinite(x)?x.toFixed(d):'—';
for(const p of [P,P3,P1]){
  const list=sigs(p);
  console.log(`\n${p.name}  —  ${list.length} إشارة`);
  console.log('  الطريقة              نُفِّذت   تنفيذ%   صفقات   ربح%    صافي   نقطة/صفقة');
  for(const m of ['close','open','limit']){
    const r=run(list,m,90,90);
    const label={close:'دخول على الإغلاق',open:'فتح الشمعة التالية',limit:'أمر معلّق عند الخط'}[m];
    console.log('  '+label.padEnd(20), String(r.filled).padStart(6), f(r.fillRate,1).padStart(7), String(r.n).padStart(7), f(r.wr,2).padStart(7), f(r.net,0).padStart(8), f(r.per,2).padStart(10));
  }
}
