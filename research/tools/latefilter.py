"""قياس مرشّح «الدخول المتأخر»: احجب الإشارة إذا كان السعر قد تحرّك في اتجاهها مسبقاً.

التشخيص أعطى منحنى رتيباً نظيفاً على حركة آخر ٥ شموع بوحدات ATR:
  تحرّك ضدّنا (نشتري هبوطاً / نبيع صعوداً) → ٦٢–٦٣٪
  تحرّك معنا ١.٥–٣ ATR                    → ٥٤.٦٨٪
  تحرّك معنا أكثر من ٣ ATR                → ٤٨.٤٤٪

هنا نمسح العتبة، ونفصل الشهور، لنرى إن كان الأثر ثابتاً أم صدفة فترة.

    python3 latefilter.py own_fixboth.json
"""
import json, csv, sys, numpy as np

PU = 0.1
R = list(csv.DictReader(open('vault.csv')))
d = json.load(open(sys.argv[1] if len(sys.argv) > 1 else 'own_fixboth.json'))
R = R[:d['bars']]
N = len(R)
H = np.array([float(r['high']) for r in R]); L = np.array([float(r['low']) for r in R])
C = np.array([float(r['close']) for r in R])
MO = np.array([r['time'][:7] for r in R])
DAYS = len(set(r['time'][:10] for r in R))


def rma(x, n):
    a = np.empty_like(x); a[0] = x[:n].mean(); k = 1.0 / n
    for i in range(1, len(x)): a[i] = a[i - 1] + k * (x[i] - a[i - 1])
    return a


tr = np.maximum(H - L, np.maximum(np.abs(H - np.roll(C, 1)), np.abs(L - np.roll(C, 1))))
tr[0] = H[0] - L[0]
ATR = rma(tr, 14) / PU                       # بالنقاط

T = [(int(eb), int(sd), int(w), float(tg), float(st))
     for eb, xb, sd, w, tg, st, sc in d['log'] if int(eb) < N]
EB = np.array([t[0] for t in T]); SD = np.array([t[1] for t in T])
W = np.array([t[2] for t in T]); TG = np.array([t[3] for t in T]); ST = np.array([t[4] for t in T])
PTS = np.where(W == 1, TG, -ST)


def premove(nb):
    j = np.maximum(EB - nb, 0)
    mv = (C[EB] - C[j]) / PU * SD
    return mv / np.maximum(ATR[EB], 1e-9)


print('%s — %d صفقة | %d يوم | الأساس %.2f%% وصافي %+.0f\n'
      % (sys.argv[1] if len(sys.argv) > 1 else 'own_fixboth.json',
         len(T), DAYS, 100 * W.mean(), PTS.sum()))

print('══ مسح العتبة: احجب إذا كانت حركة آخر N شمعة في اتجاه الإشارة ≥ العتبة')
print('%4s %8s %9s %8s %8s %10s %10s %9s' %
      ('N', 'العتبة', 'محجوبة', 'باقية', '/يوم', 'نسبة الربح', 'صافي', 'المحجوبة%'))
print('─' * 76)
best = []
for nb in (3, 5, 10, 15):
    pm = premove(nb)
    for thr in (0.2, 0.4, 0.6, 0.8, 1.0, 1.5, 2.0, 3.0):
        keep = pm < thr
        if keep.sum() < 1500: continue
        wr = 100 * W[keep].mean(); net = PTS[keep].sum()
        blk = ~keep
        print('%4d %8.1f %9d %8d %8.1f %9.2f%% %+10.0f %8.2f%%' %
              (nb, thr, blk.sum(), keep.sum(), keep.sum() / DAYS, wr, net,
               100 * W[blk].mean() if blk.sum() else 0))
        best.append((nb, thr, keep, wr, net))
print()

# الاستقرار الشهري لأفضل ثلاث عتبات بالصافي
print('══ الاستقرار الشهري لأفضل ثلاث عتبات')
for nb, thr, keep, wr, net in sorted(best, key=lambda x: -x[4])[:3]:
    print('  ── حركة %d شمعة < %.1f ATR   (%d صفقة، %.2f%%، صافي %+.0f)'
          % (nb, thr, keep.sum(), wr, net))
    print('     %-9s %7s %7s %9s %9s %9s' % ('الشهر', 'قبل', 'بعد', 'نسبة قبل', 'نسبة بعد', 'الفرق'))
    for mo in sorted(set(MO[EB])):
        m = MO[EB] == mo
        if m.sum() < 100: continue
        a = 100 * W[m].mean()
        b = 100 * W[m & keep].mean() if (m & keep).sum() >= 30 else float('nan')
        print('     %-9s %7d %7d %8.2f%% %8.2f%% %+9.2f'
              % (mo, m.sum(), (m & keep).sum(), a, b, b - a))
    print()

print('ملاحظة منهجية: هذا حذف من سجل الصفقات المنفَّذة فقط. الحجب الحقيقي يحرّر المركز')
print('فتدخل إشارات أخرى مكانها، والعدد النهائي سيكون أعلى. القياس الدقيق ينتظر')
print('انتهاء تشغيلة الاستخراج ثم إعادة المحاكاة الكاملة بـsimcore.')
