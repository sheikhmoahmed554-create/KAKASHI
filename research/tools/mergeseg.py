"""يدمج نتائج المقاطع الخمسة في صورة واحدة، مع تفصيل «مين فتح الصفقة».

    python3 research/tools/mergeseg.py research/results/seg/base_s*.json

تقسيم الست شهور على خمس عمليات متوازية يعطي النتيجة في خُمس الوقت، وكل مقطع
يأخذ ٥٠٠٠ شمعة إحماء قبل بدايته حتى تكون حالة المؤشر الداخلية جاهزة.
"""
import datetime
import glob
import gzip
import json
import sys
from collections import defaultdict

FIELDS = ['entry_time', 'side', 'outcome', 'points', 'target', 'stop',
          'source', 'source_code', 'kind', 'entry_price', 'exit_time']


def load(paths):
    trades = []
    for p in sorted(paths):
        gz = p.replace('.json', '_trades.json.gz')
        for row in json.loads(gzip.open(gz).read()):
            trades.append(dict(zip(FIELDS, row)))
    # المقاطع قد تتداخل عند حدودها: نميّز الصفقة بوقت دخولها
    seen, out = set(), []
    for t in sorted(trades, key=lambda x: x['entry_time']):
        if t['entry_time'] in seen:
            continue
        seen.add(t['entry_time'])
        out.append(t)
    return out


def stat(rows):
    if not rows:
        return None
    wins = sum(1 for t in rows if t['outcome'] == 'WIN')
    net = sum(float(t['points'] or 0) for t in rows)
    days = len({t['entry_time'][:10] for t in rows})
    return dict(trades=len(rows), win_rate=round(100.0 * wins / len(rows), 2),
                net_points=round(net, 1), per_trade=round(net / len(rows), 3),
                per_day=round(len(rows) / days, 1) if days else 0)


def by(rows, key):
    g = defaultdict(list)
    for t in rows:
        g[key(t)].append(t)
    return {k: stat(v) for k, v in sorted(g.items())}


def main():
    paths = sys.argv[1:] or glob.glob('research/results/seg/*.json')
    trades = load(paths)
    print(f'{len(trades)} صفقة من {len(paths)} مقطع\n')
    a = stat(trades)
    print(f"الإجمالي: {a['trades']} صفقة • {a['win_rate']}% • {a['per_trade']:+} نقطة/صفقة • "
          f"{a['per_day']}/يوم • صافي {a['net_points']:+}\n")

    print('### مين فتح الصفقة\n')
    print(f"{'المصدر':<18}{'صفقات':>7}{'حصة':>8}{'فوز٪':>8}{'نقطة/صفقة':>12}{'صافي':>10}")
    src = by(trades, lambda t: t['source'] or 'غير معروف')
    for k, s in sorted(src.items(), key=lambda x: -x[1]['trades']):
        print(f"{k:<18}{s['trades']:>7}{100.0 * s['trades'] / len(trades):>7.1f}%"
              f"{s['win_rate']:>8.2f}{s['per_trade']:>+12.3f}{s['net_points']:>+10.0f}")

    print('\n### كل مصدر شهرياً — نقطة لكل صفقة (عدد الصفقات)\n')
    months = sorted({t['entry_time'][:7] for t in trades})
    print(f"{'المصدر':<18}" + ''.join(f'{m[-2:]:>16}' for m in months))
    for k in sorted(src, key=lambda x: -src[x]['trades']):
        row = f'{k:<18}'
        for m in months:
            s = stat([t for t in trades if t['source'] == k and t['entry_time'][:7] == m])
            row += f"{s['per_trade']:>+9.2f}({s['trades']:>4})" if s else f"{'—':>16}"
        print(row)

    json.dump({'all': a, 'by_source': src,
               'by_month': by(trades, lambda t: t['entry_time'][:7])},
              open('research/results/merged_attribution.json', 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
