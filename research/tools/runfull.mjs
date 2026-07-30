import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
const [csv,start,end,mode,out] = process.argv.slice(2);
const b = await chromium.launch();
const page = await b.newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('file:///home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html');
await page.waitForTimeout(6000);
await page.setInputFiles('#csv', csv);
await page.waitForTimeout(5000);
await page.selectOption('#tvMatch', mode);
if (start) await page.fill('#start', start);
if (end) await page.fill('#end', end);
await page.click('#run');
for (let i=0;i<3000;i++){ await page.waitForTimeout(1000); if (await page.$eval('#run', e=>!e.disabled)) break; }
console.log('run   :', (await page.$eval('#runStatus', e=>e.innerText)).trim().replace(/\n/g,' | ').slice(0,260));
const j = await page.evaluate(() => (typeof last!=='undefined'&&last) ? {
  summary:last.summary, raw:last.raw_summary, tv:last.tv_summary, tested:last.tested_bars,
  from:last.used_from, to:last.used_to, fragile:last.fragile_wins,
  trades:(last.trades||[]).map(t=>({id:t.id,side:t.side,entry:t.entry_time,exit:t.exit_time,
    ep:t.entry_price,tp:t.tp,sl:t.sl,outcome:t.outcome,points:t.points,target:t.target_points,
    stop:t.stop_points,over:t.tp_overshoot_points,src:t.source,code:t.reported_source_code,kind:t.trade_kind}))
} : null);
if (j){ fs.writeFileSync(out, JSON.stringify(j)); console.log('saved :', out, '| trades', j.trades.length); }
await b.close();
