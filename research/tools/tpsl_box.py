"""أفضل خطة داخل صندوق المستخدم: هدف ٤٠–٦٠، وقف ٥٠–٦٥.

المطلوب أعلى نسبة فوز مع أكبر عدد نقاط معاً، وهما هدفان متعارضان، فنُخرج
جبهة باريتو — أي الخطط التي لا توجد خطة أخرى تتفوّق عليها في الاثنين معاً —
ثم نرشّح من داخلها بالثبات الشهري والمحاكاة التسلسلية.
"""
import numpy as np

NEVER = np.int32(1 << 30)
TP_LO, TP_HI = 40, 60
SL_LO, SL_HI = 50, 65
NDAYS = 138.0

Z = np.load('research/results/tpsl_paths_2026.npz', allow_pickle=True)
idx, side = Z['idx'], Z['side']
own_tp, own_sl, own_win, months = Z['own_tp'], Z['own_sl'], Z['own_win'], Z['months']
mfe, mae = Z['mfe'], Z['mae']
mons = sorted(set(months.tolist()))


def evaluate(tp, sl):
    t_tp = np.where(mfe[:, -1] >= tp, (mfe >= tp).argmax(1).astype(np.int32), NEVER)
    t_sl = np.where(mae[:, -1] >= sl, (mae >= sl).argmax(1).astype(np.int32), NEVER)
    out = np.full(len(mfe), -1, np.int8)
    out[t_tp < t_sl] = 1
    out[(t_sl <= t_tp) & (t_sl < NEVER)] = 0
    return out, np.minimum(t_tp, t_sl)


def sequential(tp, sl):
    """صفقة واحدة في المرة — الحكم الواقعي."""
    out, bars = evaluate(tp, sl)
    busy = -1; w = ls = 0; net = 0.0
    for k in np.argsort(idx):
        if idx[k] <= busy or out[k] < 0:
            continue
        if out[k] == 1:
            w += 1; net += tp
        else:
            ls += 1; net -= sl
        busy = idx[k] + int(bars[k])
    n = w + ls
    return {'trades': n, 'wins': w, 'win_rate': 100.0 * w / n if n else 0,
            'net': net, 'per_trade': net / n if n else 0}


rows = []
for tp in range(TP_LO, TP_HI + 1):
    for sl in range(SL_LO, SL_HI + 1):
        out, bars = evaluate(tp, sl)
        w = int((out == 1).sum()); ls = int((out == 0).sum()); n = w + ls
        wr = 100.0 * w / n
        be = 100.0 * sl / (tp + sl)
        net = w * tp - ls * sl
        monthly = []
        for m in mons:
            s = (months == m) & (out >= 0)
            monthly.append((100.0 * out[s].mean(),
                            int((out[s] == 1).sum() * tp - (out[s] == 0).sum() * sl)))
        rows.append({'tp': tp, 'sl': sl, 'trades': n, 'win_rate': wr, 'breakeven': be,
                     'edge': wr - be, 'net': net, 'per_trade': net / n,
                     'bars': float(bars[out >= 0].mean()),
                     'min_wr': min(x[0] for x in monthly),
                     'min_net': min(x[1] for x in monthly),
                     'neg_months': sum(1 for x in monthly if x[1] < 0),
                     'monthly': monthly})

print(f"صندوق البحث: هدف {TP_LO}–{TP_HI} • وقف {SL_LO}–{SL_HI} = {len(rows)} تركيبة")
print(f"خط الأساس (المؤشر الآن، تسلسلياً): فوز ٦٠.٧٠٪ • صافي +٧,٧٤٠ • +١.١٩٨ نقطة/صفقة\n")


def head(t):
    print(f"\n═══ {t} ═══")
    print(f"{'هدف':>4}{'وقف':>5}{'فوز%':>8}{'تعادل%':>9}{'حافة':>7}{'صافي':>8}"
          f"{'/صفقة':>8}{'أدنى شهر%':>11}{'شهور خاسرة':>12}")


def line(r):
    print(f"{r['tp']:>4}{r['sl']:>5}{r['win_rate']:>8.2f}{r['breakeven']:>9.2f}"
          f"{r['edge']:>+7.2f}{r['net']:>8.0f}{r['per_trade']:>8.3f}"
          f"{r['min_wr']:>11.1f}{r['neg_months']:>12}")


