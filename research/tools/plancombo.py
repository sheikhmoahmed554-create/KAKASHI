"""بحث تركيبي على محركات SYR30 بخطة خروج ثابتة صحيحة.

الفرق عن combos.py القديم: الخطة 45/65 بدل 39/55 — المسح أثبت أن الأهداف الأكبر
تدفع أكثر — والترتيب بصافي النقاط لا بنسبة الربح وحدها، لأن نسبة ربح عالية
بهدف صغير خسارة (هذا بالضبط ما لاحظه صاحب المؤشر).

القيد المطلوب: الهدف 30–60 نقطة • الوقف ≤ الهدف+20 • صفقة واحدة مفتوحة •
وقف زمني 30 شمعة.

    python3 plancombo.py [TP] [SL]
"""
import json, csv, re, sys, datetime, numpy as np

PU = 0.1; MAXBARS = 30
TP = float(sys.argv[1]) if len(sys.argv) > 1 else 45.0
SL = float(sys.argv[2]) if len(sys.argv) > 2 else 65.0
BE = 100 * SL / (TP + SL)

R = list(csv.DictReader(open('vault.csv')))
NB = 60000                                    # نافذة الجرد
R = R[:NB]
H = np.array([float(r['high']) for r in R])
L = np.array([float(r['low']) for r in R])
C = np.array([float(r['close']) for r in R])
N = len(R)
HR = np.array([int(r['time'][11:13]) for r in R])
TS = np.array([datetime.datetime.fromisoformat(r['time']).timestamp() for r in R])
DAYS = len(set(r['time'][:10] for r in R))
GAP = np.concatenate([[True], np.diff(TS) > 300])
VALID = (HR < 22) & ~GAP
print('شموع %d | أيام تداول %d | خطة %.0f/%.0f | تعادل %.2f%%' % (N, DAYS, TP, SL, BE), flush=True)


def precompute(buy):
    """لكل شمعة: 1 ربح / 0 خسارة، النقاط الفعلية، وعدد الشموع حتى الخروج."""
    ep = C
    tp = ep + (TP * PU if buy else -TP * PU)
    sl = ep - (SL * PU if buy else -SL * PU)
    kind = np.zeros(N, np.int8)               # 0 = لم يُحسم بعد
    bars = np.full(N, MAXBARS, np.int16)
    for k in range(1, MAXBARS + 1):
        j = np.minimum(np.arange(N) + k, N - 1)
        alive = kind == 0
        hs = (L[j] <= sl) if buy else (H[j] >= sl)
        ht = (H[j] >= tp) if buy else (L[j] <= tp)
        s = alive & hs; t = alive & ht & ~hs   # الوقف أولاً عند التعادل داخل الشمعة
        kind[s] = 2; bars[s] = k
        kind[t] = 1; bars[t] = k
    pts = np.where(kind == 1, TP, np.where(kind == 2, -SL, 0.0))
    j = np.minimum(np.arange(N) + MAXBARS, N - 1)
    tail = kind == 0
    pts[tail] = ((C[j] - C) / PU if buy else (C - C[j]) / PU)[tail]
    return pts.astype(np.float32), bars, kind


print('حساب مسبق...', flush=True)
PTS = {'BUY': None, 'SELL': None}; BARS = {}; KIND = {}
for side, buy in (('BUY', True), ('SELL', False)):
    PTS[side], BARS[side], KIND[side] = precompute(buy)
print('تم.', flush=True)


def side_of(nm):
    if re.search(r'(Buy|Long)', nm) or nm.endswith('B'): return 'BUY'
    if re.search(r'(Sell|Short)', nm) or nm.endswith('S'): return 'SELL'
    return None


d = json.load(open('inventory_all.json'))
ENG = {}
for nm, ev in (d['fires'] or {}).items():
    if not ev: continue
    sn = side_of(nm)
    if sn is None: continue
    m = np.zeros(N, bool)
    idx = np.array([i for i in ev if i < N], np.int64)
    if len(idx) < 40: continue                # محرك نادر جداً لا يُقاس
    m[idx] = True
    m &= VALID
    if m.sum() < 40: continue
    ENG[nm] = (sn, m)
print('محركات صالحة: %d  (شراء %d / بيع %d)' %
      (len(ENG), sum(1 for v in ENG.values() if v[0] == 'BUY'),
       sum(1 for v in ENG.values() if v[0] == 'SELL')), flush=True)


def walk(mask, side):
    """محاكاة تسلسلية: صفقة واحدة مفتوحة، تعطي (عدد، هدف، وقف، وقت رابح، وقت خاسر، صافي)."""
    p, b, k = PTS[side], BARS[side], KIND[side]
    idx = np.flatnonzero(mask)
    busy = -1; hit = miss = tw = tl = 0; net = 0.0; dur = 0
    for i in idx:
        if i <= busy or i >= N - 1: continue
        busy = i + int(b[i]); net += float(p[i]); dur += int(b[i])
        kk = k[i]
        if kk == 1: hit += 1
        elif kk == 2: miss += 1
        elif p[i] > 0: tw += 1
        else: tl += 1
    tot = hit + miss + tw + tl
    return tot, hit, miss, tw, tl, net, (dur / tot if tot else 0)


