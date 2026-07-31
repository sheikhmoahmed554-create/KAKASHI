"""كم صفقة يشطبها MSameCandleRule="Skip"، وكم يرفع ذلك نسبة الربح المعروضة؟

المؤشر يحذف من الإحصاء أي صفقة لمست شمعةٌ واحدة فيها الهدف والوقف معاً.
هذه الصفقات تقع فعلاً في السوق، والوسيط ينفّذ الوقف فيها غالباً.
هنا نعدّها بالطريقتين ونرى الفرق.

    python3 skipscan.py A_baseline [TP SL]
"""
import json, csv, sys, numpy as np
PU = 0.1
R = list(csv.DictReader(open('vault.csv')))
H = [float(r['high']) for r in R]; L = [float(r['low']) for r in R]
C = [float(r['close']) for r in R]; N = len(R)

cfg = sys.argv[1]
FIXED = (float(sys.argv[2]), float(sys.argv[3])) if len(sys.argv) > 3 else None
d = json.load(open('ab/%s.out.json' % cfg))
DAYS = len(set(r['time'][:10] for r in R[:d['bars']]))


def sim(i0, buy, tp, sl):
    """يرجع نوع الخروج: TP نقي / SL نقي / BOTH نفس الشمعة."""
    ep = C[i0]
    tpp = ep + (tp * PU if buy else -tp * PU)
    slp = ep - (sl * PU if buy else -sl * PU)
    for j in range(i0 + 1, N):
        ht = (H[j] >= tpp) if buy else (L[j] <= tpp)
        hs = (L[j] <= slp) if buy else (H[j] >= slp)
        if ht and hs: return 'BOTH', j - i0
        if hs: return 'SL', j - i0
        if ht: return 'TP', j - i0
    return None, None


hit = miss = both = 0
busy = -1; tgts = []; stps = []
for e in d['entries']:
    i, side, tgt, stp = e[0], e[1], e[2], e[3]
    tp, sl = FIXED if FIXED else (tgt, stp)
    if i <= busy or i >= N - 1 or not (tp > 0 and sl > 0): continue
    k, b = sim(i, side > 0, tp, sl)
    if k is None: continue
    busy = i + b; tgts.append(tp); stps.append(sl)
    if k == 'TP': hit += 1
    elif k == 'SL': miss += 1
    else: both += 1

at, as_ = np.mean(tgts), np.mean(stps)
be = 100 * as_ / (at + as_)
print('%s — خطة %s | متوسط هدف %.1f / وقف %.1f | تعادل %.2f%%'
      % (cfg, 'ثابتة %.0f/%.0f' % FIXED if FIXED else 'المؤشر', at, as_, be))
print()
print('  هدف نقي              : %d' % hit)
print('  وقف نقي              : %d' % miss)
print('  الاثنان بنفس الشمعة  : %d' % both)
print('  ─────────────────────────────────')
tot_skip = hit + miss
print('  ① كما يعرضها المؤشر (Skip — يحذفها):')
print('       صفقات %d | ربح %d | خسارة %d | نسبة %.2f%% | صافي %+.0f'
      % (tot_skip, hit, miss, 100 * hit / tot_skip, hit * at - miss * as_))
tot = hit + miss + both
print('  ② الواقع المتشائم (الوقف يُنفَّذ أولاً — ما يفعله الوسيط):')
print('       صفقات %d | ربح %d | خسارة %d | نسبة %.2f%% | صافي %+.0f'
      % (tot, hit, miss + both, 100 * hit / tot, hit * at - (miss + both) * as_))
print('  ③ الواقع المتفائل (الهدف أولاً):')
print('       صفقات %d | ربح %d | خسارة %d | نسبة %.2f%% | صافي %+.0f'
      % (tot, hit + both, miss, 100 * (hit + both) / tot, (hit + both) * at - miss * as_))
print()
print('  الفجوة بين ① و② : %.2f نقطة مئوية  (%d صفقة محذوفة = %.1f%% من الكل، %.1f/يوم)'
      % (100 * hit / tot_skip - 100 * hit / tot, both, 100 * both / tot, both / DAYS))
