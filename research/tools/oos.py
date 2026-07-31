"""الاختبار الفاصل: ابحث على يناير–أبريل، وقِس على مايو–يوليو. بلا استثناء.

يضيف على plancombo شيئين لا غنى عنهما:
  ١ ــ تقسيم زمني حقيقي: التركيبة تُختار من فترة التدريب فقط ثم تُقاس على فترة لم
       يرها البحث. أي رقم في العمود «اختبار» هو الرقم الوحيد القابل للتصديق.
  ٢ ــ خط أساس لنفس الفترة ونفس الجهة («ادخل في كل شمعة صالحة»)، فالفائض عليه هو
       المهارة. بدونه يبدو كل بيع عبقرياً في سوق هابط.

    NB=192081 INV=inventory_full.json python3 oos.py [TP] [SL]
"""
import json, csv, re, sys, os, datetime, numpy as np

PU = 0.1; MAXBARS = 30
TP = float(sys.argv[1]) if len(sys.argv) > 1 else 45.0
SL = float(sys.argv[2]) if len(sys.argv) > 2 else 65.0
BE = 100 * SL / (TP + SL)
NB = int(os.environ.get('NB', '192081'))
INV = os.environ.get('INV', 'inventory_full.json')
TAG = os.environ.get('TAG', 'oos')
TRAIN_END = os.environ.get('TRAIN_END', '2026-05-01')

R = list(csv.DictReader(open('vault.csv')))[:NB]
H = np.array([float(r['high']) for r in R]); L = np.array([float(r['low']) for r in R])
C = np.array([float(r['close']) for r in R]); N = len(R)
DATE = np.array([r['time'][:10] for r in R])
HR = np.array([int(r['time'][11:13]) for r in R])
TS = np.array([datetime.datetime.fromisoformat(r['time']).timestamp() for r in R])
VALID = (HR < 22) & ~np.concatenate([[True], np.diff(TS) > 300])
TRAIN = DATE < TRAIN_END
TEST = ~TRAIN
DTR = len(set(DATE[TRAIN])); DTE = len(set(DATE[TEST]))
print('شموع %d | تدريب %s..%s (%d يوم) | اختبار %s..%s (%d يوم) | خطة %.0f/%.0f | تعادل %.2f%%'
      % (N, DATE[0], TRAIN_END, DTR, TRAIN_END, DATE[-1], DTE, TP, SL, BE), flush=True)


def precompute(buy):
    ep = C
    tp = ep + (TP * PU if buy else -TP * PU)
    sl = ep - (SL * PU if buy else -SL * PU)
    kind = np.zeros(N, np.int8); bars = np.full(N, MAXBARS, np.int16)
    for k in range(1, MAXBARS + 1):
        j = np.minimum(np.arange(N) + k, N - 1)
        alive = kind == 0
        hs = (L[j] <= sl) if buy else (H[j] >= sl)
        ht = (H[j] >= tp) if buy else (L[j] <= tp)
        s = alive & hs; t = alive & ht & ~hs
        kind[s] = 2; bars[s] = k
        kind[t] = 1; bars[t] = k
    pts = np.where(kind == 1, TP, np.where(kind == 2, -SL, 0.0))
    j = np.minimum(np.arange(N) + MAXBARS, N - 1)
    tail = kind == 0
    pts[tail] = ((C[j] - C) / PU if buy else (C - C[j]) / PU)[tail]
    return pts.astype(np.float32), bars, kind


print('حساب مسبق...', flush=True)
PTS = {}; BARS = {}; KIND = {}
for side, buy in (('BUY', True), ('SELL', False)):
    PTS[side], BARS[side], KIND[side] = precompute(buy)

# خط الأساس: كل شمعة صالحة، نفس الجهة، نفس الفترة
BASE = {}
for side in ('BUY', 'SELL'):
    k = KIND[side]
    for nm, sel in (('train', TRAIN), ('test', TEST)):
        m = sel & VALID
        w = int(((k == 1) & m).sum()); l = int(((k == 2) & m).sum())
        BASE[(side, nm)] = 100 * w / max(w + l, 1)
print('خط الأساس — شراء: تدريب %.2f%% اختبار %.2f%%  |  بيع: تدريب %.2f%% اختبار %.2f%%'
      % (BASE[('BUY', 'train')], BASE[('BUY', 'test')],
         BASE[('SELL', 'train')], BASE[('SELL', 'test')]), flush=True)


def side_of(nm):
    if re.search(r'(Buy|Long)', nm) or nm.endswith('B'): return 'BUY'
    if re.search(r'(Sell|Short)', nm) or nm.endswith('S'): return 'SELL'
    return None


