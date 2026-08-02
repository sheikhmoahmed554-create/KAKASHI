"""هل تتركّز الحافة في ساعات معيّنة؟ وهل تختلف بين الشراء والبيع؟

سؤال مفتوح منذ BASELINE.md القسم ٦. وهو يختلف عن مسح الفلاتر السابق: ليس تركيبة
مُنتقاة من أربعمئة، بل متغيّر واحد له سبب واقعي — جلسات لندن ونيويورك وسيولتها.
ومع ذلك يبقى الحَكَم واحداً: سنة لم تدخل الاختيار.

الوقت بتوقيت UTC كما يأتي من المحرك.

    python3 hours.py
"""
import json
from collections import defaultdict

import numpy as np

import tune

YEARS = tune.YEARS
DEF = dict(length=18, momentum=6, zone=(20.0, 80.0), reaction=2, wait=12, extreme=40)
TP, SL = tune.TP, tune.SL


def trades(D, buy, sell):
    """قائمة الصفقات الفعلية بالتسلسل: (ساعة، جهة، ربح/خسارة، نقاط)."""
    res, bars = D['res'], D['bars']
    hr = ((D['time'] // 3600000) % 24).astype(int)
    out = []
    busy = -1
    for i in np.flatnonzero(buy | sell):
        if i <= busy:
            continue
        side = 1 if buy[i] else -1
        busy = i + int(bars[side][i])
        o = res[side][i]
        if o == 1:
            out.append((hr[i], side, 1, TP))
        elif o == 0:
            out.append((hr[i], side, 0, -SL))
    return out


def stat(rows, rnd):
    n = len(rows)
    if n == 0:
        return None
    w = sum(r[2] for r in rows)
    net = sum(r[3] for r in rows)
    lift = 0.0
    for side, k in ((1, 0), (-1, 1)):
        m = [r for r in rows if r[1] == side]
        if m:
            lift += len(m) * (100.0 * sum(r[2] for r in m) / len(m) - rnd[k])
    return {'n': n, 'wr': 100.0 * w / n, 'net': net, 'pt': net / n, 'lift': lift / n}


def main():
    T = {}
    for y in YEARS:
        D = tune.load(y); P = tune.prep(D)
        T[y] = trades(D, *tune.sig(D, P, DEF))
        print(f"  {y}: {len(T[y])} صفقة محسومة", flush=True)

    print("\n═══ الحافة حسب ساعة الدخول (UTC) — السنوات الأربع مجتمعة ═══")
    print(f"{'الساعة':>8}{'صفقات':>8}{'فوز%':>8}{'الزيادة':>9}{'صافي':>9}{'/صفقة':>9}"
          f"{'شراء ن':>8}{'شراء%':>8}{'بيع ن':>8}{'بيع%':>8}")
    per_hour = defaultdict(list)
    for y in YEARS:
        for r in T[y]:
            per_hour[r[0]].append((r, tune.RND[y]))
    for h in range(24):
        rows = [r for r, _ in per_hour[h]]
        if not rows:
            continue
        n = len(rows); w = sum(r[2] for r in rows); net = sum(r[3] for r in rows)
        lift = sum((100.0 * r[2] - rnd[0 if r[1] == 1 else 1]) for r, rnd in per_hour[h]) / n
        bs = [r for r in rows if r[1] == 1]; ss = [r for r in rows if r[1] == -1]
        bw = 100.0 * sum(r[2] for r in bs) / len(bs) if bs else 0
        sw = 100.0 * sum(r[2] for r in ss) / len(ss) if ss else 0
        print(f"{h:>8}{n:>8}{100.0*w/n:>8.2f}{lift:>+9.2f}{net:>+9.0f}{net/n:>+9.2f}"
              f"{len(bs):>8}{bw:>8.1f}{len(ss):>8}{sw:>8.1f}")

    print("\n═══ نوافذ الجلسات ═══")
    WIN = {'آسيا 00-06': range(0, 7), 'لندن 07-12': range(7, 13),
           'تداخل 13-16': range(13, 17), 'نيويورك 17-21': range(17, 22),
           'متأخر 22-23': range(22, 24)}
    print(f"{'النافذة':>14}{'صفقات':>8}{'فوز%':>8}{'الزيادة':>9}{'صافي':>9}{'/صفقة':>9}{'موجبة':>8}")
    for lab, hrs in WIN.items():
        rows = [r for r, _ in sum((per_hour[h] for h in hrs), [])]
        pairs = sum((per_hour[h] for h in hrs), [])
        if not rows:
            continue
        n = len(rows); w = sum(r[2] for r in rows); net = sum(r[3] for r in rows)
        lift = sum((100.0 * r[2] - rnd[0 if r[1] == 1 else 1]) for r, rnd in pairs) / n
        pos = sum(1 for y in YEARS if sum(r[3] for r in T[y] if r[0] in hrs) > 0)
        print(f"{lab:>14}{n:>8}{100.0*w/n:>8.2f}{lift:>+9.2f}{net:>+9.0f}{net/n:>+9.2f}{pos:>8}")

    print("\n═══ الجهة: شراء مقابل بيع، لكل سنة ═══")
    print(f"{'سنة':>8}{'شراء ن':>9}{'شراء%':>9}{'عشوائي':>9}{'زيادة':>8}"
          f"{'بيع ن':>9}{'بيع%':>9}{'عشوائي':>9}{'زيادة':>8}")
    for y in YEARS:
        row = f"{y:>8}"
        for side, k in ((1, 0), (-1, 1)):
            m = [r for r in T[y] if r[1] == side]
            wr = 100.0 * sum(r[2] for r in m) / len(m)
            row += f"{len(m):>9}{wr:>9.2f}{tune.RND[y][k]:>9.2f}{wr-tune.RND[y][k]:>+8.2f}"
        print(row)

    print("\n═══ الحكم: تُختار أفضل نافذة على ثلاث سنوات وتُقاس على الرابعة ═══")
    print(f"{'المتروكة':>10}{'المختارة':>16}{'تدريب/صفقة':>13}{'صافي':>9}"
          f"{'كل الساعات':>12}{'الفرق':>9}")
    tp = tb = 0.0
    picks = []
    for held in YEARS:
        tr = [y for y in YEARS if y != held]
        best, bv = None, None
        for lab, hrs in WIN.items():
            rows = [(r, tune.RND[y]) for y in tr for r in T[y] if r[0] in hrs]
            s = stat([r for r, _ in rows], (0, 0))
            if s is None or s['n'] < 150:
                continue
            if bv is None or s['pt'] > bv['pt']:
                best, bv = (lab, hrs), s
        sel = [r for r in T[held] if r[0] in best[1]]
        t = stat(sel, tune.RND[held]) or {'net': 0.0}
        allr = stat(T[held], tune.RND[held])
        tp += t['net']; tb += allr['net']
        picks.append(best[0])
        print(f"{held:>10}{best[0]:>16}{bv['pt']:>13.2f}{t['net']:>+9.0f}"
              f"{allr['net']:>+12.0f}{t['net']-allr['net']:>+9.0f}")
    print(f"\n  المجموع: النافذة المختارة {tp:+,.0f} • كل الساعات {tb:+,.0f} • "
          f"الفرق {tp-tb:+,.0f}  {'✓ نجح' if tp > tb else '✗ فشل'}")
    print(f"  المختارة: {', '.join(picks)}"
          f"{'  — ثابت' if len(set(picks)) == 1 else '  — غير ثابت'}")


if __name__ == '__main__':
    main()
