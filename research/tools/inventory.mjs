/* جرد شامل: يستخرج كل متغيرات الإشارة في SYR30 ويقيس كل واحدة وحدها.
 *
 *   node inventory.mjs <names.txt> <out.json> [maxBars]
 *
 * يُرجع لكل متغير أرقام الشموع التي يُطلق فيها (أول شمعة في كل سلسلة فقط)،
 * بصيغة مضغوطة حتى لا تسقط الصفحة كما حدث مع النسخة الأولى من schools.mjs. */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';

const [namesPath, outPath, maxBarsArg] = process.argv.slice(2);
const maxBars = maxBarsArg ? Number(maxBarsArg) : 0;
const NAMES = fs.readFileSync(namesPath, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
console.log('متغيرات مطلوبة:', NAMES.length);

const b = await chromium.launch({ args: ['--js-flags=--max-old-space-size=8192'] });
const page = await b.newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('crash', () => console.log('!! الصفحة وقعت'));
page.on('console', m => { if (m.text().startsWith('[')) console.log(m.text()); });
await page.goto('file:///home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html');
await page.waitForTimeout(6000);

let text = fs.readFileSync('vault.csv', 'utf8');
if (maxBars) text = text.split('\n').slice(0, maxBars + 1).join('\n');

const res = await page.evaluate(async ({ csvText, names }) => {
  const rows = PineLabJS.parseCSV(csvText);
  console.log('[شموع: ' + rows.length + ']');
  const t0 = performance.now();
  let r;
  try { r = new PineLabJS.PineEngine(document.getElementById('source').value).run(rows, names); }
  catch (e) { return { error: e.message }; }
  console.log('[تشغيل: ' + Math.round((performance.now() - t0) / 1000) + ' ث]');

  // أول شمعة في كل سلسلة تفعيل فقط — يمنع عدّ نفس الإعداد عشرات المرات
  const fires = {};
  for (const k of names) {
    const a = r.series[k];
    if (!a) { fires[k] = null; continue; }        // غير موجود في السلاسل
    const ev = [];
    let prev = false;
    for (let i = 1; i < a.length; i++) {
      const v = a[i] === true || (typeof a[i] === 'number' && a[i] > 0);
      if (v && !prev) ev.push(i);
      prev = v;
    }
    fires[k] = ev;
  }
  return { bars: r.bars, secs: (performance.now() - t0) / 1000,
           errors: r.diagnostics.length ? r.diagnostics[0].error : null, fires };
}, { csvText: text, names: NAMES });

if (res.error) { console.log('فشل المحرك:', res.error); await b.close(); process.exit(1); }
const live = Object.entries(res.fires).filter(([, v]) => v && v.length);
const dead = Object.entries(res.fires).filter(([, v]) => v && !v.length);
const missing = Object.entries(res.fires).filter(([, v]) => v === null);
console.log('شموع %d | %d ث | أخطاء %s', res.bars, Math.round(res.secs), res.errors);
console.log('  تُطلق إشارات : %d', live.length);
console.log('  صامتة تماماً : %d', dead.length);
console.log('  غير موجودة   : %d', missing.length);
fs.writeFileSync(outPath, JSON.stringify(res));
console.log('اتحفظ في', outPath);
await b.close();
