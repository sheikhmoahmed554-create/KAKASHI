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

mcBrtMode = input.string("Off", "Breakout & Retest", options=["Off", "Source", "Filter"], group=G_SRC)
mcBrtPeriod = input.int(7, "BRT Pivot Period", minval=1, group=G_SRC)
mcBrtConfirmDiv = input.int(2, "BRT Confirmation Divider", minval=1, maxval=10, group=G_SRC)
mcBrtAtrLen = input.int(40, "BRT ATR Length", minval=1, group=G_SRC)
mcBrtAtrMult = input.float(2.0, "BRT ATR Multiplier", minval=0.1, step=0.1, group=G_SRC)

mcSmbMode = input.string("Off", "Smart Money Breakout", options=["Off", "Source", "Filter"], group=G_SRC)
mcSmbSwing = input.int(25, "SMB Structure Horizon", minval=2, group=G_SRC)
mcSmbConfType = input.string("Candle Close", "SMB Break Confirmation", options=["Candle Close", "Wicks"], group=G_SRC)

mcSrMode = input.string("Off", "S/R Re-test Finder", options=["Off", "Source", "Filter"], group=G_SRC)
mcSrLeft = input.int(20, "S/R Left Bars", minval=1, group=G_SRC)
mcSrRight = input.int(20, "S/R Right Bars", minval=1, group=G_SRC)
mcSrMethod = input.string("Wick", "S/R Detection Method", options=["Wick", "Body"], group=G_SRC)
mcSrMaxAge = input.int(1000, "S/R Level Max Age", minval=50, group=G_SRC)

mcStrMode = input.string("Off", "Strong Reversal (Liquidity Sweep)", options=["Off", "Source", "Filter"], group=G_SRC)
mcStrPivLen = input.int(20, "Sweep Pivot Length", minval=3, maxval=100, group=G_SRC)
mcStrWick = input.float(20.0, "Min Reversal Wick %", minval=1.0, maxval=100.0, group=G_SRC)

mcMisMode = input.string("Off", "Multi-Indicator Confluence", options=["Off", "Source", "Filter"], group=G_SRC)
mcMisCombo = input.string("RSI & CCI", "Confluence Combination", options=["RSI & CCI", "RSI & Stoch", "CCI & Stoch", "All Three", "Any Two"], group=G_SRC)
mcMisRsiLen = input.int(14, "MIS RSI Length", minval=1, group=G_SRC)
mcMisCciLen = input.int(14, "MIS CCI Length", minval=1, group=G_SRC)
mcMisStochLen = input.int(14, "MIS Stochastic %K Length", minval=1, group=G_SRC)
mcMisStochSmooth = input.int(3, "MIS Stochastic Smoothing", minval=1, group=G_SRC)
mcMisRsiOS = input.int(30, "MIS RSI Oversold", minval=10, maxval=50, group=G_SRC)
mcMisRsiOB = input.int(70, "MIS RSI Overbought", minval=50, maxval=90, group=G_SRC)
mcMisCciOS = input.int(-100, "MIS CCI Oversold", minval=-150, maxval=-50, group=G_SRC)
mcMisCciOB = input.int(100, "MIS CCI Overbought", minval=50, maxval=150, group=G_SRC)
mcMisStochOS = input.int(20, "MIS Stochastic Oversold", minval=10, maxval=40, group=G_SRC)
mcMisStochOB = input.int(80, "MIS Stochastic Overbought", minval=60, maxval=90, group=G_SRC)

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

// Breakout & Retest — قمة محورية تتشكّل قرب قاعٍ سبق كسره تعني بيعاً، والعكس شراء.
// الأصل يحفظ آخر ثلاث نقاط محورية في قائمة؛ القوائم غير متاحة في محرك الاختبار
// فكُتبت الفتحات الثلاث صراحةً، والسلوك واحد.
mcBrtConfirm = math.max(1, mcBrtPeriod / mcBrtConfirmDiv)
mcBrtTol = ta.atr(mcBrtAtrLen) * mcBrtAtrMult
mcBrtPh = ta.pivothigh(high, mcBrtPeriod, mcBrtConfirm)
mcBrtPl = ta.pivotlow(low, mcBrtPeriod, mcBrtConfirm)

var float mcBrtH0 = na
var float mcBrtH1 = na
var float mcBrtH2 = na
var float mcBrtL0 = na
var float mcBrtL1 = na
var float mcBrtL2 = na

// المسافة إلى كل فتحة، وna تعني فتحة فارغة تُستبعد
mcBrtDL0 = na(mcBrtL0) or na(mcBrtPh) ? 1e18 : math.abs(mcBrtL0 - mcBrtPh)
mcBrtDL1 = na(mcBrtL1) or na(mcBrtPh) ? 1e18 : math.abs(mcBrtL1 - mcBrtPh)
mcBrtDL2 = na(mcBrtL2) or na(mcBrtPh) ? 1e18 : math.abs(mcBrtL2 - mcBrtPh)
mcBrtMinL = math.min(mcBrtDL0, math.min(mcBrtDL1, mcBrtDL2))
mcBrtPickL = mcBrtDL0 <= mcBrtMinL ? mcBrtL0 : mcBrtDL1 <= mcBrtMinL ? mcBrtL1 : mcBrtL2

mcBrtDH0 = na(mcBrtH0) or na(mcBrtPl) ? 1e18 : math.abs(mcBrtH0 - mcBrtPl)
mcBrtDH1 = na(mcBrtH1) or na(mcBrtPl) ? 1e18 : math.abs(mcBrtH1 - mcBrtPl)
mcBrtDH2 = na(mcBrtH2) or na(mcBrtPl) ? 1e18 : math.abs(mcBrtH2 - mcBrtPl)
mcBrtMinH = math.min(mcBrtDH0, math.min(mcBrtDH1, mcBrtDH2))
mcBrtPickH = mcBrtDH0 <= mcBrtMinH ? mcBrtH0 : mcBrtDH1 <= mcBrtMinH ? mcBrtH1 : mcBrtH2

