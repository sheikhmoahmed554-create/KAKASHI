// Their 342 trades came from ten days during a sharp gold rally. Does a strong
// trend lift this system's win rate? Every rolling ten-day window in the six
// months, scored against how far gold moved in it.
const fs=require('fs'),zlib=require('zlib');
const {trades}=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const html=fs.readFileSync(require('path').join(__dirname,'..','KAKASHI_V16_TV_PARITY_AUDIT.html'),'utf8');
const csv=zlib.gunzipSync(Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1],'base64')).toString('utf8');
const L=csv.split('\n');const bars=[];
for(let i=1;i<L.length;i++){if(!L[i])continue;const a=L[i].split(',');const t=Date.parse(a[0].replace(' ','T'));const c=+a[4];if(!Number.isFinite(t))continue;bars.push({t,c});}
bars.sort((x,y)=>x.t-y.t);
const pxAt=t=>{let lo=0,hi=bars.length-1;while(lo<hi){const m=(lo+hi)>>1;if(bars[m].t<t)lo=m+1;else hi=m;}return bars[lo].c;};

const DAY=86400000, SPAN=10*DAY;
const t0=trades[0].entryTime, tEnd=trades[trades.length-1].entryTime;
const rows=[];
for(let s=t0;s+SPAN<=tEnd;s+=DAY){
  const w=trades.filter(t=>t.entryTime>=s&&t.entryTime<s+SPAN);
  if(w.length<150)continue;
  const wins=w.filter(t=>t.points>0).length;
  const longs=w.filter(t=>t.side==='BUY').length;
  rows.push({s,n:w.length,wr:100*wins/w.length,net:w.reduce((a,t)=>a+t.points,0),
    longShare:100*longs/w.length, move:(pxAt(s+SPAN)-pxAt(s))/0.10});
}
const f=(x,d=1)=>x.toFixed(d);
const d=t=>new Date(t).toISOString().slice(0,10);
rows.sort((a,b)=>b.net-a.net);
console.log(`نوافذ 10 أيام متاحة: ${rows.length}\n`);
console.log('أفضل ست نوافذ عشرة أيام:');
console.log('  الفترة        صفقات  نسبة%  حصة الشراء%  حركة الذهب  صافي');
for(const r of rows.slice(0,6))
  console.log(`  ${d(r.s)}   ${String(r.n).padStart(4)}  ${f(r.wr).padStart(5)}  ${f(r.longShare).padStart(10)}  ${((r.move>0?'+':'')+f(r.move,0)).padStart(10)}  ${((r.net>0?'+':'')+f(r.net,0)).padStart(6)}`);
console.log('\nأسوأ ثلاث:');
for(const r of rows.slice(-3))
  console.log(`  ${d(r.s)}   ${String(r.n).padStart(4)}  ${f(r.wr).padStart(5)}  ${f(r.longShare).padStart(10)}  ${((r.move>0?'+':'')+f(r.move,0)).padStart(10)}  ${((r.net>0?'+':'')+f(r.net,0)).padStart(6)}`);

const wrs=rows.map(r=>r.wr).sort((a,b)=>a-b);
console.log(`\nمدى نسبة الربح على نوافذ 10 أيام: ${f(wrs[0])}%  إلى  ${f(wrs[wrs.length-1])}%   (وسيط ${f(wrs[wrs.length>>1])}%)`);
console.log(`نوافذ ≥ 69.3% : ${rows.filter(r=>r.wr>=69.3).length} من ${rows.length}`);

const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
const X=rows.map(r=>Math.abs(r.move)),Y=rows.map(r=>r.wr);
const mx=mean(X),my=mean(Y);
const r1=X.reduce((a,_,i)=>a+(X[i]-mx)*(Y[i]-my),0)/Math.sqrt(X.reduce((a,v)=>a+(v-mx)**2,0)*Y.reduce((a,v)=>a+(v-my)**2,0));
console.log(`\nالارتباط بين قوة حركة الذهب ونسبة الربح: r = ${f(r1,3)}`);
