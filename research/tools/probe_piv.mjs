import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
const b = await chromium.launch();
const page = await b.newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('file:///home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html');
await page.waitForTimeout(6000);
const src = `//@version=6
indicator("probe")
p = ta.pivotlow(low, 3, 3)
var float lastLo = na
if not na(p)
    lastLo := p
isNaP  = na(p) ? 1 : 0
isNaLo = na(lastLo) ? 1 : 0
dist   = na(lastLo) ? 999999.0 : (close - lastLo) / 0.1
plot(p)`;
let txt = fs.readFileSync('vault.csv','utf8').split('\n').slice(0,801).join('\n');
const r = await page.evaluate(async ({csvText, source}) => {
  const rows = PineLabJS.parseCSV(csvText);
  let res;
  try { res = new PineLabJS.PineEngine(source).run(rows, ['p','lastLo','isNaP','isNaLo','dist']); }
  catch(e) { return {error: e.message}; }
  const S = res.series, g = k => S[k]||[];
  const d = g('dist'), lo = g('lastLo'), inp = g('isNaP');
  const fin = d.filter(x => Number.isFinite(Number(x)));
  return { bars: res.bars, diag: res.diagnostics.slice(0,2),
           naP_count: inp.reduce((a,x)=>a+(Number(x)||0),0),
           sample_p: g('p').slice(300,312),
           sample_lastLo: lo.slice(300,312),
           sample_dist: d.slice(300,312),
           dist_under20: fin.filter(x=>Number(x)<20).length, dist_total: fin.length };
}, {csvText: txt, source: src});
console.log(JSON.stringify(r, null, 1));
await b.close();
