"""يبني أفضل تركيبة من المصادر التي تتفوق على الدخول العشوائي فعلاً.

    PYTHONPATH=research/tools python3 research/tools/liftcombo.py [tp] [sl]

الفرق عن combosearch: الترتيب هنا بالزيادة فوق العشوائي لكل شهر، لا فوق التعادل.
هذا يمنع اختيار تركيبة بيع تبدو رابحة لأن الذهب نزل في الفترة.
"""
import itertools
import json
import sys

import numpy as np

import combolab as L
import combosearch as CS

MIN_MONTHS_POSITIVE = 5
TOP = 9


def main():
    tp = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    sl = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    D = L.load_candles()
    sig = L.load_signals()
    months, weeks, days = L.window_keys(D)
    oc = L.outcomes(D, tp, sl)
    res_b, res_s = oc[0], oc[1]
    valid = np.arange(D['n']) > 250

    base = {}
    for side, res in ((1, res_b), (-1, res_s)):
        for m in sorted(set(months)):
            sel = valid & (months == m) & (res != 0)
            if sel.sum() >= 500:
                base[(side, m)] = 100.0 * (res[sel] == 1).sum() / sel.sum()

    def lift_score(chosen):
        n = D['n']
        buy = np.zeros(n, bool)
        sell = np.zeros(n, bool)
        for _, side, m in chosen:
            (buy if side == 1 else sell)[m] = True
        bars, outs, sds = L.simulate(buy, sell, oc)
        if len(bars) < 150:
            return None
        lifts = []
        for m in sorted(set(months)):
            sel = months[bars] == m
            if sel.sum() < L.MIN_TRADES_WINDOW:
                continue
            wr = 100.0 * (outs[sel] == 1).sum() / sel.sum()
            # خط الأساس للتركيبة = متوسط موزون بجهة صفقاتها في هذا الشهر
            nb = int((sds[sel] == 1).sum())
            ns = int(sel.sum()) - nb
            parts = []
            if nb and (1, m) in base:
                parts.append(base[(1, m)] * nb)
            if ns and (-1, m) in base:
                parts.append(base[(-1, m)] * ns)
            if not parts:
                continue
            lifts.append(wr - sum(parts) / sel.sum())
        if len(lifts) < 4:
            return None
        wins = int((outs == 1).sum())
        net = wins * tp - (len(bars) - wins) * sl
        ndays = len(set(days[bars]))
        return {
            'trades': int(len(bars)), 'win_rate': round(100.0 * wins / len(bars), 2),
            'median_lift': round(float(np.median(lifts)), 2),
            'worst_lift': round(float(np.min(lifts)), 2),
            'months_positive': int(sum(1 for x in lifts if x > 0)), 'months': len(lifts),
            'per_trade': round(net / len(bars), 3), 'net_points': int(net),
            'per_day': round(len(bars) / ndays, 2) if ndays else 0,
        }

    src = CS.build_sources(D, sig)
    singles = []
    for s in src:
        sc = lift_score([s])
        if sc and sc['median_lift'] > 0 and sc['months_positive'] >= MIN_MONTHS_POSITIVE:
            singles.append((s, sc))
    singles.sort(key=lambda x: x[1]['median_lift'], reverse=True)
    print(f'{len(singles)} مصدر تفوّق على العشوائي في {MIN_MONTHS_POSITIVE} شهور فأكثر\n')
    for s, sc in singles:
        print(f"  {s[0]:<32}{sc['trades']:>6}  {sc['win_rate']:>5.2f}%  زيادة {sc['median_lift']:>+5.2f}  "
              f"أسوأ {sc['worst_lift']:>+6.2f}  {sc['months_positive']}/{sc['months']}")

    pool = [s for s, _ in singles[:TOP]]
    best = []
    for k in range(1, len(pool) + 1):
        for combo in itertools.combinations(pool, k):
            sc = lift_score(list(combo))
            if sc and sc['months_positive'] >= MIN_MONTHS_POSITIVE:
                best.append(([c[0] for c in combo], sc))
    best.sort(key=lambda x: (x[1]['median_lift'], x[1]['trades']), reverse=True)
    print(f'\n{len(best)} تركيبة صمدت في {MIN_MONTHS_POSITIVE} شهور فأكثر — أفضل ١٥\n')
    for names, sc in best[:15]:
        print(f"  زيادة {sc['median_lift']:>+5.2f}  أسوأ {sc['worst_lift']:>+6.2f}  "
              f"{sc['win_rate']:>5.2f}%  {sc['trades']:>5} صفقة  {sc['per_day']:>5.2f}/يوم  "
              f"{sc['per_trade']:>+6.2f} نقطة  {sc['months_positive']}/{sc['months']}  {' + '.join(names)}")

    json.dump({'plan': [tp, sl],
               'singles': [{'source': s[0], **sc} for s, sc in singles],
               'combos': [{'sources': n, **sc} for n, sc in best[:100]]},
              open(f'research/results/liftcombo_{tp}_{sl}.json', 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
