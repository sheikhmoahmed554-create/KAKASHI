import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
const [csv, out] = process.argv.slice(2);
const b = await chromium.launch();
const page = await b.newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('file:///home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html');
await page.waitForTimeout(6000);
const text = fs.readFileSync(csv, 'utf8');
const res = await page.evaluate(async ({csvText}) => {
  const rows = PineLabJS.parseCSV(csvText);
  const S = ['finalS06','finalS09','finalS11','finalS12','finalS17','finalS18','finalS19','finalS22','finalS23'];
  const outs = [...S, 'finalFusionBuyVotes', 'finalFusionSellVotes', 'canEnterLong', 'canEnterShort'];
  const t0 = performance.now();
  const eng = new PineLabJS.PineEngine(document.getElementById('source').value);
  const r = eng.run(rows, outs);
  const sig = {};
  for (const k of outs) sig[k] = (r.series[k] || []).map(v => Number(v) || 0);
  return { bars: r.bars, secs: (performance.now()-t0)/1000,
           errors: r.diagnostics.length ? r.diagnostics[0].error : null,
           times: rows.map(x => x.time), close: rows.map(x => x.close), sig };
}, {csvText: text});
console.log('bars', res.bars, '| secs', res.secs.toFixed(0), '| errors', res.errors);
fs.writeFileSync(out, JSON.stringify(res));
console.log('saved', out);
await b.close();
