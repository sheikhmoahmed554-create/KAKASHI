"""نافذة اختبار واحدة لمفهوم واحد، بعشرات الإعدادات، على السنوات الأربع.

    python3 research/tools/window.py <المجموعة> <الخرج.json>

المجموعات: liquidity structure momentum candles path retracement levels flow time regime trade

كل صيغة تُقاس مرتين:
  منفردة  — مقابل الدخول العشوائي في نفس السنة
  مرشّحاً — فوق الإشارة الأساسية (سحب ≥١.٢٤×ATR تحت قاع ٢٠)، هل ترفعها أم تخفضها؟

لا تُقبل صيغة إلا إذا اتفقت إشارتها في السنوات الأربع.
"""
import json
import sys

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

YEARS = (2021, 2023, 2025, 2026)
PU = 0.1
MIN_N = 200


def roll(x, w, fn):
    out = np.full(len(x), np.nan)
    if w <= len(x):
        out[w - 1:] = fn(sliding_window_view(x, w), axis=1)
    return out


def prev(x, k=1):
    if k == 0:
        return np.asarray(x, float)
    return np.concatenate([np.full(k, np.nan), x[:-k]])


def rma(x, n):
    out = np.empty(len(x)); out[0] = x[0]
    a = 1. / n
    for i in range(1, len(x)):
        out[i] = a * x[i] + (1 - a) * out[i - 1]
    return out


def ema(x, n):
    out = np.empty(len(x)); out[0] = x[0]
    k = 2. / (n + 1)
    for i in range(1, len(x)):
        out[i] = k * x[i] + (1 - k) * out[i - 1]
    return out


def load(year):
    z = np.load(f'research/data/prep/{year}.npz')
    d = {k: z[k] for k in z.files}
    o, h, l, c, A = d['o'], d['h'], d['l'], d['c'], np.maximum(d['atr'], 1e-9)
    n = len(c)
    d['n'] = n
    d['rng'] = np.maximum(h - l, 1e-9)
    d['A'] = A
    for w in (10, 20, 60, 120, 240):
        hi, lo = roll(h, w, np.nanmax), roll(l, w, np.nanmin)
        d[f'phi{w}'], d[f'plo{w}'] = prev(hi), prev(lo)
        d[f'pos{w}'] = 100 * (c - lo) / np.maximum(hi - lo, 1e-9)
    for w in (30, 120, 480):
        d[f'slope{w}'] = ((c - prev(c, w)) / PU) / A
    for p in (20, 50, 200):
        d[f'ema{p}'] = ema(c, p)
    dd = np.diff(c, prepend=c[0])
    for p in (3, 7, 14, 21):
        ru, rd = rma(np.maximum(dd, 0), p), rma(-np.minimum(dd, 0), p)
        d[f'rsi{p}'] = 100 - 100 / (1 + ru / np.maximum(rd, 1e-9))
    up = (c > o).astype(int); run = np.zeros(n)
    for i in range(1, n):
        run[i] = run[i - 1] + 1 if up[i] == up[i - 1] else 1
    d['run'] = run * np.where(up, 1, -1)
    d['warm'] = np.arange(n) > 500
    d['base_sig'] = base_signal(d)
    return d


def base_signal(d):
    """الإشارة الأساسية المثبتة: سحب ≥١.٢٤×ATR تحت قاع ٢٠ شمعة."""
    depth = np.where(d['l'] < d['plo20'], ((d['plo20'] - d['l']) / PU) / d['A'], np.nan)
    return d['warm'] & np.isfinite(depth) & (depth >= 1.24)


# ─────────────────────────── مولّدات الصيغ

def g_liquidity(d):
    out = []
    for w in (10, 20, 60, 120, 240):
        below = np.where(d['l'] < d[f'plo{w}'], ((d[f'plo{w}'] - d['l']) / PU) / d['A'], np.nan)
        above = np.where(d['h'] > d[f'phi{w}'], ((d['h'] - d[f'phi{w}']) / PU) / d['A'], np.nan)
        for thr in (0.2, 0.4, 0.6, 0.8, 1.0, 1.33, 2.0):
            for rc, rcname in ((None, ''), (True, '+إغلاق راجع')):
                m = np.isfinite(below) & (below >= thr)
                if rc:
                    m = m & (d['c'] > d[f'plo{w}'])
                out.append((f'سحب_تحت_{w}≥{thr}{rcname}', 1, m))
                m = np.isfinite(above) & (above >= thr)
                if rc:
                    m = m & (d['c'] < d[f'phi{w}'])
                out.append((f'سحب_فوق_{w}≥{thr}{rcname}', -1, m))
    for w in (20, 60):
        eq = np.abs(prev(roll(d['l'], 20, np.nanmin)) - d[f'plo{w}']) / (d['A'] * PU)
        for tol in (0.1, 0.25, 0.5):
            out.append((f'بركة_متساوية_تحت_{w}_تفاوت{tol}', 1,
                        (eq < tol) & (d['l'] < d[f'plo{w}'])))
    return out


