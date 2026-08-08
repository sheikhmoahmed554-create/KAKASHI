// One train/test split can flatter a rule by luck. A filter worth keeping has
// to help in most months, not just on average. Month by month, with and without.
const fs=require('fs'),zlib=require('zlib');
const E=require('./ai963_engine');
const PU=0.10,COST=0.5;
const html=fs.readFileSync(require('path').join(__dirname,'..','KAKASHI_V16_TV_PARITY_AUDIT.html'),'utf8');
const csv=zlib.gunzipSync(Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1],'base64')).toString('utf8');
const L=csv.split('\n');const bars=[];
for(let i=1;i<L.length;i++){if(!L[i])continue;const a=L[i].split(',');const t=Date.parse(a[0].replace(' ','T'));const c=+a[4];if(!Number.isFinite(t)||!Number.isFinite(c))continue;bars.push({t,o:+a[1],h:+a[2],l:+a[3],c});}
bars.sort((x,y)=>x.t-y.t);
const atr14=E.atr(bars,14);
const {trades}=require('/tmp/claude-0/-home-user-KAKASHI/1e4c19d8-9d0d-5ea3-8b5c-535feed62b87/scratchpad/six_fixed.json');
const jul=require('/tmp/claude-0/-home-user-KAKASHI/1e4c19d8-9d0d-5ea3-8b5c-535feed62b87/scratchpad/july.json').trades;
const all=[...trades,...jul].map(t=>({...t,ATR:atr14[t.entryBar]/PU}));
const mk=t=>new Date(t).toISOString().slice(0,7);
const f=(x,d=1)=>x.toFixed(d);
const st=v=>({n:v.length,wr:v.length?100*v.filter(t=>t.points>0).length/v.length:0,net:v.reduce((a,t)=>a+t.points,0)});

for(const CUT of [20,26,30,35]){
  const M={};for(const t of all)(M[mk(t.entryTime)]??=[]).push(t);
  let better=0,tot=0,netAll=0,netF=0,nAll=0,nF=0;
  const lines=[];
  for(const k of Object.keys(M).sort()){
    const a=st(M[k]), b=st(M[k].filter(t=>t.ATR<=CUT));
    if(b.net>a.net)better++; tot++;
    netAll+=a.net;netF+=b.net;nAll+=a.n;nF+=b.n;
    lines.push(`  ${k}  بلا فلتر ${((a.net>0?'+':'')+a.net.toFixed(0)).padStart(6)}  →  مع الفلتر ${((b.net>0?'+':'')+b.net.toFixed(0)).padStart(6)}  (${b.n}/${a.n} صفقة)`);
  }
  console.log(`\nفلتر: ATR ≤ ${CUT} نقطة   —  حسّن ${better} من ${tot} أشهر`);
  console.log(lines.join('\n'));
  console.log(`  المجموع: ${netAll.toFixed(0)} → ${netF.toFixed(0)} نقطة   |  الصفقات: ${nAll} → ${nF}  |  نقطة/صفقة: ${f(netAll/nAll,2)} → ${f(netF/nF,2)}`);
}
