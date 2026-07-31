"""كم يكلّف الوقف الزمني؟ نفس الدخولات، حدود زمنية مختلفة.

المؤشر الأصلي لا يملك حداً زمنياً — يبقى ماسكاً حتى الهدف أو الوقف. القيد الذي
طلبه صاحب المؤشر (٣٠ دقيقة) قد يكون هو سبب الفارق بين ٥٩٪ في المختبر و٦٨٪ على
TradingView.  هذا السكربت يقيس الفارق مباشرة.

    python3 timescan.py A_baseline [TP SL]
"""
import json, csv, sys, numpy as np
PU = 0.1
R = list(csv.DictReader(open('vault.csv')))
H = [float(r['high']) for r in R]; L = [float(r['low']) for r in R]
C = [float(r['close']) for r in R]; N = len(R)

cfg = sys.argv[1]
FIXED = None
if len(sys.argv) > 3: FIXED = (float(sys.argv[2]), float(sys.argv[3]))
d = json.load(open('ab/%s.out.json' % cfg))
NB = d['bars']
DAYS = len(set(r['time'][:10] for r in R[:NB]))


def sim(i0, buy, tp, sl, maxbars):
    ep = C[i0]
    tpp = ep + (tp * PU if buy else -tp * PU)
    slp = ep - (sl * PU if buy else -sl * PU)
    end = min(i0 + 1 + maxbars, N)
    for j in range(i0 + 1, end):
        if (L[j] <= slp) if buy else (H[j] >= slp): return 'SL', -sl, j - i0
        if (H[j] >= tpp) if buy else (L[j] <= tpp): return 'TP', tp, j - i0
    if end > i0 + 1:
        j = end - 1
        return 'TIME', ((C[j] - ep) / PU if buy else (ep - C[j]) / PU), j - i0
    return None, None, None


print('%s — %d إشارة خام، %d شمعة، %d يوم تداول%s'
      % (cfg, len(d['entries']), NB, DAYS, ('، خطة ثابتة %.0f/%.0f' % FIXED) if FIXED else '، خطة المؤشر'))
print('%7s %8s %7s %7s %8s %8s %9s %9s %8s %7s' %
      ('حد/دقيقة', 'صفقات', 'هدف✔', 'وقف✘', 'وقت', 'ربح%', 'صافي', 'لكل صفقة', '/يوم', 'دقيقة'))
print('─' * 92)
for mb in (10, 20, 30, 45, 60, 120, 240, 480, 1440, 100000):
    hit = miss = tw = tl = 0; busy = -1; net = 0.0; dur = []
    for e in d['entries']:
        i, side, tgt, stp = e[0], e[1], e[2], e[3]
        tp, sl = FIXED if FIXED else (tgt, stp)
        if i <= busy or i >= N - 1 or not (tp > 0 and sl > 0): continue
        k, p, b = sim(i, side > 0, tp, sl, mb)
        if k is None: continue
        busy = i + b; net += p; dur.append(b)
        if k == 'TP': hit += 1
        elif k == 'SL': miss += 1
        elif p > 0: tw += 1
        else: tl += 1
    tot = hit + miss + tw + tl
    if not tot: continue
    wr = 100 * (hit + tw) / tot
    lbl = 'بلا حد' if mb > 5000 else str(mb)
    print('%7s %8d %7d %7d %8d %7.2f%% %+9.0f %+9.2f %8.1f %7.1f' %
          (lbl, tot, hit, miss, tw + tl, wr, net, net / tot, tot / DAYS, np.mean(dur)))
