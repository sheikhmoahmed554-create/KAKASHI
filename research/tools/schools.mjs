/* يستخرج إشارات المدارس التسعة من SYR30 عبر محرك كاكاشي.
 *
 *   node schools.mjs vault.csv schools6m.json [maxBars]
 *
 * النسخة الأولى وقعت لأنها كانت بترجّع 13 سلسلة × 192 ألف رقم دفعة واحدة.
 * دلوقتي بترجّع أول شمعة في كل سلسلة إشارة بس — بيانات قليلة، والباقي بيتقرا من vault.csv. */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';

const [csv, out, maxBarsArg] = process.argv.slice(2);
const maxBars = maxBarsArg ? Number(maxBarsArg) : 0;

const SCHOOLS = ['finalS06','finalS09','finalS11','finalS12','finalS17',
                 'finalS18','finalS19','finalS22','finalS23'];

const b = await chromium.launch({ args: ['--js-flags=--max-old-space-size=8192'] });
const page = await b.newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('crash', () => console.log('!! الصفحة وقعت'));
page.on('console', m => { if (m.text().startsWith('[')) console.log(m.text()); });

await page.goto('file:///home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html');
await page.waitForTimeout(6000);

let text = fs.readFileSync(csv, 'utf8');
if (maxBars) text = text.split('\n').slice(0, maxBars + 1).join('\n');

const res = await page.evaluate(async ({ csvText, schools }) => {
  const rows = PineLabJS.parseCSV(csvText);
  console.log('[شموع محمّلة: ' + rows.length + ']');
  const outs = [...schools, 'finalFusionBuyVotes', 'finalFusionSellVotes'];
  const t0 = performance.now();
  let r;
  try {
    r = new PineLabJS.PineEngine(document.getElementById('source').value).run(rows, outs);
  } catch (e) {
    return { error: e.message };
  }
  console.log('[انتهى التشغيل في ' + Math.round((performance.now() - t0) / 1000) + ' ثانية]');

  // أول شمعة في كل سلسلة إشارة فقط -> [index, side]
  const sig = {};
  for (const k of schools) {
    const a = r.series[k] || [];
    const ev = [];
    for (let i = 1; i < a.length; i++) {
      const v = Number(a[i]) || 0, p = Number(a[i - 1]) || 0;
      if (v !== 0 && v !== p) ev.push([i, v > 0 ? 1 : -1]);
    }
    sig[k] = ev;
  }
  const votes = { buy: {}, sell: {} };
  for (const [key, name] of [['buy', 'finalFusionBuyVotes'], ['sell', 'finalFusionSellVotes']]) {
    for (const v of (r.series[name] || [])) {
      const n = Number(v) || 0;
      votes[key][n] = (votes[key][n] || 0) + 1;
    }
  }
  return { bars: r.bars, secs: (performance.now() - t0) / 1000,
           errors: r.diagnostics.length ? r.diagnostics[0].error : null, sig, votes };
}, { csvText: text, schools: SCHOOLS });

if (res.error) { console.log('فشل المحرك:', res.error); await b.close(); process.exit(1); }
console.log('شموع', res.bars, '| ثانية', Math.round(res.secs), '| أخطاء', res.errors);
for (const k of SCHOOLS) console.log('  %s: %d إشارة', k, res.sig[k].length);
fs.writeFileSync(out, JSON.stringify(res));
console.log('اتحفظ في', out);
await b.close();