// الإشارة: المستوى قريب ضمن التسامح، وقد كُسر فعلاً عند شمعة النقطة المحورية
mcBrtSell = not na(mcBrtPh) and mcBrtMinL < mcBrtTol and low[mcBrtConfirm] < mcBrtPickL
mcBrtBuy = not na(mcBrtPl) and mcBrtMinH < mcBrtTol and high[mcBrtConfirm] > mcBrtPickH

// الأصل يستهلك أقرب نقطة عند كل تشكّل، سواء أطلقت إشارة أم لا
mcBrtDropL0 = not na(mcBrtPh) and mcBrtDL0 <= mcBrtMinL
mcBrtDropL1 = not na(mcBrtPh) and not mcBrtDropL0 and mcBrtDL1 <= mcBrtMinL
mcBrtDropL2 = not na(mcBrtPh) and not mcBrtDropL0 and not mcBrtDropL1
mcBrtL0 := mcBrtDropL0 ? mcBrtL1 : mcBrtL0
mcBrtL1 := mcBrtDropL0 ? mcBrtL2 : mcBrtDropL1 ? mcBrtL2 : mcBrtL1
mcBrtL2 := not na(mcBrtPh) ? na : mcBrtL2

mcBrtDropH0 = not na(mcBrtPl) and mcBrtDH0 <= mcBrtMinH
mcBrtDropH1 = not na(mcBrtPl) and not mcBrtDropH0 and mcBrtDH1 <= mcBrtMinH
mcBrtDropH2 = not na(mcBrtPl) and not mcBrtDropH0 and not mcBrtDropH1
mcBrtH0 := mcBrtDropH0 ? mcBrtH1 : mcBrtH0
mcBrtH1 := mcBrtDropH0 ? mcBrtH2 : mcBrtDropH1 ? mcBrtH2 : mcBrtH1
mcBrtH2 := not na(mcBrtPl) ? na : mcBrtH2

// ثم تُدفع النقطة الجديدة إلى مقدمة الذاكرة
mcBrtH2 := not na(mcBrtPh) ? mcBrtH1 : mcBrtH2
mcBrtH1 := not na(mcBrtPh) ? mcBrtH0 : mcBrtH1
mcBrtH0 := not na(mcBrtPh) ? mcBrtPh : mcBrtH0
mcBrtL2 := not na(mcBrtPl) ? mcBrtL1 : mcBrtL2
mcBrtL1 := not na(mcBrtPl) ? mcBrtL0 : mcBrtL1
mcBrtL0 := not na(mcBrtPl) ? mcBrtPl : mcBrtL0

mcBrtBuyOK = not na(mcBrtL0) and close > mcBrtL0
mcBrtSellOK = not na(mcBrtH0) and close < mcBrtH0

// Smart Money Breakout — كسر آخر قمة أو قاع هيكلي لم يُكسر بعد.
// النقطة المحورية تُؤكَّد بعد swingSize شمعة، فقد يكون السعر تجاوزها فعلاً لحظة
// التأكيد؛ هذا سلوك الأصل نفسه ولا نظرة أمامية فيه.
mcSmbPivHi = ta.pivothigh(high, mcSmbSwing, mcSmbSwing)
mcSmbPivLo = ta.pivotlow(low, mcSmbSwing, mcSmbSwing)
var float mcSmbPrevHigh = na
var float mcSmbPrevLow = na
var bool mcSmbHighActive = false
var bool mcSmbLowActive = false

mcSmbPrevHigh := na(mcSmbPivHi) ? mcSmbPrevHigh : mcSmbPivHi
mcSmbHighActive := na(mcSmbPivHi) ? mcSmbHighActive : true
mcSmbPrevLow := na(mcSmbPivLo) ? mcSmbPrevLow : mcSmbPivLo
mcSmbLowActive := na(mcSmbPivLo) ? mcSmbLowActive : true

mcSmbHighSrc = mcSmbConfType == "Candle Close" ? close : high
mcSmbLowSrc = mcSmbConfType == "Candle Close" ? close : low
mcSmbBuy = not na(mcSmbPrevHigh) and mcSmbHighActive and mcSmbHighSrc > mcSmbPrevHigh
mcSmbSell = not na(mcSmbPrevLow) and mcSmbLowActive and mcSmbLowSrc < mcSmbPrevLow
mcSmbHighActive := mcSmbBuy ? false : mcSmbHighActive
mcSmbLowActive := mcSmbSell ? false : mcSmbLowActive

// كفلتر: السعر فوق آخر قاع هيكلي للشراء، وتحت آخر قمة للبيع
mcSmbBuyOK = not na(mcSmbPrevLow) and close > mcSmbPrevLow
mcSmbSellOK = not na(mcSmbPrevHigh) and close < mcSmbPrevHigh

// S/R Re-test Finder — مقاومة تُكسر فتصير دعماً، فإذا عاد السعر ولمسها
// بشمعة صاعدة فتلك إشارة شراء. والعكس بيع.
// الأصل يحفظ المستويات المعلّقة في قوائم ديناميكية؛ القوائم غير متاحة في محرك
// الاختبار فتُكتب ثماني فتحات لكل طور ولكل جهة، وتسقط الأقدم عند الامتلاء.
// هذا تقريب للأصل: مستوى تاسع معلّق في الوقت نفسه يضيع.

