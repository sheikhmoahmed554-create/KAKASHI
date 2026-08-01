"""تركيب مصادر Multicator وقياسها، بلا إعادة تشغيل المحرك.

المصادر شروط شمعة مستقلة عن حالة الصفقة، ومحرك RMI ينزع تسليحه بإشارته وحدها،
فأي تركيبة من المصادر والفلاتر تُحسب هنا بدقة تامة. نُحضّر مسار كل شمعة مرشّحة
مرة واحدة، ثم تُقاس كل تركيبة في أجزاء من الثانية.

كل قياس يقارن بخط الأساس العشوائي لنفس السنة ونفس الجهة، لا بالتعادل النظري —
لأن اتجاه الذهب وحده يرفع أو يخفض نسبة الفوز عدة نقاط مئوية.
"""
import json
import itertools

import numpy as np

PU = 0.10
TP = 130.0
SL = 70.0
HORIZON = 4000
NEVER = np.int32(1 << 30)
YEARS = ('2021', '2023', '2025', '2026')
SOURCES = ['Rsi', 'Macd', 'Adx', 'Bb', 'Ichi', 'Sar', 'Pivot', 'Fib', 'Ma', 'Brt', 'Smb', 'Sr', 'Str']
# خط الأساس العشوائي (شراء, بيع) لكل سنة — محسوب في random_baseline.py
RND = {'2021': (34.11, 34.93), '2023': (34.57, 34.00),
       '2025': (38.25, 32.46), '2026': (32.67, 36.94)}


