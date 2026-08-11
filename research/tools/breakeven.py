"""التأمين: متى يحمي نقل الستوب إلى الدخول، ومتى يقتل الصفقة الرابحة؟

    PYTHONPATH=research/tools python3 research/tools/breakeven.py

شكوى صاحب المشروع: «التأمين ما عجبني — يرجع يضربها وتروح صفقات رابحة».
وهذه شكوى تُقاس ولا تُناقش. التأمين يفعل شيئين متعاكسين:

  يوفّر   خسائر كانت ستقع لولاه → تتحوّل إلى صفر
  يُتلف   صفقات كانت ستصل الهدف → تتحوّل إلى صفر أيضاً

فالحكم عليه ليس «كم صفقة أنقذ» بل **صافي النقاط**: هل ما وفّره أكبر مما أتلفه؟
نقيس ذلك على كل شمعة في السوق الحالي، عند عتبات تسليح مختلفة، بهيكلي الهدف
والستوب اللذين يعمل بهما المؤشر.

الحساب متحفّظ: إذا لمست الشمعة الستوب والهدف معاً فهي خسارة، وإذا سلّحت
التأمين وعادت إلى الدخول في نفس الشمعة فهي صفر.
"""
import json

import numpy as np

from escape3 import SPLIT, features, load

PU = 0.1
HORIZON = 480
SETUPS = [(30, 50), (40, 60), (60, 80)]
ARMS = [0, 5, 10, 15, 20, 25, 30, 40]     # صفر = بلا تأمين


def run(h, l, c, tp_pts, sl_pts, arm_pts, side):
    """يعيد لكل شمعة: ١ هدف • ٠ ستوب • ٢ تأمين (صفر) • -١ بلا حسم."""
    n = len(c)
    out = np.full(n, -1, np.int8)
    armed = np.zeros(n, bool)
    tp = c + side * tp_pts * PU
    sl = c - side * sl_pts * PU
    be = c.copy()
    trig = c + side * arm_pts * PU
    ar = np.arange(n)
    for k in range(1, HORIZON + 1):
        j = np.minimum(ar + k, n - 1)
        live = (out == -1) & (ar + k < n)
        if not live.any():
            break
        hj, lj = h[j], l[j]
        if side == 1:
            adverse_raw = lj <= sl
            reach_tp = hj >= tp
            back = lj <= be
            arm_now = hj >= trig
        else:
            adverse_raw = hj >= sl
            reach_tp = lj <= tp
            back = hj >= be
            arm_now = lj <= trig

        # غير مسلّح: الستوب الأصلي أولاً (تحفّظاً)، ثم الهدف، ثم التسليح
        u = live & ~armed
        out[u & adverse_raw] = 0
        u = live & ~armed & (out == -1)
        out[u & reach_tp] = 1
        u = live & ~armed & (out == -1)
        armed[u & arm_now] = True

        # مسلّح: الهدف أولاً، فإن لم يُلمس والسعر عاد إلى الدخول فهي صفر
        a = live & armed & (out == -1)
        out[a & reach_tp] = 1
        a = live & armed & (out == -1)
        out[a & back] = 2
    return out


def main():
    t, o, h, l, c, v = load()
    n = len(c)
    warm = np.arange(n) > 300
    half = np.array([1 if x[:10] >= SPLIT else 0 for x in t], np.int8)
    print(f'{n} شمعة • النصف الثاني من ٢٠٢٥ و٢٠٢٦\n')

    rep = {}
    for tp, sl in SETUPS:
        print(f'\n{"="*100}\n### هدف {tp} • ستوب {sl}\n')
        print(f"{'التأمين عند':<14}{'الجهة':>6}{'هدف':>9}{'صفر':>9}{'ستوب':>9}"
              f"{'نسبة الربح':>12}{'نقاط/صفقة':>12}{'الفرق':>10}")
        base = {}
        for side, sname in ((1, 'شراء'), (-1, 'بيع')):
            for arm in ARMS:
                res = run(h, l, c, tp, sl, arm if arm else 10 ** 9, side)
                m = warm & (res >= 0)
                k = int(m.sum())
                w = int((res[m] == 1).sum())
                z = int((res[m] == 2).sum())
                ls = int((res[m] == 0).sum())
                net = w * tp - ls * sl
                per = net / max(k, 1)
                key = (sname, arm)
                if arm == 0:
                    base[sname] = per
                d = per - base[sname]
                rep[f'{tp}/{sl}|{sname}|{arm}'] = {
                    'trades': k, 'target': w, 'breakeven': z, 'stopped': ls,
                    'win_rate': round(100.0 * w / max(k, 1), 2),
                    'per_trade': round(per, 3), 'delta': round(d, 3)}
                lbl = 'بلا تأمين' if arm == 0 else f'+{arm} نقطة'
                print(f"{lbl:<14}{sname:>6}{w:>9}{z:>9}{ls:>9}"
                      f"{100.0 * w / max(k, 1):>11.2f}٪{per:>+12.3f}{d:>+10.3f}")
            print()
    json.dump(rep, open('research/results/breakeven.json', 'w'), ensure_ascii=False, indent=1)
    print('→ research/results/breakeven.json')


if __name__ == '__main__':
    main()
