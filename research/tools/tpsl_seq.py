"""أفضل خطة لبوت يفتح صفقة واحدة في المرة — هدف ٤٠–٦٠، وقف ٥٠–٦٥.

الفرق الجوهري عن المسح السابق: هنا كل إشارة تصل والصفقة القائمة لم تُغلق بعد
تُرفض تماماً. فتصبح **مدة بقاء الصفقة** جزءاً من التكلفة، لا الهدف والوقف وحدهما:
وقف واسع يطيل الصفقة فيحجب إشارات كانت ستربح، وهذه الخسارة غير المرئية لا تظهر
إطلاقاً في المسح الموازي.

    python3 research/tools/tpsl_seq.py
"""
import json

import numpy as np

NEVER = np.int32(1 << 30)
TP_LO, TP_HI = 40, 60
SL_LO, SL_HI = 50, 65
HORIZON = 240
NDAYS = 138.0

Z = np.load('research/results/tpsl_paths_2026.npz', allow_pickle=True)
idx, side = Z['idx'], Z['side']
own_tp, own_sl, own_win, months = Z['own_tp'], Z['own_sl'], Z['own_win'], Z['months']
mfe, mae = Z['mfe'], Z['mae']
mons = sorted(set(months.tolist()))
order = np.argsort(idx)
idx_s = idx[order]
months_s = months[order]


def evaluate(tp, sl):
    t_tp = np.where(mfe[:, -1] >= tp, (mfe >= tp).argmax(1).astype(np.int32), NEVER)
    t_sl = np.where(mae[:, -1] >= sl, (mae >= sl).argmax(1).astype(np.int32), NEVER)
    out = np.full(len(mfe), -1, np.int8)
    out[t_tp < t_sl] = 1
    out[(t_sl <= t_tp) & (t_sl < NEVER)] = 0
    bars = np.minimum(t_tp, t_sl)
    bars[out < 0] = HORIZON          # صفقة لم تُحسم تظل حاجزة طوال الأفق
    return out, bars


def sequential(tp, sl, want_monthly=False):
    out, bars = evaluate(tp, sl)
    o_s, b_s = out[order], bars[order]
    busy = -1
    w = ls = skipped = 0
    net = 0.0
    hold = 0
    per_month = {m: [0, 0, 0.0] for m in mons}     # [فوز, خسارة, صافي]
    for p in range(len(idx_s)):
        i = idx_s[p]
        if i <= busy:
            skipped += 1
            continue
        if o_s[p] < 0:                              # تُفتح وتُحجز لكن بلا نتيجة
            busy = i + int(b_s[p])
            continue
        m = months_s[p]
        if o_s[p] == 1:
            w += 1; net += tp; per_month[m][0] += 1; per_month[m][2] += tp
        else:
            ls += 1; net -= sl; per_month[m][1] += 1; per_month[m][2] -= sl
        hold += int(b_s[p])
        busy = i + int(b_s[p])
    n = w + ls
    r = {'tp': tp, 'sl': sl, 'trades': n, 'wins': w, 'losses': ls, 'skipped': skipped,
         'win_rate': 100.0 * w / n if n else 0.0,
         'breakeven': 100.0 * sl / (tp + sl),
         'net': net, 'per_trade': net / n if n else 0.0,
         'per_day': n / NDAYS, 'avg_hold': hold / n if n else 0.0}
    r['edge'] = r['win_rate'] - r['breakeven']
    if want_monthly:
        mm = []
        for m in mons:
            a, b, s = per_month[m]
            mm.append((100.0 * a / (a + b) if a + b else 0.0, s))
        r['monthly'] = mm
        r['min_wr'] = min(x[0] for x in mm)
        r['min_net'] = min(x[1] for x in mm)
        r['neg_months'] = sum(1 for x in mm if x[1] < 0)
    return r


# ── خط الأساس: خطة المؤشر المتغيّرة، تسلسلياً ────────────────────────────────
plans = {}
for (a, b) in set(zip(own_tp, own_sl)):
    plans[(a, b)] = evaluate(a, b)
busy = -1; bw = bl = 0; bnet = 0.0; bhold = 0
for p in range(len(idx_s)):
    k = order[p]; i = idx_s[p]
    if i <= busy:
        continue
    o, bars = plans[(own_tp[k], own_sl[k])]
    if o[k] < 0:
        busy = i + int(bars[k]); continue
    if o[k] == 1:
        bw += 1; bnet += own_tp[k]
    else:
        bl += 1; bnet -= own_sl[k]
    bhold += int(bars[k]); busy = i + int(bars[k])
bn = bw + bl
B = {'win_rate': 100.0 * bw / bn, 'net': bnet, 'per_trade': bnet / bn,
     'trades': bn, 'per_day': bn / NDAYS, 'avg_hold': bhold / bn}

