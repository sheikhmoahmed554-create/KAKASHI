"""يبني RMI V2 = محرك صفقات RMI + مصادر Multicator، بالتركيب على الملف المتحقَّق منه.

نبني بالتركيب لا بإعادة الكتابة: الملف الأصلي متحقَّق منه صفقةً بصفقة مقابل المحرك،
وإعادة كتابته يدوياً تخاطر بتغيير حرف يقلب النتيجة بلا أن ينتبه أحد. فنُدخل الكتل
الجديدة في مواضع محددة ونتحقق بعدها أن خط الأساس لم يتزحزح.

القاعدة الحاكمة: كل مصدر جديد مطفأ افتراضياً، فيبقى السلوك مطابقاً للأصل تماماً
حتى يُشغَّل واحد منها عمداً.

    python3 build_v2.py
"""

SRC_INPUTS = '''
// ══════════════════════════════════════════════════════════════════
// 03 ■ Multicator Sources
// كل أداة تعمل بأحد ثلاثة أوضاع:
//   Off    — لا أثر لها إطلاقاً
//   Source — تفتح صفقة بنفسها، بالتوازي مع RMI
//   Filter — لا تفتح شيئاً، لكنها تمنع أي دخول لا يوافقها
// الافتراضي Off في الجميع، فيبقى المؤشر مطابقاً لخط الأساس المتحقَّق منه.
// ══════════════════════════════════════════════════════════════════
mcRsiMode = input.string("Off", "RSI", options=["Off", "Source", "Filter"], group=G_SRC)
mcRsiLen = input.int(14, "RSI Length", minval=2, group=G_SRC)
mcRsiMaLen = input.int(10, "RSI MA Length", minval=2, group=G_SRC)
mcRsiOS = input.float(30.0, "RSI Oversold", minval=1.0, maxval=50.0, group=G_SRC)
mcRsiOB = input.float(70.0, "RSI Overbought", minval=50.0, maxval=99.0, group=G_SRC)

mcMacdMode = input.string("Off", "MACD", options=["Off", "Source", "Filter"], group=G_SRC)
mcMacdFast = input.int(12, "MACD Fast", minval=1, group=G_SRC)
mcMacdSlow = input.int(26, "MACD Slow", minval=2, group=G_SRC)
mcMacdSig = input.int(9, "MACD Signal", minval=1, group=G_SRC)

mcAdxMode = input.string("Off", "ADX / DMI", options=["Off", "Source", "Filter"], group=G_SRC)
mcAdxLen = input.int(17, "DMI Length", minval=1, group=G_SRC)
mcAdxSmooth = input.int(14, "ADX Smoothing", minval=1, maxval=50, group=G_SRC)
mcAdxMin = input.float(20.0, "ADX Minimum", minval=0.0, maxval=60.0, step=1.0, group=G_SRC)

mcBbMode = input.string("Off", "Bollinger", options=["Off", "Source", "Filter"], group=G_SRC)
mcBbLen = input.int(20, "BB Length", minval=2, group=G_SRC)
mcBbMult = input.float(2.0, "BB StdDev", minval=0.1, maxval=10.0, step=0.1, group=G_SRC)

mcIchiMode = input.string("Off", "Ichimoku", options=["Off", "Source", "Filter"], group=G_SRC)
mcIchiConv = input.int(9, "Conversion Length", minval=1, group=G_SRC)
mcIchiBase = input.int(26, "Base Length", minval=1, group=G_SRC)
mcIchiSpanB = input.int(52, "Leading Span B Length", minval=1, group=G_SRC)

mcSarMode = input.string("Off", "Parabolic SAR", options=["Off", "Source", "Filter"], group=G_SRC)
mcSarStart = input.float(0.02, "SAR Start", minval=0.001, step=0.001, group=G_SRC)
mcSarInc = input.float(0.02, "SAR Increment", minval=0.001, step=0.001, group=G_SRC)
mcSarMax = input.float(0.2, "SAR Maximum", minval=0.01, step=0.01, group=G_SRC)

mcPivotMode = input.string("Off", "Pivot Reclaim", options=["Off", "Source", "Filter"], group=G_SRC)
mcPivotLeft = input.int(10, "Pivot Left", minval=1, group=G_SRC)
mcPivotRight = input.int(10, "Pivot Right", minval=1, group=G_SRC)

mcFibMode = input.string("Off", "Fibonacci Retracement", options=["Off", "Source", "Filter"], group=G_SRC)
mcFibLen = input.int(233, "Fibonacci Distance", minval=8, group=G_SRC)
mcFibA = input.float(0.618, "Fib Level A", minval=0.0, maxval=1.618, step=0.001, group=G_SRC)
mcFibB = input.float(0.382, "Fib Level B", minval=0.0, maxval=1.618, step=0.001, group=G_SRC)
mcFibC = input.float(0.786, "Fib Level C", minval=0.0, maxval=1.618, step=0.001, group=G_SRC)
mcFibTolATR = input.float(0.25, "Fib Touch Tolerance ATR", minval=0.01, maxval=2.0, step=0.01, group=G_SRC)

mcMaMode = input.string("Off", "Moving Average", options=["Off", "Source", "Filter"], group=G_SRC)
mcMaType = input.string("EMA", "MA Type", options=["EMA", "SMA"], group=G_SRC)
mcMaLen = input.int(200, "MA Length", minval=2, group=G_SRC)

mcAtrLen = input.int(14, "ATR Length — shared by sources", minval=1, group=G_SRC)
'''

