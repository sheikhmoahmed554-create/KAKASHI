"""يبحث في تركيبات المدارس والأساليب، ويحكم عليها على كل النوافذ المتاحة.

    python3 research/tools/combosearch.py [الخرج.json]

المراحل:
  ١ — قياس كل مصدر وحده (مدرسة أو أسلوب، كل جهة على حدة) بخطة ٣٠/٥٠.
  ٢ — مسح شامل لكل تركيبات أفضل اثني عشر مصدراً (٤٠٩٦ تركيبة).
  ٣ — توسيع جشع حتى ثلاثين مصدراً لرفع عدد الصفقات.
  ٤ — مسح خطط الخروج المسموحة على أفضل التركيبات.

كل رقم يُقاس على سبع نوافذ شهرية وكل النوافذ الأسبوعية. التركيبة لا تُقبل
إلا إذا ربحت في أغلب النوافذ، لا في المجموع فقط.
"""
import itertools
import json
import sys
import time

import numpy as np

import combolab as L
import styles as ST

REF_TP, REF_SL = 30, 50           # الخطة المرجعية: أقل هدف مسموح، ووقف = الهدف + ٢٠
TOP_EXHAUSTIVE = 12
GREEDY_MAX = 30


def build_sources(D, sig):
    """كل مصدر: (اسم، جهة، قناع). الجهة ١ شراء و−١ بيع."""
    n = D['n']
    src = []
    schools = [
        ('٠٦_زخم', 'capMomUltraBuy', 'capMomUltraSell'),
        ('٠٩_بولنجر_كلتنر', 'bbkcBuy', 'bbkcSell'),
        ('١١_QQE_فورتكس', 'capQVUltraBuy', 'capQVUltraSell'),
        ('١٢_إعادة_توازن', 'syr30BalanceBuy', 'syr30BalanceSell'),
        ('١٧_مزاد_ميت', 'syr30DeadAuctionBuy', 'syr30DeadAuctionSell'),
        ('١٨_إيتشيموكو', 'capIchiUltraBuy', 'capIchiMidSell'),
        ('١٩_حزمة_جهة', 'cap331UltraBuy', 'cap331MidSell'),
        ('٢٢_سيولة', 'capLiqExactBuy', 'capLiqExactSell'),
        ('٢٣_آسيا', 'syr30AsiaBuy', 'syr30AsiaSell'),
        ('راوتر_BASE', 'k3BaseSideBuy', 'k3BaseSideSell'),
        ('راوتر_TV', 'k3TVSideBuy', 'k3TVSideSell'),
    ]
    for label, kb, ks in schools:
        for side, key in ((1, kb), (-1, ks)):
            m = L.to_mask(sig['fired'].get(key, []), n)
            if m.sum() >= 60:
                src.append((f'{label}[{"شراء" if side == 1 else "بيع"}]', side, m))

    F = ST.features(D)
    for label, (b, s) in ST.styles(D, F).items():
        for side, m in ((1, b), (-1, s)):
            if m.sum() >= 60:
                src.append((f'{label}[{"شراء" if side == 1 else "بيع"}]', side, m))
    return src


