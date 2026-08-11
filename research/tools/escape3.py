"""بناء صفقة الهروب: أي تركيبة شروط تتجاوز التعادل في النصفين معاً؟

    PYTHONPATH=research/tools python3 research/tools/escape3.py

الجولة الثانية أعطت شرائح مفردة أقوى من التعادل. لكن الشريحة المفردة تكذب
بسهولة: تكفي سنة صاعدة لترفع كل شرائح الشراء. لذلك هنا:

  ١ — كل شرط يُقاس في ٢٠٢٥-ح٢ و٢٠٢٦ **منفصلين**، ولا يُقبل إلا إذا ربح فيهما معاً.
  ٢ — محاكاة متسلسلة بصفقة واحدة مفتوحة، دخول عند إغلاق شمعة الدقيقة فقط،
      ومستويات مجمّدة — أي القواعد التي لا تُكسر.
  ٣ — الستوب أكبر من الهدف بـ٢٠ نقطة، والهدف ٣٠ أو ٦٠.

النتيجة أرقام بسيطة: كم صفقة، كم ربحت، كم خسرت، ونسبة الربح في كل نصف.
"""
import csv
import gzip
import itertools
import json

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

PU = 0.1
HORIZON = 480
SETUPS = [(30, 50), (60, 80)]
FROM, TO = '2025-07-01', '2026-07-18'
SPLIT = '2026-01-01'
MIN_TRADES = 150


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
    """نتيجة كل شمعة لو فُتحت منها صفقة: ١ ربح ٠ خسارة -١ بلا حسم، وشمعة الخروج."""
    n = len(c)
    out = np.full(n, -1, np.int8)
    ex = np.full(n, n, np.int32)
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
        out[hitsl] = 0; ex[hitsl] = ar[hitsl] + k
        out[hittp] = 1; ex[hittp] = ar[hittp] + k
    return out, ex


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
    delta = np.diff(c, prepend=c[0])
    ag = np.empty(n); al = np.empty(n); ag[0] = al[0] = 0.
    for i in range(1, n):
        g = max(delta[i], 0.); ls = max(-delta[i], 0.)
        ag[i] = g / 14. + ag[i - 1] * 13 / 14.
        al[i] = ls / 14. + al[i - 1] * 13 / 14.
    rsi = 100 - 100 / (1 + ag / np.maximum(al, 1e-12))
    hour = np.array([int(x[11:13]) for x in t])
    vr = v / np.maximum(np.convolve(v, np.ones(60) / 60, mode='full')[:n], 1e-9)
    return {
        'atr': atr, 'regime': atr / np.maximum(long_atr, 1e-9),
        'pos': 100 * (c - lo60) / np.maximum(hi60 - lo60, 1e-9),
        'slope': ((c - back) / PU) / A,
        'closepos': 100 * (c - l) / rng,
        'sweepdn': np.where(l < plo, ((plo - l) / PU) / A, 0.0),
        'sweepup': np.where(h > phi, ((h - phi) / PU) / A, 0.0),
        'vr': vr, 'rsi': rsi, 'hour': hour.astype(float),
        'range': (rng / PU) / A,
    }


def conditions(F):
    """مكتبة الشروط: كل شرط قناع منطقي واحد، بجهة يقترحها القياس."""
    C = {}
    C['ساعة 20-23'] = (F['hour'] >= 20) & (F['hour'] < 23)
    C['ساعة 17-20'] = (F['hour'] >= 17) & (F['hour'] < 20)
    C['ساعة 5-11'] = (F['hour'] >= 5) & (F['hour'] < 11)
    C['ساعة 11-17'] = (F['hour'] >= 11) & (F['hour'] < 17)
    C['ساعة 23-5'] = (F['hour'] >= 23) | (F['hour'] < 5)
    C['RSI<36'] = F['rsi'] < 36
    C['RSI>64'] = F['rsi'] > 64
    C['RSI 50-58'] = (F['rsi'] >= 50) & (F['rsi'] < 58)
    C['RSI 42-50'] = (F['rsi'] >= 42) & (F['rsi'] < 50)
    C['قاع الساعة<12٪'] = F['pos'] < 12
    C['قمة الساعة>88٪'] = F['pos'] > 88
    C['وسط النطاق'] = (F['pos'] >= 27) & (F['pos'] < 79)
    C['حجم<0.53'] = F['vr'] < 0.53
    C['حجم 0.53-1.21'] = (F['vr'] >= 0.53) & (F['vr'] < 1.21)
    C['حجم>1.21'] = F['vr'] >= 1.21
    C['انكماش<0.75'] = F['regime'] < 0.75
    C['توسع>1.21'] = F['regime'] >= 1.21
    C['ATR<12'] = F['atr'] < 12
    C['ATR 12-27'] = (F['atr'] >= 12) & (F['atr'] < 27)
    C['ATR>27'] = F['atr'] >= 27
    C['ميل هابط'] = F['slope'] < -4.41
    C['ميل صاعد'] = F['slope'] > 5.49
    C['ميل عرضي'] = (F['slope'] >= -4.41) & (F['slope'] <= 5.49)
    C['سحب تحت≥1'] = F['sweepdn'] >= 1.0
    C['سحب فوق≥1'] = F['sweepup'] >= 1.0
    C['إغلاق قرب القاع'] = F['closepos'] < 25
    C['إغلاق قرب القمة'] = F['closepos'] > 75
    C['شمعة واسعة'] = F['range'] > 1.5
    C['شمعة ضيقة'] = F['range'] < 0.55
    return C