mcSrSrcHi = mcSrMethod == "Wick" ? high : close > open ? close : open
mcSrSrcLo = mcSrMethod == "Wick" ? low : close < open ? close : open
mcSrPh = ta.pivothigh(mcSrSrcHi, mcSrLeft, mcSrRight)
mcSrPl = ta.pivotlow(mcSrSrcLo, mcSrLeft, mcSrRight)
mcSrNewHi = not na(mcSrPh)
mcSrNewLo = not na(mcSrPl)

var float mcSrF1HP0 = na
var int mcSrF1HB0 = na
var float mcSrF1HP1 = na
var int mcSrF1HB1 = na
var float mcSrF1HP2 = na
var int mcSrF1HB2 = na
var float mcSrF1HP3 = na
var int mcSrF1HB3 = na
var float mcSrF1HP4 = na
var int mcSrF1HB4 = na
var float mcSrF1HP5 = na
var int mcSrF1HB5 = na
var float mcSrF1HP6 = na
var int mcSrF1HB6 = na
var float mcSrF1HP7 = na
var int mcSrF1HB7 = na

var float mcSrF2HP0 = na
var int mcSrF2HB0 = na
var float mcSrF2HP1 = na
var int mcSrF2HB1 = na
var float mcSrF2HP2 = na
var int mcSrF2HB2 = na
var float mcSrF2HP3 = na
var int mcSrF2HB3 = na
var float mcSrF2HP4 = na
var int mcSrF2HB4 = na
var float mcSrF2HP5 = na
var int mcSrF2HB5 = na
var float mcSrF2HP6 = na
var int mcSrF2HB6 = na
var float mcSrF2HP7 = na
var int mcSrF2HB7 = na

var float mcSrF1LP0 = na
var int mcSrF1LB0 = na
var float mcSrF1LP1 = na
var int mcSrF1LB1 = na
var float mcSrF1LP2 = na
var int mcSrF1LB2 = na
var float mcSrF1LP3 = na
var int mcSrF1LB3 = na
var float mcSrF1LP4 = na
var int mcSrF1LB4 = na
var float mcSrF1LP5 = na
var int mcSrF1LB5 = na
var float mcSrF1LP6 = na
var int mcSrF1LB6 = na
var float mcSrF1LP7 = na
var int mcSrF1LB7 = na

var float mcSrF2LP0 = na
var int mcSrF2LB0 = na
var float mcSrF2LP1 = na
var int mcSrF2LB1 = na
var float mcSrF2LP2 = na
var int mcSrF2LB2 = na
var float mcSrF2LP3 = na
var int mcSrF2LB3 = na
var float mcSrF2LP4 = na
var int mcSrF2LB4 = na
var float mcSrF2LP5 = na
var int mcSrF2LB5 = na
var float mcSrF2LP6 = na
var int mcSrF2LB6 = na
var float mcSrF2LP7 = na
var int mcSrF2LB7 = na

mcSrD2H0 = not na(mcSrF2HP0) and (low <= mcSrF2HP0 and close > mcSrF2HP0 and close > open or close < mcSrF2HP0 or bar_index - mcSrF2HB0 > mcSrMaxAge)
mcSrD2H1 = not na(mcSrF2HP1) and (low <= mcSrF2HP1 and close > mcSrF2HP1 and close > open or close < mcSrF2HP1 or bar_index - mcSrF2HB1 > mcSrMaxAge)
mcSrD2H2 = not na(mcSrF2HP2) and (low <= mcSrF2HP2 and close > mcSrF2HP2 and close > open or close < mcSrF2HP2 or bar_index - mcSrF2HB2 > mcSrMaxAge)
mcSrD2H3 = not na(mcSrF2HP3) and (low <= mcSrF2HP3 and close > mcSrF2HP3 and close > open or close < mcSrF2HP3 or bar_index - mcSrF2HB3 > mcSrMaxAge)
mcSrD2H4 = not na(mcSrF2HP4) and (low <= mcSrF2HP4 and close > mcSrF2HP4 and close > open or close < mcSrF2HP4 or bar_index - mcSrF2HB4 > mcSrMaxAge)
mcSrD2H5 = not na(mcSrF2HP5) and (low <= mcSrF2HP5 and close > mcSrF2HP5 and close > open or close < mcSrF2HP5 or bar_index - mcSrF2HB5 > mcSrMaxAge)
mcSrD2H6 = not na(mcSrF2HP6) and (low <= mcSrF2HP6 and close > mcSrF2HP6 and close > open or close < mcSrF2HP6 or bar_index - mcSrF2HB6 > mcSrMaxAge)
mcSrD2H7 = not na(mcSrF2HP7) and (low <= mcSrF2HP7 and close > mcSrF2HP7 and close > open or close < mcSrF2HP7 or bar_index - mcSrF2HB7 > mcSrMaxAge)

mcSrBuy = (not na(mcSrF2HP0) and low <= mcSrF2HP0 and close > mcSrF2HP0 and close > open) or (not na(mcSrF2HP1) and low <= mcSrF2HP1 and close > mcSrF2HP1 and close > open) or (not na(mcSrF2HP2) and low <= mcSrF2HP2 and close > mcSrF2HP2 and close > open) or (not na(mcSrF2HP3) and low <= mcSrF2HP3 and close > mcSrF2HP3 and close > open) or (not na(mcSrF2HP4) and low <= mcSrF2HP4 and close > mcSrF2HP4 and close > open) or (not na(mcSrF2HP5) and low <= mcSrF2HP5 and close > mcSrF2HP5 and close > open) or (not na(mcSrF2HP6) and low <= mcSrF2HP6 and close > mcSrF2HP6 and close > open) or (not na(mcSrF2HP7) and low <= mcSrF2HP7 and close > mcSrF2HP7 and close > open)

