"""الكتالوج الكامل: كل المفاهيم المتفق عليها، على كل السنوات، بجدول واحد.

    python3 research/tools/fullcatalog.py <سنة> <الخرج.json>

كل خاصية تُقسَّم إلى شرائح، وتُقاس كل شريحة بجهتيها مقابل الدخول العشوائي في
نفس السنة. الدخول عند إغلاق شمعة الدقيقة المؤكدة، والهدف ٢×ATR والستوب ٢.٦×ATR.
لا رقم مطلق: كل شيء بمضاعف ATR أو بنسبة.
"""
import csv
import gzip
import json
import sys

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

PU, TPM, SLR, MH, MIN_N = 0.1, 2.0, 1.3, 480, 250


def load(year):
    t, o, h, l, c, v, sp = [], [], [], [], [], [], []
    with gzip.open('research/data/vault_utc.csv.gz', 'rt') as f:
        for r in csv.DictReader(f):
            if int(r['time'][:4]) != year:
                continue
            t.append(r['time'])
            o.append(float(r['open'])); h.append(float(r['high'])); l.append(float(r['low']))
            c.append(float(r['close'])); v.append(float(r['volume'])); sp.append(float(r['spread']))
    return t, *(np.array(x) for x in (o, h, l, c, v, sp))


def rma(x, n):
    out = np.empty(len(x)); out[0] = x[0]
    a = 1. / n
    for i in range(1, len(x)):
        out[i] = a * x[i] + (1 - a) * out[i - 1]
    return out


def roll(x, w, fn):
    out = np.full(len(x), np.nan)
    if w <= len(x):
        out[w - 1:] = fn(sliding_window_view(x, w), axis=1)
    return out


def prev(x, k=1):
    return np.concatenate([np.full(k, np.nan), x[:-k]])


