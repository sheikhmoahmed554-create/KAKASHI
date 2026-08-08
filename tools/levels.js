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

/**
 * A level that has been tested and rejected more than once.
 *
 * The signal here is the failure, not the level. Price reaches a prior high,
 * cannot close through it, leaves, comes back, and fails again — that second
 * refusal is what makes the level worth trading. A double top is the plain
 * name for it.
 *
 * Two things separate this from a touch count. A test requires price to
 * actually reach the level and be pushed back, not merely come near it. And
 * the tests must be separated: price has to leave by `awayAtr` and stay away
 * for `minGap` bars, otherwise a single long stall at the level would count as
 * a dozen rejections.
 */
function failedRetestLevels(bars, opts = {}) {
  const left = opts.left ?? 30;
  const right = opts.right ?? 30;
  const side = opts.side ?? 'high';
  const minFails = opts.minFails ?? 2;
  const tolFrac = opts.tolFrac ?? 0.25;
  const awayAtr = opts.awayAtr ?? 1.0;
  const minGap = opts.minGap ?? 10;
  const maxAge = opts.maxAge ?? 6000;
  const maxPool = opts.maxPool ?? 60;
  const atr = opts.atr;

  const { highs, lows } = pivots(bars, left, right);
  const raw = side === 'high' ? highs : lows;
  const byKnown = new Map();
  for (const p of raw) {
    if (!byKnown.has(p.knownAt)) byKnown.set(p.knownAt, []);
    byKnown.get(p.knownAt).push(p);
  }

  const line = new Array(bars.length).fill(NaN);
  const fails = new Array(bars.length).fill(0);
  let pool = [];

  for (let i = 0; i < bars.length; i++) {
    const born = byKnown.get(i);
    if (born) for (const p of born) pool.push({ price: p.price, fails: 0, born: i, lastFail: -1e9, away: true });
    if (pool.length > maxPool) pool = pool.slice(-maxPool);

    const a = atr[i];
    if (!Number.isFinite(a) || !pool.length) continue;
    const tol = a * tolFrac;
    const b = bars[i];

    for (const lv of pool) {
      if (side === 'high') {
        // Reached it and was refused: the wick got there, the close did not.
        const reached = b.h >= lv.price - tol;
        const refused = b.c < lv.price - tol * 0.5;
        if (reached && refused && lv.away && i - lv.lastFail >= minGap) {
          lv.fails++;
          lv.lastFail = i;
          lv.away = false;
        }
        if (b.c < lv.price - a * awayAtr) lv.away = true;
        if (b.c > lv.price + tol) lv.dead = true;          // finally broken
      } else {
        const reached = b.l <= lv.price + tol;
        const refused = b.c > lv.price + tol * 0.5;
        if (reached && refused && lv.away && i - lv.lastFail >= minGap) {
          lv.fails++;
          lv.lastFail = i;
          lv.away = false;
        }
        if (b.c > lv.price + a * awayAtr) lv.away = true;
        if (b.c < lv.price - tol) lv.dead = true;
      }
      if (i - lv.born > maxAge) lv.dead = true;
    }
    pool = pool.filter(lv => !lv.dead);

    let best = null, bestDist = Infinity;
    for (const lv of pool) {
      if (lv.fails < minFails) continue;
      if (side === 'high' && lv.price < b.c) continue;
      if (side === 'low' && lv.price > b.c) continue;
      const d = Math.abs(b.c - lv.price);
      if (d < bestDist) { bestDist = d; best = lv; }
    }
    if (best) { line[i] = best.price; fails[i] = best.fails; }
  }
  return { line, fails };
}

/* ───────────────────────────────────────────────────────────────────────────
 * Institutional footprints.
 *
 * Nothing here sees an institution's orders — this feed has no order flow and
 * no depth. What it has is volume and range per candle, and three patterns
 * that large participation tends to leave behind. Whether gold actually
 * respects them is a measurement, not a claim.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Absorption: heavy volume that barely moved price. Size was filled without
 * the market having to travel, which is what a large resting bid or offer
 * looks like from the outside.
 */
