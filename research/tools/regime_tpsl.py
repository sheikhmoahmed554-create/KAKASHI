"""هل يفيد تبديل خطة الأهداف حسب نوع السوق — فعلاً؟

ثلاثة أسئلة منفصلة، والخلط بينها هو ما ينتج أرقاماً كاذبة:

  ١. هل التبديل أفضل من نظام R16 الحالي؟        ← سؤال سهل، الجواب نعم لأي خطة واسعة
  ٢. هل التبديل أفضل من **أفضل خطة موحّدة**؟    ← السؤال الحقيقي
  ٣. هل يصمد الفارق خارج عيّنة الاختيار؟         ← السؤال الذي يقرر البناء من عدمه

الاختيار داخل العيّنة نفسها مضمون النجاح: أربعة أنواع × ٣٣٦ خطة = ١,٣٤٤ محاولة
انتقاء. لذلك يُختار على النصف الأول ويُقاس على النصف الثاني وحده.

كل القياس تسلسلي — صفقة واحدة في المرة.

    python3 research/tools/regime_tpsl.py
"""
import csv
import json
from collections import Counter

import numpy as np

NEVER = np.int32(1 << 30)
HORIZON = 240
TP_LO, TP_HI = 40, 60
SL_LO, SL_HI = 50, 65
SPLIT = '2026-04-15'          # التدريب قبله، الاختبار بعده

Z = np.load('research/results/tpsl_paths_2026.npz', allow_pickle=True)
idx, side = Z['idx'], Z['side']
own_tp, own_sl, own_win, months = Z['own_tp'], Z['own_sl'], Z['own_win'], Z['months']
mfe, mae = Z['mfe'], Z['mae']

bar_time = np.array([r['time'][:19] for r in
                     csv.DictReader(open('research/data/builtin2026.csv'))])
trade_time = bar_time[idx]

regime = np.full(len(idx), 'UNKNOWN', dtype=object)
for s in csv.DictReader(open('research/results/regime_segments.csv')):
    m = (trade_time >= s['start']) & (trade_time <= s['end'] + ':59')
    regime[m] = s['regime']

is_train = trade_time < SPLIT
REGIMES = ['TREND_UP', 'TREND_DOWN', 'RANGE', 'VOLATILE']

print("توزيع صفقات المؤشر على أنواع السوق:")
for k, v in Counter(regime).most_common():
    print(f"  {k:<12}{v:>6}  ({100*v/len(regime):>5.1f}%)")
print(f"\nالتقسيم عند {SPLIT}: تدريب {is_train.sum():,} • اختبار {(~is_train).sum():,}")
tr_days = len(set(t[:10] for t in trade_time[is_train]))
te_days = len(set(t[:10] for t in trade_time[~is_train]))
print(f"أيام التداول: تدريب {tr_days} • اختبار {te_days}\n")


def evaluate(tp, sl):
    t_tp = np.where(mfe[:, -1] >= tp, (mfe >= tp).argmax(1).astype(np.int32), NEVER)
    t_sl = np.where(mae[:, -1] >= sl, (mae >= sl).argmax(1).astype(np.int32), NEVER)
    out = np.full(len(mfe), -1, np.int8)
    out[t_tp < t_sl] = 1
    out[(t_sl <= t_tp) & (t_sl < NEVER)] = 0
    bars = np.minimum(t_tp, t_sl)
    bars[out < 0] = HORIZON
    return out, bars


GRID = [(tp, sl) for tp in range(TP_LO, TP_HI + 1) for sl in range(SL_LO, SL_HI + 1)]
CACHE = {p: evaluate(*p) for p in GRID}
for p in set(zip(own_tp.astype(int), own_sl.astype(int))):     # خطط R16 الحقيقية
    if p not in CACHE:
        CACHE[p] = evaluate(*p)
order = np.argsort(idx)


def run(plan_of, mask=None, days=1.0):
    """تسلسلي. mask يحصر الاحتساب في فترة، لكن الحجز يسري على الكل."""
    busy = -1
    w = ls = 0
    net = 0.0
    per_reg = {}
    for p in order:
        i = idx[p]
        if i <= busy:
            continue
        tp, sl = plan_of(p)
        o, bars = CACHE[(tp, sl)]
        if o[p] < 0:
            busy = i + int(bars[p]); continue
        busy = i + int(bars[p])
        if mask is not None and not mask[p]:
            continue
        d = per_reg.setdefault(regime[p], [0, 0, 0.0])
        if o[p] == 1:
            w += 1; net += tp; d[0] += 1; d[2] += tp
        else:
            ls += 1; net -= sl; d[1] += 1; d[2] -= sl
    n = w + ls
    return {'trades': n, 'win_rate': 100.0 * w / n if n else 0, 'net': net,
            'per_trade': net / n if n else 0, 'per_day': n / days, 'by_regime': per_reg}


R16 = lambda p: (int(own_tp[p]), int(own_sl[p]))


def best_plan(mask, objective, min_n=80):
    rows = []
    for q in GRID:
        o, _ = CACHE[q]
        sel = mask & (o >= 0)
        w = int((o[sel] == 1).sum()); ls = int((o[sel] == 0).sum()); n = w + ls
        if n < min_n:
            continue
        net = w * q[0] - ls * q[1]
        rows.append({'p': q, 'n': n, 'wr': 100.0 * w / n, 'net': net, 'pt': net / n})
    return max(rows, key=objective) if rows else None


