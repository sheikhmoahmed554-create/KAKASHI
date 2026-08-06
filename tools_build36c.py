#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SYR36 stage 3 — state the two hard-coded plans in the market's own units.

RMI asks for 130 points and risks 70. Those are not numbers about gold, they are
numbers about 2026: the average one-minute bar was 21.4 points that year, 3.9 in
2021 and 3.6 in 2023. So the same 130 is six bars of range in one year and
thirty-three in another, and in the thin years the target sits four times further
than price travels in the 130 bars it has. Nothing resolves. Measured standalone
on the three years, 130/70 fixed gives +7,550 / +1,202 / -1,299.

Asia Sweep has the same defect in a smaller place: its target is the Asia range
midpoint, which already breathes, but the 5-point break threshold and the
10-point stop buffer are fixed.

The repair is one shared series — the average bar range in points — and every
fixed distance restated as a multiple of it.
"""
import io

SRC = DST = 'SYR36_CLEAN.pine'
s = io.open(SRC, encoding='utf-8').read()
before = len(s.splitlines())

SCALE = u'''//''' + u'━' * 38 + u'''
// MARKET SCALE — the unit every fixed distance below is now quoted in
//
// The average one-minute bar range, in points, over the last 500 bars. Not ATR:
// no true range, no Wilder smoothing, just how far a bar actually travels lately.
//
//   2026    21.4 points        2021    3.9        2023    3.6
//
// A plan written in raw points is a plan written for one of those three markets.
// Written as a multiple of this, it is the same trade in all of them. Measured
// on RMI standalone across the three years, one position, stop wins a tie:
//
//   plan                        2026      2021      2023    worst
//   130 / 70 fixed            +7,550    +1,202    -1,299   -1,299
//   6.07x / 3.27x scaled     +12,764      +925      -325     -325
//   5.00x / 3.27x scaled     +11,006      +444       +67      +67
//
// The middle row is the shipped plan converted; the last is the same plan with
// the target ratio swept, judged on the worst of the three years rather than on
// 2026. That is the pair used below.
//
// Trade counts tell the story better than the points do. On 2021 the fixed plan
// resolved 494 trades in a whole year; scaled, the same rule resolved 2,833. The
// rule was never losing there — it was never being asked a question it could
// answer.
//''' + u'━' * 38 + u'''
G_SCALE = "25 ■ مقياس السوق — Market Scale"
mktScaleUse = input.bool(true, "اقرأ المسافات بمقاس السوق بدل النقاط الثابتة", group=G_SCALE, tooltip="مطفي = ترجع كل الأهداف والستوبات أرقام ثابتة بالنقاط، مثل ما كانت بالضبط.")
mktScaleLen = input.int(500, "عدد الشموع لقياس مدى الشمعة", minval=50, maxval=5000, group=G_SCALE)
mktScaleRef = input.float(21.4, "مدى الشمعة وقت ضبط الأرقام (2026)", minval=1.0, step=0.1, group=G_SCALE, tooltip="متوسط مدى شمعة الدقيقة بالنقاط على 2026. الأرقام الأصلية انضبطت على هالمقاس، فمنه تتحول لنسب.")
mktScale = ta.sma(high - low, mktScaleLen) / pointUnit
mktScaleOK = mktScale > 0

'''

anchor = u'// 24 ■ RMI SOURCE'
i = s.index(anchor)
j = s.rindex(u'\n', 0, s.rindex(u'\n', 0, i)) + 1     # above its banner line
s = s[:j] + SCALE + s[j:]

# ── RMI: its own target and stop become multiples ─────────────────────────────
a = u'rsrcStopPts = input.float(70.0, "RMI Stop Points", minval=1.0, step=1.0, group=G_RSRC)\n'
assert s.count(a) == 1
s = s.replace(a, a + u'''rsrcTgtMult = input.float(5.00, "   ...أو: الهدف = كم مرة مدى الشمعة", minval=0.5, maxval=20.0, step=0.01, group=G_RSRC, tooltip="5.00 اختيرت على أسوأ السنين الثلاث. تحويل 130/70 حرفياً هو 6.07 و 3.27، وبيعطي 2026 أعلى بس 2023 سالبة.")
rsrcStpMult = input.float(3.27, "   ...والستوب = كم مرة مدى الشمعة", minval=0.5, maxval=20.0, step=0.01, group=G_RSRC)
''', 1)

a = u'''    if tradeEntrySourceCode == 7 and rsrcUseOwnTargets and not useMainFixedRisk
        tradeTargetPts := rsrcTargetPts
        tradeStopPts := rsrcStopPts'''
assert s.count(a) == 1
s = s.replace(a, u'''    if tradeEntrySourceCode == 7 and rsrcUseOwnTargets and not useMainFixedRisk
        // the plan in the market's own units, or the raw points if the scale is off
        tradeTargetPts := mktScaleUse and mktScaleOK ? math.max(10.0, mktScale * rsrcTgtMult) : rsrcTargetPts
        tradeStopPts := mktScaleUse and mktScaleOK ? math.max(10.0, mktScale * rsrcStpMult) : rsrcStopPts''', 1)

# ── Asia Sweep: the break threshold and the stop buffer ───────────────────────
a = u'kzStopBufPts = input.float(10.0, "هامش الستوب خلف رأس الكنسة (نقاط)", minval=0.0, step=1.0, group=G_KZ)\n'
assert s.count(a) == 1
s = s.replace(a, a + u'''
// Its target is already relative — the Asia range midpoint — but these two are
// not. 5 and 10 points are 0.234 and 0.467 of a 2026 bar; on a 2021 bar they are
// 1.3 and 2.6 of one, so the break threshold alone was six times stricter there.
kzBreakEff = mktScaleUse and mktScaleOK ? mktScale * (kzBreakPts / mktScaleRef) : kzBreakPts
kzStopBufEff = mktScaleUse and mktScaleOK ? mktScale * (kzStopBufPts / mktScaleRef) : kzStopBufPts
''', 1)

for a, b in [
 ('if high >= kzAsiaHi + kzBreakPts * pointUnit', 'if high >= kzAsiaHi + kzBreakEff * pointUnit'),
 ('if low <= kzAsiaLo - kzBreakPts * pointUnit', 'if low <= kzAsiaLo - kzBreakEff * pointUnit'),
 ('float kzSlPx = side == 1 ? kzLoExt - kzStopBufPts * pointUnit : kzHiExt + kzStopBufPts * pointUnit',
  'float kzSlPx = side == 1 ? kzLoExt - kzStopBufEff * pointUnit : kzHiExt + kzStopBufEff * pointUnit'),
]:
    assert s.count(a) == 1, a[:50]
    s = s.replace(a, b, 1)

io.open(DST, 'w', encoding='utf-8').write(s)
print('%s: %d lines (was %d)' % (DST, len(s.splitlines()), before))
