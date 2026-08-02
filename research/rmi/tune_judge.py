"""الحكم على مسح إعدادات RMI.

ثلاثة أسئلة، بهذا الترتيب:

١ — أين يقع الإعداد الافتراضي بين الألف وأربعمئة؟ إن كان في القمة فلا شيء نضبطه،
    وإن كان في القاع فالضبط له معنى.

٢ — الأثر الحدّي لكل قيمة: متوسط أدائها عبر كل الإعدادات الأخرى (٢٨٨ إعداداً
    لكل قيمة). أفضلُ صفٍّ في جدول من ألف صفّ يكون أفضل بالصدفة غالباً؛ أما القيمة
    التي ترفع المتوسط عبر مئات التركيبات فذلك أثر لا صدفة. هذا هو السؤال الحقيقي.

٣ — ترك سنة كاملة خارج الاختيار. الحَكَم الأخير، وبثلاث قواعد اختيار تُطبع كلها.

    python3 tune_judge.py
"""
import json
from collections import defaultdict

import numpy as np

import tune

YEARS = tune.YEARS
DEF = {'length': 18, 'momentum': 6, 'zone': [20.0, 80.0], 'reaction': 2,
       'wait': 12, 'extreme': 40}
AR = {'length': 'الطول', 'momentum': 'الزخم', 'zone': 'المناطق',
      'reaction': 'شمعات التفاعل', 'wait': 'نافذة الانتظار', 'extreme': 'قمة/قاع'}


def key(cfg):
    return (cfg['length'], cfg['momentum'], tuple(cfg['zone']),
            cfg['reaction'], cfg['wait'], cfg['extreme'])


def name(cfg):
    return (f"L{cfg['length']}/M{cfg['momentum']}/{cfg['zone'][0]:.0f}-{cfg['zone'][1]:.0f}"
            f"/R{cfg['reaction']}/W{cfg['wait']}/E{cfg['extreme']}")


def main():
    raw = json.load(open('tune_raw.json'))
    for r in raw:
        r['all'] = tune.combine(r['per'], YEARS)
    pool = [r for r in raw if r['all']]
    print(f"مُسح {len(raw)} إعداداً، صالح منها {len(pool)} (≥٢٠٠ صفقة)\n")

    base = next(r for r in raw if key(r['cfg']) == key(DEF))
    b = base['all']
    print("═══ الإعداد الافتراضي ═══")
    print(f"  {name(DEF)}")
    print(f"  {b['trades']:,} صفقة • {b['per_day']:.1f}/يوم • فوز {b['win_rate']:.2f}% • "
          f"صافي {b['net']:+,.0f} • {b['per_trade']:+.3f}/صفقة • {b['sigma']:+.2f}σ • "
          f"{b['pos']}/4 سنوات موجبة")
    for k in ('net', 'per_trade', 'sigma'):
        rank = sum(1 for r in pool if r['all'][k] > b[k]) + 1
        print(f"  ترتيبه بـ{k}: {rank} من {len(pool)}  (أعلى {100.0*rank/len(pool):.0f}%)")

    print("\n═══ ٢ — الأثر الحدّي لكل قيمة (متوسط عبر كل الإعدادات الأخرى) ═══")
    print(f"{'المُعامل':>16}{'القيمة':>12}{'عدد':>6}{'وسيط الصافي':>14}"
          f"{'وسيط /صفقة':>13}{'وسيط σ':>10}{'متوسط صفقات':>13}")
    for p in ('length', 'momentum', 'zone', 'reaction', 'wait', 'extreme'):
        g = defaultdict(list)
        for r in pool:
            v = r['cfg'][p]
            g[tuple(v) if isinstance(v, list) else v].append(r['all'])
        for v in sorted(g, key=lambda x: (x if not isinstance(x, tuple) else x[0])):
            rs = g[v]
            lab = f"{v[0]:.0f}-{v[1]:.0f}" if isinstance(v, tuple) else str(v)
            mark = ' ←' if (list(v) if isinstance(v, tuple) else v) == DEF[p] else ''
            print(f"{AR[p]:>16}{lab+mark:>12}{len(rs):>6}"
                  f"{np.median([x['net'] for x in rs]):>+14.0f}"
                  f"{np.median([x['per_trade'] for x in rs]):>+13.3f}"
                  f"{np.median([x['sigma'] for x in rs]):>+10.2f}"
                  f"{np.mean([x['trades'] for x in rs]):>13.0f}")
        print()

    print("═══ أفضل ١٥ إعداداً داخل العيّنة (بالصافي) — للاطّلاع لا للاعتماد ═══")
    print(f"{'الإعداد':>30}{'صفقات':>8}{'/يوم':>7}{'فوز%':>8}{'صافي':>9}"
          f"{'/صفقة':>8}{'σ':>7}{'موجبة':>7}")
    for r in sorted(pool, key=lambda r: -r['all']['net'])[:15]:
        a = r['all']
        print(f"{name(r['cfg']):>30}{a['trades']:>8}{a['per_day']:>7.1f}{a['win_rate']:>8.2f}"
              f"{a['net']:>+9.0f}{a['per_trade']:>+8.3f}{a['sigma']:>+7.2f}{a['pos']:>7}")

    print("\n═══ ٣ — الحكم: يُختار على ثلاث سنوات ويُقاس على الرابعة ═══")
    for label, k, need_pos in (('الصافي', 'net', 0),
                               ('التوقّع لكل صفقة', 'per_trade', 0),
                               ('σ', 'sigma', 0),
                               ('σ مع اشتراط ٣/٣ سنوات موجبة', 'sigma', 3)):
        tp = tb = 0.0
        picks, rows = [], []
        for held in YEARS:
            tr = [y for y in YEARS if y != held]
            best, bv = None, None
            for r in pool:
                a = tune.combine(r['per'], tr)
                if a is None or a['pos'] < need_pos:
                    continue
                if bv is None or a[k] > bv[k]:
                    best, bv = r, a
            t = best['per'][held]
            bs = base['per'][held]
            tp += t['net']; tb += bs['net']
            picks.append(name(best['cfg']))
            rows.append((held, name(best['cfg']), bv[k], t['net'], bs['net'], t['trades']))
        print(f"\n  قاعدة الاختيار: {label}")
        print(f"{'المتروكة':>10}{'المختار':>30}{'تدريب':>10}{'صافي':>9}"
              f"{'الافتراضي':>11}{'الفرق':>9}{'صفقات':>8}")
        for held, nm, trv, net, bn, n in rows:
            print(f"{held:>10}{nm:>30}{trv:>10.2f}{net:>+9.0f}{bn:>+11.0f}"
                  f"{net-bn:>+9.0f}{n:>8.0f}")
        print(f"    المجموع: المضبوط {tp:+,.0f} • الافتراضي {tb:+,.0f} • "
              f"الفرق {tp-tb:+,.0f}  {'✓ نجح' if tp > tb else '✗ فشل'}"
              f"  •  {'ثابت' if len(set(picks)) == 1 else 'غير ثابت'}")


if __name__ == '__main__':
    main()
