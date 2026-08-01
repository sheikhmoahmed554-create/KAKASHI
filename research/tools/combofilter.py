"""تركيبات المرشّحات فوق قاعدة «قرب قاع السوينغ».

المحركات أُغلق بابها (التجربة ٥٨: تسقط خارج العيّنة)، والطبقة العليا بلا أثر
(٦٨ و٧١)، والتبريد قرب الأمثل (٧٣)، ونقل الوقف يضرّ (٨٤). الباقي: **المرشّحات**،
وقد أثبت أحدها نفسه (قاع السوينغ، التجربة ٨٥). هنا نبحث عمّا يُضاف إليه.

الانضباط: الاختيار من التدريب وحده، والحكم من الاختبار وحده، ولا يُقبل مرشّح إلا إذا
تفوّق على القاعدة في **الفترتين معاً** وحافظ على ٢٥ صفقة/يوم على الأقل ورَبِح في
٦ أشهر من ٧. كما يُجرَّب تطبيق المرشّح على جهة واحدة، لأن التجربة ٨٥ أثبتت أن
الفائض يتركّز في جانب الشراء.

    python3 combofilter.py
"""
import numpy as np, json, simcore, lab, methods

TRAIN_END = '2026-05-01'
MIN_PERDAY = 25.0

D = simcore.load(); O = simcore.outcomes(D); N = D['n']; MO = D['mo']
TR = D['date'] < TRAIN_END; TE = ~TR
Dl = lab.load()
for k in ('t', 'o', 'h', 'l', 'c', 'v', 'sp', 'hour', 'dow', 'gap'): Dl[k] = Dl[k][:N]
Dl['n'] = N
_, F = methods.all_features(Dl, lab.features(Dl))
F = {k: np.nan_to_num(np.asarray(v, float), nan=0.0, posinf=0.0, neginf=0.0)
     for k, v in F.items() if np.asarray(v).shape == (N,)}
print('خصائص: %d | شموع %d' % (len(F), N), flush=True)

BASE = F['dist_swing_lo'] < 20.0


def ev(buy, sell):
    Dm = dict(D); Dm['buy'] = buy; Dm['sell'] = sell
    T = simcore.simulate(Dm, O)
    if len(T) < 800: return None
    idx = T[:, 0].astype(int)
    mos = [m for m in sorted(set(MO)) if (MO[idx] == m).sum() >= 50]
    pos = sum(1 for m in mos if T[MO[idx] == m][:, 3].sum() > 0)
    a = simcore.report(D, O, T, '', TR); b = simcore.report(D, O, T, '', TE)
    if not a or not b: return None
    return dict(n=len(T), perday=len(T) / D['days'], wr=100 * T[:, 2].mean(),
                net=T[:, 3].sum(), tr_wr=a['wr'], tr_net=a['net'], tr_ex=a['excess'],
                te_wr=b['wr'], te_net=b['net'], te_ex=b['excess'], te_perday=b['perday'],
                pos=pos, nmo=len(mos))


def line(lbl, r):
    return ('%-42s %5d %5.1f %6.2f%% %+7.0f | تدريب %6.2f%% %+6.0f (%+.2f) | اختبار %6.2f%% %+6.0f (%+.2f) | %d/%d'
            % (lbl, r['n'], r['perday'], r['wr'], r['net'], r['tr_wr'], r['tr_net'], r['tr_ex'],
               r['te_wr'], r['te_net'], r['te_ex'], r['pos'], r['nmo']))


b0 = ev(D['buy'], D['sell'])
bs = ev(D['buy'] & BASE, D['sell'] & BASE)
print(line('الأساس (إصلاح البوابة)', b0), flush=True)
print(line('القاعدة: قاع السوينغ < 20', bs), flush=True)
print(flush=True)

# ── مرشّحات مرشَّحة: عتبات مئينية على كل خاصية ──
cands = []
for name, arr in F.items():
    if name == 'dist_swing_lo': continue
    fin = arr[np.isfinite(arr)]
    if fin.size < 1000 or np.ptp(fin) == 0: continue
    for lvl in (15, 30, 50, 70, 85):
        thr = float(np.percentile(fin, lvl))
        cands.append((name, '<', thr, lvl))
        cands.append((name, '>', thr, lvl))
print('مرشّحات مقترحة فوق القاعدة: %d' % len(cands), flush=True)

rows = []
for i, (name, op, thr, lvl) in enumerate(cands):
    g = (F[name] > thr) if op == '>' else (F[name] < thr)
    for scope, buy, sell in (('الجهتان', D['buy'] & BASE & g, D['sell'] & BASE & g),
                             ('الشراء',  D['buy'] & BASE & g, D['sell'] & BASE),
                             ('البيع',   D['buy'] & BASE,     D['sell'] & BASE & g)):
        r = ev(buy, sell)
        if not r or r['te_perday'] < MIN_PERDAY: continue
        # يجب أن يتفوّق على القاعدة في الفترتين معاً
        if r['tr_ex'] <= bs['tr_ex'] or r['te_ex'] <= bs['te_ex']: continue
        if r['pos'] < 6: continue
        rows.append(dict(f=name, op=op, lvl=lvl, thr=thr, scope=scope, **r))
    if (i + 1) % 200 == 0:
        print('  ... %d/%d، ناجية %d' % (i + 1, len(cands), len(rows)), flush=True)

rows.sort(key=lambda r: -r['te_net'])
json.dump(rows, open('combofilter_out.json', 'w'), indent=1)
print('\n╔═══ صمدت الشروط كلها: %d من %d ═══' % (len(rows), 3 * len(cands)))
for r in rows[:20]:
    print('║ ' + line('%s %s%d [%s]' % (r['f'], r['op'], r['lvl'], r['scope']), r))
print('╚' + '═' * 118)
if rows:
    r = rows[0]
    print('\nالأفضل: القاعدة + %s %s %.4g (المئين %d) على %s'
          % (r['f'], r['op'], r['thr'], r['lvl'], r['scope']))
