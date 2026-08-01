import re
p='build_v2.py'; s=open(p,encoding='utf-8').read()

IN = '''
mcMtxMode = input.string("Off", "Matrix Series", options=["Off", "Source", "Filter"], group=G_SRC)
mcMtxSmooth = input.int(5, "Matrix Smoother", minval=2, group=G_SRC)
mcMtxOB = input.int(200, "Matrix Overbought", group=G_SRC)
mcMtxOS = input.int(-200, "Matrix Oversold", group=G_SRC)

mcVfxMode = input.string("Off", "Williams Vix Fix", options=["Off", "Source", "Filter"], group=G_SRC)
mcVfxTrigger = input.string("Filtered", "Vix Fix Trigger", options=["Filtered", "Aggressive", "Either"], group=G_SRC)
mcVfxPd = input.int(22, "VF Lookback StdDev High", minval=1, group=G_SRC)
mcVfxBbl = input.int(20, "VF Bollinger Length", minval=1, group=G_SRC)
mcVfxMult = input.float(2.0, "VF Bollinger StdDev", minval=1.0, maxval=5.0, group=G_SRC)
mcVfxLb = input.int(50, "VF Percentile Lookback", minval=1, group=G_SRC)
mcVfxPh = input.float(0.85, "VF Highest Percentile", minval=0.05, maxval=1.0, group=G_SRC)
mcVfxLtLB = input.int(40, "VF Long-Term Lookback", minval=25, maxval=99, group=G_SRC)
mcVfxMtLB = input.int(14, "VF Medium-Term Lookback", minval=10, maxval=20, group=G_SRC)
mcVfxStr = input.int(3, "VF Price Action Strength", minval=1, maxval=9, group=G_SRC)

mcQqeMode = input.string("Off", "QQE Signals", options=["Off", "Source", "Filter"], group=G_SRC)
mcQqeRsiLen = input.int(14, "QQE RSI Length", minval=1, group=G_SRC)
mcQqeSf = input.int(5, "QQE RSI Smoothing", minval=1, group=G_SRC)
mcQqeFactor = input.float(4.238, "QQE Fast Factor", minval=1.0, step=0.001, group=G_SRC)

mcSqzMode = input.string("Off", "Squeeze Momentum", options=["Off", "Source", "Filter"], group=G_SRC)
mcSqzTrigger = input.string("Signal Cross", "Squeeze Trigger", options=["Signal Cross", "Squeeze Release"], group=G_SRC)
mcSqzMomLen = input.int(20, "Squeeze Momentum Length", minval=1, group=G_SRC)
mcSqzSigLen = input.int(5, "Squeeze Signal Length", minval=2, group=G_SRC)
mcSqzLen = input.int(20, "Squeeze KC/BB Length", minval=1, group=G_SRC)
mcSqzMultBB = input.float(2.0, "Squeeze BB Mult", minval=0.5, step=0.05, group=G_SRC)
mcSqzMultKC = input.float(1.3, "Squeeze KC Mult", minval=0.5, step=0.05, group=G_SRC)

mcKwMode = input.string("Off", "Keltner Wick Rejection", options=["Off", "Source", "Filter"], group=G_SRC)
mcKwBand = input.string("Full", "Keltner Band", options=["Full", "Half", "Baseline"], group=G_SRC)
mcKwEma = input.int(21, "KW Baseline EMA", minval=1, group=G_SRC)
mcKwAtr = input.int(21, "KW ATR Period", minval=1, group=G_SRC)
mcKwMult = input.float(2.618, "KW Multiplier", minval=0.1, step=0.1, group=G_SRC)
mcKwSmooth = input.int(3, "KW Band Smoothing", minval=1, group=G_SRC)
mcKwWickRatio = input.float(0.4, "KW Wick Ratio", minval=0.0, maxval=1.0, step=0.01, group=G_SRC)
mcKwUseSrsi = input.bool(true, "KW Use Stochastic RSI Filter", group=G_SRC)
mcKwRsiLen = input.int(14, "KW RSI Length", minval=1, group=G_SRC)
mcKwStochLen = input.int(8, "KW Stochastic Length", minval=1, group=G_SRC)
mcKwSmoothK = input.int(3, "KW %K Smoothing", minval=1, group=G_SRC)
'''

