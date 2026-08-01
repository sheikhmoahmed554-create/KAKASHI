"""محاكي RMI — يعيد إنتاج المؤشر بالضبط، ثم يمسح خطط الخروج بلا إعادة تشغيل المحرك.

تيار الإشارات الخام (rawBuyEntry / rawSellEntry) لا يعتمد على حالة الصفقة في هذا
المؤشر، فهو ثابت مهما تغيّر الهدف والوقف. لذلك يكفي استخراجه مرة، ثم تُحاكى أي خطة
خروج فوقه — بما في ذلك أثر إشغال الصفقة الواحدة على الإشارات التالية.

ترتيب العمليات داخل الشمعة منسوخ من Pine حرفياً:
  ١. تُحسب الإشارة الخام
  ٢. canEnter يستخدم حالة الصفقة كما كانت قبل هذه الشمعة
  ٣. الإشارة تُستهلك سواء أُخذت أم لا
  ٤. تُفتح الصفقة إن أمكن
  ٥. يُفحص الخروج فقط إذا كانت الشمعة بعد شمعة الدخول
"""
import json

import numpy as np

PU = 0.10
YEARS = ('2021', '2023', '2025', '2026')


def load(year):
    d = json.load(open(f'sig_{year}.json'))
    n = d['bars']
    rb = np.zeros(n, bool); rb[d['raw_buy']] = True
    rs = np.zeros(n, bool); rs[d['raw_sell']] = True
    return {'n': n, 'high': np.asarray(d['high']), 'low': np.asarray(d['low']),
            'close': np.asarray(d['close']), 'time': np.asarray(d['time']),
            'rb': rb, 'rs': rs, 'engine': d['engine_internal']}


def simulate(D, tp_pts, sl_pts, sides='BOTH', collide='skip', max_hold=0):
    """يعيد قائمة الصفقات: (شمعة الدخول, الجهة, النتيجة, شمعة الخروج).
    النتيجة: 1 فوز، 0 خسارة، -2 مُلغاة بالتصادم، -1 لم تُغلق حتى نهاية الداتا."""
    h, l, c, n = D['high'], D['low'], D['close'], D['n']
    rb, rs = D['rb'], D['rs']
    tpd, sld = tp_pts * PU, sl_pts * PU
    allow_b = sides in ('BOTH', 'BUY')
    allow_s = sides in ('BOTH', 'SELL')

    trades = []
    active = False
    side = 0; tp = sl = 0.0; entry_bar = -1; entry_px = 0.0
    for i in range(n):
        if not active:
            if rb[i] and allow_b:
                side = 1
            elif rs[i] and allow_s:
                side = -1
            else:
                side = 0
            if side:
                active = True
                entry_px = c[i]; entry_bar = i
                tp = entry_px + tpd if side > 0 else entry_px - tpd
                sl = entry_px - sld if side > 0 else entry_px + sld
        if active and i > entry_bar:
            if side > 0:
                ht, hs = h[i] >= tp, l[i] <= sl
            else:
                ht, hs = l[i] <= tp, h[i] >= sl
            done = None
            if ht and hs:
                done = -2 if collide == 'skip' else (1 if collide == 'tp' else 0)
            elif ht:
                done = 1
            elif hs:
                done = 0
            elif max_hold and i - entry_bar >= max_hold:
                done = 1 if (c[i] - entry_px) * side > 0 else 0
            if done is not None:
                trades.append((entry_bar, side, done, i))
                active = False
    if active:
        trades.append((entry_bar, side, -1, n - 1))
    return trades


def score(trades, tp_pts, sl_pts, ndays=1.0):
    w = sum(1 for t in trades if t[2] == 1)
    ls = sum(1 for t in trades if t[2] == 0)
    n = w + ls
    if n == 0:
        return None
    net = w * tp_pts - ls * sl_pts
    hold = np.mean([t[3] - t[0] for t in trades if t[2] >= 0]) if n else 0
    return {'trades': n, 'wins': w, 'losses': ls,
            'win_rate': 100.0 * w / n,
            'breakeven': 100.0 * sl_pts / (tp_pts + sl_pts),
            'net': net, 'per_trade': net / n,
            'skipped': sum(1 for t in trades if t[2] == -2),
            'avg_hold': float(hold), 'per_day': n / ndays}


if __name__ == '__main__':
    print("═══ تحقّق: هل يطابق المحاكي عدّادات المؤشر الداخلية؟ ═══")
    print(f"{'سنة':>6}{'':>3}{'صفقات':>9}{'فوز':>7}{'خسارة':>8}{'صافي':>9}   الحالة")
    ok = True
    for y in YEARS:
        D = load(y)
        tr = simulate(D, 130.0, 70.0)
        s = score(tr, 130.0, 70.0)
        e = D['engine']
        match = (s['trades'] == e['trades'] and s['wins'] == e['wins']
                 and s['losses'] == e['losses'] and abs(s['net'] - e['net']) < 1e-6)
        ok &= match
        print(f"{y:>6}{'محرك':>6}{e['trades']:>7}{e['wins']:>7}{e['losses']:>8}{e['net']:>9}")
        print(f"{'':>6}{'محاكي':>6}{s['trades']:>7}{s['wins']:>7}{s['losses']:>8}"
              f"{s['net']:>9.0f}   {'✓ مطابق' if match else '✗ مختلف'}")
    print("\n" + ("التحقق نجح — المحاكي بديل صالح عن المحرك."
                  if ok else "!! التحقق فشل — لا تُستخدم أي نتيجة بعد هذا."))
