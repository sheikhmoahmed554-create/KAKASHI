"""مسح خطة الهدف/الوقف: يأخذ دخولات إعداد جاهز ويعيد محاكاتها بخطط ثابتة مختلفة.

    python3 planscan.py A_baseline T_3.2_15 ...

القيد: الهدف >= 30 نقطة، والوقف <= الهدف + 20.  صفقة واحدة فقط، ووقف زمني 30 شمعة.
"""
import json, csv, sys, numpy as np
PU = 0.1; MAXBARS = 30
R = list(csv.DictReader(open('vault.csv')))
H = np.array([float(r['high']) for r in R]); L = np.array([float(r['low']) for r in R])
C = np.array([float(r['close']) for r in R]); N = len(R)
DAYS = N / 1440.0


def sim(i0, buy, tp, sl):
    ep = C[i0]
    tpp = ep + (tp * PU if buy else -tp * PU)
    slp = ep - (sl * PU if buy else -sl * PU)
    end = min(i0 + 1 + MAXBARS, N)
    for j in range(i0 + 1, end):
        if (L[j] <= slp) if buy else (H[j] >= slp): return 'SL', -sl, j - i0
        if (H[j] >= tpp) if buy else (L[j] <= tpp): return 'TP', tp, j - i0
    if end > i0 + 1:
        j = end - 1
        return 'TIME', ((C[j] - ep) / PU if buy else (ep - C[j]) / PU), j - i0
    return None, None, None


def run(entries, tp, sl):
    hit = miss = tw = tl = 0; busy = -1; net = 0.0; dur = []
    for i, side in entries:
        if i <= busy or i >= N - 1: continue
        k, p, b = sim(i, side > 0, tp, sl)
        if k is None: continue
        busy = i + b; net += p; dur.append(b)
        if k == 'TP': hit += 1
        elif k == 'SL': miss += 1
        elif p > 0: tw += 1
        else: tl += 1
    tot = hit + miss + tw + tl
    return tot, hit, miss, tw, tl, net, (np.mean(dur) if dur else 0)


PLANS = []
for tp in (30, 35, 40, 45, 50, 55, 60):
    for extra in (-10, 0, 5, 10, 15, 20):
        sl = tp + extra
        if sl < 10: continue
        PLANS.append((tp, sl))

for cfg in sys.argv[1:]:
    d = json.load(open('ab/%s.out.json' % cfg))
    entries = [(e[0], e[1]) for e in d['entries']]
    print('\n╔═══ %s   (%d إشارة خام)' % (cfg, len(entries)))
    print('║ %5s %5s %8s %7s %7s %8s %9s %8s %9s %7s' %
          ('هدف', 'وقف', 'صفقات', 'هدف✔', 'وقف✘', 'ربح%', 'تعادل%', 'صافي', 'لكل صفقة', 'دقيقة'))
    print('╟' + '─' * 92)
    best = []
    for tp, sl in PLANS:
        tot, hit, miss, tw, tl, net, dur = run(entries, tp, sl)
        if not tot: continue
        wr = 100 * (hit + tw) / tot
        be = 100 * sl / (tp + sl)
        best.append((net, tp, sl, tot, hit, miss, wr, be, net / tot, dur))
    for net, tp, sl, tot, hit, miss, wr, be, per, dur in sorted(best, key=lambda x: -x[0]):
        mark = ' ★' if wr > be else ''
        print('║ %5d %5d %8d %7d %7d %7.2f%% %8.2f%% %+9.0f %+8.2f %7.1f%s' %
              (tp, sl, tot, hit, miss, wr, be, net, per, dur, mark))
    print('╚' + '═' * 92)