def g_structure(d):
    out = []
    for w in (10, 20, 60, 120, 240):
        cb = np.where(d['c'] < d[f'plo{w}'], ((d[f'plo{w}'] - d['c']) / PU) / d['A'], np.nan)
        ca = np.where(d['c'] > d[f'phi{w}'], ((d['c'] - d[f'phi{w}']) / PU) / d['A'], np.nan)
        for lo_, hi_ in ((0, 0.2), (0.2, 0.4), (0.4, 0.8), (0.8, 1.3), (1.3, 99)):
            out.append((f'كسر_تحت_{w}_{lo_}–{hi_}', 1,
                        np.isfinite(cb) & (cb >= lo_) & (cb < hi_)))
            out.append((f'كسر_فوق_{w}_{lo_}–{hi_}', -1,
                        np.isfinite(ca) & (ca >= lo_) & (ca < hi_)))
        for back in (1, 2, 3, 5):
            was = np.concatenate([np.full(back, False), (d['c'] < d[f'plo{w}'])[:-back]])
            out.append((f'كسر_فاشل_تحت_{w}_بعد{back}', 1, was & (d['c'] > d[f'plo{w}'])))
    return out


def g_momentum(d):
    out = []
    for p in (3, 7, 14, 21):
        for thr in (5, 10, 15, 20, 25, 30):
            out.append((f'RSI{p}<{thr}', 1, d[f'rsi{p}'] < thr))
            out.append((f'RSI{p}>{100 - thr}', -1, d[f'rsi{p}'] > 100 - thr))
    for k in (2, 3, 4, 5, 6, 8):
        out.append((f'{k}_شموع_هابطة', 1, d['run'] <= -k))
        out.append((f'{k}_شموع_صاعدة', -1, d['run'] >= k))
    for w in (30, 120, 480):
        for thr in (2, 4, 6, 10):
            out.append((f'انحدار_{w}<-{thr}', 1, d[f'slope{w}'] < -thr))
            out.append((f'انحدار_{w}>+{thr}', -1, d[f'slope{w}'] > thr))
    for p in (20, 50, 200):
        for thr in (1, 2, 3, 5):
            dist = ((d['c'] - d[f'ema{p}']) / PU) / d['A']
            out.append((f'تحت_EMA{p}_بـ{thr}ATR', 1, dist < -thr))
            out.append((f'فوق_EMA{p}_بـ{thr}ATR', -1, dist > thr))
    return out


def g_candles(d):
    o, h, l, c, r = d['o'], d['h'], d['l'], d['c'], d['rng']
    body = 100 * np.abs(c - o) / r
    upw = 100 * (h - np.maximum(o, c)) / r
    dnw = 100 * (np.minimum(o, c) - l) / r
    cp = 100 * (c - l) / r
    out = []
    for lo_, hi_ in ((0, 20), (20, 40), (40, 60), (60, 80), (80, 101)):
        out.append((f'جسم_{lo_}–{hi_}٪_شراء', 1, (body >= lo_) & (body < hi_)))
        out.append((f'جسم_{lo_}–{hi_}٪_بيع', -1, (body >= lo_) & (body < hi_)))
        out.append((f'ذيل_سفلي_{lo_}–{hi_}٪', 1, (dnw >= lo_) & (dnw < hi_)))
        out.append((f'ذيل_علوي_{lo_}–{hi_}٪', -1, (upw >= lo_) & (upw < hi_)))
        out.append((f'إغلاق_{lo_}–{hi_}٪_شراء', 1, (cp >= lo_) & (cp < hi_)))
        out.append((f'إغلاق_{lo_}–{hi_}٪_بيع', -1, (cp >= lo_) & (cp < hi_)))
    po, pc_, ph, pl = prev(o), prev(c), prev(h), prev(l)
    out.append(('ابتلاع_صاعد', 1, (c > po) & (o < pc_) & (c > o) & (pc_ < po)))
    out.append(('ابتلاع_هابط', -1, (c < po) & (o > pc_) & (c < o) & (pc_ > po)))
    out.append(('إنسايد_بار_شراء', 1, (h < ph) & (l > pl)))
    out.append(('إنسايد_بار_بيع', -1, (h < ph) & (l > pl)))
    for thr in (50, 60, 70):
        out.append((f'بن_بار_سفلي_{thr}', 1, (dnw > thr) & (body < 30)))
        out.append((f'بن_بار_علوي_{thr}', -1, (upw > thr) & (body < 30)))
    out.append(('دوجي_شراء', 1, body < 10))
    out.append(('دوجي_بيع', -1, body < 10))
    for k in (2, 3, 4):
        rl = np.ones(len(c), bool)
        for j in range(k):
            rl &= (prev(c, j) < prev(o, j))
        out.append((f'{k}_شموع_حمراء_متتالية', 1, rl))
    return out


