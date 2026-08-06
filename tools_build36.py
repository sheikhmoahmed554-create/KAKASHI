#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SYR36 = SYR30_USER with every champion school that does not pay its way taken
out of the file — inputs, court verdicts, signal lines, OR-chain terms, and the
helper series nothing else reads.

Every removal below was measured on 2026 through the Pine engine, one school at
a time, against the source version's +6,565 at 60.44% with a 2,261 drawdown.
"""
import io

SRC = 'SYR30_USER.pine'
DST = 'SYR36_CLEAN.pine'
s = io.open(SRC, encoding='utf-8').read()

# ── whole lines that leave the file ───────────────────────────────────────────
KILL = [
 # ULSWEEP v2 — worth -2,740
 u'chUlsUse = input.bool(true, "ULSWEEP v2 — ON", group=G_CH)\n',
 u'chUlsStr = input.float(1.5, "ULS stretch filter", minval=0.5, maxval=4.0, step=0.1, group=G_CH)\n',
 u'chUlsRsi = input.float(30.0, "ULS RSI3 extreme", minval=10, maxval=40, step=1, group=G_CH)\n',
 u'chUlsLen = input.int(85, "ULS level length", minval=20, maxval=400, group=G_CH)\n',
 u'courtUls2S = input.bool(true, "chUls2 SELL (حكم: -1500)", group=G_COURT)\n',
 u'chUls2B = chUlsUse and low < ta.lowest(low, chUlsLen)[1] and close > ta.lowest(low, chUlsLen)[1] and chStretch < -chUlsStr and chRsi3 < chUlsRsi\n',
 u'chUls2S = chUlsUse and high > ta.highest(high, chUlsLen)[1] and close < ta.highest(high, chUlsLen)[1] and chStretch > chUlsStr and chRsi3 > 100 - chUlsRsi\n',
 # SPRING Wyckoff — worth -1,707.  chLw/chUw/chSprLo/chSprHi are read by nothing else.
 u'chSprUse = input.bool(true, "SPRING Wyckoff — ON", group=G_R11)\n',
 u'chSprWickK = input.float(2.3, "SPRING wick x body", minval=0.5, maxval=5.0, step=0.1, group=G_R11)\n',
 u'chSprLo = ta.lowest(low, 20)\n',
 u'chSprHi = ta.highest(high, 20)\n',
 u'chLw = math.min(open, close) - low\n',
 u'chUw = high - math.max(open, close)\n',
 u'chSprB = chSprUse and low < chSprLo[1] and close > chSprLo[1] and chLw > chSprWickK * math.abs(close - open) and not chTrDn\n',
 u'chSprS = chSprUse and high > chSprHi[1] and close < chSprHi[1] and chUw > chSprWickK * math.abs(close - open) and not chTrUp\n',
 u'buySignal := buySignal or chSprB\n',
 u'sellSignal := sellSignal or chSprS\n',
 # CVD divergence — worth -571
 u'courtCvdB = input.bool(true, "chCvd BUY (حكم: -1800)", group=G_COURT)\n',
 u'chCvdUse = input.bool(true, "CVD divergence — ON", group=G_MOM_NEW)\n',
 u'chCvdLen = input.int(30, "CVD window", minval=10, maxval=100, group=G_MOM_NEW)\n',
 u'chCvdShift = input.int(5, "CVD compare shift", minval=1, maxval=30, group=G_MOM_NEW)\n',
 u'chCvdRng = math.max(high - low, syminfo.mintick)\n',
 u'chCvdFast = ta.sma((2 * close - high - low) / chCvdRng * nz(volume, 0.0), chCvdLen) * chCvdLen\n',
 u'chCvdB = chCvdUse and low <= ta.lowest(low, chCvdLen) and chCvdFast > chCvdFast[chCvdShift] and close > open\n',
 u'chCvdS = chCvdUse and high >= ta.highest(high, chCvdLen) and chCvdFast < chCvdFast[chCvdShift] and close < open\n',
 u'buySignal := buySignal or (courtCvdB and chCvdB)\n',
 u'sellSignal := sellSignal or chCvdS\n',
 # VWAP Absorption Fade — worth -285.  chTp3/chVw/chSdv are read by nothing else.
 u'courtVzS = input.bool(true, "chVz SELL (حكم: -1150)", group=G_COURT)\n',
 u'chVzUse = input.bool(true, "VWAP Absorption Fade — ON", group=G_PULLBACK_NEW)\n',
 u'chVzDev = input.float(2.0, "VZ deviation mult", minval=1.0, maxval=4.0, step=0.1, group=G_PULLBACK_NEW)\n',
 u'chTp3 = (high + low + close) / 3\n',
 u'chVw = ta.sma(chTp3 * nz(volume, 0.0), 20) / (ta.sma(nz(volume, 0.0), 20) + 0.00001)\n',
 u'chSdv = ta.stdev(chTp3 - chVw, 50)\n',
 u'chVzB = chVzUse and low < chVw - chVzDev * chSdv and chRsi3 < 18.0 and chBig\n',
 u'chVzS = chVzUse and high > chVw + chVzDev * chSdv and chRsi3 > 82.0 and chBig\n',
 # TRIPLE — worth 0.  Same 6,984 trades and the same net with it and without it.
 u'chTriUse = input.bool(true, "TRIPLE — ON", group=G_CH)\n',
 u'chTriDepth = input.float(5.0, "TRIPLE depth — CHAMPION=2.0", minval=0.5, maxval=6.0, step=0.1, group=G_CH)\n',
 u'chTriTh = input.float(18.0, "TRIPLE RSI3 threshold", minval=5.0, maxval=30.0, step=1.0, group=G_CH)\n',
 u'courtTriS = input.bool(true, "chTri SELL (نجا — عينة صغيرة)", group=G_COURT)\n',
 u'chTriB = chTriUse and chStretch < -chTriDepth and chRsi3 < chTriTh and chBig and not chTrDn\n',
 u'chTriS = chTriUse and chStretch > chTriDepth and chRsi3 > 100 - chTriTh and chBig and not chTrUp\n',
 # WAVETREND v2 — worth 0.  chWtTp3/Esa/De/Ci/1 exist only for it.
 u'courtWtS = input.bool(true, "chWt SELL (حكم: -600)", group=G_COURT)\n',
 u'chWtUse = input.bool(true, "WAVETREND v2 (WT + chassis) — ON", group=G_CH)\n',
 u'chWtTp3 = (high + low + close) / 3\n',
 u'chWtEsa = ta.ema(chWtTp3, 10)\n',
 u'chWtDe = ta.ema(math.abs(chWtTp3 - chWtEsa), 10)\n',
 u'chWtCi = (chWtTp3 - chWtEsa) / (0.015 * chWtDe + 0.00001)\n',
 u'chWt1 = ta.ema(chWtCi, 21)\n',
 u'chWtB = chWtUse and chWt1 < -60 and chRsi3 < 18.0 and chBig\n',
 u'chWtS = chWtUse and chWt1 > 60 and chRsi3 > 82.0 and chBig\n',
 u'buySignal := buySignal or chWtB\n',
 u'sellSignal := sellSignal or (courtWtS and chWtS)\n',
 # PRO SCALPER — worth +75 over six months.  chBbM/chBbS are read by nothing else.
 u'chPsUse = input.bool(true, "PRO SCALPER — ON", group=G_PULLBACK_NEW)\n',
 u'chPsRsi = input.float(25.0, "PS RSI extreme", minval=10, maxval=40, step=1, group=G_PULLBACK_NEW)\n',
 u'chPsAdx = input.float(30.0, "PS max ADX", minval=10, maxval=40, step=1, group=G_PULLBACK_NEW)\n',
 u'courtPsS = input.bool(true, "chPs SELL (نجا — عينة صغيرة)", group=G_COURT)\n',
 u'courtPsB = input.bool(true, "chPs BUY (نجا — عينة صغيرة)", group=G_COURT)\n',
 u'chBbM = ta.sma(close, 20)\n',
 u'chBbS = ta.stdev(close, 20)\n',
 u'chPsB = chPsUse and chRsi14v < chPsRsi and low <= chBbM - 2 * chBbS and (math.min(open, close) - low > math.abs(close - open) or close > high[1]) and adx < chPsAdx\n',
 u'chPsS = chPsUse and chRsi14v > 100 - chPsRsi and high >= chBbM + 2 * chBbS and (high - math.max(open, close) > math.abs(close - open) or close < low[1]) and adx < chPsAdx\n',
]
for k in KILL:
    assert s.count(k) == 1, 'not unique: ' + k[:55]
    s = s.replace(k, u'', 1)

# ── OR chains that keep some terms and lose others ────────────────────────────
OR = [
 (u'buySignal := buySignal or chUls2B or chVzB or chCrevB or chCmoB',
  u'buySignal := buySignal or chCrevB or chCmoB'),
 (u'sellSignal := sellSignal or (courtUls2S and chUls2S) or (courtVzS and chVzS) or chCrevS or (courtCmoS and chCmoS)',
  u'sellSignal := sellSignal or chCrevS or (courtCmoS and chCmoS)'),
 (u'buySignal := buySignal or chTriB or chSniB', u'buySignal := buySignal or chSniB'),
 (u'sellSignal := sellSignal or (courtTriS and chTriS) or chSniS', u'sellSignal := sellSignal or chSniS'),
 (u'buySignal := buySignal or chTsiB or chDixB or (courtPsB and chPsB)',
  u'buySignal := buySignal or chTsiB or chDixB'),
 (u'sellSignal := sellSignal or chTsiS or chDixS or (courtPsS and chPsS)',
  u'sellSignal := sellSignal or chTsiS or chDixS'),
]
for a, b in OR:
    assert s.count(a) == 1, 'not unique: ' + a[:55]
    s = s.replace(a, b, 1)

for dead in ['chUls', 'chSpr', 'chVz', 'chCvd', 'chTri', 'chWt', 'chPs',
             'chLw', 'chUw', 'chTp3', 'chVw', 'chSdv', 'chBbM', 'chBbS',
             'courtTriS', 'courtWtS', 'courtPsB', 'courtPsS']:
    assert dead not in s, 'survivor: ' + dead

NOTE = u'//' + u'━' * 38 + u'''
// REMOVED FROM THE INDICATOR
//
// Seven champion schools are gone from this file — not switched off, taken out,
// with the inputs, court verdicts and helper series that only they read. Each
// was ablated on its own on 2026 through the Pine engine, against the source
// version's +6,565 at 60.44% over 6,984 trades with a 2,261 drawdown:
//
//   school                    net without it     it was worth
//   ULSWEEP v2   (chUls2)           +9,305           -2,740
//   SPRING Wyckoff (chSpr)          +8,272           -1,707
//   CVD divergence (chCvd)          +7,136             -571
//   VWAP Absorption (chVz)          +6,850             -285
//   PRO SCALPER  (chPs)             +6,640              -75
//   TRIPLE       (chTri)            +6,565                0
//   WAVETREND v2 (chWt)             +6,565                0
//
// chTri and chWt did not change one trade in six months. The rest cost money.
//
// The eight that stay all pay for their place — removing any of them loses
// points: chRib -5,100, chR14 -2,295, chCld -1,519, chUt -1,194, chKelt -913,
// chUo -683, chCmo -352, chCrev -143.
//
// Removing the four largest was verified two ways and agreed exactly: switching
// them off in the source gave 6,682 trades / 60.36% / +8,730 / drawdown 1,652,
// and this file cut down to the same set gave the identical figures. The cut is
// clean; nothing else in the chain depended on them.
//
// chSni, chQuad, chTsi and chDix ship disabled in the source version, so they
// fire nothing as written. They are still here pending an ON test.
//''' + u'━' * 38 + u'\n'

anchor = u'chVerUse = input.bool(false,'
i = s.index(anchor)
j = s.rindex(u'\n', 0, i) + 1
s = s[:j] + NOTE + s[j:]
s = s.replace(u'SYR30', u'SYR36', 1)

io.open(DST, 'w', encoding='utf-8').write(s)
print('wrote %s  %d lines (source %d)' % (DST, len(s.splitlines()),
      len(io.open(SRC, encoding='utf-8').read().splitlines())))