function absorptionLevels(bars, opts = {}) {
  const look = opts.look ?? 240;
  const volPct = opts.volPct ?? 0.90;      // volume this high in its own window
  const rangePct = opts.rangePct ?? 0.40;  // range this low in its own window
  const maxAge = opts.maxAge ?? 3000;
  const maxPool = opts.maxPool ?? 40;
  const atr = opts.atr;
  const out = new Array(bars.length).fill(NaN);
  let pool = [];

  for (let i = look; i < bars.length; i++) {
    const win = bars.slice(i - look, i);
    const vols = win.map(b => (Number.isFinite(b.v) ? b.v : 0)).sort((a, b) => a - b);
    const rngs = win.map(b => b.h - b.l).sort((a, b) => a - b);
    const vCut = vols[Math.floor(vols.length * volPct)];
    const rCut = rngs[Math.floor(rngs.length * rangePct)];
    const b = bars[i];
    const v = Number.isFinite(b.v) ? b.v : 0;
    if (v >= vCut && (b.h - b.l) <= rCut && vCut > 0) {
      pool.push({ px: (b.h + b.l) / 2, born: i });
      if (pool.length > maxPool) pool.shift();
    }
    const a = atr[i];
    pool = pool.filter(z => i - z.born <= maxAge && (!Number.isFinite(a) || Math.abs(b.c - z.px) < a * 60));
    let best = NaN, bd = Infinity;
    for (const z of pool) {
      const d = Math.abs(b.c - z.px);
      if (d < bd) { bd = d; best = z.px; }
    }
    out[i] = best;
    i += opts.stride ?? 0;
  }
  return { line: out };
}

/**
 * The price where the most volume changed hands over a trailing window. Recomputed
 * every `step` bars rather than every bar, because a profile that shifts on
 * every candle is a moving average again, and the whole point is a level that
 * holds still.
 */
function volumeNodeLevels(bars, opts = {}) {
  const look = opts.look ?? 1440;
  const step = opts.step ?? 60;
  const buckets = opts.buckets ?? 120;
  const out = new Array(bars.length).fill(NaN);
  let poc = NaN;
  for (let i = 0; i < bars.length; i++) {
    if (i >= look && i % step === 0) {
      let lo = Infinity, hi = -Infinity;
      for (let k = i - look; k < i; k++) { if (bars[k].l < lo) lo = bars[k].l; if (bars[k].h > hi) hi = bars[k].h; }
      if (hi > lo) {
        const width = (hi - lo) / buckets;
        const hist = new Float64Array(buckets);
        for (let k = i - look; k < i; k++) {
          const b = bars[k];
          const v = Number.isFinite(b.v) && b.v > 0 ? b.v : 1;
          const idx = Math.min(buckets - 1, Math.max(0, Math.floor(((b.h + b.l + b.c) / 3 - lo) / width)));
          hist[idx] += v;
        }
        let bi = 0;
        for (let q = 1; q < buckets; q++) if (hist[q] > hist[bi]) bi = q;
        poc = lo + (bi + 0.5) * width;
      }
    }
    out[i] = poc;
  }
  return { line: out };
}

/**
 * Order block: the last candle against the move, immediately before a
 * displacement large enough to look deliberate. The retail reading is that
 * this is where size was filled before the push.
 */
