"""يرسم يوم تداول كاملاً بفريم الدقيقة: أين الفرص الحقيقية، وأين تقع إشاراتنا.

    python3 research/tools/plot_day.py <YYYY-MM-DD> <الخرج.png>

الفرصة الحقيقية = شمعة لو دخلنا عند إغلاقها لتحقق هدف ٢×ATR قبل ستوب ٢.٦×ATR.
تُرسم كنقاط تحت/فوق الشموع، حتى نرى بالعين إيقاع اليوم: أين تتكدس الفرص،
وهل إشاراتنا تقع عليها أم في فراغ.
"""
import csv
import gzip
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

PU, TPM, SLR, MH = 0.1, 2.0, 1.3, 480


def load_around(day, pad=600):
    rows = []
    with gzip.open('research/data/vault_utc.csv.gz', 'rt') as f:
        for r in csv.DictReader(f):
            rows.append((r['time'], float(r['open']), float(r['high']),
                         float(r['low']), float(r['close']), float(r['volume'])))
    idx = [i for i, r in enumerate(rows) if r[0][:10] == day]
    a, b = max(0, idx[0] - pad), min(len(rows), idx[-1] + pad)
    seg = rows[a:b]
    return (idx[0] - a, idx[-1] - a,
            [x[0] for x in seg], *(np.array([x[k] for x in seg]) for k in range(1, 6)))


def main():
    day, out = sys.argv[1], sys.argv[2]
    s, e, t, o, h, l, c, v = load_around(day)
    n = len(c)
    pc = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))
    ap = np.empty(n); ap[0] = tr[0]
    for i in range(1, n):
        ap[i] = tr[i] / 14. + ap[i - 1] * 13 / 14.
    ap /= PU

    rb = np.zeros(n, np.int8); rs = np.zeros(n, np.int8)
    tp = TPM * ap; sl = SLR * tp
    tpb, slb, tps, sls = c + tp * PU, c - sl * PU, c - tp * PU, c + sl * PU
    ar = np.arange(n)
    for k in range(1, MH + 1):
        j = ar + k; ok = j < n; jj = np.where(ok, j, n - 1)
        m = ok & (rb == 0); x = m & (l[jj] <= slb); w = m & (h[jj] >= tpb) & ~x
        rb[x] = -1; rb[w] = 1
        m = ok & (rs == 0); x = m & (h[jj] >= sls); w = m & (l[jj] <= tps) & ~x
        rs[x] = -1; rs[w] = 1

    lo60 = np.full(n, np.nan); hi60 = np.full(n, np.nan)
    lo60[59:] = sliding_window_view(l, 60).min(1)
    hi60[59:] = sliding_window_view(h, 60).max(1)
    plo = np.concatenate([[np.nan], lo60[:-1]])
    depth = np.where(l < plo, ((plo - l) / PU) / np.maximum(ap, 1e-9), np.nan)
    back = np.concatenate([np.full(120, np.nan), c[:-120]])
    slope = ((c - back) / PU) / np.maximum(ap, 1e-9)
    sig = np.isfinite(depth) & (depth >= 1.33) & (c > plo) & (slope < -3)

    fig, ax = plt.subplots(figsize=(22, 9))
    for k in range(s, e + 1):
        up = c[k] >= o[k]
        col = '#26a69a' if up else '#ef5350'
        ax.plot([k, k], [l[k], h[k]], color=col, lw=0.5, zorder=2)
        ax.add_patch(plt.Rectangle((k - 0.35, min(o[k], c[k])), 0.7,
                                   max(abs(c[k] - o[k]), 1e-9), color=col, zorder=3))
    win_b = [k for k in range(s, e + 1) if rb[k] == 1]
    win_s = [k for k in range(s, e + 1) if rs[k] == 1]
    ax.scatter(win_b, l[win_b] - ap[win_b] * PU * 0.6, s=4, color='#00c853',
               label=f'فرصة شراء متاحة ({len(win_b)})', zorder=4)
    ax.scatter(win_s, h[win_s] + ap[win_s] * PU * 0.6, s=4, color='#d50000',
               label=f'فرصة بيع متاحة ({len(win_s)})', zorder=4)
    fired = [k for k in range(s, e + 1) if sig[k]]
    ax.scatter(fired, l[fired] - ap[fired] * PU * 1.8, s=110, marker='^',
               color='#2962ff', label=f'إشارتنا: سحب عميق في هبوط ({len(fired)})', zorder=6)
    ax.plot(range(s, e + 1), plo[s:e + 1], color='#ffa726', lw=0.8, ls='--',
            label='قاع ٦٠ شمعة')
    ax.plot(range(s, e + 1), np.concatenate([[np.nan], hi60[:-1]])[s:e + 1],
            color='#ab47bc', lw=0.8, ls='--', label='قمة ٦٠ شمعة')
    ax.set_title(f'{day}  —  {e - s + 1} شمعة دقيقة  •  ATR وسيط {np.median(ap[s:e]):.0f} نقطة',
                 fontsize=14)
    ax.set_xlim(s, e); ax.grid(alpha=.15); ax.legend(loc='upper left', fontsize=9)
    step = max(1, (e - s) // 14)
    ax.set_xticks(range(s, e, step))
    ax.set_xticklabels([t[k][11:16] for k in range(s, e, step)], fontsize=8)
    plt.tight_layout(); plt.savefig(out, dpi=100)
    print(f'{day}: فرص شراء {len(win_b)} • فرص بيع {len(win_s)} • إشاراتنا {len(fired)} → {out}')


if __name__ == '__main__':
    main()
