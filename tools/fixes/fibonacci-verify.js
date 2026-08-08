'use strict';
/*
 * Adversarial verification of the "Fibonacci retracements — rebuilt" claim in
 * tools/fixes/fibonacci.js.
 *
 * The claim:
 *   1H candles, 5/5 confirmed pivots reduced to an alternating zigzag, legs of
 *   at least 2 x ATR14(1H), ratios 0.5 and 0.618 each published as its own
 *   fixed price, projected to 1m one 1H candle late, tests via the shared
 *   levelTestEvents, trade the HOLD reading (up leg held = long, down leg held
 *   = short), 60 point target / 100 point stop / 60 minute cap.
 *   Reported: 750 trades, ALPHA +10.37.
 *
 * Nothing here reuses the claimant's generator except where a stage says it is
 * deliberately comparing against it. The core generator below is written as a
 * STRICTLY ONLINE loop over the 1m stream: it can only see 1m bars up to and
 * including the current one, and it can only publish a level derived from 1H
 * candles that have already closed. If the claimant's projected series and this
 * one disagree anywhere, the claimant has lookahead.
 *
 * Stages:
 *   online     online rebuild vs claimant's series, elementwise
 *   prefix     rebuild the FULL pipeline from truncated 1m history
 *   measure    my own event detection, direction adjustment and headline alpha
 *   matched    same-hour-of-day, same-week matched control instead of a global blind
 *   holdout    derive the whole configuration on Jan-Apr, spend it on May-Jul
 *   sig        non-overlap, block bootstrap, per-month
 *   control    what a random level, and a bare 1H-leg momentum entry, earn
 *   all        everything
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('../ai963_engine');
const LV = require('../levels');
const { levelTestEvents, respectRate } = require('../level_events');

const PU = 0.10, COST = 0.5;

// ── loader, identical to tools/sweep_timeframes.js ───────────────────────────
function loadBars() {
  const html = fs.readFileSync(
    path.join(__dirname, '..', '..', 'KAKASHI_V16_TV_PARITY_AUDIT.html'), 'utf8');
  const csv = zlib.gunzipSync(
    Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1], 'base64')).toString('utf8');
  const lines = csv.split('\n');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const a = lines[i].split(',');
    const t = Date.parse(a[0].replace(' ', 'T'));
    const c = +a[4];
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
    out.push({ t, o: +a[1], h: +a[2], l: +a[3], c, v: +a[5] });
  }
  return out.sort((x, y) => x.t - y.t);
}

const bars = loadBars();
const N = bars.length;
const atr1 = E.atr(bars, 14);
const MAY1 = bars.findIndex(b => b.t >= Date.parse('2026-05-01T00:00:00Z'));

const RATIOS_ALL = [0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
const BEST = {
  minutes: 60, ratios: [0.5, 0.618], reading: 'hold',
  left: 5, right: 5, minLegAtr: 2.0, maxAge: 400, killBeyond: true,
  tp: 60, sl: 100, hold: 60,
};

// ═════════════════════════════════════════════════════════════════════════════
//  A strictly online rebuild of the claimed generator.
//
//  One pass over the 1m stream. An HTF candle is only finalised when a 1m bar
//  belonging to the NEXT bucket arrives, and the level published while inside
//  bucket k is computed from candles 0..k-1 only. Pivot detection at HTF index
//  p is run only once bar p+right has closed. There is no array of future bars
//  to index into, so lookahead is structurally impossible here.
// ═════════════════════════════════════════════════════════════════════════════
function onlineFib(minutes, o = {}) {
  const left = o.left ?? 5, right = o.right ?? 5;
  const ratios = o.ratios ?? RATIOS_ALL;
  const minLegAtr = o.minLegAtr ?? 2.0;
  const maxAge = o.maxAge ?? 400;
  const killBeyond = o.killBeyond ?? true;
  const minSpanBars = o.minSpanBars ?? 1;
  const span = minutes * 60000;

  const lines = {};
  for (const r of ratios) lines[r] = new Array(N).fill(NaN);
  const legDir = new Array(N).fill(0);

  const hb = [];                 // closed HTF candles only
  const hatr = [];               // ATR14 of hb, Wilder RMA, computed as they close
  let rmaPrev = NaN, trSum = 0, trCnt = 0;
  let last = null, active = null, nextId = 0;
  let pub = null;                // {dir, lv} as of the last closed HTF candle

  function pushAtr(j) {
    const b = hb[j];
    const tr = j === 0 ? b.h - b.l
      : Math.max(b.h - b.l, Math.abs(b.h - hb[j - 1].c), Math.abs(b.l - hb[j - 1].c));
    // E.rma seeds with an SMA of the first `len` values, then Wilder-smooths.
    if (j < 14) { trSum += tr; trCnt++; hatr[j] = j === 13 ? (trSum / 14) : NaN; if (j === 13) rmaPrev = trSum / 14; }
    else { rmaPrev = (rmaPrev * 13 + tr) / 14; hatr[j] = rmaPrev; }
  }

  function isPivot(p, kind) {
    if (p - left < 0 || p + right >= hb.length + 0) { /* caller guarantees */ }
    for (let k = 1; k <= left; k++) {
      if (kind === 'h' ? hb[p - k].h >= hb[p].h : hb[p - k].l <= hb[p].l) return false;
    }
    for (let k = 1; k <= right; k++) {
      if (kind === 'h' ? hb[p + k].h > hb[p].h : hb[p + k].l < hb[p].l) return false;
    }
    return true;
  }

  // Called the instant HTF candle j has closed. Mirrors fibLines' per-bar order:
  // births, then age, then killBeyond, then publish.
  function onClose(j) {
    pushAtr(j);
    const p = j - right;
    const born = [];
    // fibLines pushes all highs before all lows for the same knownAt.
    if (p >= left) {
      if (isPivot(p, 'h')) born.push({ bar: p, price: hb[p].h, kind: 'h' });
      if (isPivot(p, 'l')) born.push({ bar: p, price: hb[p].l, kind: 'l' });
    }
    for (const q of born) {
      if (!last) { last = q; continue; }
      if (q.kind === last.kind) {
        if (q.kind === 'h' ? q.price > last.price : q.price < last.price) last = q;
        continue;
      }
      const a = last, b = q;
      last = q;
      if (b.bar - a.bar < minSpanBars) continue;
      const height = Math.abs(b.price - a.price);
      const aRef = hatr[b.bar];
      if (!Number.isFinite(aRef) || aRef <= 0) continue;
      if (height < aRef * minLegAtr) continue;
      const dir = b.kind === 'h' ? 1 : -1;
      const lv = {};
      for (const r of ratios) lv[r] = b.price - dir * height * r;
      active = { id: nextId++, dir, born: j, anchorA: a.price, height, lv };
    }
    if (active) {
      if (j - active.born > maxAge) active = null;
      else if (killBeyond) {
        const c = hb[j].c;
        if (active.dir === 1 ? c < active.anchorA : c > active.anchorA) active = null;
      }
    }
    pub = active ? { dir: active.dir, lv: active.lv } : null;
  }

  let cur = null, curStart = -1;
  for (let i = 0; i < N; i++) {
    const b = bars[i];
    const bucket = Math.floor(b.t / span) * span;
    if (cur === null) { cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c }; curStart = bucket; }
    else if (bucket !== curStart) {
      hb.push(cur); onClose(hb.length - 1);
      cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c }; curStart = bucket;
    } else {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c;
    }
    if (pub) { for (const r of ratios) lines[r][i] = pub.lv[r]; legDir[i] = pub.dir; }
  }
  return { lines, legDir };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Scoring — my own, not imported.
