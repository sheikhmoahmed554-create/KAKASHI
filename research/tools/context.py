"""قراءة السوق ككتلة واحدة: الاتجاه، النطاق، سحب السيولة، كسر الهيكل، الارتداد.

هذه ليست مدرسة جديدة تُضاف إلى تسع مدارس. هذه طبقة تصف **حالة السوق** عند كل شمعة،
حتى يصير لكل صفقة سبب يُقال بالكلام: «دخلت شراء لأن السوق صاعد وحصل سحب سيولة
تحت قاع سابق ثم رجع فوقه».

المفاهيم الأساسية المطبّقة:
  القمم والقيعان   — نقاط انعكاس مؤكدة (swing) بنافذة يمين ويسار
  الاتجاه          — تتابع قمم وقيعان صاعدة/هابطة + موقع السعر من المتوسطات
  كسر الهيكل       — إغلاق فوق آخر قمة مؤكدة أو تحت آخر قاع مؤكد
  سحب السيولة      — اختراق ذيل فقط لقمة/قاع سابق ثم إغلاق راجع داخل النطاق
  الارتداد         — سحب سيولة في اتجاه معاكس للاتجاه العام مع رفض واضح
  النطاق           — لا اتجاه: تذبذب منخفض وحركة داخل حدود
"""
import numpy as np

SWING_L = 5          # شموع يسار ويمين لتأكيد القمة أو القاع
SWEEP_LOOKBACK = 60  # مدى البحث عن قمة/قاع سابق للسحب


def swings(h, l, k=SWING_L):
    """قمة مؤكدة: أعلى من k شمعة يمينها ويسارها. تُعرف بعد k شمعة من حدوثها."""
    n = len(h)
    hi = np.zeros(n, bool)
    lo = np.zeros(n, bool)
    for i in range(k, n - k):
        w_h = h[i - k:i + k + 1]
        w_l = l[i - k:i + k + 1]
        if h[i] == w_h.max() and (w_h == h[i]).sum() == 1:
            hi[i] = True
        if l[i] == w_l.min() and (w_l == l[i]).sum() == 1:
            lo[i] = True
    return hi, lo


def last_confirmed(mask, values, k=SWING_L):
    """قيمة آخر قمة/قاع مؤكد **متاح** عند كل شمعة — بعد k شمعة تأكيد، بلا نظر للمستقبل."""
    n = len(values)
    out = np.full(n, np.nan)
    idx = np.full(n, -1)
    cur, cur_i = np.nan, -1
    for i in range(n):
        j = i - k                      # الشمعة التي تأكدت الآن
        if j >= 0 and mask[j]:
            cur, cur_i = values[j], j
        out[i], idx[i] = cur, cur_i
    return out, idx


def build(D, F):
    """يرجع قاموس أقنعة وقيَم تصف حالة السوق عند كل شمعة."""
    o, h, l, c, n = D['o'], D['h'], D['l'], D['c'], D['n']
    C = {}
    sh, sl_ = swings(h, l)
    prev_hi, prev_hi_i = last_confirmed(sh, h)
    prev_lo, prev_lo_i = last_confirmed(sl_, l)
    C['prev_hi'], C['prev_lo'] = prev_hi, prev_lo

    # ── الاتجاه: موقع السعر من المتوسطات + ميل + تتابع الهيكل
    ema20, ema50, ema200 = F['ema20'], F['ema50'], F['ema200']
    slope = F['htf60_slope']
    up = (c > ema50) & (ema20 > ema50) & (ema50 > ema200) & (slope > 20)
    dn = (c < ema50) & (ema20 < ema50) & (ema50 < ema200) & (slope < -20)
    C['trend_up'], C['trend_down'] = up, dn
    C['range'] = ~up & ~dn & (F['atr_ratio'] < 1.0)

    # ── كسر الهيكل: إغلاق يتجاوز آخر قمة/قاع مؤكد
    C['bos_up'] = np.isfinite(prev_hi) & (c > prev_hi) & (np.roll(c, 1) <= prev_hi)
    C['bos_down'] = np.isfinite(prev_lo) & (c < prev_lo) & (np.roll(c, 1) >= prev_lo)

    # ── سحب السيولة: الذيل يخترق المستوى والإغلاق يرجع داخله
    C['sweep_low'] = np.isfinite(prev_lo) & (l < prev_lo) & (c > prev_lo) & (c > o)
    C['sweep_high'] = np.isfinite(prev_hi) & (h > prev_hi) & (c < prev_hi) & (c < o)

    # عمق السحب بالنقاط — سحب ضحل جداً ليس سحباً
    C['sweep_depth_low'] = np.where(C['sweep_low'], (prev_lo - l) / 0.1, 0.0)
    C['sweep_depth_high'] = np.where(C['sweep_high'], (h - prev_hi) / 0.1, 0.0)

    # ── الارتداد: سحب سيولة ضد الاتجاه العام مع رفض واضح بالذيل
    C['reversal_up'] = C['sweep_low'] & (F['dnwick'] > 0.40) & ~up
    C['reversal_down'] = C['sweep_high'] & (F['upwick'] > 0.40) & ~dn

    # ── استمرار مع الاتجاه: كسر هيكل في اتجاه السوق نفسه
    C['continuation_up'] = C['bos_up'] & up
    C['continuation_down'] = C['bos_down'] & dn

    # ── تصنيف واحد لكل شمعة، بالأولوية: سحب ← كسر ← اتجاه ← نطاق
    label = np.full(n, 'محايد', dtype=object)
    label[C['range']] = 'نطاق'
    label[up] = 'اتجاه صاعد'
    label[dn] = 'اتجاه هابط'
    label[C['bos_up']] = 'كسر قمة'
    label[C['bos_down']] = 'كسر قاع'
    label[C['sweep_high']] = 'سحب سيولة فوق'
    label[C['sweep_low']] = 'سحب سيولة تحت'
    C['label'] = label
    return C


def why(C, i, side):
    """سبب الدخول بالكلام، أو سبب اعتباره غير مبرَّر."""
    bits = []
    if C['trend_up'][i]:
        bits.append('اتجاه صاعد')
    elif C['trend_down'][i]:
        bits.append('اتجاه هابط')
    elif C['range'][i]:
        bits.append('نطاق')
    if C['sweep_low'][i]:
        bits.append(f"سحب سيولة تحت قاع بعمق {C['sweep_depth_low'][i]:.0f} نقطة")
    if C['sweep_high'][i]:
        bits.append(f"سحب سيولة فوق قمة بعمق {C['sweep_depth_high'][i]:.0f} نقطة")
    if C['bos_up'][i]:
        bits.append('كسر قمة مؤكدة')
    if C['bos_down'][i]:
        bits.append('كسر قاع مؤكد')

    ok = False
    if side == 1:
        ok = C['continuation_up'][i] or C['reversal_up'][i] or (C['trend_up'][i] and not C['trend_down'][i])
    else:
        ok = C['continuation_down'][i] or C['reversal_down'][i] or (C['trend_down'][i] and not C['trend_up'][i])
    return (' + '.join(bits) if bits else 'لا شيء يُذكر'), bool(ok)
