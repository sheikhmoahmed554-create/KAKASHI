"""مسح خطة الهدف/الوقف على صفقات المؤشر الفعلية (من ownstats) لا على إشارات خام.

الدرس المثبت (تجربة ٤٩): الخطة تحرّك النتيجة أكثر من الدخول. وقد ثبت أن جانب البيع
هو صاحب الفائض الحقيقي (+٢.٦١، ٧ من ٧ أشهر)، فالسؤال الآن: هل خطته التكيّفية
٣٦.٩/٥٤.٨ هي الأفضل له، أم أن هدفاً أكبر يدفع أكثر؟

القيد المطلوب: الهدف ٣٠–٦٠ • الوقف ≤ الهدف+٢٠ • صفقة واحدة • وقف زمني ٣٠ شمعة.

    python3 planscan2.py own_fixboth.json [SELL|BUY|ALL]
"""
import json, csv, sys, numpy as np
PU = 0.1; MAXBARS = 30
R = list(csv.DictReader(open('vault.csv')))
H = [float(r['high']) for r in R]; L = [float(r['low']) for r in R]
C = [float(r['close']) for r in R]; N = len(R)

path = sys.argv[1]
want = sys.argv[2] if len(sys.argv) > 2 else 'SELL'
d = json.load(open(path))
off = N - d['bars']
DAYS = len(set(r['time'][:10] for r in R[off:]))

ent = []
for eb, xb, side, win, tgt, stp, src in d['log']:
    if want == 'SELL' and side > 0: continue
    if want == 'BUY' and side < 0: continue
    ent.append((off + int(eb), int(side), float(tgt), float(stp)))
ent.sort()
print('%s — %s: %d دخول، %d يوم تداول' % (path, want, len(ent), DAYS))


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


def run(tp, sl):
    hit = miss = tw = tl = 0; busy = -1; net = 0.0; dur = 0
    for i, side, t0, s0 in ent:
        a, b_ = (t0, s0) if tp is None else (tp, sl)
        if i <= busy or i >= N - 1 or not (a > 0 and b_ > 0): continue
        k, p, b = sim(i, side > 0, a, b_)
        if k is None: continue
        busy = i + b; net += p; dur += b
        if k == 'TP': hit += 1
        elif k == 'SL': miss += 1
        elif p > 0: tw += 1
        else: tl += 1
    tot = hit + miss + tw + tl
    return tot, hit, miss, tw, tl, net, dur / max(tot, 1)


rows = []
for tp in (None, 30, 35, 40, 45, 50, 55, 60):
    for extra in ([0] if tp is None else (-10, 0, 5, 10, 15, 20)):
        sl = None if tp is None else tp + extra
        if sl is not None and sl < 15: continue
        tot, hit, miss, tw, tl, net, dur = run(tp, sl)
        if not tot: continue
        wr = 100 * (hit + tw) / tot
        be = 100 * sl / (tp + sl) if tp else None
        rows.append((net, tp, sl, tot, hit, miss, wr, be, net / tot, dur, tot / DAYS))

print('%7s %6s %8s %7s %7s %8s %9s %10s %9s %7s %7s' %
      ('هدف', 'وقف', 'صفقات', 'هدف✔', 'وقف✘', 'ربح%', 'تعادل%', 'صافي', 'لكل صفقة', '/يوم', 'دقيقة'))
print('─' * 96)
for net, tp, sl, tot, hit, miss, wr, be, per, dur, pd in sorted(rows, key=lambda x: -x[0]):
    lbl = 'التكيّفية' if tp is None else str(tp)
    sll = '—' if sl is None else str(sl)
    bes = '—' if be is None else '%.2f%%' % be
    star = ' ★' if be is not None and wr > be else ''
    print('%7s %6s %8d %7d %7d %7.2f%% %9s %+10.0f %+9.2f %7.1f %7.1f%s' %
          (lbl, sll, tot, hit, miss, wr, bes, net, per, pd, dur, star))