CALC = '''
// ── Matrix Series ───────────────────────────────────────────────────────────
// مذبذب زخم معيّر: انحراف السعر عن متوسطه مقسوماً على انحرافه المعياري ×200،
// ثم تنعيم مزدوج. الإشارة عبور حد التشبّع مع انعكاس الميل.
// ta.cross غير متاح فاستُبدل بالعبور الصريح، وهو التعريف نفسه.
mcMtxYs = (high + low + close * 2.0) / 4.0
mcMtxMa = ta.ema(mcMtxYs, mcMtxSmooth)
mcMtxSd = ta.stdev(mcMtxYs, mcMtxSmooth)
mcMtxRaw = mcMtxSd == 0.0 ? 0.0 : (mcMtxYs - mcMtxMa) * 200.0 / mcMtxSd
mcMtxUp = ta.ema(ta.ema(mcMtxRaw, mcMtxSmooth), mcMtxSmooth)
mcMtxDown = ta.ema(mcMtxUp, mcMtxSmooth)
mcMtxCrossOS = ta.crossover(mcMtxUp, mcMtxOS) or ta.crossunder(mcMtxUp, mcMtxOS)
mcMtxCrossOB = ta.crossover(mcMtxUp, mcMtxOB) or ta.crossunder(mcMtxUp, mcMtxOB)
mcMtxBuy = mcMtxCrossOS and nz(mcMtxUp[1], mcMtxUp) < mcMtxUp
mcMtxSell = mcMtxCrossOB and nz(mcMtxUp[1], mcMtxUp) > mcMtxUp
mcMtxBuyOK = mcMtxUp > mcMtxDown
mcMtxSellOK = mcMtxUp < mcMtxDown

// ── Williams Vix Fix ────────────────────────────────────────────────────────
// مقياس خوف يبلغ ذروته عند القيعان. الإشارة شراء فقط بحكم تصميمه، فجهة البيع
// لا تُصدر شيئاً — وهذا سلوك الأصل لا نقص في النقل.
mcVfxHi = ta.highest(close, mcVfxPd)
mcVfxWvf = mcVfxHi == 0.0 ? 0.0 : (mcVfxHi - low) / mcVfxHi * 100.0
mcVfxSd = mcVfxMult * ta.stdev(mcVfxWvf, mcVfxBbl)
mcVfxMid = ta.sma(mcVfxWvf, mcVfxBbl)
mcVfxUpper = mcVfxMid + mcVfxSd
mcVfxRangeHigh = ta.highest(mcVfxWvf, mcVfxLb) * mcVfxPh
mcVfxWasHigh = nz(mcVfxWvf[1], 0.0) >= nz(mcVfxUpper[1], 1e18) or nz(mcVfxWvf[1], 0.0) >= nz(mcVfxRangeHigh[1], 1e18)
mcVfxCooled = mcVfxWvf < mcVfxUpper and mcVfxWvf < mcVfxRangeHigh
mcVfxUpRange = low > nz(low[1], low) and close > nz(high[1], high)
mcVfxUpRangeAggr = close > nz(close[1], close) and close > nz(open[1], open)
mcVfxBase = close > nz(close[mcVfxStr], close) and (close < nz(close[mcVfxLtLB], close) or close < nz(close[mcVfxMtLB], close))
mcVfxFe = mcVfxUpRange and mcVfxBase and mcVfxWasHigh and mcVfxCooled
mcVfxAe = mcVfxUpRangeAggr and mcVfxBase and mcVfxWasHigh and not mcVfxCooled
mcVfxBuy = mcVfxTrigger == "Filtered" ? mcVfxFe : mcVfxTrigger == "Aggressive" ? mcVfxAe : (mcVfxFe or mcVfxAe)
mcVfxSell = false
mcVfxBuyOK = mcVfxWvf < mcVfxUpper
mcVfxSellOK = true

// ── QQE ─────────────────────────────────────────────────────────────────────
// نطاقات متتبِّعة مبنية على تنعيم RSI ومدى تغيّره. الإشارة أول شمعة ينقلب فيها
// موقع الـ RSI المنعَّم عن نطاقه المتتبِّع.
mcQqeWilders = mcQqeRsiLen * 2 - 1
mcQqeRsi = ta.rsi(close, mcQqeRsiLen)
mcQqeIdx = ta.ema(mcQqeRsi, mcQqeSf)
mcQqeAtrRsi = math.abs(nz(mcQqeIdx[1], mcQqeIdx) - mcQqeIdx)
mcQqeMaAtr = ta.ema(mcQqeAtrRsi, mcQqeWilders)
mcQqeDelta = ta.ema(mcQqeMaAtr, mcQqeWilders) * mcQqeFactor
mcQqeNewShort = mcQqeIdx + mcQqeDelta
mcQqeNewLong = mcQqeIdx - mcQqeDelta
var float mcQqeLongBand = 0.0
var float mcQqeShortBand = 0.0
var int mcQqeTrend = 1
mcQqeLbPrev = nz(mcQqeLongBand[1], 0.0)
mcQqeSbPrev = nz(mcQqeShortBand[1], 0.0)
mcQqeLongBand := nz(mcQqeIdx[1], mcQqeIdx) > mcQqeLbPrev and mcQqeIdx > mcQqeLbPrev ? math.max(mcQqeLbPrev, mcQqeNewLong) : mcQqeNewLong
mcQqeShortBand := nz(mcQqeIdx[1], mcQqeIdx) < mcQqeSbPrev and mcQqeIdx < mcQqeSbPrev ? math.min(mcQqeSbPrev, mcQqeNewShort) : mcQqeNewShort
mcQqeUpCross = ta.crossover(mcQqeIdx, mcQqeSbPrev)
mcQqeDnCross = ta.crossunder(mcQqeIdx, mcQqeLbPrev)
mcQqeTrend := mcQqeUpCross ? 1 : mcQqeDnCross ? -1 : nz(mcQqeTrend[1], 1)
mcQqeTl = mcQqeTrend == 1 ? mcQqeLongBand : mcQqeShortBand
mcQqeAbove = mcQqeTl < mcQqeIdx
mcQqeBuy = mcQqeAbove and not nz(mcQqeAbove[1], false)
mcQqeSell = not mcQqeAbove and nz(mcQqeAbove[1], false)
mcQqeBuyOK = mcQqeAbove
mcQqeSellOK = not mcQqeAbove

// ── Squeeze Momentum ────────────────────────────────────────────────────────
// انضغاط بولنجر داخل كلتنر، وزخم انحدار خطي حول منتصف المدى.
// math.avg غير متاح فكُتب القسمة صراحةً.
mcSqzBasis = ta.sma(close, mcSqzLen)
mcSqzDev = ta.stdev(close, mcSqzLen)
mcSqzUpBB = mcSqzBasis + mcSqzMultBB * mcSqzDev
mcSqzLoBB = mcSqzBasis - mcSqzMultBB * mcSqzDev
mcSqzRangeMa = ta.sma(ta.tr, mcSqzLen)
mcSqzUpKC = mcSqzBasis + mcSqzRangeMa * mcSqzMultKC
mcSqzLoKC = mcSqzBasis - mcSqzRangeMa * mcSqzMultKC
mcSqzOn = mcSqzLoBB > mcSqzLoKC and mcSqzUpBB < mcSqzUpKC
mcSqzOff = mcSqzLoBB <= mcSqzLoKC and mcSqzUpBB >= mcSqzUpKC
mcSqzMid = ((ta.highest(high, mcSqzMomLen) + ta.lowest(low, mcSqzMomLen)) / 2.0 + ta.sma(close, mcSqzMomLen)) / 2.0
mcSqzMom = ta.linreg(close - mcSqzMid, mcSqzMomLen, 0)
mcSqzSig = ta.sma(mcSqzMom, mcSqzSigLen)
mcSqzCrossBuy = ta.crossover(mcSqzMom, mcSqzSig)
mcSqzCrossSell = ta.crossunder(mcSqzMom, mcSqzSig)
mcSqzRelBuy = mcSqzOff and not nz(mcSqzOff[1], false) and mcSqzMom >= mcSqzSig
mcSqzRelSell = mcSqzOff and not nz(mcSqzOff[1], false) and mcSqzMom < mcSqzSig
mcSqzBuy = mcSqzTrigger == "Signal Cross" ? mcSqzCrossBuy : mcSqzRelBuy
mcSqzSell = mcSqzTrigger == "Signal Cross" ? mcSqzCrossSell : mcSqzRelSell
mcSqzBuyOK = mcSqzMom >= mcSqzSig
mcSqzSellOK = mcSqzMom < mcSqzSig

// ── Keltner Wick Rejection ──────────────────────────────────────────────────
// ذيل يخترق نطاق كلتنر ثم يغلق داخله = رفض. مرشَّح بستوكاستك RSI.
// ta.stoch وta.rising/falling غير متاحة، فكُتبت صيغها صراحةً.
mcKwEma0 = ta.ema(close, mcKwEma)
mcKwBase = ta.ema(mcKwEma0, 3)
mcKwAtrV = ta.atr(mcKwAtr)
mcKwUpFull = ta.sma(mcKwBase + mcKwAtrV * mcKwMult, mcKwSmooth)
mcKwLoFull = ta.sma(mcKwBase - mcKwAtrV * mcKwMult, mcKwSmooth)
mcKwUpHalf = ta.sma(mcKwBase + mcKwAtrV * mcKwMult / 2.0, mcKwSmooth)
mcKwLoHalf = ta.sma(mcKwBase - mcKwAtrV * mcKwMult / 2.0, mcKwSmooth)
mcKwUpper = mcKwBand == "Full" ? mcKwUpFull : mcKwBand == "Half" ? mcKwUpHalf : mcKwBase
mcKwLower = mcKwBand == "Full" ? mcKwLoFull : mcKwBand == "Half" ? mcKwLoHalf : mcKwBase
mcKwRsiV = ta.rsi(close, mcKwRsiLen)
mcKwHH = ta.highest(mcKwRsiV, mcKwStochLen)
mcKwLL = ta.lowest(mcKwRsiV, mcKwStochLen)
mcKwRawK = mcKwHH - mcKwLL == 0 ? 50.0 : 100.0 * (mcKwRsiV - mcKwLL) / (mcKwHH - mcKwLL)
mcKwK = ta.sma(mcKwRawK, mcKwSmoothK)
mcKwBearOK = not mcKwUseSrsi or mcKwK > 80.0
mcKwBullOK = not mcKwUseSrsi or mcKwK < 20.0
mcKwSize = high - low == 0 ? syminfo.mintick : high - low
mcKwUpWick = (high - math.max(open, close)) / mcKwSize
mcKwDnWick = (math.min(open, close) - low) / mcKwSize
mcKwSell = close < mcKwUpper and high > mcKwUpper and mcKwBearOK and mcKwUpWick > mcKwWickRatio
mcKwBuy = close > mcKwLower and low < mcKwLower and mcKwBullOK and mcKwDnWick > mcKwWickRatio
mcKwBuyOK = close > mcKwBase
mcKwSellOK = close < mcKwBase
'''

