"""تحضير نتيجة الهدف/الوقف لكل شمعة، لا للمرشّحة فقط.

المسح السابق ثبّت إعدادات RMI فكانت الشموع المرشّحة معروفة سلفاً. الآن تتغيّر
الإعدادات، فأي شمعة قد تصير دخولاً. يُحسب لكل شمعة، لكل جهة: هل الهدف قبل الوقف،
وبعد كم شمعة أُغلقت — مرة واحدة، ويُخزَّن.

الحجم بعد التخزين ميغابايتات قليلة، فيصير كل مسح لاحق قراءةً لا حساباً.

    python3 allres.py [سنة]
"""
import json
import sys
import time

import numpy as np

PU = 0.10
TP = 130.0
SL = 70.0
HORIZON = 4000
NEVER = np.int32(1 << 30)
YEARS = ('2021', '2023', '2025', '2026')
CH = 3000


def build(year):
    t0 = time.time()
    d = json.load(open(f'probe_{year}.json'))
    n = d['bars']
    h = np.asarray(d['high']); l = np.asarray(d['low']); c = np.asarray(d['close'])
    res = {1: np.full(n, -1, np.int8), -1: np.full(n, -1, np.int8)}
    bars = {1: np.zeros(n, np.int32), -1: np.zeros(n, np.int32)}

    for a0 in range(0, n, CH):
        a1 = min(a0 + CH, n)
        m = a1 - a0
        up = np.empty((m, HORIZON), np.float32)
        dn = np.empty((m, HORIZON), np.float32)
        for a in range(m):
            i = a0 + a; ep = c[i]
            j0, j1 = i + 1, min(i + 1 + HORIZON, n)
            w = j1 - j0
            if w <= 0:
                up[a, :] = -1e9; dn[a, :] = -1e9
                continue
            up[a, :w] = np.maximum.accumulate((h[j0:j1] - ep) / PU)
            dn[a, :w] = np.maximum.accumulate((ep - l[j0:j1]) / PU)
            if w < HORIZON:
                up[a, w:] = up[a, w - 1]; dn[a, w:] = dn[a, w - 1]

        def touch(curve, level):
            return np.where(curve[:, -1] >= level,
                            (curve >= level).argmax(1).astype(np.int32), NEVER)

        for side, (tpc, slc) in ((1, (up, dn)), (-1, (dn, up))):
            t1 = touch(tpc, TP); t2 = touch(slc, SL)
            o = np.full(m, -1, np.int8)
            o[t1 < t2] = 1              # هدف
            o[t2 < t1] = 0              # وقف
            o[(t1 == t2) & (t1 < NEVER)] = -2   # الاثنان في شمعة واحدة = تُلغى
            b = np.minimum(t1, t2); b[b >= NEVER] = HORIZON
            res[side][a0:a1] = o
            bars[side][a0:a1] = b + 1
        del up, dn
        if (a0 // CH) % 10 == 0:
            print(f"  {year}: {a1}/{n}  {time.time()-t0:.0f}s", flush=True)

    days = len(set(np.asarray(d['time']) // 86400000))
    np.savez_compressed(
        f'allres_{year}.npz',
        high=h.astype(np.float32), low=l.astype(np.float32), close=c.astype(np.float64),
        time=np.asarray(d['time'], np.int64),
        res_b=res[1], res_s=res[-1], bars_b=bars[1], bars_s=bars[-1],
        days=np.int32(days), n=np.int32(n))
    print(f"  {year}: كُتب allres_{year}.npz • {n:,} شمعة • {days} يوماً • "
          f"{time.time()-t0:.0f}s", flush=True)


if __name__ == '__main__':
    for y in (sys.argv[1:] or YEARS):
        build(y)
