"""معمل تركيبات المدارس وأساليب التداول على XAUUSD M1.

الفكرة: المحرك يشتغل مرة واحدة ويعطينا إشارات كل مدرسة خام. بعدها أي تركيبة
(إضافة مدرسة، حذف مدرسة، تغيير عتبة التصويت، أسلوب تداول جديد) تصير عملية
مصفوفات — فنجرّب آلاف التركيبات بدل واحدة.

القيود ثابتة في كل تقييم: صفقة واحدة مفتوحة، الهدف ٣٠ فأكثر، الوقف لا يزيد عن
الهدف + ٢٠. وعند لمس الهدف والوقف في نفس الشمعة يفوز الوقف.

الحكم على كل تركيبة يكون على كل النوافذ المتاحة — سبعة أشهر وكل الأسابيع —
لا على رقم إجمالي واحد.
"""
import datetime
import gzip
import json

import numpy as np

PU = 0.1
MAX_HOLD = 240
VAULT = 'research/tools/vault.csv'
MIN_TRADES_WINDOW = 15          # نافذة أقل من هذا لا تدخل في التصويت


# ------------------------------------------------------------ الداتا

def load_candles(path=VAULT):
    raw = np.genfromtxt(path, delimiter=',', skip_header=1,
                        usecols=(1, 2, 3, 4, 5), dtype=np.float64)
    times = []
    with open(path) as f:
        f.readline()
        for line in f:
            times.append(datetime.datetime.fromisoformat(line.split(',', 1)[0]))
    t = np.array([x.timestamp() for x in times])
    return dict(t=t, dt=times, o=raw[:, 0], h=raw[:, 1], l=raw[:, 2],
                c=raw[:, 3], v=raw[:, 4], n=len(t))


def load_signals(path='research/results/schools_raw.json.gz'):
    with gzip.open(path) as f:
        return json.load(f)


def to_mask(idx, n):
    m = np.zeros(n, bool)
    if len(idx):
        a = np.asarray(idx, dtype=np.int64)
        m[a[a < n]] = True
    return m


# ------------------------------------------------------------ نتائج الدخول

def outcomes(D, tp_pts, sl_pts):
    """لكل شمعة: نتيجة الدخول شراءً وبيعاً بخطة محددة، وبعد كم شمعة أُغلقت.

    0 = لم يُحسم داخل المدة، 1 = هدف، -1 = وقف. الوقف يفوز عند التصادم."""
    h, l, c, n = D['h'], D['l'], D['c'], D['n']
    tpd, sld = tp_pts * PU, sl_pts * PU
    res_b = np.zeros(n, np.int8)
    res_s = np.zeros(n, np.int8)
    bar_b = np.zeros(n, np.int16)
    bar_s = np.zeros(n, np.int16)
    tp_b, sl_b = c + tpd, c - sld
    tp_s, sl_s = c - tpd, c + sld
    ar = np.arange(n)
    for k in range(1, MAX_HOLD + 1):
        j = ar + k
        valid = j < n
        jj = np.where(valid, j, n - 1)
        hj, lj = h[jj], l[jj]
        open_b = valid & (res_b == 0)
        hit_sl = open_b & (lj <= sl_b)
        hit_tp = open_b & (hj >= tp_b) & ~hit_sl
        res_b[hit_sl] = -1
        bar_b[hit_sl] = k
        res_b[hit_tp] = 1
        bar_b[hit_tp] = k
        open_s = valid & (res_s == 0)
        hit_sl = open_s & (hj >= sl_s)
        hit_tp = open_s & (lj <= tp_s) & ~hit_sl
        res_s[hit_sl] = -1
        bar_s[hit_sl] = k
        res_s[hit_tp] = 1
        bar_s[hit_tp] = k
        if not (res_b == 0).any() and not (res_s == 0).any():
            break
    return res_b, res_s, bar_b, bar_s


# ------------------------------------------------------------ المحاكاة

def simulate(buy_mask, sell_mask, oc):
    """صفقة واحدة مفتوحة. عند إشارتين في نفس الشمعة تُتخطى الشمعة كما يفعل المؤشر."""
    res_b, res_s, bar_b, bar_s = oc
    both = buy_mask & sell_mask
    b = buy_mask & ~both
    s = sell_mask & ~both
    order = np.flatnonzero(b | s)
    sides = np.where(b[order], 1, -1)
    free = -1
    bars, outs, sds = [], [], []
    for i, side in zip(order, sides):
        if i <= free:
            continue
        r = res_b[i] if side == 1 else res_s[i]
        if r == 0:                      # لم يُحسم — نتركها تنتهي ولا نحتسبها
            free = i + MAX_HOLD
            continue
        free = i + (bar_b[i] if side == 1 else bar_s[i])
        bars.append(i)
        outs.append(r)
        sds.append(side)
    return np.array(bars, np.int64), np.array(outs, np.int8), np.array(sds, np.int8)


# ------------------------------------------------------------ التقييم بالنوافذ

def window_keys(D):
    months = np.array([f'{d.year}-{d.month:02d}' for d in D['dt']])
    weeks = np.array([(d - datetime.timedelta(days=(d.weekday()))).strftime('%Y-%m-%d')
                      for d in D['dt']])
    days = np.array([d.strftime('%Y-%m-%d') for d in D['dt']])
    return months, weeks, days


def score(bars, outs, tp, sl, months, weeks, days):
    """يرجع ملخصاً عاماً + عدد النوافذ الرابحة شهرياً وأسبوعياً."""
    if len(bars) == 0:
        return None
    wins = int((outs == 1).sum())
    n = len(bars)
    net = wins * tp - (n - wins) * sl
    breakeven = 100.0 * sl / (tp + sl)
    wr = 100.0 * wins / n
    ndays = len(set(days[bars]))

    def by(keys):
        won = tot = 0
        per = []
        for key in sorted(set(keys[bars])):
            m = keys[bars] == key
            if m.sum() < MIN_TRADES_WINDOW:
                continue
            w = int((outs[m] == 1).sum())
            pt = (w * tp - (m.sum() - w) * sl) / m.sum()
            per.append(pt)
            tot += 1
            won += pt > 0
        return int(won), int(tot), (float(np.median(per)) if per else 0.0)

    mw, mt, mmed = by(months)
    ww, wt, wmed = by(weeks)
    return dict(trades=n, win_rate=round(wr, 2), breakeven=round(breakeven, 2),
                edge=round(wr - breakeven, 2), net_points=round(net, 1),
                per_trade=round(net / n, 3), per_day=round(n / ndays, 2) if ndays else 0,
                months_won=mw, months_total=mt, month_median=round(mmed, 3),
                weeks_won=ww, weeks_total=wt, week_median=round(wmed, 3))


def robust(s):
    """مقبولة = رابحة في أغلب الشهور وأغلب الأسابيع، لا في المجموع فقط."""
    if not s or s['months_total'] < 4:
        return False
    return (s['per_trade'] > 0 and s['month_median'] > 0
            and s['months_won'] >= s['months_total'] - 1
            and s['weeks_won'] >= 0.65 * s['weeks_total'])
