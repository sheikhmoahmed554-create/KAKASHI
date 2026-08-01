"""نفس المعايرة لكن على القاعدة نفسها: هل «قاع السوينغ» يفوق الصدفة؟

المعايرة السابقة أسقطت المرشّح الثاني. الأمانة تقتضي توجيه السلاح نفسه إلى
القاعدة: هي أيضاً انتُقيت من ٢٠١٦ مرشّحاً، فكم مرشّحاً عشوائياً يبلغ ما بلغته؟

المعيار = ما بلغته القاعدة فعلاً على فترة الاختبار وحدها:
  صافي اختبار ≥ +٦١١١  •  ٣٠ صفقة/يوم على الأقل  •  رابح في ٧ أشهر من ٧

    python3 nullbase.py [عدد المحاولات]
"""
import numpy as np, sys, json, simcore, lab, methods

TRIALS = int(sys.argv[1]) if len(sys.argv) > 1 else 400
TRAIN_END = '2026-05-01'
rng = np.random.default_rng(7311940)

D = simcore.load(); O = simcore.outcomes(D); N = D['n']; MO = D['mo']
TR = D['date'] < TRAIN_END; TE = ~TR
Dl = lab.load()
for k in ('t', 'o', 'h', 'l', 'c', 'v', 'sp', 'hour', 'dow', 'gap'): Dl[k] = Dl[k][:N]
Dl['n'] = N
_, F = methods.all_features(Dl, lab.features(Dl))
F = {k: np.nan_to_num(np.asarray(v, float), nan=0.0, posinf=0.0, neginf=0.0)
     for k, v in F.items() if np.asarray(v).shape == (N,)}
names = list(F)


def ev(gate):
    Dm = dict(D)
    Dm['buy'] = D['buy'] & gate; Dm['sell'] = D['sell'] & gate
    T = simcore.simulate(Dm, O)
    if len(T) < 800: return None
    idx = T[:, 0].astype(int)
    mos = [m for m in sorted(set(MO)) if (MO[idx] == m).sum() >= 50]
    pos = sum(1 for m in mos if T[MO[idx] == m][:, 3].sum() > 0)
    b = simcore.report(D, O, T, '', TE)
    if not b: return None
    return dict(n=len(T), perday=len(T) / D['days'], wr=100 * T[:, 2].mean(),
                net=T[:, 3].sum(), te_net=b['net'], te_ex=b['excess'],
                pos=pos, nmo=len(mos))


base = ev(np.ones(N, bool))
real = ev(F['dist_swing_lo'] < 20.0)
print('بلا مرشّح       : %d صفقة (%.1f/يوم) | %.2f%% | صافي %+.0f | اختبار %+.0f | أشهر %d/%d'
      % (base['n'], base['perday'], base['wr'], base['net'], base['te_net'], base['pos'], base['nmo']))
print('قاع السوينغ < 20: %d صفقة (%.1f/يوم) | %.2f%% | صافي %+.0f | اختبار %+.0f | أشهر %d/%d'
      % (real['n'], real['perday'], real['wr'], real['net'], real['te_net'], real['pos'], real['nmo']))
print('\nالمعيار: صافي اختبار ≥ %+.0f + %.0f صفقة/يوم + %d أشهر رابحة من %d\n'
      % (real['te_net'], 30, real['pos'], real['nmo']), flush=True)

ok = 0; tried = 0; best = None
for t in range(TRIALS):
    nm = names[rng.integers(len(names))]
    arr = np.roll(F[nm], int(rng.integers(20000, N - 20000)))
    lvl = int(rng.choice([10, 15, 20, 30, 40, 50, 60, 70, 85, 90]))
    thr = float(np.percentile(arr[np.isfinite(arr)], lvl))
    g = (arr > thr) if rng.random() < 0.5 else (arr < thr)
    r = ev(g)
    if r is None: continue
    tried += 1
    hit = (r['te_net'] >= real['te_net'] and r['perday'] >= 30.0 and r['pos'] >= real['pos'])
    if hit:
        ok += 1
        if best is None or r['te_net'] > best['te_net']: best = r
    if (t + 1) % 100 == 0:
        print('  ... %d محاولة | صالحة %d | بلغت المستوى صدفةً %d (%.1f%%)'
              % (t + 1, tried, ok, 100 * ok / max(tried, 1)), flush=True)

rate = 100 * ok / max(tried, 1)
print('\n╔═══ نتيجة معايرة القاعدة ═══')
print('║ محاولات صالحة        : %d' % tried)
print('║ بلغت مستوى القاعدة   : %d  ←  **%.2f%%**' % (ok, rate))
print('║ عدد مرشّحات البحث     : ٢٠١٦')
print('║ المتوقّع بالصدفة       : %.0f مرشّحاً' % (2016 * rate / 100))
if best:
    print('║ أفضل ما بلغته الصدفة : صافي اختبار %+.0f | %.2f%% | %.1f/يوم' % (best['te_net'], best['wr'], best['perday']))
print('╚' + '═' * 62)
json.dump({'trials': tried, 'hits': ok, 'rate': rate,
           'real': real, 'nofilter': base}, open('nullbase_out.json', 'w'), indent=1)
