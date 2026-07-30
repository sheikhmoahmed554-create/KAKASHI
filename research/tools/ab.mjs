/* اختبار A/B على SYR30 نفسه: يعدّل قيم الـ input الافتراضية ويشغّل المؤشر.
 *
 *   node ab.mjs <config.json> <out.json> [maxBars]
 *
 * ملف الإعداد: {"name":"...", "flags":{"fusionUseBBKC":false, "syr30UseBalance":true}}
 * التعديل يتم على نص Pine مباشرة — input.bool(false,"...") تصير input.bool(true,"...")
 * فلا حاجة لفهم كيف يمرّر المحرك التجاوزات. */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';

const [cfgPath, outPath, maxBarsArg] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const maxBars = maxBarsArg ? Number(maxBarsArg) : 0;

function patchSource(src, flags) {
  let applied = {}, missing = [];
  for (const [name, want] of Object.entries(flags)) {
    // name = input.bool(false, "...")  ->  name = input.bool(true, "...")
    const re = new RegExp('(^\\s*' + name + '\\s*=\\s*input\\.bool\\()\\s*(true|false)\\s*(,)', 'm');
    const m = src.match(re);
    if (!m) { missing.push(name); continue; }
    applied[name] = { from: m[2], to: String(want) };
    src = src.replace(re, '$1' + want + '$3');
  }
  return { src, applied, missing };
}

const b = await chromium.launch({ args: ['--js-flags=--max-old-space-size=8192'] });
const page = await b.newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('console', m => { if (m.text().startsWith('[')) console.log(m.text()); });
await page.goto('file:///home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html');
await page.waitForTimeout(6000);

const original = await page.evaluate(() => document.getElementById('source').value);
const { src, applied, missing } = patchSource(original, cfg.flags || {});
console.log('الإعداد:', cfg.name);
for (const [k, v] of Object.entries(applied)) console.log('   %s: %s -> %s', k, v.from, v.to);
if (missing.length) console.log('   !! لم يُعثر على:', missing.join(', '));

let text = fs.readFileSync('vault.csv', 'utf8');
if (maxBars) text = text.split('\n').slice(0, maxBars + 1).join('\n');

const res = await page.evaluate(async ({ csvText, source }) => {
  const rows = PineLabJS.parseCSV(csvText);
  console.log('[شموع: ' + rows.length + ']');
  const schools = ['finalS06','finalS09','finalS11','finalS12','finalS17',
                   'finalS18','finalS19','finalS22','finalS23'];
  const outs = ['canEnterLong','canEnterShort','entryPrice','tpPrice','slPrice',
                'tradeTargetPts','tradeStopPts','tradeEntrySource', ...schools];
  const t0 = performance.now();
  let r;
  try { r = new PineLabJS.PineEngine(source).run(rows, outs); }
  catch (e) { return { error: e.message }; }

  const entries = [];
  const cl = r.series.canEnterLong || [], cs = r.series.canEnterShort || [];
  const tgt = r.series.tradeTargetPts || [], stp = r.series.tradeStopPts || [];
  for (let i = 1; i < r.bars; i++) {
    const gl = Boolean(cl[i]), gs = Boolean(cs[i]);
    if (gl === gs) continue;                       // لا إشارة أو تعارض
    if (Boolean(cl[i - 1]) === gl && Boolean(cs[i - 1]) === gs) continue;  // أول شمعة فقط
    entries.push([i, gl ? 1 : -1, Number(tgt[i]) || 0, Number(stp[i]) || 0]);
  }
  const counts = {};
  for (const k of schools) {
    const a = r.series[k] || [];
    let c = 0;
    for (let i = 1; i < a.length; i++) {
      const v = Number(a[i]) || 0;
      if (v !== 0 && v !== (Number(a[i - 1]) || 0)) c++;
    }
    counts[k] = c;
  }
  return { bars: r.bars, secs: (performance.now() - t0) / 1000,
           errors: r.diagnostics.length ? r.diagnostics[0].error : null,
           entries, school_counts: counts };
}, { csvText: text, source: src });

if (res.error) { console.log('فشل المحرك:', res.error); await b.close(); process.exit(1); }
console.log('شموع %d | %d ثانية | دخولات %d | أخطاء %s',
            res.bars, Math.round(res.secs), res.entries.length, res.errors);
for (const [k, v] of Object.entries(res.school_counts)) if (v) console.log('   %s: %d', k, v);
fs.writeFileSync(outPath, JSON.stringify({ config: cfg, applied, ...res }));
console.log('اتحفظ في', outPath);
await b.close();
