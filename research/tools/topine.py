"""يحوّل قواعد المعمل إلى مؤشر Pine v5 جاهز للتشغيل على TradingView.

    python3 topine.py version_A.json KAKASHI_LAB_A.pine "KAKASHI LAB A"

المؤشر الناتج يصدّر canEnterLong / canEnterShort وخطة الخروج، فيعمل مباشرة
داخل منصة كاكاشي، ويرسم إشارات الدخول على شارت TradingView.
"""
import json, re, sys

# ترجمة كل خاصية من مكتبة methods.py إلى Pine — الأسماء مطابقة للتعريفات الأصلية
PINE_DEFS = """
// ══════════ الخصائص ══════════
pu   = 0.1
dayIdx = int(time / 86400000)
newDay = dayIdx != dayIdx[1]
atrR = ta.rma(ta.tr(true), 14)
atr14 = atrR / pu
atr60 = ta.rma(ta.tr(true), 60) / pu
atr_ratio = atr14 / math.max(atr60, 1e-9)
atr_accel = atr14 / math.max(atr14[30], 1e-9)
rng = math.max(high - low, 1e-9)

rsi14 = ta.rsi(close, 14)
rsi3  = ta.rsi(close, 3)
body  = math.abs(close - open) / rng
dnwick = (math.min(open, close) - low) / rng

ret1 = (close - close[1]) / pu
ret5 = (close - close[5]) / pu
roc5 = (close - close[5]) / math.max(close[5], 1e-9) * 10000

hh20 = ta.highest(high, 20)
ll20 = ta.lowest(low, 20)
hh60 = ta.highest(high, 60)
ll60 = ta.lowest(low, 60)
hh240 = ta.highest(high, 240)
ll240 = ta.lowest(low, 240)
pos20  = (close - ll20)  / math.max(hh20 - ll20, 1e-9) * 100
pos60  = (close - ll60)  / math.max(hh60 - ll60, 1e-9) * 100
pos240 = (close - ll240) / math.max(hh240 - ll240, 1e-9) * 100

bbMid = ta.sma(close, 20)
bbSd = ta.stdev(close, 20)
bb_z = (close - bbMid) / math.max(bbSd, 1e-9)
kMid = ta.ema(close, 20)
kAtr = ta.rma(math.max(high - low, 1e-9), 20)
kelt_z = (close - kMid) / math.max(2 * kAtr, 1e-9)
bb_squeeze = (bbSd * 4) / math.max(kAtr * 2, 1e-9)

ema9 = ta.ema(close, 9)
ema21 = ta.ema(close, 21)
ema50 = ta.ema(close, 50)
ema9_21  = (ema9 - ema21) / pu
ema21_50 = (ema21 - ema50) / pu

vol_ratio = nz(volume, 0) / math.max(ta.sma(nz(volume, 0), 60), 1e-9)

stoch5  = (close - ta.lowest(low, 5))  / math.max(ta.highest(high, 5)  - ta.lowest(low, 5),  1e-9) * 100
stoch14 = (close - ta.lowest(low, 14)) / math.max(ta.highest(high, 14) - ta.lowest(low, 14), 1e-9) * 100
stoch21 = (close - ta.lowest(low, 21)) / math.max(ta.highest(high, 21) - ta.lowest(low, 21), 1e-9) * 100
willr5  = -100 * (ta.highest(high, 5)  - close) / math.max(ta.highest(high, 5)  - ta.lowest(low, 5),  1e-9)
willr14 = -100 * (ta.highest(high, 14) - close) / math.max(ta.highest(high, 14) - ta.lowest(low, 14), 1e-9)
willr21 = -100 * (ta.highest(high, 21) - close) / math.max(ta.highest(high, 21) - ta.lowest(low, 21), 1e-9)
mfTyp = hlc3
mfRaw = mfTyp * nz(volume, 0)
mfUp  = mfTyp > mfTyp[1] ? mfRaw : 0.0
mfDn  = mfTyp < mfTyp[1] ? mfRaw : 0.0
mfi14 = 100 - 100 / (1 + ta.sma(mfUp, 14) / math.max(ta.sma(mfDn, 14), 1e-9))
[pDI, mDI, adxv] = ta.dmi(14, 14)
adx = adxv
di_diff = pDI - mDI

// VWAP يومي وانحرافه بالـ ATR
var float vwCumPV = 0.0
var float vwCumV  = 0.0
vwTyp = hlc3
vwV   = math.max(nz(volume, 0), 1e-9)
if newDay
    vwCumPV := vwTyp * vwV
    vwCumV  := vwV
else
    vwCumPV := vwCumPV + vwTyp * vwV
    vwCumV  := vwCumV + vwV
vwapD = vwCumPV / math.max(vwCumV, 1e-9)
vwap_dist = (close - vwapD) / pu
vwap_dist_atr = vwap_dist / math.max(atr14, 1e-9)

// إيشيموكو
ten = (ta.highest(high, 9) + ta.lowest(low, 9)) / 2
kij = (ta.highest(high, 26) + ta.lowest(low, 26)) / 2
ichi_price_kij = (close - kij) / pu
ichi_price_kij_atr = ichi_price_kij / math.max(atr14, 1e-9)

// Parabolic SAR
var float sarv = na
var float sarEP = na
var float sarAF = 0.02
var bool  sarUp = true
if na(sarv)
    sarv := low
    sarEP := high
else
    sarv := sarv + sarAF * (sarEP - sarv)
    if sarUp
        if low < sarv
            sarUp := false
            sarv := sarEP
            sarEP := low
            sarAF := 0.02
        else if high > sarEP
            sarEP := high
            sarAF := math.min(sarAF + 0.02, 0.2)
    else
        if high > sarv
            sarUp := true
            sarv := sarEP
            sarEP := high
            sarAF := 0.02
        else if low < sarEP
            sarEP := low
            sarAF := math.min(sarAF + 0.02, 0.2)
sar_dist = (close - sarv) / pu
sar_dist_atr = sar_dist / math.max(atr14, 1e-9)

// دونشيان
dh20 = ta.highest(high, 20)[1]
dl20 = ta.lowest(low, 20)[1]
dh55 = ta.highest(high, 55)
dl55 = ta.lowest(low, 55)
donch55_pos = (close - dl55) / math.max(dh55 - dl55, 1e-9) * 100
donch20_brk_dn = close < dl20 ? 1 : 0
donch55_brk_dn = close < ta.lowest(low, 55)[1] ? 1 : 0

// نقاط محورية يومية من اليوم السابق
var float curH = na
var float curL = na
var float pdH  = na
var float pdL  = na
var float pdC  = na
if newDay
    pdH := curH
    pdL := curL
    pdC := close[1]
    curH := high
    curL := low
else
    curH := math.max(nz(curH, high), high)
    curL := math.min(nz(curL, low), low)
pivP = (nz(pdH) + nz(pdL) + nz(pdC)) / 3
piv_dist    = na(pdH) ? 0.0 : (close - pivP) / pu
piv_r1_dist = na(pdH) ? 0.0 : (close - (2 * pivP - pdL)) / pu
piv_s1_dist = na(pdH) ? 0.0 : (close - (2 * pivP - pdH)) / pu
piv_r1_dist_atr = piv_r1_dist / math.max(atr14, 1e-9)
piv_s1_dist_atr = piv_s1_dist / math.max(atr14, 1e-9)

// فيبوناتشي من مدى 120 شمعة
fH = ta.highest(high, 120)
fL = ta.lowest(low, 120)
fSpan = math.max(fH - fL, 1e-9)
fib_382_dist_atr = ((close - (fL + fSpan * 0.382)) / pu) / math.max(atr14, 1e-9)

// هيكل السوق: قمم وقيعان مؤكَّدة بعد 3 شموع
swH = ta.pivothigh(high, 3, 3)
swL = ta.pivotlow(low, 3, 3)
var float lastSwH = na
var float lastSwL = na
if not na(swH)
    lastSwH := swH
if not na(swL)
    lastSwL := swL
dist_swing_hi = na(lastSwH) ? 0.0 : (lastSwH - close) / pu
dist_swing_lo = na(lastSwL) ? 0.0 : (close - lastSwL) / pu

// اكتساح السيولة ودايفرجنس
sweep_high = (high > ta.highest(high, 20)[1] and close < ta.highest(high, 20)[1]) ? 1 : 0
pMin30 = ta.lowest(close, 30)
rMin30 = ta.lowest(rsi14, 30)
div_bull = (close <= pMin30 and rsi14 > rMin30 + 3) ? 1 : 0

// سلاسل الصعود والهبوط
var int upS = 0
var int dnS = 0
upS := close > open ? upS + 1 : 0
dnS := close < open ? dnS + 1 : 0
up_streak = upS
dn_streak = dnS

// نطاق افتتاح اليوم (أول 60 دقيقة)
var float orH = na
var float orL = na
var int    orN = 0
if newDay
    orH := high
    orL := low
    orN := 0
else
    orN := orN + 1
    if orN < 60
        orH := math.max(orH, high)
        orL := math.min(orL, low)
or_pos    = (na(orH) or orH <= orL) ? 50.0 : (close - orL) / math.max(orH - orL, 1e-9) * 100
or_brk_up = (not na(orH) and close > orH and orN >= 60) ? 1 : 0

// ميل الفريمات الأعلى (مبني من M1)
e45  = ta.ema(close, 45)
htf5_slope  = (e45  - e45[5])   / pu
e135 = ta.ema(close, 135)
htf15_slope = (e135 - e135[15]) / pu
e540 = ta.ema(close, 540)
htf60_slope = (e540 - e540[60]) / pu

// الجلسات بتوقيت UTC
hUTC = hour(time, "UTC")
sess_asia   = (hUTC >= 0  and hUTC < 7)  ? 1 : 0
sess_london = (hUTC >= 7  and hUTC < 13) ? 1 : 0
sess_ny     = (hUTC >= 13 and hUTC < 21) ? 1 : 0
"""