SRC_CALC = '''
// ══════════════════════════════════════════════════════════════════
// MULTICATOR SOURCES — كل أداة تُنتج إشارة شراء وإشارة بيع
// كلها سببية: لا تقرأ إلا شموعاً مغلقة. ta.pivot* تُرجع قيمة قديمة
// مؤكَّدة بالفعل، فلا نظرة أمامية فيها.
// ══════════════════════════════════════════════════════════════════
mcATR = ta.atr(mcAtrLen)

// RSI — تقاطع مع متوسطه قادماً من منطقة التشبّع
mcRsi = ta.rsi(close, mcRsiLen)
mcRsiMa = ta.sma(mcRsi, mcRsiMaLen)
mcRsiBuy = ta.crossover(mcRsi, mcRsiMa) and mcRsi[1] <= mcRsiOS
mcRsiSell = ta.crossunder(mcRsi, mcRsiMa) and mcRsi[1] >= mcRsiOB
mcRsiBuyOK = mcRsi > mcRsiMa
mcRsiSellOK = mcRsi < mcRsiMa

// MACD — تقاطع الخط مع خط الإشارة
[mcMacdLine, mcMacdSignal, mcMacdHist] = ta.macd(close, mcMacdFast, mcMacdSlow, mcMacdSig)
mcMacdBuy = ta.crossover(mcMacdLine, mcMacdSignal)
mcMacdSell = ta.crossunder(mcMacdLine, mcMacdSignal)
mcMacdBuyOK = mcMacdLine > mcMacdSignal
mcMacdSellOK = mcMacdLine < mcMacdSignal

// ADX / DMI — اتجاه مع قوة كافية
[mcPDI, mcMDI, mcADX] = ta.dmi(mcAdxLen, mcAdxSmooth)
mcAdxBuy = ta.crossover(mcPDI, mcMDI) and mcADX >= mcAdxMin
mcAdxSell = ta.crossunder(mcMDI, mcPDI) == false and ta.crossunder(mcPDI, mcMDI) and mcADX >= mcAdxMin
mcAdxBuyOK = mcPDI > mcMDI and mcADX >= mcAdxMin
mcAdxSellOK = mcMDI > mcPDI and mcADX >= mcAdxMin

// Bollinger — ارتداد من الحافة إلى الداخل
mcBbBasis = ta.sma(close, mcBbLen)
mcBbDev = mcBbMult * ta.stdev(close, mcBbLen)
mcBbUpper = mcBbBasis + mcBbDev
mcBbLower = mcBbBasis - mcBbDev
mcBbBuy = low <= mcBbLower and close > mcBbLower and close > open
mcBbSell = high >= mcBbUpper and close < mcBbUpper and close < open
mcBbBuyOK = close < mcBbBasis
mcBbSellOK = close > mcBbBasis

// Ichimoku — تقاطع التحويل والأساس مع موقع السعر من السحابة
mcDonchian(_len) =>
    (ta.lowest(_len) + ta.highest(_len)) / 2.0
mcConv = mcDonchian(mcIchiConv)
mcBase = mcDonchian(mcIchiBase)
mcSpanA = (mcConv + mcBase) / 2.0
mcSpanB = mcDonchian(mcIchiSpanB)
mcCloudTop = math.max(mcSpanA, mcSpanB)
mcCloudBot = math.min(mcSpanA, mcSpanB)
mcIchiBuy = ta.crossover(mcConv, mcBase) and close > mcCloudBot
mcIchiSell = ta.crossunder(mcConv, mcBase) and close < mcCloudTop
mcIchiBuyOK = close > mcCloudTop
mcIchiSellOK = close < mcCloudBot

// Parabolic SAR — مكتوب يدوياً لأن محرك الاختبار لا يوفّر ta.sar، وصيغته
// هي صيغة وايلدر نفسها فالنتيجة على TradingView واحدة. كُتب مسطّحاً بلا تفريعات
// متداخلة لأن محلّل المحرك يعلق عليها.
var float mcSarVal = na
var float mcSarEP = na
var float mcSarAF = na
var int mcSarDir = 0
mcSarSeed = na(mcSarVal)
mcSarUp = mcSarDir == 1
mcSarRaw = mcSarSeed ? na : mcSarVal + mcSarAF * (mcSarEP - mcSarVal)
mcSarClamped = mcSarSeed ? na : mcSarUp ? math.min(mcSarRaw, math.min(nz(low[1], low), nz(low[2], low))) : math.max(mcSarRaw, math.max(nz(high[1], high), nz(high[2], high)))
mcSarFlip = mcSarSeed ? false : mcSarUp ? low <= mcSarClamped : high >= mcSarClamped
mcSarNewDir = mcSarSeed ? (close >= open ? 1 : -1) : mcSarFlip ? -mcSarDir : mcSarDir
mcSarNewVal = mcSarSeed ? (mcSarNewDir == 1 ? low : high) : mcSarFlip ? mcSarEP : mcSarClamped
mcSarNewEP = mcSarSeed or mcSarFlip ? (mcSarNewDir == 1 ? high : low) : mcSarUp ? math.max(mcSarEP, high) : math.min(mcSarEP, low)
mcSarNewAF = mcSarSeed or mcSarFlip ? mcSarStart : mcSarNewEP != mcSarEP ? math.min(mcSarAF + mcSarInc, mcSarMax) : mcSarAF
mcSarDir := mcSarNewDir
mcSarVal := mcSarNewVal
mcSarEP := mcSarNewEP
mcSarAF := mcSarNewAF
mcSar = mcSarVal
mcSarBuy = mcSarFlip and mcSarDir == 1
mcSarSell = mcSarFlip and mcSarDir == -1
mcSarBuyOK = mcSarDir == 1
mcSarSellOK = mcSarDir == -1

// Pivot — استعادة آخر قاع مؤكَّد أو رفض آخر قمة مؤكَّدة
mcPh = ta.pivothigh(mcPivotLeft, mcPivotRight)
mcPl = ta.pivotlow(mcPivotLeft, mcPivotRight)
var float mcLastPh = na
var float mcLastPl = na
mcLastPh := na(mcPh) ? mcLastPh : mcPh
mcLastPl := na(mcPl) ? mcLastPl : mcPl
mcPivotBuy = not na(mcLastPl) and low <= mcLastPl and close > mcLastPl and close > open
mcPivotSell = not na(mcLastPh) and high >= mcLastPh and close < mcLastPh and close < open
mcPivotBuyOK = not na(mcLastPl) and close > mcLastPl
mcPivotSellOK = not na(mcLastPh) and close < mcLastPh

// Fibonacci — لمس أحد مستويات التصحيح ثم الإغلاق في الاتجاه
mcFibTop = ta.highest(high, mcFibLen)
mcFibBot = ta.lowest(low, mcFibLen)
mcFibRange = mcFibTop - mcFibBot
mcFibDownLeg = math.abs(ta.highestbars(mcFibLen)) < math.abs(ta.lowestbars(mcFibLen))
mcFibL1 = mcFibDownLeg ? mcFibTop - mcFibRange * mcFibA : mcFibBot + mcFibRange * mcFibA
mcFibL2 = mcFibDownLeg ? mcFibTop - mcFibRange * mcFibB : mcFibBot + mcFibRange * mcFibB
mcFibL3 = mcFibDownLeg ? mcFibTop - mcFibRange * mcFibC : mcFibBot + mcFibRange * mcFibC
mcFibTol = mcATR * mcFibTolATR
mcNearLevel(_p) =>
    math.min(math.min(math.abs(_p - mcFibL1), math.abs(_p - mcFibL2)), math.abs(_p - mcFibL3)) <= mcFibTol
mcFibBuy = mcFibRange > 0 and mcNearLevel(low) and close > open and close > math.min(math.min(mcFibL1, mcFibL2), mcFibL3)
mcFibSell = mcFibRange > 0 and mcNearLevel(high) and close < open and close < math.max(math.max(mcFibL1, mcFibL2), mcFibL3)
mcFibBuyOK = mcFibRange > 0 and close >= mcFibBot + mcFibRange * 0.236
mcFibSellOK = mcFibRange > 0 and close <= mcFibTop - mcFibRange * 0.236

// Moving average — عبور المتوسط أو الوقوف في جهته
mcMa = mcMaType == "EMA" ? ta.ema(close, mcMaLen) : ta.sma(close, mcMaLen)
mcMaBuy = ta.crossover(close, mcMa)
mcMaSell = ta.crossunder(close, mcMa)
mcMaBuyOK = close > mcMa
mcMaSellOK = close < mcMa

// ── تجميع المصادر والفلاتر ──────────────────────────────────────────────────
f_src(_mode, _sig) =>
    _mode == "Source" and _sig

f_flt(_mode, _ok) =>
    _mode != "Filter" or _ok

mcSourceBuy = f_src(mcRsiMode, mcRsiBuy) or f_src(mcMacdMode, mcMacdBuy) or
 f_src(mcAdxMode, mcAdxBuy) or f_src(mcBbMode, mcBbBuy) or f_src(mcIchiMode, mcIchiBuy) or
 f_src(mcSarMode, mcSarBuy) or f_src(mcPivotMode, mcPivotBuy) or f_src(mcFibMode, mcFibBuy) or
 f_src(mcMaMode, mcMaBuy)

mcSourceSell = f_src(mcRsiMode, mcRsiSell) or f_src(mcMacdMode, mcMacdSell) or
 f_src(mcAdxMode, mcAdxSell) or f_src(mcBbMode, mcBbSell) or f_src(mcIchiMode, mcIchiSell) or
 f_src(mcSarMode, mcSarSell) or f_src(mcPivotMode, mcPivotSell) or f_src(mcFibMode, mcFibSell) or
 f_src(mcMaMode, mcMaSell)

mcFilterBuyOK = f_flt(mcRsiMode, mcRsiBuyOK) and f_flt(mcMacdMode, mcMacdBuyOK) and
 f_flt(mcAdxMode, mcAdxBuyOK) and f_flt(mcBbMode, mcBbBuyOK) and f_flt(mcIchiMode, mcIchiBuyOK) and
 f_flt(mcSarMode, mcSarBuyOK) and f_flt(mcPivotMode, mcPivotBuyOK) and f_flt(mcFibMode, mcFibBuyOK) and
 f_flt(mcMaMode, mcMaBuyOK)

mcFilterSellOK = f_flt(mcRsiMode, mcRsiSellOK) and f_flt(mcMacdMode, mcMacdSellOK) and
 f_flt(mcAdxMode, mcAdxSellOK) and f_flt(mcBbMode, mcBbSellOK) and f_flt(mcIchiMode, mcIchiSellOK) and
 f_flt(mcSarMode, mcSarSellOK) and f_flt(mcPivotMode, mcPivotSellOK) and f_flt(mcFibMode, mcFibSellOK) and
 f_flt(mcMaMode, mcMaSellOK)

mcActiveCount = (mcRsiMode != "Off" ? 1 : 0) + (mcMacdMode != "Off" ? 1 : 0) +
 (mcAdxMode != "Off" ? 1 : 0) + (mcBbMode != "Off" ? 1 : 0) + (mcIchiMode != "Off" ? 1 : 0) +
 (mcSarMode != "Off" ? 1 : 0) + (mcPivotMode != "Off" ? 1 : 0) + (mcFibMode != "Off" ? 1 : 0) +
 (mcMaMode != "Off" ? 1 : 0)
'''


