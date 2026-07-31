"""البحث عن مرشّح يرفع نسبة الربح فوق إشارات المؤشر النهائية.

هذا هو المسار الوحيد الباقي بعد أن أُغلقت البقية:
* البحث التركيبي على المحركات — سقط خارج العيّنة (التجربة ٥٨).
* الطبقة العليا (راوتر، تصويت، مصادر M1) — بلا أثر (التجارب ٦٨ و٧١).
* التبريد — القيم الحالية قريبة من الأمثل (التجربة ٧٣).
* خطة الخروج — التكيّفية أعلى نسبة من ٤٢ خطة ثابتة (التجربة ٦٦).

يبقى: **أخذ إشارات المؤشر كما هي وحجب أسوأها.** كل مرشّح يُختار من فترة التدريب
ويُحكم عليه بفترة الاختبار وحدها، والمعيار الفائض على خط أساس نفس الفترة لا النسبة.

    python3 filtersearch.py [TRAIN_END]
"""
import sys, json, numpy as np
import simcore, lab, methods

TRAIN_END = sys.argv[1] if len(sys.argv) > 1 else '2026-05-01'
MIN_TEST_PERDAY = 20.0          # لا تُقبل تركيبة تنزل بالعدد تحت شرط ٣٠ صفقة/يوم كثيراً

print('تحميل...', flush=True)
D = simcore.load()
O = simcore.outcomes(D)
TRAIN = D['date'] < TRAIN_END
TEST = ~TRAIN
print('شموع %d | تدريب %d شمعة | اختبار %d شمعة' % (D['n'], TRAIN.sum(), TEST.sum()), flush=True)

base = simcore.simulate(D, O)
for nm, sel in (('تدريب', TRAIN), ('اختبار', TEST)):
    r = simcore.report(D, O, base, nm, sel)
    print('  الأساس %-7s: %d صفقة (%.1f/يوم) | %.2f%% | صافي %+.0f | فائض %+.2f'
          % (nm, r['n'], r['perday'], r['wr'], r['net'], r['excess']), flush=True)

print('بناء الخصائص...', flush=True)
Dl = lab.load()
for k in ('t', 'o', 'h', 'l', 'c', 'v', 'sp', 'hour', 'dow', 'gap'):
    Dl[k] = Dl[k][:D['n']]
Dl['n'] = D['n']
_, F = methods.all_features(Dl, lab.features(Dl))
F = {k: np.nan_to_num(v, nan=0.0, posinf=0.0, neginf=0.0) for k, v in F.items()
     if np.asarray(v).shape == (D['n'],)}
print('خصائص: %d' % len(F), flush=True)

cands = []
for name, arr in F.items():
    finite = arr[np.isfinite(arr)]
    if finite.size < 1000: continue
    qs = np.percentile(finite, [10, 20, 30, 40, 50, 60, 70, 80, 90])
    for q, lvl in zip(qs, (10, 20, 30, 40, 50, 60, 70, 80, 90)):
        cands.append((name, '>', float(q), lvl))
        cands.append((name, '<', float(q), lvl))
print('مرشّحات مقترحة: %d' % len(cands), flush=True)

rows = []
for i, (name, op, thr, lvl) in enumerate(cands):
    g = (F[name] > thr) if op == '>' else (F[name] < thr)
    T = simcore.simulate(D, O, gate=g)
    tr = simcore.report(D, O, T, 'tr', TRAIN)
    if not tr or tr['n'] < 300: continue
    te = simcore.report(D, O, T, 'te', TEST)
    if not te or te['perday'] < MIN_TEST_PERDAY: continue
    rows.append(dict(f=name, op=op, thr=thr, lvl=lvl,
                     tr_n=tr['n'], tr_wr=tr['wr'], tr_ex=tr['excess'], tr_net=tr['net'],
                     te_n=te['n'], te_wr=te['wr'], te_ex=te['excess'], te_net=te['net'],
                     te_pd=te['perday'], te_per=te['per']))
    if (i + 1) % 200 == 0:
        print('  ... %d/%d، ناجية %d' % (i + 1, len(cands), len(rows)), flush=True)

rows.sort(key=lambda r: -r['tr_ex'])
json.dump(rows, open('filtersearch_out.json', 'w'), indent=1)
print('\n╔═══ أعلى ٢٥ بفائض التدريب — والحكم في عمود الاختبار ═══')
print('║ %-24s %4s %9s %8s %8s %8s %8s %8s %8s' %
      ('المرشّح', 'عتبة', 'تدريب ن', 'ربح%', 'فائض', 'اختبار ن', 'ربح%', 'فائض', '/يوم'))
print('╟' + '─' * 100)
for r in rows[:25]:
    print('║ %-24s %s%-3d %9d %7.2f%% %+8.2f %8d %7.2f%% %+8.2f %8.1f'
          % (r['f'], r['op'], r['lvl'], r['tr_n'], r['tr_wr'], r['tr_ex'],
             r['te_n'], r['te_wr'], r['te_ex'], r['te_pd']))
print('╚' + '═' * 100)

sur = [r for r in rows if r['tr_ex'] > 0.5 and r['te_ex'] > 0.5]
print('\nصمدت في الفترتين (فائض > +٠.٥ في كلٍّ منهما): %d من %d' % (len(sur), len(rows)))
for r in sorted(sur, key=lambda x: -x['te_ex'])[:12]:
    print('  %-24s %s%-3d | تدريب %+5.2f → اختبار %+5.2f | %d صفقة (%.1f/يوم) صافي %+.0f'
          % (r['f'], r['op'], r['lvl'], r['tr_ex'], r['te_ex'], r['te_n'], r['te_pd'], r['te_net']))
