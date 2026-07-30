"""يقارن نسخ SYR30 عبر كل النوافذ الزمنية، لا عبر نافذة واحدة.

    python3 research/tools/compare.py [مجلد النتائج] [النسخة المرجعية]

الحكم على أي تعديل = في كم نافذة مستقلة تفوّق على المؤشر كما هو.
تعديل يكسب في نافذة واحدة من سبع = ضوضاء، مهما كان حجم المكسب فيها.
"""
import glob
import json
import os
import sys


def load(folder):
    out = {}
    for path in sorted(glob.glob(os.path.join(folder, '*.json'))):
        if path.endswith('_trades.json'):
            continue
        d = json.load(open(path))
        out[d['variant']] = d
    return out


def table(variants, base_name, window_key, title):
    base = variants[base_name]
    windows = [w['window'] for w in base[window_key]]
    names = [n for n in variants if n != base_name]

    print(f'\n### {title} — نسبة الفوز٪ (النقاط لكل صفقة)\n')
    head = f"{'النافذة':<12}{base_name:>26}"
    for n in names:
        head += f'{n:>26}'
    print(head)
    for w in windows:
        b = next((x for x in base[window_key] if x['window'] == w), None)
        if not b or b['trades'] < 20:      # نافذة أصغر من ٢٠ صفقة لا تحتمل استنتاجاً
            continue
        line = f"{w:<12}{b['win_rate']:>10.2f}% ({b['per_trade']:>+7.2f}) "
        for n in names:
            v = next((x for x in variants[n][window_key] if x['window'] == w), None)
            line += f"{v['win_rate']:>10.2f}% ({v['per_trade']:>+7.2f}) " if v else f"{'—':>21} "
        print(line)

    print(f'\n**عدد النوافذ التي تفوّقت فيها كل نسخة على «{base_name}» (من حيث النقاط لكل صفقة):**')
    for n in names:
        wins = total = 0
        for w in windows:
            b = next((x for x in base[window_key] if x['window'] == w), None)
            v = next((x for x in variants[n][window_key] if x['window'] == w), None)
            if not b or not v or b['trades'] < 20:
                continue
            total += 1
            wins += v['per_trade'] > b['per_trade']
        print(f'  {n:<26} {wins}/{total}')


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else 'research/results/ab'
    base_name = sys.argv[2] if len(sys.argv) > 2 else 'A_baseline'
    variants = load(folder)
    if base_name not in variants:
        raise SystemExit(f'النسخة المرجعية {base_name} غير موجودة في {folder}')

    print('## الست شهور كاملة\n')
    print(f"{'النسخة':<26}{'صفقات':>8}{'فوز٪':>9}{'صافي':>10}{'نقطة/صفقة':>12}{'/يوم':>8}")
    for n, d in sorted(variants.items()):
        a = d['all']
        print(f"{n:<26}{a['trades']:>8}{a['win_rate']:>9.2f}{a['net_points']:>10.0f}"
              f"{a['per_trade']:>12.3f}{a['per_day']:>8.1f}")

    table(variants, base_name, 'months', 'شهرياً')
    table(variants, base_name, 'weeks', 'أسبوعياً')


if __name__ == '__main__':
    main()