def main():
    src = open('RMI.pine', encoding='utf-8').read()

    # ── مجموعة إعدادات جديدة، وإعادة ترقيم المجموعات التالية ────────────────
    src = src.replace('''G_RMI   = "01 ■ RMI"
G_ENTRY = "02 ■ RMI Reaction Entry"
G_RISK  = "03 ■ Trade / TP / SL"
G_EXEC  = "04 ■ Execution"
G_VIS   = "05 ■ Statistics / Visuals"
G_ALERT = "06 ■ Alerts / Bot"''', '''G_RMI   = "01 ■ RMI"
G_ENTRY = "02 ■ RMI Reaction Entry"
G_SRC   = "03 ■ Multicator Sources"
G_RISK  = "04 ■ Trade / TP / SL"
G_EXEC  = "05 ■ Execution"
G_VIS   = "06 ■ Statistics / Visuals"
G_ALERT = "07 ■ Alerts / Bot"''')
    for a, b in [('// 03 ■ Trade / TP / SL', '// 04 ■ Trade / TP / SL'),
                 ('// 04 ■ Execution', '// 05 ■ Execution'),
                 ('// 05 ■ Statistics / Visuals', '// 06 ■ Statistics / Visuals'),
                 ('// 06 ■ Alerts / Bot', '// 07 ■ Alerts / Bot')]:
        assert a in src, a
    src = src.replace('// 06 ■ Alerts / Bot', '// 07 ■ Alerts / Bot')
    src = src.replace('// 05 ■ Statistics / Visuals', '// 06 ■ Statistics / Visuals')
    src = src.replace('// 04 ■ Execution', '// 05 ■ Execution')
    src = src.replace('// 03 ■ Trade / TP / SL', '// 04 ■ Trade / TP / SL')

    anchor = '// ══════════════════════════════════════════════════════════════════\n// 04 ■ Trade / TP / SL'
    assert anchor in src
    src = src.replace(anchor, SRC_INPUTS.strip() + '\n\n' + anchor)

    anchor2 = '// ══════════════════════════════════════════════════════════════════\n// REACTION ENGINE'
    assert anchor2 in src
    src = src.replace(anchor2, SRC_CALC.strip() + '\n\n' + anchor2)

    # ── دمج المصادر في بوابة الدخول ─────────────────────────────────────────
    old = '''rawBuyEntry = enableRMIEntries and enableBuy and buyArmed and buyReactionCount >= reactionBars and buyOptionalOK and buySignalCrossOK
rawSellEntry = enableRMIEntries and enableSell and sellArmed and sellReactionCount >= reactionBars and sellOptionalOK and sellSignalCrossOK'''
    assert old in src
    new = '''rmiRawBuy = enableRMIEntries and enableBuy and buyArmed and buyReactionCount >= reactionBars and buyOptionalOK and buySignalCrossOK
rmiRawSell = enableRMIEntries and enableSell and sellArmed and sellReactionCount >= reactionBars and sellOptionalOK and sellSignalCrossOK

// المصادر تُجمع بـ OR، والفلاتر تُطبَّق على النتيجة. كل المصادر مطفأة افتراضياً،
// فتؤول المعادلة إلى إشارة RMI وحدها وتبقى مطابقة لخط الأساس.
rawBuyEntry = (rmiRawBuy or (enableBuy and mcSourceBuy)) and mcFilterBuyOK
rawSellEntry = (rmiRawSell or (enableSell and mcSourceSell)) and mcFilterSellOK'''
    src = src.replace(old, new)

    # ── نزع التسليح يتبع RMI وحده، لا الإشارة المجمّعة ──────────────────────
    old_dis = '''// A completed RMI setup is consumed immediately. It is never queued behind
// an already open trade.
if rawBuyEntry or rawSellEntry'''
    assert old_dis in src
    src = src.replace(old_dis, '''// A completed RMI setup is consumed immediately. It is never queued behind
// an already open trade. Only the RMI setup disarms the RMI engine — a
// Multicator source firing must not consume an RMI setup that is still valid.
if rmiRawBuy or rmiRawSell''')

    # ── صف في الجدول يبيّن عدد المصادر المفعّلة ─────────────────────────────
    src = src.replace(
        '''table.cell(t, 1, 11, "RMI REACTION HARD", text_color=BUY_C, bgcolor=TBL_BG_ROW, text_size=size.small)''',
        '''table.cell(t, 1, 11, mcActiveCount == 0 ? "RMI ONLY" : "RMI + " + str.tostring(mcActiveCount) + " MC", text_color=mcActiveCount == 0 ? BUY_C : EN_C, bgcolor=TBL_BG_ROW, text_size=size.small)''')

    src = src.replace('indicator("RMI TRADE ENGINE + SYR30 TABLE", shorttitle="RMI TRADER"',
                      'indicator("RMI + MULTICATOR SOURCES", shorttitle="RMI MC"')

    open('RMI_V2.pine', 'w', encoding='utf-8').write(src)
    print(f"كُتب RMI_V2.pine — {len(src.splitlines())} سطر • {src.count('input.')} إعداد")


if __name__ == '__main__':
    main()
