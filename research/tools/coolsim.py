"""محاكي التبريد خارج المتصفح — يحوّل تجربة مدّتها ٢٥ دقيقة إلى أجزاء من الثانية.

يقرأ من `own_extract.json` سلاسل لكل شمعة: الإشارة النهائية للجهتين (بعد كل أسطر OR
وبعد إصلاح البوابة)، وهدف/وقف الخطة التكيّفية لكل جهة محسوبَين بدوال المؤشر نفسها.
ثم يعيد بناء منطق الدخول كاملاً:

    canEnterLong = not active and canCooldown and canLongAfterLoss and buySignal

مع أربعة عدّادات التبريد الحيّة — وهي المفاتيح الوحيدة غير المختبرة في المؤشر.

    python3 coolsim.py            # مسح شبكي
    python3 coolsim.py 21 12 24 13   # إعداد واحد بالتفصيل
"""
import json, csv, sys, itertools, numpy as np

PU = 0.1
R = list(csv.DictReader(open('vault.csv')))
d = json.load(open('own_extract.json'))
NB = d['bars']
R = R[:NB]
H = np.array([float(r['high']) for r in R]); L = np.array([float(r['low']) for r in R])
C = np.array([float(r['close']) for r in R])
N = len(R)
DAYS = len(set(r['time'][:10] for r in R))
MO = np.array([r['time'][:7] for r in R])

X = d['extra']
BUY = np.array(X['xBuy'], bool); SELL = np.array(X['xSell'], bool)
TGB = np.array(X['xTgtB'], float); STB = np.array(X['xStpB'], float)
TGS = np.array(X['xTgtS'], float); STS = np.array(X['xStpS'], float)
print('شموع %d | %d يوم | إشارات شراء %d / بيع %d'
      % (N, DAYS, BUY.sum(), SELL.sum()), flush=True)

BI = np.flatnonzero(BUY); SI = np.flatnonzero(SELL)
CAND = np.union1d(BI, SI)


def resolve(i, buy, tp, sl):
    """يرجع (فاز، نقاط، شمعة الخروج). بلا حد زمني — كما يفعل المؤشر."""
    ep = C[i]
    tpp = ep + (tp * PU if buy else -tp * PU)
    slp = ep - (sl * PU if buy else -sl * PU)
    for j in range(i + 1, N):
        hs = (L[j] <= slp) if buy else (H[j] >= slp)
        ht = (H[j] >= tpp) if buy else (L[j] <= tpp)
        if hs and ht: return 0, -sl, j          # نفس الشمعة: الوقف أولاً (الواقع)
        if hs: return 0, -sl, j
        if ht: return 1, tp, j
    return None, None, None


def run(cd_win, cd_loss, cd_buy, cd_sell, sides='BOTH'):
    """cd_win = تبريد بعد أي صفقة • cd_loss = بعد أي خسارة •
       cd_buy/cd_sell = بعد خسارة الجهة نفسها."""
    busy_until = -1
    last_trade = last_any_stop = last_long_stop = last_short_stop = -10**9
    log = []
    for i in CAND:
        if i <= busy_until or i >= N - 1: continue
        b = BUY[i] and sides in ('BOTH', 'LONG')
        s = SELL[i] and sides in ('BOTH', 'SHORT')
        if b and s: b = True; s = False          # الشراء أولاً كما في canEnterLong
        if not (b or s): continue
        if i - last_trade < cd_win: continue
        if i - last_any_stop < cd_loss: continue
        if b and i - last_long_stop < cd_buy: continue
        if s and i - last_short_stop < cd_sell: continue
        tp, sl = (TGB[i], STB[i]) if b else (TGS[i], STS[i])
        if not (tp > 0 and sl > 0): continue
        w, p, j = resolve(i, b, tp, sl)
        if w is None: continue
        busy_until = j; last_trade = j
        if not w:
            last_any_stop = j
            if b: last_long_stop = j
            else: last_short_stop = j
        log.append((i, 1 if b else -1, w, p))
    return log


def stats(log):
    if len(log) < 50: return None
    a = np.array([(x[1], x[2], x[3]) for x in log], float)
    n = len(a); w = int(a[:, 1].sum()); net = a[:, 2].sum()
    mos = sorted(set(MO[[x[0] for x in log]]))
    per_mo = []
    idx = np.array([x[0] for x in log])
    for m in mos:
        sel = MO[idx] == m
        if sel.sum() >= 30: per_mo.append(a[sel, 2].sum())
    return dict(n=n, wr=100 * w / n, net=net, per=net / n, perday=n / DAYS,
                pos_mo=sum(1 for x in per_mo if x > 0), n_mo=len(per_mo),
                buy=int((a[:, 0] > 0).sum()), sell=int((a[:, 0] < 0).sum()))


if len(sys.argv) > 4:
    g = [int(x) for x in sys.argv[1:5]]
    for sd in ('BOTH', 'SHORT'):
        r = stats(run(*g, sides=sd))
        if r: print('%-6s صفقات %d (%.1f/يوم) | شراء %d بيع %d | ربح %.2f%% | صافي %+.0f (%+.2f/صفقة) | أشهر موجبة %d/%d'
                    % (sd, r['n'], r['perday'], r['buy'], r['sell'], r['wr'], r['net'], r['per'], r['pos_mo'], r['n_mo']))
    sys.exit()

print('\n%-22s %7s %7s %8s %10s %9s %8s' % ('التبريد (ربح/خسارة/شراء/بيع)', 'صفقات', '/يوم', 'ربح%', 'صافي', 'لكل صفقة', 'أشهر+'))
print('─' * 78)
rows = []
GRID = list(itertools.product((8, 15, 21, 30, 45), (5, 12, 25), (15, 24, 45), (8, 13, 30)))
for g in GRID:
    r = stats(run(*g))
    if r: rows.append((g, r))
for g, r in sorted(rows, key=lambda x: -x[1]['net'])[:25]:
    print('%-22s %7d %7.1f %7.2f%% %+10.0f %+9.2f %5d/%d'
          % ('/'.join(map(str, g)), r['n'], r['perday'], r['wr'], r['net'], r['per'], r['pos_mo'], r['n_mo']))
json.dump([{'cool': g, **r} for g, r in rows], open('coolsim_out.json', 'w'), indent=1)
print('\nالإعدادات المجرَّبة: %d — اتحفظت في coolsim_out.json' % len(rows))