mcSrD2L0 = not na(mcSrF2LP0) and (high >= mcSrF2LP0 and close < mcSrF2LP0 and close < open or close > mcSrF2LP0 or bar_index - mcSrF2LB0 > mcSrMaxAge)
mcSrD2L1 = not na(mcSrF2LP1) and (high >= mcSrF2LP1 and close < mcSrF2LP1 and close < open or close > mcSrF2LP1 or bar_index - mcSrF2LB1 > mcSrMaxAge)
mcSrD2L2 = not na(mcSrF2LP2) and (high >= mcSrF2LP2 and close < mcSrF2LP2 and close < open or close > mcSrF2LP2 or bar_index - mcSrF2LB2 > mcSrMaxAge)
mcSrD2L3 = not na(mcSrF2LP3) and (high >= mcSrF2LP3 and close < mcSrF2LP3 and close < open or close > mcSrF2LP3 or bar_index - mcSrF2LB3 > mcSrMaxAge)
mcSrD2L4 = not na(mcSrF2LP4) and (high >= mcSrF2LP4 and close < mcSrF2LP4 and close < open or close > mcSrF2LP4 or bar_index - mcSrF2LB4 > mcSrMaxAge)
mcSrD2L5 = not na(mcSrF2LP5) and (high >= mcSrF2LP5 and close < mcSrF2LP5 and close < open or close > mcSrF2LP5 or bar_index - mcSrF2LB5 > mcSrMaxAge)
mcSrD2L6 = not na(mcSrF2LP6) and (high >= mcSrF2LP6 and close < mcSrF2LP6 and close < open or close > mcSrF2LP6 or bar_index - mcSrF2LB6 > mcSrMaxAge)
mcSrD2L7 = not na(mcSrF2LP7) and (high >= mcSrF2LP7 and close < mcSrF2LP7 and close < open or close > mcSrF2LP7 or bar_index - mcSrF2LB7 > mcSrMaxAge)

mcSrSell = (not na(mcSrF2LP0) and high >= mcSrF2LP0 and close < mcSrF2LP0 and close < open) or (not na(mcSrF2LP1) and high >= mcSrF2LP1 and close < mcSrF2LP1 and close < open) or (not na(mcSrF2LP2) and high >= mcSrF2LP2 and close < mcSrF2LP2 and close < open) or (not na(mcSrF2LP3) and high >= mcSrF2LP3 and close < mcSrF2LP3 and close < open) or (not na(mcSrF2LP4) and high >= mcSrF2LP4 and close < mcSrF2LP4 and close < open) or (not na(mcSrF2LP5) and high >= mcSrF2LP5 and close < mcSrF2LP5 and close < open) or (not na(mcSrF2LP6) and high >= mcSrF2LP6 and close < mcSrF2LP6 and close < open) or (not na(mcSrF2LP7) and high >= mcSrF2LP7 and close < mcSrF2LP7 and close < open)

mcSrUp0 = not na(mcSrF1HP0) and low > mcSrF1HP0
mcSrDn0 = not na(mcSrF1LP0) and high < mcSrF1LP0
mcSrUp1 = not na(mcSrF1HP1) and low > mcSrF1HP1
mcSrDn1 = not na(mcSrF1LP1) and high < mcSrF1LP1
mcSrUp2 = not na(mcSrF1HP2) and low > mcSrF1HP2
mcSrDn2 = not na(mcSrF1LP2) and high < mcSrF1LP2
mcSrUp3 = not na(mcSrF1HP3) and low > mcSrF1HP3
mcSrDn3 = not na(mcSrF1LP3) and high < mcSrF1LP3
mcSrUp4 = not na(mcSrF1HP4) and low > mcSrF1HP4
mcSrDn4 = not na(mcSrF1LP4) and high < mcSrF1LP4
mcSrUp5 = not na(mcSrF1HP5) and low > mcSrF1HP5
mcSrDn5 = not na(mcSrF1LP5) and high < mcSrF1LP5
mcSrUp6 = not na(mcSrF1HP6) and low > mcSrF1HP6
mcSrDn6 = not na(mcSrF1LP6) and high < mcSrF1LP6
mcSrUp7 = not na(mcSrF1HP7) and low > mcSrF1HP7
mcSrDn7 = not na(mcSrF1LP7) and high < mcSrF1LP7

mcSrPromoH = mcSrUp0 or mcSrUp1 or mcSrUp2 or mcSrUp3 or mcSrUp4 or mcSrUp5 or mcSrUp6 or mcSrUp7

mcSrPromoHP = mcSrUp0 ? mcSrF1HP0 : mcSrUp1 ? mcSrF1HP1 : mcSrUp2 ? mcSrF1HP2 : mcSrUp3 ? mcSrF1HP3 : mcSrUp4 ? mcSrF1HP4 : mcSrUp5 ? mcSrF1HP5 : mcSrUp6 ? mcSrF1HP6 : mcSrUp7 ? mcSrF1HP7 : na

mcSrPromoHB = mcSrUp0 ? mcSrF1HB0 : mcSrUp1 ? mcSrF1HB1 : mcSrUp2 ? mcSrF1HB2 : mcSrUp3 ? mcSrF1HB3 : mcSrUp4 ? mcSrF1HB4 : mcSrUp5 ? mcSrF1HB5 : mcSrUp6 ? mcSrF1HB6 : mcSrUp7 ? mcSrF1HB7 : na

mcSrPromoL = mcSrDn0 or mcSrDn1 or mcSrDn2 or mcSrDn3 or mcSrDn4 or mcSrDn5 or mcSrDn6 or mcSrDn7

