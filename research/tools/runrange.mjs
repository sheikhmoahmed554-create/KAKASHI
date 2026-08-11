import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
const [csv, start, end, out] = process.argv.slice(2);
const b = await chromium.launch();
const page = await b.newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('file:///tmp/claude-0/-home-user-KAKASHI/1fe6b375-ff1f-58c9-a3ea-9d7f686c3fae/scratchpad/v16_syr30.html');
await page.waitForTimeout(5000);
await page.setInputFiles('#csv', csv);
await page.waitForTimeout(4000);
await page.fill('#start', start);
await page.fill('#end', end);
await page.click('#run');
const t0 = Date.now();
for (let i=0;i<2400;i++){ await page.waitForTimeout(1000); if (await page.$eval('#run', e=>!e.disabled)) break; }
console.log('wall  :', ((Date.now()-t0)/1000).toFixed(1)+'s');
console.log('run   :', (await page.$eval('#runStatus', e=>e.innerText)).trim().replace(/\n/g,' | ').slice(0,300));
console.log('parity:', (await page.$eval('#parityStatus', e=>e.innerText).catch(()=>'-')).trim().replace(/\n/g,' | ').slice(0,300));
const j = await page.evaluate(() => (typeof last!=='undefined'&&last) ? {
  summary:last.summary, tested_bars:last.tested_bars, warmup:last.warmup_bars,
  used_from:last.used_from, used_to:last.used_to, skipped:last.ambiguous_bars,
  fragile:last.fragile_wins, fragile_base:last.fragile_base_wins, profile:last.profile,
  removed:last.profile_rows_removed, secs:last.runtime_seconds,
  trades:(last.trades||[]).map(t=>({id:t.id,side:t.side,entry:t.entry_time,exit:t.exit_time,
    entry_price:t.entry_price,tp:t.tp,sl:t.sl,outcome:t.outcome,points:t.points,
    target:t.target_points,stop:t.stop_points,overshoot:t.tp_overshoot_points,fragile:t.feed_fragile,src:t.source}))
} : null);
if (j) { fs.writeFileSync(out, JSON.stringify(j,null,1)); console.log('saved :', out, '| trades:', j.trades.length); }
else console.log('!! could not read result object');
await b.close();
