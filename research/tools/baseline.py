"""خط الأساس: نتيجة الدخول عند كل شمعة بلا أي شرط، لكل خطة ولكل نافذة.

    PYTHONPATH=research/tools python3 research/tools/baseline.py

بدون هذا الرقم تبدو أي قاعدة بيع عبقرية في سوق هابط. المقياس الصحيح لأي تركيبة
هو الزيادة فوق خط الأساس لنفس النافذة ونفس الجهة، لا فوق نقطة التعادل النظرية.
"""
import json

import numpy as np

import combolab as L


def main(out='research/results/baseline.json'):
    D = L.load_candles()
    months, weeks, days = L.window_keys(D)
    valid = np.arange(D['n']) > 250
    rows = []
    for tp in range(30, 65, 5):
        for sl in range(20, tp + 21, 5):
            res_b, res_s, _, _ = L.outcomes(D, tp, sl)
            entry = {'tp': tp, 'sl': sl, 'breakeven': round(100.0 * sl / (tp + sl), 2), 'months': {}}
            for side, res in (('buy', res_b), ('sell', res_s)):
                decided = valid & (res != 0)
                wr = 100.0 * (res[decided] == 1).sum() / max(decided.sum(), 1)
                entry[side] = round(float(wr), 2)
                for m in sorted(set(months)):
                    sel = decided & (months == m)
                    if sel.sum() < 500:
                        continue
                    w = round(float(100.0 * (res[sel] == 1).sum() / sel.sum()), 2)
                    entry['months'].setdefault(m, {})[side] = w
            rows.append(entry)
            print(f"TP{tp:>2}/SL{sl:>2}  تعادل {entry['breakeven']:>5.2f}%  "
                  f"عشوائي شراء {entry['buy']:>5.2f}%  عشوائي بيع {entry['sell']:>5.2f}%")
    json.dump(rows, open(out, 'w'), ensure_ascii=False, indent=1)
    print(f'\n→ {out}')


if __name__ == '__main__':
    main()
