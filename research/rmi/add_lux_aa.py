p='build_v2.py'; s=open(p,encoding='utf-8').read()

IN = '''
mcLuxMode = input.string("Off", "LuxAlgo Reversal", options=["Off", "Source", "Filter"], group=G_SRC)
mcLuxSetup = input.string("Exhaustion", "Lux Setup", options=["Momentum", "Exhaustion"], group=G_SRC)

mcAaMode = input.string("Off", "AlgoAlpha Reversal", options=["Off", "Source", "Filter"], group=G_SRC)
mcAaLookback = input.int(12, "AA Candle Lookback", minval=2, maxval=200, group=G_SRC)
mcAaConfirm = input.int(3, "AA Confirm Within", minval=1, maxval=50, group=G_SRC)
mcAaUseVolume = input.bool(true, "AA Use Volume Confirmation", group=G_SRC)
'''

CALC = '''
// ── LuxAlgo Reversal ────────────────────────────────────────────────────────
// عدّ مراحل على طريقة التسلسل: تسع شمعات زخم، ثم ثلاث عشرة شمعة استنزاف.
// الإشارة انقلاب السعر بعد اكتمال المرحلة. وضع Qualified محذوف لأنه يحتاج
// ta.valuewhen وهي غير متاحة في محرك الاختبار؛ الوضعان الباقيان كاملان.
var int mcLuxBs = 0
var int mcLuxSs = 0
mcLuxCon = close < nz(close[4], close)
mcLuxBs := mcLuxCon ? (mcLuxBs == 9 ? 1 : mcLuxBs + 1) : 0
mcLuxSs := mcLuxCon ? 0 : (mcLuxSs == 9 ? 1 : mcLuxSs + 1)
mcLuxBc8 = nz(mcLuxBs[1], 0) == 8 and mcLuxSs == 1
mcLuxSc8 = nz(mcLuxSs[1], 0) == 8 and mcLuxBs == 1

// مرحلة الاستنزاف: عدّ الإغلاقات تحت قاع شمعتين خلف، وبالعكس
var int mcLuxBcc = 0
var int mcLuxScc = 0
var bool mcLuxBon = false
var bool mcLuxSon = false
mcLuxBon := mcLuxBs == 9 ? true : (mcLuxSs == 9 or mcLuxBcc >= 13) ? false : mcLuxBon
mcLuxSon := mcLuxSs == 9 ? true : (mcLuxBs == 9 or mcLuxScc >= 13) ? false : mcLuxSon
mcLuxBcc := mcLuxBon ? (close <= nz(low[2], low) ? mcLuxBcc + 1 : mcLuxBcc) : 0
mcLuxScc := mcLuxSon ? (close >= nz(high[2], high) ? mcLuxScc + 1 : mcLuxScc) : 0

// انقلاب السعر بعد اكتمال المرحلة
mcLuxBuyReady = mcLuxSetup == "Momentum" ? (mcLuxBs == 9 or mcLuxBc8) : nz(mcLuxBcc[5], 0) == 13
mcLuxSellReady = mcLuxSetup == "Momentum" ? (mcLuxSs == 9 or mcLuxSc8) : nz(mcLuxScc[5], 0) == 13
var bool mcLuxBarm = false
var bool mcLuxSarm = false
mcLuxBuy = mcLuxBarm and close > nz(close[4], close) and nz(close[1], close) < nz(close[5], close)
mcLuxSell = mcLuxSarm and close < nz(close[4], close) and nz(close[1], close) > nz(close[5], close)
mcLuxBarm := mcLuxBuyReady ? true : mcLuxBuy ? false : mcLuxBarm
mcLuxSarm := mcLuxSellReady ? true : mcLuxSell ? false : mcLuxSarm
mcLuxBuyOK = not mcLuxSarm
mcLuxSellOK = not mcLuxBarm

// ── AlgoAlpha Reversal ──────────────────────────────────────────────────────
// شمعة تغلق تحت كل قيعان النافذة تُرشِّح انعكاساً صاعداً، ثم يتأكّد باختراق
// قمتها خلال عدد محدود من الشموع، مع تأكيد فوليوم اختياري.
mcAaVolHigh = volume > ta.sma(volume, 20)
mcAaBullScore = 0
mcAaBearScore = 0
for mcAaI = 0 to mcAaLookback - 1
    if close < low[mcAaI]
        mcAaBullScore += 1
    if close > high[mcAaI]
        mcAaBearScore += 1

var bool mcAaBullCand = false
var bool mcAaBearCand = false
var float mcAaBullLo = 0.0
var float mcAaBullHi = 0.0
var float mcAaBearLo = 0.0
var float mcAaBearHi = 0.0
var bool mcAaBullDone = false
var bool mcAaBearDone = false
var int mcAaBullCnt = 0
var int mcAaBearCnt = 0

mcAaNewBull = mcAaBullScore == mcAaLookback - 1
mcAaNewBear = mcAaBearScore == mcAaLookback - 1
mcAaBullCand := mcAaNewBull ? true : mcAaBullCand
mcAaBullLo := mcAaNewBull ? low : mcAaBullLo
mcAaBullHi := mcAaNewBull ? high : mcAaBullHi
mcAaBullDone := mcAaNewBull ? false : mcAaBullDone
mcAaBullCnt := mcAaNewBull ? 0 : (mcAaBullCand ? mcAaBullCnt + 1 : mcAaBullCnt)
mcAaBearCand := mcAaNewBear ? true : mcAaBearCand
mcAaBearLo := mcAaNewBear ? low : mcAaBearLo
mcAaBearHi := mcAaNewBear ? high : mcAaBearHi
mcAaBearDone := mcAaNewBear ? false : mcAaBearDone
mcAaBearCnt := mcAaNewBear ? 0 : (mcAaBearCand ? mcAaBearCnt + 1 : mcAaBearCnt)

mcAaBullFire = mcAaBullCand and close > mcAaBullHi and not mcAaBullDone and mcAaBullCnt <= mcAaConfirm + 1
mcAaBearFire = mcAaBearCand and close < mcAaBearLo and not mcAaBearDone and mcAaBearCnt <= mcAaConfirm + 1
mcAaBuy = mcAaBullFire and (not mcAaUseVolume or mcAaVolHigh)
mcAaSell = mcAaBearFire and (not mcAaUseVolume or mcAaVolHigh)
mcAaBullDone := mcAaBullFire ? true : mcAaBullDone
mcAaBearDone := mcAaBearFire ? true : mcAaBearDone
mcAaBullCand := mcAaBullCand and close >= mcAaBullLo
mcAaBearCand := mcAaBearCand and close <= mcAaBearHi
mcAaBuyOK = not mcAaBearCand
mcAaSellOK = not mcAaBullCand
'''

