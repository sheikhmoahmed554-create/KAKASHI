"""بحث موجّه عن نسبة فوز ٧٥–٨٠٪ داخل قيود السكالب.

    PYTHONPATH=research/tools python3 research/tools/hunt75.py [tp] [sl]

الخطة الافتراضية ٣٠/٥٠ لأنها أعلى نسبة فوز تسمح بها القاعدة (الهدف الأصغر مع
الستوب الأكبر). الفحص على مرحلتين: غربلة سريعة بنتيجة الدخول عند كل شمعة، ثم
تثبيت الناجين بمحاكاة تسلسلية بصفقة واحدة مفتوحة وقياس على كل شهر.
"""
import itertools
import json
import sys

import numpy as np

import combolab as L
import combosearch as CS
import styles as ST

MIN_TRADES = 150
TARGET_WR = 75.0


def main():
    tp = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    sl = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    D = L.load_candles()
    sig = L.load_signals()
    months, weeks, days = L.window_keys(D)
    oc = L.outcomes(D, tp, sl)
    res_b, res_s = oc[0], oc[1]
    F = ST.features(D)
    n = D['n']
    warm = np.arange(n) > 250

    # مكتبة شروط: كل خاصية عند عشرة فواصل، بالاتجاهين
    conds = []
    for name in ['atr14', 'atr_ratio', 'rsi3', 'rsi14', 'bb_z', 'pos20', 'pos60', 'pos240',
                 'vol_ratio', 'body', 'upwick', 'dnwick', 'vwap_dist', 'to_dollar', 'htf60_slope']:
        x = F[name]
        fin = np.isfinite(x)
        for q in (5, 10, 20, 30, 70, 80, 90, 95):
            thr = float(np.nanpercentile(x[fin], q))
            if q <= 30:
                conds.append((f'{name}<{thr:.4g}', fin & (x < thr)))
            else:
                conds.append((f'{name}>{thr:.4g}', fin & (x > thr)))
    for s in ('sess_asia', 'sess_london', 'sess_ny'):
        conds.append((s, F[s].astype(bool)))
    print(f'{len(conds)} شرط في المكتبة')

    src = {s[0]: s for s in CS.build_sources(D, sig)}
    bases = [('كل الشموع', 1, warm), ('كل الشموع', -1, warm)]
    for nm in ['اندفاع_حجم_مع_انهيار[شراء]', 'ار_اس_اي_٣_متطرف[شراء]',
               'ما_وراء_البولنجر[شراء]', 'قرب_الرقم_المدور[شراء]', 'راوتر_BASE[شراء]',
               'راوتر_BASE[بيع]', '٠٩_بولنجر_كلتنر[بيع]']:
        if nm in src:
            _, side, m = src[nm]
            bases.append((nm, side, m & warm))

    found = []
    for label, side, base in bases:
        res = res_b if side == 1 else res_s
        decided = base & (res != 0)
        if decided.sum() < MIN_TRADES:
            continue
        wr0 = 100.0 * (res[decided] == 1).mean()
        print(f'\n{label} [{"شراء" if side == 1 else "بيع"}] — أساس {int(decided.sum())} شمعة، {wr0:.2f}%')
        # شرط واحد ثم شرطان ثم ثلاثة، مع إبقاء الأفضل فقط في كل مستوى
        level = [((), decided)]
        for depth in (1, 2, 3):
            nxt = []
            for names, mask in level:
                for cname, cmask in conds:
                    if cname in names:
                        continue
                    m2 = mask & cmask
                    k = int(m2.sum())
                    if k < MIN_TRADES:
                        continue
                    wr = 100.0 * (res[m2] == 1).mean()
                    nxt.append(((*names, cname), m2, wr, k))
            if not nxt:
                break
            nxt.sort(key=lambda x: x[2], reverse=True)
            best = nxt[:40]
            print(f'  عمق {depth}: أفضل نسبة غربلة {best[0][2]:.2f}% على {best[0][3]} شمعة')
            for names, m2, wr, k in best:
                if wr >= TARGET_WR:
                    found.append((label, side, names, m2, wr, k))
            level = [(names, m2) for names, m2, _, _ in best]

    print(f'\n{len(found)} قاعدة تجاوزت {TARGET_WR}% في الغربلة\n')
    confirmed = []
    for label, side, names, mask, wr, k in found:
        buy = mask if side == 1 else np.zeros(n, bool)
        sell = mask if side == -1 else np.zeros(n, bool)
        bars, outs, _ = L.simulate(buy, sell, oc)
        sc = L.score(bars, outs, tp, sl, months, weeks, days)
        if not sc or sc['trades'] < MIN_TRADES:
            continue
        confirmed.append({'base': label, 'side': int(side), 'conditions': list(names),
                          'screen_win_rate': round(wr, 2), 'screen_bars': k, **sc})
    confirmed.sort(key=lambda r: r['win_rate'], reverse=True)
    print(f"{'نسبة الفوز':>10}{'صفقات':>8}{'/يوم':>7}{'شهور':>8}{'أسابيع':>9}  القاعدة")
    for r in confirmed[:25]:
        print(f"{r['win_rate']:>10.2f}{r['trades']:>8}{r['per_day']:>7.2f}"
              f"{r['months_won']:>5}/{r['months_total']:<2}{r['weeks_won']:>6}/{r['weeks_total']:<2}"
              f"  {r['base']} + {' & '.join(r['conditions'])}")
    json.dump(confirmed, open(f'research/results/hunt75_{tp}_{sl}.json', 'w'),
              ensure_ascii=False, indent=1)
    print(f'\n{len(confirmed)} قاعدة ثبتت بالمحاكاة التسلسلية')


if __name__ == '__main__':
    main()
