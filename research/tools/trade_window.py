"""نافذة إدارة الصفقة: الستوب، الخروج بالوقت، إعادة الدخول، السبريد.

    python3 research/tools/trade_window.py <القسم> <الخرج.json>
    الأقسام: stops exits reentry targets

محاكاة تسلسلية حقيقية: صفقة واحدة مفتوحة، الدخول عند إغلاق الشمعة المؤكدة،
والمستويات تُثبَّت عند الدخول ولا تتحرك. السبريد يُخصم من كل صفقة.

الإشارة الأساسية: سحب ≥٠.٨×ATR تحت قاع ٢٠ شمعة — اختيرت لأنها تعطي ٢٩.٨
صفقة يومياً بزيادة +٢.٣ في أضعف سنة، أي أقرب نقطة على منحنى التردد إلى
هدف الثلاثين صفقة.
"""
import json
import sys

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

YEARS = (2021, 2023, 2025, 2026)
PU = 0.1
MAX_HOLD = 480
SPREAD_FALLBACK = 2.0        # نقاط كاكاشي، حين لا يتوفر عمود السبريد
# عمود MT5 بوحدة ٠.٠١ دولار، ونقطة كاكاشي ٠.١٠ دولار، فالتحويل قسمة على عشرة.
MT5_TO_KAKASHI = 0.1


def roll_min(x, w):
    out = np.full(len(x), np.nan)
    out[w - 1:] = sliding_window_view(x, w).min(1)
    return out


def load(year):
    z = np.load(f'research/data/prep/{year}.npz')
    d = {k: z[k] for k in z.files}
    n = len(d['c'])
    d['n'] = n
    d['A'] = np.maximum(d['atr'], 1e-9)
    lo20 = roll_min(d['l'], 20)
    d['plo20'] = np.concatenate([[np.nan], lo20[:-1]])
    d['lo20'] = lo20
    depth = np.where(d['l'] < d['plo20'], ((d['plo20'] - d['l']) / PU) / d['A'], np.nan)
    d['depth'] = depth
    d['sig'] = (np.arange(n) > 500) & np.isfinite(depth) & (depth >= 0.8)
    d['spread_pts'] = np.where(d['sp'] > 0, d['sp'] * MT5_TO_KAKASHI, SPREAD_FALLBACK)
    return d


def simulate(d, tp_mult, stop_rule, stop_param, time_exit=None,
             noprog=None, reentry_block=0, deduct_spread=True):
    """يرجع قائمة الصفقات: (شمعة الدخول، النتيجة بالنقاط بعد السبريد، طول الصفقة)."""
    c, h, l, A, n = d['c'], d['h'], d['l'], d['A'], d['n']
    sig = np.flatnonzero(d['sig'])
    trades = []
    free = -1
    blocked_until = -1
    for i in sig:
        if i <= free or i <= blocked_until or i + 1 >= n:
            continue
        tp_pts = tp_mult * A[i]
        if stop_rule == 'atr':
            sl_pts = stop_param * tp_pts
        elif stop_rule == 'structure':          # خلف قاع الشمعة أو قاع ٢٠، أيهما أبعد
            base = min(l[i], d['lo20'][i]) if np.isfinite(d['lo20'][i]) else l[i]
            sl_pts = (c[i] - base) / PU + stop_param * A[i]
        else:                                    # خلف قاع الشمعة الحالية فقط
            sl_pts = (c[i] - l[i]) / PU + stop_param * A[i]
        sl_pts = max(sl_pts, 0.2 * A[i])
        tp_px, sl_px = c[i] + tp_pts * PU, c[i] - sl_pts * PU
        end = min(i + 1 + MAX_HOLD, n)
        out = None
        for j in range(i + 1, end):
            if l[j] <= sl_px:
                out = (-sl_pts, j); break
            if h[j] >= tp_px:
                out = (tp_pts, j); break
            k = j - i
            if time_exit and k >= time_exit:
                out = ((c[j] - c[i]) / PU, j); break
            if noprog and k >= noprog[0]:
                mfe = (h[i + 1:j + 1].max() - c[i]) / PU
                if mfe < noprog[1] * A[i]:
                    out = ((c[j] - c[i]) / PU, j); break
        if out is None:
            out = ((c[end - 1] - c[i]) / PU, end - 1)
        pts, j = out
        if deduct_spread:
            pts -= d['spread_pts'][i]
        trades.append((i, pts, j - i))
        free = j
        blocked_until = j + reentry_block
    return trades


