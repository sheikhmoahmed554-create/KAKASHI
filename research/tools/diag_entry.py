"""تشخيص: أي فرضية عن سعر الدخول وقاعدة التصادم تُعيد نتائج المؤشر الفعلية؟

لا تُقبل أي نتيجة مسح قبل أن تتطابق المحاكاة مع صفقات المؤشر صفقةً بصفقة.
"""
import csv
import gzip
import json
from collections import Counter

import numpy as np

PU = 0.1
TRADES = 'research/results/ab/A_baseline_trades.json.gz'
VAULT = 'research/data/builtin2026.csv'   # الداتا التي شغّل عليها المحرك فعلاً


def load_bars(prefix='2026'):
    t, o, h, l, c = [], [], [], [], []
    with open(VAULT) as f:
        for r in csv.DictReader(f):
            if not r['time'].startswith(prefix):
                continue
            t.append(r['time'][:19]); o.append(float(r['open']))
            h.append(float(r['high'])); l.append(float(r['low'])); c.append(float(r['close']))
    return t, np.array(o), np.array(h), np.array(l), np.array(c)


def run(idx, side, tp, sl, o, h, l, c, n, entry, start_off, collide, maxbars):
    """entry: 'close' | 'nextopen'   collide: 'sl' | 'tp' | 'skip'"""
    out = np.full(len(idx), -2, np.int8)          # -2 = تُخطّى
    for k in range(len(idx)):
        i = idx[k]
        ep = c[i] if entry == 'close' else (o[i + 1] if i + 1 < n else c[i])
        j0 = i + start_off
        end = min(j0 + maxbars, n)
        tpd, sld = tp[k] * PU, sl[k] * PU
        if side[k] == 1:
            tpx, slx = ep + tpd, ep - sld
        else:
            tpx, slx = ep - tpd, ep + sld
        res = -1
        for j in range(j0, end):
            if side[k] == 1:
                hit_tp, hit_sl = h[j] >= tpx, l[j] <= slx
            else:
                hit_tp, hit_sl = l[j] <= tpx, h[j] >= slx
            if hit_tp and hit_sl:
                if collide == 'sl':
                    res = 0
                elif collide == 'tp':
                    res = 1
                else:
                    res = -2
                break
            if hit_sl:
                res = 0; break
            if hit_tp:
                res = 1; break
        out[k] = res
    return out


def main():
    raw = json.load(gzip.open(TRADES, 'rt'))
    t, o, h, l, c = load_bars('2026')
    n = len(c)
    pos = {ts: i for i, ts in enumerate(t)}

    idx, side, tp, sl, win = [], [], [], [], []
    for tr in raw:
        i = pos.get(tr[0].replace('T', ' ')[:19])
        if i is None or i + 2 >= n:
            continue
        idx.append(i); side.append(1 if tr[1] == 'BUY' else -1)
        tp.append(float(tr[4])); sl.append(float(tr[5]))
        win.append(1 if tr[2] == 'WIN' else 0)
    idx = np.array(idx); side = np.array(side)
    tp = np.array(tp); sl = np.array(sl); win = np.array(win)

    # عيّنة سريعة للفرز، ثم تأكيد على الكل
    smp = np.arange(0, len(idx), max(1, len(idx) // 1500))
    print(f"صفقات: {len(idx):,} • عيّنة التشخيص: {len(smp):,}\n")
    print(f"{'دخول':>9}{'بداية':>7}{'تصادم':>7}{'أفق':>6}{'تطابق%':>9}{'فوز% محاكاة':>13}"
          f"{'فوز% المؤشر':>13}{'محسوم':>8}")

    best = None
    for entry in ('close', 'nextopen'):
        for start_off in (0, 1):
            for collide in ('sl', 'tp', 'skip'):
                for maxbars in (240, 480, 1440):
                    out = run(idx[smp], side[smp], tp[smp], sl[smp], o, h, l, c, n,
                              entry, start_off, collide, maxbars)
                    d = out >= 0
                    if d.sum() == 0:
                        continue
                    agree = 100.0 * (out[d] == win[smp][d]).mean()
                    wr = 100.0 * out[d].mean()
                    ref = 100.0 * win[smp][d].mean()
                    print(f"{entry:>9}{start_off:>7}{collide:>7}{maxbars:>6}"
                          f"{agree:>9.2f}{wr:>13.2f}{ref:>13.2f}{d.sum():>8}")
                    if best is None or agree > best[0]:
                        best = (agree, entry, start_off, collide, maxbars)

    print(f"\nأفضل فرضية: {best[1]} / بداية +{best[2]} / تصادم={best[3]} / أفق={best[4]}"
          f"  →  تطابق {best[0]:.2f}%")

    _, entry, start_off, collide, maxbars = best
    out = run(idx, side, tp, sl, o, h, l, c, n, entry, start_off, collide, maxbars)
    d = out >= 0
    print(f"\nعلى كل الصفقات: تطابق {100*(out[d]==win[d]).mean():.2f}% • "
          f"محاكاة {100*out[d].mean():.2f}% • مؤشر {100*win[d].mean():.2f}% • محسوم {d.sum():,}")

    mism = np.flatnonzero(d & (out != win))
    print(f"\nعدد الاختلافات: {len(mism):,}")
    if len(mism):
        print("عيّنة من الاختلافات (المؤشر مقابل المحاكاة):")
        for k in mism[:8]:
            i = idx[k]
            print(f"  {t[i]}  {'BUY' if side[k]==1 else 'SELL'}  TP{tp[k]:.0f}/SL{sl[k]:.0f}  "
                  f"مؤشر={'WIN' if win[k] else 'LOSS'}  محاكاة={'WIN' if out[k] else 'LOSS'}  "
                  f"close={c[i]:.2f} nextopen={o[i+1]:.2f}")


if __name__ == '__main__':
    main()