def g_path(d):
    o, h, l, c, n = d['o'], d['h'], d['l'], d['c'], d['n']
    out = []
    for step in (3, 5, 10, 15, 30):
        fh = np.full(n, np.nan); we = np.full(n, np.nan); eff = np.full(n, np.nan)
        for s in range(0, n - step, step):
            hh, ll = h[s:s + step], l[s:s + step]
            ih, il = int(np.argmax(hh)), int(np.argmin(ll))
            travel = np.abs(np.diff(c[s:s + step])).sum() + abs(c[s] - o[s])
            e = s + step - 1
            fh[e] = 1.0 if ih < il else 0.0
            we[e] = (ih if c[e] >= o[s] else il) / (step - 1)
            eff[e] = abs(c[e] - o[s]) / travel if travel > 0 else np.nan
        out.append((f'القاع_قبل_القمة_{step}', 1, fh == 0))
        out.append((f'القمة_قبل_القاع_{step}', -1, fh == 1))
        for lo_, hi_ in ((0, .2), (.2, .4), (.4, .6), (.6, 1.01)):
            out.append((f'كفاءة_{step}_{lo_}–{hi_}_شراء', 1,
                        np.isfinite(eff) & (eff >= lo_) & (eff < hi_)))
            out.append((f'كفاءة_{step}_{lo_}–{hi_}_بيع', -1,
                        np.isfinite(eff) & (eff >= lo_) & (eff < hi_)))
        for lo_, hi_ in ((0, .25), (.25, .5), (.5, .75), (.75, 1.01)):
            out.append((f'موضع_الطرف_{step}_{lo_}–{hi_}', 1,
                        np.isfinite(we) & (we >= lo_) & (we < hi_)))
    return out


def g_retracement(d):
    out = []
    c = d['c']
    for w in (60, 120, 240):
        hi, lo = roll(d['h'], w, np.nanmax), roll(d['l'], w, np.nanmin)
        wave = np.maximum(hi - lo, 1e-9)
        depth_from_hi = 100 * (hi - c) / wave
        width = ((hi - lo) / PU) / d['A']
        for lo_, hi_ in ((0, 11), (11, 25), (25, 38.2), (38.2, 50),
                         (50, 61.8), (61.8, 78.6), (78.6, 89), (89, 101)):
            m = (depth_from_hi >= lo_) & (depth_from_hi < hi_)
            out.append((f'تصحيح_{w}_{lo_}–{hi_}٪_شراء', 1, m))
            out.append((f'تصحيح_{w}_{lo_}–{hi_}٪_بيع', -1, m))
        for wmin in (2, 4, 8):
            out.append((f'تصحيح_عميق_{w}_موجة>{wmin}ATR', 1,
                        (depth_from_hi > 61.8) & (width > wmin)))
    return out


