"""معايرة الصدفة: كم مرشّحاً «ينجح» لو لم يكن هناك أثر حقيقي أصلاً؟

`combofilter.py` أعطى ١٨٤ ناجياً من ٣٢٧٠ = ٥.٦٪. السؤال الوحيد المهم: هل ٥.٦٪
أعلى من نسبة النجاح بالصدفة تحت نفس الشروط؟ إن لم تكن، فكل الناجين ضجيج.

الاختبار: نأخذ نفس الخصائص ونزيحها دائرياً بمقدار عشوائي كبير. الإزاحة الدائرية
تحفظ البنية الزمنية للخاصية (تقلّبها، ترابطها الذاتي، توزيعها) وتكسر فقط ارتباطها
بنتائج الصفقات — فأي «نجاح» بعدها صدفة محضة بالتعريف.

    python3 nullcal.py [عدد المحاولات]
"""
import numpy as np, sys, json, simcore, lab, methods

TRIALS = int(sys.argv[1]) if len(sys.argv) > 1 else 400
TRAIN_END = '2026-05-01'
MIN_PERDAY = 25.0
rng = np.random.default_rng(20260801)

D = simcore.load(); O = simcore.outcomes(D); N = D['n']; MO = D['mo']
TR = D['date'] < TRAIN_END; TE = ~TR
Dl = lab.load()
for k in ('t', 'o', 'h', 'l', 'c', 'v', 'sp', 'hour', 'dow', 'gap'): Dl[k] = Dl[k][:N]
Dl['n'] = N
_, F = methods.all_features(Dl, lab.features(Dl))
F = {k: np.nan_to_num(np.asarray(v, float), nan=0.0, posinf=0.0, neginf=0.0)
     for k, v in F.items() if np.asarray(v).shape == (N,)}
BASE = F['dist_swing_lo'] < 20.0
names = [k for k in F if k != 'dist_swing_lo']


def ev(buy, sell):
    Dm = dict(D); Dm['buy'] = buy; Dm['sell'] = sell
    T = simcore.simulate(Dm, O)
    if len(T) < 800: return None
    idx = T[:, 0].astype(int)
    mos = [m for m in sorted(set(MO)) if (MO[idx] == m).sum() >= 50]
    pos = sum(1 for m in mos if T[MO[idx] == m][:, 3].sum() > 0)
    a = simcore.report(D, O, T, '', TR); b = simcore.report(D, O, T, '', TE)
    if not a or not b: return None
    return dict(tr_ex=a['excess'], te_ex=b['excess'], te_net=b['net'],
                te_perday=b['perday'], pos=pos, nmo=len(mos), net=T[:, 3].sum())


bs = ev(D['buy'] & BASE, D['sell'] & BASE)
print('القاعدة: فائض تدريب %+.2f | فائض اختبار %+.2f | صافي %+.0f | أشهر %d/%d'
      % (bs['tr_ex'], bs['te_ex'], bs['net'], bs['pos'], bs['nmo']), flush=True)
print('الشروط: يتفوّق على القاعدة في الفترتين + ٢٥ صفقة/يوم + ٦ أشهر رابحة من ٧\n', flush=True)


def passes(r):
    if not r or r['te_perday'] < MIN_PERDAY: return False
    return r['tr_ex'] > bs['tr_ex'] and r['te_ex'] > bs['te_ex'] and r['pos'] >= 6


ok = 0; tried = 0; nets = []
for t in range(TRIALS):
    nm = names[rng.integers(len(names))]
    arr = np.roll(F[nm], int(rng.integers(20000, N - 20000)))     # إزاحة دائرية
    lvl = int(rng.choice([15, 30, 50, 70, 85]))
    thr = float(np.percentile(arr[np.isfinite(arr)], lvl))
    g = (arr > thr) if rng.random() < 0.5 else (arr < thr)
    scope = int(rng.integers(3))
    buy = D['buy'] & BASE & (g if scope != 2 else True)
    sell = D['sell'] & BASE & (g if scope != 1 else True)
    r = ev(buy, sell)
    if r is None: continue
    tried += 1
    if passes(r):
        ok += 1
        nets.append(r['te_net'])
    if (t + 1) % 100 == 0:
        print('  ... %d محاولة | صالحة %d | ناجحة بالصدفة %d (%.1f%%)'
              % (t + 1, tried, ok, 100 * ok / max(tried, 1)), flush=True)

rate = 100 * ok / max(tried, 1)
print('\n╔═══ نتيجة المعايرة ═══')
print('║ محاولات صالحة : %d' % tried)
print('║ نجحت بالصدفة  : %d  ←  **%.1f%%**' % (ok, rate))
print('║ البحث الحقيقي : ١٨٤ من ٣٢٧٠  ←  **٥.٦٪**')
if nets:
    print('║ أفضل صافي اختبار بالصدفة: %+.0f (القاعدة %+.0f)' % (max(nets), bs['te_net']))
print('╚' + '═' * 60)
if rate >= 4.0:
    print('\nالحكم: نسبة نجاح البحث الحقيقي **لا تفوق الصدفة**. الناجون الـ١٨٤ ضجيج،')
    print('ولا يجوز شحن أيٍّ منهم. القاعدة وحدها هي ما يصمد.')
else:
    print('\nالحكم: البحث الحقيقي يتفوّق على الصدفة بفارق %.1f نقطة مئوية.' % (5.6 - rate))
json.dump({'trials': tried, 'chance_hits': ok, 'chance_rate': rate,
           'real_rate': 5.6, 'base': bs}, open('nullcal_out.json', 'w'), indent=1)
