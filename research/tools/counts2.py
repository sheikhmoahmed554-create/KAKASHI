"""عدّ صريح + صافي النقاط: كام صفقة ضربت الهدف، كام ضربت الوقف، نسبة الربح، والصافي."""
import json, csv, sys, numpy as np
PU = 0.1; MAXBARS = 30
R = list(csv.DictReader(open('vault.csv')))
H = [float(r['high']) for r in R]; L = [float(r['low']) for r in R]
C = [float(r['close']) for r in R]; N = len(R)
DAYS = len(set(r['time'][:10] for r in R[:60000]))   # أيام تداول فعلية في نافذة القياس


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
        pts = (C[j] - ep) / PU if buy else (ep - C[j]) / PU
        return 'TIME', pts, j - i0
    return None, None, None


rows = []
for cfg in sys.argv[1:]:
    d = json.load(open('ab/%s.out.json' % cfg))
    tp = sl = tw = tl = 0; busy = -1
    tgts = []; stps = []; durs = []; pnl = []
    for e in d['entries']:
        i, side, tgt, stp = e[0], e[1], e[2], e[3]
        if i <= busy or i >= N - 1 or not (tgt > 0 and stp > 0): continue
        k, p, b = sim(i, side > 0, tgt, stp)
        if k is None: continue
        busy = i + b
        tgts.append(tgt); stps.append(stp); durs.append(b); pnl.append(p)
        if k == 'TP': tp += 1
        elif k == 'SL': sl += 1
        elif p > 0: tw += 1
        else: tl += 1
    tot = tp + sl + tw + tl
    if not tot: continue
    wins = tp + tw
    pnl = np.array(pnl)
    gross_w = pnl[pnl > 0].sum(); gross_l = -pnl[pnl < 0].sum()
    net = pnl.sum()
    print('════ %s' % cfg)
    print('  إجمالي الصفقات        : %d   (%.1f صفقة/يوم)' % (tot, tot / DAYS))
    print('  ضربت الهدف            : %d  (%.1f%%)' % (tp, 100 * tp / tot))
    print('  ضربت الوقف            : %d  (%.1f%%)' % (sl, 100 * sl / tot))
    print('  خرجت بالوقت رابحة     : %d  (%.1f%%)' % (tw, 100 * tw / tot))
    print('  خرجت بالوقت خاسرة     : %d  (%.1f%%)' % (tl, 100 * tl / tot))
    print('  ─────────────────────────────────')
    print('  نسبة الربح            : %.2f%%   (%d رابحة / %d خاسرة)' % (100 * wins / tot, wins, tot - wins))
    print('  متوسط الهدف           : %.1f نقطة' % np.mean(tgts))
    print('  متوسط الوقف           : %.1f نقطة' % np.mean(stps))
    print('  نقطة التعادل          : %.2f%%' % (100 * np.mean(stps) / (np.mean(tgts) + np.mean(stps))))
    print('  ─────────────────────────────────')
    print('  صافي النقاط           : %+.0f نقطة  (= %+.0f دولار للّوت الواحد)' % (net, net * PU * 100))
    print('  متوسط الصفقة          : %+.2f نقطة' % (net / tot))
    print('  الربح الإجمالي        : %.0f   |  الخسارة الإجمالية: %.0f  |  عامل الربح: %.2f'
          % (gross_w, gross_l, gross_w / max(gross_l, 1e-9)))
    print('  صافي في اليوم         : %+.1f نقطة' % (net / DAYS))
    print('  متوسط مدة الصفقة      : %.1f دقيقة' % np.mean(durs))
    print()
    rows.append((cfg, tot, tp, sl, 100 * wins / tot, np.mean(tgts), net, net / tot))

if len(rows) > 1:
    print('╔' + '═' * 86)
    print('║ %-18s %7s %7s %7s %8s %8s %9s %8s' %
          ('الإعداد', 'صفقات', 'هدف', 'وقف', 'ربح%', 'م.هدف', 'صافي', 'لكل صفقة'))
    print('╟' + '─' * 86)
    for r in sorted(rows, key=lambda x: -x[6]):
        print('║ %-18s %7d %7d %7d %7.2f%% %8.1f %+9.0f %+8.2f' % r)
    print('╚' + '═' * 86)