s=s.replace('mcAtrLen = input.int(14, "ATR Length — shared by sources", minval=1, group=G_SRC)',
            IN.strip() + '\n\nmcAtrLen = input.int(14, "ATR Length — shared by sources", minval=1, group=G_SRC)')
s=s.replace("// ── تجميع المصادر والفلاتر ──", CALC.strip() + "\n\n// ── تجميع المصادر والفلاتر ──")
NEW=['Mtx','Vfx','Qqe','Sqz','Kw']
srcb=" or ".join(f"f_src(mc{n}Mode, mc{n}Buy)" for n in NEW)
srcs=" or ".join(f"f_src(mc{n}Mode, mc{n}Sell)" for n in NEW)
fltb=" and ".join(f"f_flt(mc{n}Mode, mc{n}BuyOK)" for n in NEW)
flts=" and ".join(f"f_flt(mc{n}Mode, mc{n}SellOK)" for n in NEW)
cnt=" + ".join(f'(mc{n}Mode != "Off" ? 1 : 0)' for n in NEW)
for a,b in [('f_src(mcVolMode, mcVolBuy)', 'f_src(mcVolMode, mcVolBuy) or '+srcb),
            ('f_src(mcVolMode, mcVolSell)','f_src(mcVolMode, mcVolSell) or '+srcs),
            ('f_flt(mcVolMode, mcVolBuyOK)','f_flt(mcVolMode, mcVolBuyOK) and '+fltb),
            ('f_flt(mcVolMode, mcVolSellOK)','f_flt(mcVolMode, mcVolSellOK) and '+flts),
            ('(mcVolMode != "Off" ? 1 : 0)','(mcVolMode != "Off" ? 1 : 0) + '+cnt)]:
    assert a in s, a
    s=s.replace(a,b)
open(p,'w',encoding='utf-8').write(s)
print("أُضيفت 5 مصادر: Matrix • VixFix • QQE • Squeeze • KeltnerWick")
