"""مكتبة أساليب تداول تُضاف كمدارس جديدة إلى جانب مدارس SYR30 التسع.

كل أسلوب يُنتج قناعي شراء وبيع بطول عدد الشموع، فيدخل في التصويت مثل أي مدرسة.
الأساليب هنا كلاسيكية معروفة، والغرض قياسها على نفس النوافذ لا افتراض نفعها.
"""
import datetime

import numpy as np


# ------------------------------------------------------------ أدوات

def ema(x, n):
    a = 2.0 / (n + 1)
    out = np.empty_like(x)
    out[0] = x[0]
    for i in range(1, len(x)):
        out[i] = a * x[i] + (1 - a) * out[i - 1]
    return out


def rma(x, n):
    a = 1.0 / n
    out = np.empty_like(x)
    out[0] = x[0]
    for i in range(1, len(x)):
        out[i] = a * x[i] + (1 - a) * out[i - 1]
    return out


def roll(x, n, fn):
    out = np.full(len(x), np.nan)
    if n <= len(x):
        from numpy.lib.stride_tricks import sliding_window_view
        out[n - 1:] = fn(sliding_window_view(x, n), axis=1)
    return out


def shift(x, k=1, fill=np.nan):
    out = np.full_like(x, fill, dtype=np.float64)
    if k > 0:
        out[k:] = x[:-k]
    return out


# ------------------------------------------------------------ الخصائص

def features(D):
    o, h, l, c, v, n = D['o'], D['h'], D['l'], D['c'], D['v'], D['n']
    F = {}
    tr = np.maximum(h - l, np.maximum(np.abs(h - shift(c, 1, c[0])),
                                      np.abs(l - shift(c, 1, c[0]))))
    F['atr14'] = rma(tr, 14) / 0.1                      # بالنقاط
    F['atr_ratio'] = F['atr14'] / np.maximum(roll(F['atr14'], 240, np.nanmean), 1e-9)
    F['ema20'] = ema(c, 20)
    F['ema50'] = ema(c, 50)
    F['ema200'] = ema(c, 200)

    d = np.diff(c, prepend=c[0])
    F['rsi3'] = 100 - 100 / (1 + rma(np.maximum(d, 0), 3) / np.maximum(rma(-np.minimum(d, 0), 3), 1e-9))
    F['rsi14'] = 100 - 100 / (1 + rma(np.maximum(d, 0), 14) / np.maximum(rma(-np.minimum(d, 0), 14), 1e-9))

    mean20 = roll(c, 20, np.nanmean)
    std20 = roll(c, 20, np.nanstd)
    F['bb_z'] = (c - mean20) / np.maximum(std20, 1e-9)

    for w in (20, 60, 240):
        hi, lo = roll(h, w, np.nanmax), roll(l, w, np.nanmin)
        F[f'pos{w}'] = 100 * (c - lo) / np.maximum(hi - lo, 1e-9)
        F[f'hi{w}'], F[f'lo{w}'] = hi, lo

    F['vol_ratio'] = v / np.maximum(roll(v, 60, np.nanmean), 1e-9)
    F['body'] = np.abs(c - o) / np.maximum(h - l, 1e-9)
    F['upwick'] = (h - np.maximum(o, c)) / np.maximum(h - l, 1e-9)
    F['dnwick'] = (np.minimum(o, c) - l) / np.maximum(h - l, 1e-9)

    # انحراف عن VWAP اليومي، بالنقاط
    day = np.array([d.toordinal() for d in D['dt']])
    newday = np.concatenate([[True], np.diff(day) != 0])
    tp = (h + l + c) / 3
    cum_pv = np.zeros(n)
    cum_v = np.zeros(n)
    acc_pv = acc_v = 0.0
    for i in range(n):
        if newday[i]:
            acc_pv = acc_v = 0.0
        acc_pv += tp[i] * v[i]
        acc_v += v[i]
        cum_pv[i], cum_v[i] = acc_pv, acc_v
    F['vwap'] = cum_pv / np.maximum(cum_v, 1e-9)
    F['vwap_dist'] = (c - F['vwap']) / 0.1

    F['to_dollar'] = np.minimum(c % 1.0, 1.0 - (c % 1.0)) / 0.1   # البعد عن الرقم المدوّر
    hour = np.array([d.hour for d in D['dt']])
    F['hour'] = hour
    F['sess_asia'] = (hour >= 0) & (hour < 7)
    F['sess_london'] = (hour >= 7) & (hour < 13)
    F['sess_ny'] = (hour >= 13) & (hour < 21)

    c60 = c[::-1]                                          # ميل الفريم الساعي تقريباً
    F['htf60_slope'] = (c - shift(c, 60, c[0])) / 0.1
    del c60
    return F


