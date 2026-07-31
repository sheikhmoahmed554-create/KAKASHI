"""نواة المحاكاة السريعة: تُحمّل مرة وتخدم كل التجارب اللاحقة.

تعتمد على `own_extract.json` — تشغيلة واحدة في المتصفح صدّرت لكل شمعة:
  xBuy / xSell   الإشارة النهائية بعد كل أسطر OR وبعد إصلاح البوابة
  xTgtB / xStpB  هدف ووقف الخطة التكيّفية للشراء، بدوال المؤشر نفسها
  xTgtS / xStpS  المثل للبيع

تُحسب نتيجة كل شمعة مسبقاً (فوز/خسارة/شمعة الخروج) بلا حد زمني — كما يفعل المؤشر —
فتصبح أي محاكاة لاحقة مجرّد مشي على فهارس الإشارات.
"""
import json, csv, numpy as np

PU = 0.1
MAXHOLD = 480          # سقف أمان: التجربة ٥٢ أثبتت أن كل الصفقات تُحسم قبل ٢٤٠ شمعة


def load(path='own_extract.json'):
    R = list(csv.DictReader(open('vault.csv')))
    d = json.load(open(path))
    R = R[:d['bars']]
    N = len(R)
    D = dict(
        n=N,
        h=np.array([float(r['high']) for r in R]),
        l=np.array([float(r['low']) for r in R]),
        c=np.array([float(r['close']) for r in R]),
        o=np.array([float(r['open']) for r in R]),
        v=np.array([float(r.get('volume', 0) or 0) for r in R]),
        t=np.array([int(np.datetime64(r['time'][:19], 's').astype('int64')) for r in R]),
        date=np.array([r['time'][:10] for r in R]),
        mo=np.array([r['time'][:7] for r in R]),
        days=len(set(r['time'][:10] for r in R)))
    X = d['extra']
    D['buy'] = np.array(X['xBuy'], bool)
    D['sell'] = np.array(X['xSell'], bool)
    D['tgt'] = {1: np.array(X['xTgtB'], float), -1: np.array(X['xTgtS'], float)}
    D['stp'] = {1: np.array(X['xStpB'], float), -1: np.array(X['xStpS'], float)}
    return D


def outcomes(D):
    """لكل شمعة وجهة: (فاز ١/٠، النقاط، شمعة الخروج). الوقف أولاً عند التعادل داخل الشمعة."""
    N = D['n']; h, l, c = D['h'], D['l'], D['c']
    out = {}
    for side in (1, -1):
        tp = D['tgt'][side]; sl = D['stp'][side]
        tpp = c + (tp * PU if side == 1 else -tp * PU)
        slp = c - (sl * PU if side == 1 else -sl * PU)
        win = np.full(N, -1, np.int8)
        exb = np.full(N, -1, np.int32)
        ar = np.arange(N)
        for k in range(1, MAXHOLD + 1):
            j = np.minimum(ar + k, N - 1)
            alive = win < 0
            if not alive.any(): break
            hs = (l[j] <= slp) if side == 1 else (h[j] >= slp)
            ht = (h[j] >= tpp) if side == 1 else (l[j] <= tpp)
            s = alive & hs
            t = alive & ht & ~hs
            win[s] = 0; exb[s] = j[s]
            win[t] = 1; exb[t] = j[t]
        pts = np.where(win == 1, D['tgt'][side], np.where(win == 0, -D['stp'][side], 0.0))
        out[side] = (win, pts, exb)
    return out


def simulate(D, O, cool=(21, 12, 24, 13), sides='BOTH', gate=None):
    """يعيد بناء canEnterLong/Short كاملاً.

    cool = (بعد أي صفقة، بعد أي خسارة، بعد خسارة شراء، بعد خسارة بيع)
    gate = مصفوفة منطقية اختيارية لكل شمعة: شرط إضافي للسماح بالدخول.
    يرجع مصفوفة صفقات (شمعة الدخول، الجهة، فاز، نقاط، شمعة الخروج).
    """
    cw, cl, cb, cs = cool
    buy, sell = D['buy'], D['sell']
    if gate is not None:
        buy = buy & gate; sell = sell & gate
    if sides == 'LONG': sell = np.zeros_like(sell)
    if sides == 'SHORT': buy = np.zeros_like(buy)
    cand = np.flatnonzero(buy | sell)
    N = D['n']
    busy = -1; lt = las = lls = lss = -10**9
    rows = []
    for i in cand:
        if i <= busy or i >= N - 1: continue
        side = 1 if buy[i] else -1                      # الشراء أولاً كما في المؤشر
        if i - lt < cw: continue
        if i - las < cl: continue
        if side == 1 and i - lls < cb: continue
        if side == -1 and i - lss < cs: continue
        w, p, j = O[side][0][i], O[side][1][i], O[side][2][i]
        if w < 0 or j < 0: continue
        busy = j; lt = j
        if w == 0:
            las = j
            if side == 1: lls = j
            else: lss = j
        rows.append((i, side, int(w), float(p), int(j)))
    return np.array(rows, dtype=float) if rows else np.zeros((0, 5))


def baseline(D, O, side, sel):
    """نسبة فوز «ادخل في كل شمعة صالحة» لنفس الجهة والفترة — مرجع انحياز الاتجاه."""
    w = O[side][0]
    m = sel & (w >= 0)
    n = m.sum()
    return 100 * (w[m] == 1).sum() / max(n, 1)


def report(D, O, T, label='', sel=None):
    if len(T) == 0: return None
    idx = T[:, 0].astype(int)
    if sel is not None:
        keep = sel[idx]
        T = T[keep]; idx = idx[keep]
        if len(T) == 0: return None
    n = len(T); w = int(T[:, 2].sum()); net = T[:, 3].sum()
    days = len(set(D['date'][idx]))
    r = dict(label=label, n=n, wr=100 * w / n, net=net, per=net / n,
             perday=n / max(days, 1), buy=int((T[:, 1] > 0).sum()),
             sell=int((T[:, 1] < 0).sum()))
    # الفائض على خط الأساس، مرجّح بحصّة كل جهة
    ex = 0.0
    for side in (1, -1):
        m = T[:, 1] == side
        if m.sum() < 20: continue
        s = np.zeros(D['n'], bool)
        s[idx[m]] = True
        span = np.zeros(D['n'], bool)
        for mo in set(D['mo'][idx[m]]): span |= D['mo'] == mo
        b = baseline(D, O, side, span)
        ex += (100 * T[m, 2].sum() / m.sum() - b) * m.sum() / n
    r['excess'] = ex
    return r
