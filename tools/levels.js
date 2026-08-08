'use strict';
/*
 * Eight kinds of level, one per signal source.
 *
 * The problem with the V12 design is not that it has eight sources — it is
 * that all eight are the same moving average at different speeds, so they sit
 * on top of each other and fire on the same candle at the same price. Eight
 * correlated opinions cost eight spreads and carry one opinion's worth of
 * information.
 *
 * Each generator here returns a series aligned to the 1m bars: the price of
 * the nearest active level of that kind. That series drops straight into the
 * existing rejection/breakout engine, so the machinery around it — slots,
 * cooldowns, targets, stats — is unchanged. Only the thing being watched
 * differs, and these levels sit in genuinely different places.
 *
 * Every generator is causal: a level is only visible on bars after the
 * information that defines it was complete.
 */

/** Confirmed pivots. A pivot at i is only known at i + right. */
function pivots(bars, left, right) {
  const highs = [], lows = [];
  for (let i = left; i < bars.length - right; i++) {
    let isHigh = true, isLow = true;
    for (let k = 1; k <= left; k++) {
      if (bars[i - k].h >= bars[i].h) isHigh = false;
      if (bars[i - k].l <= bars[i].l) isLow = false;
    }
    for (let k = 1; k <= right; k++) {
      if (bars[i + k].h > bars[i].h) isHigh = false;
      if (bars[i + k].l < bars[i].l) isLow = false;
    }
    if (isHigh) highs.push({ bar: i, knownAt: i + right, price: bars[i].h });
    if (isLow) lows.push({ bar: i, knownAt: i + right, price: bars[i].l });
  }
  return { highs, lows };
}

/**
 * Swing levels scored by how often price came back and respected them, which
 * is the user's rule: a line three lows have touched is a line worth trading.
 * A level joins the pool when confirmed, gains a touch each time price returns
 * to within `tol` without closing through, and is dropped once price closes
 * decisively beyond it.
 */
function swingLevels(bars, opts = {}) {
  const left = opts.left ?? 20;
  const right = opts.right ?? 20;
  const side = opts.side ?? 'low';
  const minTouches = opts.minTouches ?? 2;
  const tolFrac = opts.tolFrac ?? 0.15;      // tolerance as a fraction of ATR
  const atr = opts.atr;
  const maxAge = opts.maxAge ?? 5000;

  const { highs, lows } = pivots(bars, left, right);
  const raw = side === 'low' ? lows : highs;
  const byKnown = new Map();
  for (const p of raw) {
    if (!byKnown.has(p.knownAt)) byKnown.set(p.knownAt, []);
    byKnown.get(p.knownAt).push(p);
  }

  const out = new Array(bars.length).fill(NaN);
  const touches = new Array(bars.length).fill(0);
  let pool = [];

  for (let i = 0; i < bars.length; i++) {
    const born = byKnown.get(i);
    if (born) for (const p of born) pool.push({ price: p.price, touches: 1, born: i });

    const a = atr[i];
    if (!Number.isFinite(a) || !pool.length) continue;
    const tol = a * tolFrac;
    const b = bars[i];

    for (const lv of pool) {
      // A touch is a wick reaching the level while the body stays on its side.
      if (side === 'low') {
        if (b.l <= lv.price + tol && b.l >= lv.price - tol * 3 && Math.min(b.o, b.c) >= lv.price - tol) lv.touches++;
        if (b.c < lv.price - tol * 2) lv.dead = true;
      } else {
        if (b.h >= lv.price - tol && b.h <= lv.price + tol * 3 && Math.max(b.o, b.c) <= lv.price + tol) lv.touches++;
        if (b.c > lv.price + tol * 2) lv.dead = true;
      }
      if (i - lv.born > maxAge) lv.dead = true;
    }
    pool = pool.filter(lv => !lv.dead);

    // The line is the nearest level that has earned enough touches, taken from
    // the side that can actually act as support or resistance right now.
    let best = null, bestDist = Infinity;
    for (const lv of pool) {
      if (lv.touches < minTouches) continue;
      if (side === 'low' && lv.price > b.c) continue;
      if (side === 'high' && lv.price < b.c) continue;
      const d = Math.abs(b.c - lv.price);
      if (d < bestDist) { bestDist = d; best = lv; }
    }
    if (best) { out[i] = best.price; touches[i] = best.touches; }
  }
  return { line: out, touches };
}

/** Retracements of the most recent confirmed swing, nearest ratio to price. */
function fibLevels(bars, opts = {}) {
  const left = opts.left ?? 60;
  const right = opts.right ?? 60;
  const ratios = opts.ratios ?? [0.382, 0.5, 0.618, 0.786];
  const { highs, lows } = pivots(bars, left, right);
  const events = [...highs.map(p => ({ ...p, kind: 'h' })), ...lows.map(p => ({ ...p, kind: 'l' }))]
    .sort((a, b) => a.knownAt - b.knownAt);

  const out = new Array(bars.length).fill(NaN);
  let lastHigh = null, lastLow = null, e = 0;
  for (let i = 0; i < bars.length; i++) {
    while (e < events.length && events[e].knownAt <= i) {
      if (events[e].kind === 'h') lastHigh = events[e]; else lastLow = events[e];
      e++;
    }
    if (!lastHigh || !lastLow) continue;
    const hi = lastHigh.price, lo = lastLow.price;
    if (!(hi > lo)) continue;
    const span = hi - lo;
    let best = NaN, bestDist = Infinity;
    for (const r of ratios) {
      // Direction of the leg decides which end the retracement measures from.
      const px = lastHigh.bar > lastLow.bar ? hi - span * r : lo + span * r;
      const d = Math.abs(bars[i].c - px);
      if (d < bestDist) { bestDist = d; best = px; }
    }
    out[i] = best;
  }
  return { line: out };
}

