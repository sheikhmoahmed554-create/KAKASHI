"""قاعدة واحدة ثابتة بدل الاختيار: استبعاد ساعات الذهب الميتة.

اختيار أفضل نافذة من خمس فشل خارج العيّنة، وهذا متوقَّع — الاختيار نفسه هو
المشكلة. أما هذه فقاعدة واحدة مُعلَنة سلفاً بسبب واقعي (ساعات ما قبل لندن وما
بعد نيويورك: سيولة رقيقة)، ولا يُنتقى فيها شيء. فاختبارها اختبار واحد لا خمسة،
ونتيجته تُقرأ كما هي في كل سنة على حدة.
"""
import numpy as np
import tune
from hours import trades

DEF = dict(length=18, momentum=6, zone=(20.0, 80.0), reaction=2, wait=12, extreme=40)
DEAD = set(range(0, 7)) | {22, 23}

T = {}
for y in tune.YEARS:
    D = tune.load(y); P = tune.prep(D)
    T[y] = trades(D, *tune.sig(D, P, DEF))

def st(rows, y):
    n = len(rows)
    if n == 0: return None
    w = sum(r[2] for r in rows); net = sum(r[3] for r in rows)
    lift = sum(100.0*r[2] - tune.RND[y][0 if r[1]==1 else 1] for r in rows)/n
    return n, 100.0*w/n, net, net/n, lift

print("═══ قاعدة ثابتة: تجاهُل الساعات 00-06 و22-23 (UTC) ═══")
print(f"{'سنة':>8}{'كل الساعات':>28}{'بعد الاستبعاد':>30}{'الفرق':>10}")
print(f"{'':>8}{'ن':>8}{'فوز%':>8}{'صافي':>12}{'ن':>8}{'فوز%':>8}{'صافي':>8}{'/صفقة':>8}{'زيادة':>8}")
ta = tb = 0.0; pa = pb = 0
for y in tune.YEARS:
    a = st(T[y], y)
    b = st([r for r in T[y] if r[0] not in DEAD], y)
    ta += a[2]; tb += b[2]; pa += a[2] > 0; pb += b[2] > 0
    print(f"{y:>8}{a[0]:>8}{a[1]:>8.2f}{a[2]:>+12.0f}{b[0]:>8}{b[1]:>8.2f}"
          f"{b[2]:>+8.0f}{b[3]:>+8.2f}{b[4]:>+8.2f}{b[2]-a[2]:>+10.0f}")
A = st([r for y in tune.YEARS for r in T[y]], '2021')
allrows = [(r, y) for y in tune.YEARS for r in T[y]]
def agg(sel):
    n = len(sel); w = sum(r[2] for r,_ in sel); net = sum(r[3] for r,_ in sel)
    lift = sum(100.0*r[2] - tune.RND[y][0 if r[1]==1 else 1] for r,y in sel)/n
    se = 100.0*np.sqrt(0.35*0.65/n)
    return n, 100.0*w/n, net, net/n, lift, lift/se
for lab, sel in (('كل الساعات', allrows),
                 ('بعد الاستبعاد', [(r,y) for r,y in allrows if r[0] not in DEAD])):
    n, wr, net, pt, lift, sg = agg(sel)
    print(f"\n  {lab}: {n:,} صفقة • فوز {wr:.2f}% • صافي {net:+,.0f} • "
          f"{pt:+.3f}/صفقة • زيادة {lift:+.2f} ({sg:+.2f}σ)")
print(f"\n  سنوات موجبة: كل الساعات {pa}/4 • بعد الاستبعاد {pb}/4")
