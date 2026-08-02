"""الزخم = ١٠: هل هو أثر أم صدفة؟ ثم دمجه مع استبعاد الساعات الميتة.

مسح الألف وأربعمئة أسقط كل «أفضل إعداد» خارج العيّنة، لكنه أظهر شيئاً آخر:
قيمة واحدة ترفع الوسيط عبر ٣٦٠ إعداداً مختلفاً — الزخم ١٠. أفضلُ صفٍّ في جدول
قد يكون صدفة؛ وسيطُ ثلاثمئة وستين صفّاً لا يكون.

يُفحص ذلك بأقسى صورة: هل الوسيط الأعلى للزخم ١٠ يتكرّر في كل سنة على حدة؟ أربع
تأكيدات مستقلة أقوى من واحدة على المجموع.
"""
from collections import defaultdict
import json
import numpy as np
import tune
from hours import trades

YEARS = tune.YEARS
DEAD = set(range(0, 7)) | {22, 23}
raw = json.load(open('tune_raw.json'))

print("═══ الأثر الحدّي للزخم — في كل سنة على حدة (وسيط /صفقة) ═══")
print(f"{'الزخم':>8}" + "".join(f"{y:>11}" for y in YEARS) + f"{'المجموع':>11}{'أفضل في':>10}")
best_cnt = defaultdict(int)
tbl = {}
for m in (3, 5, 6, 10):
    row = []
    for y in YEARS:
        v = [r['per'][y]['net']/r['per'][y]['trades'] for r in raw
             if r['cfg']['momentum'] == m and r['per'][y] and r['per'][y]['trades'] >= 50]
        row.append(np.median(v))
    tbl[m] = row
for y_i, y in enumerate(YEARS):
    bm = max(tbl, key=lambda m: tbl[m][y_i]); best_cnt[bm] += 1
for m in (3, 5, 6, 10):
    all_v = [r['per'][y]['net'] for r in raw if r['cfg']['momentum'] == m
             for y in YEARS if r['per'][y]]
    mark = ' ←' if m == 6 else ''
    print(f"{str(m)+mark:>8}" + "".join(f"{v:>+11.3f}" for v in tbl[m])
          + f"{np.median(tbl[m]):>+11.3f}{best_cnt[m]:>10}")

print("\n═══ تغيير واحد فقط: الزخم ٦ → ١٠، وكل شيء آخر افتراضي ═══")
CFGS = [('الافتراضي  L18/M6', dict(length=18, momentum=6, zone=(20.,80.), reaction=2, wait=12, extreme=40)),
        ('الزخم ١٠   L18/M10', dict(length=18, momentum=10, zone=(20.,80.), reaction=2, wait=12, extreme=40))]
T = {}
for lab, cfg in CFGS:
    T[lab] = {}
    for y in YEARS:
        D = tune.load(y); P = tune.prep(D)
        T[lab][y] = trades(D, *tune.sig(D, P, cfg))

def agg(rows_by_year, dead=False):
    sel = [(r, y) for y in YEARS for r in rows_by_year[y] if not (dead and r[0] in DEAD)]
    n = len(sel); w = sum(r[2] for r,_ in sel); net = sum(r[3] for r,_ in sel)
    lift = sum(100.0*r[2] - tune.RND[y][0 if r[1]==1 else 1] for r,y in sel)/n
    se = 100.0*np.sqrt(0.35*0.65/n)
    pos = sum(1 for y in YEARS
              if sum(r[3] for r in rows_by_year[y] if not (dead and r[0] in DEAD)) > 0)
    return n, 100.0*w/n, net, net/n, lift, lift/se, pos

print(f"{'التركيبة':>26}{'صفقات':>8}{'/يوم':>7}{'فوز%':>8}{'صافي':>9}{'/صفقة':>9}"
      f"{'زيادة':>8}{'σ':>7}{'موجبة':>7}")
DAYS = sum(tune.load(y)['days'] for y in YEARS)
rows = []
for lab, _ in CFGS:
    for dh, dlab in ((False, ''), (True, ' + استبعاد الميتة')):
        a = agg(T[lab], dh)
        rows.append((lab+dlab, a))
        print(f"{lab+dlab:>26}{a[0]:>8}{a[0]/DAYS:>7.1f}{a[1]:>8.2f}{a[2]:>+9.0f}"
              f"{a[3]:>+9.3f}{a[4]:>+8.2f}{a[5]:>+7.2f}{a[6]:>7}")

print(f"\n═══ كل سنة على حدة ═══")
print(f"{'التركيبة':>26}" + "".join(f"{y:>13}" for y in YEARS))
for lab, _ in CFGS:
    for dh, dlab in ((False, ''), (True, ' + استبعاد الميتة')):
        cells = []
        for y in YEARS:
            rr = [r for r in T[lab][y] if not (dh and r[0] in DEAD)]
            cells.append(f"{sum(r[3] for r in rr):+.0f} ({len(rr)})")
        print(f"{lab+dlab:>26}" + "".join(f"{c:>13}" for c in cells))