def simulate(sig, res, ex, half):
    """محاكاة متسلسلة: صفقة واحدة مفتوحة، دخول عند إغلاق الشمعة فقط."""
    n = len(sig)
    i = 0
    tr = [[0, 0], [0, 0]]   # [نصف][ربح/خسارة]
    idx = np.flatnonzero(sig)
    p = 0
    while p < len(idx):
        i = idx[p]
        r = res[i]
        if r >= 0:
            tr[half[i]][r] += 1
            j = ex[i]
        else:
            j = i + 1
        while p < len(idx) and idx[p] <= j:
            p += 1
    return tr


def main():
    t, o, h, l, c, v = load()
    n = len(c)
    F = features(t, o, h, l, c, v)
    C = conditions(F)
    warm = np.arange(n) > 300
    for k in C:
        C[k] = C[k] & warm & np.isfinite(F['pos']) & np.isfinite(F['slope'])
    half = np.array([1 if x[:10] >= SPLIT else 0 for x in t], np.int8)
    d1 = len({x[:10] for x in t if x[:10] < SPLIT})
    d2 = len({x[:10] for x in t if x[:10] >= SPLIT})
    print(f'{n} شمعة • ٢٠٢٥-ح٢ {d1} يوم • ٢٠٢٦ {d2} يوم\n')

    R = {}
    for tp, sl in SETUPS:
        for side in (1, -1):
            R[(tp, sl, side)] = resolve(h, l, c, tp, sl, side)

    rep = {}
    for tp, sl in SETUPS:
        be = 100.0 * sl / (tp + sl)
        print(f'\n{"="*96}\n### هدف {tp} • ستوب {sl} • التعادل {be:.1f}٪ '
              f'— لا يُقبل شرط إلا إذا تجاوز التعادل في النصفين معاً\n')
        rows = []
        names = list(C)
        combos = ([(x,) for x in names]
                  + list(itertools.combinations(names, 2))
                  + list(itertools.combinations(names, 3)))
        for combo in combos:
            m = C[combo[0]].copy()
            for k in combo[1:]:
                m &= C[k]
            if m.sum() < 1500:
                continue
            for side, sname in ((1, 'شراء'), (-1, 'بيع')):
                res, ex = R[(tp, sl, side)]
                tr = simulate(m, res, ex, half)
                a, b = tr[0], tr[1]
                na, nb = a[0] + a[1], b[0] + b[1]
                if na < MIN_TRADES or nb < MIN_TRADES:
                    continue
                wa = 100.0 * a[1] / na
                wb = 100.0 * b[1] / nb
                if wa <= be or wb <= be:
                    continue
                rows.append({'combo': ' + '.join(combo), 'side': sname,
                             'h2_2025': {'trades': na, 'wins': a[1], 'losses': a[0],
                                         'win_rate': round(wa, 2), 'per_day': round(na / d1, 1)},
                             '2026': {'trades': nb, 'wins': b[1], 'losses': b[0],
                                      'win_rate': round(wb, 2), 'per_day': round(nb / d2, 1)},
                             'worst': round(min(wa, wb), 2)})
        rows.sort(key=lambda r: -r['worst'])
        rep[f'{tp}/{sl}'] = {'breakeven': round(be, 2), 'passed': len(rows), 'rows': rows[:60]}
        print(f'نجح {len(rows)} تركيبة من {len(combos)} مُختبَرة (بالجهتين)\n')
        print(f"{'التركيبة':<52}{'الجهة':>6}{'٢٠٢٥-ح٢':>26}{'٢٠٢٦':>26}")
        print(f"{'':<58}{'صفقة  ربح/خسر  نسبة  /يوم':>26}{'صفقة  ربح/خسر  نسبة  /يوم':>26}")
        for r in rows[:30]:
            a, b = r['h2_2025'], r['2026']
            print(f"{r['combo'][:51]:<52}{r['side']:>6}"
                  f"{a['trades']:>7}{a['wins']:>5}/{a['losses']:<4}{a['win_rate']:>6.2f}%{a['per_day']:>5.1f}"
                  f"{b['trades']:>7}{b['wins']:>5}/{b['losses']:<4}{b['win_rate']:>6.2f}%{b['per_day']:>5.1f}")
    json.dump(rep, open('research/results/escape3.json', 'w'), ensure_ascii=False, indent=1)
    print('\n→ research/results/escape3.json')


if __name__ == '__main__':
    main()
