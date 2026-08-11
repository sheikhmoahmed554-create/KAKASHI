"""مختبر الخروج: هل الخروج «لأن السبب مات» يضيف نقاطاً، أم يتلف صفقات رابحة؟

    PYTHONPATH=research/tools python3 research/tools/exitlab.py

الفرق الذي يقوم عليه المختبر: الستوب المتحرك يسأل «كم رجع السعر؟» وهو مقبض
يوزّع الحافة بين نسبة الفوز وحجمه. أما الخروج بالسبب فيسأل «هل ما زال السبب
الذي أدخلني قائماً؟» وهو معلومة. والفرق بينهما يُقاس ولا يُفترض.

خمسة أسباب موت، أربعة منها محسوبة أصلاً في SY152 لكنها موصولة بالدخول فقط:

  إنهاك ضدنا      سلسلة شموع قوية + ذيل رفض، أو حركة ≥ ن×ATR + ذيل
  كسر كاذب ضدنا   كسر مستوى ثم إغلاق راجع داخله
  انكسار هيكل     إغلاق تحت أدنى قاع النافذة (للشراء)
  زخم معاكس       RSI يبلغ الطرف المعاكس
  انقلاب اتجاه    ميل النافذة ينقلب ضدنا

كل سبب يُقاس وحده: كم صفقة خاسرة أنقذ، وكم صفقة كانت ستربح أتلف، وصافي النقاط.
والمقارنة دائماً ضد الاحتفاظ حتى الهدف أو الستوب — لا ضد شيء آخر.
"""
import json

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from escape3 import SPLIT, load

PU = 0.1
HORIZON = 480
SETUPS = [(30, 50), (60, 80)]


def build(t, o, h, l, c, v):
    n = len(c)
    pc = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))
    atr = np.empty(n); atr[0] = tr[0]
    for i in range(1, n):
        atr[i] = tr[i] / 14. + atr[i - 1] * 13 / 14.
    A = np.maximum(atr, 1e-9)          # بالسعر
    rng = np.maximum(h - l, 1e-9)
    body = np.abs(c - o) / rng * 100.0
    upw = (h - np.maximum(o, c)) / rng * 100.0
    dnw = (np.minimum(o, c) - l) / rng * 100.0

    # سلاسل الشموع القوية — نفس تعريف SY152
    strong_up = (c > o) & (body >= 62.0)
    strong_dn = (c < o) & (body >= 62.0)
    bull = np.zeros(n, int); bear = np.zeros(n, int)
    for i in range(1, n):
        bull[i] = bull[i - 1] + 1 if strong_up[i] else (0 if c[i] < o[i] else bull[i - 1])
        bear[i] = bear[i - 1] + 1 if strong_dn[i] else (0 if c[i] > o[i] else bear[i - 1])

    lo12 = np.full(n, np.nan); hi12 = np.full(n, np.nan)
    lo12[11:] = sliding_window_view(l, 12).min(1)
    hi12[11:] = sliding_window_view(h, 12).max(1)
    # إنهاك: سلسلة قوية مع ذيل رفض، أو حركة كبيرة مع ذيل رفض
    ex_up = ((bull >= 8) & (upw >= 40)) | (((c - lo12) >= A * 3.8) & (upw >= 40))
    ex_dn = ((bear >= 8) & (dnw >= 40)) | (((hi12 - c) >= A * 3.8) & (dnw >= 40))

    # كسر كاذب: تجاوز قمة/قاع النافذة ثم إغلاق راجع داخلها
    hi20 = np.full(n, np.nan); lo20 = np.full(n, np.nan)
    hi20[19:] = sliding_window_view(h, 20).max(1)
    lo20[19:] = sliding_window_view(l, 20).min(1)
    phi = np.concatenate([[np.nan], hi20[:-1]]); plo = np.concatenate([[np.nan], lo20[:-1]])
    fail_up = (h > phi) & (c < phi)     # كسر كاذب لأعلى → ضد الشراء
    fail_dn = (l < plo) & (c > plo)     # كسر كاذب لأسفل → ضد البيع

    # انكسار هيكل بنافذة ٣ شموع — نفس smartBreakLookback
    lo3 = np.full(n, np.nan); hi3 = np.full(n, np.nan)
    lo3[2:] = sliding_window_view(l, 3).min(1)
    hi3[2:] = sliding_window_view(h, 3).max(1)
    brk_dn = c < np.concatenate([[np.nan], lo3[:-1]])
    brk_up = c > np.concatenate([[np.nan], hi3[:-1]])

    delta = np.diff(c, prepend=c[0])
    ag = np.empty(n); al = np.empty(n); ag[0] = al[0] = 0.
    for i in range(1, n):
        ag[i] = max(delta[i], 0.) / 14. + ag[i - 1] * 13 / 14.
        al[i] = max(-delta[i], 0.) / 14. + al[i - 1] * 13 / 14.
    rsi = 100 - 100 / (1 + ag / np.maximum(al, 1e-12))

    back = np.concatenate([np.full(120, np.nan), c[:-120]])
    slope = (c - back) / A

    # قواعد الخروج: (اسم، ضد الشراء، ضد البيع)
    R = {
        'إنهاك ضدنا': (np.nan_to_num(ex_up).astype(bool), np.nan_to_num(ex_dn).astype(bool)),
        'كسر كاذب ضدنا': (np.nan_to_num(fail_up).astype(bool), np.nan_to_num(fail_dn).astype(bool)),
        'انكسار هيكل': (np.nan_to_num(brk_dn).astype(bool), np.nan_to_num(brk_up).astype(bool)),
        'زخم معاكس RSI': (rsi >= 70, rsi <= 30),
        'انقلاب الميل': (np.nan_to_num(slope) < -6, np.nan_to_num(slope) > 6),
    }
    R['إنهاك + كسر كاذب'] = (R['إنهاك ضدنا'][0] | R['كسر كاذب ضدنا'][0],
                              R['إنهاك ضدنا'][1] | R['كسر كاذب ضدنا'][1])
    R['كل الأسباب'] = (np.logical_or.reduce([R[k][0] for k in list(R)[:5]]),
                        np.logical_or.reduce([R[k][1] for k in list(R)[:5]]))
    return R