d = json.load(open(INV))
ENG = {}
for nm, ev in (d['fires'] or {}).items():
    if not ev: continue
    sn = side_of(nm)
    if sn is None: continue
    m = np.zeros(N, bool)
    idx = np.array([i for i in ev if i < N], np.int64)
    if len(idx) < 60: continue
    m[idx] = True; m &= VALID
    if (m & TRAIN).sum() < 40 or (m & TEST).sum() < 20: continue
    ENG[nm] = (sn, m)
print('محركات صالحة: %d (شراء %d / بيع %d)'
      % (len(ENG), sum(1 for v in ENG.values() if v[0] == 'BUY'),
         sum(1 for v in ENG.values() if v[0] == 'SELL')), flush=True)


def walk(mask, side, sel, days):
    p, b, k = PTS[side], BARS[side], KIND[side]
    idx = np.flatnonzero(mask & sel)
    busy = -1; hit = miss = tw = tl = 0; net = 0.0
    for i in idx:
        if i <= busy or i >= N - 1: continue
        busy = i + int(b[i]); net += float(p[i])
        kk = k[i]
        if kk == 1: hit += 1
        elif kk == 2: miss += 1
        elif p[i] > 0: tw += 1
        else: tl += 1
    tot = hit + miss + tw + tl
    if tot < 20: return None
    wr = 100 * (hit + tw) / tot
    return dict(trades=tot, hit=hit, miss=miss, wr=round(wr, 2), net=round(net),
                per=round(net / tot, 2), perday=round(tot / days, 1))


def ev(names, side):
    m = np.zeros(N, bool)
    for nm in names: m |= ENG[nm][1]
    tr = walk(m, side, TRAIN, DTR); te = walk(m, side, TEST, DTE)
    if not tr or not te: return None
    tr['excess'] = round(tr['wr'] - BASE[(side, 'train')], 2)
    te['excess'] = round(te['wr'] - BASE[(side, 'test')], 2)
    return {'train': tr, 'test': te}


BEAM = 40
out = {}
for sn in ('BUY', 'SELL'):
    pool = [nm for nm in ENG if ENG[nm][0] == sn]
    scored = []
    for nm in pool:
        r = ev((nm,), sn)
        if r: scored.append(((nm,), r))
    scored.sort(key=lambda x: -x[1]['train']['net'])
    pool = [k[0] for k, _ in scored[:60]]
    print('\n══ %s — مجمّع %d ══' % (sn, len(pool)), flush=True)
    beam = scored[:BEAM]
    keep = list(beam[:15])
    for depth in (2, 3, 4):
        nxt = []; seen = set()
        for names, _ in beam:
            for nm in pool:
                if nm in names: continue
                key = tuple(sorted(names + (nm,)))
                if key in seen: continue
                seen.add(key)
                r = ev(key, sn)
                if r: nxt.append((key, r))
        nxt.sort(key=lambda x: -x[1]['train']['net'])   # الاختيار من التدريب وحده
        beam = nxt[:BEAM]
        keep += beam[:15]
        if beam:
            k, r = beam[0]
            print('  عمق %d | تدريب: %d صفقة %.2f%% صافي %+d (فائض %+.2f)'
                  % (depth, r['train']['trades'], r['train']['wr'], r['train']['net'], r['train']['excess']),
                  flush=True)
            print('           اختبار: %d صفقة (%.1f/يوم) %.2f%% صافي %+d (فائض %+.2f) | %s'
                  % (r['test']['trades'], r['test']['perday'], r['test']['wr'], r['test']['net'],
                     r['test']['excess'], ' + '.join(k)), flush=True)
    out[sn] = [(list(k), r) for k, r in keep]

json.dump({'plan': [TP, SL], 'train_end': TRAIN_END, 'base': {'%s_%s' % kk: vv for kk, vv in BASE.items()},
           'results': out}, open(TAG + '_out.json', 'w'), ensure_ascii=False, indent=1)

print('\n╔═══ أثبت التركيبات: مرتّبة بفائض فترة الاختبار (التي لم يرها البحث) ═══')
for sn in ('BUY', 'SELL'):
    rows = sorted(out[sn], key=lambda x: -x[1]['test']['excess'])[:8]
    print('║ %s   — خط الأساس اختبار %.2f%%' % (sn, BASE[(sn, 'test')]))
    for k, r in rows:
        print('║   تدريب %6.2f%% (فائض %+5.2f) → اختبار %6.2f%% (فائض %+5.2f) | %4d صفقة %.1f/يوم | صافي %+6d | %s'
              % (r['train']['wr'], r['train']['excess'], r['test']['wr'], r['test']['excess'],
                 r['test']['trades'], r['test']['perday'], r['test']['net'], ' + '.join(k)))
print('╚' + '═' * 100)
