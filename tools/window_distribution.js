// The chart table counts every trade in the loaded history. On a 1m chart that
// history is days, not months. So the honest comparison is not 342 trades
// against 7,212 — it is 342 against every 342-trade window the six months hold.
const fs=require('fs');
const {trades}=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const W=342, TARGET_WR=69.3, TARGET_NET=11370;
const wins=trades.map(t=>t.points>0?1:0), pts=trades.map(t=>t.points);

const rows=[];
for(let i=0;i+W<=trades.length;i++){
  let w=0,net=0;
  for(let k=i;k<i+W;k++){w+=wins[k];net+=pts[k];}
  rows.push({i,wr:100*w/W,net,from:trades[i].entryTime,to:trades[i+W-1].exitTime});
}
const wrs=rows.map(r=>r.wr).sort((a,b)=>a-b);
const nets=rows.map(r=>r.net).sort((a,b)=>a-b);
const q=(a,p)=>a[Math.min(a.length-1,Math.floor(p*a.length))];
const f=(x,d=1)=>x.toFixed(d);

console.log(`عدد النوافذ المتاحة بطول ${W} صفقة: ${rows.length.toLocaleString()}\n`);
console.log('توزيع نسبة الربح عبر النوافذ');
console.log(`  الأدنى ${f(wrs[0])}%   ربع ${f(q(wrs,.25))}%   وسيط ${f(q(wrs,.5))}%   ثلاثة أرباع ${f(q(wrs,.75))}%   الأعلى ${f(wrs[wrs.length-1])}%`);
console.log('\nتوزيع صافي النقاط عبر النوافذ');
console.log(`  الأدنى ${f(nets[0],0)}   ربع ${f(q(nets,.25),0)}   وسيط ${f(q(nets,.5),0)}   ثلاثة أرباع ${f(q(nets,.75),0)}   الأعلى ${f(nets[nets.length-1],0)}`);

const ge=rows.filter(r=>r.wr>=TARGET_WR).length;
const geNet=rows.filter(r=>r.net>=TARGET_NET).length;
console.log(`\nنوافذ بنسبة ربح ≥ ${TARGET_WR}% : ${ge} من ${rows.length}  (${f(100*ge/rows.length,1)}%)`);
console.log(`نوافذ بصافي ≥ ${TARGET_NET} نقطة : ${geNet} من ${rows.length}  (${f(100*geNet/rows.length,1)}%)`);

const best=rows.slice().sort((a,b)=>b.net-a.net)[0];
const worst=rows.slice().sort((a,b)=>a.net-b.net)[0];
const d=t=>new Date(t).toISOString().slice(0,10);
console.log(`\nأفضل نافذة  : ${d(best.from)} → ${d(best.to)}   نسبة ${f(best.wr)}%   صافي ${f(best.net,0)}`);
console.log(`أسوأ نافذة  : ${d(worst.from)} → ${d(worst.to)}   نسبة ${f(worst.wr)}%   صافي ${f(worst.net,0)}`);

// same thing per calendar week, which is closer to what a loaded chart shows
const byWeek={};
for(const t of trades){const k=new Date(t.entryTime);const y=k.getUTCFullYear();
  const day=Math.floor((k-Date.UTC(y,0,1))/86400000);const wk=y+'-W'+String(Math.floor(day/7)+1).padStart(2,'0');
  (byWeek[wk]??=[]).push(t);}
const wk=Object.entries(byWeek).map(([k,v])=>({k,n:v.length,
  wr:100*v.filter(t=>t.points>0).length/v.length,net:v.reduce((a,t)=>a+t.points,0)}))
  .filter(x=>x.n>=100).sort((a,b)=>b.net-a.net);
console.log(`\nأفضل خمسة أسابيع من أصل ${wk.length}:`);
for(const x of wk.slice(0,5))console.log(`  ${x.k}  ${String(x.n).padStart(4)} صفقة  نسبة ${f(x.wr)}%  صافي ${(x.net>0?'+':'')+f(x.net,0)}`);
console.log('أسوأ خمسة:');
for(const x of wk.slice(-5))console.log(`  ${x.k}  ${String(x.n).padStart(4)} صفقة  نسبة ${f(x.wr)}%  صافي ${(x.net>0?'+':'')+f(x.net,0)}`);
