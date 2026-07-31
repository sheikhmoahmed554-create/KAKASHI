"""الحركات الهاربة: ما الذي يسبق حركة ٦٠ نقطة السريعة النظيفة؟

    PYTHONPATH=research/tools python3 research/tools/escape.py

نبحث عكسياً: بدل أن نسأل «هل هذا الشرط نافع؟» نأخذ الحركات التي أعطت الهدف
فعلاً ونسأل «ما الذي كان مختلفاً قبلها؟».

الحركة الهاربة = من إغلاق شمعة، يصل السعر إلى +٦٠ نقطة خلال مدة قصيرة،
**دون أن يتراجع ٢٠ نقطة ضدنا أولاً**. أي حركة نظيفة لا تحتاج صبراً ولا تحمّل
تراجع — وهي ما يبحث عنه صاحب المشروع.

القياس على السوق الحالي فقط: النصف الثاني من ٢٠٢٥ و٢٠٢٦.
"""
import csv
import gzip
import json

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

PU = 0.1
TARGET = 60.0        # نقاط
ADVERSE = 20.0       # أقصى تراجع مسموح قبل الوصول
HORIZONS = (15, 30, 60, 120)


def load():
    t, o, h, l, c, v = [], [], [], [], [], []
    with gzip.open('research/data/vault_utc.csv.gz', 'rt') as f:
        for r in csv.DictReader(f):
            d = r['time'][:10]
            if not ('2025-07-01' <= d < '2026-07-18'):
                continue
            t.append(r['time'])
            o.append(float(r['open'])); h.append(float(r['high']))
            l.append(float(r['low'])); c.append(float(r['close'])); v.append(float(r['volume']))
    return t, *(np.array(x) for x in (o, h, l, c, v))


def escapes(h, l, c, horizon, side=1):
    """لكل شمعة: هل تبدأ منها حركة هاربة خلال المدة، بلا تراجع يتجاوز الحد."""
    n = len(c)
    hit = np.zeros(n, bool)
    tgt = c + side * TARGET * PU
    adv = c - side * ADVERSE * PU
    alive = np.ones(n, bool)
    ar = np.arange(n)
    for k in range(1, horizon + 1):
        j = ar + k
        ok = (j < n) & alive & ~hit
        jj = np.where(j < n, j, n - 1)
        if side == 1:
            broke = ok & (l[jj] <= adv)
            reach = ok & (h[jj] >= tgt) & ~broke
        else:
            broke = ok & (h[jj] >= adv)
            reach = ok & (l[jj] <= tgt) & ~broke
        alive[broke] = False
        hit[reach] = True
    return hit


def main():
    t, o, h, l, c, v = load()
    n = len(c)
    pc = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))
    atr = np.empty(n); atr[0] = tr[0]
    for i in range(1, n):
        atr[i] = tr[i] / 14. + atr[i - 1] * 13 / 14.
    atr /= PU
    A = np.maximum(atr, 1e-9)
    days = len({x[:10] for x in t})
    print(f'{n} شمعة • {days} يوم تداول • ATR وسيط {np.median(atr):.0f} نقطة\n')

    print(f'### كم مرة تحدث حركة {TARGET:.0f} نقطة نظيفة (تراجع أقل من {ADVERSE:.0f})\n')
    print(f"{'المدة':<12}{'صعوداً':>12}{'هبوطاً':>12}{'مجموع/يوم':>14}")
    best = {}
    for hz in HORIZONS:
        up = escapes(h, l, c, hz, 1)
        dn = escapes(h, l, c, hz, -1)
        best[hz] = (up, dn)
        print(f"{hz:<12}{up.sum():>12}{dn.sum():>12}{(up.sum() + dn.sum()) / days:>14.1f}")

    # نأخذ مدة ٦٠ دقيقة كتعريف عملي ونحلّل ما يسبقها
    up, dn = best[60]
    warm = np.arange(n) > 300
    rng = np.maximum(h - l, 1e-9)
    hi60 = np.full(n, np.nan); lo60 = np.full(n, np.nan)
    hi60[59:] = sliding_window_view(h, 60).max(1)
    lo60[59:] = sliding_window_view(l, 60).min(1)
    plo, phi = np.concatenate([[np.nan], lo60[:-1]]), np.concatenate([[np.nan], hi60[:-1]])
    long_atr = np.convolve(atr, np.ones(240) / 240, mode='full')[:n]
    back = np.concatenate([np.full(120, np.nan), c[:-120]])

    F = {
        'ATR بالنقاط': atr,
        'نظام التذبذب': atr / np.maximum(long_atr, 1e-9),
        'الموضع في نطاق 60٪': 100 * (c - lo60) / np.maximum(hi60 - lo60, 1e-9),
        'انحدار 120 × ATR': ((c - back) / PU) / A,
        'مدى الشمعة × ATR': (rng / PU) / A,
        'موضع الإغلاق٪': 100 * (c - l) / rng,
        'عمق السحب تحت × ATR': np.where(l < plo, ((plo - l) / PU) / A, 0.0),
        'عمق السحب فوق × ATR': np.where(h > phi, ((h - phi) / PU) / A, 0.0),
        'نسبة الحجم': v / np.maximum(np.convolve(v, np.ones(60) / 60, mode='full')[:n], 1e-9),
    }
    print(f'\n### ما الذي يسبق الحركة الهاربة (مدة ٦٠ دقيقة)\n')
    print(f"{'الخاصية':<24}{'قبل هروب صاعد':>18}{'قبل هروب هابط':>18}{'الوسط العام':>16}")
    rep = {}
    for name, x in F.items():
        fin = warm & np.isfinite(x)
        mu = float(np.median(x[fin]))
        a_ = float(np.median(x[fin & up])) if (fin & up).sum() > 50 else float('nan')
        b_ = float(np.median(x[fin & dn])) if (fin & dn).sum() > 50 else float('nan')
        rep[name] = {'up': round(a_, 3), 'down': round(b_, 3), 'all': round(mu, 3)}
        print(f"{name:<24}{a_:>18.2f}{b_:>18.2f}{mu:>16.2f}")

    print(f'\n### احتمال الهروب حسب الحالة\n')
    base_up = 100.0 * up[warm].mean()
    base_dn = 100.0 * dn[warm].mean()
    print(f'الأساس: صعوداً {base_up:.2f}٪ من الشموع • هبوطاً {base_dn:.2f}٪\n')
    print(f"{'الشريحة':<34}{'شموع':>8}{'هروب صعوداً':>14}{'هروب هبوطاً':>14}")
    cells = {}
    for name, x in F.items():
        fin = warm & np.isfinite(x)
        qs = np.nanpercentile(x[fin], [0, 25, 50, 75, 90, 100])
        for a_, b_ in zip(qs[:-1], qs[1:]):
            m = fin & (x >= a_) & (x < b_)
            if m.sum() < 2000:
                continue
            pu_ = 100.0 * up[m].mean()
            pd_ = 100.0 * dn[m].mean()
            if max(pu_ / max(base_up, 1e-9), pd_ / max(base_dn, 1e-9)) < 1.35:
                continue
            key = f'{name} [{a_:.2f}→{b_:.2f}]'
            cells[key] = {'n': int(m.sum()), 'up': round(pu_, 2), 'down': round(pd_, 2)}
            print(f"{key[:33]:<34}{m.sum():>8}{pu_:>13.2f}٪{pd_:>13.2f}٪")
    json.dump({'baseline': {'up': round(base_up, 2), 'down': round(base_dn, 2)},
               'medians': rep, 'cells': cells},
              open('research/results/escape.json', 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
