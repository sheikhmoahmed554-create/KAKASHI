"""مكتبة طرق التداول الموسّعة — كل العائلات المعروفة كخصائص قابلة للبحث.

تُبنى فوق lab.py وتضيف عشرات المؤشرات والأنماط: المذبذبات، القنوات،
الإيشيموكو، SAR، ADX، النقاط المحورية، فيبوناتشي، أنماط الشموع،
الدايفرجنس، فجوات القيمة العادلة، كتل الأوامر، اكتساح السيولة،
نطاق الافتتاح، والأرقام المدوّرة.

    import methods; F = methods.all_features()
"""
import numpy as np
import lab

PU = lab.PU


def _roll_max(x, n): return lab.roll_max(x, n)
def _roll_min(x, n): return lab.roll_min(x, n)
def _roll_mean(x, n): return lab.roll_mean(x, n)


def all_features(D=None, F=None):
    if D is None:
        D = lab.load()
    if F is None:
        F = lab.features(D)
    o, h, l, c, v = D['o'], D['h'], D['l'], D['c'], D['v']
    N = D['n']
    atr = np.maximum(F['atr14'], 1e-9)          # بالنقاط
    rng = np.maximum(h - l, 1e-9)

    # ── مذبذبات ──
    for n in (5, 14, 21):
        hh, ll = _roll_max(h, n), _roll_min(l, n)
        F['stoch%d' % n] = (c - ll) / np.maximum(hh - ll, 1e-9) * 100
        F['willr%d' % n] = (hh - c) / np.maximum(hh - ll, 1e-9) * -100
    tp = (h + l + c) / 3.0
    for n in (14, 20):
        m = _roll_mean(tp, n)
        md = _roll_mean(np.abs(tp - m), n)
        F['cci%d' % n] = (tp - m) / np.maximum(0.015 * md, 1e-9)
    for n in (5, 20):
        F['roc%d' % n] = (c - np.roll(c, n)) / np.maximum(np.roll(c, n), 1e-9) * 10000
    mf = tp * np.maximum(v, 0)
    up = np.where(np.diff(tp, prepend=tp[0]) > 0, mf, 0.0)
    dn = np.where(np.diff(tp, prepend=tp[0]) < 0, mf, 0.0)
    F['mfi14'] = 100 - 100 / (1 + _roll_mean(up, 14) / np.maximum(_roll_mean(dn, 14), 1e-9))

    # ── قنوات ──
    kmid = lab.ema(c, 20)
    katr = lab.rma(np.maximum(h - l, 1e-9), 20)
    F['kelt_z'] = (c - kmid) / np.maximum(2 * katr, 1e-9)
    for n in (20, 55):
        dh, dl = _roll_max(h, n), _roll_min(l, n)
        F['donch%d_pos' % n] = (c - dl) / np.maximum(dh - dl, 1e-9) * 100
        F['donch%d_brk_up' % n] = (c > np.roll(dh, 1)).astype(float)
        F['donch%d_brk_dn' % n] = (c < np.roll(dl, 1)).astype(float)
    F['bb_squeeze'] = (F['bb_sd'] * 4) / np.maximum(katr * 2, 1e-9)

    # ── إيشيموكو ──
    ten = (_roll_max(h, 9) + _roll_min(l, 9)) / 2
    kij = (_roll_max(h, 26) + _roll_min(l, 26)) / 2
    F['ichi_tk'] = (ten - kij) / PU
    F['ichi_price_kij'] = (c - kij) / PU
    spa = np.roll((ten + kij) / 2, 26)
    spb = np.roll((_roll_max(h, 52) + _roll_min(l, 52)) / 2, 26)
    F['ichi_cloud_pos'] = (c - (spa + spb) / 2) / PU
    F['ichi_cloud_thick'] = np.abs(spa - spb) / PU

    # ── ADX / DMI ──
    upm = h - np.roll(h, 1)
    dnm = np.roll(l, 1) - l
    plus = np.where((upm > dnm) & (upm > 0), upm, 0.0)
    minus = np.where((dnm > upm) & (dnm > 0), dnm, 0.0)
    trr = np.maximum(h - l, np.maximum(np.abs(h - np.roll(c, 1)), np.abs(l - np.roll(c, 1))))
    atr_ = np.maximum(lab.rma(trr, 14), 1e-9)
    pdi = 100 * lab.rma(plus, 14) / atr_
    mdi = 100 * lab.rma(minus, 14) / atr_
    F['adx'] = lab.rma(100 * np.abs(pdi - mdi) / np.maximum(pdi + mdi, 1e-9), 14)
    F['di_diff'] = pdi - mdi

    # ── Parabolic SAR (مبسّط) ──
    sar = np.zeros(N); sar[0] = l[0]; bull = True; af = 0.02; ep = h[0]
    for i in range(1, N):
        sar[i] = sar[i-1] + af * (ep - sar[i-1])
        if bull:
            if l[i] < sar[i]:
                bull = False; sar[i] = ep; ep = l[i]; af = 0.02
            elif h[i] > ep:
                ep = h[i]; af = min(af + 0.02, 0.2)
        else:
            if h[i] > sar[i]:
                bull = True; sar[i] = ep; ep = h[i]; af = 0.02
            elif l[i] < ep:
                ep = l[i]; af = min(af + 0.02, 0.2)
    F['sar_dist'] = (c - sar) / PU

    # ── نقاط محورية يومية (من اليوم السابق) ──
    day = (D['t'] // 86400).astype(np.int64)
    newday = np.concatenate([[True], day[1:] != day[:-1]])
    ph = np.zeros(N); pl = np.zeros(N); pc = np.zeros(N)
    dh = dl = dc = np.nan; ch_ = cl_ = None
    for i in range(N):
        if newday[i]:
            if ch_ is not None:
                dh, dl, dc = ch_, cl_, c[i-1]
            ch_, cl_ = h[i], l[i]
        else:
            ch_ = max(ch_, h[i]); cl_ = min(cl_, l[i])
        ph[i], pl[i], pc[i] = dh, dl, dc
    piv = (ph + pl + pc) / 3
    F['piv_dist'] = np.where(np.isfinite(piv), (c - piv) / PU, 0.0)
    F['piv_r1_dist'] = np.where(np.isfinite(piv), (c - (2 * piv - pl)) / PU, 0.0)
    F['piv_s1_dist'] = np.where(np.isfinite(piv), (c - (2 * piv - ph)) / PU, 0.0)

    # ── فيبوناتشي من مدى 120 شمعة ──
    fh, fl = _roll_max(h, 120), _roll_min(l, 120)
    span = np.maximum(fh - fl, 1e-9)
    F['fib_pos'] = (c - fl) / span * 100
    for lvl, nm in ((0.382, '382'), (0.5, '500'), (0.618, '618')):
        F['fib_%s_dist' % nm] = (c - (fl + span * lvl)) / PU

    # ── أنماط الشموع ──
    body = np.abs(c - o)
    prev_body = np.roll(body, 1)
    F['engulf_up'] = ((c > o) & (np.roll(c, 1) < np.roll(o, 1)) &
                      (c >= np.roll(o, 1)) & (o <= np.roll(c, 1))).astype(float)
    F['engulf_dn'] = ((c < o) & (np.roll(c, 1) > np.roll(o, 1)) &
                      (c <= np.roll(o, 1)) & (o >= np.roll(c, 1))).astype(float)
    F['hammer'] = ((F['dnwick'] > 0.55) & (F['body'] < 0.35) & (F['upwick'] < 0.2)).astype(float)
    F['shooting_star'] = ((F['upwick'] > 0.55) & (F['body'] < 0.35) & (F['dnwick'] < 0.2)).astype(float)
    F['harami'] = ((body < prev_body * 0.5) &
                   (np.maximum(c, o) < np.maximum(np.roll(c, 1), np.roll(o, 1))) &
                   (np.minimum(c, o) > np.minimum(np.roll(c, 1), np.roll(o, 1)))).astype(float)
    F['inside_bar'] = ((h < np.roll(h, 1)) & (l > np.roll(l, 1))).astype(float)
    F['outside_bar'] = ((h > np.roll(h, 1)) & (l < np.roll(l, 1))).astype(float)

    # ── فجوات القيمة العادلة (FVG / ICT) ──
    F['fvg_up'] = (np.roll(l, -1) > np.roll(h, 1)).astype(float)      # تُقرأ بعد شمعتين
    F['fvg_up'] = np.roll(F['fvg_up'], 1)
    F['fvg_dn'] = (np.roll(h, -1) < np.roll(l, 1)).astype(float)
    F['fvg_dn'] = np.roll(F['fvg_dn'], 1)

    # ── اكتساح السيولة: كسر قمة/قاع 20 ثم الرجوع داخلها ──
    hh20, ll20 = np.roll(_roll_max(h, 20), 1), np.roll(_roll_min(l, 20), 1)
    F['sweep_high'] = ((h > hh20) & (c < hh20)).astype(float)
    F['sweep_low'] = ((l < ll20) & (c > ll20)).astype(float)

    # ── دايفرجنس RSI مقابل السعر على 30 شمعة ──
    r = F['rsi14']
    pm = _roll_max(c, 30); rm = _roll_max(r, 30)
    pn = _roll_min(c, 30); rn = _roll_min(r, 30)
    F['div_bear'] = ((c >= pm - 1e-9) & (r < rm - 3)).astype(float)
    F['div_bull'] = ((c <= pn + 1e-9) & (r > rn + 3)).astype(float)

    # ── نطاق الافتتاح: أول 60 دقيقة من كل يوم ──
    orh = np.zeros(N); orl = np.zeros(N); into = np.zeros(N)
    ch_ = cl_ = None; cnt = 0
    for i in range(N):
        if newday[i]:
            ch_, cl_ = h[i], l[i]; cnt = 0
        else:
            cnt += 1
            if cnt < 60:
                ch_ = max(ch_, h[i]); cl_ = min(cl_, l[i])
        orh[i], orl[i], into[i] = ch_, cl_, cnt
    F['or_pos'] = np.where(orh > orl, (c - orl) / np.maximum(orh - orl, 1e-9) * 100, 50.0)
    F['or_brk_up'] = ((c > orh) & (into >= 60)).astype(float)
    F['or_brk_dn'] = ((c < orl) & (into >= 60)).astype(float)

    # ── تطبيع بالـ ATR لكل خاصية سعرية (تجعلها قابلة للمقارنة عبر الأنظمة) ──
    for k in ['sar_dist', 'piv_dist', 'ichi_price_kij', 'fib_500_dist',
              'fib_618_dist', 'fib_382_dist', 'piv_r1_dist', 'piv_s1_dist']:
        F[k + '_atr'] = F[k] / atr

    for k in F:
        F[k] = np.nan_to_num(F[k], nan=0.0, posinf=0.0, neginf=0.0)
    return D, F


if __name__ == '__main__':
    import time
    t0 = time.time()
    D, F = all_features()
    print('خصائص: %d  |  شموع: %d  |  %.0f ثانية' % (len(F), D['n'], time.time() - t0))
    print('العائلات الجديدة:')
    print('  ', ', '.join(sorted(k for k in F if any(
        k.startswith(p) for p in ('stoch', 'willr', 'cci', 'roc', 'mfi', 'kelt', 'donch',
                                  'ichi', 'adx', 'di_', 'sar', 'piv', 'fib', 'engulf',
                                  'hammer', 'shooting', 'harami', 'inside', 'outside',
                                  'fvg', 'sweep', 'div_', 'or_', 'bb_squeeze')))))
