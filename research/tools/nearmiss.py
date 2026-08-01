"""الصفقات التي كادت تربح: ٣٠٨ خاسرة بلغت ٨٠٪+ من الهدف ثم انعكست إلى الوقف.

التشخيص (التجربة ٧٧) وجدها لكن لم يقِس علاجها. هنا نقيس ثلاثة علاجات:
  ① نقل الوقف إلى نقطة الدخول بعد بلوغ نسبة X من الهدف
  ② الخروج فوراً عند بلوغ نسبة X من الهدف (هدف مصغّر)
  ③ نقل الوقف إلى ربح صغير مضمون بعد بلوغ X

كل علاج يُقاس على نفس الصفقات بالضبط: نفس الدخولات، ونفس تسلسل الشموع، ويُعاد
حساب التبريد لأن تغيّر شمعة الخروج يغيّر ما بعدها.

    python3 nearmiss.py
"""
import numpy as np, simcore

PU = 0.1
D = simcore.load()
N = D['n']
h, l, c = D['h'], D['l'], D['c']
MO = D['mo']
MAXHOLD = simcore.MAXHOLD


def outcomes_be(D, arm_frac, be_pts):
    """arm_frac = نسبة الهدف التي تُفعّل نقل الوقف • be_pts = مكان الوقف الجديد بالنقاط
    من سعر الدخول (٠ = نقطة الدخول، موجب = ربح مضمون).
    arm_frac = None يعني بلا نقل (السلوك الأصلي)."""
    out = {}
    for side in (1, -1):
        tp = D['tgt'][side]; sl = D['stp'][side]
        sgn = 1.0 if side == 1 else -1.0
        tpp = c + sgn * tp * PU
        slp = c - sgn * sl * PU
        armp = c + sgn * tp * arm_frac * PU if arm_frac else None
        bep = c + sgn * be_pts * PU if arm_frac else None
        win = np.full(N, -1, np.int8)
        pts = np.zeros(N)
        exb = np.full(N, -1, np.int32)
        armed = np.zeros(N, bool)
        ar = np.arange(N)
        for k in range(1, MAXHOLD + 1):
            j = np.minimum(ar + k, N - 1)
            alive = win < 0
            if not alive.any(): break
            hi, lo = h[j], l[j]
            hitT = (hi >= tpp) if side == 1 else (lo <= tpp)
            hitS = (lo <= slp) if side == 1 else (hi >= slp)
            if arm_frac:
                # الوقف المنقول يُفحص قبل الوقف الأصلي لأنه أقرب إلى السعر
                hitB = armed & ((lo <= bep) if side == 1 else (hi >= bep))
                stop_now = alive & (hitS | hitB)
                use_be = alive & hitB & ~hitS
            else:
                stop_now = alive & hitS
                use_be = np.zeros(N, bool)
            both = alive & hitT & stop_now
            onlyT = alive & hitT & ~stop_now
            onlyS = stop_now & ~hitT
            win[both] = 2; exb[both] = j[both]                    # sameCandleRule = Skip
            win[onlyT] = 1; exb[onlyT] = j[onlyT]; pts[onlyT] = tp[onlyT]
            win[onlyS] = 0; exb[onlyS] = j[onlyS]
            pts[onlyS & use_be] = be_pts
            pts[onlyS & ~use_be] = -sl[onlyS & ~use_be]
            if arm_frac:
                hitA = alive & ((hi >= armp) if side == 1 else (lo <= armp))
                armed |= hitA & (win < 0)
        out[side] = (win, pts, exb)
    return out


def run(O):
    T = simcore.simulate(D, O)
    if len(T) == 0: return None
    w = int((T[:, 2] == 1).sum())
    idx = T[:, 0].astype(int)
    mos = sorted(set(MO[idx]))
    pos = sum(1 for m in mos if (MO[idx] == m).sum() >= 50 and T[MO[idx] == m][:, 3].sum() > 0)
    return dict(n=len(T), wr=100 * w / len(T), net=T[:, 3].sum(),
                per=T[:, 3].sum() / len(T), perday=len(T) / D['days'],
                pos=pos, nmo=len(mos))


print('%-38s %7s %7s %8s %10s %9s %7s' %
      ('العلاج', 'صفقات', '/يوم', 'ربح%', 'صافي', 'لكل صفقة', 'أشهر+'))
print('─' * 88)
base = run(simcore.outcomes(D))
print('%-38s %7d %7.1f %7.2f%% %+10.0f %+9.2f %5d/%d' %
      ('بلا علاج (الأصل)', base['n'], base['perday'], base['wr'], base['net'],
       base['per'], base['pos'], base['nmo']), flush=True)

for arm in (0.5, 0.6, 0.7, 0.8):
    for be in (0.0, 5.0, 10.0):
        r = run(outcomes_be(D, arm, be))
        if not r: continue
        tag = 'الوقف ← %s بعد بلوغ %d%% من الهدف' % (
            'الدخول' if be == 0 else '+%d نقطة' % be, int(arm * 100))
        print('%-38s %7d %7.1f %7.2f%% %+10.0f %+9.2f %5d/%d' %
              (tag, r['n'], r['perday'], r['wr'], r['net'], r['per'], r['pos'], r['nmo']), flush=True)
