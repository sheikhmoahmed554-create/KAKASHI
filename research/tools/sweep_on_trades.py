"""مسح آلاف الإعدادات على صفقات المؤشر نفسها — بلا تشغيل المحرك.

    PYTHONPATH=research/tools python3 research/tools/sweep_on_trades.py <ملف الصفقات.jsonl>

تشغيل المحرك على ١٣ شهراً يأخذ ساعات، فلا يمكن تكرار ذلك ٥٠ مرة لكل مفهوم.
لكن المحرك لا يلزم إلا مرة واحدة: يعطينا **صفقات المؤشر الفعلية** بأوقاتها
وجهاتها ونتائجها. وبعدها كل مرشّح مجرّد سؤال عن قيمة عند شمعة الدخول، فتُمسح
آلاف الإعدادات في ثوانٍ على نفس الصفقات بالضبط.

القاعدة التي لا تُكسر هنا: المرشّح لا يضيف صفقة، يمنعها فقط. فالنتيجة الصادقة
هي «كم بقي، وكم منها ربح» — لا نسبة على عيّنة أخرى.

وكل مرشّح يُقاس في ٢٠٢٥-ح٢ و٢٠٢٦ منفصلين، ولا يُقبل إلا إذا رفع النسبة فيهما معاً.
"""
import csv
import datetime
import gzip
import json
import sys
from collections import defaultdict

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

PU = 0.1
SPLIT = '2026-01-01'
MIN_KEEP = 0.55          # لا نقبل مرشّحاً يُبقي أقل من هذه النسبة من الصفقات


def bars(lo, hi):
    t, o, h, l, c, v = [], [], [], [], [], []
    with gzip.open('research/data/vault_utc.csv.gz', 'rt') as f:
        for r in csv.DictReader(f):
            if not (lo <= r['time'][:10] <= hi):
                continue
            t.append(r['time'])
            o.append(float(r['open'])); h.append(float(r['high']))
            l.append(float(r['low'])); c.append(float(r['close'])); v.append(float(r['volume']))
    return t, *(np.array(x) for x in (o, h, l, c, v))


def series(t, o, h, l, c, v):
    n = len(c)
    pc = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))
    atr = np.empty(n); atr[0] = tr[0]
    for i in range(1, n):
        atr[i] = tr[i] / 14. + atr[i - 1] * 13 / 14.
    atr /= PU
    A = np.maximum(atr, 1e-9)
    rng = np.maximum(h - l, 1e-9)
    delta = np.diff(c, prepend=c[0])
    ag = np.empty(n); al = np.empty(n); ag[0] = al[0] = 0.
    for i in range(1, n):
        ag[i] = max(delta[i], 0.) / 14. + ag[i - 1] * 13 / 14.
        al[i] = max(-delta[i], 0.) / 14. + al[i - 1] * 13 / 14.
    rsi = 100 - 100 / (1 + ag / np.maximum(al, 1e-12))

    S = {'atr': atr, 'closepos': 100 * (c - l) / rng, 'range': (rng / PU) / A, 'rsi': rsi}
    for w in (30, 60, 120, 240, 480):
        av = np.convolve(atr, np.ones(w) / w, mode='full')[:n]
        S[f'regime{w}'] = atr / np.maximum(av, 1e-9)
        va = np.convolve(v, np.ones(w) / w, mode='full')[:n]
        S[f'vol{w}'] = v / np.maximum(va, 1e-9)
        hi = np.full(n, np.nan); lo = np.full(n, np.nan)
        hi[w - 1:] = sliding_window_view(h, w).max(1)
        lo[w - 1:] = sliding_window_view(l, w).min(1)
        S[f'pos{w}'] = 100 * (c - lo) / np.maximum(hi - lo, 1e-9)
        phi = np.concatenate([[np.nan], hi[:-1]]); plo = np.concatenate([[np.nan], lo[:-1]])
        S[f'swdn{w}'] = np.where(l < plo, ((plo - l) / PU) / A, 0.0)
        S[f'swup{w}'] = np.where(h > phi, ((h - phi) / PU) / A, 0.0)
        back = np.concatenate([np.full(w, np.nan), c[:-w]])
        S[f'slope{w}'] = ((c - back) / PU) / A
    up = (c > o).astype(int) - (c < o).astype(int)
    run = np.zeros(n, int)
    for i in range(1, n):
        run[i] = run[i - 1] + up[i] if up[i] and np.sign(run[i - 1]) in (0, up[i]) else up[i]
    S['run'] = run.astype(float)
    S['hour'] = np.array([float(x[11:13]) for x in t])
    return S