mcSrPromoLP = mcSrDn0 ? mcSrF1LP0 : mcSrDn1 ? mcSrF1LP1 : mcSrDn2 ? mcSrF1LP2 : mcSrDn3 ? mcSrF1LP3 : mcSrDn4 ? mcSrF1LP4 : mcSrDn5 ? mcSrF1LP5 : mcSrDn6 ? mcSrF1LP6 : mcSrDn7 ? mcSrF1LP7 : na

mcSrPromoLB = mcSrDn0 ? mcSrF1LB0 : mcSrDn1 ? mcSrF1LB1 : mcSrDn2 ? mcSrF1LB2 : mcSrDn3 ? mcSrF1LB3 : mcSrDn4 ? mcSrF1LB4 : mcSrDn5 ? mcSrF1LB5 : mcSrDn6 ? mcSrF1LB6 : mcSrDn7 ? mcSrF1LB7 : na

mcSrF1HP0 := mcSrUp0 or (not na(mcSrF1HB0) and bar_index - mcSrF1HB0 > mcSrMaxAge) ? na : mcSrF1HP0

mcSrF1LP0 := mcSrDn0 or (not na(mcSrF1LB0) and bar_index - mcSrF1LB0 > mcSrMaxAge) ? na : mcSrF1LP0

mcSrF2HP0 := mcSrD2H0 ? na : mcSrF2HP0

mcSrF2LP0 := mcSrD2L0 ? na : mcSrF2LP0

mcSrF1HP1 := mcSrUp1 or (not na(mcSrF1HB1) and bar_index - mcSrF1HB1 > mcSrMaxAge) ? na : mcSrF1HP1

mcSrF1LP1 := mcSrDn1 or (not na(mcSrF1LB1) and bar_index - mcSrF1LB1 > mcSrMaxAge) ? na : mcSrF1LP1

mcSrF2HP1 := mcSrD2H1 ? na : mcSrF2HP1

mcSrF2LP1 := mcSrD2L1 ? na : mcSrF2LP1

mcSrF1HP2 := mcSrUp2 or (not na(mcSrF1HB2) and bar_index - mcSrF1HB2 > mcSrMaxAge) ? na : mcSrF1HP2

mcSrF1LP2 := mcSrDn2 or (not na(mcSrF1LB2) and bar_index - mcSrF1LB2 > mcSrMaxAge) ? na : mcSrF1LP2

mcSrF2HP2 := mcSrD2H2 ? na : mcSrF2HP2

mcSrF2LP2 := mcSrD2L2 ? na : mcSrF2LP2

mcSrF1HP3 := mcSrUp3 or (not na(mcSrF1HB3) and bar_index - mcSrF1HB3 > mcSrMaxAge) ? na : mcSrF1HP3

mcSrF1LP3 := mcSrDn3 or (not na(mcSrF1LB3) and bar_index - mcSrF1LB3 > mcSrMaxAge) ? na : mcSrF1LP3

mcSrF2HP3 := mcSrD2H3 ? na : mcSrF2HP3

mcSrF2LP3 := mcSrD2L3 ? na : mcSrF2LP3

mcSrF1HP4 := mcSrUp4 or (not na(mcSrF1HB4) and bar_index - mcSrF1HB4 > mcSrMaxAge) ? na : mcSrF1HP4

mcSrF1LP4 := mcSrDn4 or (not na(mcSrF1LB4) and bar_index - mcSrF1LB4 > mcSrMaxAge) ? na : mcSrF1LP4

mcSrF2HP4 := mcSrD2H4 ? na : mcSrF2HP4

mcSrF2LP4 := mcSrD2L4 ? na : mcSrF2LP4

mcSrF1HP5 := mcSrUp5 or (not na(mcSrF1HB5) and bar_index - mcSrF1HB5 > mcSrMaxAge) ? na : mcSrF1HP5

mcSrF1LP5 := mcSrDn5 or (not na(mcSrF1LB5) and bar_index - mcSrF1LB5 > mcSrMaxAge) ? na : mcSrF1LP5

mcSrF2HP5 := mcSrD2H5 ? na : mcSrF2HP5

mcSrF2LP5 := mcSrD2L5 ? na : mcSrF2LP5

mcSrF1HP6 := mcSrUp6 or (not na(mcSrF1HB6) and bar_index - mcSrF1HB6 > mcSrMaxAge) ? na : mcSrF1HP6

mcSrF1LP6 := mcSrDn6 or (not na(mcSrF1LB6) and bar_index - mcSrF1LB6 > mcSrMaxAge) ? na : mcSrF1LP6

mcSrF2HP6 := mcSrD2H6 ? na : mcSrF2HP6

mcSrF2LP6 := mcSrD2L6 ? na : mcSrF2LP6

mcSrF1HP7 := mcSrUp7 or (not na(mcSrF1HB7) and bar_index - mcSrF1HB7 > mcSrMaxAge) ? na : mcSrF1HP7

mcSrF1LP7 := mcSrDn7 or (not na(mcSrF1LB7) and bar_index - mcSrF1LB7 > mcSrMaxAge) ? na : mcSrF1LP7

mcSrF2HP7 := mcSrD2H7 ? na : mcSrF2HP7

mcSrF2LP7 := mcSrD2L7 ? na : mcSrF2LP7

