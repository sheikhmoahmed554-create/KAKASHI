"""الحكم الأخير على محور الزخم وحده.

المسح العريض أسقط اختيار «أفضل إعداد» من ١٤٤٠ ومن ٥٠٤٠. لكن الاختيار على محور
واحد من أربع عشرة قيمة مسألة أخرى: احتمال الصدفة أصغر بمراتب. فإن سقط هذا أيضاً
فالمحور كله ضجيج، وإن صمد فهو أول ضبط مثبت.

ويُقاس معه شيئان: صلابة الجوار — كم من الإعدادات المحيطة تبقى موجبة عند كل قيمة،
فالقيمة التي تنجح وحدها بين جيران خاسرين شوكةٌ لا قمّة — واتفاق السنوات.
"""
import json
import numpy as np
import tune
from hours import trades

YEARS = tune.YEARS
DEAD = set(range(0, 7)) | {22, 23}
MOMS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24]

tune.GRID['momentum'] = MOMS
D = {y: tune.load(y) for y in YEARS}
P = {y: tune.prep(D[y]) for y in YEARS}
T = {}
for m in MOMS:
    cfg = dict(length=18, momentum=m, zone=(20., 80.), reaction=2, wait=12, extreme=40)
    T[m] = {y: trades(D[y], *tune.sig(D[y], P[y], cfg)) for y in YEARS}

def st(m, years, dead):
    sel = [(r, y) for y in years for r in T[m][y] if not (dead and r[0] in DEAD)]
    n = len(sel)
    if n < 80: return None
    w = sum(r[2] for r, _ in sel); net = sum(r[3] for r, _ in sel)
    lift = sum(100.0*r[2] - tune.RND[y][0 if r[1] == 1 else 1] for r, y in sel)/n
    return {'n': n, 'net': net, 'pt': net/n, 'lift': lift,
            'sigma': lift/(100.0*np.sqrt(0.35*0.65/n))}

raw = json.load(open('tune2_raw.json'))
print("═══ صلابة الجوار: نسبة الإعدادات الموجبة حول كل قيمة زخم ═══")
print(f"{'الزخم':>7}{'موجب٪ (٣٦٠ إعداد)':>22}{'صافي عند الافتراضي':>22}"
      f"{'الجارتان':>22}")
for i, m in enumerate(MOMS):
    rs = [r for r in raw if r['cfg']['momentum'] == m]
    a = [tune.combine(r['per'], YEARS) for r in rs]
    a = [x for x in a if x]
    pct = 100.0*np.mean([x['net'] > 0 for x in a])
    nb = [st(MOMS[j], YEARS, False)['net'] for j in (i-1, i+1) if 0 <= j < len(MOMS)]
    print(f"{str(m)+(' ←' if m == 6 else ''):>7}{pct:>22.0f}"
          f"{st(m, YEARS, False)['net']:>+22.0f}"
          f"{'  '.join(f'{v:+.0f}' for v in nb):>22}")

for dead in (False, True):
    lab = 'بعد استبعاد الساعات الميتة' if dead else 'كل الساعات'
    print(f"\n═══ ترك سنة خارج الاختيار على محور الزخم — {lab} ═══")
    print(f"{'المتروكة':>10}{'المختار':>9}{'تدريب/صفقة':>13}{'اختبار/صفقة':>13}"
          f"{'صافي':>9}{'زخم ٦':>9}{'الفرق':>9}")
    tp = tb = 0.0; picks = []
    for held in YEARS:
        tr = [y for y in YEARS if y != held]
        best, bv = None, None
        for m in MOMS:
            a = st(m, tr, dead)
            if a and (bv is None or a['pt'] > bv['pt']):
                best, bv = m, a
        t = st(best, [held], dead); b = st(6, [held], dead)
        tp += t['net']; tb += b['net']; picks.append(best)
        print(f"{held:>10}{best:>9}{bv['pt']:>13.2f}{t['pt']:>13.2f}"
              f"{t['net']:>+9.0f}{b['net']:>+9.0f}{t['net']-b['net']:>+9.0f}")
    print(f"  المجموع: المختار {tp:+,.0f} • زخم ٦ {tb:+,.0f} • الفرق {tp-tb:+,.0f}"
          f"  {'✓ نجح' if tp > tb else '✗ فشل'} • "
          f"{'ثابت' if len(set(picks)) == 1 else 'غير ثابت'} ({picks})")
