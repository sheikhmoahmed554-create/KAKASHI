"""الدفعة الثانية من الكتالوج: مفاهيم الهيكل والسيولة الأدق.

    python3 research/tools/catalog2.py <سنة> <الخرج.json>

المفاهيم: الكسر الفاشل • البرك المتساوية • تغيّر الطابع مقابل كسر الهيكل •
التباعد • الانكماش ثم التوسع • بُعد VWAP • مدى الافتتاح • ملء الفجوة.

الدخول دائماً عند إغلاق شمعة الدقيقة المؤكدة، والتقييم يبدأ من الشمعة التالية.
كل عتبة بمضاعف ATR. الهدف ٢×ATR والستوب ٢.٦×ATR.
"""
import csv
import gzip
import json
import sys

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

PU, TPM, SLR, MH, MIN_N = 0.1, 2.0, 1.3, 480, 60


def load(year):
    t, o, h, l, c, v = [], [], [], [], [], []
    with gzip.open('research/data/vault_utc.csv.gz', 'rt') as f:
        for r in csv.DictReader(f):
            if int(r['time'][:4]) != year:
                continue
            t.append(r['time'])
            o.append(float(r['open'])); h.append(float(r['high']))
            l.append(float(r['low'])); c.append(float(r['close'])); v.append(float(r['volume']))
    return t, *(np.array(x) for x in (o, h, l, c, v))


def atr14(h, l, c):
    pc = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))
    out = np.empty(len(tr)); out[0] = tr[0]
    for i in range(1, len(tr)):
        out[i] = tr[i] / 14. + out[i - 1] * 13 / 14.
    return out / PU


def forward(h, l, c, ap):
    n = len(c)
    rb = np.zeros(n, np.int8); rs = np.zeros(n, np.int8)
    tp = TPM * ap; sl = SLR * tp
    tpb, slb, tps, sls = c + tp * PU, c - sl * PU, c - tp * PU, c + sl * PU
    ar = np.arange(n)
    for k in range(1, MH + 1):
        j = ar + k; ok = j < n; jj = np.where(ok, j, n - 1)
        hj, lj = h[jj], l[jj]
        m = ok & (rb == 0); s = m & (lj <= slb); w = m & (hj >= tpb) & ~s
        rb[s] = -1; rb[w] = 1
        m = ok & (rs == 0); s = m & (hj >= sls); w = m & (lj <= tps) & ~s
        rs[s] = -1; rs[w] = 1
    return rb, rs


def roll(x, w, fn):
    out = np.full(len(x), np.nan)
    out[w - 1:] = fn(sliding_window_view(x, w), axis=1)
    return out


def prev(x):
    return np.concatenate([[np.nan], x[:-1]])


