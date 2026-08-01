"""هل يحلّ الهدف المربوط بـ ATR مشكلة عدم انتقال الخطة بين السنوات؟

الهدف الثابت بالنقاط يعني ١٣ دولاراً سواء كان الذهب عند ١,٨٠٠ أو ٤,٣٠٠، فالخطة
نفسها تتصرّف تصرّفاً مختلفاً كلياً كل سنة. الهدف المربوط بـ ATR يُفترض أن ينقل
المعنى لا الرقم، فيصمد عبر السنوات.

هذه فرضية بنيوية لا بحث عن رقم أفضل، ولذلك تستحق الاختبار. والحكم عليها هو
نفسه: الاختيار على ثلاث سنوات والقياس على الرابعة.

    python3 atr_plan.py
"""
import json

import numpy as np

PU = 0.10
HORIZON = 4000
ATR_LEN = 14
YEARS = ('2021', '2023', '2025', '2026')
NEVER = np.int32(1 << 30)
K_TP = [round(x, 1) for x in np.arange(1.0, 8.1, 0.5)]
K_SL = [round(x, 1) for x in np.arange(0.5, 5.1, 0.5)]


def wilder(x, n):
    out = np.empty(len(x)); out[0] = x[0]
    a = 1.0 / n
    for i in range(1, len(x)):
        out[i] = a * x[i] + (1 - a) * out[i - 1]
    return out


def load(year):
    d = json.load(open(f'sig_{year}.json'))
    n = d['bars']
    h = np.asarray(d['high']); l = np.asarray(d['low']); c = np.asarray(d['close'])
    pc = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(np.abs(h - pc), np.abs(l - pc)))
    atr_pts = wilder(tr, ATR_LEN) / PU        # ATR بالنقاط

    sig = sorted([(i, 1) for i in d['raw_buy']] + [(i, -1) for i in d['raw_sell']])
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
    return {'idx': idx, 'side': side, 'mfe': mfe, 'mae': mae,
            'atr': atr_pts[idx], 'days': days, 'year': year}


def run(D, tp_pts, sl_pts):
    """tp_pts / sl_pts: مصفوفة لكل إشارة (تتغيّر مع ATR) أو رقم واحد."""
    mfe, mae = D['mfe'], D['mae']
    tp = np.broadcast_to(np.atleast_1d(tp_pts), (len(mfe),)).astype(np.float32)
    sl = np.broadcast_to(np.atleast_1d(sl_pts), (len(mfe),)).astype(np.float32)
    t_tp = np.where(mfe[:, -1] >= tp, (mfe >= tp[:, None]).argmax(1).astype(np.int32), NEVER)
    t_sl = np.where(mae[:, -1] >= sl, (mae >= sl[:, None]).argmax(1).astype(np.int32), NEVER)
    out = np.full(len(mfe), -1, np.int8)
    out[t_tp < t_sl] = 1
    out[t_sl < t_tp] = 0
    out[(t_tp == t_sl) & (t_tp < NEVER)] = -2
    bars = np.minimum(t_tp, t_sl); bars[bars >= NEVER] = HORIZON
    bars = bars + 1

    idx = D['idx']
    busy = -1; w = ls = 0; net = 0.0; wasted = 0; hold = 0
    for a in range(len(idx)):
        i = int(idx[a])
        if i <= busy:
            wasted += 1; continue
        busy = i + int(bars[a])
        hold += int(bars[a])
        if out[a] == 1:
            w += 1; net += float(tp[a])
        elif out[a] == 0:
            ls += 1; net -= float(sl[a])
    n = w + ls
    if n == 0:
        return None
    return {'trades': n, 'wins': w, 'losses': ls, 'win_rate': 100.0 * w / n,
            'net': net, 'per_trade': net / n, 'wasted': wasted,
            'per_day': n / D['days'], 'avg_hold': hold / max(1, n)}


DATA = {y: load(y) for y in YEARS}
print("متوسط ATR على شمعة الإشارة (بالنقاط):")
for y in YEARS:
    print(f"  {y}: {DATA[y]['atr'].mean():>7.1f}   "
          f"(هدف ١٣٠ = {130/DATA[y]['atr'].mean():>4.2f}× ATR)")

GRID = [(a, b) for a in K_TP for b in K_SL]
R = {y: {} for y in YEARS}
for y in YEARS:
    for (a, b) in GRID:
        r = run(DATA[y], a * DATA[y]['atr'], b * DATA[y]['atr'])
        if r:
            R[y][(a, b)] = r


def agg(p, years):
    w = sum(R[y][p]['wins'] for y in years)
    ls = sum(R[y][p]['losses'] for y in years)
    net = sum(R[y][p]['net'] for y in years)
    n = w + ls
    return {'trades': n, 'win_rate': 100.0 * w / n if n else 0,
            'net': net, 'per_trade': net / n if n else 0}


pos4 = [p for p in GRID if all(R[y][p]['net'] > 0 for y in YEARS)]
print(f"\nخطط ATR موجبة في السنوات الأربع: {len(pos4)} من {len(GRID)}"
      f"  ({100*len(pos4)/len(GRID):.1f}% مقابل 6.25% للصدفة)")

rows = sorted(GRID, key=lambda p: -agg(p, YEARS)['per_trade'])
print(f"\n═══ أعلى توقّع (داخل العيّنة) ═══")
print(f"{'×هدف':>6}{'×وقف':>6}{'صفقات':>8}{'فوز%':>8}{'صافي':>10}{'/صفقة':>9}"
      + "".join(f"{y:>9}" for y in YEARS))
for p in rows[:10]:
    a = agg(p, YEARS)
    print(f"{p[0]:>6.1f}{p[1]:>6.1f}{a['trades']:>8}{a['win_rate']:>8.2f}{a['net']:>10.0f}"
          f"{a['per_trade']:>9.3f}" + "".join(f"{R[y][p]['net']:>9.0f}" for y in YEARS))

print(f"\n═══ تحقق متقاطع بترك سنة ═══")
print(f"{'المتروكة':>10}{'المختارة':>12}{'تدريب/صفقة':>13}{'اختبار/صفقة':>13}"
      f"{'اختبار فوز%':>13}{'اختبار صافي':>13}")
tn = tnet = 0
for held in YEARS:
    tr = [y for y in YEARS if y != held]
    best = max(GRID, key=lambda p: agg(p, tr)['per_trade'])
    t = R[held][best]
    tn += t['trades']; tnet += t['net']
    print(f"{held:>10}{f'{best[0]}×/{best[1]}×':>12}{agg(best, tr)['per_trade']:>13.3f}"
          f"{t['per_trade']:>13.3f}{t['win_rate']:>13.2f}{t['net']:>13.0f}")
print(f"\n  مجموع خارج العيّنة: {tn:,} صفقة • صافي {tnet:+,.0f} • {tnet/tn:+.3f}/صفقة")
print(f"  الافتراضية ١٣٠/٧٠ الثابتة: 3,208 صفقة • صافي +3,040 • +0.948/صفقة")

json.dump({f"{a}_{b}": {y: R[y][(a, b)] for y in YEARS} for (a, b) in GRID},
          open('atr_grid.json', 'w'))
print("\nكُتب atr_grid.json")
