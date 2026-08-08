'use strict';
/*
 * Rising trendline joining higher lows — rebuilt.
 *
 * The falling trendline earns +12.58 on 15m candles with the same generator,
 * while the rising one is negative almost everywhere. That asymmetry is the
 * whole story, and it is not "up lines do not work". Three things are wrong
 * with the way the rising line is currently drawn:
 *
 *   1. It is drawn on the wrong timeframe. A low with ten 1m bars either side
 *      is a ten-minute dip.
 *
 *   2. It is kept alive for far too long. maxProject is 2000 bars measured
 *      from the moment the second anchor is confirmed, which on 15m candles is
 *      three weeks of extrapolation from two points. A rising support line in
 *      a falling market is a line price walks away from downwards; the longer
 *      it is projected the further below price it sits, and every "test" of it
 *      is really a test of nothing.
 *
 *   3. The pierce tolerance between the anchors is 0.3 ATR, so lows may dip
 *      through the line and it still counts as clean. A support line that
 *      price has already traded below is not support.
 *
 * And the measurement is wrong in the way every level here is measured wrong:
 * a 90 point target with a 90 point stop, on a level whose actual excursion is
 * nothing like that size.
 *
 * Everything below is written so the numbers are directly comparable to
 * tools/sweep_timeframes.js — same loader, same race(), same direction
 * adjustment, same levelTestEvents detector — except where a change is stated
 * explicitly and measured on both sides.
 *
 * Usage:
 *   node --max-old-space-size=3500 tools/fixes/rising-trendline.js base
 *   node --max-old-space-size=3500 tools/fixes/rising-trendline.js causal
 *   node --max-old-space-size=3500 tools/fixes/rising-trendline.js tf
 *   node --max-old-space-size=3500 tools/fixes/rising-trendline.js knobs
 *   node --max-old-space-size=3500 tools/fixes/rising-trendline.js excursion
 *   node --max-old-space-size=3500 tools/fixes/rising-trendline.js targets
 *   node --max-old-space-size=3500 tools/fixes/rising-trendline.js final
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('../ai963_engine');
const LV = require('../levels');
const { levelTestEvents, respectRate } = require('../level_events');

// ── constants, identical to tools/sweep_timeframes.js ────────────────────────
const PU = 0.10, COST = 0.5, MAX_HOLD = 1440;
const TP0 = 90, SL0 = 90;                 // the 90/90 everything was forced onto
const RANDOM_RESPECT = 68.95;
const TIMEFRAMES = [1, 5, 15, 60, 240, 1440];
const TF_NAME = { 1: '1m', 5: '5m', 15: '15m', 60: '1H', 240: '4H', 1440: 'D' };

// ── loader, copied from tools/sweep_timeframes.js ────────────────────────────
function loadBars() {
  const html = fs.readFileSync(
    path.join(__dirname, '..', '..', 'KAKASHI_V16_TV_PARITY_AUDIT.html'), 'utf8');
  const csv = zlib.gunzipSync(
    Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1], 'base64')).toString('utf8');
  const lines = csv.split('\n');
  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const a = lines[i].split(',');
    const t = Date.parse(a[0].replace(' ', 'T'));
    const c = +a[4];
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
    bars.push({ t, o: +a[1], h: +a[2], l: +a[3], c, v: +a[5] });
  }
  return bars.sort((x, y) => x.t - y.t);
}

const bars = loadBars();
const atr1 = E.atr(bars, 14);
const N = bars.length;

// ── trade simulation, copied, but with the target/stop made a parameter ──────
function race(i, dir, tp, sl, maxHold) {
  const e = bars[i].c, tpx = e + dir * tp * PU, slx = e - dir * sl * PU;
  const end = Math.min(N - 1, i + maxHold);
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    const ht = dir === 1 ? b.h >= tpx : b.l <= tpx;
    const hs = dir === 1 ? b.l <= slx : b.h >= slx;
    if (ht && hs) return null;          // ambiguous inside one candle
    if (ht) return tp - COST;
    if (hs) return -sl - COST;
  }
  return (bars[end].c - e) * dir / PU - COST;
}

function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/*
 * The blind baseline is a function of the target and the stop. Every time the
 * target changes, the thing a result has to beat changes with it — a 20 point
 * target in a falling market has a different blind-short edge than a 90 point
 * one. Re-deriving it per (tp, sl, hold) is the only honest way to compare
 * across target sizes.
 */
const BLIND = new Map();
function blind(dir, tp, sl, maxHold, n = 40000) {
  const key = `${dir}|${tp}|${sl}|${maxHold}|${n}`;
  if (BLIND.has(key)) return BLIND.get(key);
  const r = rng(dir === 1 ? 31337 : 73331);
  let c = 0, net = 0;
  const lo = 100, hi = N - maxHold - 2;
  for (let k = 0; k < n; k++) {
    const p = race(lo + Math.floor(r() * (hi - lo)), dir, tp, sl, maxHold);
    if (p === null) continue;
    c++; net += p;
  }
  const v = net / c;
  BLIND.set(key, v);
  return v;
}

