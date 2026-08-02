"""السؤال الحاسم: هل سطح المُعاملات نمطٌ أم ضجيج؟

عند إعدادٍ واحد، منحنى الزخم يقفز من سالبٍ إلى موجب بتغيير قيمة واحدة. لكن ذلك
شريحة واحدة، وقد تكون هي الضجيج. الاختبار الصحيح: وسيط الأداء لكل قيمة زخم عبر
٣٦٠ إعداداً آخر. إن خرج ناعماً بقمّة واضحة فالأثر حقيقي والقيمة تُعتمد؛ وإن خرج
مشوّكاً مثل الشريحة فالسطح كله ضجيج، ولا يُضبط شيء.
"""
import itertools, json, time
import numpy as np
import tune

tune.GRID['momentum'] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24]
YEARS = tune.YEARS
t0 = time.time()
DATA = {y: tune.load(y) for y in YEARS}
PREP = {y: tune.prep(DATA[y]) for y in YEARS}
print(f"حُضّرت السنوات • {time.time()-t0:.0f}s", flush=True)

keys = ['length', 'momentum', 'zone', 'reaction', 'wait', 'extreme']
combos = list(itertools.product(*(tune.GRID[k] for k in keys)))
print(f"{len(combos)} إعداداً", flush=True)
out = []
for c, vals in enumerate(combos):
    cfg = dict(zip(keys, vals))
    per = {y: tune.simulate(DATA[y], *tune.sig(DATA[y], PREP[y], cfg)) for y in YEARS}
    out.append({'cfg': {k: (list(v) if isinstance(v, tuple) else v) for k, v in cfg.items()},
                'per': {y: (None if per[y] is None else {k: float(v) for k, v in per[y].items()})
                        for y in YEARS}})
    if (c+1) % 500 == 0:
        print(f"  {c+1}/{len(combos)} • {time.time()-t0:.0f}s", flush=True)
json.dump(out, open('tune2_raw.json', 'w'))

for r in out:
    r['all'] = tune.combine(r['per'], YEARS)
pool = [r for r in out if r['all']]
print(f"\n═══ الأثر الحدّي للزخم عبر {len(pool)//len(tune.GRID['momentum'])} إعداداً لكل قيمة ═══")
print(f"{'الزخم':>7}{'عدد':>6}{'وسيط الصافي':>14}{'وسيط /صفقة':>13}{'وسيط σ':>10}"
      f"{'٪ موجب':>9}{'متوسط صفقات':>13}")
for m in tune.GRID['momentum']:
    rs = [r['all'] for r in pool if r['cfg']['momentum'] == m]
    if not rs: continue
    mark = ' ←' if m == 6 else ''
    print(f"{str(m)+mark:>7}{len(rs):>6}{np.median([x['net'] for x in rs]):>+14.0f}"
          f"{np.median([x['per_trade'] for x in rs]):>+13.3f}"
          f"{np.median([x['sigma'] for x in rs]):>+10.2f}"
          f"{100.0*np.mean([x['net'] > 0 for x in rs]):>9.0f}"
          f"{np.mean([x['trades'] for x in rs]):>13.0f}")

print(f"\n═══ نفس المنحنى لكل سنة على حدة (وسيط /صفقة) ═══")
print(f"{'الزخم':>7}" + "".join(f"{y:>11}" for y in YEARS))
for m in tune.GRID['momentum']:
    cells = []
    for y in YEARS:
        v = [r['per'][y]['net']/r['per'][y]['trades'] for r in pool
             if r['cfg']['momentum'] == m and r['per'][y] and r['per'][y]['trades'] >= 50]
        cells.append(np.median(v) if v else float('nan'))
    print(f"{str(m)+(' ←' if m == 6 else ''):>7}" + "".join(f"{v:>+11.3f}" for v in cells))
