"""هدف الهروب بهيكل صفقتك: هدف ٦٠ وستوب ٨٠ — أين ينجح فعلاً؟

    PYTHONPATH=research/tools python3 research/tools/escape2.py

الجولة الأولى قاست «كم مرة تحدث حركة ٦٠ نظيفة» فوجدتها تحدث صعوداً وهبوطاً
بنفس النسبة تقريباً — أي أنها موجودة لكن اتجاهها غير معروف. وهذا لا يفيد.

هنا نقيس الشيء الذي يدفع الحساب: من إغلاق كل شمعة، لو فتحنا صفقة بهدف T
وستوب S (والقاعدة: الستوب أكبر من الهدف بما لا يزيد عن ٢٠)، أيهما يُلمس أولاً؟
ثم نسأل: في أي حالة سوق يميل الجواب إلى جهة واحدة؟

نقطة التعادل = S ÷ (T+S). كل ما فوقها ربح، وكل ما تحتها خسارة مهما بدا الرقم كبيراً.
السوق الحالي فقط: النصف الثاني من ٢٠٢٥ و٢٠٢٦.
"""
import csv
import gzip
import json

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

PU = 0.1
HORIZON = 480          # ٨ ساعات: أبعد من أي صفقة سكالب، فالحسم شبه مؤكد
SETUPS = [(30, 50), (40, 60), (50, 70), (60, 80)]
FROM, TO = '2025-07-01', '2026-07-18'


def load():
    t, o, h, l, c, v = [], [], [], [], [], []
    with gzip.open('research/data/vault_utc.csv.gz', 'rt') as f:
        for r in csv.DictReader(f):
            if not (FROM <= r['time'][:10] < TO):
                continue
            t.append(r['time'])
            o.append(float(r['open'])); h.append(float(r['high']))
            l.append(float(r['low'])); c.append(float(r['close'])); v.append(float(r['volume']))
    return t, *(np.array(x) for x in (o, h, l, c, v))


def resolve(h, l, c, tp_pts, sl_pts, side):
    """أيهما يُلمس أولاً: الهدف أم الستوب؟ ١ ربح • ٠ خسارة • -١ لم يُحسم.

    عند لمسهما في نفس الشمعة نحتسبها خسارة — هذا عرف TradingView وهو الأمان.
    """
    n = len(c)
    out = np.full(n, -1, np.int8)
    tp = c + side * tp_pts * PU
    sl = c - side * sl_pts * PU
    ar = np.arange(n)
    for k in range(1, HORIZON + 1):
        j = np.minimum(ar + k, n - 1)
        live = (out == -1) & (ar + k < n)
        if not live.any():
            break
        if side == 1:
            hitsl = live & (l[j] <= sl)
            hittp = live & (h[j] >= tp) & ~hitsl
        else:
            hitsl = live & (h[j] >= sl)
            hittp = live & (l[j] <= tp) & ~hitsl
        out[hitsl] = 0
        out[hittp] = 1
    return out


def features(t, o, h, l, c, v):
    n = len(c)
    pc = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))
    atr = np.empty(n); atr[0] = tr[0]
    for i in range(1, n):
        atr[i] = tr[i] / 14. + atr[i - 1] * 13 / 14.
    atr /= PU
    A = np.maximum(atr, 1e-9)
    long_atr = np.convolve(atr, np.ones(240) / 240, mode='full')[:n]
    back = np.concatenate([np.full(120, np.nan), c[:-120]])
    rng = np.maximum(h - l, 1e-9)

    hi60 = np.full(n, np.nan); lo60 = np.full(n, np.nan)
    hi60[59:] = sliding_window_view(h, 60).max(1)
    lo60[59:] = sliding_window_view(l, 60).min(1)
    phi = np.concatenate([[np.nan], hi60[:-1]])
    plo = np.concatenate([[np.nan], lo60[:-1]])

    # سلسلة الشموع المتتالية بإشارة: +٣ ثلاث خضراء، -٣ ثلاث حمراء
    up = (c > o).astype(int) - (c < o).astype(int)
    run = np.zeros(n, int)
    for i in range(1, n):
        run[i] = run[i - 1] + up[i] if up[i] and np.sign(run[i - 1]) in (0, up[i]) else up[i]

    d = np.array([x[:10] for x in t])
    newday = np.concatenate([[True], d[1:] != d[:-1]])
    dopen = np.where(newday, o, np.nan)
    for i in range(1, n):
        if not newday[i]:
            dopen[i] = dopen[i - 1]

    delta = np.diff(c, prepend=c[0])
    gain = np.where(delta > 0, delta, 0.); loss = np.where(delta < 0, -delta, 0.)
    ag = np.empty(n); al = np.empty(n); ag[0] = al[0] = 0.
    for i in range(1, n):
        ag[i] = gain[i] / 14. + ag[i - 1] * 13 / 14.
        al[i] = loss[i] / 14. + al[i - 1] * 13 / 14.
    rsi = 100 - 100 / (1 + ag / np.maximum(al, 1e-12))

    hour = np.array([int(x[11:13]) for x in t])

    return atr, {
        'ATR بالنقاط': atr,
        'نظام التذبذب': atr / np.maximum(long_atr, 1e-9),
        'الموضع في نطاق ساعة٪': 100 * (c - lo60) / np.maximum(hi60 - lo60, 1e-9),
        'انحدار ساعتين ×ATR': ((c - back) / PU) / A,
        'مدى الشمعة ×ATR': (rng / PU) / A,
        'موضع الإغلاق٪': 100 * (c - l) / rng,
        'سحب تحت قاع الساعة ×ATR': np.where(l < plo, ((plo - l) / PU) / A, 0.0),
        'سحب فوق قمة الساعة ×ATR': np.where(h > phi, ((h - phi) / PU) / A, 0.0),
        'نسبة الحجم': v / np.maximum(np.convolve(v, np.ones(60) / 60, mode='full')[:n], 1e-9),
        'شموع متتالية': run.astype(float),
        'البعد عن افتتاح اليوم ×ATR': ((c - dopen) / PU) / A,
        'RSI': rsi,
        'الساعة UTC': hour.astype(float),
    }