def signals(t, o, h, l, c, v, ap):
    """كل إشارة: قناع + جهة. الشرط يُقيَّم على شمعة مغلقة فقط."""
    n = len(c)
    S = {}
    hi60, lo60 = roll(h, 60, np.nanmax), roll(l, 60, np.nanmin)
    phi, plo = prev(hi60), prev(lo60)

    # كسر فاشل: أغلقت تحت القاع ثم عادت فوقه في شمعة لاحقة قريبة
    closed_below = c < plo
    for back in (1, 2, 3):
        was = np.concatenate([np.full(back, False), closed_below[:-back]])
        S[f'كسر_فاشل_تحت_بعد_{back}'] = (was & (c > plo), 1)
        was_up = np.concatenate([np.full(back, False), (c > phi)[:-back]])
        S[f'كسر_فاشل_فوق_بعد_{back}'] = (was_up & (c < phi), -1)

    # برك متساوية: قاعان متقاربان خلال ٦٠ شمعة ثم اختراقهما
    lo20 = roll(l, 20, np.nanmin); hi20 = roll(h, 20, np.nanmax)
    eq_lo = np.abs(prev(lo20) - plo) / np.maximum(ap * PU, 1e-9) < 0.25
    eq_hi = np.abs(prev(hi20) - phi) / np.maximum(ap * PU, 1e-9) < 0.25
    S['بركة_متساوية_تحت'] = (eq_lo & (l < plo) & (c > plo), 1)
    S['بركة_متساوية_فوق'] = (eq_hi & (h > phi) & (c < phi), -1)

    # الانكماش ثم التوسع
    long_atr = np.convolve(ap, np.ones(240) / 240, mode='full')[:n]
    squeeze = ap / np.maximum(long_atr, 1e-9)
    was_sq = np.concatenate([np.full(5, False), (squeeze < 0.7)[:-5]])
    S['انفجار_بعد_انكماش_صعوداً'] = (was_sq & (c > phi), 1)
    S['انفجار_بعد_انكماش_هبوطاً'] = (was_sq & (c < plo), -1)

    # التباعد: قاع سعري أدنى وزخم أعلى
    d = np.diff(c, prepend=c[0])
    up_ = np.maximum(d, 0); dn_ = -np.minimum(d, 0)
    ru = np.empty(n); rd = np.empty(n); ru[0] = up_[0]; rd[0] = dn_[0]
    for i in range(1, n):
        ru[i] = up_[i] / 14. + ru[i - 1] * 13 / 14.
        rd[i] = dn_[i] / 14. + rd[i - 1] * 13 / 14.
    rsi = 100 - 100 / (1 + ru / np.maximum(rd, 1e-9))
    lo_now = roll(l, 30, np.nanmin)
    rsi_lo = roll(rsi, 30, np.nanmin)
    S['تباعد_صاعد'] = ((l <= lo_now) & (rsi > prev(rsi_lo) + 5), 1)
    hi_now = roll(h, 30, np.nanmax); rsi_hi = roll(rsi, 30, np.nanmax)
    S['تباعد_هابط'] = ((h >= hi_now) & (rsi < prev(rsi_hi) - 5), -1)

    # بُعد عن VWAP اليومي
    day = np.array([x[:10] for x in t])
    newday = np.concatenate([[True], day[1:] != day[:-1]])
    tp3 = (h + l + c) / 3
    cpv = np.zeros(n); cv = np.zeros(n); apv = av = 0.0
    for i in range(n):
        if newday[i]:
            apv = av = 0.0
        apv += tp3[i] * max(v[i], 1); av += max(v[i], 1)
        cpv[i], cv[i] = apv, av
    vw = cpv / np.maximum(cv, 1e-9)
    dist = ((c - vw) / PU) / np.maximum(ap, 1e-9)
    S['تحت_VWAP_بمقدار'] = ((dist < -2.0) & (c > o), 1)
    S['فوق_VWAP_بمقدار'] = ((dist > 2.0) & (c < o), -1)

    # مدى الافتتاح: أول ٦٠ دقيقة من اليوم، ثم كسره
    idx_day = np.cumsum(newday) - 1
    first = np.zeros(n, bool)
    cnt = {}
    for i in range(n):
        k = idx_day[i]; cnt[k] = cnt.get(k, 0) + 1
        first[i] = cnt[k] <= 60
    orh = np.full(n, np.nan); orl = np.full(n, np.nan)
    ch = cl = np.nan
    for i in range(n):
        if newday[i]:
            ch = cl = np.nan
        if first[i]:
            ch = h[i] if not np.isfinite(ch) else max(ch, h[i])
            cl = l[i] if not np.isfinite(cl) else min(cl, l[i])
        orh[i], orl[i] = ch, cl
    S['كسر_مدى_الافتتاح_صعوداً'] = (~first & np.isfinite(orh) & (c > orh) & (prev(c) <= orh), 1)
    S['كسر_مدى_الافتتاح_هبوطاً'] = (~first & np.isfinite(orl) & (c < orl) & (prev(c) >= orl), -1)

    # الفجوة اليومية وملؤها
    gap = (o - prev(c)) / PU / np.maximum(ap, 1e-9)
    S['فجوة_هابطة_تُملأ'] = (newday & (gap < -1.0), 1)
    S['فجوة_صاعدة_تُملأ'] = (newday & (gap > 1.0), -1)
    return S


def main():
    year, out_path = int(sys.argv[1]), sys.argv[2]
    t, o, h, l, c, v = load(year)
    ap = atr14(h, l, c)
    rb, rs = forward(h, l, c, ap)
    warm = np.arange(len(c)) > 300
    base_b = 100.0 * (rb[warm & (rb != 0)] == 1).mean()
    base_s = 100.0 * (rs[warm & (rs != 0)] == 1).mean()
    print(f'## {year} — أساس شراء {base_b:.2f}%  بيع {base_s:.2f}%\n')
    rep = {'year': year, 'base_buy': base_b, 'base_sell': base_s, 'signals': {}}
    for name, (mask, side) in signals(t, o, h, l, c, v, ap).items():
        res, base = (rb, base_b) if side == 1 else (rs, base_s)
        m = warm & np.nan_to_num(mask, nan=False).astype(bool) & (res != 0)
        if m.sum() < MIN_N:
            continue
        wr = 100.0 * (res[m] == 1).mean()
        rep['signals'][name] = {'n': int(m.sum()), 'side': side,
                                'win_rate': round(wr, 2), 'lift': round(wr - base, 2)}
        print(f"{name:<30}{'شراء' if side == 1 else 'بيع '}  {m.sum():>6}  "
              f"{wr:>6.2f}%  زيادة {wr - base:>+6.2f}")
    json.dump(rep, open(out_path, 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
