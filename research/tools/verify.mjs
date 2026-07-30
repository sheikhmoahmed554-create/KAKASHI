import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const [csv,start,end,mode] = process.argv.slice(2);
const b = await chromium.launch();
const page = await b.newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('file:///home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html');
await page.waitForTimeout(6000);
console.log('boot   :', (await page.$eval('#boot', e=>e.innerText)).trim().slice(0,150));
if (!csv) { await b.close(); process.exit(0); }
await page.setInputFiles('#csv', csv);
await page.waitForTimeout(4000);
await page.selectOption('#tvMatch', mode);
await page.fill('#start', start); await page.fill('#end', end);
await page.click('#run');
for (let i=0;i<900;i++){ await page.waitForTimeout(1000); if (await page.$eval('#run', e=>!e.disabled)) break; }
console.log('mode   :', mode);
console.log('parity :', (await page.$eval('#parityStatus', e=>e.innerText)).trim());
console.log('tiles  :', await page.evaluate(()=>['sT','sW','sL','sWR','sN'].map(id=>id+'='+document.getElementById(id).textContent).join('  ')));
await b.close();