head("أعلى نسبة فوز داخل الصندوق")
for r in sorted(rows, key=lambda r: -r['win_rate'])[:10]:
    line(r)

head("أعلى صافي نقاط داخل الصندوق")
for r in sorted(rows, key=lambda r: -r['net'])[:10]:
    line(r)

# ── جبهة باريتو: لا توجد خطة أفضل في نسبة الفوز والصافي معاً ────────────────
pareto = [r for r in rows
          if not any(o['win_rate'] >= r['win_rate'] and o['net'] >= r['net']
                     and (o['win_rate'] > r['win_rate'] or o['net'] > r['net'])
                     for o in rows)]
pareto.sort(key=lambda r: -r['win_rate'])
head(f"جبهة باريتو — الخيارات غير المهزومة ({len(pareto)} خطة)")
for r in pareto:
    line(r)

# ── الترشيح النهائي: باريتو + ثبات ───────────────────────────────────────────
strong = [r for r in pareto if r['net'] > 7740 and r['win_rate'] > 60.70]
print(f"\n═══ الخطط التي تتفوّق على المؤشر الحالي في الاثنين معاً ═══")
if strong:
    head("")
    for r in strong:
        line(r)
else:
    print("  لا توجد خطة داخل الصندوق تتفوّق على المؤشر في نسبة الفوز والصافي معاً.")
    best_both = max(rows, key=lambda r: (r['net'] > 7740, r['win_rate']))
    print(f"  الأقرب: هدف {best_both['tp']}/وقف {best_both['sl']} — "
          f"فوز {best_both['win_rate']:.2f}% وصافي {best_both['net']:.0f}")

# ── المحاكاة التسلسلية لمرشّحي باريتو ───────────────────────────────────────
print(f"\n═══ المحاكاة التسلسلية — صفقة واحدة في المرة ═══")
print(f"{'هدف':>4}{'وقف':>5}{'صفقات':>8}{'/يوم':>7}{'فوز%':>8}{'صافي':>9}{'/صفقة':>8}")
seq = []
for r in pareto:
    s = sequential(r['tp'], r['sl'])
    seq.append((r, s))
    print(f"{r['tp']:>4}{r['sl']:>5}{s['trades']:>8}{s['trades']/NDAYS:>7.1f}"
          f"{s['win_rate']:>8.2f}{s['net']:>9.0f}{s['per_trade']:>8.3f}")

# ── الثبات الشهري للمرشّحين الثلاثة الأبرز ──────────────────────────────────
top = sorted(pareto, key=lambda r: -r['win_rate'])[:2] + sorted(pareto, key=lambda r: -r['net'])[:2]
seen, uniq = set(), []
for r in top:
    if (r['tp'], r['sl']) not in seen:
        seen.add((r['tp'], r['sl'])); uniq.append(r)

print(f"\n═══ الثبات الشهري — نسبة الفوز ═══")
print(f"{'خطة':>11}" + "".join(f"{m[-2:]:>7}" for m in mons) + f"{'أدنى':>8}{'مدى':>7}")
for r in uniq:
    v = [x[0] for x in r['monthly']]
    print(f"{str(r['tp'])+'/'+str(r['sl']):>11}" + "".join(f"{x:>7.1f}" for x in v)
          + f"{min(v):>8.1f}{max(v)-min(v):>7.1f}")

print(f"\n═══ الثبات الشهري — الصافي ═══")
print(f"{'خطة':>11}" + "".join(f"{m[-2:]:>8}" for m in mons) + f"{'أسوأ':>9}")
for r in uniq:
    v = [x[1] for x in r['monthly']]
    print(f"{str(r['tp'])+'/'+str(r['sl']):>11}" + "".join(f"{x:>8}" for x in v) + f"{min(v):>9}")

import json
json.dump([{k: v for k, v in r.items() if k != 'monthly'} for r in rows],
          open('research/results/tpsl_box_40_60.json', 'w'), indent=1)
print("\nكُتب research/results/tpsl_box_40_60.json")
