"""محرك RMI مكتوباً بالبايثون — نسخة طبق الأصل عن المؤشر.

كل ضبط سابق كان حول المؤشر لا فيه، لأن تغيير إعداد واحد في RMI يوجب إعادة تشغيل
المحرك (خمس دقائق للسنة الواحدة). هنا يُكتب المنطق نفسه بالبايثون فيصير مسح مئات
الإعدادات دقائق.

الشرط الذي يجعل هذا مقبولاً: عند الإعدادات الافتراضية يجب أن تطابق الإشارات
إشارات المحرك **شمعةً بشمعة**، لا في العدد فقط. `verify()` يرفض أي فرق.

المعادلة كما في RMI.pine:
    rmiUp   = ema(max(close - close[mom], 0), len)
    rmiDown = ema(max(close[mom] - close, 0), len)
    rmi     = 100 - 100/(1 + up/down)
وآلة التسليح: دخول المنطقة يسلّح، ثم يُنتظر عدد شمعات تفاعل متتالية خلال نافذة،
وشرط اختياري بلمس قمة/قاع سابق. التسليح ينتقض بدخول المنطقة المضادة.
"""
import json

import numpy as np


def ema(x, n):
    """ta.ema — أول قيمة هي SMA لأول n، ثم التكرار. كما يفعل المحرك."""
    a = 2.0 / (n + 1.0)
    out = np.empty(len(x))
    out[:n - 1] = np.nan
    s = x[:n].mean()
    out[n - 1] = s
    for i in range(n, len(x)):
        s = a * x[i] + (1 - a) * s
        out[i] = s
    return out


def rolling_min(x, n):
    """ta.lowest على نافذة n — بطابور أحادي، خطّي لا تربيعي."""
    out = np.full(len(x), np.nan)
    from collections import deque
    q = deque()
    for i, v in enumerate(x):
        while q and x[q[-1]] >= v:
            q.pop()
        q.append(i)
        if q[0] <= i - n:
            q.popleft()
        if i >= n - 1:
            out[i] = x[q[0]]
    return out


def rolling_max(x, n):
    out = np.full(len(x), np.nan)
    from collections import deque
    q = deque()
    for i, v in enumerate(x):
        while q and x[q[-1]] <= v:
            q.pop()
        q.append(i)
        if q[0] <= i - n:
            q.popleft()
        if i >= n - 1:
            out[i] = x[q[0]]
    return out


DEFAULT = dict(length=18, momentum=6, ob=80.0, os=20.0, reaction=2,
               wait=12, extreme=40, price_reaction=True)


def signals(H, L, C, p):
    """يعيد (buy, sell) كمصفوفتَي bool بطول الشموع."""
    n = len(C)
    mom, ln = p['momentum'], p['length']
    d = np.zeros(n)
    d[mom:] = C[mom:] - C[:-mom]
    up = ema(np.maximum(d, 0.0), ln)
    dn = ema(np.maximum(-d, 0.0), ln)
    with np.errstate(divide='ignore', invalid='ignore'):
        rmi = np.where(dn == 0.0, np.where(up == 0.0, 50.0, 100.0),
                       100.0 - 100.0 / (1.0 + up / dn))
    rmi[np.isnan(up)] = np.nan

    inBuy = rmi <= p['os']
    inSell = rmi >= p['ob']
    # na مقارَنةً في Pine تعطي false، وnot false = true، فأول شمعة صالحة تُعدّ دخولاً
    inBuy[np.isnan(rmi)] = False
    inSell[np.isnan(rmi)] = False
    buyEnter = inBuy & ~np.r_[False, inBuy[:-1]]
    sellEnter = inSell & ~np.r_[False, inSell[:-1]]

    rmiUpTick = np.r_[False, rmi[1:] > rmi[:-1]]
    rmiDnTick = np.r_[False, rmi[1:] < rmi[:-1]]
    if p['price_reaction']:
        pUp = np.r_[False, C[1:] > C[:-1]]
        pDn = np.r_[False, C[1:] < C[:-1]]
    else:
        pUp = pDn = np.ones(n, bool)

    ex = p['extreme']
    if ex > 0:
        pl = np.r_[np.nan, rolling_min(L, ex)[:-1]]
        ph = np.r_[np.nan, rolling_max(H, ex)[:-1]]
        exBuy = L <= pl
        exSell = H >= ph
        exBuy[np.isnan(pl)] = False
        exSell[np.isnan(ph)] = False
    else:
        exBuy = exSell = np.zeros(n, bool)

    need = p['reaction']
    wait = p['wait']
    buy = np.zeros(n, bool)
    sell = np.zeros(n, bool)
    bArm = sArm = False
    bBar = sBar = 0
    bCnt = sCnt = 0
    bSeen = sSeen = False
    for i in range(n):
        if buyEnter[i]:
            bArm, sArm = True, False
            bBar = i; bCnt = sCnt = 0; bSeen = bool(exBuy[i])
        if sellEnter[i]:
            sArm, bArm = True, False
            sBar = i; sCnt = bCnt = 0; sSeen = bool(exSell[i])
        if bArm and exBuy[i]:
            bSeen = True
        if sArm and exSell[i]:
            sSeen = True
        if bArm and i - bBar > wait:
            bArm = False; bCnt = 0
        if sArm and i - sBar > wait:
            sArm = False; sCnt = 0
        if bArm:
            bCnt = bCnt + 1 if (i > bBar and rmiUpTick[i] and pUp[i]) else 0
        if sArm:
            sCnt = sCnt + 1 if (i > sBar and rmiDnTick[i] and pDn[i]) else 0
        if bArm and bCnt >= need and (ex == 0 or bSeen):
            buy[i] = True
        if sArm and sCnt >= need and (ex == 0 or sSeen):
            sell[i] = True
        # المؤشر ينزع التسليح بمجرّد صدور الإشارة، سواء فُتحت صفقة أم لا
        # (RMI.pine سطر ٣١٨). بدونه تتكرّر الإشارة كل شمعة تفاعل تالية.
        if buy[i] or sell[i]:
            bArm = sArm = False
    return buy, sell


def verify(years=('2021', '2023', '2025', '2026')):
    """الشرط: مطابقة شمعةً بشمعة لإشارات المحرك عند الإعدادات الافتراضية."""
    allok = True
    for y in years:
        d = json.load(open(f'probe_{y}.json'))
        n = d['bars']
        H = np.asarray(d['high'], float); L = np.asarray(d['low'], float)
        C = np.asarray(d['close'], float)
        eb = np.zeros(n, bool); eb[d['bits']['rmiRawBuy']] = True
        es = np.zeros(n, bool); es[d['bits']['rmiRawSell']] = True
        b, s = signals(H, L, C, DEFAULT)
        db = int((b != eb).sum()); ds = int((s != es).sum())
        ok = db == 0 and ds == 0
        allok &= ok
        print(f"  {y}: بايثون {b.sum()}/{s.sum()} • محرك {eb.sum()}/{es.sum()} • "
              f"فروق {db}+{ds}  {'✓' if ok else '✗'}")
        if not ok:
            w = np.flatnonzero(b != eb)[:8]
            print(f"      أول اختلافات الشراء عند الشموع: {w.tolist()}")
    return allok


if __name__ == '__main__':
    print("═══ تحقّق: RMI بالبايثون مقابل محرك المنصة، شمعةً بشمعة ═══")
    if verify():
        print("\nمطابقة تامة. المسح مسموح.")
    else:
        raise SystemExit("\n!! لا تطابق — المسح ممنوع حتى يُصلح.")
