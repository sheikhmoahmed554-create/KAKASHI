"""كتالوج مفاهيم السوق: لكل مفهوم، شريحة الرقم ← عدد الحالات ← نتيجتها.

    PYTHONPATH=research/tools python3 research/tools/catalog.py <سنة> <ملف الخرج.json>

المبدأ: لا نسأل «هل المفهوم صحيح؟» بل «أي رقم فيه يسبق فعلاً حركة بمقدار هدفنا؟».
النتيجة المرجعية لكل شمعة: هل يتحقق هدف ٢×ATR قبل ستوب ٢.٦×ATR (النسبة ١.٣ التي
تحترم قيد صاحب المشروع في كل المدى). كل شيء بمضاعفات ATR، فلا رقم مطلق ينكسر
بين سنة وأخرى.

مسار الشمعة: شموع الدقيقة هي مسار شمعة الخمس دقائق، فنبني M5 من M1 ونعرف
لكل شمعة أكبر كيف تشكّلت — أيهما جاء أولاً القمة أم القاع، ومتى، وكم كانت
كفاءة الطريق. هذا ما تراه العين ولا يقوله OHLC.
"""
import csv
import gzip
import json
import sys

import numpy as np

TP_MULT, SL_RATIO, MAX_HOLD, PU = 2.0, 1.3, 480, 0.1
MIN_BUCKET = 300


def load(year):
    t, o, h, l, c, v = [], [], [], [], [], []
    with gzip.open('research/data/vault_utc.csv.gz', 'rt') as f:
        for r in csv.DictReader(f):
            if int(r['time'][:4]) != year:
                continue
            t.append(r['time'])
            o.append(float(r['open'])); h.append(float(r['high']))
            l.append(float(r['low'])); c.append(float(r['close']))
            v.append(float(r['volume']))
    return (t, *(np.array(x) for x in (o, h, l, c, v)))


def atr14(h, l, c):
    pc = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))
    out = np.empty(len(tr)); out[0] = tr[0]
    a = 1 / 14.
    for i in range(1, len(tr)):
        out[i] = a * tr[i] + (1 - a) * out[i - 1]
    return out / PU


def forward(h, l, c, ap):
    """لكل شمعة: هل يتحقق الهدف قبل الستوب، شراءً وبيعاً، بأهداف نسبية."""
    n = len(c)
    rb = np.zeros(n, np.int8); rs = np.zeros(n, np.int8)
    tp = TP_MULT * ap; sl = SL_RATIO * tp
    tpb, slb = c + tp * PU, c - sl * PU
    tps, sls = c - tp * PU, c + sl * PU
    ar = np.arange(n)
    for k in range(1, MAX_HOLD + 1):
        j = ar + k; ok = j < n; jj = np.where(ok, j, n - 1)
        hj, lj = h[jj], l[jj]
        m = ok & (rb == 0)
        s = m & (lj <= slb); w = m & (hj >= tpb) & ~s
        rb[s] = -1; rb[w] = 1
        m = ok & (rs == 0)
        s = m & (hj >= sls); w = m & (lj <= tps) & ~s
        rs[s] = -1; rs[w] = 1
    return rb, rs


def path_features(o, h, l, c, step=5):
    """مسار الشمعة الأكبر، مقروءاً من شموع الدقيقة داخلها.

    لكل شمعة M5 مبنية من ٥ شمعات M1 نعرف: أيهما سبق القمة أم القاع، وموضع
    الطرف داخلها، وكفاءة المسار (الإزاحة الصافية ÷ المسافة المقطوعة)."""
    n = len(c)
    first_hi = np.full(n, np.nan)      # ١ = القمة سبقت القاع
    when_ext = np.full(n, np.nan)      # موضع الطرف الحاسم داخل الشمعة، ٠..١
    eff = np.full(n, np.nan)           # كفاءة المسار
    for s in range(0, n - step, step):
        seg = slice(s, s + step)
        hh, ll = h[seg], l[seg]
        ih, il = int(np.argmax(hh)), int(np.argmin(ll))
        travel = np.abs(np.diff(c[seg])).sum() + abs(c[s] - o[s])
        net = abs(c[s + step - 1] - o[s])
        i_end = s + step - 1
        # القيم تُنسب إلى الشمعة التي تكتمل عندها المجموعة، فلا نظر للمستقبل
        first_hi[i_end] = 1.0 if ih < il else 0.0
        up = c[i_end] >= o[s]
        when_ext[i_end] = (ih if up else il) / (step - 1)
        eff[i_end] = net / travel if travel > 0 else np.nan
    return first_hi, when_ext, eff