// ═════════════════════════════════════════════════════════════════════════════
function race(i, dir, tp, sl, hold) {
  const e = bars[i].c, tpx = e + dir * tp * PU, slx = e - dir * sl * PU;
  const end = Math.min(N - 1, i + hold);
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    const ht = dir === 1 ? b.h >= tpx : b.l <= tpx;
    const hs = dir === 1 ? b.l <= slx : b.h >= slx;
    if (ht && hs) return null;
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
const BLIND = new Map();
function blind(dir, tp, sl, hold, n = 40000, lo = 100, hi = null) {
  const HI = hi === null ? N - hold - 2 : hi;
  const key = `${dir}|${tp}|${sl}|${hold}|${n}|${lo}|${HI}`;
  if (BLIND.has(key)) return BLIND.get(key);
  const r = rng(dir === 1 ? 31337 : 73331);
  let c = 0, net = 0;
  for (let k = 0; k < n; k++) {
    const p = race(lo + Math.floor(r() * (HI - lo)), dir, tp, sl, hold);
    if (p === null) continue;
    c++; net += p;
  }
  const v = net / c; BLIND.set(key, v); return v;
}
/**
 * Direction-adjusted score. Longs are judged against a blind long over the same
 * window and stops, shorts against a blind short, then combined by count.
 * `lo`/`hi` restrict the blind sampler to the same slice of tape the events
 * live in, so a half-sample result is never compared to a whole-sample drift.
 */
function score(events, tp, sl, hold, blindN = 40000, lo = 100, hi = null) {
  const bl = blind(1, tp, sl, hold, blindN, lo, hi);
  const bs = blind(-1, tp, sl, hold, blindN, lo, hi);
  let ln = 0, lnet = 0, sn = 0, snet = 0, wins = 0, nulls = 0;
  const adj = [];
  for (const e of events) {
    const p = race(e.i, e.dir, tp, sl, hold);
    if (p === null) { nulls++; continue; }
    if (p > 0) wins++;
    adj.push(p - (e.dir === 1 ? bl : bs));
    if (e.dir === 1) { ln++; lnet += p; } else { sn++; snet += p; }
  }
  const tot = ln + sn;
  const la = ln ? lnet / ln - bl : 0, sa = sn ? snet / sn - bs : 0;
  const mu = adj.length ? adj.reduce((a, b) => a + b, 0) / adj.length : NaN;
  const sd = adj.length > 1
    ? Math.sqrt(adj.reduce((a, b) => a + (b - mu) ** 2, 0) / (adj.length - 1)) : NaN;
  return {
    ...respectRate(events), nulls, traded: tot, longs: ln, shorts: sn,
    hit: tot ? 100 * wins / tot : NaN,
    raw: tot ? (lnet + snet) / tot : NaN,
    longAlpha: ln ? la : NaN, shortAlpha: sn ? sa : NaN,
    alpha: tot ? (la * ln + sa * sn) / tot : NaN,
    blindLong: bl, blindShort: bs, adj, sd,
    t: sd > 0 ? mu / (sd / Math.sqrt(adj.length)) : NaN,
  };
}

// ── readings ────────────────────────────────────────────────────────────────
function tagEvents(events, legDir) {
  return events.map(e => {
    const L = legDir[e.i];
    const up = L === 1;
    let name;
    if (up) name = e.kind === 'reject' ? (e.dir === 1 ? 'upHold' : 'upReject')
                                       : (e.dir === -1 ? 'upLose' : 'upReclaim');
    else    name = e.kind === 'reject' ? (e.dir === -1 ? 'dnHold' : 'dnSupport')
                                       : (e.dir === 1 ? 'dnLose' : 'dnBreak');
    return { ...e, legDir: L, name };
  });
}
const pick = (ev, reading) =>
    reading === 'all' ? ev
  : reading === 'hold' ? ev.filter(e => e.name === 'upHold' || e.name === 'dnHold')
  : reading === 'holdFade' ? ev.filter(e => e.name === 'upHold' || e.name === 'dnHold').map(e => ({ ...e, dir: -e.dir }))
  : reading === 'lose' ? ev.filter(e => e.name === 'upLose' || e.name === 'dnLose')
  : reading === 'reject' ? ev.filter(e => e.kind === 'reject')
  : ev.filter(e => e.name === reading);

const LINE_CACHE = new Map();
function build(cfg) {
  const key = `${cfg.minutes}|${cfg.left}|${cfg.right}|${cfg.minLegAtr}|${cfg.maxAge}|${cfg.killBeyond}|${(cfg.ratiosBuild || RATIOS_ALL).join(',')}`;
  if (!LINE_CACHE.has(key)) LINE_CACHE.set(key, onlineFib(cfg.minutes, { ...cfg, ratios: cfg.ratiosBuild || RATIOS_ALL }));
  return LINE_CACHE.get(key);
}
const EV_CACHE = new Map();
/** Pooled, deduplicated events for a ratio list, tagged with the leg direction. */
function eventsFor(cfg, detOpts) {
  const key = `${cfg.minutes}|${cfg.left}|${cfg.right}|${cfg.minLegAtr}|${cfg.maxAge}|${cfg.killBeyond}|${cfg.ratios.join('+')}|${JSON.stringify(detOpts || null)}`;
  if (EV_CACHE.has(key)) return EV_CACHE.get(key);
  const p = build(cfg);
  let ev = [];
  for (const r of cfg.ratios) {
    ev = ev.concat(tagEvents(levelTestEvents(bars, p.lines[r], atr1, detOpts), p.legDir)
      .map(e => ({ ...e, ratio: r })));
  }
  ev.sort((a, b) => a.i - b.i);
  if (cfg.ratios.length > 1) {
    const seen = new Set();
    ev = ev.filter(e => (seen.has(e.i) ? false : (seen.add(e.i), true)));
  }
  EV_CACHE.set(key, ev);
  return ev;
}

const f = (x, d = 2) => Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '—';
const fp = (x, d = 1) => Number.isFinite(x) ? x.toFixed(d) : '—';

// ═════════════════════════════════════════════════════════════════════════════
//  Stage: online rebuild vs the claimant's projected series
// ═════════════════════════════════════════════════════════════════════════════
function stageOnline() {
  const claim = require('./fibonacci_lib_shim');   // never used; placeholder guard
}

function claimantSeries(cfg) {
  // Rebuild the claimant's path exactly: resample -> fibLines -> projectConfirmed.
  const { bars: hb, index } = E.resample(bars, cfg.minutes);
  const ha = E.atr(hb, 14);
  const raw = fibLinesClaimant(hb, ha, cfg);
  const lines = {};
  for (const k of Object.keys(raw.lines)) lines[k] = E.projectConfirmed(raw.lines[k], index);
  return { lines, legDir: E.projectConfirmed(raw.legDir, index).map(v => Number.isFinite(v) ? v : 0) };
}
// verbatim copy of tools/fixes/fibonacci.js fibLines, so the comparison is exact
function fibLinesClaimant(hbars, atr, o = {}) {
  const left = o.left ?? 5, right = o.right ?? 5;
  const ratios = o.ratiosBuild || RATIOS_ALL;
  const minLegAtr = o.minLegAtr ?? 2.0, maxAge = o.maxAge ?? 400;
  const killBeyond = o.killBeyond ?? true, minSpanBars = o.minSpanBars ?? 1;
  const n = hbars.length;
  const { highs, lows } = LV.pivots(hbars, left, right);
  const byKnown = new Map();
  const push = (p, kind) => {
    if (!byKnown.has(p.knownAt)) byKnown.set(p.knownAt, []);
    byKnown.get(p.knownAt).push({ ...p, kind });
  };
  for (const p of highs) push(p, 'h');
  for (const p of lows) push(p, 'l');
  const lines = {};
  for (const r of ratios) lines[r] = new Array(n).fill(NaN);
  const legDir = new Array(n).fill(0);
  let last = null, active = null;
  for (let i = 0; i < n; i++) {
    const born = byKnown.get(i);
    if (born) for (const p of born) {
      if (!last) { last = p; continue; }
      if (p.kind === last.kind) {
        if (p.kind === 'h' ? p.price > last.price : p.price < last.price) last = p;
        continue;
      }
      const a = last, b = p; last = p;
      if (b.bar - a.bar < minSpanBars) continue;
      const height = Math.abs(b.price - a.price);
      const aRef = atr[b.bar];
      if (!Number.isFinite(aRef) || aRef <= 0) continue;
      if (height < aRef * minLegAtr) continue;
      const dir = b.kind === 'h' ? 1 : -1;
      const lv = {};
      for (const r of ratios) lv[r] = b.price - dir * height * r;
      active = { dir, born: i, anchorA: a.price, lv };
    }
    if (!active) continue;
    if (i - active.born > maxAge) { active = null; continue; }
    if (killBeyond) {
      const c = hbars[i].c;
      if (active.dir === 1 ? c < active.anchorA : c > active.anchorA) { active = null; continue; }
    }
    for (const r of ratios) lines[r][i] = active.lv[r];
    legDir[i] = active.dir;
  }
  return { lines, legDir };
}

function cmpOnline() {
  const cfg = BEST;
  const mine = build(cfg);
  const theirs = claimantSeries(cfg);
  let diff = 0, both = 0, onlyMine = 0, onlyTheirs = 0, worst = 0;
  for (const r of cfg.ratios) {
    for (let i = 0; i < N; i++) {
      const a = mine.lines[r][i], b = theirs.lines[r][i];
      const fa = Number.isFinite(a), fb = Number.isFinite(b);
      if (fa && fb) { both++; const d = Math.abs(a - b); worst = Math.max(worst, d); if (d > 1e-9) diff++; }
      else if (fa) onlyMine++;
      else if (fb) onlyTheirs++;
    }
  }
  let dirDiff = 0;
  for (let i = 0; i < N; i++) if (mine.legDir[i] !== theirs.legDir[i]) dirDiff++;
  console.log('ONLINE REBUILD vs CLAIMANT SERIES  (ratios ' + cfg.ratios.join(',') + ')');
  console.log(`  both finite ${both.toLocaleString()}   value disagreements ${diff}   max |diff| ${worst.toExponential(2)}`);
  console.log(`  finite only in my online build ${onlyMine}   only in theirs ${onlyTheirs}`);
  console.log(`  leg-direction disagreements ${dirDiff}`);
  console.log(`  => ${diff === 0 && onlyMine === 0 && onlyTheirs === 0 && dirDiff === 0
    ? 'IDENTICAL. A provably online generator reproduces their series exactly: no lookahead in the level.'
    : 'DIFFERENT — investigate.'}`);
  return { mine, theirs };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Stage: full-pipeline rebuild from truncated 1m history
// ═════════════════════════════════════════════════════════════════════════════
/*
 * The claimant's own causality check truncated the HIGHER timeframe array. That
 * cannot catch a resample or projection-index bug, because the higher timeframe
 * array is itself derived from the future. This redoes it from the raw 1m tape:
 * resample(bars[0..i]) -> atr -> fibLines -> projectConfirmed, and compares the
 * value visible at bar i.
 */
function stagePrefix() {
  const cfg = BEST;
  const full = claimantSeries(cfg);
  const mineFull = build(cfg);
  const r = rng(9182);
  let checked = 0, bad = 0, worst = 0, badMine = 0;
  for (let k = 0; k < 120; k++) {
    const i = 20000 + Math.floor(r() * (N - 25000));
    const cut = bars.slice(0, i + 1);
    const { bars: hb, index } = E.resample(cut, cfg.minutes);
    const ha = E.atr(hb, 14);
    const raw = fibLinesClaimant(hb, ha, cfg);
    for (const ratio of cfg.ratios) {
      const proj = E.projectConfirmed(raw.lines[ratio], index);
      const a = full.lines[ratio][i], b = proj[i], c = mineFull.lines[ratio][i];
      const fa = Number.isFinite(a), fb = Number.isFinite(b);
      checked++;
      if (fa !== fb || (fa && fb && Math.abs(a - b) > 1e-9)) { bad++; worst = Math.max(worst, Math.abs((a || 0) - (b || 0))); }
      if ((Number.isFinite(c) !== fb) || (Number.isFinite(c) && fb && Math.abs(c - b) > 1e-9)) badMine++;
    }
  }
  console.log('\nPREFIX REBUILD (resample + atr + generator + projection recomputed from 1m history only)');
  console.log(`  ${checked} comparisons   claimant disagreements ${bad}   my-online disagreements ${badMine}   max |diff| ${worst.toExponential(2)}`);

  // A blunt cross-check: shifting the published level one 1m bar LATER should
  // barely change anything if the series is genuinely causal, and should
  // destroy the result if the level is quietly ahead of price.
  const ev0 = eventsFor(cfg);
  const shifted = {};
  const p = build(cfg);
  for (const ratio of cfg.ratios) {
    const s = new Array(N).fill(NaN);
    for (let i = 1; i < N; i++) s[i] = p.lines[ratio][i - 1];
    shifted[ratio] = s;
  }
  let ev1 = [];
  const legShift = new Array(N).fill(0);
  for (let i = 1; i < N; i++) legShift[i] = p.legDir[i - 1];
  for (const ratio of cfg.ratios) {
    ev1 = ev1.concat(tagEvents(levelTestEvents(bars, shifted[ratio], atr1), legShift));
  }
  ev1.sort((a, b) => a.i - b.i);
  const seen = new Set(); ev1 = ev1.filter(e => (seen.has(e.i) ? false : (seen.add(e.i), true)));
  const s0 = score(pick(ev0, 'hold'), cfg.tp, cfg.sl, cfg.hold);
  const s1 = score(pick(ev1, 'hold'), cfg.tp, cfg.sl, cfg.hold);
  console.log(`  as published:            ${s0.traded} trades  alpha ${f(s0.alpha)}`);
  console.log(`  level delayed one 1m bar: ${s1.traded} trades  alpha ${f(s1.alpha)}   (a lookahead-driven result collapses here)`);

  // And an extra full 1H candle of delay: the level a chartist would have drawn
  // if they only looked at the chart once an hour after the fact.
  const { index } = E.resample(bars, cfg.minutes);
  const lag2 = {}; const legLag2 = new Array(N).fill(0);
  const rawHtf = fibLinesClaimant(E.resample(bars, cfg.minutes).bars, E.atr(E.resample(bars, cfg.minutes).bars, 14), cfg);
  for (const ratio of cfg.ratios) {
    const s = new Array(N).fill(NaN);
    for (let i = 0; i < N; i++) { const j = index[i] - 2; s[i] = j >= 0 ? rawHtf.lines[ratio][j] : NaN; }
    lag2[ratio] = s;
  }
  for (let i = 0; i < N; i++) { const j = index[i] - 2; legLag2[i] = j >= 0 ? rawHtf.legDir[j] : 0; }
  let ev2 = [];
  for (const ratio of cfg.ratios) ev2 = ev2.concat(tagEvents(levelTestEvents(bars, lag2[ratio], atr1), legLag2));
  ev2.sort((a, b) => a.i - b.i);
  const seen2 = new Set(); ev2 = ev2.filter(e => (seen2.has(e.i) ? false : (seen2.add(e.i), true)));
  const s2 = score(pick(ev2, 'hold'), cfg.tp, cfg.sl, cfg.hold);
  console.log(`  level delayed a full extra 1H candle: ${s2.traded} trades  alpha ${f(s2.alpha)}`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  Stage: my own headline measurement
// ═════════════════════════════════════════════════════════════════════════════
function stageMeasure() {
  const cfg = BEST;
  const ev = eventsFor(cfg);
  const list = pick(ev, cfg.reading);
  const s = score(list, cfg.tp, cfg.sl, cfg.hold);
  const all = score(ev, cfg.tp, cfg.sl, cfg.hold);
  console.log('\nMY MEASUREMENT — online generator, shared detector, own scoring');
  console.log(`  blind long ${f(s.blindLong)}   blind short ${f(s.blindShort)}   (${cfg.tp}/${cfg.sl}, ${cfg.hold}m cap)`);
  console.log(`  all tests of these levels: ${all.tests}   respect ${fp(all.respect)}%  (random 68.95%)`);
  console.log(`  HOLD reading: ${s.traded} trades (${s.longs}L / ${s.shorts}S, ${fp(100 * s.shorts / s.traded)}% short)`);
  console.log(`  hit ${fp(s.hit)}%   raw ${f(s.raw)}   long alpha ${f(s.longAlpha)}   short alpha ${f(s.shortAlpha)}`);
  console.log(`  ALPHA ${f(s.alpha)}   (naive per-trade t ${fp(s.t, 2)}, optimistic — trades overlap)`);
  const undirected = s.raw - (s.blindLong * s.longs + s.blindShort * s.shorts) / s.traded;
  console.log(`  sanity: same number computed as raw minus count-weighted blind = ${f(undirected)}`);

  // every reading, so the choice of "hold" can be seen in context
  console.log('\n  reading split at the same size:');
  for (const nm of ['upHold', 'dnHold', 'upLose', 'dnLose', 'upReject', 'dnSupport', 'upReclaim', 'dnBreak']) {
    const l = pick(ev, nm);
    if (l.length < 25) { console.log(`    ${nm.padEnd(11)} (${l.length})`); continue; }
    const x = score(l, cfg.tp, cfg.sl, cfg.hold, 20000);
    console.log(`    ${nm.padEnd(11)} ${String(x.traded).padStart(4)}  alpha ${f(x.alpha).padStart(8)}  raw ${f(x.raw).padStart(8)}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Stage: matched control instead of a global blind
// ═════════════════════════════════════════════════════════════════════════════
/*
 * The global blind baseline averages over the whole sample and every hour of
 * the day. If the fib events happen to cluster in the months and the sessions
 * where the drift was strongest, that baseline flatters them. The matched
 * control removes both: for every event, the same direction is entered at the
 * SAME TIME OF DAY on the five days either side. Whatever the fib level is
 * worth has to show up against that.
 */
function matchedControl(list, tp, sl, hold, offsetsDays = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5]) {
  let realN = 0, realSum = 0, ctrlN = 0, ctrlSum = 0;
  const paired = [];
  for (const e of list) {
    const p = race(e.i, e.dir, tp, sl, hold);
    if (p === null) continue;
    let cn = 0, cs = 0;
    for (const d of offsetsDays) {
      const j = e.i + d * 1440;
      if (j < 1 || j > N - hold - 2) continue;
      const q = race(j, e.dir, tp, sl, hold);
      if (q === null) continue;
      cn++; cs += q;
    }
    if (!cn) continue;
    realN++; realSum += p; ctrlN += cn; ctrlSum += cs;
    paired.push(p - cs / cn);
  }
  const mu = paired.reduce((a, b) => a + b, 0) / (paired.length || 1);
  const sd = paired.length > 1
    ? Math.sqrt(paired.reduce((a, b) => a + (b - mu) ** 2, 0) / (paired.length - 1)) : NaN;
  return { n: realN, real: realSum / realN, ctrl: ctrlSum / ctrlN, alpha: mu, sd,
           t: sd > 0 ? mu / (sd / Math.sqrt(paired.length)) : NaN, paired };
}

function stageMatched() {
  const cfg = BEST;
  const list = pick(eventsFor(cfg), cfg.reading);
  const m = matchedControl(list, cfg.tp, cfg.sl, cfg.hold);
  console.log('\nMATCHED CONTROL — same direction, same hour of day, +/- 1..5 days');
  console.log(`  ${m.n} events   real ${f(m.real)}   matched control ${f(m.ctrl)}   ALPHA(matched) ${f(m.alpha)}`);
  console.log(`  naive t on the paired difference ${fp(m.t, 2)} (still overlapping, so still optimistic)`);
  // split by direction
  for (const [nm, d] of [['longs', 1], ['shorts', -1]]) {
    const sub = list.filter(e => e.dir === d);
    if (sub.length < 30) continue;
    const mm = matchedControl(sub, cfg.tp, cfg.sl, cfg.hold);
    console.log(`  ${nm.padEnd(7)} ${String(mm.n).padStart(4)}   real ${f(mm.real)}   control ${f(mm.ctrl)}   alpha ${f(mm.alpha)}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Stage: honest holdout — derive EVERYTHING on Jan-Apr, spend it on May-Jul
// ═════════════════════════════════════════════════════════════════════════════
function stageHoldout() {
  const MINUTES = [15, 60, 240];
  const RATIOSETS = [[0.236], [0.382], [0.5], [0.618], [0.786], [0.5, 0.618], [0.382, 0.5, 0.618], [0.618, 0.786]];
  const READINGS = ['hold', 'holdFade', 'lose', 'reject'];
  const TPS = [30, 40, 60, 80, 100];
  const SLS = [40, 60, 100, 130, 200];
  const HOLDS = [60, 240];
  const LR = [3, 5, 8];
  const MLA = [1.5, 2.0, 3.0];

  const inS = e => e.i < MAY1, outS = e => e.i >= MAY1;
  let best = null, tried = 0;
  const results = [];
  for (const minutes of MINUTES) {
    for (const lr of LR) {
      for (const mla of MLA) {
        const base = { minutes, left: lr, right: lr, minLegAtr: mla, maxAge: 400, killBeyond: true };
        for (const ratios of RATIOSETS) {
          const ev = eventsFor({ ...base, ratios });
          for (const reading of READINGS) {
            const l = pick(ev, reading);
            const li = l.filter(inS);
            if (li.length < 100) continue;
            for (const tp of TPS) for (const sl of SLS) for (const hold of HOLDS) {
              tried++;
              const s = score(li, tp, sl, hold, 12000, 100, MAY1 - hold - 2);
              if (s.traded < 100) continue;
              results.push({ cfg: { ...base, ratios, reading, tp, sl, hold }, inAlpha: s.alpha, inN: s.traded });
              if (!best || s.alpha > best.inAlpha) best = results[results.length - 1];
            }
          }
        }
      }
    }
  }
  console.log(`\nHOLDOUT — ${tried} configurations derived on Jan 2 - Apr 30, judged on May 1 - Jul 17`);
  const show = (label, cfg) => {
    const ev = eventsFor(cfg);
    const l = pick(ev, cfg.reading);
    const a = score(l.filter(inS), cfg.tp, cfg.sl, cfg.hold, 40000, 100, MAY1 - cfg.hold - 2);
    const b = score(l.filter(outS), cfg.tp, cfg.sl, cfg.hold, 40000, MAY1, N - cfg.hold - 2);
    console.log(`  ${label}`);
    console.log(`     ${cfg.minutes}m  lr${cfg.left}  minLeg${cfg.minLegAtr}  ratios ${cfg.ratios.join('+')}  ${cfg.reading}  ${cfg.tp}/${cfg.sl}  hold ${cfg.hold}m`);
    console.log(`     Jan-Apr  ${String(a.traded).padStart(4)} trades  alpha ${f(a.alpha).padStart(8)}      May-Jul  ${String(b.traded).padStart(4)} trades  alpha ${f(b.alpha).padStart(8)}`);
    return b;
  };
  show('best in-sample configuration:', best.cfg);
  show('the CLAIMED configuration:', BEST);

  // top ten in-sample, and what each of them did out of sample: the honest
  // picture of how much of the in-sample ranking survives.
  results.sort((x, y) => y.inAlpha - x.inAlpha);
  console.log('\n  top 10 in-sample configurations and their out-of-sample alpha:');
  console.log('   rank   in-alpha  in-n     out-alpha  out-n   config');
  let survived = 0;
  for (let k = 0; k < Math.min(10, results.length); k++) {
    const c = results[k].cfg;
    const l = pick(eventsFor(c), c.reading).filter(outS);
    const b = score(l, c.tp, c.sl, c.hold, 20000, MAY1, N - c.hold - 2);
    if (b.alpha > 0) survived++;
    console.log(`   ${String(k + 1).padStart(4)} ${f(results[k].inAlpha).padStart(10)} ${String(results[k].inN).padStart(5)} ` +
      `${f(b.alpha).padStart(13)} ${String(b.traded).padStart(6)}   ${c.minutes}m lr${c.left} mla${c.minLegAtr} ${c.ratios.join('+')} ${c.reading} ${c.tp}/${c.sl} h${c.hold}`);
  }
  console.log(`  ${survived}/10 of the top in-sample configurations stayed positive out of sample.`);

  // Reverse the split as well: deriving on the LATER half and judging the
  // earlier one is the same question asked the other way round.
  let best2 = null;
  for (const r of results) {
    const l = pick(eventsFor(r.cfg), r.cfg.reading).filter(outS);
    const s = score(l, r.cfg.tp, r.cfg.sl, r.cfg.hold, 8000, MAY1, N - r.cfg.hold - 2);
    if (s.traded >= 100 && (!best2 || s.alpha > best2.a)) best2 = { cfg: r.cfg, a: s.alpha, n: s.traded };
  }
  if (best2) {
    const l = pick(eventsFor(best2.cfg), best2.cfg.reading).filter(inS);
    const s = score(l, best2.cfg.tp, best2.cfg.sl, best2.cfg.hold, 40000, 100, MAY1 - best2.cfg.hold - 2);
    console.log(`\n  reversed: best on May-Jul (${f(best2.a)}, n ${best2.n}) scored on Jan-Apr: ${f(s.alpha)} over ${s.traded}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Stage: significance with the overlap taken seriously
// ═════════════════════════════════════════════════════════════════════════════
function serial(list, hold, startAfter = -1) {
  const out = []; let free = startAfter;
  for (const e of list) { if (e.i <= free) continue; out.push(e); free = e.i + hold; }
  return out;
}
function stageSig() {
  const cfg = BEST;
  const list = pick(eventsFor(cfg), cfg.reading);
  const s = score(list, cfg.tp, cfg.sl, cfg.hold);
  const ser = serial(list, cfg.hold);
  const ss = score(ser, cfg.tp, cfg.sl, cfg.hold);
  console.log('\nSIGNIFICANCE');
  console.log(`  all overlapping trades   n ${s.traded}   alpha ${f(s.alpha)}   naive t ${fp(s.t, 2)}`);
  console.log(`  non-overlapping subset   n ${ss.traded}   alpha ${f(ss.alpha)}   t ${fp(ss.t, 2)}   sd ${fp(ss.sd)}`);

  // Greedy from the front is a choice. Do it from many random starting points.
  const r = rng(20260808);
  const alts = [];
  for (let k = 0; k < 40; k++) {
    const drop = Math.floor(r() * Math.min(40, list.length));
    const sub = score(serial(list.slice(drop), cfg.hold), cfg.tp, cfg.sl, cfg.hold, 20000);
    if (sub.traded >= 100) alts.push(sub.alpha);
  }
  alts.sort((a, b) => a - b);
  console.log(`  random-offset non-overlapping: mean ${f(alts.reduce((a, b) => a + b, 0) / alts.length)}  ` +
    `range ${f(alts[0])} .. ${f(alts[alts.length - 1])}  over ${alts.length} draws`);

  // Moving-block bootstrap on the non-overlapping, direction-adjusted returns.
  const adj = ss.adj;
  const B = 4000, blk = 10;
  const rr = rng(4242);
  const means = [];
  for (let b = 0; b < B; b++) {
    let sum = 0, cnt = 0;
    while (cnt < adj.length) {
      const st = Math.floor(rr() * Math.max(1, adj.length - blk));
      for (let j = 0; j < blk && cnt < adj.length; j++, cnt++) sum += adj[st + j];
    }
    means.push(sum / adj.length);
  }
  means.sort((a, b) => a - b);
  const q = p => means[Math.min(means.length - 1, Math.floor(p * means.length))];
  console.log(`  moving-block bootstrap (block ${blk}, ${B} draws): mean ${f(q(0.5))}  ` +
    `90% CI ${f(q(0.05))} .. ${f(q(0.95))}   P(alpha<=0) ${fp(100 * means.filter(v => v <= 0).length / B, 1)}%`);

  // per month, on the non-overlapping subset
  const byM = new Map();
  const bl = blind(1, cfg.tp, cfg.sl, cfg.hold), bs = blind(-1, cfg.tp, cfg.sl, cfg.hold);
  for (const e of ser) {
    const k = new Date(bars[e.i].t).toISOString().slice(0, 7);
    const p = race(e.i, e.dir, cfg.tp, cfg.sl, cfg.hold);
    if (p === null) continue;
    if (!byM.has(k)) byM.set(k, { n: 0, adj: 0 });
    const o = byM.get(k); o.n++; o.adj += p - (e.dir === 1 ? bl : bs);
  }
  console.log('  month     n   adjusted');
  for (const [k, o] of [...byM.entries()].sort()) {
    console.log(`  ${k} ${String(o.n).padStart(5)}   ${f(o.adj / o.n).padStart(8)}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Stage: what does the level actually add?
// ═════════════════════════════════════════════════════════════════════════════
/*
 * Three controls, in increasing order of how much they hurt.
 *
 *  1. RANDOM LEVEL. Arbitrary constant prices, the same detector, trade every
 *     bounce. This is what "price bounced off something" is worth on its own.
 *  2. RANDOM LEVEL, LEG-FILTERED. The same random bounces, but kept only when
 *     the bounce direction agrees with the prevailing 1H leg direction taken
 *     from the fib build. This is the claimed strategy with the fib level
 *     replaced by nothing at all.
 *  3. BARE MOMENTUM. No level: enter at random minutes in the direction of the
 *     prevailing 1H leg. This is what "the 1H swing is up so buy" is worth.
 */
function stageControl() {
  const cfg = BEST;
  const { tp, sl, hold } = cfg;
  const p = build(cfg);
  const legDir = p.legDir;

  const list = pick(eventsFor(cfg), cfg.reading);
  const s = score(list, tp, sl, hold);
  console.log('\nCONTROLS  (all at ' + tp + '/' + sl + ', ' + hold + 'm cap)');
  console.log(`  fib golden-zone HOLD                       n ${String(s.traded).padStart(5)}   alpha ${f(s.alpha)}`);

  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
  const constantLine = (level, maxDistAtr = 6) => {
    const out = new Array(N).fill(NaN);
    for (let i = 0; i < N; i++) {
      const a = atr1[i];
      if (Number.isFinite(a) && Math.abs(bars[i].c - level) <= a * maxDistAtr) out[i] = level;
    }
    return out;
  };
  const r = rng(777001);
  let rej = [], legRej = [];
  for (let k = 0; k < 500; k++) {
    let px = lo + r() * (hi - lo);
    if (Math.abs(px - Math.round(px / 10) * 10) < 1.5) px += 3.7;
    const ev = levelTestEvents(bars, constantLine(px), atr1);
    for (const e of ev) {
      if (e.kind !== 'reject') continue;
      rej.push(e);
      if (legDir[e.i] === e.dir) legRej.push(e);
    }
  }
  // dedupe by bar so overlapping random levels do not double-count a minute
  const dedupe = a => { const s2 = new Set(); return a.sort((x, y) => x.i - y.i).filter(e => (s2.has(e.i) ? false : (s2.add(e.i), true))); };
  rej = dedupe(rej); legRej = dedupe(legRej);
  const sr = score(rej, tp, sl, hold, 40000);
  const sl2 = score(legRej, tp, sl, hold, 40000);
  console.log(`  random level, every bounce traded           n ${String(sr.traded).padStart(5)}   alpha ${f(sr.alpha)}`);
  console.log(`  random level, bounce agrees with 1H leg     n ${String(sl2.traded).padStart(5)}   alpha ${f(sl2.alpha)}`);

  // bare momentum: no level at all
  const rm = rng(31415);
  const mom = [];
  for (let k = 0; k < 20000; k++) {
    const i = 100 + Math.floor(rm() * (N - hold - 200));
    if (legDir[i] === 0) continue;
    mom.push({ i, dir: legDir[i], kind: 'reject' });
  }
  const sm = score(mom, tp, sl, hold, 40000);
  console.log(`  no level: random entry along the 1H leg     n ${String(sm.traded).padStart(5)}   alpha ${f(sm.alpha)}`);

  // and the same momentum sampled only at the minutes the fib events happened,
  // which removes any timing advantage the events might have
  const momAt = list.map(e => ({ i: e.i, dir: legDir[e.i] || e.dir, kind: 'reject' }));
  const sma = score(momAt, tp, sl, hold, 40000);
  console.log(`  1H-leg direction at the fib event minutes   n ${String(sma.traded).padStart(5)}   alpha ${f(sma.alpha)}`);

  // matched control on the two that matter
  const mFib = matchedControl(list, tp, sl, hold);
  const mLeg = matchedControl(legRej, tp, sl, hold);
  console.log(`\n  matched (same hour, +/-5d): fib hold ${f(mFib.alpha)}  vs  random-level leg-filtered bounce ${f(mLeg.alpha)}`);
}

// ═════════════════════════════════════════════════════════════════════════════
const stage = process.argv[2] || 'all';
const STAGES = {
  online: () => cmpOnline(),
  prefix: stagePrefix,
  measure: stageMeasure,
  matched: stageMatched,
  holdout: stageHoldout,
  sig: stageSig,
  control: stageControl,
};
if (stage === 'all') {
  cmpOnline(); stagePrefix(); stageMeasure(); stageMatched(); stageSig(); stageControl(); stageHoldout();
} else (STAGES[stage] || stageMeasure)();
