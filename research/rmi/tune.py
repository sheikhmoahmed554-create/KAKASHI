"""ضبط إعدادات RMI نفسها — لا ما حولها.

كل ما جُرِّب سابقاً كان طبقةً فوق المؤشر: أهداف، فلاتر، مصادر، تبديل حسب نوع
السوق. كلها سقطت خارج العيّنة. هذا أول مسح يمسّ قلب المؤشر: طول RMI، الزخم،
عتبات المناطق، عدد شمعات التفاعل، نافذة الانتظار، وشرط القمة/القاع السابق.

المنطق مطابق للمحرك شمعةً بشمعة (`rmi_py.verify()`)، والمحاكاة متسلسلة — صفقة
واحدة في المرة — فطول بقاء الصفقة يحجب الإشارات التالية كما في الواقع.

يُقاس كل إعداد على السنوات الأربع منفصلةً في مرور واحد، ثم يتم الاختيار خارج
العيّنة مجاناً بأي قاعدة. وعند ألف إعداد وأكثر، أفضلُها داخل العيّنة سيبدو
ممتازاً بالضرورة — الحَكَم الوحيد هو السنة التي لم تدخل الاختيار.

    python3 tune.py
"""
import itertools
import json
import time

import numpy as np

import rmi_py

YEARS = ('2021', '2023', '2025', '2026')
TP, SL = 130.0, 70.0
RND = {'2021': (34.11, 34.93), '2023': (34.57, 34.00),
       '2025': (38.25, 32.46), '2026': (32.67, 36.94)}

GRID = dict(
    length=[8, 12, 18, 25, 35],
    momentum=[3, 5, 6, 10],
    zone=[(20.0, 80.0), (25.0, 75.0), (30.0, 70.0), (15.0, 85.0)],
    reaction=[1, 2, 3],
    wait=[6, 12, 24],
    extreme=[0, 40],
)


def load(year):
    z = np.load(f'allres_{year}.npz')
    return {'H': z['high'].astype(float), 'L': z['low'].astype(float),
            'C': z['close'], 'time': z['time'],
            'res': {1: z['res_b'], -1: z['res_s']},
            'bars': {1: z['bars_b'], -1: z['bars_s']},
            'n': int(z['n']), 'days': int(z['days']), 'year': year}


def prep(D):
    """يُحسب الثقيل مرة واحدة لكل سنة: RMI لكل (طول، زخم)، والقمم/القيعان."""
    n, C, H, L = D['n'], D['C'], D['H'], D['L']
    P = {'rmi': {}, 'ex': {}}
    for ln, mom in itertools.product(GRID['length'], GRID['momentum']):
        d = np.zeros(n)
        d[mom:] = C[mom:] - C[:-mom]
        up = rmi_py.ema(np.maximum(d, 0.0), ln)
        dn = rmi_py.ema(np.maximum(-d, 0.0), ln)
        with np.errstate(divide='ignore', invalid='ignore'):
            r = np.where(dn == 0.0, np.where(up == 0.0, 50.0, 100.0),
                         100.0 - 100.0 / (1.0 + up / dn))
        r[np.isnan(up)] = np.nan
        P['rmi'][(ln, mom)] = r
    for ex in GRID['extreme']:
        if ex == 0:
            P['ex'][0] = (np.zeros(n, bool), np.zeros(n, bool))
            continue
        pl = np.r_[np.nan, rmi_py.rolling_min(L, ex)[:-1]]
        ph = np.r_[np.nan, rmi_py.rolling_max(H, ex)[:-1]]
        eb = L <= pl; eb[np.isnan(pl)] = False
        es = H >= ph; es[np.isnan(ph)] = False
        P['ex'][ex] = (eb, es)
    P['pUp'] = np.r_[False, C[1:] > C[:-1]]
    P['pDn'] = np.r_[False, C[1:] < C[:-1]]
    return P


