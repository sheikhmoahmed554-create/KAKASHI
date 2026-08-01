"""تدقيق المرشّحين: الثبات الشهري، ونسبة الصفقات غير المحسومة، والمحاكاة التسلسلية.

المسح يفترض أخذ كل إشارة على حدة. الواقع أن البوت يفتح صفقة واحدة في المرة،
فالحكم النهائي هو المحاكاة التسلسلية لا المسح.

    python3 research/tools/tpsl_verify.py
"""
import numpy as np

PU = 0.1
NEVER = np.int32(1 << 30)
Z = np.load('research/results/tpsl_paths_2026.npz', allow_pickle=True)
idx, side = Z['idx'], Z['side']
own_tp, own_sl, own_win, months = Z['own_tp'], Z['own_sl'], Z['own_win'], Z['months']
mfe, mae = Z['mfe'], Z['mae']

CANDS = [
    (46, 119, 'أعلى فوز مع ربح ≥ ربح المؤشر الحالي'),
    (29, 116, 'أعلى فوز مع ربح ≥ ٤٠٠٠'),
    (23, 119, 'أعلى فوز مع بقاء الصافي موجباً'),
    (60,  84, 'أعلى صافي مطلقاً'),
    (60,  54, 'أعلى صافي ضمن قيود المشروع'),
    (31,  51, 'أعلى فوز ضمن قيود المشروع'),
    (30,  50, 'خطة المؤشر الأكثر استخداماً'),
]


def evaluate(tp, sl):
    t_tp = np.where(mfe[:, -1] >= tp, (mfe >= tp).argmax(1).astype(np.int32), NEVER)
    t_sl = np.where(mae[:, -1] >= sl, (mae >= sl).argmax(1).astype(np.int32), NEVER)
    out = np.full(len(mfe), -1, np.int8)
    out[t_tp < t_sl] = 1
    out[(t_sl <= t_tp) & (t_sl < NEVER)] = 0
    return out, np.minimum(t_tp, t_sl)


def sequential(tp, sl):
    """صفقة واحدة في المرة: تُتجاهل أي إشارة تصل قبل إغلاق الصفقة القائمة."""
    out, bars = evaluate(tp, sl)
    order = np.argsort(idx)
    busy_until = -1
    w = ls = 0; net = 0.0; taken = 0
    for k in order:
        if idx[k] <= busy_until or out[k] < 0:
            continue
        taken += 1
        if out[k] == 1:
            w += 1; net += tp
        else:
            ls += 1; net -= sl
        busy_until = idx[k] + int(bars[k])
    n = w + ls
    return {'trades': taken, 'wins': w, 'losses': ls,
            'win_rate': 100.0 * w / n if n else 0, 'net': net,
            'per_trade': net / n if n else 0}


mons = sorted(set(months.tolist()))
ndays = 138.0     # أيام تداول تقريبية في الفترة

# ── خط الأساس ────────────────────────────────────────────────────────────────
base_net = float(sum(own_tp[i] if own_win[i] else -own_sl[i] for i in range(len(own_win))))
print("╔════ خط الأساس — المؤشر بنظام R16 التكيّفي كما هو ════╗")
print(f"  {len(own_win):,} صفقة • فوز {100*own_win.mean():.2f}% • "
      f"صافي {base_net:+,.0f} • {base_net/len(own_win):+.3f} نقطة/صفقة")

print("\n╔════ المرشّحون — كل الإشارات مأخوذة (موازية) ════╗")
print(f"{'خطة':>11}{'صفقات':>8}{'فوز%':>8}{'حافة':>7}{'صافي':>9}{'/صفقة':>8}"
      f"{'غير محسوم':>11}{'شمعة':>7}   الوصف")
rows = {}
for tp, sl, desc in CANDS:
    out, bars = evaluate(tp, sl)
    d = out >= 0
    w = int((out == 1).sum()); ls = int((out == 0).sum()); n = w + ls
    wr = 100.0 * w / n; be = 100.0 * sl / (tp + sl)
    net = w * tp - ls * sl
    unres = int((~d).sum())
    rows[(tp, sl)] = (out, bars)
    print(f"{'TP'+str(tp)+'/SL'+str(sl):>11}{n:>8}{wr:>8.2f}{wr-be:>+7.2f}{net:>9}"
          f"{net/n:>8.3f}{unres:>11}{bars[d].mean():>7.0f}   {desc}")

print("\n╔════ الثبات الشهري — نسبة الفوز ════╗")
print(f"{'خطة':>11}" + "".join(f"{m[-2:]:>7}" for m in mons) + f"{'أدنى':>8}{'مدى':>7}")
for tp, sl, _ in CANDS:
    out, _ = rows[(tp, sl)]
    v = []
    for m in mons:
        s = (months == m) & (out >= 0)
        v.append(100.0 * out[s].mean() if s.sum() else float('nan'))
    print(f"{'TP'+str(tp)+'/SL'+str(sl):>11}" + "".join(f"{x:>7.1f}" for x in v)
          + f"{min(v):>8.1f}{max(v)-min(v):>7.1f}")

print("\n╔════ الثبات الشهري — الصافي بالنقاط ════╗")
print(f"{'خطة':>11}" + "".join(f"{m[-2:]:>8}" for m in mons) + f"{'أسوأ شهر':>10}")
for tp, sl, _ in CANDS:
    out, _ = rows[(tp, sl)]
    v = []
    for m in mons:
        s = (months == m) & (out >= 0)
        v.append(int((out[s] == 1).sum() * tp - (out[s] == 0).sum() * sl))
    print(f"{'TP'+str(tp)+'/SL'+str(sl):>11}" + "".join(f"{x:>8}" for x in v) + f"{min(v):>10}")

print("\n╔════ المحاكاة التسلسلية — صفقة واحدة في المرة (الحكم الواقعي) ════╗")
print(f"{'خطة':>11}{'صفقات':>8}{'/يوم':>7}{'فوز%':>8}{'صافي':>9}{'/صفقة':>8}   الوصف")
for tp, sl, desc in CANDS:
    r = sequential(tp, sl)
    print(f"{'TP'+str(tp)+'/SL'+str(sl):>11}{r['trades']:>8}{r['trades']/ndays:>7.1f}"
          f"{r['win_rate']:>8.2f}{r['net']:>9.0f}{r['per_trade']:>8.3f}   {desc}")

# خط الأساس تسلسلياً بخطة المؤشر المتغيّرة
order = np.argsort(idx); busy = -1; w = ls = 0; net = 0.0
for k in order:
    if idx[k] <= busy:
        continue
    tp_, sl_ = own_tp[k], own_sl[k]
    out, bars = evaluate(int(tp_), int(sl_))
    if out[k] < 0:
        continue
    if out[k] == 1:
        w += 1; net += tp_
    else:
        ls += 1; net -= sl_
    busy = idx[k] + int(bars[k])
n = w + ls
print(f"{'R16 التكيّفي':>11}{n:>8}{n/ndays:>7.1f}{100*w/n:>8.2f}{net:>9.0f}"
      f"{net/n:>8.3f}   خط الأساس تسلسلياً")