def main():
    t, o, h, l, c, v = load()
    n = len(c)
    days = len({x[:10] for x in t})
    atr, F = features(t, o, h, l, c, v)
    warm = np.arange(n) > 300
    print(f'{n} شمعة • {days} يوم • ATR وسيط {np.median(atr):.0f} نقطة\n')

    print('### الأساس: لو دخلنا كل شمعة بلا شرط\n')
    print(f"{'الهيكل':<16}{'التعادل':>10}{'شراء':>10}{'بيع':>10}{'الأفضل':>10}")
    rep = {'setups': {}}
    resolved = {}
    for tp, sl in SETUPS:
        be = 100.0 * sl / (tp + sl)
        rl = resolve(h, l, c, tp, sl, 1)
        rs = resolve(h, l, c, tp, sl, -1)
        resolved[(tp, sl)] = (rl, rs)
        ml, ms = warm & (rl >= 0), warm & (rs >= 0)
        wl = 100.0 * rl[ml].mean(); ws = 100.0 * rs[ms].mean()
        rep['setups'][f'{tp}/{sl}'] = {'breakeven': round(be, 2),
                                       'buy': round(wl, 2), 'sell': round(ws, 2)}
        print(f"{f'هدف {tp} ستوب {sl}':<16}{be:>9.1f}%{wl:>9.2f}%{ws:>9.2f}%{max(wl, ws) - be:>+9.2f}")

    # الهيكل الذي يطلبه صاحب المشروع كأقصى هدف: ٦٠ / ٨٠
    tp, sl = 60, 80
    be = 100.0 * sl / (tp + sl)
    rl, rs = resolved[(tp, sl)]
    print(f'\n### هدف {tp} ستوب {sl} — نقطة التعادل {be:.1f}٪. أين تُتجاوز؟\n')
    print(f"{'الشريحة':<38}{'شموع':>8}{'شراء':>9}{'بيع':>9}{'فوق التعادل':>13}")
    cells = {}
    for name, x in F.items():
        fin = warm & np.isfinite(x)
        qs = np.unique(np.nanpercentile(x[fin], [0, 10, 25, 50, 75, 90, 100]))
        for a_, b_ in zip(qs[:-1], qs[1:]):
            m = fin & (x >= a_) & (x < b_)
            ml, ms = m & (rl >= 0), m & (rs >= 0)
            if ml.sum() < 3000 or ms.sum() < 3000:
                continue
            wl = 100.0 * rl[ml].mean(); ws = 100.0 * rs[ms].mean()
            edge = max(wl, ws) - be
            key = f'{name} [{a_:.2f}→{b_:.2f}]'
            cells[key] = {'n': int(m.sum()), 'buy': round(wl, 2), 'sell': round(ws, 2),
                          'edge': round(edge, 2)}
            if edge > 0:
                print(f"{key[:37]:<38}{m.sum():>8}{wl:>8.2f}%{ws:>8.2f}%{edge:>+12.2f}")
    rep['cells_60_80'] = cells
    top = sorted(cells.items(), key=lambda kv: -kv[1]['edge'])[:12]
    print('\n### أقوى ١٢ شريحة (بأي هيكل تُقاس لاحقاً)\n')
    print(f"{'الشريحة':<38}{'شموع':>8}{'الجهة':>7}{'النسبة':>9}{'فوق التعادل':>13}")
    for k, v_ in top:
        side = 'شراء' if v_['buy'] >= v_['sell'] else 'بيع'
        wr = max(v_['buy'], v_['sell'])
        print(f"{k[:37]:<38}{v_['n']:>8}{side:>7}{wr:>8.2f}%{v_['edge']:>+12.2f}")
    json.dump(rep, open('research/results/escape2.json', 'w'), ensure_ascii=False, indent=1)
    print('\n→ research/results/escape2.json')


if __name__ == '__main__':
    main()