mcSrF2HP7 := mcSrPromoH ? mcSrF2HP6 : mcSrF2HP7
mcSrF2HB7 := mcSrPromoH ? mcSrF2HB6 : mcSrF2HB7
mcSrF2HP6 := mcSrPromoH ? mcSrF2HP5 : mcSrF2HP6
mcSrF2HB6 := mcSrPromoH ? mcSrF2HB5 : mcSrF2HB6
mcSrF2HP5 := mcSrPromoH ? mcSrF2HP4 : mcSrF2HP5
mcSrF2HB5 := mcSrPromoH ? mcSrF2HB4 : mcSrF2HB5
mcSrF2HP4 := mcSrPromoH ? mcSrF2HP3 : mcSrF2HP4
mcSrF2HB4 := mcSrPromoH ? mcSrF2HB3 : mcSrF2HB4
mcSrF2HP3 := mcSrPromoH ? mcSrF2HP2 : mcSrF2HP3
mcSrF2HB3 := mcSrPromoH ? mcSrF2HB2 : mcSrF2HB3
mcSrF2HP2 := mcSrPromoH ? mcSrF2HP1 : mcSrF2HP2
mcSrF2HB2 := mcSrPromoH ? mcSrF2HB1 : mcSrF2HB2
mcSrF2HP1 := mcSrPromoH ? mcSrF2HP0 : mcSrF2HP1
mcSrF2HB1 := mcSrPromoH ? mcSrF2HB0 : mcSrF2HB1
mcSrF2HP0 := mcSrPromoH ? mcSrPromoHP : mcSrF2HP0
mcSrF2HB0 := mcSrPromoH ? mcSrPromoHB : mcSrF2HB0

mcSrF2LP7 := mcSrPromoL ? mcSrF2LP6 : mcSrF2LP7
mcSrF2LB7 := mcSrPromoL ? mcSrF2LB6 : mcSrF2LB7
mcSrF2LP6 := mcSrPromoL ? mcSrF2LP5 : mcSrF2LP6
mcSrF2LB6 := mcSrPromoL ? mcSrF2LB5 : mcSrF2LB6
mcSrF2LP5 := mcSrPromoL ? mcSrF2LP4 : mcSrF2LP5
mcSrF2LB5 := mcSrPromoL ? mcSrF2LB4 : mcSrF2LB5
mcSrF2LP4 := mcSrPromoL ? mcSrF2LP3 : mcSrF2LP4
mcSrF2LB4 := mcSrPromoL ? mcSrF2LB3 : mcSrF2LB4
mcSrF2LP3 := mcSrPromoL ? mcSrF2LP2 : mcSrF2LP3
mcSrF2LB3 := mcSrPromoL ? mcSrF2LB2 : mcSrF2LB3
mcSrF2LP2 := mcSrPromoL ? mcSrF2LP1 : mcSrF2LP2
mcSrF2LB2 := mcSrPromoL ? mcSrF2LB1 : mcSrF2LB2
mcSrF2LP1 := mcSrPromoL ? mcSrF2LP0 : mcSrF2LP1
mcSrF2LB1 := mcSrPromoL ? mcSrF2LB0 : mcSrF2LB1
mcSrF2LP0 := mcSrPromoL ? mcSrPromoLP : mcSrF2LP0
mcSrF2LB0 := mcSrPromoL ? mcSrPromoLB : mcSrF2LB0

mcSrF1HP7 := mcSrNewHi ? mcSrF1HP6 : mcSrF1HP7
mcSrF1HB7 := mcSrNewHi ? mcSrF1HB6 : mcSrF1HB7
mcSrF1HP6 := mcSrNewHi ? mcSrF1HP5 : mcSrF1HP6
mcSrF1HB6 := mcSrNewHi ? mcSrF1HB5 : mcSrF1HB6
mcSrF1HP5 := mcSrNewHi ? mcSrF1HP4 : mcSrF1HP5
mcSrF1HB5 := mcSrNewHi ? mcSrF1HB4 : mcSrF1HB5
mcSrF1HP4 := mcSrNewHi ? mcSrF1HP3 : mcSrF1HP4
mcSrF1HB4 := mcSrNewHi ? mcSrF1HB3 : mcSrF1HB4
mcSrF1HP3 := mcSrNewHi ? mcSrF1HP2 : mcSrF1HP3
mcSrF1HB3 := mcSrNewHi ? mcSrF1HB2 : mcSrF1HB3
mcSrF1HP2 := mcSrNewHi ? mcSrF1HP1 : mcSrF1HP2
mcSrF1HB2 := mcSrNewHi ? mcSrF1HB1 : mcSrF1HB2
mcSrF1HP1 := mcSrNewHi ? mcSrF1HP0 : mcSrF1HP1
mcSrF1HB1 := mcSrNewHi ? mcSrF1HB0 : mcSrF1HB1
mcSrF1HP0 := mcSrNewHi ? mcSrPh : mcSrF1HP0
mcSrF1HB0 := mcSrNewHi ? bar_index - mcSrRight : mcSrF1HB0

mcSrF1LP7 := mcSrNewLo ? mcSrF1LP6 : mcSrF1LP7
mcSrF1LB7 := mcSrNewLo ? mcSrF1LB6 : mcSrF1LB7
mcSrF1LP6 := mcSrNewLo ? mcSrF1LP5 : mcSrF1LP6
mcSrF1LB6 := mcSrNewLo ? mcSrF1LB5 : mcSrF1LB6
mcSrF1LP5 := mcSrNewLo ? mcSrF1LP4 : mcSrF1LP5
mcSrF1LB5 := mcSrNewLo ? mcSrF1LB4 : mcSrF1LB5
mcSrF1LP4 := mcSrNewLo ? mcSrF1LP3 : mcSrF1LP4
mcSrF1LB4 := mcSrNewLo ? mcSrF1LB3 : mcSrF1LB4
mcSrF1LP3 := mcSrNewLo ? mcSrF1LP2 : mcSrF1LP3
mcSrF1LB3 := mcSrNewLo ? mcSrF1LB2 : mcSrF1LB3
mcSrF1LP2 := mcSrNewLo ? mcSrF1LP1 : mcSrF1LP2
mcSrF1LB2 := mcSrNewLo ? mcSrF1LB1 : mcSrF1LB2
mcSrF1LP1 := mcSrNewLo ? mcSrF1LP0 : mcSrF1LP1
mcSrF1LB1 := mcSrNewLo ? mcSrF1LB0 : mcSrF1LB1
mcSrF1LP0 := mcSrNewLo ? mcSrPl : mcSrF1LP0
mcSrF1LB0 := mcSrNewLo ? bar_index - mcSrRight : mcSrF1LB0

