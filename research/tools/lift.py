"""يرتّب المصادر بالزيادة فوق الدخول العشوائي، لا فوق نقطة التعادل.

    PYTHONPATH=research/tools python3 research/tools/lift.py [tp] [sl]

لكل مصدر ولكل شهر: نسبة فوزه ناقص نسبة فوز الدخول عند كل شمعة في نفس الشهر
وبنفس الجهة. هذه هي الزيادة الحقيقية. مصدر بيع يسجّل ٦٤٪ في يوليو بينما
العشوائي بيعاً يسجّل ٦٤.٥٪ في يوليو لم يكتشف شيئاً.
"""
import json
import sys

import numpy as np

import combolab as L
import combosearch as CS


def main():
    tp = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    sl = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    D = L.load_candles()
    sig = L.load_signals()
    months, weeks, days = L.window_keys(D)
    res_b, res_s, bar_b, bar_s = oc = L.outcomes(D, tp, sl)

    # خط الأساس لكل شهر ولكل جهة: الدخول عند كل شمعة بلا شرط
    valid = np.arange(D['n']) > 250
    base = {}
    for side, res in ((1, res_b), (-1, res_s)):
        for m in sorted(set(months)):
            sel = valid & (months == m) & (res != 0)
            if sel.sum() >= 500:
                base[(side, m)] = 100.0 * (res[sel] == 1).sum() / sel.sum()

    rows = []
    for name, side, mask in CS.build_sources(D, sig):
        buy = mask if side == 1 else np.zeros(D['n'], bool)
        sell = mask if side == -1 else np.zeros(D['n'], bool)
        bars, outs, _ = L.simulate(buy, sell, oc)
        if len(bars) < 150:
            continue
        lifts, per_month = [], {}
        for m in sorted(set(months)):
            sel = months[bars] == m
            if sel.sum() < L.MIN_TRADES_WINDOW or (side, m) not in base:
                continue
            wr = 100.0 * (outs[sel] == 1).sum() / sel.sum()
            lift = wr - base[(side, m)]
            lifts.append(lift)
            per_month[m] = round(float(lift), 2)
        if len(lifts) < 4:
            continue
        wins = int((outs == 1).sum())
        wr_all = 100.0 * wins / len(bars)
        rows.append({
            'source': name, 'trades': int(len(bars)), 'win_rate': round(wr_all, 2),
            'median_lift': round(float(np.median(lifts)), 2),
            'worst_lift': round(float(np.min(lifts)), 2),
            'months_positive': int(sum(1 for x in lifts if x > 0)), 'months': len(lifts),
            'per_month': per_month,
        })

    rows.sort(key=lambda r: r['median_lift'], reverse=True)
    print(f'## الزيادة فوق العشوائي — خطة {tp}/{sl}\n')
    print(f"{'المصدر':<34}{'صفقات':>7}{'فوز٪':>8}{'وسيط الزيادة':>14}{'أسوأ شهر':>11}{'شهور موجبة':>12}")
    for r in rows:
        print(f"{r['source']:<34}{r['trades']:>7}{r['win_rate']:>8.2f}{r['median_lift']:>+14.2f}"
              f"{r['worst_lift']:>+11.2f}{r['months_positive']:>7}/{r['months']:<4}")
    json.dump(rows, open(f'research/results/lift_{tp}_{sl}.json', 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