def build(t, o, h, l, c, v, sp):
    n = len(c)
    pc = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))
    ap = rma(tr, 14) / PU                      # ATR بالنقاط
    A = np.maximum(ap, 1e-9)
    rng = np.maximum(h - l, 1e-9)
    F = {}

    # ── الشمعة: الجسم والذيول وأين تُغلق
    F['جسم٪'] = 100 * np.abs(c - o) / rng
    F['ذيل_علوي٪'] = 100 * (h - np.maximum(o, c)) / rng
    F['ذيل_سفلي٪'] = 100 * (np.minimum(o, c) - l) / rng
    F['موضع_الإغلاق٪'] = 100 * (c - l) / rng
    F['مدى_الشمعة_ATR'] = (rng / PU) / A
    F['جسم_ATR'] = (np.abs(c - o) / PU) / A

    # ── مسار الشمعة الأكبر، مقروءاً من شموع الدقيقة داخلها
    for step in (5, 15):
        fh = np.full(n, np.nan); we = np.full(n, np.nan); eff = np.full(n, np.nan)
        for s in range(0, n - step, step):
            hh, ll = h[s:s + step], l[s:s + step]
            ih, il = int(np.argmax(hh)), int(np.argmin(ll))
            travel = np.abs(np.diff(c[s:s + step])).sum() + abs(c[s] - o[s])
            e = s + step - 1
            fh[e] = 1.0 if ih < il else 0.0
            we[e] = (ih if c[e] >= o[s] else il) / (step - 1)
            eff[e] = abs(c[e] - o[s]) / travel if travel > 0 else np.nan
        F[f'القمة_قبل_القاع_{step}'] = fh
        F[f'موضع_الطرف_{step}'] = we
        F[f'كفاءة_المسار_{step}'] = eff

    # ── الهيكل: النطاقات والاختراقات والكسور
    for w in (20, 60, 240):
        hi, lo = roll(h, w, np.nanmax), roll(l, w, np.nanmin)
        ph, pl = prev(hi), prev(lo)
        F[f'الموضع_في_نطاق_{w}٪'] = 100 * (c - lo) / np.maximum(hi - lo, 1e-9)
        F[f'عرض_النطاق_{w}_ATR'] = ((hi - lo) / PU) / A
        F[f'سحب_تحت_{w}_ATR'] = np.where(l < pl, ((pl - l) / PU) / A, np.nan)
        F[f'سحب_فوق_{w}_ATR'] = np.where(h > ph, ((h - ph) / PU) / A, np.nan)
        F[f'كسر_تحت_{w}_ATR'] = np.where(c < pl, ((pl - c) / PU) / A, np.nan)
        F[f'كسر_فوق_{w}_ATR'] = np.where(c > ph, ((c - ph) / PU) / A, np.nan)

    # ── الاتجاه والزخم
    for w in (30, 120, 480):
        F[f'انحدار_{w}_ATR'] = ((c - prev(c, w)) / PU) / A
    ema = {}
    for p in (20, 50, 200):
        k = 2. / (p + 1); e = np.empty(n); e[0] = c[0]
        for i in range(1, n):
            e[i] = k * c[i] + (1 - k) * e[i - 1]
        ema[p] = e
        F[f'البعد_عن_EMA{p}_ATR'] = ((c - e) / PU) / A
    F['ترتيب_المتوسطات'] = np.sign(ema[20] - ema[50]) + np.sign(ema[50] - ema[200])

    d = np.diff(c, prepend=c[0])
    for p in (3, 14):
        ru, rd = rma(np.maximum(d, 0), p), rma(-np.minimum(d, 0), p)
        F[f'RSI{p}'] = 100 - 100 / (1 + ru / np.maximum(rd, 1e-9))
    F['تسارع_ATR'] = ((c - prev(c, 5)) - (prev(c, 5) - prev(c, 10))) / PU / A

    up = (c > o).astype(int); run = np.zeros(n)
    for i in range(1, n):
        run[i] = run[i - 1] + 1 if up[i] == up[i - 1] else 1
    F['شموع_متتالية'] = run * np.where(up, 1, -1)

    # ── التذبذب: الانكماش والتوسع
    long_atr = np.convolve(ap, np.ones(240) / 240, mode='full')[:n]
    F['نظام_التذبذب'] = ap / np.maximum(long_atr, 1e-9)
    F['ATR_بالنقاط'] = ap

    # ── التصحيح: عمق الارتداد داخل موجة، وهو سؤال فيبوناتشي
    hi60, lo60 = roll(h, 60, np.nanmax), roll(l, 60, np.nanmin)
    wave = np.maximum(hi60 - lo60, 1e-9)
    F['عمق_التصحيح_من_القمة٪'] = 100 * (hi60 - c) / wave
    F['عمق_التصحيح_من_القاع٪'] = 100 * (c - lo60) / wave

    # ── مستويات مرجعية: اليوم السابق، والافتتاح، والرقم المدوّر
    day = np.array([x[:10] for x in t])
    newday = np.concatenate([[True], day[1:] != day[:-1]])
    dh = dl = dop = np.nan
    pdh = np.full(n, np.nan); pdl = np.full(n, np.nan); dopen = np.full(n, np.nan)
    ch = cl = -np.inf, np.inf
    curh, curl = -np.inf, np.inf
    for i in range(n):
        if newday[i]:
            dh, dl = (curh if curh > -np.inf else np.nan), (curl if curl < np.inf else np.nan)
            curh, curl = h[i], l[i]
            dop = o[i]
        else:
            curh = max(curh, h[i]); curl = min(curl, l[i])
        pdh[i], pdl[i], dopen[i] = dh, dl, dop
    F['البعد_عن_قمة_أمس_ATR'] = ((c - pdh) / PU) / A
    F['البعد_عن_قاع_أمس_ATR'] = ((c - pdl) / PU) / A
    F['البعد_عن_افتتاح_اليوم_ATR'] = ((c - dopen) / PU) / A
    F['البعد_عن_الرقم_المدور_ATR'] = (np.minimum(c % 1.0, 1.0 - (c % 1.0)) / PU) / A

    # ── VWAP اليومي
    tp3 = (h + l + c) / 3
    cpv = np.zeros(n); cv = np.zeros(n); apv = av = 0.0
    for i in range(n):
        if newday[i]:
            apv = av = 0.0
        w_ = max(v[i], 1.0)
        apv += tp3[i] * w_; av += w_
        cpv[i], cv[i] = apv, av
    F['البعد_عن_VWAP_ATR'] = ((c - cpv / np.maximum(cv, 1e-9)) / PU) / A

    # ── الفجوة عند الافتتاح
    F['فجوة_الافتتاح_ATR'] = ((o - prev(c)) / PU) / A

    # ── الوقت
    F['الساعة'] = np.array([int(x[11:13]) for x in t], float)
    F['يوم_الأسبوع'] = np.array([__import__('datetime').date(int(x[:4]), int(x[5:7]),
                                                             int(x[8:10])).weekday() for x in t], float)

    # ── الحجم والسبريد، متى توفّرا
    if v.max() > 0:
        vm = np.convolve(v, np.ones(60) / 60, mode='full')[:n]
        F['نسبة_الحجم'] = v / np.maximum(vm, 1e-9)
        F['الجهد_مقابل_النتيجة'] = (rng / PU) / np.maximum(v, 1.0)
    if sp.max() > 0:
        F['السبريد_ATR'] = sp / A
    return F, ap


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


def main():
    year, out_path = int(sys.argv[1]), sys.argv[2]
    t, o, h, l, c, v, sp = load(year)
    F, ap = build(t, o, h, l, c, v, sp)
    rb, rs = forward(h, l, c, ap)
    warm = np.arange(len(c)) > 500
    base_b = 100.0 * (rb[warm & (rb != 0)] == 1).mean()
    base_s = 100.0 * (rs[warm & (rs != 0)] == 1).mean()

    rep = {'year': year, 'bars': len(c), 'base_buy': base_b, 'base_sell': base_s, 'f': {}}
    for name, x in F.items():
        fin = np.isfinite(x)
        if fin.sum() < MIN_N * 3:
            continue
        edges = np.unique(np.nanpercentile(x[fin], [0, 10, 25, 50, 75, 90, 100]))
        if len(edges) < 3:
            continue
        rows = []
        for a, b in zip(edges[:-1], edges[1:]):
            m0 = warm & fin & (x >= a) & (x < b)
            for side, res, base in ((1, rb, base_b), (-1, rs, base_s)):
                m = m0 & (res != 0)
                if m.sum() < MIN_N:
                    continue
                wr = 100.0 * (res[m] == 1).mean()
                rows.append({'from': round(float(a), 4), 'to': round(float(b), 4),
                             'side': side, 'n': int(m.sum()),
                             'wr': round(wr, 2), 'lift': round(wr - base, 2)})
        if rows:
            rep['f'][name] = rows
    json.dump(rep, open(out_path, 'w'), ensure_ascii=False)
    print(f'{year}: {len(rep["f"])} خاصية • أساس شراء {base_b:.2f}% بيع {base_s:.2f}%')


if __name__ == '__main__':
    main()