function orderBlockLevels(bars, opts = {}) {
  const dispAtr = opts.dispAtr ?? 2.0;
  const lookback = opts.lookback ?? 12;
  const maxAge = opts.maxAge ?? 3000;
  const maxPool = opts.maxPool ?? 40;
  const atr = opts.atr;
  const out = new Array(bars.length).fill(NaN);
  let pool = [];

  for (let i = 3; i < bars.length; i++) {
    const a = atr[i];
    if (!Number.isFinite(a) || a <= 0) continue;
    const body = bars[i].c - bars[i].o;
    if (Math.abs(body) >= a * dispAtr) {
      const wantDown = body > 0;                 // bullish push: find the last down candle
      for (let k = 1; k <= lookback && i - k >= 0; k++) {
        const p = bars[i - k];
        const isDown = p.c < p.o;
        if (isDown === wantDown) {
          pool.push({ px: (p.o + p.c) / 2, born: i, up: wantDown });
          if (pool.length > maxPool) pool.shift();
          break;
        }
      }
    }
    const b = bars[i];
    pool = pool.filter(z => i - z.born <= maxAge &&
      (z.up ? b.c > z.px - a * 2 : b.c < z.px + a * 2));
    let best = NaN, bd = Infinity;
    for (const z of pool) {
      const d = Math.abs(b.c - z.px);
      if (d < bd) { bd = d; best = z.px; }
    }
    out[i] = best;
  }
  return { line: out };
}

/* ───────────────────────────────────────────────────────────────────────────
 * Sloped levels.
 *
 * Everything above is horizontal. A trendline is the one level that moves —
 * and moves with a reason, since every point on it is fixed by two real
 * pivots. That is the distinction worth keeping: a moving average moves
 * because time passed, a trendline moves because the market drew it.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The most recent valid trendline, extended to the current bar.
 *
 * Anchored on two confirmed pivots sloping the right way, and only kept if
 * nothing between them pierced it — a line price already broke is not a line.
 * It dies once a close gets through by more than `breakAtr`, and it is only
 * quoted while price is on the side it is supposed to hold.
 */
function trendLineLevels(bars, opts = {}) {
  const left = opts.left ?? 25;
  const right = opts.right ?? 25;
  const side = opts.side ?? 'down';        // 'down' joins falling highs
  const maxSpan = opts.maxSpan ?? 3000;
  const minSpan = opts.minSpan ?? 60;
  const breakAtr = opts.breakAtr ?? 0.5;
  const maxProject = opts.maxProject ?? 2000;
  const atr = opts.atr;

  const { highs, lows } = pivots(bars, left, right);
  const anchors = side === 'down' ? highs : lows;
  const byKnown = new Map();
  for (const p of anchors) {
    if (!byKnown.has(p.knownAt)) byKnown.set(p.knownAt, []);
    byKnown.get(p.knownAt).push(p);
  }

  const out = new Array(bars.length).fill(NaN);
  const seen = [];
  let active = null;

  for (let i = 0; i < bars.length; i++) {
    const born = byKnown.get(i);
    if (born) {
      for (const p of born) {
        // Pair the new pivot with the most recent earlier one that slopes the
        // right way and whose connecting line was never pierced between them.
        for (let k = seen.length - 1; k >= 0; k--) {
          const q = seen[k];
          const span = p.bar - q.bar;
          if (span < minSpan) continue;
          if (span > maxSpan) break;
          if (side === 'down' && !(p.price < q.price)) continue;
          if (side === 'up' && !(p.price > q.price)) continue;
          const slope = (p.price - q.price) / span;
          let clean = true;
          for (let j = q.bar; j <= p.bar; j++) {
            const y = q.price + slope * (j - q.bar);
            if (side === 'down' ? bars[j].h > y + (atr[j] || 0) * 0.3
                                : bars[j].l < y - (atr[j] || 0) * 0.3) { clean = false; break; }
          }
          if (!clean) continue;
          active = { x0: q.bar, y0: q.price, slope, born: i };
          break;
        }
        seen.push(p);
        if (seen.length > 200) seen.shift();
      }
    }

    if (!active) continue;
    const y = active.y0 + active.slope * (i - active.x0);
    const a = atr[i] || 0;
    if (i - active.born > maxProject) { active = null; continue; }
    if (side === 'down' ? bars[i].c > y + a * breakAtr : bars[i].c < y - a * breakAtr) { active = null; continue; }
    out[i] = y;
  }
  return { line: out };
}

