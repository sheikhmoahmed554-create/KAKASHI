'use strict';
/*
 * A proper test of whether price respects a level.
 *
 * The first pass at this was wrong, and the signal counts gave it away: round
 * numbers produced 50,576 signals over 192,081 candles and fair value gaps
 * 60,674. A level that is genuinely tested is tested a handful of times a
 * week. Those counts were not tests, they were the same stretch of price
 * counted once per candle.
 *
 * Three mistakes, all in the measurement rather than in the ideas:
 *
 *   1. Bar-by-bar signals. Price loitering at a level for forty candles scored
 *      forty separate rejections. One approach is one event.
 *
 *   2. Levels that followed price. "Nearest round number to the close" moves
 *      whenever the close moves, and "nearest of the five pivots" does too.
 *      That turns a fixed level into a step function trailing price — exactly
 *      the flaw that made the KNN lines worthless.
 *
 *   3. No approach requirement. A test means price was away and came back. Any
 *      candle that merely happened to be near the level counted.
 *
 * What this module does instead: watch one specific level value at a time,
 * require price to have been genuinely away from it, then fire once when it
 * arrives and reacts. The level has to be left behind before it can fire
 * again.
 */

/**
 * Discrete test events against a level series.
 *
 * A level qualifies only after price has been at least `approachAtr` away from
 * it. When price then reaches within `tolAtr`, the candle's close decides what
 * kind of event it was:
 *
 *   reject  price arrived and was pushed back to the side it came from
 *   break   price arrived and closed decisively through
 *
 * After either, the level is locked until price moves `resetAtr` away, so one
 * visit produces one event no matter how long it lasts.
 */
function levelTestEvents(bars, line, atr, opts = {}) {
  const tolAtr = opts.tolAtr ?? 0.20;
  const approachAtr = opts.approachAtr ?? 1.5;
  const breakAtr = opts.breakAtr ?? 0.25;
  const resetAtr = opts.resetAtr ?? 1.0;
  const levelEps = opts.levelEps ?? 0.05;   // how much the level may drift and stay "the same level"

  const events = [];
  let armedLevel = NaN;   // the level value price is currently away from
  let lockedLevel = NaN;  // a level already acted on, waiting to be left
  let approached = false;

  for (let i = 1; i < bars.length; i++) {
    const L = line[i];
    const a = atr[i];
    if (!Number.isFinite(L) || !Number.isFinite(a) || a <= 0) continue;

    const b = bars[i];
    const tol = a * tolAtr;

    // A different level value resets the state: this is a new thing to watch.
    if (!Number.isFinite(armedLevel) || Math.abs(L - armedLevel) > Math.max(levelEps, a * 0.5)) {
      armedLevel = L;
      approached = false;
      lockedLevel = NaN;
    }

    const distClose = Math.abs(b.c - L);

    // Release a locked level once price has genuinely walked away from it.
    if (Number.isFinite(lockedLevel) && Math.abs(b.c - lockedLevel) > a * resetAtr) lockedLevel = NaN;

    // Arm once price is far enough away to make a return meaningful.
    if (distClose >= a * approachAtr) approached = true;

    if (!approached || Number.isFinite(lockedLevel)) continue;

    const cameFromAbove = bars[i - 1].c > L;
    const reached = cameFromAbove ? b.l <= L + tol : b.h >= L - tol;
    if (!reached) continue;

    if (cameFromAbove) {
      if (b.c > L + tol * 0.5) events.push({ i, dir: 1, kind: 'reject', level: L });
      else if (b.c < L - a * breakAtr) events.push({ i, dir: -1, kind: 'break', level: L });
      else continue;
    } else {
      if (b.c < L - tol * 0.5) events.push({ i, dir: -1, kind: 'reject', level: L });
      else if (b.c > L + a * breakAtr) events.push({ i, dir: 1, kind: 'break', level: L });
      else continue;
    }

    lockedLevel = L;
    approached = false;
  }
  return events;
}

/**
 * How often price turned at a level, measured without reference to any trade.
 *
 * `respect` is the share of arrivals that were pushed back rather than passing
 * through. A level nobody watches sits near 50%; anything meaningfully above
 * is the market treating it as a boundary. This is deliberately separate from
 * profitability — a level can be respected and still not be tradeable once
 * targets and costs are applied, and the two questions deserve separate
 * answers.
 */
function respectRate(events) {
  const rejects = events.filter(e => e.kind === 'reject').length;
  return {
    tests: events.length,
    rejects,
    breaks: events.length - rejects,
    respect: events.length ? (100 * rejects) / events.length : NaN,
  };
}

module.exports = { levelTestEvents, respectRate };