def score(d, trades):
    if len(trades) < 100:
        return None
    pts = np.array([t[1] for t in trades])
    bars = np.array([t[2] for t in trades])
    idx = np.array([t[0] for t in trades])
    nd = int(d['ndays'])
    days = d['day_idx'][idx]
    daily = {}
    for k, p in zip(days, pts):
        daily[k] = daily.get(k, 0) + p
    vals = np.array(list(daily.values()))
    eq = np.cumsum(pts)
    dd = float((np.maximum.accumulate(eq) - eq).max())
    streak = mx = 0
    for p in pts:
        streak = streak + 1 if p < 0 else 0
        mx = max(mx, streak)
    return {'trades': len(trades), 'per_day': round(len(trades) / nd, 2),
            'win_rate': round(100.0 * (pts > 0).mean(), 2),
            'per_trade': round(float(pts.mean()), 3),
            'points_per_day': round(float(pts.sum()) / nd, 1),
            'median_bars': int(np.median(bars)),
            'days_positive': round(100.0 * (vals > 0).mean(), 1),
            'max_drawdown_pts': round(dd, 0),
            'max_losing_streak': int(mx)}


def configs(section):
    out = []
    if section == 'stops':
        for tp in (1.5, 2.0, 2.5, 3.0):
            for r in (1.0, 1.3, 1.6, 2.0):
                out.append((f'ستوب_نسبي_{r}×الهدف_TP{tp}', dict(tp_mult=tp, stop_rule='atr', stop_param=r)))
            for buf in (0.25, 0.5, 1.0, 1.5):
                out.append((f'ستوب_خلف_الهيكل_+{buf}ATR_TP{tp}',
                            dict(tp_mult=tp, stop_rule='structure', stop_param=buf)))
                out.append((f'ستوب_خلف_الشمعة_+{buf}ATR_TP{tp}',
                            dict(tp_mult=tp, stop_rule='candle', stop_param=buf)))
    elif section == 'exits':
        for te in (15, 30, 60, 120, 240, None):
            out.append((f'خروج_بالوقت_{te or "بلا"}',
                        dict(tp_mult=2.0, stop_rule='atr', stop_param=1.3, time_exit=te)))
        for k in (10, 20, 40, 60):
            for frac in (0.25, 0.5, 0.75):
                out.append((f'خروج_عدم_تقدّم_{k}شمعة_<{frac}ATR',
                            dict(tp_mult=2.0, stop_rule='atr', stop_param=1.3, noprog=(k, frac))))
    elif section == 'reentry':
        for b in (0, 5, 15, 30, 60, 120):
            out.append((f'حظر_إعادة_دخول_{b}شمعة',
                        dict(tp_mult=2.0, stop_rule='atr', stop_param=1.3, reentry_block=b)))
        for b in (0, 30):
            out.append((f'بلا_خصم_سبريد_حظر{b}',
                        dict(tp_mult=2.0, stop_rule='atr', stop_param=1.3,
                             reentry_block=b, deduct_spread=False)))
    else:
        for tp in (1.0, 2.0, 3.0, 5.0, 8.0, 12.0, 20.0):
            for r in (1.1, 1.3, 1.6):
                out.append((f'هدف_{tp}×ATR_ستوب_{r}×الهدف',
                            dict(tp_mult=tp, stop_rule='atr', stop_param=r)))
    return out


def main():
    section, out_path = sys.argv[1], sys.argv[2]
    data = {y: load(y) for y in YEARS}
    res = {}
    for name, kw in configs(section):
        e = {}
        for y in YEARS:
            s = score(data[y], simulate(data[y], **kw))
            if s:
                e[y] = s
        if len(e) == 4:
            res[name] = e
            pt = [e[y]['per_trade'] for y in YEARS]
            print(f"{name:<40}" + ''.join(f'{x:>+8.2f}' for x in pt) +
                  f"  {e[2026]['per_day']:>6.1f}/يوم  {e[2026]['win_rate']:>5.1f}%")
    json.dump(res, open(out_path, 'w'), ensure_ascii=False, indent=1)
    good = [k for k, v in res.items() if min(v[y]['per_trade'] for y in YEARS) > 0]
    print(f'\n{len(res)} إعداد • {len(good)} موجب في السنوات الأربع')


if __name__ == '__main__':
    main()
