// +12.00 per trade out of sample is higher than anything measured in sample,
// which on 319 trades is as likely to be small-sample noise as it is an edge.
// Put an error bar on it, and check whether the month-by-month decay is real.
const oos=[
 {m:'2026-03',n:74,net:1462},{m:'2026-04',n:80,net:1400},{m:'2026-05',n:93,net:554},
 {m:'2026-06',n:59,net:541},{m:'2026-07',n:13,net:-127}];
const N=oos.reduce((a,x)=>a+x.n,0), NET=oos.reduce((a,x)=>a+x.net,0);
const per=NET/N;
// per-trade spread: targets in this run are 60-120 points, so a trade's
// outcome is roughly +-110. Use that as the standard deviation.
const SD=110;
const se=SD/Math.sqrt(N), t=per/se;
// trades overlap across up to three sources, so the independent count is lower
const effN=N/2.2, seEff=SD/Math.sqrt(effN), tEff=per/seEff;
const f=(x,d=2)=>x.toFixed(d);
console.log('الحصيلة خارج العيّنة');
console.log(`  ${N} صفقة   ${NET>0?'+':''}${NET} نقطة   ${f(per)} لكل صفقة\n`);
console.log(`  الخطأ المعياري ≈ ${f(se)}   t = ${f(t)}`);
console.log(`  بعد خصم التداخل (صفقات متزامنة): t ≈ ${f(tEff)}`);
console.log(`  ${Math.abs(tEff)>1.96?'دال إحصائيًا':'غير دال — المجال يشمل الصفر'}\n`);

// is the month-to-month decline a trend or noise?
const x=oos.map((_,i)=>i), y=oos.map(o=>o.n?o.net/o.n:0);
const mx=x.reduce((a,b)=>a+b)/x.length, my=y.reduce((a,b)=>a+b)/y.length;
const r=x.reduce((a,_,i)=>a+(x[i]-mx)*(y[i]-my),0)/Math.sqrt(x.reduce((a,v)=>a+(v-mx)**2,0)*y.reduce((a,v)=>a+(v-my)**2,0));
console.log('الاتجاه الشهري (نقطة/صفقة):');
for(const o of oos)console.log(`  ${o.m}  ${String(o.n).padStart(3)} صفقة  ${f(o.n?o.net/o.n:0).padStart(7)}`);
console.log(`  الارتباط مع الزمن: r = ${f(r,3)}  ← ${r<-0.7?'تدهور واضح':r<-0.3?'ميل للتدهور':'بلا اتجاه'}`);

// how much of the total sits in the first two months
const firstTwo=oos.slice(0,2).reduce((a,x)=>a+x.net,0);
console.log(`\n  أول شهرين: ${firstTwo} من ${NET} = ${f(100*firstTwo/NET,0)}% من الربح`);
console.log(`  آخر ثلاثة أشهر: ${NET-firstTwo} نقطة على ${oos.slice(2).reduce((a,x)=>a+x.n,0)} صفقة`);
