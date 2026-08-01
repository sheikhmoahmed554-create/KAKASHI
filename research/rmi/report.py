"""تقرير المصادر: كل مصدر وحده، Source و Filter، على أربع سنوات، مقابل العشوائي.

المقياس ليس نسبة الفوز بل الزيادة فوق الدخول العشوائي في السنة نفسها والجهة
نفسها، لأن اتجاه الذهب وحده يحرّك النسبة عدة نقاط مئوية. وعتبة القبول ١.٨σ
هي المعتمدة في هذا المشروع منذ درس «الساعة السادسة» المسجَّل في research/README.

يُطبَع أيضاً تصحيح الاختبارات المتعددة: نقيس ٤٢ تركيبة، فبعضها سيبدو جيداً
بالصدفة وحدها. العمود الأخير يقول كم منها يُتوقَّع أن يتجاوز العتبة لو لم يكن
لأيٍّ منها حافة إطلاقاً.
"""
import json

import numpy as np

import comb

YEARS = comb.YEARS
SOURCES = comb.SOURCES
SIGMA_BAR = 1.8


def main():
    DATA = {y: comb.load(y) for y in YEARS}

    print("═══ تحقّق: التركيبة الفارغة تطابق عدّادات المحرك ═══")
    ok = True
    for y in YEARS:
        r = comb.run(DATA[y], {})
        e = DATA[y]['engine']
        m = (r['trades'] == e['trades'] and r['wins'] == e['wins'])
        ok &= m
        print(f"  {y}: {r['trades']}/{r['wins']}W  مقابل محرك {e['trades']}/{e['wins']}W  "
              f"{'✓' if m else '✗'}")
    if not ok:
        raise SystemExit("!! التركيب لا يطابق المحرك — توقّف، لا تُقرأ أي نتيجة بعده.")

    base, base_years = comb.total(DATA, {})
    print(f"\n╔══ خط الأساس — RMI وحده ══╗")
    print(f"  {base['trades']:,} صفقة • {base['per_day']:.1f}/يوم • فوز {base['win_rate']:.2f}% • "
          f"صافي {base['net']:+,.0f}")
    print(f"  الزيادة فوق العشوائي {base['lift']:+.2f} نقطة مئوية = {base['sigma']:+.2f}σ • "
          f"سنوات موجبة {base['pos_years']}/4")

    rows = []
    for s in SOURCES:
        for mode in ('Source', 'Filter'):
            t, per = comb.total(DATA, {s: mode})
            if t is None:
                continue
            t['source'] = s
            t['mode'] = mode
            t['d_trades'] = t['trades'] - base['trades']
            t['d_net'] = t['net'] - base['net']
            t['d_lift'] = t['lift'] - base['lift']
            t['min_year_net'] = min(r['net'] for r in per.values())
            rows.append(t)

    def show(title, sel, n=14):
        print(f"\n═══ {title} ═══")
        print(f"{'المصدر':>7}{'الوضع':>8}{'صفقات':>8}{'Δصفقات':>9}{'/يوم':>7}{'فوز%':>8}"
              f"{'زيادة':>8}{'σ':>7}{'صافي':>9}{'Δصافي':>9}{'موجبة':>7}")
        for r in sel[:n]:
            print(f"{r['source']:>7}{r['mode']:>8}{r['trades']:>8}{r['d_trades']:>+9}"
                  f"{r['per_day']:>7.1f}{r['win_rate']:>8.2f}{r['lift']:>+8.2f}{r['sigma']:>+7.2f}"
                  f"{r['net']:>9.0f}{r['d_net']:>+9.0f}{r['pos_years']:>7}")

    show("مرتّبة بالزيادة فوق العشوائي", sorted(rows, key=lambda r: -r['sigma']), 20)
    show("مرتّبة بالصافي", sorted(rows, key=lambda r: -r['net']), 12)
    show("مرتّبة بالتحسّن على خط الأساس", sorted(rows, key=lambda r: -r['d_net']), 12)

    passed = [r for r in rows if r['sigma'] >= SIGMA_BAR]
    print(f"\n═══ الحكم ═══")
    print(f"عدد التركيبات المقيسة: {len(rows)}")
    print(f"ما تجاوز عتبة {SIGMA_BAR}σ: {len(passed)}")
    # تحت فرضية العدم، احتمال تجاوز 1.8σ لكل اختبار ≈ 3.6% ذيلين
    exp_by_chance = len(rows) * 0.036
    print(f"المتوقَّع بالصدفة وحدها لو لم يكن لأيٍّ منها حافة: {exp_by_chance:.1f}")
    if passed:
        for r in sorted(passed, key=lambda r: -r['sigma']):
            print(f"  {r['source']} {r['mode']}: {r['sigma']:+.2f}σ • صافي {r['net']:+.0f} • "
                  f"سنوات موجبة {r['pos_years']}/4 • أسوأ سنة {r['min_year_net']:+.0f}")
        if len(passed) <= exp_by_chance:
            print("\n  عددها لا يتجاوز ما تعطيه الصدفة. لا يُبنى على أيٍّ منها بمفرده.")
    else:
        print("  لا شيء. ولا مصدر واحد من الواحد والعشرين يرفع الحافة فوق العتبة.")

    print(f"\n═══ المصادر التي تتفوّق على الأساس في الصافي وعدد السنوات الموجبة معاً ═══")
    better = [r for r in rows if r['net'] > base['net'] and r['pos_years'] >= base['pos_years']]
    if better:
        for r in sorted(better, key=lambda r: -r['net'])[:10]:
            print(f"  {r['source']:>6} {r['mode']:<7} صافي {r['net']:+8.0f} "
                  f"(الأساس {base['net']:+.0f}) • {r['sigma']:+.2f}σ • {r['pos_years']}/4")
    else:
        print("  لا شيء.")

    json.dump([{k: (float(v) if isinstance(v, (int, float, np.floating)) else v)
                for k, v in r.items()} for r in rows],
              open('source_report.json', 'w'), indent=1, ensure_ascii=False)
    print("\nكُتب source_report.json")


if __name__ == '__main__':
    main()
