"""محاولة ثانية للحكم على الفلاتر — بقاعدة اختيار أمتن.

المحاولة الأولى اختارت بالتوقّع لكل صفقة، فوقعت على تركيبات تُبقي عُشر الصفقات
وتبدو ممتازة لأنها قليلة. هذه المحاولة تشترط إبقاء نصف الصفقات على الأقل وتختار
بالزيادة فوق العشوائي مقسومة على خطئها المعياري، وهو معيار المشروع أصلاً.

وهي محاولة ثانية بعد فشل الأولى، فحتى لو نجحت تبقى قيمتها أقل — والمحاولات
تُحصى. تُطبع النتيجتان معاً بلا انتقاء.

    python3 filters_oos2.py
"""
import json

import numpy as np

import comb
from filters import agg

YEARS = comb.YEARS


def loyo(DATA, pool, key, min_keep, base_trades):
    """يختار على ثلاث سنوات بالمعيار المعطى ويقيس على الرابعة."""
    tp = tb = 0.0
    picks = []
    rows = []
    for held in YEARS:
        tr = [y for y in YEARS if y != held]
        floor = min_keep * base_trades * 0.75      # ثلاث سنوات من أصل أربع
        best, bv = None, None
        for r in pool:
            names = r['name'].split('+')
            a = agg(DATA, {x: 'Filter' for x in names}, tr)
            if a is None or a['trades'] < floor:
                continue
            if bv is None or a[key] > bv[key]:
                best, bv = names, a
        t = agg(DATA, {x: 'Filter' for x in best}, [held])
        b = agg(DATA, {}, [held])
        tp += t['net']; tb += b['net']
        picks.append('+'.join(best))
        rows.append((held, '+'.join(best), bv[key], t['per_trade'], t['net'], b['net'],
                     100.0 * t['trades'] / b['trades']))
    return tp, tb, picks, rows


def main():
    DATA = {y: comb.load(y) for y in YEARS}
    base = agg(DATA, {}, YEARS)
    pool = json.load(open('filter_report.json'))
    print(f"خط الأساس: {base['trades']:,} صفقة • صافي {base['net']:+,.0f} • "
          f"{base['per_trade']:+.3f}/صفقة • {base['sigma']:+.2f}σ")
    print(f"المجموعة: {len(pool)} تركيبة\n")

    for label, key, mk in (('بالتوقّع لكل صفقة، بلا شرط', 'per_trade', 0.0),
                           ('بالزيادة/σ مع إبقاء ≥50% من الصفقات', 'sigma', 0.50),
                           ('بالزيادة/σ مع إبقاء ≥70% من الصفقات', 'sigma', 0.70)):
        tp, tb, picks, rows = loyo(DATA, pool, key, mk, base['trades'])
        print(f"═══ قاعدة الاختيار: {label} ═══")
        print(f"{'المتروكة':>10}{'المختار':>20}{'تدريب':>10}{'اختبار/صفقة':>13}"
              f"{'صافي':>10}{'أساس':>10}{'الفرق':>10}{'أبقى%':>8}")
        for held, name, trv, pt, net, bnet, keep in rows:
            print(f"{held:>10}{name:>20}{trv:>10.3f}{pt:>13.3f}{net:>10.0f}"
                  f"{bnet:>10.0f}{net-bnet:>+10.0f}{keep:>8.0f}")
        print(f"  المجموع: الفلتر {tp:+,.0f} • بلا فلتر {tb:+,.0f} • الفرق {tp-tb:+,.0f}"
              f"  {'✓ نجح' if tp > tb else '✗ فشل'}")
        print(f"  الثبات: {'ثابت' if len(set(picks)) == 1 else 'غير ثابت'}\n")


if __name__ == '__main__':
    main()