mcSrBuyOK = not na(mcSrF2HP0) and close > mcSrF2HP0
mcSrSellOK = not na(mcSrF2LP0) and close < mcSrF2LP0

// Strong Reversal — كنس سيولة فوق قمة أو تحت قاع بذيل رفض، ثم انتظار توقّف
// الطرف عن التمدد، وعندها الدخول عكس الكنس.
// وضع Macro Pivots فقط: أوضاع الجلسات والفريم الأعلى تحتاج time() وهي غير متاحة
// في محرك الاختبار. ونظام النجوم مؤجَّل لأن percentrank يحتاج حلقة مئة تكرار
// لكل شمعة، وهذا يخنق السرعة قبل أن نعرف إن كان الدخول يستحق أصلاً.
mcStrL = mcStrPivLen % 2 == 0 ? mcStrPivLen + 1 : mcStrPivLen
mcStrPv = int(mcStrL / 2)
mcStrPh = ta.pivothigh(high, mcStrPv, mcStrPv)
mcStrPl = ta.pivotlow(low, mcStrPv, mcStrPv)

mcStrRng = high - low == 0 ? syminfo.mintick : high - low
mcStrUpWick = (high - math.max(open, close)) / mcStrRng
mcStrDnWick = (math.min(open, close) - low) / mcStrRng

var float mcStrTop = na
var bool mcStrTopBrk = true
var float mcStrBtm = na
var bool mcStrBtmBrk = true
var int mcStrState = 0
var float mcStrExt = na

mcStrTop := na(mcStrPh) ? mcStrTop : mcStrPh
mcStrTopBrk := na(mcStrPh) ? mcStrTopBrk : false
mcStrBtm := na(mcStrPl) ? mcStrBtm : mcStrPl
mcStrBtmBrk := na(mcStrPl) ? mcStrBtmBrk : false

// الكنس: إغلاق فوق المستوى مع ذيل رفض بالحجم المطلوب
mcStrSweepUp = not mcStrTopBrk and not na(mcStrTop) and close > mcStrTop and mcStrUpWick * 100 >= mcStrWick
mcStrSweepDn = not mcStrBtmBrk and not na(mcStrBtm) and close < mcStrBtm and mcStrDnWick * 100 >= mcStrWick
mcStrTopBrk := mcStrSweepUp ? true : mcStrTopBrk
mcStrBtmBrk := mcStrSweepDn ? true : mcStrBtmBrk
mcStrState := mcStrSweepUp ? 1 : mcStrSweepDn ? -1 : mcStrState
mcStrExt := mcStrSweepUp ? high : mcStrSweepDn ? low : mcStrExt

// الطرف يتمدد ما دام يُسجَّل قمة أعلى (أو قاع أدنى)؛ أول شمعة تفشل تُطلق العكس
mcStrGoUp = mcStrState == 1 and high >= mcStrExt
mcStrGoDn = mcStrState == -1 and low <= mcStrExt
mcStrSell = mcStrState == 1 and not mcStrGoUp
mcStrBuy = mcStrState == -1 and not mcStrGoDn
mcStrExt := mcStrGoUp ? high : mcStrGoDn ? low : mcStrExt
mcStrState := mcStrSell or mcStrBuy ? 0 : mcStrState

// كفلتر: الشراء ممنوع بينما كنسٌ صاعد ما زال يتمدد، والعكس
mcStrBuyOK = mcStrState != 1
mcStrSellOK = mcStrState != -1

// Multi-Indicator Confluence — الأصل يشترط تقاطع مؤشرين أو ثلاثة في الشمعة نفسها.
// ta.stoch غير متاح في محرك الاختبار فكُتبت الصيغة صراحةً، وهي التعريف نفسه.
mcMisRsi = ta.rsi(close, mcMisRsiLen)
mcMisCci = ta.cci((high + low + close) / 3.0, mcMisCciLen)
mcMisHH = ta.highest(high, mcMisStochLen)
mcMisLL = ta.lowest(low, mcMisStochLen)
mcMisRawK = mcMisHH - mcMisLL == 0 ? 50.0 : 100.0 * (close - mcMisLL) / (mcMisHH - mcMisLL)
mcMisK = ta.sma(mcMisRawK, mcMisStochSmooth)

mcMisRsiB = ta.crossover(mcMisRsi, mcMisRsiOS)
mcMisRsiS = ta.crossunder(mcMisRsi, mcMisRsiOB)
mcMisCciB = ta.crossover(mcMisCci, mcMisCciOS)
mcMisCciS = ta.crossunder(mcMisCci, mcMisCciOB)
mcMisStoB = ta.crossover(mcMisK, mcMisStochOS)
mcMisStoS = ta.crossunder(mcMisK, mcMisStochOB)

mcMisBuyVotes = (mcMisRsiB ? 1 : 0) + (mcMisCciB ? 1 : 0) + (mcMisStoB ? 1 : 0)
mcMisSellVotes = (mcMisRsiS ? 1 : 0) + (mcMisCciS ? 1 : 0) + (mcMisStoS ? 1 : 0)