function score(events, tp = TP0, sl = SL0, maxHold = MAX_HOLD, blindN = 40000) {
  const r = respectRate(events);
  const bl = blind(1, tp, sl, maxHold, blindN);
  const bs = blind(-1, tp, sl, maxHold, blindN);
  let ln = 0, lnet = 0, sn = 0, snet = 0, nulls = 0;
  for (const e of events) {
    const p = race(e.i, e.dir, tp, sl, maxHold);
    if (p === null) { nulls++; continue; }
    if (e.dir === 1) { ln++; lnet += p; } else { sn++; snet += p; }
  }
  const tot = ln + sn;
  const la = ln ? lnet / ln - bl : 0;
  const sa = sn ? snet / sn - bs : 0;
  return {
    ...r, nulls, longs: ln, shorts: sn, traded: tot,
    longAlpha: ln ? lnet / ln - bl : NaN,
    shortAlpha: sn ? snet / sn - bs : NaN,
    shortShare: tot ? (100 * sn) / tot : NaN,
    raw: tot ? (lnet + snet) / tot : NaN,
    alpha: tot ? (la * ln + sa * sn) / tot : NaN,
  };
}

// ── resample cache ───────────────────────────────────────────────────────────
const TF = new Map();
function tf(m) {
  if (!TF.has(m)) {
    const { bars: b, index } = E.resample(bars, m);
    TF.set(m, { bars: b, index, atr: E.atr(b, 14) });
  }
  return TF.get(m);
}
function project(minutes, build) {
  const { bars: b, index, atr } = tf(minutes);
  const raw = build(b, atr);
  if (minutes === 1) return raw;
  if (Array.isArray(raw)) return E.projectConfirmed(raw, index);
  const out = {};
  for (const k of Object.keys(raw)) out[k] = E.projectConfirmed(raw[k], index);
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
//  The rebuilt generator.
// ═════════════════════════════════════════════════════════════════════════════
/*
 * A rising trendline is two confirmed higher lows and the ray through them.
 * The knobs that matter, and why each one exists:
 *
 *   left / right     what counts as a swing low. `right` is also the delay:
 *                    the pivot is invisible until `right` bars after it.
 *   minSpan/maxSpan  how far apart the two anchors may be, in candles.
 *   pierceAtr        how far a low between the anchors may dip below the ray
 *                    and the ray still counts as untouched support. The old
 *                    value, 0.3 ATR, admits lines price has already broken.
 *   maxSlopeAtr      a cap on rise per candle, in ATR. A near-vertical line
 *                    leaves price behind within hours and every later "test"
 *                    of it is meaningless.
 *   maxProject       how many candles past the second anchor the ray stays
 *                    alive. The old value, 2000, is three weeks on 15m.
 *   breakAtr         how decisively a close below the ray kills it.
 *   killOnBreak      whether the first clean break ends the line at all.
 *   graceBars        after a break, how long the line stays dead before the
 *                    generator is allowed to draw a new one (0 = immediately).
 *   confirmTouches   require the ray to be respected this many times after
 *                    birth before it is published. A line two points define is
 *                    a guess; a line price has already turned at once is a
 *                    level.
 *   pick             which earlier pivot to pair the new one with.
 *
 * Causality: a pivot enters `seen` at knownAt = bar + right, the ray is born
 * on that same index from two anchors both strictly in the past, and the
 * published value at bar i is the ray evaluated at i. Nothing reads forward.
 * Verified numerically by the `causal` stage.
 */
function risingTrendline(hbars, atr, o = {}) {
  const left = o.left ?? 10;
  const right = o.right ?? 10;
  const minSpan = o.minSpan ?? 60;
  const maxSpan = o.maxSpan ?? 3000;
  const pierceAtr = o.pierceAtr ?? 0.3;
  const maxSlopeAtr = o.maxSlopeAtr ?? Infinity;   // rise per candle, in ATR
  const minSlopeAtr = o.minSlopeAtr ?? 0;
  const maxProject = o.maxProject ?? 2000;
  const breakAtr = o.breakAtr ?? 0.5;
  const killOnBreak = o.killOnBreak ?? true;
  const graceBars = o.graceBars ?? 0;
  const confirmTouches = o.confirmTouches ?? 0;
  const touchAtr = o.touchAtr ?? 0.25;
  const candCap = o.candCap ?? 60;
  const pick = o.pick ?? 'recent';                 // recent | far | flattest

  const n = hbars.length;
  const { lows } = LV.pivots(hbars, left, right);
  const byKnown = new Map();
  for (const p of lows) {
    if (!byKnown.has(p.knownAt)) byKnown.set(p.knownAt, []);
    byKnown.get(p.knownAt).push(p);
  }

  const line = new Array(n).fill(NaN);
  const id = new Array(n).fill(-1);       // which ray each published value belongs to
  const seen = [];
  let active = null, nextId = 0, deadUntil = -1;

  for (let i = 0; i < n; i++) {
    const born = byKnown.get(i);
    if (born) {
      for (const p of born) {
        if (i >= deadUntil) {
          // Candidate earlier lows, most recent first. `seen` is ordered by
          // bar, so walking backwards makes span grow monotonically.
          let best = null, bestKey = Infinity, tried = 0;
          for (let k = seen.length - 1; k >= 0 && tried < candCap; k--) {
            const q = seen[k];
            const span = p.bar - q.bar;
            if (span < minSpan) continue;
            if (span > maxSpan) break;
            tried++;
            if (!(p.price > q.price)) continue;          // must be a HIGHER low
            const slope = (p.price - q.price) / span;
            const aRef = atr[p.bar] || atr[q.bar] || 0;
            if (aRef > 0) {
              const sa = slope / aRef;
              if (sa > maxSlopeAtr || sa < minSlopeAtr) continue;
            }
            let clean = true;
            for (let j = q.bar; j <= p.bar; j++) {
              const y = q.price + slope * (j - q.bar);
              if (hbars[j].l < y - (atr[j] || 0) * pierceAtr) { clean = false; break; }
            }
            if (!clean) continue;
            const key = pick === 'flattest' ? Math.abs(slope) / (aRef || 1)
                      : pick === 'far'      ? -span
                      : 0;                                  // 'recent': first hit wins
            if (key < bestKey) { best = { q, slope }; bestKey = key; }
            if (pick === 'recent') break;
          }
          if (best) {
            active = {
              x0: best.q.bar, y0: best.q.price, slope: best.slope,
              born: i, id: nextId++, touches: 0,
              lastTouch: -1, published: confirmTouches === 0,
            };
          }
        }
        seen.push(p);
        if (seen.length > 400) seen.shift();
      }
    }

    if (!active) continue;
    const y = active.y0 + active.slope * (i - active.x0);
    const a = atr[i] || 0;

    if (i - active.born > maxProject) { active = null; continue; }

    // A decisive close below ends the line.
    if (hbars[i].c < y - a * breakAtr) {
      if (killOnBreak) { active = null; deadUntil = i + graceBars; continue; }
    }

    // Count respected touches while the line is still provisional.
    if (!active.published) {
      const touched = hbars[i].l <= y + a * touchAtr && hbars[i].c > y;
      if (touched && i - active.lastTouch > right) {
        active.lastTouch = i;
        if (++active.touches >= confirmTouches) active.published = true;
      }
      continue;                       // not visible yet
    }

    line[i] = y;
    id[i] = active.id;
  }
  return { line, id };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Event detection.
//
//  levelTestEvents is the shared detector and every headline number here uses
//  it unchanged, so the results line up with everyone else's. It resets its
//  state whenever the level value moves more than half an ATR, which is fine
//  for a horizontal level and slightly wrong for a sloping one: a fast ray can
//  re-arm itself purely by drifting. `idTestEvents` is the same logic keyed on
//  the ray's identity instead of its value, and is reported alongside as a
//  cross-check rather than as the headline.
// ═════════════════════════════════════════════════════════════════════════════
function idTestEvents(bars1, line, ids, atr, opts = {}) {
  const tolAtr = opts.tolAtr ?? 0.20;
  const approachAtr = opts.approachAtr ?? 1.5;
  const breakAtr = opts.breakAtr ?? 0.25;
  const resetAtr = opts.resetAtr ?? 1.0;

  const events = [];
  let curId = -1, approached = false, locked = NaN;
  for (let i = 1; i < bars1.length; i++) {
    const L = line[i], a = atr[i];
    if (!Number.isFinite(L) || !Number.isFinite(a) || a <= 0) { continue; }
    const b = bars1[i];
    if (ids[i] !== curId) { curId = ids[i]; approached = false; locked = NaN; }
    const tol = a * tolAtr;
    const d = Math.abs(b.c - L);
    if (Number.isFinite(locked) && Math.abs(b.c - locked) > a * resetAtr) locked = NaN;
    if (d >= a * approachAtr) approached = true;
    if (!approached || Number.isFinite(locked)) continue;
    const above = bars1[i - 1].c > L;
    const reached = above ? b.l <= L + tol : b.h >= L - tol;
    if (!reached) continue;
    if (above) {
      if (b.c > L + tol * 0.5) events.push({ i, dir: 1, kind: 'reject', level: L });
      else if (b.c < L - a * breakAtr) events.push({ i, dir: -1, kind: 'break', level: L });
      else continue;
    } else {
      if (b.c < L - tol * 0.5) events.push({ i, dir: -1, kind: 'reject', level: L });
      else if (b.c > L + a * breakAtr) events.push({ i, dir: 1, kind: 'break', level: L });
      else continue;
    }
    locked = L; approached = false;
  }
  return events;
}

// ── excursion: what does a test of this line actually pay? ───────────────────
function excursion(events, horizons = [60, 240, 1440]) {
  const out = {};
  for (const H of horizons) {
    const mfe = [], mae = [];
    for (const e of events) {
      const entry = bars[e.i].c;
      const end = Math.min(N - 1, e.i + H);
      let f = 0, adv = 0;
      for (let j = e.i + 1; j <= end; j++) {
        const b = bars[j];
        const up = (b.h - entry) / PU, dn = (entry - b.l) / PU;
        if (e.dir === 1) { f = Math.max(f, up); adv = Math.max(adv, dn); }
        else { f = Math.max(f, dn); adv = Math.max(adv, up); }
      }
      mfe.push(f); mae.push(adv);
    }
    out[H] = { mfe: quant(mfe), mae: quant(mae), n: mfe.length };
  }
  return out;
}
function quant(a) {
  const s = a.slice().sort((x, y) => x - y);
  const q = p => s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
  return { p25: q(0.25), med: q(0.50), p75: q(0.75), p90: q(0.90) };
}

// ── filters over an event list ───────────────────────────────────────────────
const ONLY = {
  all:      e => e,
  bounce:   e => e.filter(x => x.kind === 'reject'),
  brk:      e => e.filter(x => x.kind === 'break'),
  // "fade": read a rejection at the rising line as a failure, trade it the
  // other way. In a falling market this is the reading that might be right.
  fade:     e => e.filter(x => x.kind === 'reject').map(x => ({ ...x, dir: -x.dir })),
  brkfade:  e => e.filter(x => x.kind === 'break').map(x => ({ ...x, dir: -x.dir })),
};

const f = (x, d = 2) => Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '—';
const fp = (x, d = 1) => Number.isFinite(x) ? x.toFixed(d) : '—';

// current construction, exactly as tools/sweep_timeframes.js builds it
const CURRENT = (b, a) => LV.trendLineLevels(b, { side: 'up', left: 10, right: 10, atr: a }).line;

// ═════════════════════════════════════════════════════════════════════════════
//  Stages
// ═════════════════════════════════════════════════════════════════════════════
function stageBase() {
  console.log(`${N.toLocaleString()} bars   random respect ${RANDOM_RESPECT}%   ` +
    `blind long ${f(blind(1, TP0, SL0, MAX_HOLD))}  blind short ${f(blind(-1, TP0, SL0, MAX_HOLD))}`);
  console.log('\nCURRENT construction — LV.trendLineLevels side:up left/right 10, 90/90 target\n');
  console.log('tf     tests  rejects  respect%   longs  shorts     raw    ALPHA');
  console.log('─'.repeat(66));
  for (const m of TIMEFRAMES) {
    let s;
    try { s = score(levelTestEvents(bars, project(m, CURRENT), atr1)); }
    catch (err) { s = { tests: 0 }; }
    if (!s.tests) { console.log(TF_NAME[m].padEnd(6) + '     0'); continue; }
    console.log(
      TF_NAME[m].padEnd(6) + String(s.tests).padStart(6) + String(s.rejects).padStart(9) +
      fp(s.respect).padStart(10) + String(s.longs).padStart(8) + String(s.shorts).padStart(8) +
      f(s.raw).padStart(8) + f(s.alpha).padStart(9));
  }
}

function stageCausal() {
  /*
   * A lookahead bug is the one failure mode that produces beautiful numbers, so
   * it gets tested directly rather than argued about. The line is rebuilt from
   * a truncated history — only bars up to and including j — and the value it
   * publishes at j is compared with the value the full-history build published
   * at the same j. If any future bar leaks into the construction the two
   * disagree.
   */
  const m = 15;
  const { bars: hb, atr: ha } = tf(m);
  const opts = { left: 6, right: 6, minSpan: 8, maxSpan: 200, pierceAtr: 0.05,
                 maxProject: 60, breakAtr: 0.25, confirmTouches: 1 };
  const full = risingTrendline(hb, ha, opts);
  const rr = rng(4242);
  let checked = 0, bad = 0, worst = 0;
  for (let k = 0; k < 40; k++) {
    const j = 300 + Math.floor(rr() * (hb.length - 400));
    const cut = hb.slice(0, j + 1);
    const cutAtr = E.atr(cut, 14);
    const part = risingTrendline(cut, cutAtr, opts);
    const a = full.line[j], b = part.line[j];
    const bothNaN = !Number.isFinite(a) && !Number.isFinite(b);
    if (!bothNaN) {
      const d = Math.abs((a || 0) - (b || 0));
      worst = Math.max(worst, Number.isFinite(d) ? d : Infinity);
      if (!(d < 1e-9)) bad++;
    }
    checked++;
  }
  console.log(`causality: ${checked} truncated rebuilds, ${bad} disagreements, ` +
    `max |diff| ${worst.toExponential(2)}`);

  // Second check: the 1m projection must never show a value derived from an
  // HTF candle that has not closed.
  const { index } = tf(m);
  let leak = 0;
  const proj = E.projectConfirmed(full.line, index);
  for (let i = 1; i < N; i += 997) {
    const j = index[i] - 1;
    if (j >= 0 && Number.isFinite(proj[i]) && proj[i] !== full.line[j]) leak++;
    // the HTF bar supplying the value must have ended before this 1m bar began
    if (j >= 0 && hb[j].t + m * 60000 > bars[i].t) leak++;
  }
  console.log(`projection: ${leak} leaks across ${Math.floor(N / 997)} sampled 1m bars`);
}

function run(m, opts, reading = 'all', tp = TP0, sl = SL0, hold = MAX_HOLD, blindN = 40000) {
  const { line, id } = project(m, (b, a) => risingTrendline(b, a, opts));
  const ev = levelTestEvents(bars, line, atr1);
  return { s: score(ONLY[reading](ev), tp, sl, hold, blindN), ev, line, id };
}

function stageTf() {
  console.log('\nREBUILT generator, knobs at their conservative defaults, 90/90 target\n');
  console.log('left/right sweep per timeframe — alpha (tests)\n');
  const LRS = [[3, 3], [5, 5], [10, 10], [20, 20]];
  const head = 'tf    ' + LRS.map(l => `${l[0]}/${l[1]}`.padStart(16)).join('');
  console.log(head); console.log('─'.repeat(head.length));
  for (const m of TIMEFRAMES) {
    let row = TF_NAME[m].padEnd(6);
    for (const [L, R] of LRS) {
      let cell = '—';
      try {
        const { s } = run(m, { left: L, right: R, minSpan: Math.max(3, L),
          maxSpan: 400, pierceAtr: 0.1, maxProject: 200, breakAtr: 0.4 });
        cell = s.tests ? `${f(s.alpha)} (${s.tests})` : '—';
      } catch (e) { cell = 'ERR'; }
      row += cell.padStart(16);
    }
    console.log(row);
  }
}

function stageKnobs() {
  const cfgs = [];
  const base = { left: 5, right: 5, minSpan: 6, maxSpan: 200, pierceAtr: 0.1,
                 maxProject: 200, breakAtr: 0.4, confirmTouches: 0 };
  for (const mp of [20, 40, 60, 100, 200, 2000]) cfgs.push(['maxProject ' + mp, { ...base, maxProject: mp }]);
  for (const pa of [0, 0.05, 0.1, 0.3, 0.6]) cfgs.push(['pierceAtr ' + pa, { ...base, pierceAtr: pa }]);
  for (const ba of [0.1, 0.25, 0.5, 1.0]) cfgs.push(['breakAtr ' + ba, { ...base, breakAtr: ba }]);
  cfgs.push(['no kill on break', { ...base, killOnBreak: false }]);
  for (const g of [10, 30]) cfgs.push(['grace ' + g, { ...base, graceBars: g }]);
  for (const ct of [1, 2]) cfgs.push(['confirmTouches ' + ct, { ...base, confirmTouches: ct }]);
  for (const ms of [0.15, 0.3, 0.6]) cfgs.push(['maxSlopeAtr ' + ms, { ...base, maxSlopeAtr: ms }]);
  for (const p of ['far', 'flattest']) cfgs.push(['pick ' + p, { ...base, pick: p }]);
  for (const sp of [[4, 60], [8, 400], [20, 200]]) cfgs.push(`minSpan ${sp[0]} maxSpan ${sp[1]}`)
    , cfgs[cfgs.length - 1] = [`span ${sp[0]}-${sp[1]}`, { ...base, minSpan: sp[0], maxSpan: sp[1] }];

  const TFS = [15, 60, 240, 1440];
  console.log('\nknob sweep, 90/90 target, alpha (tests)   [base: L/R 5, span 6-200, pierce .1, proj 200, brk .4]\n');
  const head = 'config'.padEnd(22) + TFS.map(m => TF_NAME[m].padStart(16)).join('');
  console.log(head); console.log('─'.repeat(head.length));
  console.log('BASE'.padEnd(22) + TFS.map(m => {
    const { s } = run(m, base); return (s.tests ? `${f(s.alpha)} (${s.tests})` : '—').padStart(16);
  }).join(''));
  for (const [name, o] of cfgs) {
    const row = TFS.map(m => {
      try { const { s } = run(m, o); return (s.tests ? `${f(s.alpha)} (${s.tests})` : '—').padStart(16); }
      catch (e) { return 'ERR'.padStart(16); }
    }).join('');
    console.log(name.padEnd(22) + row);
  }
}

/*
 * The reading question. A rising line is support, so the textbook trade is the
 * bounce: price comes down to it, holds, buy. The market fell over this sample
 * though, and the honest thing is to check all four readings rather than
 * assume — bounce as a long, the same bounce faded as a short, the break as a
 * short, and the break faded.
 */
function stageDetail() {
  const CANDS = [
    ['4H base',       240, { left: 5, right: 5, minSpan: 6, maxSpan: 200, pierceAtr: 0.1, maxProject: 200, breakAtr: 0.4 }],
    ['4H brk .5',     240, { left: 5, right: 5, minSpan: 6, maxSpan: 200, pierceAtr: 0.1, maxProject: 200, breakAtr: 0.5 }],
    ['4H brk 1',      240, { left: 5, right: 5, minSpan: 6, maxSpan: 200, pierceAtr: 0.1, maxProject: 200, breakAtr: 1.0 }],
    ['4H nokill',     240, { left: 5, right: 5, minSpan: 6, maxSpan: 200, pierceAtr: 0.1, maxProject: 200, breakAtr: 0.4, killOnBreak: false }],
    ['4H span4-60',   240, { left: 5, right: 5, minSpan: 4, maxSpan: 60, pierceAtr: 0.1, maxProject: 200, breakAtr: 0.4 }],
    ['4H L/R 3',      240, { left: 3, right: 3, minSpan: 4, maxSpan: 200, pierceAtr: 0.1, maxProject: 200, breakAtr: 0.4 }],
    ['4H L/R 8',      240, { left: 8, right: 8, minSpan: 10, maxSpan: 200, pierceAtr: 0.1, maxProject: 200, breakAtr: 0.4 }],
    ['1H nokill',      60, { left: 5, right: 5, minSpan: 6, maxSpan: 200, pierceAtr: 0.1, maxProject: 200, breakAtr: 0.4, killOnBreak: false }],
    ['15m base',       15, { left: 5, right: 5, minSpan: 6, maxSpan: 200, pierceAtr: 0.1, maxProject: 200, breakAtr: 0.4 }],
    ['15m brk 1',      15, { left: 5, right: 5, minSpan: 6, maxSpan: 200, pierceAtr: 0.1, maxProject: 200, breakAtr: 1.0 }],
    ['15m nokill',     15, { left: 5, right: 5, minSpan: 6, maxSpan: 200, pierceAtr: 0.1, maxProject: 200, breakAtr: 0.4, killOnBreak: false }],
    ['5m nokill',       5, { left: 5, right: 5, minSpan: 6, maxSpan: 200, pierceAtr: 0.1, maxProject: 200, breakAtr: 0.4, killOnBreak: false }],
  ];
  console.log('\n90/90 target. alpha (n) per reading. bounce = long the hold, fade = short it.\n');
  const head = 'config'.padEnd(14) + 'resp%'.padStart(7) +
    ['all', 'bounce', 'fade', 'brk', 'brkfade'].map(r => r.padStart(15)).join('');
  console.log(head); console.log('─'.repeat(head.length));
  for (const [name, m, o] of CANDS) {
    const { ev } = run(m, o);
    let row = name.padEnd(14) + fp(respectRate(ev).respect).padStart(7);
    for (const r of ['all', 'bounce', 'fade', 'brk', 'brkfade']) {
      const l = ONLY[r](ev);
      if (!l.length) { row += '—'.padStart(15); continue; }
      const s = score(l, TP0, SL0, MAX_HOLD);
      row += `${f(s.alpha)} (${s.tests})`.padStart(15);
    }
    console.log(row);
  }
}

function stageExcursion(cfg = null) {
  const { m, opts } = cfg || BEST;
  const { ev } = run(m, opts);
  const rej = ONLY.bounce(ev), brk = ONLY.brk(ev);
  console.log(`\nexcursion after a test of the rising line — ${TF_NAME[m]} build`);
  console.log(`  ${ev.length} events   ${rej.length} bounces (long)   ${brk.length} breaks (short)\n`);
  for (const [name, list] of [['bounce/long', rej], ['break/short', brk], ['all', ev]]) {
    if (!list.length) continue;
    const x = excursion(list);
    console.log(`  ${name}  (n=${list.length})`);
    for (const H of [60, 240, 1440]) {
      const e = x[H];
      console.log(`    ${String(H).padStart(4)}m   favourable p25/med/p75/p90 ` +
        `${fp(e.mfe.p25)}/${fp(e.mfe.med)}/${fp(e.mfe.p75)}/${fp(e.mfe.p90)}` +
        `    adverse ${fp(e.mae.p25)}/${fp(e.mae.med)}/${fp(e.mae.p75)}/${fp(e.mae.p90)}`);
    }
    console.log('');
  }
}

function stageTargets(cfg = null) {
  const { m, opts } = cfg || BEST;
  const { ev } = run(m, opts);
  /*
   * The excursion says the median favourable travel after a test is roughly a
   * hundred points inside an hour and two hundred inside four, so the grid has
   * to reach well past 90 in both directions. Every cell re-derives its own
   * blind baseline at that exact target, stop and hold — otherwise a wider
   * target would look better purely because the market drifted.
   */
  const TPS = [30, 45, 60, 90, 120, 180, 250, 350];
  const SLS = [30, 45, 60, 90, 120, 180, 250];
  const HOLDS = (process.env.HOLDS || '240,480,1440').split(',').map(Number);
  const READINGS = (process.env.READINGS || 'brk,bounce,all').split(',');
  for (const HOLD of HOLDS) {
    for (const reading of READINGS) {
      const list = ONLY[reading](ev);
      if (list.length < 100) { console.log(`\n${reading}: only ${list.length} events, skipped`); continue; }
      console.log(`\n${reading}  (${list.length} events, hold ${HOLD}m)   alpha per trade, direction-adjusted`);
      const head = 'TP\\SL'.padEnd(7) + SLS.map(s => String(s).padStart(9)).join('');
      console.log(head); console.log('─'.repeat(head.length));
      for (const tp of TPS) {
        let row = String(tp).padEnd(7);
        for (const sl of SLS) {
          const s = score(list, tp, sl, HOLD, 20000);
          row += f(s.alpha, 1).padStart(9);
        }
        console.log(row);
      }
    }
  }
}

/*
 * Anti-overfitting. A grid of eight targets by seven stops by three holds is
 * 168 cells on a few hundred trades; the best cell in that grid is worth
 * nothing on its own. Two checks are applied to anything the grid likes.
 *
 * `fine` asks whether the winning target sits on a plateau or a spike. A real
 * exit size is a broad region — the trades that reach 90 mostly reach 85 too.
 * A single column that stands two standard errors above both its neighbours is
 * noise wearing a suit.
 *
 * `robust` asks whether the result survives the generator being drawn slightly
 * differently. Same reading, same target, twenty variations of pivot width,
 * pierce tolerance, span limits and break rule. If the edge is in the market
 * it shows up in most of them; if it is in one lucky line-drawing rule it does
 * not.
 */
function stageFine() {
  const { m, opts } = BEST;
  const { ev } = run(m, opts);
  const list = ONLY[process.env.READING || 'brk'](ev);
  const HOLD = +(process.env.HOLD || 240);
  console.log(`\nfine target scan — ${list.length} events, hold ${HOLD}m, SL fixed per column\n`);
  const SLS = [45, 60, 90, 120];
  const head = 'TP'.padEnd(6) + SLS.map(s => ('SL' + s).padStart(9)).join('') + '   trades';
  console.log(head); console.log('─'.repeat(head.length));
  for (let tp = 40; tp <= 200; tp += 10) {
    let row = String(tp).padEnd(6), n = 0;
    for (const sl of SLS) {
      const s = score(list, tp, sl, HOLD, 20000);
      row += f(s.alpha, 1).padStart(9);
      n = s.traded;
    }
    console.log(row + String(n).padStart(9));
  }
}

function familyConfigs() {
  const fam = [];
  for (const m of [15, 60, 240]) {
    for (const lr of [4, 5, 6, 8]) {
      for (const pierce of [0.05, 0.1, 0.3]) {
        for (const brk of [0.4, 1.0]) {
          for (const span of [[4, 60], [6, 200], [6, 400]]) {
            fam.push([m, { left: lr, right: lr, minSpan: Math.max(span[0], lr),
              maxSpan: span[1], pierceAtr: pierce, maxProject: 200, breakAtr: brk }]);
          }
        }
      }
    }
  }
  return fam;
}

function stageRobust() {
  const reading = process.env.READING || 'brk';
  const tp = +(process.env.TP || 90), sl = +(process.env.SL || 60), hold = +(process.env.HOLD || 240);
  const fam = familyConfigs();
  console.log(`\nrobustness — reading ${reading}, ${tp}/${sl}, hold ${hold}m, ${fam.length} generator variants`);
  console.log('only variants with >= 100 traded events count\n');
  const byTf = new Map();
  for (const [m, o] of fam) {
    let s;
    try { const r = run(m, o); s = score(ONLY[reading](r.ev), tp, sl, hold, 20000); }
    catch (e) { continue; }
    if (s.traded < 100) continue;
    if (!byTf.has(m)) byTf.set(m, []);
    byTf.get(m).push({ o, s });
  }
  for (const [m, rows] of [...byTf.entries()].sort((a, b) => a[0] - b[0])) {
    const a = rows.map(r => r.s.alpha).sort((x, y) => x - y);
    const pos = a.filter(x => x > 0).length;
    const mean = a.reduce((x, y) => x + y, 0) / a.length;
    console.log(`  ${TF_NAME[m].padEnd(4)} ${String(rows.length).padStart(3)} variants   ` +
      `mean ${f(mean)}   median ${f(a[a.length >> 1])}   min ${f(a[0])}   max ${f(a[a.length - 1])}   ` +
      `${(100 * pos / a.length).toFixed(0)}% positive`);
  }
  const all = [];
  for (const rows of byTf.values()) for (const r of rows) all.push(r);
  all.sort((x, y) => y.s.alpha - x.s.alpha);
  console.log('\n  best few:');
  for (const r of all.slice(0, 6)) {
    console.log(`    ${f(r.s.alpha)}  n=${r.s.traded}  ${JSON.stringify(r.o)}`);
  }
}

// The construction the sweeps land on. Filled in from measured results.
let BEST = {
  m: 15,
  opts: { left: 6, right: 6, minSpan: 8, maxSpan: 200, pierceAtr: 0.1,
          maxProject: 200, breakAtr: 0.4 },
  reading: 'bounce', tp: 30, sl: 30, hold: 480,
};
if (process.env.CFG) {
  const o = JSON.parse(process.env.CFG);
  BEST = { ...BEST, ...o, opts: o.opts ? { ...BEST.opts, ...o.opts } : BEST.opts };
}

function monthly(list, tp, sl, hold) {
  const by = new Map();
  const bl = blind(1, tp, sl, hold), bs = blind(-1, tp, sl, hold);
  for (const e of list) {
    const d = new Date(bars[e.i].t);
    const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!by.has(k)) by.set(k, { n: 0, net: 0, adj: 0 });
    const p = race(e.i, e.dir, tp, sl, hold);
    if (p === null) continue;
    const r = by.get(k);
    r.n++; r.net += p; r.adj += p - (e.dir === 1 ? bl : bs);
  }
  return [...by.entries()].sort().map(([k, v]) => ({ month: k, n: v.n, alpha: v.adj / v.n }));
}

function stageFinal() {
  const { m, opts, reading, tp, sl, hold } = BEST;
  console.log(`${N.toLocaleString()} bars   random respect ${RANDOM_RESPECT}%`);
  console.log(`blind long ${f(blind(1, TP0, SL0, MAX_HOLD))} / blind short ${f(blind(-1, TP0, SL0, MAX_HOLD))} at 90/90`);
  console.log(`blind long ${f(blind(1, tp, sl, hold))} / blind short ${f(blind(-1, tp, sl, hold))} at ${tp}/${sl} hold ${hold}\n`);

  console.log('BEFORE — current construction, best timeframe, 90/90:');
  let bestBefore = null;
  for (const mm of TIMEFRAMES) {
    let s; try { s = score(levelTestEvents(bars, project(mm, CURRENT), atr1)); } catch (e) { continue; }
    if (!s.tests) continue;
    console.log(`   ${TF_NAME[mm].padEnd(4)} ${String(s.tests).padStart(5)} tests  respect ${fp(s.respect)}%  alpha ${f(s.alpha)}`);
    if (s.tests >= 100 && (!bestBefore || s.alpha > bestBefore.s.alpha)) bestBefore = { m: mm, s };
  }
  if (bestBefore) console.log(`   -> best current: ${TF_NAME[bestBefore.m]}  alpha ${f(bestBefore.s.alpha)}  (${bestBefore.s.tests} tests)`);

  console.log(`\nAFTER — rebuilt, ${TF_NAME[m]}, ${reading}, ${tp}/${sl}, hold ${hold}m`);
  console.log('   opts ' + JSON.stringify(opts));
  const { ev, line, id } = run(m, opts);
  const list = ONLY[reading](ev);
  const s = score(list, tp, sl, hold);
  const s90 = score(list, TP0, SL0, MAX_HOLD);
  const all = score(ev, tp, sl, hold);
  console.log(`   events ${ev.length}  (bounce ${ONLY.bounce(ev).length} / break ${ONLY.brk(ev).length})  respect ${fp(respectRate(ev).respect)}%`);
  console.log(`   traded ${s.traded}  nulls ${s.nulls}  longs ${s.longs} shorts ${s.shorts}`);
  console.log(`   raw ${f(s.raw)}  ALPHA ${f(s.alpha)}   (longAlpha ${f(s.longAlpha)} shortAlpha ${f(s.shortAlpha)})`);
  console.log(`   same events at 90/90: alpha ${f(s90.alpha)}   all-events at ${tp}/${sl}: alpha ${f(all.alpha)}`);

  const idev = ONLY[reading](idTestEvents(bars, line, id, atr1));
  if (idev.length) {
    const si = score(idev, tp, sl, hold);
    console.log(`   id-keyed detector cross-check: ${si.tests} events  alpha ${f(si.alpha)}`);
  }

  console.log('\n   month-by-month (alpha, n):');
  for (const r of monthly(list, tp, sl, hold)) {
    console.log(`     ${r.month}  ${String(r.n).padStart(4)}  ${f(r.alpha)}`);
  }

  // bootstrap on the direction-adjusted per-trade series
  const bl = blind(1, tp, sl, hold), bs = blind(-1, tp, sl, hold);
  const adj = [];
  for (const e of list) {
    const p = race(e.i, e.dir, tp, sl, hold);
    if (p === null) continue;
    adj.push(p - (e.dir === 1 ? bl : bs));
  }
  const r = rng(90210);
  let pos = 0;
  for (let k = 0; k < 2000; k++) {
    let t = 0;
    for (let j = 0; j < adj.length; j++) t += adj[Math.floor(r() * adj.length)];
    if (t / adj.length > 0) pos++;
  }
  console.log(`\n   bootstrap: mean alpha > 0 in ${(100 * pos / 2000).toFixed(1)}% of 2000 resamples`);
}

const stage = process.argv[2] || 'final';
({ base: stageBase, causal: stageCausal, tf: stageTf, knobs: stageKnobs,
   detail: stageDetail, excursion: stageExcursion, targets: stageTargets,
   fine: stageFine, robust: stageRobust, final: stageFinal }[stage] || stageFinal)();

module.exports = { risingTrendline, idTestEvents, excursion, score, race, blind, loadBars };