s=s.replace('mcAtrLen = input.int(14, "ATR Length — shared by sources", minval=1, group=G_SRC)',
            IN.strip() + '\n\nmcAtrLen = input.int(14, "ATR Length — shared by sources", minval=1, group=G_SRC)')
s=s.replace("// ── تجميع المصادر والفلاتر ──", CALC.strip() + "\n\n// ── تجميع المصادر والفلاتر ──")
NEW=['Lux','Aa']
for a,b in [('f_src(mcKwMode, mcKwBuy)','f_src(mcKwMode, mcKwBuy) or '+" or ".join(f"f_src(mc{n}Mode, mc{n}Buy)" for n in NEW)),
            ('f_src(mcKwMode, mcKwSell)','f_src(mcKwMode, mcKwSell) or '+" or ".join(f"f_src(mc{n}Mode, mc{n}Sell)" for n in NEW)),
            ('f_flt(mcKwMode, mcKwBuyOK)','f_flt(mcKwMode, mcKwBuyOK) and '+" and ".join(f"f_flt(mc{n}Mode, mc{n}BuyOK)" for n in NEW)),
            ('f_flt(mcKwMode, mcKwSellOK)','f_flt(mcKwMode, mcKwSellOK) and '+" and ".join(f"f_flt(mc{n}Mode, mc{n}SellOK)" for n in NEW)),
            ('(mcKwMode != "Off" ? 1 : 0)','(mcKwMode != "Off" ? 1 : 0) + '+" + ".join(f'(mc{n}Mode != "Off" ? 1 : 0)' for n in NEW))]:
    assert a in s, a
    s=s.replace(a,b)
open(p,'w',encoding='utf-8').write(s)
print("أُضيف LuxAlgo Reversal و AlgoAlpha Reversal")
