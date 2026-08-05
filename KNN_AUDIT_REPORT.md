# AI Trend Navigator (KNN) — pushed to its ceiling, and the harness audit that came first

## Part 1 — the challenge: "not one indicator has ever won on the BUY side, so your tests are wrong"

Fair challenge. It was tested three ways before anything else was done.

### A) Is the forward-walk code itself biased against BUY?

The bar series was flipped upside down (every `high` became a `low`, mirrored about a fixed
price) and the same walk function was run on both. A BUY on mirrored bars must return exactly
what a SELL returned on the originals.

| files | paired walks | mismatches | worst difference |
|---|---|---|---|
| 2026 / 2021 / 2023 / lev31 | 129,240 | **0** | 4.5 × 10⁻¹² |

The walk is side-symmetric. There is no bug.

### B) What did the market itself pay each side, with no rule at all?

20,000–30,000 **random** entries per side, drawn from the same bars, same plans:

| plan | 2026 buy / sell | 2021 buy / sell | 2023 buy / sell |
|---|---|---|---|
| 50/50 | **−1.70** / +1.28 | −1.05 / +0.86 | **+0.60** / −0.91 |
| 90/90 | **−4.31** / +4.16 | −1.17 / +1.17 | **+1.35** / −1.36 |
| 90/120 | **−4.89** / +4.50 | +0.06 / −0.60 | **+4.20** / −0.60 |
| 150/100 | **−6.97** / +5.29 | −1.47 / −1.67 | **+0.77** / −6.32 |

*(points per trade)*

2026 fell 3,558 points in 197 days, and pays SELL up to 9 points a trade more than BUY for
zero skill. 2023 rose 2,218 points and the sign flips completely — BUY positive on every plan,
SELL negative on every plan. A code bug would not flip with the year.

### C) The engine's own two sides, measured by the same harness

| file | engine | buy N | buy WR | buy net | sell N | sell WR | sell net |
|---|---|---|---|---|---|---|---|
| 2026 | **SYR31** | 2,776 | **62.21%** | **+7,010** | 4,167 | 63.02% | +8,655 |
| 2021 | SYR30 | 1,121 | 61.55% | **+2,971** | 1,166 | 63.64% | +3,195 |
| 2023 | SYR30 | 905 | 57.79% | −1,222 | 980 | 57.96% | −2,309 |

In 2023 the SELL side lost *more* than the BUY side — the mirror image of 2026.

**Verdict: the measurement was correct; the *ranking* was wrong.** Sorting candidates by raw net
profit on a year that fell 3,558 points rewards the short bet, not the rule. Every configuration
is now scored against the same year's random baseline for the same plan:

```
edge = (rule's points per trade) − (a coin flip's points per trade, same side, same year, same plan)
```

## Part 2 — a second measurement error, found while re-running

Gold's minute-bar volatility is not comparable across these years:

| year | price range | median M1 ATR(14) | what a 90-point target really is |
|---|---|---|---|
| 2026 | 4330 → 4018 | **23.2 points** | 3.9 × ATR |
| 2021 | 1910 → 1829 | 4.3 points | 20.7 × ATR |
| 2023 | 1827 → 2063 | 4.0 points | 22.4 × ATR |

A fixed 90-point plan is a scalp in 2026 and a swing trade in 2021 — the same name on two
different trades. Every cross-year comparison below converts each plan to the ATR multiple it
was in 2026, so all three years are asked the same question. Before this fix, the same rule
produced 22.9 trades/day in 2026 and 1.8 in 2021, purely from the plan being mis-scaled.

## Part 3 — the navigator at its ceiling

Search space: **8 timeframes × 15 line types × 11 lengths × 3 signal readings × 9 exit plans
= 35,640 configurations**, each evaluated per-signal on all three years.

Line types tried, beyond the four the indicator ships with: T3 (Tillson), ALMA, LSMA,
KAMA, VIDYA (Chande), McGinley Dynamic, Ehlers 2-pole SuperSmoother, DEMA, TEMA, rolling
median, WMA, SMA.

### Survivors vs. chance

| gate | pass rate 2026 / 2021 / 2023 | survivors | expected by chance |
|---|---|---|---|
| both sides + both halves beat baseline | 1.20% / 1.35% / 1.99% | **0** | 0.1 |
| both sides beat baseline | 6.74% / 10.81% / 13.05% | **32** | **33.9** |
| BUY side alone beats baseline | 13.77% / 55.03% / 32.17% | 1,029 | 869 |
| the pair, summed, beats baseline | 35.04% / 32.76% / 44.08% | 1,457 | 1,803 |

