"""يعرض كل صفقة فتحها المؤشر ومعها سياق السوق عندها — «مين فتحها وليش».

    PYTHONPATH=research/tools python3 research/tools/audit.py research/results/seg/base_s*.json

يقسم الصفقات إلى مبرَّرة وغير مبرَّرة حسب قواعد التداول الأساسية، ويقيس أداء
كل مصدر **داخل سياقه الصحيح** بدل قياسه على السوق كله. أداة الارتداد تُقاس في
الارتداد، وأداة الاتجاه تُقاس في الاتجاه — وهذا ما لم يُفعل من قبل.
"""
import datetime
import glob
import gzip
import json
import sys
from collections import defaultdict

import numpy as np

import combolab as L
import context as CX
import styles as ST

FIELDS = ['entry_time', 'side', 'outcome', 'points', 'target', 'stop',
          'source', 'source_code', 'kind', 'entry_price', 'exit_time']


def load_trades(paths):
    seen, out = set(), []
    for p in sorted(paths):
        gz = p.replace('.json', '_trades.json.gz')
        for row in json.loads(gzip.open(gz).read()):
            t = dict(zip(FIELDS, row))
            if t['entry_time'] in seen:
                continue
            seen.add(t['entry_time'])
            out.append(t)
    return sorted(out, key=lambda x: x['entry_time'])


def stat(rows):
    if not rows:
        return None
    wins = sum(1 for t in rows if t['outcome'] == 'WIN')
    net = sum(float(t['points'] or 0) for t in rows)
    return dict(n=len(rows), wr=round(100.0 * wins / len(rows), 2),
                per=round(net / len(rows), 3), net=round(net))


def main():
    paths = sys.argv[1:] or glob.glob('research/results/seg/base_s*.json')
    D = L.load_candles()
    F = ST.features(D)
    C = CX.build(D, F)
    idx_of = {int(d.replace(tzinfo=datetime.timezone.utc).timestamp()): i
              for i, d in enumerate(D['dt'])}

    trades = load_trades(paths)
    rows = []
    for t in trades:
        ts = int(datetime.datetime.fromisoformat(t['entry_time'].replace('Z', '+00:00')).timestamp())
        i = idx_of.get(ts)
        if i is None:
            continue
        side = 1 if t['side'] == 'BUY' else -1
        reason, ok = CX.why(C, i, side)
        rows.append({**t, 'bar': i, 'label': C['label'][i], 'reason': reason, 'justified': ok})
    print(f'{len(rows)} صفقة مطابَقة بالشموع\n')

    just = [r for r in rows if r['justified']]
    unjust = [r for r in rows if not r['justified']]
    a, b = stat(just), stat(unjust)
    print('### الصفقات المبرَّرة مقابل غير المبرَّرة\n')
    print(f"{'':<14}{'صفقات':>7}{'حصة':>8}{'فوز٪':>8}{'نقطة/صفقة':>12}{'صافي':>9}")
    for name, s in (('مبرَّرة', a), ('غير مبرَّرة', b)):
        if s:
            print(f"{name:<14}{s['n']:>7}{100.0 * s['n'] / len(rows):>7.1f}%{s['wr']:>8.2f}"
                  f"{s['per']:>+12.3f}{s['net']:>+9}")

    print('\n### حالة السوق عند الدخول\n')
    print(f"{'الحالة':<20}{'صفقات':>7}{'شراء':>7}{'بيع':>7}{'فوز٪':>8}{'نقطة/صفقة':>12}")
    g = defaultdict(list)
    for r in rows:
        g[r['label']].append(r)
    for k, v in sorted(g.items(), key=lambda x: -len(x[1])):
        s = stat(v)
        nb = sum(1 for x in v if x['side'] == 'BUY')
        print(f"{k:<20}{s['n']:>7}{nb:>7}{s['n'] - nb:>7}{s['wr']:>8.2f}{s['per']:>+12.3f}")

    print('\n### كل مصدر: داخل سياقه وخارجه\n')
    print(f"{'المصدر':<18}{'مبرَّرة':>26}{'غير مبرَّرة':>26}")
    print(f"{'':<18}{'عدد':>8}{'فوز٪':>8}{'نقطة':>10}{'عدد':>8}{'فوز٪':>8}{'نقطة':>10}")
    src = defaultdict(list)
    for r in rows:
        src[r['source']].append(r)
    for k, v in sorted(src.items(), key=lambda x: -len(x[1])):
        sj, su = stat([x for x in v if x['justified']]), stat([x for x in v if not x['justified']])
        line = f'{k:<18}'
        line += f"{sj['n']:>8}{sj['wr']:>8.2f}{sj['per']:>+10.2f}" if sj else f"{'—':>26}"
        line += f"{su['n']:>8}{su['wr']:>8.2f}{su['per']:>+10.2f}" if su else f"{'—':>26}"
        print(line)

    print('\n### عيّنة من الصفقات غير المبرَّرة الخاسرة — «ليششش؟»\n')
    bad = [r for r in unjust if r['outcome'] == 'LOSS']
    for r in bad[:12]:
        print(f"  {r['entry_time'][:16]}  {r['side']:<4} {r['source']:<14} "
              f"{r['label']:<16} خسارة {r['points']:>6} — {r['reason']}")

    json.dump({'justified': a, 'unjustified': b,
               'by_label': {k: stat(v) for k, v in g.items()},
               'by_source': {k: {'justified': stat([x for x in v if x['justified']]),
                                 'unjustified': stat([x for x in v if not x['justified']])}
                             for k, v in src.items()}},
              open('research/results/audit.json', 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