def features(o, h, l, c, v, ap):
    n = len(c)
    rng = np.maximum(h - l, 1e-9)
    F = {}
    F['جسم_الشمعة٪'] = 100 * np.abs(c - o) / rng
    F['ذيل_علوي٪'] = 100 * (h - np.maximum(o, c)) / rng
    F['ذيل_سفلي٪'] = 100 * (np.minimum(o, c) - l) / rng
    F['موضع_الإغلاق٪'] = 100 * (c - l) / rng
    F['مدى_الشمعة_ATR'] = (rng / PU) / np.maximum(ap, 1e-9)

    prev = np.concatenate([[np.nan], c[:-1]])
    F['فجوة_الافتتاح_ATR'] = ((o - prev) / PU) / np.maximum(ap, 1e-9)

    # انكماش أو توسع: ATR الحالي مقابل متوسطه البعيد
    long_atr = np.convolve(ap, np.ones(240) / 240, mode='full')[:n]
    F['نظام_التذبذب'] = ap / np.maximum(long_atr, 1e-9)

    # عدّ الشموع المتتالية في اتجاه واحد
    up = (c > o).astype(int); run = np.zeros(n)
    for i in range(1, n):
        run[i] = run[i - 1] + 1 if up[i] == up[i - 1] else 1
    F['شموع_متتالية'] = run * np.where(up, 1, -1)

    # الموضع داخل نطاق ٦٠ شمعة: خصم أم علاوة
    from numpy.lib.stride_tricks import sliding_window_view
    hi60 = np.full(n, np.nan); lo60 = np.full(n, np.nan)
    hi60[59:] = sliding_window_view(h, 60).max(1)
    lo60[59:] = sliding_window_view(l, 60).min(1)
    F['الموضع_في_النطاق٪'] = 100 * (c - lo60) / np.maximum(hi60 - lo60, 1e-9)

    # عمق اختراق قاع/قمة ٦٠ شمعة السابقة، بمضاعف ATR — أساس سحب السيولة
    plo = np.concatenate([[np.nan], lo60[:-1]])
    phi = np.concatenate([[np.nan], hi60[:-1]])
    F['عمق_السحب_تحت_ATR'] = np.where(l < plo, ((plo - l) / PU) / np.maximum(ap, 1e-9), np.nan)
    F['عمق_السحب_فوق_ATR'] = np.where(h > phi, ((h - phi) / PU) / np.maximum(ap, 1e-9), np.nan)
    F['عمق_الكسر_فوق_ATR'] = np.where(c > phi, ((c - phi) / PU) / np.maximum(ap, 1e-9), np.nan)
    F['عمق_الكسر_تحت_ATR'] = np.where(c < plo, ((plo - c) / PU) / np.maximum(ap, 1e-9), np.nan)

    fh, we, eff = path_features(o, h, l, c)
    F['القمة_قبل_القاع'] = fh
    F['موضع_الطرف'] = we
    F['كفاءة_المسار'] = eff

    if v.max() > 0:
        vm = np.convolve(v, np.ones(60) / 60, mode='full')[:n]
        F['نسبة_الحجم'] = v / np.maximum(vm, 1e-9)
    return F


def buckets(x, q=(0, 10, 25, 50, 75, 90, 100)):
    fin = np.isfinite(x)
    if fin.sum() < MIN_BUCKET * 2:
        return None
    edges = np.unique(np.nanpercentile(x[fin], q))
    return edges if len(edges) >= 3 else None


def main():
    year = int(sys.argv[1])
    out_path = sys.argv[2]
    t, o, h, l, c, v = load(year)
    ap = atr14(h, l, c)
    rb, rs = forward(h, l, c, ap)
    F = features(o, h, l, c, v, ap)
    warm = np.arange(len(c)) > 300

    base_b = 100.0 * (rb[warm & (rb != 0)] == 1).mean()
    base_s = 100.0 * (rs[warm & (rs != 0)] == 1).mean()
    print(f'## {year} — {len(c)} شمعة • هدف {TP_MULT}×ATR • ستوب {SL_RATIO}× الهدف')
    print(f'خط الأساس: شراء {base_b:.2f}%  بيع {base_s:.2f}%\n')

    report = {'year': year, 'bars': len(c), 'base_buy': base_b, 'base_sell': base_s, 'features': {}}
    for name, x in F.items():
        edges = buckets(x)
        if edges is None:
            continue
        rows = []
        for a, b in zip(edges[:-1], edges[1:]):
            m = warm & np.isfinite(x) & (x >= a) & (x < b)
            for side, res, base in ((1, rb, base_b), (-1, rs, base_s)):
                mm = m & (res != 0)
                if mm.sum() < MIN_BUCKET:
                    continue
                wr = 100.0 * (res[mm] == 1).mean()
                rows.append({'from': round(float(a), 3), 'to': round(float(b), 3),
                             'side': side, 'n': int(mm.sum()),
                             'win_rate': round(wr, 2), 'lift': round(wr - base, 2)})
        if not rows:
            continue
        report['features'][name] = rows
        best = max(rows, key=lambda r: r['lift'])
        worst = min(rows, key=lambda r: r['lift'])
        print(f'{name}')
        for r in rows:
            mark = '  ←' if r is best or r is worst else ''
            print(f"   [{r['from']:>8.2f} → {r['to']:>8.2f}]  {'شراء' if r['side'] == 1 else 'بيع '}  "
                  f"{r['n']:>6}  {r['win_rate']:>6.2f}%  زيادة {r['lift']:>+6.2f}{mark}")
        print()

    json.dump(report, open(out_path, 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
