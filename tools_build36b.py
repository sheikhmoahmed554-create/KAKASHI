#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SYR36 stage 2 — six sections leave the file, and the two that pay are turned on.

Everything here was measured on 2026 through the Pine engine, never the JS lab.
Sections were tested by switching them ON against the seven-school-cut base of
+8,567 / 60.33% / 6,680 trades / 1,652 drawdown.
"""
import io, re

SRC = 'SYR36_CLEAN.pine'          # already has the seven schools removed
DST = 'SYR36_CLEAN.pine'
s = io.open(SRC, encoding='utf-8').read()
before = len(s.splitlines())
L = s.split('\n')


def span(first_pred, last_pred, why):
    """Return the [i, j) line span starting at the first line matching first_pred
    and ending after the first later line matching last_pred."""
    i = next(k for k, l in enumerate(L) if first_pred(l))
    j = next(k for k in range(i, len(L)) if last_pred(L[k])) + 1
    return i, j, why


kill_spans = []

# ── 21 ■ Our Regime Gate — turning it ON cost 7,962 points and 1,885 trades ──
kill_spans.append(span(lambda l: l.startswith('// 21 ■ OUR REGIME GATE'),
                       lambda l: l.startswith('bgcolor(ourShowRegimeBg'),
                       '21 Our Regime Gate'))
# its banner line sits one line above the header
kill_spans[-1] = (kill_spans[-1][0] - 1, kill_spans[-1][1], kill_spans[-1][2])

# ── 27 ■ ORB London — ON it earned +70 alone and cost 779 next to RMI ──
kill_spans.append(span(lambda l: l.startswith('// 27 ■ ORB LONDON'),
                       lambda l: l.strip() == 'm1SelectedSourceCode := 8',
                       '27 ORB London'))
kill_spans[-1] = (kill_spans[-1][0] - 1, kill_spans[-1][1], kill_spans[-1][2])

# ── 26 ■ Buy with no thesis — my own addition; next to RMI it cost 2,371 ──
kill_spans.append(span(lambda l: l.startswith('G_HTFB ='),
                       lambda l: l.startswith('buySignal := buySignal and not (htfbUse'),
                       '26 Buy with no thesis'))

# ── 18 / 19 / 20 — the three SYR30 replacement schools. ON, 18 and 20 did not
#    move a single trade in six months and 19 moved one and lost 100 points. ──
kill_spans.append(span(lambda l: l.startswith('// ━━━ SYR30 SCHOOL 1'),
                       lambda l: l.startswith('syr30ReplacementSell ='),
                       '18/19/20 SYR30 replacement schools'))

for i, j, why in sorted(kill_spans, reverse=True):
    del L[i:j]
s = '\n'.join(L)

# their input blocks and group names go too
s = re.sub(r'^.*group=G_(SYR30_BAL|SYR30_ASIA|SYR30_AUCT|OURF|ORB|HTFB)[,)].*\n', '', s, flags=re.M)
s = re.sub(r'^G_(SYR30_BAL|SYR30_ASIA|SYR30_AUCT|OURF|ORB|HTFB) = ".*\n', '', s, flags=re.M)
s = re.sub(r'^// ━━━ SYR30 replacement-school controls ━━━\n', '', s, flags=re.M)

# ── the six places that still name the removed signals ────────────────────────
FIX = [
 # school router: three of its slots pointed at schools that no longer exist
 ('finalS12 = syr30UseSchoolRouter ? f_final_school_side(syr30BalanceBuy, syr30BalanceSell) : 0',
  'finalS12 = 0'),
 ('finalS17 = syr30UseSchoolRouter ? f_final_school_side(syr30DeadAuctionBuy, syr30DeadAuctionSell) : 0',
  'finalS17 = 0'),
 ('finalS23 = syr30UseSchoolRouter ? f_final_school_side(syr30AsiaBuy, syr30AsiaSell) : 0',
  'finalS23 = 0'),
 # the fast-final bypass and the arbiter's reversal test
 ('fastFinalBuyBypass = sy338TrueCounterBuy or sweepLow or realRevBuy or sy360FibBoostBuy or sy361LiqBoostBuy or syr30DeadAuctionBuy',
  'fastFinalBuyBypass = sy338TrueCounterBuy or sweepLow or realRevBuy or sy360FibBoostBuy or sy361LiqBoostBuy'),
 ('fastFinalSellBypass = sy338TrueCounterSell or sweepHigh or realRevSell or sy360FibBoostSell or sy361LiqBoostSell or syr30DeadAuctionSell',
  'fastFinalSellBypass = sy338TrueCounterSell or sweepHigh or realRevSell or sy360FibBoostSell or sy361LiqBoostSell'),
 ('qaBuyReversal = qaAllowStrongReversal and (realRevBuy or sy338TrueCounterBuy or syr30DeadAuctionBuy or (sweepLow and (bullReject or bullMomentum)))',
  'qaBuyReversal = qaAllowStrongReversal and (realRevBuy or sy338TrueCounterBuy or (sweepLow and (bullReject or bullMomentum)))'),
 ('qaSellReversal = qaAllowStrongReversal and (realRevSell or sy338TrueCounterSell or syr30DeadAuctionSell or (sweepHigh and (bearReject or bearMomentum)))',
  'qaSellReversal = qaAllowStrongReversal and (realRevSell or sy338TrueCounterSell or (sweepHigh and (bearReject or bearMomentum)))'),
 # the arbiter's source score carried a weight for each of the three
 ('(pbPairBuy ? 0.85 : 0.0) + (syr30BalanceBuy ? 1.10 : 0.0) + (syr30AsiaBuy ? 0.95 : 0.0) + (syr30DeadAuctionBuy ? 1.05 : 0.0) + (r11ConnB ? 0.20 : 0.0)',
  '(pbPairBuy ? 0.85 : 0.0) + (r11ConnB ? 0.20 : 0.0)'),
 ('(pbPairSell ? 0.85 : 0.0) + (syr30BalanceSell ? 1.10 : 0.0) + (syr30AsiaSell ? 0.95 : 0.0) + (syr30DeadAuctionSell ? 1.05 : 0.0) + (r11ConnS ? 0.20 : 0.0)',
  '(pbPairSell ? 0.85 : 0.0) + (r11ConnS ? 0.20 : 0.0)'),
 # the final entry gate named the regime filter and the ORB triggers
 ('canEnterLong = barstate.isconfirmed and not active and allowLong and ((canCooldown and canLongAfterLoss and buySignal and ourBuyOK and ourSoloOK) or rsrcDirectBuy or orbDirectBuy or kzDirectBuy)',
  'canEnterLong = barstate.isconfirmed and not active and allowLong and ((canCooldown and canLongAfterLoss and buySignal and ourSoloOK) or rsrcDirectBuy or kzDirectBuy)'),
 ('canEnterShort = barstate.isconfirmed and not active and allowShort and ((canCooldown and canShortAfterLoss and sellSignal and ourSellOK and ourSoloOK) or rsrcDirectSell or orbDirectSell or kzDirectSell)',
  'canEnterShort = barstate.isconfirmed and not active and allowShort and ((canCooldown and canShortAfterLoss and sellSignal and ourSoloOK) or rsrcDirectSell or kzDirectSell)'),
]
for a, b in FIX:
    assert s.count(a) == 1, 'not unique: ' + a[:60]
    s = s.replace(a, b, 1)

# ── the two that pay now ship on ──────────────────────────────────────────────
ON = [
 ('useRmiSource = input.bool(false, "استخدم رمي كمصدر دخول"',
  'useRmiSource = input.bool(true, "استخدم رمي كمصدر دخول"'),
 ('useKzLondon = input.bool(false, "استخدم كنسة لندن"',
  'useKzLondon = input.bool(true, "استخدم كنسة لندن"'),
]
for a, b in ON:
    assert s.count(a) == 1, a[:60]
    s = s.replace(a, b, 1)

for dead in ['syr30UseBalance', 'syr30UseAsia', 'syr30UseDeadAuction', 'syr30Balance',
             'syr30Asia', 'syr30Auction', 'syr30DeadAuction', 'syr30SchoolBuyVotes',
             'useOurRegimeGate', 'ourBuyOK', 'ourSellOK', 'ourTrendUp', 'useOrbLondon', 'orbDirectBuy',
             'htfbUse', 'G_ORB', 'G_HTFB', 'G_OURF']:
    assert dead not in s, 'survivor: ' + dead

NOTE = u'//' + u'━' * 38 + u'''
// SECTIONS REMOVED, AND THE TWO THAT WERE SWITCHED ON
//
// Each section was tested by turning it ON against the base left after the seven
// schools were cut: +8,567 at 60.33% over 6,680 trades, drawdown 1,652, on 2026
// through the Pine engine.
//
//   section                        ON gave     it was worth
//   18 Balance Reset Launch         +8,567            0      not one trade moved
//   20 Dead Auction Reclaim         +8,567            0      not one trade moved
//   19 Asia Accepted Break-Retest   +8,630         -100      one extra trade
//   27 ORB London                   +8,637          +70      and -779 beside RMI
//   21 Our Regime Gate                +768       -7,962      cut 1,885 trades
//   26 Buy with no thesis          -              -2,371     measured beside RMI
//
// All six are gone from the file, with their inputs, their computation blocks,
// and every reference to them in the school router, the fast-final bypass and
// the arbiter's source score.
//
// Two sections that shipped OFF pay, and now ship ON:
//
//   24 RMI Source        +17,874     +9,307
//   28 Asia Sweep        +10,636     +2,069
//   both together        +18,881    +10,314     drawdown 2,183, 6,194 trades
//
// R11 Connors was tested the other way, by switching it OFF: +7,326 against
// +8,567, so it earns 1,241 and stays.
//
// The version this was cut from made +6,565 at 60.44% with a 2,261 drawdown.
//''' + u'━' * 38 + u'\n'

anchor = u'G_RSRC = '
i = s.index(anchor)
j = s.rindex(u'\n', 0, i) + 1
s = s[:j] + NOTE + s[j:]

io.open(DST, 'w', encoding='utf-8').write(s)
print('%s: %d lines (was %d)' % (DST, len(s.splitlines()), before))