def g_levels(d):
    c, n = d['c'], d['n']
    out = []
    di = d['day_idx']
    newday = np.concatenate([[True], di[1:] != di[:-1]])
    pdh = np.full(n, np.nan); pdl = np.full(n, np.nan); dop = np.full(n, np.nan)
    ch = cl = None; ph_ = pl_ = op = np.nan
    for i in range(n):
        if newday[i]:
            if ch is not None:
                ph_, pl_ = ch, cl
            ch, cl = d['h'][i], d['l'][i]
            op = d['o'][i]
        else:
            ch = max(ch, d['h'][i]); cl = min(cl, d['l'][i])
        pdh[i], pdl[i], dop[i] = ph_, pl_, op
    for name, lvl in (('قمة_أمس', pdh), ('قاع_أمس', pdl), ('افتتاح_اليوم', dop)):
        dist = ((c - lvl) / PU) / d['A']
        for thr in (0.5, 1, 2, 3, 5):
            out.append((f'تحت_{name}_بـ{thr}ATR', 1, dist < -thr))
            out.append((f'فوق_{name}_بـ{thr}ATR', -1, dist > thr))
    rd = (np.minimum(c % 1.0, 1.0 - (c % 1.0)) / PU) / d['A']
    for thr in (0.05, 0.1, 0.2):
        out.append((f'قرب_الرقم_المدور_{thr}_شراء', 1, rd < thr))
        out.append((f'قرب_الرقم_المدور_{thr}_بيع', -1, rd < thr))
    for k in (30, 60, 120):
        orh = np.full(n, np.nan); orl = np.full(n, np.nan)
        cnt = {}; hh = ll = np.nan
        for i in range(n):
            j = di[i]; cnt[j] = cnt.get(j, 0) + 1
            if cnt[j] == 1:
                hh, ll = d['h'][i], d['l'][i]
            elif cnt[j] <= k:
                hh = max(hh, d['h'][i]); ll = min(ll, d['l'][i])
            orh[i], orl[i] = (hh, ll) if cnt[j] > k else (np.nan, np.nan)
        out.append((f'تحت_مدى_افتتاح_{k}', 1, c < orl))
        out.append((f'فوق_مدى_افتتاح_{k}', -1, c > orh))
    return out


def g_flow(d):
    out = []
    v = d['v']
    if v.max() <= 0:
        return out
    vm = np.convolve(v, np.ones(60) / 60, mode='full')[:len(v)]
    vr = v / np.maximum(vm, 1e-9)
    for lo_, hi_ in ((0, .5), (.5, .8), (.8, 1.2), (1.2, 1.8), (1.8, 3), (3, 99)):
        m = (vr >= lo_) & (vr < hi_)
        out.append((f'حجم_{lo_}–{hi_}_شراء', 1, m))
        out.append((f'حجم_{lo_}–{hi_}_بيع', -1, m))
    eff = (d['rng'] / PU) / np.maximum(v, 1.0)
    for q in (10, 25, 50, 75, 90):
        thr = np.nanpercentile(eff[np.isfinite(eff)], q)
        out.append((f'جهد_مقابل_نتيجة<{q}٪', 1, eff < thr))
        out.append((f'جهد_مقابل_نتيجة>{q}٪', -1, eff > thr))
    if d['sp'].max() > 0:
        sr = d['sp'] / d['A']
        for q in (25, 50, 75, 90):
            thr = np.nanpercentile(sr[np.isfinite(sr)], q)
            out.append((f'سبريد_مرتفع>{q}٪_شراء', 1, sr > thr))
            out.append((f'سبريد_منخفض<{q}٪_شراء', 1, sr < thr))
    return out


def g_time(d):
    out = []
    hr = d['hour']
    for h0 in range(0, 24, 2):
        m = (hr >= h0) & (hr < h0 + 2)
        out.append((f'ساعة_{h0}–{h0 + 2}_شراء', 1, m))
        out.append((f'ساعة_{h0}–{h0 + 2}_بيع', -1, m))
    di = d['day_idx']
    pos = np.zeros(len(di))
    cnt = {}
    for i in range(len(di)):
        j = di[i]; cnt[j] = cnt.get(j, 0) + 1
        pos[i] = cnt[j]
    for lo_, hi_ in ((0, 60), (60, 240), (240, 600), (600, 1000), (1000, 2000)):
        m = (pos >= lo_) & (pos < hi_)
        out.append((f'دقيقة_اليوم_{lo_}–{hi_}_شراء', 1, m))
        out.append((f'دقيقة_اليوم_{lo_}–{hi_}_بيع', -1, m))
    jump = d['A'] / np.maximum(prev(d['A'], 30), 1e-9)
    for thr in (1.3, 1.6, 2.0, 3.0):
        out.append((f'انفجار_تذبذب>{thr}_شراء', 1, jump > thr))
        out.append((f'انفجار_تذبذب>{thr}_بيع', -1, jump > thr))
    return out