def grid():
    """المرشّحات وإعداداتها — لكل مفهوم عشرات القيم، لا قيمة واحدة مختارة سلفاً."""
    G = []
    for w in (30, 60, 120, 240, 480):
        for lo in (0.55, 0.65, 0.75, 0.85, 0.95):
            G.append((f'نظام{w} امنع الشراء تحت {lo}', f'regime{w}', 'buy_min', lo))
        for hi in (1.05, 1.15, 1.25, 1.40, 1.60):
            G.append((f'نظام{w} امنع البيع فوق {hi}', f'regime{w}', 'sell_max', hi))
        for hi in (70., 80., 88., 94.):
            G.append((f'موضع{w} امنع الشراء فوق {hi:.0f}٪', f'pos{w}', 'buy_max', hi))
        for lo in (6., 12., 20., 30.):
            G.append((f'موضع{w} امنع البيع تحت {lo:.0f}٪', f'pos{w}', 'sell_min', lo))
        for d in (0.3, 0.6, 1.0, 1.5, 2.0):
            G.append((f'سحب{w} تحت ≥{d}', f'swdn{w}', 'buy_min', d))
            G.append((f'سحب{w} فوق ≥{d}', f'swup{w}', 'sell_min', d))
        for s in (0.53, 0.75, 1.00, 1.30):
            G.append((f'حجم{w} امنع الشراء فوق {s}', f'vol{w}', 'buy_max', s))
            G.append((f'حجم{w} امنع البيع تحت {s}', f'vol{w}', 'sell_min', s))
        for s in (-12., -6., -3., 0., 3., 6., 12.):
            G.append((f'ميل{w} امنع الشراء تحت {s:.0f}', f'slope{w}', 'buy_min', s))
            G.append((f'ميل{w} امنع البيع فوق {s:.0f}', f'slope{w}', 'sell_max', s))
    for x in (30., 36., 42., 50., 58., 64., 70.):
        G.append((f'RSI امنع الشراء فوق {x:.0f}', 'rsi', 'buy_max', x))
        G.append((f'RSI امنع البيع تحت {x:.0f}', 'rsi', 'sell_min', x))
    for x in (8., 12., 16., 20., 25., 30., 40.):
        G.append((f'ATR امنع الكل تحت {x:.0f}', 'atr', 'both_min', x))
        G.append((f'ATR امنع الكل فوق {x:.0f}', 'atr', 'both_max', x))
    for x in (20., 30., 40., 50., 60., 70., 80.):
        G.append((f'إغلاق امنع الشراء فوق {x:.0f}٪', 'closepos', 'buy_max', x))
        G.append((f'إغلاق امنع البيع تحت {x:.0f}٪', 'closepos', 'sell_min', x))
    for x in (0.5, 0.7, 0.9, 1.2, 1.5, 2.0):
        G.append((f'مدى الشمعة امنع الكل تحت {x}', 'range', 'both_min', x))
        G.append((f'مدى الشمعة امنع الكل فوق {x}', 'range', 'both_max', x))
    for x in (1., 2., 3., 4., 5.):
        G.append((f'اشترط {x:.0f} شموع هابطة للشراء', 'run', 'buy_max', -x))
        G.append((f'اشترط {x:.0f} شموع صاعدة للبيع', 'run', 'sell_min', x))
    return G


def apply(kind, val, x, is_buy):
    """قناع «هل تُسمح هذه الصفقة». المرشّح يمنع فقط، ولا يضيف صفقة أبداً."""
    if kind == 'buy_min':
        return ~is_buy | (x >= val)
    if kind == 'buy_max':
        return ~is_buy | (x <= val)
    if kind == 'sell_min':
        return is_buy | (x >= val)
    if kind == 'sell_max':
        return is_buy | (x <= val)
    if kind == 'both_min':
        return x >= val
    return x <= val


