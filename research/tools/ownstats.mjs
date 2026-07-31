/* يقرأ محاسبة المؤشر نفسها (trades/wins/losses/netPts) بدل إعادة محاكاتها.
 * الفرق الجوهري: المؤشر لا يملك وقفاً زمنياً — يبقى ماسكاً حتى الهدف أو الوقف.
 *
 *   node ownstats.mjs <config.json> <out.json> [maxBars]
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';

const [cfgPath, outPath, maxBarsArg] = process.argv.slice(2);
const cfg = cfgPath && cfgPath !== '-' ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : { name: 'الأصل كما هو' };
const maxBars = maxBarsArg ? Number(maxBarsArg) : 0;

function patchSource(src, flags) {
  const applied = {}, missing = [];
  for (const [name, want] of Object.entries(flags || {})) {
    const re = new RegExp('(^\\s*' + name + '\\s*=\\s*input\\.(?:bool|string|int|float)\\()\\s*' +
                          '(true|false|"[^"]*"|-?[0-9.]+)\\s*(,)', 'm');
    const m = src.match(re);
    if (!m) { missing.push(name); continue; }
    const lit = typeof want === 'string' ? JSON.stringify(want) : String(want);
    applied[name] = { from: m[2], to: lit };
    src = src.replace(re, '$1' + lit + '$3');
  }
  return { src, applied, missing };
}

function applyRewrites(src, rewrites) {
  const done = [], failed = [];
  for (const [find, repl] of rewrites || []) {
    if (!src.includes(find)) { failed.push(find); continue; }
    src = src.replace(find, repl); done.push(find + '  ⟶  ' + repl);
  }
  return { src, done, failed };
}

const b = await chromium.launch({ args: ['--js-flags=--max-old-space-size=8192'] });
const page = await b.newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('console', m => { if (m.text().startsWith('[')) console.log(m.text()); });
await page.goto('file:///home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html');
await page.waitForTimeout(6000);

const original = await page.evaluate(() => document.getElementById('source').value);
let { src, applied, missing } = patchSource(original, cfg.flags);
const rw = applyRewrites(src, cfg.rewrites);
src = rw.src;
console.log('الإعداد:', cfg.name);
for (const [k, v] of Object.entries(applied)) console.log('   %s: %s -> %s', k, v.from, v.to);
for (const l of rw.done) console.log('   إعادة كتابة: %s', l);
if (missing.length) console.log('   !! مفاتيح غير موجودة:', missing.join(', '));
if (rw.failed.length) { console.log('   !! فشلت إعادة الكتابة:', rw.failed.join(' | ')); process.exit(2); }

const DATA = process.env.DATA || 'vault.csv';
let text = fs.readFileSync(DATA, 'utf8');
if (maxBars > 0) text = text.split('\n').slice(0, maxBars + 1).join('\n');
else if (maxBars < 0) { const L = text.split('\n').filter(Boolean); text = [L[0], ...L.slice(maxBars)].join('\n'); }

const res = await page.evaluate(async ({ csvText, source }) => {
  const rows = PineLabJS.parseCSV(csvText);
  console.log('[شموع: ' + rows.length + ']');
  const outs = ['trades', 'wins', 'losses', 'netPts', 'sumWinPts', 'sumLossPts',
                'active', 'side', 'entryPrice', 'tpPrice', 'slPrice',
                'tradeTargetPts', 'tradeStopPts', 'entryBar', 'tradeEntrySourceCode',
                'canEnterLong', 'canEnterShort'];
  const t0 = performance.now();
  let r;
  try { r = new PineLabJS.PineEngine(source).run(rows, outs); }
  catch (e) { return { error: e.message }; }
  const S = r.series, n = r.bars;
  const g = k => S[k] || [];
  const tr = g('trades'), wi = g('wins'), lo = g('losses'), np = g('netPts');
  // سجل الصفقات من تغيّر العدّادات
  const log = [];
  const act = g('active'), sd = g('side'), tg = g('tradeTargetPts'), st = g('tradeStopPts'),
        eb = g('entryBar'), sc = g('tradeEntrySourceCode');
  for (let i = 1; i < n; i++) {
    const dw = (Number(wi[i]) || 0) - (Number(wi[i - 1]) || 0);
    const dl = (Number(lo[i]) || 0) - (Number(lo[i - 1]) || 0);
    if (dw <= 0 && dl <= 0) continue;
    log.push([Number(eb[i - 1]) || 0, i, Number(sd[i - 1]) || 0, dw > 0 ? 1 : 0,
              Number(tg[i - 1]) || 0, Number(st[i - 1]) || 0, Number(sc[i - 1]) || 0]);
  }
  const last = k => { const a = g(k); for (let i = n - 1; i >= 0; i--) if (a[i] != null && !Number.isNaN(Number(a[i]))) return Number(a[i]); return 0; };
  return { bars: n, secs: (performance.now() - t0) / 1000,
           errors: r.diagnostics.length ? r.diagnostics[0].error : null,
           final: { trades: last('trades'), wins: last('wins'), losses: last('losses'),
                    netPts: last('netPts'), sumWin: last('sumWinPts'), sumLoss: last('sumLossPts') },
           log };
}, { csvText: text, source: src });

if (res.error) { console.log('فشل المحرك:', res.error); await b.close(); process.exit(1); }
const f = res.final;
const wr = f.trades ? 100 * f.wins / f.trades : 0;
console.log('شموع %d | %d ث | أخطاء %s', res.bars, Math.round(res.secs), res.errors);
console.log('  محاسبة المؤشر نفسه:');
console.log('    صفقات ' + f.trades + ' | ربح ' + f.wins + ' | خسارة ' + f.losses +
            ' | نسبة ' + wr.toFixed(2) + '% | صافي ' + f.netPts.toFixed(0) + ' نقطة');
if (f.wins) console.log('    متوسط الهدف ' + (f.sumWin / f.wins).toFixed(2) +
                        ' | متوسط الوقف ' + (f.losses ? f.sumLoss / f.losses : 0).toFixed(2));
console.log('  صفقات مسجّلة من السلاسل: %d', res.log.length);
fs.writeFileSync(outPath, JSON.stringify({ config: cfg, applied, ...res }));
console.log('اتحفظ في', outPath);
await b.close();
