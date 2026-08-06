const fs=require('fs');
const {loadRows,backtest}=require('./run.js');
const src=fs.readFileSync(process.argv[2],'utf8');
const bars=parseInt(process.argv[3]||'60000',10);
const inputs=process.argv[4]?JSON.parse(process.argv[4]):{};
const fromISO=process.argv[5]||null;
const rows=loadRows(bars,fromISO);
const r=backtest({source:src,rows,inputs});
if(!r.ok){console.error('ERR',r.error);process.exit(1);}
console.log(`from=${new Date(rows[0].time).toISOString().slice(0,10)} to=${new Date(rows[rows.length-1].time).toISOString().slice(0,10)} bars=${r.bars} trades=${r.trades.length} overall win%=${r.summary.win_rate.toFixed(2)} net=${r.summary.net_points}`);
const by={};
for(const t of r.trades){
  const k=t.source||'?';
  by[k]=by[k]||{t:0,w:0,net:0,buy:0,sell:0,bw:0,sw:0};
  by[k].t++; if(t.outcome==='WIN'){by[k].w++;} by[k].net+=t.points||0;
  if(t.side==='BUY'){by[k].buy++; if(t.outcome==='WIN')by[k].bw++;} else {by[k].sell++; if(t.outcome==='WIN')by[k].sw++;}
}
console.log('\nENGINE       trades   wins   win%      net   | BUY w%    SELL w%');
console.log('-'.repeat(72));
const rowsOut=Object.entries(by).sort((a,b)=>b[1].net-a[1].net);
for(const [k,v] of rowsOut){
  const wr=v.t?100*v.w/v.t:0, bwr=v.buy?100*v.bw/v.buy:0, swr=v.sell?100*v.sw/v.sell:0;
  console.log(`${k.padEnd(12)} ${String(v.t).padStart(6)} ${String(v.w).padStart(6)} ${wr.toFixed(1).padStart(6)} ${String(v.net).padStart(8)}   | ${bwr.toFixed(1).padStart(5)}(${v.buy})  ${swr.toFixed(1).padStart(5)}(${v.sell})`);
}