def eval_set(chosen, oc, months, weeks, days, tp=REF_TP, sl=REF_SL):
    n = len(months)
    buy = np.zeros(n, bool)
    sell = np.zeros(n, bool)
    for _, side, m in chosen:
        if side == 1:
            buy |= m
        else:
            sell |= m
    bars, outs, _ = L.simulate(buy, sell, oc)
    return L.score(bars, outs, tp, sl, months, weeks, days)


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else 'research/results/combosearch.json'
    t0 = time.time()
    D = L.load_candles()
    sig = L.load_signals()
    months, weeks, days = L.window_keys(D)
    print(f'{D["n"]} شمعة، {len(set(months))} شهر، {len(set(weeks))} أسبوع')

    oc = L.outcomes(D, REF_TP, REF_SL)
    src = build_sources(D, sig)
    print(f'{len(src)} مصدر يطلق إشارات كافية\n')

    # ---------------- ١ — كل مصدر وحده
    singles = []
    for s in src:
        sc = eval_set([s], oc, months, weeks, days)
        if sc and sc['trades'] >= 100:
            singles.append((s, sc))
    singles.sort(key=lambda x: (x[1]['month_median'], x[1]['per_trade']), reverse=True)
    print('### كل مصدر وحده، خطة ٣٠/٥٠ — مرتبة بوسيط الشهور\n')
    print(f"{'المصدر':<34}{'صفقات':>7}{'فوز٪':>8}{'حافة':>8}{'شهور':>8}{'أسابيع':>9}{'وسيط':>8}")
    for s, sc in singles:
        print(f"{s[0]:<34}{sc['trades']:>7}{sc['win_rate']:>8.2f}{sc['edge']:>+8.2f}"
              f"{sc['months_won']:>5}/{sc['months_total']:<3}{sc['weeks_won']:>6}/{sc['weeks_total']:<3}"
              f"{sc['month_median']:>+8.2f}")

    survivors = [s for s, sc in singles if sc['month_median'] > 0]
    print(f'\n{len(survivors)} مصدر ربح في أغلب شهوره\n')

    # ---------------- ٢ — مسح شامل لأفضل اثني عشر
    pool = survivors[:TOP_EXHAUSTIVE]
    combos = []
    for k in range(1, len(pool) + 1):
        for combo in itertools.combinations(pool, k):
            sc = eval_set(combo, oc, months, weeks, days)
            if sc and sc['trades'] >= 200:
                combos.append(([c[0] for c in combo], sc))
    combos.sort(key=lambda x: (x[1]['month_median'], x[1]['per_trade']), reverse=True)
    print(f'### {len(combos)} تركيبة مفحوصة — أفضل عشر بوسيط الشهور\n')
    for names, sc in combos[:10]:
        print(f"  {sc['win_rate']:>5.2f}%  حافة {sc['edge']:>+6.2f}  {sc['per_day']:>5.2f}/يوم  "
              f"شهور {sc['months_won']}/{sc['months_total']}  وسيط {sc['month_median']:>+6.2f}  "
              f"{' + '.join(names)}")

    # ---------------- ٣ — توسيع جشع لرفع عدد الصفقات
    best = list(pool[:1])
    if combos:
        top_names = set(combos[0][0])
        best = [s for s in src if s[0] in top_names]
    trail = []
    remaining = [s for s in survivors if s[0] not in {b[0] for b in best}]
    while len(best) < GREEDY_MAX and remaining:
        scored = []
        for cand in remaining:
            sc = eval_set(best + [cand], oc, months, weeks, days)
            if sc:
                scored.append((sc['month_median'], sc['per_trade'], cand, sc))
        if not scored:
            break
        scored.sort(reverse=True, key=lambda x: (x[0], x[1]))
        _, _, cand, sc = scored[0]
        if sc['month_median'] <= 0:
            break
        best.append(cand)
        remaining = [s for s in remaining if s[0] != cand[0]]
        trail.append({'added': cand[0], 'sources': len(best), **sc})
        print(f"  +{cand[0]:<34} → {sc['trades']:>5} صفقة  {sc['win_rate']:>5.2f}%  "
              f"{sc['per_day']:>5.2f}/يوم  شهور {sc['months_won']}/{sc['months_total']}  "
              f"وسيط {sc['month_median']:>+6.2f}")

    # ---------------- ٤ — مسح الخطط المسموحة على أفضل تركيبة
    print('\n### خطط الخروج المسموحة على التركيبة النهائية\n')
    plans = []
    for tp in range(30, 65, 5):
        for sl in range(20, tp + 21, 5):
            oc2 = L.outcomes(D, tp, sl)
            sc = eval_set(best, oc2, months, weeks, days, tp, sl)
            if sc:
                plans.append({'tp': tp, 'sl': sl, **sc})
                print(f"  TP{tp:>2}/SL{sl:>2}  {sc['win_rate']:>5.2f}%  حافة {sc['edge']:>+6.2f}  "
                      f"{sc['per_trade']:>+7.3f} نقطة/صفقة  {sc['per_day']:>5.2f}/يوم  "
                      f"شهور {sc['months_won']}/{sc['months_total']}")
    plans.sort(key=lambda p: (p['month_median'], p['per_trade']), reverse=True)

    json.dump({
        'singles': [{'source': s[0], **sc} for s, sc in singles],
        'combos': [{'sources': names, **sc} for names, sc in combos[:200]],
        'greedy': trail,
        'final_sources': [b[0] for b in best],
        'plans': plans,
        'runtime_seconds': round(time.time() - t0, 1),
    }, open(out_path, 'w'), ensure_ascii=False, indent=1)
    print(f'\nتم في {time.time() - t0:.0f}s → {out_path}')


if __name__ == '__main__':
    main()