def simulate(h, l, c, tp_pts, sl_pts, side, kill=None, min_bars=1):
    """يعيد لكل شمعة نقاطها: الهدف، الستوب، أو الخروج بالسبب عند إغلاق الشمعة."""
    n = len(c)
    out = np.full(n, np.nan)
    done = np.zeros(n, bool)
    tp = c + side * tp_pts * PU
    sl = c - side * sl_pts * PU
    ar = np.arange(n)
    for k in range(1, HORIZON + 1):
        j = np.minimum(ar + k, n - 1)
        live = ~done & (ar + k < n)
        if not live.any():
            break
        if side == 1:
            hitsl = live & (l[j] <= sl)
            hittp = live & (h[j] >= tp) & ~hitsl
        else:
            hitsl = live & (h[j] >= sl)
            hittp = live & (l[j] <= tp) & ~hitsl
        out[hitsl] = -sl_pts; done[hitsl] = True
        out[hittp] = tp_pts;  done[hittp] = True
        if kill is not None and k >= min_bars:
            ku = ~done & (ar + k < n) & kill[j]
            if ku.any():
                out[ku] = side * (c[j][ku] - c[ku]) / PU
                done[ku] = True
    return out, done


def main():
    t, o, h, l, c, v = load()
    n = len(c)
    R = build(t, o, h, l, c, v)
    warm = np.arange(n) > 300
    half = np.array([1 if x[:10] >= SPLIT else 0 for x in t], np.int8)
    print(f'{n} شمعة • النصف الثاني من ٢٠٢٥ و٢٠٢٦\n')

    rep = {}
    for tp, sl in SETUPS:
        print(f'\n{"="*108}\n### هدف {tp} • ستوب {sl}\n')
        print(f"{'قاعدة الخروج':<22}{'الجهة':>6}{'صفقة':>8}{'ربح':>7}{'خسر':>7}"
              f"{'خروج بالسبب':>13}{'النسبة':>9}{'نقاط/صفقة':>12}{'الفرق':>10}")
        for side, sname in ((1, 'شراء'), (-1, 'بيع')):
            base_pts, base_done = simulate(h, l, c, tp, sl, side)
            m0 = warm & base_done
            b = float(np.nanmean(base_pts[m0]))
            w0 = int((base_pts[m0] > 0).sum()); l0 = int((base_pts[m0] < 0).sum())
            print(f"{'احتفاظ حتى النهاية':<22}{sname:>6}{int(m0.sum()):>8}{w0:>7}{l0:>7}"
                  f"{0:>13}{100.0*w0/max(int(m0.sum()),1):>8.2f}٪{b:>+12.3f}{0.0:>+10.3f}")
            for name, (ku, kd) in R.items():
                kill = ku if side == 1 else kd
                pts, done = simulate(h, l, c, tp, sl, side, kill)
                m = warm & done
                k = int(m.sum())
                w = int((pts[m] > 0).sum()); ls = int((pts[m] < 0).sum())
                # الصفقات التي خرجت بالسبب: لا هدفاً ولا ستوباً
                bysebab = int((m & (pts != tp) & (pts != -sl)).sum())
                per = float(np.nanmean(pts[m]))
                rep[f'{tp}/{sl}|{sname}|{name}'] = {
                    'trades': k, 'wins': w, 'losses': ls, 'by_reason': bysebab,
                    'win_rate': round(100.0 * w / max(k, 1), 2),
                    'per_trade': round(per, 3), 'delta': round(per - b, 3)}
                print(f"{name:<22}{sname:>6}{k:>8}{w:>7}{ls:>7}{bysebab:>13}"
                      f"{100.0*w/max(k,1):>8.2f}٪{per:>+12.3f}{per-b:>+10.3f}")
            print()
    json.dump(rep, open('research/results/exitlab.json', 'w'), ensure_ascii=False, indent=1)
    print('→ research/results/exitlab.json')


if __name__ == '__main__':
    main()
