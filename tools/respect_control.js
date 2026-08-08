// Every level type scored above 60% respect, which is either a discovery or a
// property of how "respect" was defined. Random price levels settle it: if an
// arbitrary number gets the same rate, the metric measures the market's habit
// of bouncing, not the level's significance.
const fs=require('fs'),path=require('path'),zlib=require('zlib');
const E=require('./ai963_engine');
const {levelTestEvents,respectRate}=require('./level_events');
const html=fs.readFileSync(require('path').join(__dirname,'..','KAKASHI_V16_TV_PARITY_AUDIT.html'),'utf8');
const csv=zlib.gunzipSync(Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1],'base64')).toString('utf8');
const L=csv.split('\n');const bars=[];
for(let i=1;i<L.length;i++){if(!L[i])continue;const a=L[i].split(',');const t=Date.parse(a[0].replace(' ','T'));const c=+a[4];if(!Number.isFinite(t)||!Number.isFinite(c))continue;bars.push({t,o:+a[1],h:+a[2],l:+a[3],c,v:+a[5]});}
bars.sort((x,y)=>x.t-y.t);
const atr14=E.atr(bars,14);const N=bars.length;
function constantLine(level,maxDistAtr=6){const out=new Array(N).fill(NaN);
  for(let i=0;i<N;i++){const a=atr14[i];if(Number.isFinite(a)&&Math.abs(bars[i].c-level)<=a*maxDistAtr)out[i]=level;}return out;}
function rng(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

let lo=Infinity,hi=-Infinity;for(const b of bars){if(b.l<lo)lo=b.l;if(b.h>hi)hi=b.h;}
const f=(x,d=1)=>x.toFixed(d);

// Random levels: arbitrary prices, deliberately avoiding the round grid so the
// control cannot accidentally sit on the very thing being tested.
const runs=[];
for(let s=1;s<=6;s++){
  const r=rng(s*7717);const ev=[];
  for(let k=0;k<400;k++){
    let px=lo+r()*(hi-lo);
    if(Math.abs(px-Math.round(px/10)*10)<1.5)px+=3.7;   // keep clear of $10 marks
    ev.push(...levelTestEvents(bars,constantLine(px),atr14));
  }
  runs.push(respectRate(ev));
}
const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
const rs=runs.map(x=>x.respect);
const m=mean(rs);
const sd=Math.sqrt(rs.reduce((a,v)=>a+(v-m)**2,0)/(rs.length-1));
console.log('ضابط: مستويات سعرية عشوائية (6 جولات × 400 مستوى)\n');
console.log(`  اختبارات لكل جولة: ~${Math.round(mean(runs.map(x=>x.tests)))}`);
console.log(`  نسبة الاحترام    : ${f(m,2)}% ± ${f(sd,2)}\n`);
console.log('  إذن أي مستوى نسبته قريبة من هذا الرقم = لا يعني شيئًا.\n');

const measured=[['قمم حقيقية',94.8],['قيعان حقيقية',93.8],['فشل متكرر — قمة',93.8],['فشل متكرر — قاع',92.0],
 ['ترند صاعد',79.9],['ترند هابط',78.4],['فجوات FVG',75.4],['امتصاص',72.6],['انقلاب الدور',70.7],['عقدة الحجم',70.3],
 ['أرقام مستديرة $10',69.3],['فيبوناتشي اليومي',69.1],['أرقام $25',69.2],['أرقام $50',68.9],
 ['نطاق آسيا',68.4],['افتتاح اليوم',68.3],['بيفوت كلاسيكي',68.3],['VWAP',67.8],['اليوم السابق',66.3],['بلوك الأوامر',61.5]];
console.log('  المستوى                 احترام%   الفرق عن العشوائي   الحكم');
console.log('  '+'─'.repeat(64));
for(const [nm,v] of measured){
  const d=v-m;
  const z=d/sd;
  const verdict = Math.abs(z)<2 ? 'لا فرق عن العشوائي' : z>0 ? '★ أعلى فعلًا' : 'أسوأ من العشوائي';
  console.log('  '+nm.padEnd(22), f(v).padStart(6), ((d>0?'+':'')+f(d)).padStart(16), '   '+verdict);
}
