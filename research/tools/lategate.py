"""القياس الدقيق لمرشّح الدخول المتأخر — حجب حقيقي لا حذف من السجل.

الفرق جوهري: حذف الصفقة من السجل يترك مكانها فارغاً، أما الحجب الحقيقي فيُبقي
المركز حراً فتدخل إشارة أخرى بعدها. لذلك العدد النهائي أعلى من تقدير `latefilter.py`.

    python3 lategate.py
"""
import numpy as np, simcore, json

PU = 0.1
D = simcore.load()
O = simcore.outcomes(D)
h, l, c = D['h'], D['l'], D['c']
N = D['n']


def rma(x, n):
    a = np.empty_like(x); a[0] = x[:n].mean(); k = 1.0 / n
    for i in range(1, len(x)): a[i] = a[i - 1] + k * (x[i] - a[i - 1])
    return a


tr = np.maximum(h - l, np.maximum(np.abs(h - np.roll(c, 1)), np.abs(l - np.roll(c, 1))))
tr[0] = h[0] - l[0]
ATR = np.maximum(rma(tr, 14), 1e-9)

MO = D['mo']


def show(T, label):
    r = simcore.report(D, O, T, label)
    idx = T[:, 0].astype(int)
    mos = sorted(set(MO[idx]))
    pos = 0
    for m in mos:
        s = MO[idx] == m
        if s.sum() >= 50 and T[s, 3].sum() > 0: pos += 1
    print('%-28s %6d صفقة (%.1f/يوم) | %6.2f%% | صافي %+7.0f (%+.2f/صفقة) | فائض %+5.2f | أشهر رابحة %d/%d'
          % (label, r['n'], r['perday'], r['wr'], r['net'], r['per'], r['excess'], pos, len(mos)))
    return r


print('══ الأساس (إصلاح البوابة، بلا مرشّح)')
base = simcore.simulate(D, O)
show(base, 'بلا مرشّح')
print()

print('══ مرشّح الدخول المتأخر — حجب حقيقي')
rows = []
for nb in (2, 3, 5, 8):
    mv = np.zeros(N)
    mv[nb:] = (c[nb:] - c[:-nb]) / PU
    atrp = ATR / PU
    for thr in (0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1.2):
        # الشراء يُحجب إذا صعد السعر مسبقاً، والبيع يُحجب إذا هبط مسبقاً
        gb = (mv / atrp) < thr
        gs = (-mv / atrp) < thr
        buy = D['buy'] & gb
        sell = D['sell'] & gs
        Dm = dict(D); Dm['buy'] = buy; Dm['sell'] = sell
        T = simcore.simulate(Dm, O)
        r = show(T, 'حركة %d شمعة < %.1f ATR' % (nb, thr))
        rows.append(dict(nb=nb, thr=thr, **{k: r[k] for k in ('n', 'wr', 'net', 'per', 'perday', 'excess')}))
    print()

json.dump(rows, open('lategate_out.json', 'w'), indent=1)
best = max(rows, key=lambda r: r['net'])
print('أعلى صافي: حركة %d شمعة < %.1f ATR → %d صفقة (%.1f/يوم)، %.2f%%، صافي %+.0f'
      % (best['nb'], best['thr'], best['n'], best['perday'], best['wr'], best['net']))