def main(path):
    rows = []
    seen = set()
    for ln in open(path):
        ln = ln.strip()
        if not ln:
            continue
        r = json.loads(ln)
        if r[0] in seen:
            continue
        seen.add(r[0])
        rows.append(r)
    rows.sort(key=lambda r: r[0])
    times = [r[0] for r in rows]
    lo, hi = times[0][:10], times[-1][:10]
    t, o, h, l, c, v = bars(lo, hi)
    S = series(t, o, h, l, c, v)
    idx = {x: i for i, x in enumerate(t)}
    keep = [(i, r) for i, r in ((idx.get(r[0].replace('Z', '')[:16]), r) for r in rows) if i is not None]
    if len(keep) < len(rows) * 0.9:
        keep = []
        for r in rows:
            k = r[0][:16].replace('T', ' ')
            for cand in (r[0][:16], r[0][:16] + ':00', k):
                if cand in idx:
                    keep.append((idx[cand], r)); break
    bi = np.array([k[0] for k in keep])
    is_buy = np.array([k[1][1] == 'BUY' for k in keep])
    win = np.array([k[1][2] == 'WIN' for k in keep])
    half = np.array([1 if k[1][0][:10] >= SPLIT else 0 for k in keep], np.int8)
    n1, n2 = int((half == 0).sum()), int((half == 1).sum())
    b1 = 100.0 * win[half == 0].mean(); b2 = 100.0 * win[half == 1].mean()
    print(f'{len(keep)} صفقة من {len(rows)} • ٢٠٢٥-ح٢ {n1} بنسبة {b1:.2f}٪ • '
          f'٢٠٢٦ {n2} بنسبة {b2:.2f}٪\n')

    G = grid()
    out = []
    for name, key, kind, val in G:
        x = S[key][bi]
        m = apply(kind, val, x, is_buy) & np.isfinite(x)
        a, b = m & (half == 0), m & (half == 1)
        ka, kb = int(a.sum()), int(b.sum())
        if ka < MIN_KEEP * n1 or kb < MIN_KEEP * n2:
            continue
        wa = 100.0 * win[a].mean(); wb = 100.0 * win[b].mean()
        if wa <= b1 or wb <= b2:
            continue
        out.append({'filter': name, 'h2_2025': {'trades': ka, 'wins': int(win[a].sum()),
                                                'losses': ka - int(win[a].sum()),
                                                'win_rate': round(wa, 2),
                                                'kept': round(100.0 * ka / n1, 1)},
                    '2026': {'trades': kb, 'wins': int(win[b].sum()),
                             'losses': kb - int(win[b].sum()),
                             'win_rate': round(wb, 2), 'kept': round(100.0 * kb / n2, 1)},
                    'lift': round(min(wa - b1, wb - b2), 2)})
    out.sort(key=lambda r: -r['lift'])
    print(f'{len(out)} مرشّحاً من {len(G)} رفع النسبة في النصفين معاً وأبقى '
          f'{MIN_KEEP*100:.0f}٪ من الصفقات\n')
    print(f"{'المرشّح':<40}{'٢٠٢٥-ح٢: فتح ربح/خسر نسبة بقي':>34}{'٢٠٢٦: فتح ربح/خسر نسبة بقي':>34}")
    for r in out[:40]:
        a, b = r['h2_2025'], r['2026']
        print(f"{r['filter'][:39]:<40}"
              f"{a['trades']:>7}{a['wins']:>6}/{a['losses']:<4}{a['win_rate']:>6.2f}٪{a['kept']:>6.0f}٪"
              f"{b['trades']:>9}{b['wins']:>6}/{b['losses']:<4}{b['win_rate']:>6.2f}٪{b['kept']:>6.0f}٪")
    json.dump({'baseline': {'h2_2025': round(b1, 2), '2026': round(b2, 2),
                            'trades': [n1, n2]}, 'passed': out},
              open('research/results/sweep_on_trades.json', 'w'), ensure_ascii=False, indent=1)
    print('\n→ research/results/sweep_on_trades.json')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'research/results/current/w3a_trades.jsonl')