def walk_two(mB, mS):
    """محفظة الجانبين معاً: أول إشارة تفوز، لا تُفتح ثانية حتى تُغلق الأولى."""
    both = np.flatnonzero(mB | mS)
    busy = -1; hit = miss = tw = tl = 0; net = 0.0; dur = 0
    for i in both:
        if i <= busy or i >= N - 1: continue
        side = 'BUY' if mB[i] else 'SELL'
        p, b, k = PTS[side], BARS[side], KIND[side]
        busy = i + int(b[i]); net += float(p[i]); dur += int(b[i])
        kk = k[i]
        if kk == 1: hit += 1
        elif kk == 2: miss += 1
        elif p[i] > 0: tw += 1
        else: tl += 1
    tot = hit + miss + tw + tl
    return tot, hit, miss, tw, tl, net, (dur / tot if tot else 0)


def score(r):
    tot, hit, miss, tw, tl, net, dur = r
    if tot < 30: return None
    wr = 100 * (hit + tw) / tot
    return dict(trades=tot, hit=hit, miss=miss, tw=tw, tl=tl, net=round(net),
                wr=round(wr, 2), per=round(net / tot, 2),
                perday=round(tot / DAYS, 1), netday=round(net / DAYS, 1),
                mins=round(dur, 1), edge=round(wr - BE, 2))


# ── 1. كل محرك وحده ──
solo = {}
for nm, (sn, m) in ENG.items():
    s = score(walk(m, sn))
    if s: solo[nm] = dict(side=sn, **s)
srt = sorted(solo.items(), key=lambda x: -x[1]['net'])
print('\n══ أفضل ٢٥ محرك منفرد (مرتّبة بالصافي) ══', flush=True)
print('%-28s %5s %7s %6s %6s %7s %8s %7s' % ('المحرك', 'جهة', 'صفقات', 'هدف', 'وقف', 'ربح%', 'صافي', '/يوم'))
for nm, s in srt[:25]:
    print('%-28s %5s %7d %6d %6d %6.2f%% %+8d %7.1f' %
          (nm, s['side'], s['trades'], s['hit'], s['miss'], s['wr'], s['net'], s['perday']), flush=True)
json.dump(solo, open('plancombo_solo.json', 'w'), ensure_ascii=False, indent=1)


# ── 2. البحث التركيبي: OR داخل نفس الجهة، شعاع ٤٠ ──
def combo_mask(names):
    m = np.zeros(N, bool)
    for nm in names: m |= ENG[nm][1]
    return m


BEAM = 40
results = {}
for sn in ('BUY', 'SELL'):
    pool = [nm for nm in solo if solo[nm]['side'] == sn]
    pool.sort(key=lambda n: -solo[n]['net'])
    pool = pool[:60]                                   # أعلى ٦٠ محرك لكل جهة
    print('\n══ تركيبات %s  (مجمّع %d) ══' % (sn, len(pool)), flush=True)
    beam = [((nm,), solo[nm]) for nm in pool[:BEAM]]
    best_all = [(t, s) for t, s in beam]
    for depth in (2, 3, 4):
        nxt = []
        seen = set()
        for names, _ in beam:
            for nm in pool:
                if nm in names: continue
                key = tuple(sorted(names + (nm,)))
                if key in seen: continue
                seen.add(key)
                s = score(walk(combo_mask(key), sn))
                if s: nxt.append((key, s))
        nxt.sort(key=lambda x: -x[1]['net'])
        beam = nxt[:BEAM]
        best_all += beam[:10]
        if beam:
            k, s = beam[0]
            print('  عمق %d: أفضل صافي %+d | %d صفقة (%.1f/يوم) | ربح %.2f%% | %s'
                  % (depth, s['net'], s['trades'], s['perday'], s['wr'], ' + '.join(k)), flush=True)
    best_all.sort(key=lambda x: -x[1]['net'])
    results[sn] = [(list(k), s) for k, s in best_all[:40]]

json.dump({'plan': [TP, SL], 'days': DAYS, 'results': results},
          open('plancombo_out.json', 'w'), ensure_ascii=False, indent=1)

# ── 3. أفضل محفظة: أعلى تركيبة شراء + أعلى تركيبة بيع معاً ──
print('\n══ المحفظة المدمجة ══', flush=True)
bb = results['BUY'][0][0]; ss = results['SELL'][0][0]
r = score(walk_two(combo_mask(bb), combo_mask(ss)))
print('شراء : %s' % ' + '.join(bb))
print('بيع  : %s' % ' + '.join(ss))
print('  صفقات %d (%.1f/يوم) | هدف %d | وقف %d | ربح %.2f%% | تعادل %.2f%% | صافي %+d (%.1f/يوم) | %.1f دقيقة'
      % (r['trades'], r['perday'], r['hit'], r['miss'], r['wr'], BE, r['net'], r['netday'], r['mins']), flush=True)
json.dump({'plan': [TP, SL], 'buy': bb, 'sell': ss, 'portfolio': r},
          open('plancombo_port.json', 'w'), ensure_ascii=False, indent=1)
print('\nتم الحفظ: plancombo_solo.json / plancombo_out.json / plancombo_port.json')
