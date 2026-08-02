"""هل الزخم ١٠ قمّة أم حافة شبكة؟

القيمة الفائزة كانت آخر قيمة في الشبكة، وهذا وحده مريب: قد يكون الأفضل خارجها.
يُمدّ المحور من ٣ إلى ٢٤ مع تثبيت كل شيء آخر. القمّة الوسطى تعني أمثلية حقيقية؛
والصعود المستمر حتى الطرف يعني أن الشبكة هي التي كانت قصيرة.
"""
import numpy as np
import tune
from hours import trades

YEARS = tune.YEARS
DEAD = set(range(0, 7)) | {22, 23}
MOMS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24]

D = {}; P = {}
for y in YEARS:
    D[y] = tune.load(y)
    D[y]['C'] = D[y]['C']
for y in YEARS:
    n = D[y]['n']; C = D[y]['C']
    pr = {}
    for m in MOMS:
        d = np.zeros(n); d[m:] = C[m:] - C[:-m]
        up = tune.rmi_py.ema(np.maximum(d, 0.0), 18)
        dn = tune.rmi_py.ema(np.maximum(-d, 0.0), 18)
        with np.errstate(divide='ignore', invalid='ignore'):
            r = np.where(dn == 0.0, np.where(up == 0.0, 50.0, 100.0),
                         100.0 - 100.0/(1.0 + up/dn))
        r[np.isnan(up)] = np.nan
        pr[(18, m)] = r
    pl = np.r_[np.nan, tune.rmi_py.rolling_min(D[y]['L'], 40)[:-1]]
    ph = np.r_[np.nan, tune.rmi_py.rolling_max(D[y]['H'], 40)[:-1]]
    eb = D[y]['L'] <= pl; eb[np.isnan(pl)] = False
    es = D[y]['H'] >= ph; es[np.isnan(ph)] = False
    P[y] = {'rmi': pr, 'ex': {40: (eb, es)},
            'pUp': np.r_[False, C[1:] > C[:-1]], 'pDn': np.r_[False, C[1:] < C[:-1]]}

DAYS = sum(D[y]['days'] for y in YEARS)
print("═══ منحنى الزخم — الطول ١٨، ومناطق ٢٠/٨٠، وشمعتا تفاعل، وانتظار ١٢، وقمة/قاع ٤٠ ═══")
print(f"{'الزخم':>7}{'صفقات':>8}{'/يوم':>6}{'فوز%':>8}{'صافي':>8}{'/صفقة':>8}{'σ':>7}{'موجبة':>7}"
      f"{'│':>3}{'بعد استبعاد الميتة':>0}")
print(f"{'':>7}{'':>8}{'':>6}{'':>8}{'':>8}{'':>8}{'':>7}{'':>7}{'│':>3}"
      f"{'صفقات':>8}{'/يوم':>6}{'فوز%':>8}{'صافي':>8}{'/صفقة':>8}{'σ':>7}{'موجبة':>7}")
for m in MOMS:
    cfg = dict(length=18, momentum=m, zone=(20., 80.), reaction=2, wait=12, extreme=40)
    T = {y: trades(D[y], *tune.sig(D[y], P[y], cfg)) for y in YEARS}
    out = [f"{str(m)+(' ←' if m == 6 else ''):>7}"]
    for dead in (False, True):
        sel = [(r, y) for y in YEARS for r in T[y] if not (dead and r[0] in DEAD)]
        n = len(sel)
        if n == 0:
            out.append(f"{'—':>52}"); continue
        w = sum(r[2] for r, _ in sel); net = sum(r[3] for r, _ in sel)
        lift = sum(100.0*r[2] - tune.RND[y][0 if r[1] == 1 else 1] for r, y in sel)/n
        sg = lift / (100.0*np.sqrt(0.35*0.65/n))
        pos = sum(1 for y in YEARS
                  if sum(r[3] for r in T[y] if not (dead and r[0] in DEAD)) > 0)
        out.append(f"{n:>8}{n/DAYS:>6.1f}{100.0*w/n:>8.2f}{net:>+8.0f}"
                   f"{net/n:>+8.2f}{sg:>+7.2f}{pos:>7}")
        if not dead:
            out.append(f"{'│':>3}")
    print("".join(out), flush=True)