print("╔═══ خط الأساس — المؤشر بنظام R16، صفقة واحدة في المرة ═══╗")
print(f"  {B['trades']:,} صفقة • {B['per_day']:.1f}/يوم • فوز {B['win_rate']:.2f}% • "
      f"صافي {B['net']:+,.0f} • {B['per_trade']:+.3f}/صفقة • بقاء {B['avg_hold']:.0f} شمعة\n")

rows = [sequential(tp, sl, True)
        for tp in range(TP_LO, TP_HI + 1) for sl in range(SL_LO, SL_HI + 1)]
print(f"مُسحت {len(rows)} تركيبة داخل الصندوق، كلها تسلسلياً.\n")


def head(t):
    print(f"\n═══ {t} ═══")
    print(f"{'هدف':>4}{'وقف':>5}{'صفقات':>8}{'/يوم':>6}{'فوز%':>8}{'تعادل%':>8}{'حافة':>7}"
          f"{'صافي':>8}{'/صفقة':>8}{'بقاء':>6}{'أدنى شهر%':>11}{'خاسر':>6}")


def line(r, mark=''):
    print(f"{r['tp']:>4}{r['sl']:>5}{r['trades']:>8}{r['per_day']:>6.1f}{r['win_rate']:>8.2f}"
          f"{r['breakeven']:>8.2f}{r['edge']:>+7.2f}{r['net']:>8.0f}{r['per_trade']:>8.3f}"
          f"{r['avg_hold']:>6.0f}{r['min_wr']:>11.1f}{r['neg_months']:>6}{mark}")


head("أعلى نسبة فوز")
for r in sorted(rows, key=lambda r: -r['win_rate'])[:8]:
    line(r)

head("أعلى صافي نقاط")
for r in sorted(rows, key=lambda r: -r['net'])[:8]:
    line(r)

pareto = [r for r in rows
          if not any(o['win_rate'] >= r['win_rate'] and o['net'] >= r['net']
                     and (o['win_rate'] > r['win_rate'] or o['net'] > r['net'])
                     for o in rows)]
pareto.sort(key=lambda r: -r['win_rate'])
head(f"جبهة باريتو — الخيارات غير المهزومة ({len(pareto)})")
for r in pareto:
    beats = ' ✅ يتفوّق على المؤشر في الاثنين' if (r['win_rate'] > B['win_rate']
                                                   and r['net'] > B['net']) else ''
    line(r, beats)

both = [r for r in rows if r['win_rate'] > B['win_rate'] and r['net'] > B['net']]
print(f"\n═══ الخلاصة ═══")
print(f"خطط تتفوّق على المؤشر في نسبة الفوز والصافي معاً: {len(both)}")
for r in sorted(both, key=lambda r: -r['net'])[:6]:
    print(f"  هدف {r['tp']}/وقف {r['sl']} → فوز {r['win_rate']:.2f}% "
          f"(+{r['win_rate']-B['win_rate']:.2f}) • صافي {r['net']:+.0f} "
          f"(+{r['net']-B['net']:.0f} = +{100*(r['net']-B['net'])/B['net']:.0f}%) "
          f"• أسوأ شهر {r['min_net']:+.0f} • شهور خاسرة {r['neg_months']}")

top = sorted(both, key=lambda r: -r['net'])[:2] if both else []
top += sorted(rows, key=lambda r: -r['win_rate'])[:1] + sorted(rows, key=lambda r: -r['net'])[:1]
seen, uniq = set(), []
for r in top:
    if (r['tp'], r['sl']) not in seen:
        seen.add((r['tp'], r['sl'])); uniq.append(r)

print(f"\n═══ الثبات الشهري — نسبة الفوز ═══")
print(f"{'خطة':>10}" + "".join(f"{m[-2:]:>7}" for m in mons) + f"{'أدنى':>8}{'مدى':>7}")
for r in uniq:
    v = [x[0] for x in r['monthly']]
    print(f"{str(r['tp'])+'/'+str(r['sl']):>10}" + "".join(f"{x:>7.1f}" for x in v)
          + f"{min(v):>8.1f}{max(v)-min(v):>7.1f}")
bv = []
for m in mons:
    pass

print(f"\n═══ الثبات الشهري — الصافي ═══")
print(f"{'خطة':>10}" + "".join(f"{m[-2:]:>8}" for m in mons) + f"{'أسوأ':>9}")
for r in uniq:
    v = [x[1] for x in r['monthly']]
    print(f"{str(r['tp'])+'/'+str(r['sl']):>10}" + "".join(f"{x:>8.0f}" for x in v)
          + f"{min(v):>9.0f}")

json.dump([{k: v for k, v in r.items() if k != 'monthly'} for r in rows],
          open('research/results/tpsl_seq_40_60.json', 'w'), indent=1)
print("\nكُتب research/results/tpsl_seq_40_60.json")