/** Today's opening price — the reference every intraday desk marks from. */
function dailyOpenLevels(bars) {
  const out = new Array(bars.length).fill(NaN);
  const dayOf = t => Math.floor(t / 86400000);
  let curDay = dayOf(bars[0].t), open = bars[0].c;
  for (let i = 0; i < bars.length; i++) {
    const d = dayOf(bars[i].t);
    if (d !== curDay) { curDay = d; open = bars[i].o; }
    out[i] = open;
  }
  return { line: out };
}

/**
 * Classic floor-trader pivots from yesterday's range, nearest level to price.
 * Their claim to work is circular — enough people watch them that they matter —
 * which makes them worth measuring rather than dismissing.
 */
function classicPivotLevels(bars) {
  const out = new Array(bars.length).fill(NaN);
  const dayOf = t => Math.floor(t / 86400000);
  let curDay = dayOf(bars[0].t);
  let h = -Infinity, l = Infinity, c = NaN, set = null;
  for (let i = 0; i < bars.length; i++) {
    const d = dayOf(bars[i].t);
    if (d !== curDay) {
      if (Number.isFinite(c) && h > -Infinity) {
        const pp = (h + l + c) / 3;
        set = [pp, 2 * pp - l, 2 * pp - h, pp + (h - l), pp - (h - l)];
      }
      curDay = d; h = -Infinity; l = Infinity;
    }
    if (set) {
      let best = NaN, bd = Infinity;
      for (const px of set) {
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

/**
 * A level that broke and changed sides: resistance that price closed above
 * becomes support, and the other way round. The break is what qualifies it.
 */
function roleReversalLevels(bars, opts = {}) {
  const left = opts.left ?? 20;
  const right = opts.right ?? 20;
  const breakAtr = opts.breakAtr ?? 0.5;
  const maxAge = opts.maxAge ?? 4000;
  const maxPool = opts.maxPool ?? 40;
  const atr = opts.atr;
  const { highs, lows } = pivots(bars, left, right);
  const byKnown = new Map();
  for (const p of [...highs.map(x => ({ ...x, was: 'res' })), ...lows.map(x => ({ ...x, was: 'sup' }))]) {
    if (!byKnown.has(p.knownAt)) byKnown.set(p.knownAt, []);
    byKnown.get(p.knownAt).push(p);
  }
  const out = new Array(bars.length).fill(NaN);
  let pending = [], flipped = [];
  for (let i = 0; i < bars.length; i++) {
    const born = byKnown.get(i);
    if (born) for (const p of born) pending.push({ px: p.price, was: p.was, born: i });
    const a = atr[i] || 0;
    const b = bars[i];
    for (const p of pending) {
      if (p.was === 'res' && b.c > p.px + a * breakAtr) { p.done = true; flipped.push({ px: p.px, born: i }); }
      if (p.was === 'sup' && b.c < p.px - a * breakAtr) { p.done = true; flipped.push({ px: p.px, born: i }); }
      if (i - p.born > maxAge) p.done = true;
    }
    pending = pending.filter(p => !p.done);
    if (pending.length > maxPool) pending = pending.slice(-maxPool);
    flipped = flipped.filter(p => i - p.born <= maxAge);
    if (flipped.length > maxPool) flipped = flipped.slice(-maxPool);
    let best = NaN, bd = Infinity;
    for (const p of flipped) {
      const d = Math.abs(b.c - p.px);
      if (d < bd) { bd = d; best = p.px; }
    }
    out[i] = best;
  }
  return { line: out };
}

module.exports = {
  pivots, swingLevels, fibLevels, previousDayLevels,
  sessionRangeLevels, roundNumberLevels, vwapLevels, fvgLevels,
  failedRetestLevels, absorptionLevels, volumeNodeLevels, orderBlockLevels,
  trendLineLevels, dailyOpenLevels, classicPivotLevels, roleReversalLevels,
};
