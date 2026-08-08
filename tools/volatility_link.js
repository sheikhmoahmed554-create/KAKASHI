// The regime tables point at absolute volatility. If that is the real driver,
// each month's ATR should line up with that month's result — and July, the
// month right before the user's window, should sit in the good zone.
const fs=require('fs'),zlib=require('zlib');
const E=require('./ai963_engine');
const PU=0.10;
const html=fs.readFileSync(require('path').join(__dirname,'..','KAKASHI_V16_TV_PARITY_AUDIT.html'),'utf8');
const csv=zlib.gunzipSync(Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1],'base64')).toString('utf8');
const L=csv.split('\n');const bars=[];
for(let i=1;i<L.length;i++){if(!L[i])continue;const a=L[i].split(',');const t=Date.parse(a[0].replace(' ','T'));const c=+a[4];if(!Number.isFinite(t)||!Number.isFinite(c))continue;bars.push({t,o:+a[1],h:+a[2],l:+a[3],c});}
bars.sort((x,y)=>x.t-y.t);
const atr14=E.atr(bars,14);
const mk=t=>new Date(t).toISOString().slice(0,7);

const {trades}=require('/tmp/claude-0/-home-user-KAKASHI/1e4c19d8-9d0d-5ea3-8b5c-535feed62b87/scratchpad/six_fixed.json');
const jul=require('/tmp/claude-0/-home-user-KAKASHI/1e4c19d8-9d0d-5ea3-8b5c-535feed62b87/scratchpad/july.json').trades;
const all=[...trades,...jul];

const A={};for(let i=0;i<bars.length;i++){if(!Number.isFinite(atr14[i]))continue;const k=mk(bars[i].t);(A[k]??=[]).push(atr14[i]/PU);}
const T={};for(const t of all){(T[mk(t.entryTime)]??=[]).push(t);}
const med=a=>{const s=a.slice().sort((x,y)=>x-y);return s[s.length>>1]};
const f=(x,d=2)=>x.toFixed(d);
console.log('التذبذب الشهري مقابل نتيجة المؤشر\n');
console.log('الشهر     ATR وسيط   حصة الصفقات تحت 30 نقطة   نسبة الربح   صافي');
console.log('─'.repeat(70));
const rows=[];
for(const k of Object.keys(T).sort()){
  const v=T[k],w=v.filter(t=>t.points>0).length,net=v.reduce((a,t)=>a+t.points,0);
  const share=100*A[k].filter(x=>x<=30).length/A[k].length;
  rows.push({k,atr:med(A[k]),share,wr:100*w/v.length,net});
  console.log(k, f(med(A[k]),1).padStart(10), f(share,0).padStart(22)+'%', f(100*w/v.length,1).padStart(12)+'%', ((net>0?'+':'')+f(net,0)).padStart(8));
}
const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
const X=rows.map(r=>r.atr),Y=rows.map(r=>r.net);
const mx=mean(X),my=mean(Y);
const r=X.reduce((a,_,i)=>a+(X[i]-mx)*(Y[i]-my),0)/Math.sqrt(X.reduce((a,v)=>a+(v-mx)**2,0)*Y.reduce((a,v)=>a+(v-my)**2,0));
console.log(`\nالارتباط بين وسيط ATR الشهري وصافي الشهر: r = ${f(r,3)}`);
const X2=rows.map(r=>r.share);const mx2=mean(X2);
const r2=X2.reduce((a,_,i)=>a+(X2[i]-mx2)*(Y[i]-my),0)/Math.sqrt(X2.reduce((a,v)=>a+(v-mx2)**2,0)*Y.reduce((a,v)=>a+(v-my)**2,0));
console.log(`الارتباط بين حصة الشموع الهادئة وصافي الشهر: r = ${f(r2,3)}`);