def load(year):
    d = json.load(open(f'probe_{year}.json'))
    n = d['bars']
    h = np.asarray(d['high']); l = np.asarray(d['low']); c = np.asarray(d['close'])
    B = {}
    for k, v in d['bits'].items():
        a = np.zeros(n, bool); a[v] = True; B[k] = a

    # الشموع التي قد تصير دخولاً في أي تركيبة
    cand = B['rmiRawBuy'] | B['rmiRawSell']
    for s in SOURCES:
        cand |= B[f'mc{s}Buy'] | B[f'mc{s}Sell']
    idx = np.flatnonzero(cand)

    # المسار لكل مرشّح، بالنقاط، للجهتين
    k = len(idx)
    up = np.zeros((k, HORIZON), np.float32)     # أقصى صعود متاح
    dn = np.zeros((k, HORIZON), np.float32)     # أقصى هبوط متاح
    for a in range(k):
        i = idx[a]; ep = c[i]
        j0, j1 = i + 1, min(i + 1 + HORIZON, n)
        m = j1 - j0
        if m <= 0:
            up[a, :] = -1e9; dn[a, :] = -1e9
            continue
        up[a, :m] = np.maximum.accumulate((h[j0:j1] - ep) / PU)
        dn[a, :m] = np.maximum.accumulate((ep - l[j0:j1]) / PU)
        if m < HORIZON:
            up[a, m:] = up[a, m - 1]; dn[a, m:] = dn[a, m - 1]

    def touch(curve, level):
        return np.where(curve[:, -1] >= level,
                        (curve >= level).argmax(1).astype(np.int32), NEVER)

    # الشراء: الهدف صعوداً والوقف هبوطاً. البيع بالعكس.
    res, bars = {}, {}
    for side, (tpc, slc) in ((1, (up, dn)), (-1, (dn, up))):
        t1 = touch(tpc, TP); t2 = touch(slc, SL)
        o = np.full(k, -1, np.int8)
        o[t1 < t2] = 1
        o[t2 < t1] = 0
        o[(t1 == t2) & (t1 < NEVER)] = -2        # تصادم في شمعة واحدة → تُلغى
        b = np.minimum(t1, t2); b[b >= NEVER] = HORIZON
        res[side] = o; bars[side] = b + 1

    pos = -np.ones(n, np.int64); pos[idx] = np.arange(k)
    days = len(set(np.asarray(d['time']) // 86400000))
    return {'B': B, 'idx': idx, 'pos': pos, 'res': res, 'bars': bars,
            'n': n, 'days': days, 'engine': d['engine_internal'], 'year': year}


def streams(D, cfg):
    """cfg: {'Rsi': 'Source'|'Filter'|'Off', ...} → إشارتا الدخول النهائيتان."""
    B = D['B']
    buy = B['rmiRawBuy'].copy()
    sell = B['rmiRawSell'].copy()
    fb = np.ones(D['n'], bool)
    fs = np.ones(D['n'], bool)
    for s in SOURCES:
        mode = cfg.get(s, 'Off')
        if mode == 'Source':
            buy |= B[f'mc{s}Buy']; sell |= B[f'mc{s}Sell']
        elif mode == 'Filter':
            fb &= B[f'mc{s}BuyOK']; fs &= B[f'mc{s}SellOK']
    return buy & fb, sell & fs


def run(D, cfg):
    buy, sell = streams(D, cfg)
    pos, res, bars = D['pos'], D['res'], D['bars']
    order = np.flatnonzero(buy | sell)
    busy = -1
    w = {1: 0, -1: 0}; ls = {1: 0, -1: 0}
    skipped = 0; hold = 0
    for i in order:
        if i <= busy:
            continue
        side = 1 if buy[i] else -1          # الشراء أسبق عند التزامن، كترتيب Pine
        a = pos[i]
        if a < 0:
            continue
        busy = i + int(bars[side][a]); hold += int(bars[side][a])
        o = res[side][a]
        if o == 1:
            w[side] += 1
        elif o == 0:
            ls[side] += 1
        elif o == -2:
            skipped += 1
    tw = w[1] + w[-1]; tl = ls[1] + ls[-1]; n = tw + tl
    if n == 0:
        return None
    net = tw * TP - tl * SL
    lift = 0.0
    for side, key in ((1, 0), (-1, 1)):
        m = w[side] + ls[side]
        if m:
            lift += m * (100.0 * w[side] / m - RND[D['year']][key])
    return {'trades': n, 'wins': tw, 'losses': tl, 'win_rate': 100.0 * tw / n,
            'net': net, 'per_trade': net / n, 'per_day': n / D['days'],
            'lift': lift / n, 'skipped': skipped, 'avg_hold': hold / max(1, n),
            'buy': (w[1], ls[1]), 'sell': (w[-1], ls[-1])}


def total(DATA, cfg):
    rs = {y: run(DATA[y], cfg) for y in YEARS}
    if any(r is None for r in rs.values()):
        return None, rs
    tw = sum(r['wins'] for r in rs.values()); tl = sum(r['losses'] for r in rs.values())
    n = tw + tl
    net = sum(r['net'] for r in rs.values())
    lift = sum(r['lift'] * r['trades'] for r in rs.values()) / n
    se = 100.0 * np.sqrt(0.35 * 0.65 / n)
    return {'trades': n, 'win_rate': 100.0 * tw / n, 'net': net, 'per_trade': net / n,
            'lift': lift, 'sigma': lift / se, 'pos_years': sum(1 for r in rs.values() if r['net'] > 0),
            'per_day': np.mean([r['per_day'] for r in rs.values()])}, rs


if __name__ == '__main__':
    DATA = {y: load(y) for y in YEARS}
    OFF = {}

    print("═══ تحقّق: التركيبة الفارغة = خط الأساس المتحقَّق منه ═══")
    ok = True
    for y in YEARS:
        r = run(DATA[y], OFF); e = DATA[y]['engine']
        m = (r['trades'] == e['trades'] and r['wins'] == e['wins'] and r['losses'] == e['losses'])
        ok &= m
        print(f"  {y}: {r['trades']}/{r['wins']}W/{r['losses']}L  مقابل محرك "
              f"{e['trades']}/{e['wins']}W/{e['losses']}L  {'✓' if m else '✗'}")
    if not ok:
        raise SystemExit("!! التركيب لا يطابق — توقّف.")

    base, _ = total(DATA, OFF)
    print(f"\nخط الأساس: {base['trades']:,} صفقة • فوز {base['win_rate']:.2f}% • "
          f"صافي {base['net']:+,.0f} • زيادة {base['lift']:+.2f} ({base['sigma']:+.2f}σ) • "
          f"سنوات موجبة {base['pos_years']}/4")

    print(f"\n═══ كل مصدر وحده ═══")
    print(f"{'المصدر':>8}{'الوضع':>9}{'صفقات':>8}{'/يوم':>7}{'فوز%':>8}{'الزيادة':>9}"
          f"{'σ':>7}{'صافي':>9}{'/صفقة':>8}{'موجبة':>7}")
    print(f"{'—':>8}{'باطن':>9}{base['trades']:>8}{base['per_day']:>7.1f}{base['win_rate']:>8.2f}"
          f"{base['lift']:>+9.2f}{base['sigma']:>+7.2f}{base['net']:>9.0f}"
          f"{base['per_trade']:>8.3f}{base['pos_years']:>7}")
    rows = []
    for s in SOURCES:
        for mode in ('Source', 'Filter'):
            t, _ = total(DATA, {s: mode})
            if t is None:
                continue
            rows.append((s, mode, t))
            print(f"{s:>8}{mode:>9}{t['trades']:>8}{t['per_day']:>7.1f}{t['win_rate']:>8.2f}"
                  f"{t['lift']:>+9.2f}{t['sigma']:>+7.2f}{t['net']:>9.0f}"
                  f"{t['per_trade']:>8.3f}{t['pos_years']:>7}")
    json.dump([{'source': s, 'mode': m, **{k: float(v) for k, v in t.items()}}
               for s, m, t in rows], open('single_source.json', 'w'), indent=1)
    print("\nكُتب single_source.json")