# ── ١. اختيار على التدريب فقط ────────────────────────────────────────────────
print("═══ الاختيار على النصف الأول فقط (تدريب) ═══")
sel_regime = {}
for R in REGIMES:
    b = best_plan(is_train & (regime == R), lambda r: r['pt'])
    sel_regime[R] = b['p']
    print(f"  {R:<12} → {b['p'][0]}/{b['p'][1]}   ({b['n']} صفقة تدريب، "
          f"فوز {b['wr']:.1f}%، {b['pt']:+.3f}/صفقة)")
b_uni = best_plan(is_train, lambda r: r['pt'])
print(f"  {'خطة موحّدة':<12} → {b_uni['p'][0]}/{b_uni['p'][1]}   "
      f"({b_uni['n']} صفقة، {b_uni['pt']:+.3f}/صفقة)")
b_uni_wr = best_plan(is_train, lambda r: r['wr'])
print(f"  {'أعلى فوز موحّد':<12} → {b_uni_wr['p'][0]}/{b_uni_wr['p'][1]}   "
      f"(فوز {b_uni_wr['wr']:.1f}%)")

SW = lambda p: sel_regime.get(regime[p], b_uni['p'])
UNI = lambda p, q=b_uni['p']: q
UNIW = lambda p, q=b_uni_wr['p']: q

# ── ٢. القياس على الاختبار وحده ──────────────────────────────────────────────
for title, mask, days in [("التدريب (داخل العيّنة — متفائل بطبيعته)", is_train, tr_days),
                          ("الاختبار (خارج العيّنة — الحكم الحقيقي)", ~is_train, te_days)]:
    print(f"\n═══ {title} ═══")
    print(f"{'النظام':<26}{'صفقات':>8}{'/يوم':>7}{'فوز%':>8}{'صافي':>9}{'/صفقة':>8}")
    out = {}
    for name, fn in [('R16 الحالي', R16), (f'موحّدة {b_uni["p"][0]}/{b_uni["p"][1]}', UNI),
                     (f'أعلى فوز {b_uni_wr["p"][0]}/{b_uni_wr["p"][1]}', UNIW),
                     ('تبديل حسب نوع السوق', SW)]:
        r = run(fn, mask, days)
        out[name] = r
        print(f"{name:<26}{r['trades']:>8}{r['per_day']:>7.1f}{r['win_rate']:>8.2f}"
              f"{r['net']:>9.0f}{r['per_trade']:>8.3f}")
    if 'الاختبار' in title:
        sw = out['تبديل حسب نوع السوق']
        uni = out[f'موحّدة {b_uni["p"][0]}/{b_uni["p"][1]}']
        base = out['R16 الحالي']
        print(f"\n  التبديل مقابل R16       : فوز {sw['win_rate']-base['win_rate']:+.2f} • "
              f"صافي {sw['net']-base['net']:+.0f} ({100*(sw['net']-base['net'])/abs(base['net']):+.1f}%)")
        print(f"  التبديل مقابل الموحّدة  : فوز {sw['win_rate']-uni['win_rate']:+.2f} • "
              f"صافي {sw['net']-uni['net']:+.0f} ({100*(sw['net']-uni['net'])/abs(uni['net']):+.1f}%)")
        print(f"  ← هذا الثاني هو الرقم الذي يقرر: هل يستحق المحرك أن يُبنى؟")
        json.dump({'selected': {k: list(v) for k, v in sel_regime.items()},
                   'universal': list(b_uni['p']),
                   'test': {k: {kk: vv for kk, vv in v.items() if kk != 'by_regime'}
                            for k, v in out.items()}},
                  open('research/results/regime_tpsl.json', 'w'), indent=1, ensure_ascii=False)

# ── ٣. هل الخطط المختارة مختلفة أصلاً بين الأنواع؟ ──────────────────────────
print(f"\n═══ فحص: هل تختلف الخطة المثلى بين الأنواع فعلاً؟ ═══")
print(f"{'النوع':<12}{'المختارة':>10}   ثم أداء كل خطط الأنواع الأخرى على هذا النوع (اختبار)")
for R in REGIMES:
    m = (~is_train) & (regime == R)
    cells = []
    for R2 in REGIMES:
        q = sel_regime[R2]
        o, _ = CACHE[q]
        sel = m & (o >= 0)
        w = int((o[sel] == 1).sum()); ls = int((o[sel] == 0).sum()); n = w + ls
        pt = (w * q[0] - ls * q[1]) / n if n else 0
        cells.append(f"{R2[:4]}:{pt:+.2f}")
    print(f"{R:<12}{str(sel_regime[R][0])+'/'+str(sel_regime[R][1]):>10}   " + "  ".join(cells))
print("\nإن كانت خطة النوع لا تتفوّق على خطط الأنواع الأخرى داخل نوعها،")
print("فالتبديل يقيس ضجيجاً لا بنية، ولا معنى لبناء كاشف لحظي له.")