mcMisBuy = mcMisCombo == "RSI & CCI" ? (mcMisRsiB and mcMisCciB) :
 mcMisCombo == "RSI & Stoch" ? (mcMisRsiB and mcMisStoB) :
 mcMisCombo == "CCI & Stoch" ? (mcMisCciB and mcMisStoB) :
 mcMisCombo == "All Three" ? (mcMisRsiB and mcMisCciB and mcMisStoB) : mcMisBuyVotes >= 2

mcMisSell = mcMisCombo == "RSI & CCI" ? (mcMisRsiS and mcMisCciS) :
 mcMisCombo == "RSI & Stoch" ? (mcMisRsiS and mcMisStoS) :
 mcMisCombo == "CCI & Stoch" ? (mcMisCciS and mcMisStoS) :
 mcMisCombo == "All Three" ? (mcMisRsiS and mcMisCciS and mcMisStoS) : mcMisSellVotes >= 2

// كفلتر: لا يشترط تقاطعاً، بل أن تكون المؤشرات الثلاثة في النصف الموافق
mcMisBuyOK = mcMisRsi < 50.0 and mcMisCci < 0.0 and mcMisK < 50.0
mcMisSellOK = mcMisRsi > 50.0 and mcMisCci > 0.0 and mcMisK > 50.0

// ── تجميع المصادر والفلاتر ──────────────────────────────────────────────────
f_src(_mode, _sig) =>
    _mode == "Source" and _sig

f_flt(_mode, _ok) =>
    _mode != "Filter" or _ok

mcSourceBuy = f_src(mcRsiMode, mcRsiBuy) or f_src(mcMacdMode, mcMacdBuy) or
 f_src(mcAdxMode, mcAdxBuy) or f_src(mcBbMode, mcBbBuy) or f_src(mcIchiMode, mcIchiBuy) or
 f_src(mcSarMode, mcSarBuy) or f_src(mcPivotMode, mcPivotBuy) or f_src(mcFibMode, mcFibBuy) or
 f_src(mcMaMode, mcMaBuy) or f_src(mcBrtMode, mcBrtBuy) or f_src(mcSmbMode, mcSmbBuy) or f_src(mcSrMode, mcSrBuy) or f_src(mcStrMode, mcStrBuy) or f_src(mcMisMode, mcMisBuy)

mcSourceSell = f_src(mcRsiMode, mcRsiSell) or f_src(mcMacdMode, mcMacdSell) or
 f_src(mcAdxMode, mcAdxSell) or f_src(mcBbMode, mcBbSell) or f_src(mcIchiMode, mcIchiSell) or
 f_src(mcSarMode, mcSarSell) or f_src(mcPivotMode, mcPivotSell) or f_src(mcFibMode, mcFibSell) or
 f_src(mcMaMode, mcMaSell) or f_src(mcBrtMode, mcBrtSell) or f_src(mcSmbMode, mcSmbSell) or f_src(mcSrMode, mcSrSell) or f_src(mcStrMode, mcStrSell) or f_src(mcMisMode, mcMisSell)

mcFilterBuyOK = f_flt(mcRsiMode, mcRsiBuyOK) and f_flt(mcMacdMode, mcMacdBuyOK) and
 f_flt(mcAdxMode, mcAdxBuyOK) and f_flt(mcBbMode, mcBbBuyOK) and f_flt(mcIchiMode, mcIchiBuyOK) and
 f_flt(mcSarMode, mcSarBuyOK) and f_flt(mcPivotMode, mcPivotBuyOK) and f_flt(mcFibMode, mcFibBuyOK) and
 f_flt(mcMaMode, mcMaBuyOK) and f_flt(mcBrtMode, mcBrtBuyOK) and f_flt(mcSmbMode, mcSmbBuyOK) and f_flt(mcSrMode, mcSrBuyOK) and f_flt(mcStrMode, mcStrBuyOK) and f_flt(mcMisMode, mcMisBuyOK)

mcFilterSellOK = f_flt(mcRsiMode, mcRsiSellOK) and f_flt(mcMacdMode, mcMacdSellOK) and
 f_flt(mcAdxMode, mcAdxSellOK) and f_flt(mcBbMode, mcBbSellOK) and f_flt(mcIchiMode, mcIchiSellOK) and
 f_flt(mcSarMode, mcSarSellOK) and f_flt(mcPivotMode, mcPivotSellOK) and f_flt(mcFibMode, mcFibSellOK) and
 f_flt(mcMaMode, mcMaSellOK) and f_flt(mcBrtMode, mcBrtSellOK) and f_flt(mcSmbMode, mcSmbSellOK) and f_flt(mcSrMode, mcSrSellOK) and f_flt(mcStrMode, mcStrSellOK) and f_flt(mcMisMode, mcMisSellOK)

mcActiveCount = (mcRsiMode != "Off" ? 1 : 0) + (mcMacdMode != "Off" ? 1 : 0) +
 (mcAdxMode != "Off" ? 1 : 0) + (mcBbMode != "Off" ? 1 : 0) + (mcIchiMode != "Off" ? 1 : 0) +
 (mcSarMode != "Off" ? 1 : 0) + (mcPivotMode != "Off" ? 1 : 0) + (mcFibMode != "Off" ? 1 : 0) +
 (mcMaMode != "Off" ? 1 : 0) + (mcBrtMode != "Off" ? 1 : 0) + (mcSmbMode != "Off" ? 1 : 0) + (mcSrMode != "Off" ? 1 : 0) + (mcStrMode != "Off" ? 1 : 0) + (mcMisMode != "Off" ? 1 : 0)
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
