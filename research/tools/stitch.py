"""يدمج قطع الاستخراج الأربع في own_extract.json واحد.

كل قطعة شُغّلت بتسخين ١٢٠٠٠ شمعة تُقصّ عند الدمج، فالسلاسل المحفوظة كلها
تأتي من مناطق سخّن فيها المؤشر مؤشراته الدوّارة بالكامل.
"""
import json, csv, sys

plan = json.load(open('chunkplan.json'))
KEYS = ['xBuy', 'xSell', 'xTgtB', 'xStpB', 'xTgtS', 'xStpS']
out = {k: [] for k in KEYS}
for k, rs, ke, warm, keep in plan:
    d = json.load(open('own_c%d.json' % k))
    assert d['bars'] == ke - rs, 'قطعة %d: شموع %d متوقّع %d' % (k, d['bars'], ke - rs)
    for key in KEYS:
        out[key] += d['extra'][key][warm:]
    print('قطعة %d: أضيف %d قيمة (المجموع %d)' % (k, keep, len(out['xBuy'])))

N = len(out['xBuy'])
nrows = sum(1 for _ in csv.DictReader(open('vault.csv')))
assert N == nrows, 'الطول %d لا يطابق %d صفاً' % (N, nrows)
json.dump({'bars': N, 'extra': out, 'log': [], 'stitched': True},
          open('own_extract.json', 'w'))
print('اتحفظ own_extract.json — %d شمعة، إشارات شراء %d / بيع %d'
      % (N, sum(out['xBuy']), sum(out['xSell'])))
