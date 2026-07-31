"""تشخيص الشكاوى الثلاث لصاحب المؤشر، كل واحدة برقم:

  ١ ــ «يدخل متأخر»  : كم تحرّك السعر في اتجاه الإشارة *قبل* الدخول؟
  ٢ ــ «يدخل بكير»   : كم يذهب السعر ضدّنا بعد الدخول قبل أن يعود؟ (MAE)
  ٣ ــ «زخم قوي فجأة يهبط الأداء» : نسبة الربح مقابل نسبة ATR الحالية إلى متوسطها.

الثالثة تخصّ `sfAtrRatio` الذي يستعمله `sfBlock` — وهو مرشّح موجود ومفعّل في المؤشر
(`sfUseAtrFilter=true`, `sfAtrMaxRatio=2.8`) لكنه كان متجاوَزاً بأسطر OR قبل الإصلاح.

    python3 diagnose.py own_fixboth.json
"""
import json, csv, sys, numpy as np

PU = 0.1
R = list(csv.DictReader(open('vault.csv')))
d = json.load(open(sys.argv[1] if len(sys.argv) > 1 else 'own_fixboth.json'))
R = R[:d['bars']]
N = len(R)
H = np.array([float(r['high']) for r in R]); L = np.array([float(r['low']) for r in R])
C = np.array([float(r['close']) for r in R])


def rma(x, n):
    a = np.empty_like(x); a[0] = x[:n].mean()
    k = 1.0 / n
    for i in range(1, len(x)): a[i] = a[i - 1] + k * (x[i] - a[i - 1])
    return a


tr = np.maximum(H - L, np.maximum(np.abs(H - np.roll(C, 1)), np.abs(L - np.roll(C, 1))))
tr[0] = H[0] - L[0]
ATR14 = rma(tr, 14)
ATR240 = np.convolve(ATR14, np.ones(240) / 240, mode='full')[:N]
ATR240[:240] = ATR14[:240]
RATIO = ATR14 / np.maximum(ATR240, 1e-9)

T = [(int(eb), int(xb), int(sd), int(w), float(tg), float(st))
     for eb, xb, sd, w, tg, st, sc in d['log'] if int(eb) < N]
print('%s — %d صفقة على %d شمعة\n' % (sys.argv[1] if len(sys.argv) > 1 else 'own_fixboth.json', len(T), N))


def buckets(vals, wins, edges, title, unit=''):
    print('══ %s' % title)
    print('  %-20s %8s %8s %9s %9s' % ('الشريحة', 'صفقات', 'حصة%', 'نسبة الربح', 'الفرق'))
    print('  ' + '─' * 60)
    base = 100 * np.mean(wins)
    v = np.asarray(vals); w = np.asarray(wins)
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (v >= lo) & (v < hi)
        if m.sum() < 60: continue
        wr = 100 * w[m].mean()
        print('  %-20s %8d %7.1f%% %8.2f%% %+8.2f' %
              ('%.2f – %.2f%s' % (lo, hi, unit), m.sum(), 100 * m.sum() / len(v), wr, wr - base))
    print('  %-20s %8d %7.1f%% %8.2f%%' % ('الكل', len(v), 100.0, base))
    print()


W = np.array([t[3] for t in T])

# ── ٣ ــ الزخم المفاجئ: نسبة ATR عند الدخول ──
buckets([RATIO[t[0]] for t in T], W,
        [0, 0.7, 0.9, 1.1, 1.4, 1.8, 2.4, 3.2, 99],
        '٣ ــ الزخم المفاجئ: ATR14 ÷ متوسط ATR على ٢٤٠ شمعة، عند لحظة الدخول', '×')

# ── ١ ــ الدخول المتأخر: كم تحرّك السعر في اتجاه الإشارة قبلها ──
for nb in (5, 15, 30):
    pre = []
    for eb, xb, sd, w, tg, st in T:
        j = max(eb - nb, 0)
        mv = (C[eb] - C[j]) / PU * (1 if sd > 0 else -1)      # موجب = تحرّك معنا مسبقاً
        pre.append(mv / max(ATR14[eb] / PU, 1e-9))            # بوحدات ATR
    buckets(pre, W, [-9, -1.5, -0.7, -0.2, 0.2, 0.7, 1.5, 3.0, 9],
            '١ ــ الدخول المتأخر: حركة آخر %d شمعة في اتجاه الإشارة (بوحدات ATR)' % nb, ' ATR')

# ── ٢ ــ الدخول المبكر: أقصى حركة ضدّنا بعد الدخول (MAE) ──
mae = []; mfe = []
for eb, xb, sd, w, tg, st in T:
    a = slice(eb + 1, min(xb + 1, N))
    if a.start >= a.stop: mae.append(0.0); mfe.append(0.0); continue
    if sd > 0:
        mae.append((C[eb] - L[a].min()) / PU); mfe.append((H[a].max() - C[eb]) / PU)
    else:
        mae.append((H[a].max() - C[eb]) / PU); mfe.append((C[eb] - L[a].min()) / PU)
mae = np.array(mae); mfe = np.array(mfe)
stp = np.array([t[5] for t in T])
print('══ ٢ ــ الدخول المبكر: أقصى حركة ضدّنا قبل النتيجة (MAE)')
for lo, hi in ((0, .2), (.2, .4), (.4, .6), (.6, .8), (.8, 1.01)):
    m = (mae / stp >= lo) & (mae / stp < hi)
    if m.sum() < 60: continue
    print('  MAE %3d–%3d%% من الوقف : %5d صفقة (%4.1f%%) | نسبة الربح %.2f%%'
          % (lo * 100, hi * 100, m.sum(), 100 * m.sum() / len(T), 100 * W[m].mean()))
won = W == 1
print('  ─────────────')
print('  الرابحة  : MAE متوسط %.1f نقطة = %.0f%% من الوقف' % (mae[won].mean(), 100 * (mae[won] / stp[won]).mean()))
print('  الخاسرة  : MFE متوسط %.1f نقطة = %.0f%% من الهدف'
      % (mfe[~won].mean(), 100 * (mfe[~won] / np.array([t[4] for t in T])[~won]).mean()))
nearmiss = (~won) & (mfe >= np.array([t[4] for t in T]) * 0.8)
print('  خاسرة وصلت ٨٠%%+ من الهدف قبل أن تنعكس: %d (%.1f%% من الخاسرات)'
      % (nearmiss.sum(), 100 * nearmiss.sum() / max((~won).sum(), 1)))
