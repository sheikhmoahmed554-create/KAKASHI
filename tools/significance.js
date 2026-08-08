// 349 trades from eight sources reading the same market are not 349 independent
// bets — they fire together on the same moves. Textbook binomial error bars
// therefore understate how much a short window can swing. Measure the real
// spread across windows and compare it to what independence would predict.
const fs=require('fs');
const {trades}=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const DAY=86400000, SPAN=13*DAY;      // 26 Jul 22:00 -> 8 Aug 13:35
const USER={win:233,loss:116,avgWin:88.2,avgLoss:94.7,net:9560};
const f=(x,d=2)=>x.toFixed(d);

const t0=trades[0].entryTime, tE=trades[trades.length-1].entryTime;
const rows=[];
for(let s=t0;s+SPAN<=tE;s+=DAY){
  const w=trades.filter(t=>t.entryTime>=s&&t.entryTime<s+SPAN);
  if(w.length<200)continue;
  rows.push({n:w.length,wr:100*w.filter(t=>t.points>0).length/w.length,
    net:w.reduce((a,t)=>a+t.points,0),s});
}
const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
const sd=a=>{const m=mean(a);return Math.sqrt(a.reduce((x,v)=>x+(v-m)**2,0)/(a.length-1));};
const wrs=rows.map(r=>r.wr), ns=rows.map(r=>r.n);

const beWR=100*USER.avgLoss/(USER.avgWin+USER.avgLoss);
const nAvg=mean(ns);
const binomSD=Math.sqrt((beWR/100)*(1-beWR/100)/nAvg)*100;
const obsSD=sd(wrs);
const inflation=obsSD/binomSD;

console.log(`نوافذ 13 يومًا في الستة أشهر: ${rows.length}   (متوسط ${f(nAvg,0)} صفقة لكل نافذة)\n`);
console.log(`نسبة الربح: وسط ${f(mean(wrs))}%   انحراف فعلي ${f(obsSD)} نقطة مئوية`);
console.log(`الانحراف لو كانت الصفقات مستقلة: ${f(binomSD)} نقطة مئوية`);
console.log(`معامل التضخّم (ترابط الصفقات): ×${f(inflation)}\n`);

console.log(`نقطة التعادل بأرقامك (${USER.avgWin} مقابل ${USER.avgLoss}): ${f(beWR)}%`);
const userWR=100*USER.win/(USER.win+USER.loss);
console.log(`نسبتك: ${f(userWR)}%   الأفضلية: +${f(userWR-beWR)} نقطة مئوية\n`);

const zNaive=(userWR-beWR)/(Math.sqrt((beWR/100)*(1-beWR/100)/(USER.win+USER.loss))*100);
const zReal=zNaive/inflation;
console.log(`z لو اعتبرنا الصفقات مستقلة : ${f(zNaive)}`);
console.log(`z بعد تصحيح الترابط        : ${f(zReal)}`);
const p=x=>0.5*(1-erf(x/Math.SQRT2));
function erf(x){const s=x<0?-1:1;x=Math.abs(x);const a=[0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429],p_=0.3275911;
 const t=1/(1+p_*x);let y=1-((((a[4]*t+a[3])*t+a[2])*t+a[1])*t+a[0])*t*Math.exp(-x*x);return s*y;}
console.log(`احتمال الحصول على هذا بالصدفة: ${(p(zReal)*100).toFixed(3)}%\n`);

console.log(`أعلى نسبة ربح في أي نافذة 13 يومًا عندي: ${f(Math.max(...wrs))}%`);
console.log(`أعلى صافي في أي نافذة 13 يومًا عندي   : ${f(Math.max(...rows.map(r=>r.net)),0)} نقطة   (أنت: ${USER.net})`);

let cw=0,mw=0; for(const t of trades){if(t.points>0){cw++;if(cw>mw)mw=cw}else cw=0}
console.log(`\nأطول سلسلة ربح في ستة أشهر عندي: ${mw}   (أنت: 18 في 13 يومًا)`);