def g_regime(d):
    """نافذة المحرك: كيف تتغيّر النتيجة بتغيّر نوع السوق وقوته."""
    out = []
    A = d['atr']
    long_atr = np.convolve(A, np.ones(240) / 240, mode='full')[:len(A)]
    reg = A / np.maximum(long_atr, 1e-9)
    for lo_, hi_ in ((0, .6), (.6, .8), (.8, 1.0), (1.0, 1.3), (1.3, 2.0), (2.0, 99)):
        m = (reg >= lo_) & (reg < hi_)
        out.append((f'نظام_تذبذب_{lo_}–{hi_}_شراء', 1, m))
        out.append((f'نظام_تذبذب_{lo_}–{hi_}_بيع', -1, m))
    for q0, q1 in ((0, 20), (20, 40), (40, 60), (60, 80), (80, 100)):
        a, b = np.nanpercentile(A, [q0, q1])
        m = (A >= a) & (A < b)
        out.append((f'ATR_شريحة_{q0}–{q1}_شراء', 1, m))
        out.append((f'ATR_شريحة_{q0}–{q1}_بيع', -1, m))
    for w in (120, 480):
        for lo_, hi_ in ((-99, -6), (-6, -2), (-2, 2), (2, 6), (6, 99)):
            m = (d[f'slope{w}'] >= lo_) & (d[f'slope{w}'] < hi_)
            out.append((f'اتجاه_{w}_{lo_}–{hi_}_شراء', 1, m))
            out.append((f'اتجاه_{w}_{lo_}–{hi_}_بيع', -1, m))
    for w in (60, 240):
        width = ((roll(d['h'], w, np.nanmax) - roll(d['l'], w, np.nanmin)) / PU) / d['A']
        for lo_, hi_ in ((0, 4), (4, 8), (8, 15), (15, 99)):
            m = (width >= lo_) & (width < hi_)
            out.append((f'عرض_نطاق_{w}_{lo_}–{hi_}_شراء', 1, m))
            out.append((f'عرض_نطاق_{w}_{lo_}–{hi_}_بيع', -1, m))
    return out



def g_advanced(d):
    """المفاهيم الباقية: تغيّر الطابع، العرض والطلب، مناطق الأوامر، الفجوات،
    السيولة غير المختبرة، الاندفاع مقابل التصحيح، القنوات، الانقطاع اليومي."""
    o, h, l, c, n, A = d['o'], d['h'], d['l'], d['c'], d['n'], d['A']
    out = []

    # الفجوة السعرية: شمعة لا يتداخل مداها مع ما قبلها بشمعتين
    for k in (1, 2, 3):
        fvg_up = prev(l, 0) > prev(h, 2)
        fvg_dn = prev(h, 0) < prev(l, 2)
        gap_up = ((prev(l, 0) - prev(h, 2)) / PU) / A
        gap_dn = ((prev(l, 2) - prev(h, 0)) / PU) / A
        for thr in (0.2, 0.5, 1.0):
            out.append((f'فجوة_صاعدة≥{thr}_شراء', 1, fvg_up & (gap_up >= thr)))
            out.append((f'فجوة_هابطة≥{thr}_شراء', 1, fvg_dn & (gap_dn >= thr)))
            out.append((f'فجوة_هابطة≥{thr}_بيع', -1, fvg_dn & (gap_dn >= thr)))
        break

    # مناطق الأوامر: آخر شمعة معاكسة قبل اندفاعة، والعودة إليها
    body = np.abs(c - o) / np.maximum(h - l, 1e-9)
    impulse_up = ((c - prev(c, 3)) / PU) / A
    for thr in (2, 3, 5):
        ob_bull = np.concatenate([np.full(3, False), ((c < o) & (body > 0.3))[:-3]]) & (impulse_up > thr)
        out.append((f'منطقة_أوامر_صاعدة_اندفاع{thr}', 1, ob_bull))
        ob_bear = np.concatenate([np.full(3, False), ((c > o) & (body > 0.3))[:-3]]) & (impulse_up < -thr)
        out.append((f'منطقة_أوامر_هابطة_اندفاع{thr}', -1, ob_bear))

    # العرض والطلب: قاعدة ضيقة ثم انطلاقة، والعودة الأولى إليها
    for w in (20, 60):
        width = ((roll(h, w, np.nanmax) - roll(l, w, np.nanmin)) / PU) / A
        base_narrow = np.concatenate([np.full(10, False), (width < 3)[:-10]])
        for thr in (3, 5):
            out.append((f'عودة_لقاعدة_{w}_بعد_اندفاع{thr}', 1,
                        base_narrow & (impulse_up < -thr)))

    # تغيّر الطابع: أول كسر ضد اتجاه قائم
    for w in (20, 60):
        up_trend = d[f'slope{120}'] > 3
        dn_trend = d[f'slope{120}'] < -3
        out.append((f'تغيّر_طابع_صاعد_{w}', 1, dn_trend & (c > d[f'phi{w}'])))
        out.append((f'تغيّر_طابع_هابط_{w}', -1, up_trend & (c < d[f'plo{w}'])))

    # السيولة غير المختبرة: بُعد أقرب قمة/قاع لم يُلمس
    for w in (60, 240):
        dist_lo = ((c - d[f'plo{w}']) / PU) / A
        dist_hi = ((d[f'phi{w}'] - c) / PU) / A
        for thr in (1, 2, 4):
            out.append((f'قرب_سيولة_تحت_{w}<{thr}', 1, dist_lo < thr))
            out.append((f'قرب_سيولة_فوق_{w}<{thr}', -1, dist_hi < thr))

    # الاندفاع مقابل التصحيح: كفاءة الحركة على نافذة
    for w in (10, 30, 60):
        net = np.abs(c - prev(c, w))
        travel = np.convolve(np.abs(np.diff(c, prepend=c[0])), np.ones(w), mode='full')[:n]
        er = net / np.maximum(travel, 1e-9)
        for lo_, hi_ in ((0, .2), (.2, .4), (.4, 1.01)):
            m = (er >= lo_) & (er < hi_)
            out.append((f'كفاءة_حركة_{w}_{lo_}–{hi_}_شراء', 1, m))
            out.append((f'كفاءة_حركة_{w}_{lo_}–{hi_}_بيع', -1, m))

    # الانقطاع اليومي: أول وآخر شمعات الجلسة
    di = d['day_idx']
    newday = np.concatenate([[True], di[1:] != di[:-1]])
    pos = np.zeros(n); cnt = {}
    for i in range(n):
        j = int(di[i]); cnt[j] = cnt.get(j, 0) + 1; pos[i] = cnt[j]
    tot = {}
    for i in range(n):
        tot[int(di[i])] = pos[i]
    rem = np.array([tot[int(di[i])] - pos[i] for i in range(n)])
    for k in (30, 60, 120):
        out.append((f'أول_{k}_دقيقة_شراء', 1, pos <= k))
        out.append((f'آخر_{k}_دقيقة_شراء', 1, rem <= k))
        out.append((f'آخر_{k}_دقيقة_بيع', -1, rem <= k))
    return out

