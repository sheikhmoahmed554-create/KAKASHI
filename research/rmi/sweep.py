"""مسح خطط الهدف/الوقف على تيار إشارات RMI، مع تحقق متقاطع بترك سنة خارج الاختيار.

بأربع سنوات فقط، أي اختيار وقياس على الداتا نفسها يضمن نتيجة جميلة وكاذبة. لذلك
تُختار الخطة على ثلاث سنوات وتُقاس على الرابعة، أربع مرات — فكل سنة تلعب دور
الغريب مرة واحدة. الحكم هو متوسط أداء السنة المتروكة، لا أفضل رقم في الجدول.

كل محاكاة تحترم إشغال الصفقة الواحدة: الإشارة التي تصل والصفقة مفتوحة تُهدر،
فالهدف الأوسع يشتري نقاطاً أكثر ويدفع ثمنها إشارات ضائعة.

    python3 sweep.py
"""
import json

import numpy as np

PU = 0.10
HORIZON = 4000
YEARS = ('2021', '2023', '2025', '2026')
TPS = list(range(40, 261, 10))
SLS = list(range(30, 181, 10))
NEVER = np.int32(1 << 30)


def load(year):
    d = json.load(open(f'sig_{year}.json'))
    n = d['bars']
    h = np.asarray(d['high'], np.float64)
    l = np.asarray(d['low'], np.float64)
    c = np.asarray(d['close'], np.float64)
    sig = sorted([(i, 1) for i in d['raw_buy']] + [(i, -1) for i in d['raw_sell']])
    # عند تعارض شراء وبيع على الشمعة نفسها، الشراء أسبق — كما في ترتيب Pine
    seen, clean = set(), []
    for i, s in sig:
        if i in seen:
            continue
        seen.add(i); clean.append((i, s))
    idx = np.array([i for i, _ in clean], np.int64)
    side = np.array([s for _, s in clean], np.int8)

    k = len(idx)
    mfe = np.zeros((k, HORIZON), np.float32)
    mae = np.zeros((k, HORIZON), np.float32)
    for a in range(k):
        i = idx[a]; ep = c[i]
        j0, j1 = i + 1, min(i + 1 + HORIZON, n)
        m = j1 - j0
        if m <= 0:
            mfe[a, :] = -1e9; mae[a, :] = -1e9
            continue
        hh, ll = h[j0:j1], l[j0:j1]
        fav, adv = ((hh - ep) / PU, (ep - ll) / PU) if side[a] == 1 else ((ep - ll) / PU, (hh - ep) / PU)
        mfe[a, :m] = np.maximum.accumulate(fav)
        mae[a, :m] = np.maximum.accumulate(adv)
        if m < HORIZON:
            mfe[a, m:] = mfe[a, m - 1]; mae[a, m:] = mae[a, m - 1]
    days = len(set(np.asarray(d['time']) // 86400000))
    return {'idx': idx, 'side': side, 'mfe': mfe, 'mae': mae, 'n': n, 'days': days,
            'engine': d['engine_internal']}


def resolve(D, tp, sl):
    """لكل إشارة: شمعة الحسم ونتيجتها. التصادم في شمعة واحدة يُلغي الصفقة."""
    mfe, mae = D['mfe'], D['mae']
    t_tp = np.where(mfe[:, -1] >= tp, (mfe >= tp).argmax(1).astype(np.int32), NEVER)
    t_sl = np.where(mae[:, -1] >= sl, (mae >= sl).argmax(1).astype(np.int32), NEVER)
    out = np.full(len(mfe), -1, np.int8)          # -1 لم تُحسم
    out[t_tp < t_sl] = 1
    out[t_sl < t_tp] = 0
    out[(t_tp == t_sl) & (t_tp < NEVER)] = -2     # تصادم → مُلغاة
    bars = np.minimum(t_tp, t_sl)
    bars[bars >= NEVER] = HORIZON
    return out, bars + 1                          # +1 لأن الفحص يبدأ من الشمعة التالية


def run(D, tp, sl, sides='BOTH'):
    """تسلسلي: صفقة واحدة في المرة، والإشارة أثناء الانشغال تُهدر."""
    out, bars = resolve(D, tp, sl)
    idx, side = D['idx'], D['side']
    allow = {'BOTH': (1, -1), 'BUY': (1,), 'SELL': (-1,)}[sides]
    busy = -1
    w = ls = skipped = wasted = 0
    hold = 0
    for a in range(len(idx)):
        i = int(idx[a])
        if side[a] not in allow:
            continue
        if i <= busy:
            wasted += 1
            continue
        ex = i + int(bars[a])
        busy = ex
        o = out[a]
        if o == 1:
            w += 1
        elif o == 0:
            ls += 1
        elif o == -2:
            skipped += 1
        hold += int(bars[a])
    n = w + ls
    if n == 0:
        return None
    net = w * tp - ls * sl
    return {'tp': tp, 'sl': sl, 'trades': n, 'wins': w, 'losses': ls,
            'win_rate': 100.0 * w / n, 'breakeven': 100.0 * sl / (tp + sl),
            'edge': 100.0 * w / n - 100.0 * sl / (tp + sl),
            'net': net, 'per_trade': net / n, 'skipped': skipped, 'wasted': wasted,
            'per_day': n / D['days'], 'avg_hold': hold / max(1, n + skipped)}


DATA = {y: load(y) for y in YEARS}

print("═══ تحقّق المحاكي المتجهي عند الخطة الافتراضية ١٣٠/٧٠ ═══")
allok = True
for y in YEARS:
    r = run(DATA[y], 130, 70)
    e = DATA[y]['engine']
    m = (r['trades'] == e['trades'] and r['wins'] == e['wins'] and r['losses'] == e['losses'])
    allok &= m
    print(f"  {y}: محاكي {r['trades']}/{r['wins']}W/{r['losses']}L  •  "
          f"محرك {e['trades']}/{e['wins']}W/{e['losses']}L  {'✓' if m else '✗'}")
if not allok:
    raise SystemExit("!! المحاكي المتجهي لا يطابق — توقّف.")

# ── المسح الكامل لكل سنة ─────────────────────────────────────────────────────
GRID = [(tp, sl) for tp in TPS for sl in SLS]
print(f"\nمسح {len(GRID)} خطة × {len(YEARS)} سنوات…", flush=True)
R = {y: {} for y in YEARS}
for y in YEARS:
    for (tp, sl) in GRID:
        r = run(DATA[y], tp, sl)
        if r:
            R[y][(tp, sl)] = r

json.dump({y: {f"{tp}_{sl}": v for (tp, sl), v in R[y].items()} for y in YEARS},
          open('sweep_grid.json', 'w'))


def agg(plan, years):
    w = sum(R[y][plan]['wins'] for y in years)
    ls = sum(R[y][plan]['losses'] for y in years)
    n = w + ls
    net = w * plan[0] - ls * plan[1]
    return {'trades': n, 'win_rate': 100.0 * w / n if n else 0,
            'net': net, 'per_trade': net / n if n else 0}


# ── تحقق متقاطع: اختر على ثلاث سنوات، اختبر على الرابعة ─────────────────────
print("\n═══ تحقق متقاطع بترك سنة خارج الاختيار ═══")
print(f"{'السنة المتروكة':>14}{'الخطة المختارة':>16}{'تدريب/صفقة':>13}"
      f"{'اختبار/صفقة':>13}{'اختبار فوز%':>13}{'اختبار صافي':>13}")
oos = []
for held in YEARS:
    tr_years = [y for y in YEARS if y != held]
    best = max(GRID, key=lambda p: agg(p, tr_years)['per_trade'])
    a = agg(best, tr_years)
    t = R[held][best]
    oos.append((held, best, a, t))
    print(f"{held:>14}{str(best[0])+'/'+str(best[1]):>16}{a['per_trade']:>13.3f}"
          f"{t['per_trade']:>13.3f}{t['win_rate']:>13.2f}{t['net']:>13.0f}")

tot_n = sum(t['trades'] for _, _, _, t in oos)
tot_net = sum(t['net'] for _, _, _, t in oos)
print(f"\n  مجموع السنوات المتروكة: {tot_n:,} صفقة • صافي {tot_net:+,.0f} • "
      f"{tot_net/tot_n:+.3f} نقطة/صفقة")
base_n = sum(R[y][(130, 70)]['trades'] for y in YEARS)
base_net = sum(R[y][(130, 70)]['net'] for y in YEARS)
print(f"  الخطة الافتراضية ١٣٠/٧٠  : {base_n:,} صفقة • صافي {base_net:+,.0f} • "
      f"{base_net/base_n:+.3f} نقطة/صفقة")

# ── أفضل الخطط على المجموع (للاطّلاع فقط — داخل العيّنة) ────────────────────
rows = [(p, agg(p, YEARS)) for p in GRID]
rows.sort(key=lambda x: -x[1]['per_trade'])
print("\n═══ أعلى توقّع على السنوات الأربع مجتمعة (داخل العيّنة — متفائل) ═══")
print(f"{'هدف':>5}{'وقف':>5}{'صفقات':>9}{'فوز%':>8}{'تعادل%':>9}{'صافي':>10}{'/صفقة':>9}")
for p, a in rows[:10]:
    be = 100.0 * p[1] / (p[0] + p[1])
    print(f"{p[0]:>5}{p[1]:>5}{a['trades']:>9}{a['win_rate']:>8.2f}{be:>9.2f}"
          f"{a['net']:>10.0f}{a['per_trade']:>9.3f}")
d = agg((130, 70), YEARS)
print(f"{130:>5}{70:>5}{d['trades']:>9}{d['win_rate']:>8.2f}{35.0:>9.2f}"
      f"{d['net']:>10.0f}{d['per_trade']:>9.3f}   ← الافتراضية")

# ── ثبات: كم سنة موجبة لكل خطة من أفضل عشر ─────────────────────────────────
print("\n═══ ثبات أفضل الخطط عبر السنوات (صافي كل سنة) ═══")
print(f"{'خطة':>10}" + "".join(f"{y:>10}" for y in YEARS) + f"{'موجبة':>8}")
for p, _ in rows[:8]:
    nets = [R[y][p]['net'] for y in YEARS]
    print(f"{str(p[0])+'/'+str(p[1]):>10}" + "".join(f"{v:>10.0f}" for v in nets)
          + f"{sum(1 for v in nets if v > 0):>8}")
nets = [R[y][(130, 70)]['net'] for y in YEARS]
print(f"{'130/70':>10}" + "".join(f"{v:>10.0f}" for v in nets)
      + f"{sum(1 for v in nets if v > 0):>8}   ← الافتراضية")