# ------------------------------------------------------------ الأساليب

def styles(D, F):
    """كل أسلوب: (قناع شراء، قناع بيع). الأسماء تدخل تقارير التركيبات."""
    o, h, l, c, n = D['o'], D['h'], D['l'], D['c'], D['n']
    ok = np.isfinite(F['atr14']) & np.isfinite(F['bb_z']) & (np.arange(n) > 250)
    S = {}

    S['ما_وراء_البولنجر'] = (ok & (F['bb_z'] < -2.0), ok & (F['bb_z'] > 2.0))
    S['ار_اس_اي_٣_متطرف'] = (ok & (F['rsi3'] < 8), ok & (F['rsi3'] > 92))
    S['اندفاع_حجم_مع_انهيار'] = (ok & (F['vol_ratio'] > 1.35) & (F['pos20'] < 5),
                                  ok & (F['vol_ratio'] > 1.35) & (F['pos20'] > 95))
    S['تقاطع_المتوسطات'] = (ok & (F['ema20'] > F['ema50']) & (shift(F['ema20']) <= shift(F['ema50'])),
                             ok & (F['ema20'] < F['ema50']) & (shift(F['ema20']) >= shift(F['ema50'])))
    S['كسر_دونشيان'] = (ok & (c > shift(F['hi60'])), ok & (c < shift(F['lo60'])))
    S['ارتداد_عن_VWAP'] = (ok & (F['vwap_dist'] < -15) & (c > o),
                            ok & (F['vwap_dist'] > 15) & (c < o))
    S['رفض_بذيل'] = (ok & (F['dnwick'] > 0.55) & (F['pos60'] < 25),
                      ok & (F['upwick'] > 0.55) & (F['pos60'] > 75))
    S['ابتلاع'] = (ok & (c > shift(o)) & (o < shift(c)) & (c > o) & (shift(c) < shift(o)),
                    ok & (c < shift(o)) & (o > shift(c)) & (c < o) & (shift(c) > shift(o)))
    S['انفجار_بعد_انكماش'] = (ok & (F['atr_ratio'] < 0.75) & (c > shift(F['hi20'])),
                               ok & (F['atr_ratio'] < 0.75) & (c < shift(F['lo20'])))
    S['هدوء_منتصف_اليوم'] = (ok & (F['atr14'] < 16) & (F['vol_ratio'] < 0.70) & F['sess_london'] & (F['pos20'] < 20),
                              ok & (F['atr14'] < 16) & (F['vol_ratio'] < 0.70) & F['sess_london'] & (F['pos20'] > 80))
    S['قرب_الرقم_المدور'] = (ok & (F['to_dollar'] < 1.5) & (F['pos60'] < 20),
                              ok & (F['to_dollar'] < 1.5) & (F['pos60'] > 80))
    S['استمرار_زخم'] = (ok & (c > o) & (shift(c) > shift(o)) & (F['body'] > 0.6) & (c > F['ema20']),
                         ok & (c < o) & (shift(c) < shift(o)) & (F['body'] > 0.6) & (c < F['ema20']))
    S['اصطفاف_الفريم_الساعي'] = (ok & (F['htf60_slope'] > 40) & (F['pos20'] < 30),
                                  ok & (F['htf60_slope'] < -40) & (F['pos20'] > 70))
    S['تشبع_مع_جلسة_نيويورك'] = (ok & F['sess_ny'] & (F['rsi14'] < 25), ok & F['sess_ny'] & (F['rsi14'] > 75))
    S['كسر_نطاق_آسيا'] = (ok & F['sess_london'] & (c > shift(F['hi240'])),
                           ok & F['sess_london'] & (c < shift(F['lo240'])))
    return S