GROUPS = {'liquidity': g_liquidity, 'structure': g_structure, 'momentum': g_momentum,
          'candles': g_candles, 'path': g_path, 'retracement': g_retracement,
          'levels': g_levels, 'flow': g_flow, 'time': g_time, 'regime': g_regime,
          'advanced': g_advanced}


def main():
    group, out_path = sys.argv[1], sys.argv[2]
    gen = GROUPS[group]
    data = {y: load(y) for y in YEARS}
    res = {}
    for y in YEARS:
        d = data[y]
        rb, rs = d['rb'], d['rs']
        bb = 100.0 * (rb[d['warm'] & (rb != 0)] == 1).mean()
        bs = 100.0 * (rs[d['warm'] & (rs != 0)] == 1).mean()
        base_m = d['base_sig'] & (rb != 0)
        base_wr = 100.0 * (rb[base_m] == 1).mean()
        for name, side, mask in gen(d):
            mask = np.nan_to_num(mask, nan=False).astype(bool)
            r, base = (rb, bb) if side == 1 else (rs, bs)
            m = d['warm'] & mask & (r != 0)
            e = res.setdefault(name, {'side': side, 'years': {}})
            if m.sum() >= MIN_N:
                wr = 100.0 * (r[m] == 1).mean()
                e['years'][y] = {'n': int(m.sum()), 'wr': round(wr, 2),
                                 'lift': round(wr - base, 2),
                                 'per_day': round(m.sum() / int(d['ndays']), 2)}
            f = base_m & mask
            if f.sum() >= MIN_N // 2:
                fwr = 100.0 * (rb[f] == 1).mean()
                e['years'].setdefault(y, {})['filter_lift'] = round(fwr - base_wr, 2)
                e['years'][y]['filter_n'] = int(f.sum())
    json.dump(res, open(out_path, 'w'), ensure_ascii=False)
    ok = sum(1 for v in res.values()
             if len(v['years']) == 4 and all('lift' in v['years'][y] for y in YEARS)
             and (min(v['years'][y]['lift'] for y in YEARS) > 0
                  or max(v['years'][y]['lift'] for y in YEARS) < 0))
    print(f'{group}: {len(res)} صيغة • {ok} اتفقت في السنوات الأربع')


if __name__ == '__main__':
    main()
