"""يرسم حالات حقيقية من الشارت للتحقق بالعين أن الرقم يصف ما نظنه.

    python3 research/tools/plot_setups.py <سنة> <المفهوم> <الخرج.png>

المفاهيم: sweep_deep (سحب عميق تحت ≥١.٣٣×ATR) • break_below (كسر تحت ٠.٧٨–١.٢٩×ATR)

كل لوحة: ٦٠ شمعة قبل الحدث و١٢٠ بعده، مع مستوى القاع المُخترق، والهدف والستوب
بمضاعفات ATR، ونتيجة الصفقة. نصفها رابح ونصفها خاسر حتى لا نخدع أنفسنا.
"""
import csv
import gzip
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

PU, TP_MULT, SL_RATIO, MAX_HOLD = 0.1, 2.0, 1.3, 480
BEFORE, AFTER = 60, 120


def load(year):
    t, o, h, l, c = [], [], [], [], []
    with gzip.open('research/data/vault_utc.csv.gz', 'rt') as f:
        for r in csv.DictReader(f):
            if int(r['time'][:4]) != year:
                continue
            t.append(r['time'][:16])
            o.append(float(r['open'])); h.append(float(r['high']))
            l.append(float(r['low'])); c.append(float(r['close']))
    return t, *(np.array(x) for x in (o, h, l, c))


def atr14(h, l, c):
    pc = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))
    out = np.empty(len(tr)); out[0] = tr[0]
    for i in range(1, len(tr)):
        out[i] = tr[i] / 14. + out[i - 1] * 13 / 14.
    return out / PU


def outcome(i, h, l, c, ap):
    tp = TP_MULT * ap[i]; sl = SL_RATIO * tp
    tpb, slb = c[i] + tp * PU, c[i] - sl * PU
    for j in range(i + 1, min(i + 1 + MAX_HOLD, len(c))):
        if l[j] <= slb:
            return 0, j, tpb, slb
        if h[j] >= tpb:
            return 1, j, tpb, slb
    return -1, min(i + MAX_HOLD, len(c) - 1), tpb, slb


def candles(ax, o, h, l, c, x0):
    for k in range(len(c)):
        up = c[k] >= o[k]
        col = '#26a69a' if up else '#ef5350'
        ax.plot([x0 + k, x0 + k], [l[k], h[k]], color=col, lw=0.6, zorder=2)
        ax.add_patch(plt.Rectangle((x0 + k - 0.3, min(o[k], c[k])), 0.6,
                                   max(abs(c[k] - o[k]), 1e-9), color=col, zorder=3))


def main():
    year, concept, out = int(sys.argv[1]), sys.argv[2], sys.argv[3]
    t, o, h, l, c = load(year)
    ap = atr14(h, l, c)
    n = len(c)
    from numpy.lib.stride_tricks import sliding_window_view
    lo60 = np.full(n, np.nan); lo60[59:] = sliding_window_view(l, 60).min(1)
    plo = np.concatenate([[np.nan], lo60[:-1]])

    if concept == 'sweep_deep':
        depth = np.where(l < plo, ((plo - l) / PU) / np.maximum(ap, 1e-9), np.nan)
        cand = np.flatnonzero(np.isfinite(depth) & (depth >= 1.33) & (c > plo))
        title = 'سحب سيولة عميق تحت القاع ≥ ١.٣٣×ATR'
    else:
        depth = np.where(c < plo, ((plo - c) / PU) / np.maximum(ap, 1e-9), np.nan)
        cand = np.flatnonzero(np.isfinite(depth) & (depth >= 0.78) & (depth <= 1.29))
        title = 'كسر إغلاقي تحت القاع ٠.٧٨–١.٢٩×ATR'
    cand = cand[(cand > BEFORE + 300) & (cand < n - AFTER - 1)]

    res = [(i, *outcome(i, h, l, c, ap)) for i in cand]
    wins = [r for r in res if r[1] == 1]
    losses = [r for r in res if r[1] == 0]
    print(f'{len(cand)} حالة • رابحة {len(wins)} • خاسرة {len(losses)}')

    rng = np.random.default_rng(7)
    pick = ([wins[k] for k in rng.choice(len(wins), 3, replace=False)] +
            [losses[k] for k in rng.choice(len(losses), 3, replace=False)])

    fig, axes = plt.subplots(3, 2, figsize=(19, 13))
    fig.suptitle(f'{title}  —  {year}   (يسار: رابحة   يمين: خاسرة)', fontsize=15)
    for ax, (i, won, jend, tpb, slb) in zip(axes.T.ravel(), pick):
        a, b = i - BEFORE, min(i + AFTER, n)
        candles(ax, o[a:b], h[a:b], l[a:b], c[a:b], a)
        ax.axhline(plo[i], color='#ffa726', ls='--', lw=1.1, label='القاع السابق')
        ax.axhline(tpb, color='#26a69a', ls='-', lw=1.1, label='الهدف ٢×ATR')
        ax.axhline(slb, color='#ef5350', ls='-', lw=1.1, label='الستوب ٢.٦×ATR')
        ax.axvline(i, color='#42a5f5', lw=1.4)
        ax.plot([jend], [c[jend]], marker='o', ms=7,
                color='#26a69a' if won == 1 else '#ef5350', zorder=5)
        ax.set_title(f"{t[i]}   {'ربح' if won == 1 else 'خسارة' if won == 0 else 'بلا حسم'}"
                     f"   بعد {jend - i} دقيقة   ATR={ap[i]:.0f} نقطة", fontsize=10)
        ax.set_xlim(a, b); ax.grid(alpha=.15)
        ax.legend(fontsize=7, loc='upper left')
    plt.tight_layout()
    plt.savefig(out, dpi=110)
    print(f'→ {out}')


if __name__ == '__main__':
    main()