def cond_to_pine(part):
    part = part.strip()
    if '<' in part:
        f, t = part.split('<'); return '%s < %s' % (f.strip(), t.strip())
    if '>' in part:
        f, t = part.split('>'); return '%s > %s' % (f.strip(), t.strip())
    if '=' in part:
        f = part.split('=')[0].strip(); return '%s == 1' % f
    raise ValueError(part)


def main(src, out, title):
    d = json.load(open(src))
    rules = d['rules']
    ver, t = d['version'], d['test']
    buys = [r for r in rules if r['side'] == 'BUY']
    sells = [r for r in rules if r['side'] == 'SELL']

    L = []
    L.append('//@version=5')
    L.append('// %s — مولّد آلياً من بحث كاكاشي' % title)
    L.append('// النسخة %s • %d عائلة (%d شراء، %d بيع)' % (ver, len(rules), len(buys), len(sells)))
    L.append('// قياس خارج العينة: %.1f%% فوز • %.1f صفقة/يوم • توقّع %+.2f نقطة • متوسط %.1f شمعة'
             % (t['win_rate'], t['per_day'], t['expectancy'], t['avg_bars']))
    L.append('// القيود: صفقة واحدة مفتوحة • وقف زمني 30 شمعة • هدف 30 / وقف 50')
    L.append('indicator("%s", overlay=true, max_bars_back=600)' % title)
    L.append(PINE_DEFS)
    L.append('\n// ══════════ القواعد ══════════')

    # القواعد بترتيب الأولوية نفسه المستخدم في القياس: أول قاعدة تُطلق هي التي تُنفَّذ
    for i, r in enumerate(rules, 1):
        expr = ' and '.join(cond_to_pine(p) for p in r['name'].split(' & '))
        L.append('r%03d = %s   // %s %.1f%% / %.1f%%'
                 % (i, expr, r['side'], r['wr_train'], r['wr_test']))

    L.append('\n// الاختيار بالأولوية — أول قاعدة تُطلق تحدد الجهة')
    chain = ' : '.join('r%03d ? %d' % (i, 1 if r['side'] == 'BUY' else -1)
                       for i, r in enumerate(rules, 1))
    L.append('sideSel = %s : 0' % chain)
    L.append('')
    L.append('canEnterLong  = sideSel ==  1')
    L.append('canEnterShort = sideSel == -1')
    L.append('')
    L.append('// خطة الخروج التي قيست عليها الأرقام')
    L.append('tradeTargetPts = 30.0')
    L.append('tradeStopPts   = 50.0')
    L.append('pointUnit      = pu')
    L.append('tpPrice = canEnterLong ? close + tradeTargetPts * pu : canEnterShort ? close - tradeTargetPts * pu : na')
    L.append('slPrice = canEnterLong ? close - tradeStopPts   * pu : canEnterShort ? close + tradeStopPts   * pu : na')
    L.append('entryPrice = close')
    L.append('')
    L.append('plotshape(canEnterLong,  "BUY",  shape.labelup,   location.belowbar, color.new(color.green, 0), text="BUY",  textcolor=color.white, size=size.tiny)')
    L.append('plotshape(canEnterShort, "SELL", shape.labeldown, location.abovebar, color.new(color.red,   0), text="SELL", textcolor=color.white, size=size.tiny)')
    L.append('alertcondition(canEnterLong,  "KAKASHI BUY",  "BUY")')
    L.append('alertcondition(canEnterShort, "KAKASHI SELL", "SELL")')

    open(out, 'w').write('\n'.join(L) + '\n')
    print('%s : %d سطر • %d قاعدة (%d شراء، %d بيع)'
          % (out, len(L), len(rules), len(buys), len(sells)))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3])