/** Yesterday's high, low and close — whichever sits nearest to price. */
function previousDayLevels(bars) {
  const out = new Array(bars.length).fill(NaN);
  const dayOf = t => Math.floor(t / 86400000);
  let curDay = dayOf(bars[0].t);
  let h = -Infinity, l = Infinity, c = NaN;
  let prev = null;
  for (let i = 0; i < bars.length; i++) {
    const d = dayOf(bars[i].t);
    if (d !== curDay) {
      prev = Number.isFinite(c) ? { h, l, c } : prev;
      curDay = d; h = -Infinity; l = Infinity;
    }
    if (prev) {
      let best = NaN, bd = Infinity;
      for (const px of [prev.h, prev.l, prev.c]) {
        const dd = Math.abs(bars[i].c - px);
        if (dd < bd) { bd = dd; best = px; }
      }
      out[i] = best;
    }
    h = Math.max(h, bars[i].h);
    l = Math.min(l, bars[i].l);
    c = bars[i].c;
  }
  return { line: out };
}

/** High and low of a session window, usable only once that session has closed. */
function sessionRangeLevels(bars, opts = {}) {
  const startH = opts.startHour ?? 0;
  const endH = opts.endHour ?? 7;
  const out = new Array(bars.length).fill(NaN);
  const dayOf = t => Math.floor(t / 86400000);
  let curDay = dayOf(bars[0].t);
  let hi = -Infinity, lo = Infinity, ready = null;
  for (let i = 0; i < bars.length; i++) {
    const d = new Date(bars[i].t);
    const day = dayOf(bars[i].t);
    const hour = d.getUTCHours();
    if (day !== curDay) { curDay = day; hi = -Infinity; lo = Infinity; ready = null; }
    if (hour >= startH && hour < endH) {
      hi = Math.max(hi, bars[i].h);
      lo = Math.min(lo, bars[i].l);
    } else if (hour >= endH && ready === null && hi > -Infinity) {
      ready = { hi, lo };
    }
    if (ready) {
      out[i] = Math.abs(bars[i].c - ready.hi) < Math.abs(bars[i].c - ready.lo) ? ready.hi : ready.lo;
    }
  }
  return { line: out };
}

/** The nearest round number. Gold turns at these far more than chance allows. */
function roundNumberLevels(bars, opts = {}) {
  const step = opts.step ?? 10;
  const out = new Array(bars.length).fill(NaN);
  for (let i = 0; i < bars.length; i++) out[i] = Math.round(bars[i].c / step) * step;
  return { line: out };
}

/** Session-anchored VWAP, with a time-weighted fallback when volume is absent. */
function vwapLevels(bars) {
  const out = new Array(bars.length).fill(NaN);
  const dayOf = t => Math.floor(t / 86400000);
  let curDay = dayOf(bars[0].t), pv = 0, vol = 0;
  for (let i = 0; i < bars.length; i++) {
    const d = dayOf(bars[i].t);
    if (d !== curDay) { curDay = d; pv = 0; vol = 0; }
    const v = Number.isFinite(bars[i].v) && bars[i].v > 0 ? bars[i].v : 1;
    pv += ((bars[i].h + bars[i].l + bars[i].c) / 3) * v;
    vol += v;
    out[i] = pv / vol;
  }
  return { line: out };
}

/**
 * Fair value gaps: a three-candle window where the middle candle moved far
 * enough that the outer two do not overlap. The untouched middle is what price
 * tends to come back for.
 */
function fvgLevels(bars, opts = {}) {
  const minAtrFrac = opts.minAtrFrac ?? 0.5;
  const atr = opts.atr;
  const maxAge = opts.maxAge ?? 3000;
  const out = new Array(bars.length).fill(NaN);
  let pool = [];
  for (let i = 2; i < bars.length; i++) {
    const a = atr[i];
    if (Number.isFinite(a)) {
      const upGap = bars[i].l - bars[i - 2].h;
      const dnGap = bars[i - 2].l - bars[i].h;
      if (upGap >= a * minAtrFrac) pool.push({ px: (bars[i].l + bars[i - 2].h) / 2, born: i, up: true });
      if (dnGap >= a * minAtrFrac) pool.push({ px: (bars[i].h + bars[i - 2].l) / 2, born: i, up: false });
    }
    pool = pool.filter(g => i - g.born <= maxAge &&
      !(g.up ? bars[i].c < g.px - (atr[i] || 0) : bars[i].c > g.px + (atr[i] || 0)));
    let best = NaN, bd = Infinity;
    for (const g of pool) {
      const d = Math.abs(bars[i].c - g.px);
      if (d < bd) { bd = d; best = g.px; }
    }
    out[i] = best;
  }
  return { line: out };
}

module.exports = {
  pivots, swingLevels, fibLevels, previousDayLevels,
  sessionRangeLevels, roundNumberLevels, vwapLevels, fvgLevels,
};