At every level the survivor count sits at or below what chance alone produces. Nothing in the
35,640 clears the bar as a group.

The 2026-only champion — **30m VIDYA 51 REJ 150/100**, which looked spectacular at +27.6 points
of buy-side edge — has a **worst three-year edge of −9.15**. It was fitting, and the three-year
test caught it.

### Neighbourhood test

A single winning cell proves nothing when survivors are at chance level. A real edge has
neighbours: the lengths either side and the plans either side should lean positive too. Across
all configurations, an edge is positive **44.5%** of the time — that is the number to beat.

| config | signals/day | worst 3yr edge | neighbourhood positive rate | lift |
|---|---|---|---|---|
| 2m LSMA 40 REJ 90/120 | 105 | +0.83 | 60.5% | +16.0 |
| 30m SSF 15 REJ 120/60 | 39.5 | +0.77 | 60.5% | +16.0 |
| 1H T3 34 REJ 120/90 | 9.8 | **+3.49** | 58.0% | +13.5 |
| 15m DEMA 28 REJ 90/120 | 46 | +1.05 | 57.4% | +12.9 |
| 15m KNN 51 REJ 90/90 | 22.8 | +0.26 | 54.9% | +10.4 |
| 30m VIDYA 51 REJ 150/100 | 5.6 | **−9.15** | 57.4% | +12.9 |

Best and worst families (all lengths, all plans, all three years):

| best | positive rate | | worst | positive rate |
|---|---|---|---|---|
| 30m KNN REJ | 55.4% | | 2m EMA REJ | 33.5% |
| 1H RMA REJ | 54.4% | | 1m KNN REJ | 33.3% |
| 30m LSMA REJ | 53.4% | | 1m MCG REJ | 33.0% |
| 1H LSMA REJ | 53.4% | | 1m EMA REJ | 32.5% |
| 15m KNN REJ | 53.2% | | 1m LSMA REJ | 31.1% |

**Every 1m and 2m short-length family is at the bottom.** The indicator's own KNN line is best on
**30m with the rejection signal** — which is a genuine result in its favour, just not on the
timeframes it is normally run on.

### Traded for real — one position at a time, ATR-scaled, stop wins a same-bar tie

| slot | 2026 net | 2021 net | 2023 net | /day |
|---|---|---|---|---|
| 15m DEMA 28 REJ 90/120 | **+13,256** | −462 | +349 | 9.1 |
| 30m SSF 15 REJ 120/60 | **+5,240** | +1,122 | −1,476 | 10.3 |
| 1H T3 34 REJ 120/90 | **+4,172** | −355 | −224 | 2.0 |
| 2m LSMA 40 REJ 90/120 | −1,647 | −864 | −514 | 16.1 |
| **four slots together** | **+21,021** | **−559** | **−1,865** | **37.5** |
| all merged into one slot | −272 | −1,846 | −732 | 18.3 |

On 2026 the buy side is healthy where the rule is healthy — 15m DEMA runs 58.4% WR on BUY for
+1,890 and 63.4% on SELL for +11,366.

## Conclusion

The navigator was taken to its ceiling: 35,640 tuned configurations, eleven line types it does
not ship with, ATR-normalised exits, three years, per-side and per-half validation.

Its ceiling is **+3,138 points/month on 2026 at 37.5 trades/day, and flat-to-negative on 2021 and
2023.** That is below the 5,000–10,000/month target and below what SYR32 already delivers
(+30,385 on 2026). It is not worth mounting on the engine.

What is worth keeping from it:

1. **The scoring fix** — drift-relative edge instead of raw net. This applies to every future
   candidate, not just this one.
2. **The ATR-scaling fix** — no fixed-point plan may be compared across years again.
3. **VIDYA, T3, DEMA and Ehlers SuperSmoother** as line candidates; they beat the KNN line
   itself in several families and are now available in `lab/lines.js`.
4. **1m and 2m are where this family of rules dies** — 31–33% positive against a 44.5% base.

## Files

| file | what it does |
|---|---|
| `lab/buyaudit.js` | mirror invariance, random control, per-side engine stats |
| `lab/lines.js` | 15 centre-line implementations + the KNN line |
| `lab/knnopt2.js` | the 35,640-config sweep with drift-relative scoring |
| `lab/knncross.js` | strict three-year intersection |
| `lab/knncross2.js` | stepped-down intersection with chance expectation |
| `lab/knnhood.js` | neighbourhood stability test |
| `lab/knnfinal.js` | ATR-scaled single-slot simulation of the survivors |