def sig(D, P, cfg):
    n = D['n']
    r = P['rmi'][(cfg['length'], cfg['momentum'])]
    os_, ob = cfg['zone']
    inB = r <= os_; inB[np.isnan(r)] = False
    inS = r >= ob;  inS[np.isnan(r)] = False
    bE = inB & ~np.r_[False, inB[:-1]]
    sE = inS & ~np.r_[False, inS[:-1]]
    uT = np.r_[False, r[1:] > r[:-1]]
    dT = np.r_[False, r[1:] < r[:-1]]
    pUp, pDn = P['pUp'], P['pDn']
    exB, exS = P['ex'][cfg['extreme']]
    ex, need, wait = cfg['extreme'], cfg['reaction'], cfg['wait']

    buy = np.zeros(n, bool); sell = np.zeros(n, bool)
    bArm = sArm = False; bBar = sBar = 0; bCnt = sCnt = 0; bSeen = sSeen = False
    for i in range(n):
        if bE[i]:
            bArm, sArm = True, False; bBar = i; bCnt = sCnt = 0; bSeen = bool(exB[i])
        if sE[i]:
            sArm, bArm = True, False; sBar = i; sCnt = bCnt = 0; sSeen = bool(exS[i])
        if bArm:
            if exB[i]:
                bSeen = True
            if i - bBar > wait:
                bArm = False; bCnt = 0
            else:
                bCnt = bCnt + 1 if (i > bBar and uT[i] and pUp[i]) else 0
                if bCnt >= need and (ex == 0 or bSeen):
                    buy[i] = True; bArm = sArm = False
                    continue
        if sArm:
            if exS[i]:
                sSeen = True
            if i - sBar > wait:
                sArm = False; sCnt = 0
            else:
                sCnt = sCnt + 1 if (i > sBar and dT[i] and pDn[i]) else 0
                if sCnt >= need and (ex == 0 or sSeen):
                    sell[i] = True; bArm = sArm = False
    return buy, sell


def simulate(D, buy, sell):
    """متسلسلة: صفقة واحدة في المرة، والشراء أسبق عند التزامن كترتيب Pine."""
    res, bars = D['res'], D['bars']
    order = np.flatnonzero(buy | sell)
    busy = -1
    w = {1: 0, -1: 0}; ls = {1: 0, -1: 0}
    for i in order:
        if i <= busy:
            continue
        side = 1 if buy[i] else -1
        busy = i + int(bars[side][i])
        o = res[side][i]
        if o == 1:
            w[side] += 1
        elif o == 0:
            ls[side] += 1
    tw = w[1] + w[-1]; tl = ls[1] + ls[-1]; n = tw + tl
    if n == 0:
        return None
    lift = 0.0
    for side, k in ((1, 0), (-1, 1)):
        m = w[side] + ls[side]
        if m:
            lift += m * (100.0 * w[side] / m - RND[D['year']][k])
    return {'trades': n, 'wins': tw, 'net': tw * TP - tl * SL,
            'lift': lift / n, 'per_day': n / D['days']}


def combine(per, years):
    rs = [per[y] for y in years]
    if any(r is None for r in rs):
        return None
    n = sum(r['trades'] for r in rs)
    if n < 200:
        return None
    w = sum(r['wins'] for r in rs)
    net = sum(r['net'] for r in rs)
    lift = sum(r['lift'] * r['trades'] for r in rs) / n
    se = 100.0 * np.sqrt(0.35 * 0.65 / n)
    return {'trades': n, 'win_rate': 100.0 * w / n, 'net': net, 'per_trade': net / n,
            'lift': lift, 'sigma': lift / se,
            'pos': sum(1 for r in rs if r['net'] > 0),
            'per_day': float(np.mean([r['per_day'] for r in rs]))}


def main():
    t0 = time.time()
    DATA = {y: load(y) for y in YEARS}
    PREP = {}
    for y in YEARS:
        PREP[y] = prep(DATA[y])
        print(f"  حُضّرت {y} • {time.time()-t0:.0f}s", flush=True)

    keys = ['length', 'momentum', 'zone', 'reaction', 'wait', 'extreme']
    combos = list(itertools.product(*(GRID[k] for k in keys)))
    print(f"\n{len(combos)} إعداداً × {len(YEARS)} سنوات", flush=True)

    out = []
    for c, vals in enumerate(combos):
        cfg = dict(zip(keys, vals))
        per = {y: simulate(DATA[y], *sig(DATA[y], PREP[y], cfg)) for y in YEARS}
        rec = {'cfg': {k: (list(v) if isinstance(v, tuple) else v)
                       for k, v in cfg.items()},
               'per': {y: (None if per[y] is None else
                           {k: float(v) for k, v in per[y].items()}) for y in YEARS}}
        out.append(rec)
        if (c + 1) % 100 == 0:
            print(f"  {c+1}/{len(combos)} • {time.time()-t0:.0f}s", flush=True)

    json.dump(out, open('tune_raw.json', 'w'))
    print(f"\nكُتب tune_raw.json • {time.time()-t0:.0f}s")


if __name__ == '__main__':
    main()
