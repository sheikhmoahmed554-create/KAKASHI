'use strict';
/* ===========================================================================
 * daily-open  —  the daily open and the session opens, rebuilt.
 *
 * WHAT WAS WRONG WITH THE ORIGINAL
 * --------------------------------
 * tools/levels.js:dailyOpenLevels() takes one anchor and one anchor only:
 * Math.floor(t / 86400000) — midnight on the timestamp clock. For this feed
 * that lands inside the 00:00–01:00 nightly maintenance gap, so the level it
 * produces is the open of the 01:00 bar, which is the CME Globex electronic
 * open (18:00 New York). That is a real boundary for a clearing house and a
 * dead one for a trader: it is the quietest hour of the gold day and, measured
 * below, price respects it 68.9% of the time against a random-level control of
 * 68.95%. It is exactly, precisely worthless — not weak, worthless.
 *
 * Three further faults, each worth more than the anchor:
 *
 *   1. ONE open per day. Gold has several openings a day that real desks mark
 *      from — Shanghai, London/LBMA, the US data window, the COMEX pit, the
 *      NYSE bell — and they are separate fixed levels, not one.
 *   2. The "test" was scaled to 1m ATR (23 pts), so any 35-point wobble counted
 *      as price leaving and returning. That yields ~10 "tests" of the daily
 *      open per day. A level is tested a handful of times a week.
 *   3. Everything was forced onto 90/90. Median daily range here is 1095 pts,
 *      so 90/90 is not "too big", it is arbitrary — it was never matched to the
 *      excursion a test of the open actually produces.
 *
 * WHAT THIS FILE DOES
 * -------------------
 *   stage 0  establishes the feed's session clock from the data itself
 *   stage 1  measures the current construction, direction-adjusted, at 90/90
 *   stage 2  sweeps anchor × ATR-timeframe on RESPECT and event count only
 *            (both trade-agnostic, so the choice of level is not made by
 *            peeking at P&L)
 *   stage 3  measures the excursion a test of the open really gives
 *   stage 4  sizes target/stop/hold, with the blind baseline recomputed at
 *            every single config, across all four readings
 *   stage 5  in-sample / out-of-sample split — config chosen on Jan–Apr,
 *            reported on May–Jul
 *   stage 6  robustness: month by month, anchor jitter, parameter jitter,
 *            and an explicit lookahead audit
 *
 * CALIBRATION (measured in this repo, not assumed):
 *   random levels are respected 68.95% of the time — 69 is zero, not 50
 *   blind long ≈ -5.0 pts/trade, blind short ≈ +4.1 pts/trade at 90/90/1440
 *   longs are scored against blind long and shorts against blind short, always
 *   at the same target/stop/hold, then combined weighted by count
 *   cost 0.5 pts round trip. 1 pt = $0.10.
 *
 * Usage:  node --max-old-space-size=3500 tools/fixes/daily-open.js [stage...]
 * =========================================================================== */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require(path.join(__dirname, '..', 'ai963_engine'));
const LV = require(path.join(__dirname, '..', 'levels'));
const { levelTestEvents, respectRate } = require(path.join(__dirname, '..', 'level_events'));

const PU = 0.10, COST = 0.5;
const RANDOM_RESPECT = 68.95;

// ───────────────────────────── data ─────────────────────────────
// Loader copied verbatim from tools/sweep_timeframes.js so the sample matches.
function loadBars() {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'KAKASHI_V16_TV_PARITY_AUDIT.html'), 'utf8');
  const csv = zlib.gunzipSync(Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1], 'base64')).toString('utf8');
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
const N = bars.length;
const atr1 = E.atr(bars, 14);

// ATR on higher timeframes, projected onto the 1m stream one HTF bar late.
const TFS = [1, 5, 15, 60, 240, 1440];
const TF_NAME = { 1: '1m', 5: '5m', 15: '15m', 60: '1H', 240: '4H', 1440: 'D' };
const ATR_TF = new Map();
for (const m of TFS) {
  const { bars: b, index } = E.resample(bars, m);
  const a = E.atr(b, 14);
  ATR_TF.set(m, m === 1 ? a : E.projectConfirmed(a, index));
}

// ─────────────────── the session clock of this feed ───────────────────
/*
 * Read off the data (stage 0). Bars run 01:00 → 23:58 on the label clock,
 * Mon–Fri, with a 62-minute nightly break. The volatility peaks at 15:30 and
 * 16:30 sit at the same label time in January and in July, while the Asian
 * peak walks 03:00 → 04:00 across the spring DST boundary. Only one clock does
 * that: a server clock that is UTC+2 in winter and UTC+3 in summer, with the
 * US-anchored events therefore fixed and the China-anchored ones (no DST)
 * sliding. That pins every session in label time:
 *
 *   01:00  CME Globex gold open (18:00 New York)  ← the current "daily open"
 *   03:00 / 04:00  Shanghai Gold Exchange open (09:00 China, winter/summer)
 *   10:00  London / LBMA open (08:00 London)
 *   12:30  LBMA AM auction (10:30 London)
 *   15:30  US macro window (08:30 New York)
 *   16:20  COMEX pit open (08:20 New York)
 *   16:30  NYSE open (09:30 New York)
 *   17:00  LBMA PM auction (15:00 London)
 *   20:30  COMEX pit close (13:30 New York)
 *   23:00  NYSE close (16:00 New York)
 *
 * The 62-minute break at 00:00 → 01:00 label is 22:00 → 23:00 UTC in winter,
 * i.e. 17:00 → 18:00 New York: the CME daily settlement halt. Consistent.
 */
const NAMED = {
  60: 'Globex open 18:00 NY  [CURRENT]',
  180: 'Shanghai open (winter)',
  240: 'Shanghai open (summer)',
  600: 'London / LBMA open',
  750: 'LBMA AM auction',
  930: 'US macro 08:30 NY',
  980: 'COMEX pit open',
  990: 'NYSE open 09:30 NY',
  1020: 'LBMA PM auction',
  1230: 'COMEX pit close',
  1380: 'NYSE close 16:00 NY',
};
const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

// ─────────────────────── level construction ───────────────────────
/**
 * The opening price of one named session, held as a FIXED value.
 *
 * For each calendar day we take the first bar whose minute-of-day falls in
 * [anchorMin, anchorMin + catch) and freeze its OPEN. Nothing about the level
 * depends on where price goes afterwards and nothing about it moves with the
 * close — that was the flaw that turned half the generators in levels.js into
 * step functions trailing price rather than levels.
 *
 * Causality: the open of bar k is known the moment bar k begins, so publishing
 * it at bar k would already be legitimate. `lag` (default 1) withholds it until
 * bar k has closed anyway, which is strictly more conservative and matches the
 * one-HTF-bar-late convention used everywhere else in this repo.
 * `lifeMin` retires the level that many minutes after its anchor; the default
 * 1440 keeps it live until the next day's anchor replaces it.
 */
function sessionOpenLine(bs, anchorMin, opts = {}) {
  const lag = opts.lag ?? 1;
  const lifeMin = opts.lifeMin ?? 1440;
  const catchMin = opts.catchMin ?? 120;
  const out = new Array(bs.length).fill(NaN);

  const anchors = [];
  let curDate = -1, taken = false;
  for (let i = 0; i < bs.length; i++) {
    const date = Math.floor(bs[i].t / 86400000);
    if (date !== curDate) { curDate = date; taken = false; }
    if (taken) continue;
    const d = new Date(bs[i].t);
    const mod = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (mod >= anchorMin && mod < anchorMin + catchMin) { anchors.push(i); taken = true; }
  }

  for (let a = 0; a < anchors.length; a++) {
    const k = anchors[a];
    const px = bs[k].o;                        // frozen at the anchor bar's open
    const stop = a + 1 < anchors.length ? anchors[a + 1] : bs.length;
    const tCut = bs[k].t + lifeMin * 60000;
    for (let i = k + lag; i < stop; i++) {
      if (bs[i].t > tCut) break;
      out[i] = px;
    }
  }
  return { line: out, anchors };
}

// ─────────────────────── outcome machinery ───────────────────────
/*
 * One forward walk per entry records the first-touch bar of every target and
 * every stop in the grid, plus the close-out P&L at every hold. Any
 * (target, stop, hold) triple then reads out in O(1) — which is what makes it
 * affordable to recompute the blind baseline at every single config instead of
 * scoring a 20-point trade against a 90-point baseline.
 *
 * The read-out reproduces tools/sweep_timeframes.js:race() exactly, including
 * its rule that a bar which touches both target and stop is discarded rather
 * than guessed.
 */
const TP_GRID = [10, 15, 20, 30, 40, 60, 80, 90, 110, 140, 180, 240, 320];
const SL_GRID = [10, 15, 20, 30, 40, 60, 80, 90, 110, 140, 180, 240, 320];
const HOLD_GRID = [30, 60, 120, 240, 480, 1440];
const MAXH = 1440;
const NT = TP_GRID.length, NS = SL_GRID.length, NH = HOLD_GRID.length;

function walk(i, dir) {
  const e = bars[i].c;
  const end = Math.min(N - 1, i + MAXH);
  const ftp = new Int32Array(NT).fill(0x7fffffff);
  const fsl = new Int32Array(NS).fill(0x7fffffff);
  const closeP = new Float64Array(NH);
  const mfeH = new Float64Array(NH), maeH = new Float64Array(NH);   // excursion per horizon
  let ti = 0, si = 0, hi = 0, mfe = 0, mae = 0;
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    const fav = dir === 1 ? (b.h - e) / PU : (e - b.l) / PU;
    const adv = dir === 1 ? (e - b.l) / PU : (b.h - e) / PU;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
    while (ti < NT && mfe >= TP_GRID[ti]) ftp[ti++] = j - i;
    while (si < NS && mae >= SL_GRID[si]) fsl[si++] = j - i;
    while (hi < NH && j - i >= HOLD_GRID[hi]) { closeP[hi] = (b.c - e) * dir / PU - COST; mfeH[hi] = mfe; maeH[hi] = mae; hi++; }
  }
  while (hi < NH) { closeP[hi] = (bars[end].c - e) * dir / PU - COST; mfeH[hi] = mfe; maeH[hi] = mae; hi++; }
  return { ftp, fsl, closeP, mfe, mae, mfeH, maeH };
}

/** Read one (target, stop, hold) out of a walk. null = ambiguous bar, discard. */
function pnl(w, ti, si, hi) {
  const h = HOLD_GRID[hi];
  const t = w.ftp[ti], s = w.fsl[si];
  const tHit = t <= h, sHit = s <= h;
  if (tHit && sHit) { if (t === s) return null; return t < s ? TP_GRID[ti] - COST : -SL_GRID[si] - COST; }
  if (tHit) return TP_GRID[ti] - COST;
  if (sHit) return -SL_GRID[si] - COST;
  return w.closeP[hi];
}

// The exact rng and sampling bounds of tools/sweep_timeframes.js, so the
// reference blind numbers reproduce to the digit.
function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function blindIndices(n, seed) {
  const r = rng(seed);
  const lo = 100, hi = N - MAXH - 2;
  const out = new Int32Array(n);
  for (let k = 0; k < n; k++) out[k] = lo + Math.floor(r() * (hi - lo));
  return out;
}

const NB = 40000;
const GRIDN = NT * NS * NH;
const bIdx = (ti, si, hi) => (ti * NS + si) * NH + hi;
const BLIND = {};        // full sample
const BLIND_SEG = {};    // [dir][segment] where segment 0 = first half, 1 = second half

function baselineFor(dir, seed, filter) {
  const idx = blindIndices(NB, seed);
  const sum = new Float64Array(GRIDN), cnt = new Float64Array(GRIDN);
  for (let k = 0; k < NB; k++) {
    const i = idx[k];
    if (filter && !filter(i)) continue;
    const w = walk(i, dir);
    for (let p = 0, ti = 0; ti < NT; ti++)
      for (let si = 0; si < NS; si++)
        for (let hi = 0; hi < NH; hi++, p++) {
          const v = pnl(w, ti, si, hi);
          if (v === null) continue;
          sum[p] += v; cnt[p]++;
        }
  }
  const mean = new Float64Array(GRIDN);
  for (let p = 0; p < GRIDN; p++) mean[p] = cnt[p] >= 200 ? sum[p] / cnt[p] : NaN;
  return mean;
}

let SPLIT_I = 0;   // bar index where the out-of-sample half begins
function buildBaselines() {
  SPLIT_I = Math.floor(N / 2);
  BLIND[1] = baselineFor(1, 31337, null);
  BLIND[-1] = baselineFor(-1, 73331, null);
  BLIND_SEG[1] = [baselineFor(1, 31337, i => i < SPLIT_I), baselineFor(1, 31337, i => i >= SPLIT_I)];
  BLIND_SEG[-1] = [baselineFor(-1, 73331, i => i < SPLIT_I), baselineFor(-1, 73331, i => i >= SPLIT_I)];
}

// ───────────────────────── scoring ─────────────────────────
/**
 * Direction-adjusted alpha for one set of events at one (target, stop, hold).
 * Longs are scored against the blind-long baseline, shorts against the
 * blind-short baseline, both recomputed at this exact target/stop/hold, and the
 * two are combined weighted by count. The market fell over this sample; an
 * unadjusted number would just be measuring that.
 * `seg` picks a baseline restricted to the same half of the sample, so an
 * out-of-sample number is compared against out-of-sample drift.
 */
function scoreAt(events, ti, si, hi, flip, seg) {
  const BL = seg === undefined ? BLIND : { 1: BLIND_SEG[1][seg], '-1': BLIND_SEG[-1][seg] };
  const p = bIdx(ti, si, hi);
  let ln = 0, lnet = 0, sn = 0, snet = 0, wins = 0, tot = 0, gross = 0;
  for (const ev of events) {
    const dir = flip ? -ev.dir : ev.dir;
    const w = ev._w[flip ? 1 : 0];
    const v = pnl(w, ti, si, hi);
    if (v === null) continue;
    tot++; gross += v; if (v > 0) wins++;
    if (dir === 1) { ln++; lnet += v; } else { sn++; snet += v; }
  }
  if (!tot) return { n: 0, alpha: NaN, raw: NaN, win: NaN, longs: 0, shorts: 0 };
  const bl = BL[1][p], bs = BL[-1][p];
  const la = ln && Number.isFinite(bl) ? lnet / ln - bl : 0;
  const sa = sn && Number.isFinite(bs) ? snet / sn - bs : 0;
  return {
    n: tot, longs: ln, shorts: sn,
    raw: gross / tot,
    alpha: (la * ln + sa * sn) / tot,
    win: (100 * wins) / tot,
  };
}

/** Attach both forward walks (as-signalled and inverted) once per event. */
function attach(events) {
  const out = [];
  for (const ev of events) {
    if (ev.i >= N - 5) continue;
    if (!ev._w) ev._w = [walk(ev.i, ev.dir), walk(ev.i, -ev.dir)];
    out.push(ev);
  }
  return out;
}

const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quant = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f = (x, d = 2) => Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '—';
const fp = (x, d = 1) => Number.isFinite(x) ? x.toFixed(d) : '—';

/** Best (target, stop, hold) for one event set and one reading. */
function bestConfig(set, flip, minN, seg) {
  let b = null;
  for (let ti = 0; ti < NT; ti++)
    for (let si = 0; si < NS; si++)
      for (let hi = 0; hi < NH; hi++) {
        const s = scoreAt(set, ti, si, hi, flip, seg);
        if (s.n < minN || !Number.isFinite(s.alpha)) continue;
        if (!b || s.alpha > b.s.alpha) b = { s, ti, si, hi };
      }
  return b;
}

const READINGS = [
  ['bounce  (reject, as signalled)', 'reject', false],
  ['fade    (reject, inverted)', 'reject', true],
  ['break   (break, as signalled)', 'break', false],
  ['antibrk (break, inverted)', 'break', true],
  ['all     (as signalled)', null, false],
  ['all     (inverted)', null, true],
];

// ─────────────────── event sets: real levels and placebos ───────────────────
const ANCHORS = [];
for (let m = 60; m <= 1380; m += 60) ANCHORS.push(m);
for (const m of [750, 930, 980, 990, 1230]) if (!ANCHORS.includes(m)) ANCHORS.push(m);
ANCHORS.sort((a, b) => a - b);

// The openings a gold desk actually marks from, as opposed to the clearing
// house's bookkeeping boundary at 01:00.
const SESSION_SET = [600, 930, 980, 990, 1020];   // London, US data, COMEX pit, NYSE, LBMA PM

const EV = new Map();
function eventsFor(m, tf, opts) {
  const k = `${m}|${tf}|${opts ? JSON.stringify(opts) : ''}`;
  if (EV.has(k)) return EV.get(k);
  const { line } = sessionOpenLine(bars, m, opts);
  const ev = attach(levelTestEvents(bars, line, ATR_TF.get(tf)));
  for (const e of ev) e.anchor = m;
  EV.set(k, ev);
  return ev;
}
function pooled(ms, tf, opts) {
  const out = [];
  for (const m of ms) out.push(...eventsFor(m, tf, opts));
  return out.sort((a, b) => a.i - b.i);
}

/**
 * THE PLACEBO.
 *
 * Two things in this study inflate results for reasons that have nothing to do
 * with the daily open, and both are silent unless controlled:
 *
 *   - Respect rises mechanically with the ATR scale. The published 68.95%
 *     control was measured with 1m ATR; at 15m ATR *any* level looks respected
 *     because the approach and tolerance bands are five times wider.
 *   - levelTestEvents enters at the close of the reaction bar. If this market
 *     has any one-bar mean reversion, "fade the bounce" earns money at every
 *     level, real or invented.
 *
 * The placebo is the same construction with the price replaced: same anchors,
 * same one-bar publication lag, same lifetime, same ATR scale, same event
 * detector — but the level is the anchor bar's open displaced by a random
 * multiple of ATR. It therefore lives in the same neighbourhood as price and
 * inherits every property of the machinery, and differs only in not being the
 * open. Anything the real level scores that the placebo also scores is not the
 * level.
 */
/*
 * Three placebo flavours, because one is not enough to pin the claim down:
 *
 *   'far'      the open displaced 0.6–3 ATR. Controls for the detector and the
 *              scale, but the level starts away from price, so its first touch
 *              is a first arrival rather than a return.
 *   'near'     the open displaced 0.25–0.8 ATR. Sits where price actually was,
 *              so the approach-and-return structure matches the real level.
 *   'intraday' the CLOSE of a random bar 30–240 minutes after the anchor. This
 *              is the sharpest control of all: a genuine traded price from
 *              earlier in the same session, frozen and published the same way.
 *              If the open beats this, the OPEN is what matters. If it does
 *              not, what matters is "a fixed price from earlier today", and the
 *              opening print is nothing special.
 */
function placeboLine(anchorMin, tf, seed, opts = {}) {
  const lag = opts.lag ?? 1;
  const lifeMin = opts.lifeMin ?? 1440;
  const mode = opts.mode ?? 'far';
  const r = rng(seed);
  const { anchors } = sessionOpenLine(bars, anchorMin, opts);
  const A = ATR_TF.get(tf);
  const out = new Array(N).fill(NaN);
  for (let a = 0; a < anchors.length; a++) {
    const k = anchors[a];
    const stop = a + 1 < anchors.length ? anchors[a + 1] : N;
    const tCut = bars[k].t + lifeMin * 60000;
    let px, from = k;
    if (mode === 'intraday') {
      const off = 30 + Math.floor(r() * 210);          // 30–240 min after the anchor
      const j = k + off;
      if (j >= stop || j >= N) continue;
      px = bars[j].c;                                   // a price the market really traded
      from = j;                                         // and it is only known once bar j closed
    } else {
      const at = Number.isFinite(A[k]) ? A[k] : atr1[k];
      if (!Number.isFinite(at) || at <= 0) continue;
      const lo = mode === 'near' ? 0.25 : 0.6, hi = mode === 'near' ? 0.8 : 3;
      const u = (lo + r() * (hi - lo)) * (r() < 0.5 ? -1 : 1);
      px = bars[k].o + u * at;
    }
    for (let i = from + lag; i < stop; i++) { if (bars[i].t > tCut) break; out[i] = px; }
  }
  return out;
}
const PEV = new Map();
function placeboEvents(anchorMin, tf, seed, opts) {
  const k = `${anchorMin}|${tf}|${seed}|${opts ? JSON.stringify(opts) : ''}`;
  if (PEV.has(k)) return PEV.get(k);
  const ev = attach(levelTestEvents(bars, placeboLine(anchorMin, tf, seed, opts), ATR_TF.get(tf)));
  PEV.set(k, ev);
  return ev;
}

// ───────────────────────── stages ─────────────────────────
const argv = process.argv.slice(2);
const want = argv.length ? new Set(argv) : new Set(['0', '1', '2', '3', '4', '5', '6']);
const on = s => want.has(String(s));
const hr = t => `\n${'═'.repeat(84)}\n${t}\n${'═'.repeat(84)}`;

function stage0() {
  console.log(hr("0.  THE FEED'S CLOCK"));
  const byH = new Array(24).fill(0), rngH = new Array(24).fill(0);
  for (const b of bars) { const h = new Date(b.t).getUTCHours(); byH[h]++; rngH[h] += b.h - b.l; }
  console.log(`  ${N.toLocaleString()} bars  ${new Date(bars[0].t).toISOString().slice(0, 10)} → ${new Date(bars[N - 1].t).toISOString().slice(0, 10)}   Mon–Fri only`);
  console.log(`  hour 00 holds ${byH[0]} bars: the nightly break is 00:00→01:00, so midnight is not a tradeable`);
  console.log('  anchor — floor(t/86400000) resolves to the 01:00 bar, i.e. the CME Globex open.');
  const q = [];
  for (let h = 0; h < 24; h++) if (byH[h]) q.push([h, rngH[h] / byH[h] / PU]);
  q.sort((a, b) => b[1] - a[1]);
  console.log('  busiest hours, average 1m range in pts: ' + q.slice(0, 6).map(x => `${String(x[0]).padStart(2, '0')}:00=${x[1].toFixed(0)}`).join('  '));
  const days = new Map();
  for (const x of bars) { const d = Math.floor(x.t / 86400000); if (!days.has(d)) days.set(d, { h: x.h, l: x.l }); const y = days.get(d); y.h = Math.max(y.h, x.h); y.l = Math.min(y.l, x.l); }
  console.log(`  ${days.size} trading days, median daily range ${median([...days.values()].map(d => (d.h - d.l) / PU)).toFixed(0)} pts.`);
  console.log('  median ATR by timeframe (pts): ' + TFS.map(tf => `${TF_NAME[tf]}=${(median(ATR_TF.get(tf).filter(Number.isFinite)) / PU).toFixed(0)}`).join('  '));
}

// ---- stage 1 ---------------------------------------------------------------
let ALPHA_BEFORE = NaN;
function stage1() {
  console.log(hr('1.  THE CURRENT CONSTRUCTION   levels.js:dailyOpenLevels, 90 / 90 / 1440, 1m ATR'));
  const ti = TP_GRID.indexOf(90), si = SL_GRID.indexOf(90), hi = HOLD_GRID.indexOf(1440);
  console.log(`  blind long ${f(BLIND[1][bIdx(ti, si, hi)])}   blind short ${f(BLIND[-1][bIdx(ti, si, hi)])}   (reproduces tools/sweep_timeframes.js)`);
  const ev = attach(levelTestEvents(bars, LV.dailyOpenLevels(bars).line, atr1));
  const r = respectRate(ev);
  const s = scoreAt(ev, ti, si, hi, false);
  ALPHA_BEFORE = s.alpha;
  console.log(`  tests ${r.tests}   respect ${fp(r.respect)}%   random control 68.95%   →  edge ${f(r.respect - RANDOM_RESPECT)} pts of respect`);
  console.log(`  raw ${f(s.raw)}   longs ${s.longs}  shorts ${s.shorts}  win ${fp(s.win)}%   →   ALPHA ${f(s.alpha)} pts/trade`);
  for (const [name, kind, flip] of READINGS) {
    const set = kind ? ev.filter(e => e.kind === kind) : ev;
    if (set.length < 40) continue;
    const x = scoreAt(set, ti, si, hi, flip);
    console.log(`     ${name.padEnd(32)} n=${String(x.n).padStart(4)}   alpha ${f(x.alpha).padStart(7)}`);
  }
  console.log('\n  Each reading is the exact negative of its inverse: the direction adjustment has');
  console.log('  already removed the drift, so these numbers describe the level, not the market.');
  console.log('  The headline is the "all, as signalled" line: ' + f(ALPHA_BEFORE) + ' pts/trade.');
  return ALPHA_BEFORE;
}

// ---- stage 2: which open, at what scale, against a MATCHED control ----------
const CTRL = new Map();   // tf -> matched placebo respect
function stage2() {
  console.log(hr('2.  WHICH OPEN, AND AT WHAT SCALE?'));
  console.log('  Chosen on respect and event count only — both trade-agnostic, so the level is');
  console.log('  not picked by peeking at P&L. The control is NOT 68.95% except at 1m: respect');
  console.log('  rises mechanically as the ATR scale widens, so a matched placebo is measured at');
  console.log('  every scale (same anchors, same lag, same detector, level displaced ±3 ATR).\n');
  const useTf = [1, 5, 15, 60];

  process.stdout.write('  measuring matched placebo controls …\r');
  for (const tf of useTf) {
    const ev = [];
    for (let s = 0; s < 6; s++) for (const m of ANCHORS) ev.push(...placeboEvents(m, tf, 91711 + s * 7717 + m));
    const r = respectRate(ev);
    CTRL.set(tf, r);
  }
  console.log('  matched placebo control (a fake fixed daily level in the same place):        ');
  for (const tf of useTf) console.log(`     ${TF_NAME[tf].padStart(4)} ATR   respect ${fp(CTRL.get(tf).respect)}%   (${CTRL.get(tf).tests.toLocaleString()} placebo events)`);
  console.log(`     the published 1m random-level control is ${RANDOM_RESPECT}% — the placebo reproduces it, which`);
  console.log('     is the check that this control is measuring the same thing.\n');

  console.log('  Cell = respect% and, in brackets, the EDGE over the matched control at that scale.');
  console.log('  anchor  ' + useTf.map(t => (TF_NAME[t] + ' ATR').padStart(18)).join('') + '  session');
  console.log('  ' + '─'.repeat(9 + 18 * useTf.length + 28));
  const table = [];
  for (const m of ANCHORS) {
    const cells = [];
    for (const tf of useTf) {
      const r = respectRate(eventsFor(m, tf));
      cells.push({ tf, ...r, edge: r.respect - CTRL.get(tf).respect });
    }
    table.push({ m, cells });
    console.log('  ' + hhmm(m) + '  ' + cells.map(c => (c.tests >= 60 ? `${fp(c.respect)} [${f(c.edge, 1)}] ${c.tests}` : `— (${c.tests})`).padStart(18)).join('') + '  ' + (NAMED[m] || ''));
  }

  console.log('\n  Pooled by scale, and the pooled real-vs-placebo edge:');
  for (const tf of useTf) {
    const rs = table.map(r => r.cells.find(c => c.tf === tf));
    const tot = rs.reduce((a, c) => a + c.tests, 0), rej = rs.reduce((a, c) => a + c.rejects, 0);
    console.log(`     ${TF_NAME[tf].padStart(4)} ATR   real ${fp(100 * rej / tot)}%   placebo ${fp(CTRL.get(tf).respect)}%   edge ${f(100 * rej / tot - CTRL.get(tf).respect, 2)}   ${(tot / ANCHORS.length / 140).toFixed(1)} events per anchor per day`);
  }
  console.log('\n  Read that carefully: once the control is matched to the scale, the respect edge of');
  console.log('  the open over an invented level is small at every scale. Respect is not where');
  console.log('  this level earns its living — so the rest of the study goes after the excursion.');
  return table;
}

// ---- stage 3: excursion, by horizon, against the placebo -------------------
/** Median favourable and adverse travel at each horizon, in the signalled direction. */
function excursion(set, flip) {
  const k = flip ? 1 : 0;
  const rows = [];
  for (let hi = 0; hi < NH; hi++) {
    const mfe = set.map(e => e._w[k].mfeH[hi]), mae = set.map(e => e._w[k].maeH[hi]);
    rows.push({ hold: HOLD_GRID[hi], mfe: median(mfe), mae: median(mae), p25: quant(mfe, .25), p75: quant(mfe, .75) });
  }
  return rows;
}

function stage3(picks, seeds = 3) {
  console.log(hr('3.  EXCURSION — how far does price really travel after a test of the open?'));
  console.log('  Median favourable and adverse travel, in points, at each horizon, in the direction');
  console.log('  the event signals. Alongside each is the matched PLACEBO: the same detector on an');
  console.log('  invented daily level. If the real level and the invented one produce the same');
  console.log('  excursion, the excursion belongs to the market, not to the open.\n');
  for (const p of picks) {
    const set = p.kind ? p.ev.filter(e => e.kind === p.kind) : p.ev;
    if (set.length < 40) continue;
    const pev = [];
    for (let s = 0; s < seeds; s++) for (const m of p.anchors) pev.push(...placeboEvents(m, p.tf, 44101 + s * 6323 + m));
    const pset = p.kind ? pev.filter(e => e.kind === p.kind) : pev;
    console.log(`  ── ${p.label}   ${TF_NAME[p.tf]} ATR   ${p.kind || 'all'}   n=${set.length}   (placebo n=${pset.length})`);
    console.log('     hold    medMFE  medMAE   MFE-MAE  |  placebo medMFE medMAE  MFE-MAE  |  real minus placebo');
    const R = excursion(set, false), P = excursion(pset, false);
    for (let hi = 0; hi < NH; hi++) {
      const d = R[hi].mfe - R[hi].mae, pd = P[hi].mfe - P[hi].mae;
      console.log(`     ${String(HOLD_GRID[hi]).padStart(4)}  ${fp(R[hi].mfe).padStart(9)} ${fp(R[hi].mae).padStart(7)} ${f(d, 1).padStart(9)}  | ${fp(P[hi].mfe).padStart(13)} ${fp(P[hi].mae).padStart(6)} ${f(pd, 1).padStart(8)}  | ${f(d - pd, 1).padStart(12)}`);
    }
  }
  console.log('\n  MFE − MAE is the only number here that can carry an edge: it is the asymmetry of');
  console.log('  the travel. Everything else is volatility, and volatility is identical for the');
  console.log('  placebo. 90/90 was never wrong for being too wide or too narrow — it was wrong');
  console.log('  for being unrelated to any measured asymmetry.');
}

// ---- stage 4: size the trade, with the placebo alongside -------------------
/** Alpha of the identical pipeline on invented levels: the number that decides everything. */
function placeboAlpha(anchors, tf, kind, flip, ti, si, hi, seeds = 8, seg, mode = 'far') {
  const out = [];
  for (let s = 0; s < seeds; s++) {
    const pev = [];
    for (const m of anchors) pev.push(...placeboEvents(m, tf, 55001 + s * 9173 + m, { mode }));
    const pset = kind ? pev.filter(e => e.kind === kind) : pev;
    const sub = seg === undefined ? pset : pset.filter(e => seg === 0 ? e.i < SPLIT_I : e.i >= SPLIT_I);
    const ps = scoreAt(sub, ti, si, hi, flip, seg);
    if (ps.n >= 40) out.push(ps.alpha);
  }
  if (!out.length) return { mean: NaN, sd: NaN, n: 0 };
  const m = out.reduce((a, b) => a + b, 0) / out.length;
  const sd = out.length > 1 ? Math.sqrt(out.reduce((a, v) => a + (v - m) ** 2, 0) / (out.length - 1)) : NaN;
  return { mean: m, sd, n: out.length, min: Math.min(...out), max: Math.max(...out) };
}

/**
 * Trades here overlap massively: 20 events a day each held for up to 480
 * minutes are not 2,795 independent observations. A plain standard error would
 * flatter the result badly, so significance is taken from a block bootstrap
 * that resamples whole trading DAYS with replacement — the block being the
 * natural unit of dependence.
 */
function dayBlockBootstrap(set, ti, si, hi, flip, iters = 2000, seed = 4242) {
  const byDay = new Map();
  for (const e of set) {
    const v = pnl(e._w[flip ? 1 : 0], ti, si, hi);
    if (v === null) continue;
    const d = Math.floor(bars[e.i].t / 86400000);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push({ v, dir: flip ? -e.dir : e.dir });
  }
  const days = [...byDay.values()];
  if (days.length < 20) return null;
  const p = bIdx(ti, si, hi), bl = BLIND[1][p], bs = BLIND[-1][p];
  const alphaOf = pool => {
    let ln = 0, lnet = 0, sn = 0, snet = 0;
    for (const t of pool) { if (t.dir === 1) { ln++; lnet += t.v; } else { sn++; snet += t.v; } }
    const tot = ln + sn; if (!tot) return NaN;
    const la = ln ? lnet / ln - bl : 0, sa = sn ? snet / sn - bs : 0;
    return (la * ln + sa * sn) / tot;
  };
  const point = alphaOf(days.flat());
  const r = rng(seed), draws = [];
  for (let it = 0; it < iters; it++) {
    const pool = [];
    for (let d = 0; d < days.length; d++) pool.push(...days[Math.floor(r() * days.length)]);
    const a = alphaOf(pool);
    if (Number.isFinite(a)) draws.push(a);
  }
  draws.sort((a, b) => a - b);
  const q = p2 => draws[Math.min(draws.length - 1, Math.floor(p2 * draws.length))];
  const neg = draws.filter(x => x <= 0).length;
  return { point, days: days.length, lo: q(0.025), hi: q(0.975), pOneSided: neg / draws.length };
}

function stage4(picks, minN, withPlacebo) {
  console.log(hr('4.  TARGET AND STOP SIZED TO THE LEVEL   blind baseline recomputed at every cell'));
  console.log(`  Best (target / stop / hold) per reading, full sample, minimum ${minN} events.`);
  console.log(`  Grid searched: ${NT} targets × ${NS} stops × ${NH} holds = ${NT * NS * NH} cells per reading.`);
  console.log('  ALPHA is direction-adjusted. PLACEBO is the same cell measured on invented levels;');
  console.log('  NET = ALPHA − PLACEBO is what is actually attributable to the open.\n');
  const all = [];
  for (const p of picks) {
    console.log(`  ── ${p.label}   ${TF_NAME[p.tf]} ATR   (${p.ev.length} events)`);
    for (const [name, kind, flip] of READINGS) {
      const set = kind ? p.ev.filter(e => e.kind === kind) : p.ev;
      const b = bestConfig(set, flip, minN);
      if (!b) continue;
      let pl = null, tail = '';
      if (withPlacebo) {
        pl = placeboAlpha(p.anchors, p.tf, kind, flip, b.ti, b.si, b.hi, 8);
        tail = `  placebo ${f(pl.mean).padStart(7)}±${fp(pl.sd, 1)}  NET ${f(b.s.alpha - pl.mean).padStart(7)}`;
      }
      console.log(`     ${name.padEnd(32)} n=${String(b.s.n).padStart(5)} L/S ${String(b.s.longs).padStart(4)}/${String(b.s.shorts).padStart(4)}  TP ${String(TP_GRID[b.ti]).padStart(3)}/SL ${String(SL_GRID[b.si]).padStart(3)}/h ${String(HOLD_GRID[b.hi]).padStart(4)}  win ${fp(b.s.win).padStart(5)}%  ALPHA ${f(b.s.alpha).padStart(7)}${tail}`);
      all.push({ ...p, name, kind, flip, ...b, placebo: pl });
    }
  }
  all.sort((a, b) => (b.s.alpha - (b.placebo ? b.placebo.mean : 0)) - (a.s.alpha - (a.placebo ? a.placebo.mean : 0)));
  return all;
}

// ---- stage 5: in-sample / out-of-sample ------------------------------------
function stage5(cands, minIS, minOOS) {
  console.log(hr('5.  HONEST SPLIT — choose the target/stop on Jan–Apr, report it on May–Jul'));
  const cut = bars[SPLIT_I].t;
  console.log(`  split at ${new Date(cut).toISOString().slice(0, 16).replace('T', ' ')}   (${SPLIT_I.toLocaleString()} bars each side)`);
  console.log('  Baselines are recomputed per half, so each half is scored against its own drift.\n');
  console.log('  set                     atrTF reading                        IS n  IS α    OOS n OOS α   full α  TP/SL/hold');
  console.log('  ' + '─'.repeat(112));
  const out = [];
  for (const c of cands) {
    const set = c.kind ? c.ev.filter(e => e.kind === c.kind) : c.ev;
    const isSet = set.filter(e => e.i < SPLIT_I), oosSet = set.filter(e => e.i >= SPLIT_I);
    const b = bestConfig(isSet, c.flip, minIS, 0);
    if (!b) continue;
    const o = scoreAt(oosSet, b.ti, b.si, b.hi, c.flip, 1);
    if (o.n < minOOS) continue;
    const full = scoreAt(set, b.ti, b.si, b.hi, c.flip);
    out.push({ ...c, ti: b.ti, si: b.si, hi: b.hi, is: b.s, oos: o, full });
    console.log(`  ${c.label.padEnd(23)} ${TF_NAME[c.tf].padStart(4)} ${c.name.padEnd(32)} ${String(b.s.n).padStart(4)} ${f(b.s.alpha).padStart(7)}  ${String(o.n).padStart(4)} ${f(o.alpha).padStart(7)} ${f(full.alpha).padStart(7)}  ${TP_GRID[b.ti]}/${SL_GRID[b.si]}/${HOLD_GRID[b.hi]}`);
  }
  console.log('\n  A configuration that only works in the half it was chosen on is a fitted number.');
  return out;
}

// ---- stage 6: robustness and placebo ---------------------------------------
function stage6(win) {
  console.log(hr('6.  ROBUSTNESS OF THE CHOSEN CONSTRUCTION'));
  const { tf, kind, flip, ti, si, hi } = win;
  console.log(`  ${win.label}, ${TF_NAME[tf]} ATR, ${win.name.trim()}, TP ${TP_GRID[ti]} / SL ${SL_GRID[si]} / hold ${HOLD_GRID[hi]}\n`);
  const set = kind ? win.ev.filter(e => e.kind === kind) : win.ev;
  const full = scoreAt(set, ti, si, hi, flip);
  console.log(`  full sample: n=${full.n}  raw ${f(full.raw)}  win ${fp(full.win)}%  longs ${full.longs} shorts ${full.shorts}  ALPHA ${f(full.alpha)}`);

  // THE PLACEBOS — the numbers that decide whether any of this is the level.
  console.log('\n  PLACEBOS: the identical pipeline on levels that are not the open');
  let pm = NaN, psd = NaN;
  for (const mode of ['far', 'near', 'intraday']) {
    const p = placeboAlpha(win.anchors, tf, kind, flip, ti, si, hi, 12, undefined, mode);
    const note = { far: 'open ± 0.6–3 ATR', near: 'open ± 0.25–0.8 ATR', intraday: 'a real traded price 30–240 min after the anchor' }[mode];
    console.log(`    ${mode.padEnd(9)} ${String(p.n).padStart(2)} runs   mean alpha ${f(p.mean).padStart(7)}  sd ${fp(p.sd, 1).padStart(5)}  range ${f(p.min)} … ${f(p.max)}   (${note})`);
    console.log(`              → real minus placebo ${f(full.alpha - p.mean)}   = ${fp((full.alpha - p.mean) / p.sd, 2)} placebo sd`);
    if (mode === 'intraday') { pm = p.mean; psd = p.sd; }
  }
  console.log("    The 'intraday' row is the one that matters: it asks whether the OPEN is special,");
  console.log('    or whether any fixed price from earlier in the same session would do as well.');

  // block bootstrap — the honest error bar given overlapping trades
  const bb = dayBlockBootstrap(set, ti, si, hi, flip);
  if (bb) {
    console.log(`\n  DAY-BLOCK BOOTSTRAP (${bb.days} trading days resampled, 2000 iterations)`);
    console.log(`    alpha ${f(bb.point)}   95% interval ${f(bb.lo)} … ${f(bb.hi)}   one-sided p = ${bb.pOneSided.toFixed(3)}`);
    console.log('    This is the error bar to trust. The naive standard error below assumes the');
    console.log('    trades are independent, and with 20 overlapping trades a day they are not.');
  }

  // month by month
  console.log('\n  month by month:');
  const byMonth = new Map();
  for (const e of set) { const k = new Date(bars[e.i].t).toISOString().slice(0, 7); if (!byMonth.has(k)) byMonth.set(k, []); byMonth.get(k).push(e); }
  let pos = 0, tot = 0;
  for (const k of [...byMonth.keys()].sort()) {
    const s = scoreAt(byMonth.get(k), ti, si, hi, flip);
    if (s.n >= 10) { tot++; if (s.alpha > 0) pos++; }
    console.log(`    ${k}   n=${String(s.n).padStart(4)}   raw ${f(s.raw).padStart(7)}   alpha ${f(s.alpha).padStart(7)}   win ${fp(s.win).padStart(5)}%`);
  }
  console.log(`    → positive in ${pos} of ${tot} months`);

  // anchor jitter
  console.log('\n  anchor jitter — is the session special, or is any hour of the day as good?');
  for (const d of [-120, -60, -30, 0, 30, 60, 120]) {
    const ms = win.anchors.map(m => ((m + d) % 1440 + 1440) % 1440);
    const e2 = pooled(ms, tf);
    const s2 = kind ? e2.filter(e => e.kind === kind) : e2;
    const sc = scoreAt(s2, ti, si, hi, flip);
    console.log(`    ${(d >= 0 ? '+' : '') + String(d).padStart(4)} min   n=${String(sc.n).padStart(4)}   alpha ${f(sc.alpha).padStart(7)}`);
  }

  // target/stop neighbourhood
  console.log('\n  target/stop neighbourhood (alpha; the chosen cell is bracketed):');
  const th = [Math.max(0, ti - 2), Math.min(NT - 1, ti + 2)], sh = [Math.max(0, si - 2), Math.min(NS - 1, si + 2)];
  let head = '      SL→ ';
  for (let s2 = sh[0]; s2 <= sh[1]; s2++) head += String(SL_GRID[s2]).padStart(9);
  console.log(head);
  for (let t2 = th[0]; t2 <= th[1]; t2++) {
    let row = `    TP ${String(TP_GRID[t2]).padStart(3)} `;
    for (let s2 = sh[0]; s2 <= sh[1]; s2++) {
      const sc = scoreAt(set, t2, s2, hi, flip);
      const cell = f(sc.alpha);
      row += ((t2 === ti && s2 === si) ? `[${cell}]` : cell).padStart(9);
    }
    console.log(row);
  }

  // hold sensitivity
  console.log('\n  hold sensitivity:');
  for (let h2 = 0; h2 < NH; h2++) {
    const sc = scoreAt(set, ti, si, h2, flip);
    console.log(`    hold ${String(HOLD_GRID[h2]).padStart(4)}   n=${String(sc.n).padStart(4)}   alpha ${f(sc.alpha).padStart(7)}   win ${fp(sc.win).padStart(5)}%`);
  }

  // level lifetime
  console.log('\n  how long should the level stay on the chart?');
  for (const life of [120, 240, 480, 720, 1440]) {
    const e2 = pooled(win.anchors, tf, { lifeMin: life });
    const s2 = kind ? e2.filter(e => e.kind === kind) : e2;
    const sc = scoreAt(s2, ti, si, hi, flip);
    console.log(`    life ${String(life).padStart(4)} min   n=${String(sc.n).padStart(4)}   respect ${fp(respectRate(s2).respect).padStart(5)}%   alpha ${f(sc.alpha).padStart(7)}`);
  }

  // per-anchor breakdown, so a pooled result is not one anchor carrying four
  if (win.anchors.length > 1) {
    console.log('\n  contribution of each anchor in the pool:');
    for (const m of win.anchors) {
      const e2 = eventsFor(m, tf);
      const s2 = kind ? e2.filter(e => e.kind === kind) : e2;
      const sc = scoreAt(s2, ti, si, hi, flip);
      console.log(`    ${hhmm(m)} ${(NAMED[m] || '').padEnd(22)} n=${String(sc.n).padStart(4)}   alpha ${f(sc.alpha).padStart(7)}`);
    }
  }

  // significance on the raw series
  const vals = [];
  for (const e of set) { const v = pnl(e._w[flip ? 1 : 0], ti, si, hi); if (v !== null) vals.push(v); }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1));
  const se = sd / Math.sqrt(vals.length);
  console.log(`\n  raw mean ${f(mean)} pts, sd ${fp(sd)}, standard error ${fp(se, 2)}  →  t = ${fp(mean / se, 2)} on the raw series`);
  console.log(`  95% interval on the raw mean: ${f(mean - 1.96 * se)} … ${f(mean + 1.96 * se)} pts`);

  // lookahead audit
  console.log('\n  LOOKAHEAD AUDIT');
  const m0 = win.anchors[0];
  const { line, anchors } = sessionOpenLine(bars, m0, {});
  let live = 0;
  for (const k of anchors) if (Number.isFinite(line[k])) live++;
  console.log(`    the level is still NaN on its own anchor bar for ${anchors.length - live} of ${anchors.length} anchors (want all: published one bar late)`);
  const okSet = new Set(anchors.map(k => bars[k].o));
  let viol = 0, checked = 0;
  for (let i = 0; i < N; i++) { if (!Number.isFinite(line[i])) continue; checked++; if (!okSet.has(line[i])) viol++; }
  console.log(`    ${checked.toLocaleString()} live bars, ${viol} carry a value that is not some anchor bar's open`);
  let late = 0;
  for (let i = 0; i < N; i++) {
    if (!Number.isFinite(line[i])) continue;
    let src = -1;
    for (let a = anchors.length - 1; a >= 0; a--) if (anchors[a] < i && bars[anchors[a]].o === line[i]) { src = anchors[a]; break; }
    if (src < 0) late++;
  }
  console.log(`    ${late} live bars carry a value whose source anchor is not strictly in the past`);
  const cut2 = Math.floor(N * 0.6);
  const trunc = sessionOpenLine(bars.slice(0, cut2), m0, {}).line;
  let mism = 0;
  for (let i = 0; i < cut2; i++) {
    const a = line[i], b = trunc[i];
    if (Number.isFinite(a) !== Number.isFinite(b) || (Number.isFinite(a) && a !== b)) mism++;
  }
  console.log(`    rebuilding on only the first ${cut2.toLocaleString()} bars reproduces ${(cut2 - mism).toLocaleString()} of ${cut2.toLocaleString()} values exactly (${mism} differ)`);
  console.log('    → the level is a frozen past open, published one bar late. It cannot see forward.');
  return { full, placeboMean: pm, placeboSd: psd, t: mean / se };
}

// ---- stage 7: is it a finding or one lucky cell? ---------------------------
/**
 * A configuration that survived a split can still be one cell out of a hundred
 * thousand. Two checks separate a finding from a fluke, and neither costs a new
 * degree of freedom:
 *
 *   FAMILY   freeze the whole configuration and run it across all 28 anchors.
 *            A real effect shows up as a distribution shifted off zero. A fitted
 *            one shows up as 27 anchors at zero and one spike.
 *   ENGINE   strip the target and stop out entirely and exit purely on time. If
 *            the alpha survives, the money is coming from an 8-hour directional
 *            bet that the event merely timed, and the "level" is doing nothing
 *            that a coin flip at the same moment would not do.
 */
function timeExitAlpha(set, flip, holdMin) {
  let ln = 0, lnet = 0, sn = 0, snet = 0;
  const bl = [], bs = [];
  for (const ev of set) {
    const dir = flip ? -ev.dir : ev.dir;
    const i = ev.i, e = bars[i].c;
    const j = Math.min(N - 1, i + holdMin);
    const v = (bars[j].c - e) * dir / PU - COST;
    if (dir === 1) { ln++; lnet += v; } else { sn++; snet += v; }
  }
  // blind baseline for a pure time exit, same sampling as everywhere else
  for (const [dir, seed, acc] of [[1, 31337, bl], [-1, 73331, bs]]) {
    const idx = blindIndices(NB, seed);
    let s = 0, c = 0;
    for (let k = 0; k < NB; k++) {
      const i = idx[k], j = Math.min(N - 1, i + holdMin);
      s += (bars[j].c - bars[i].c) * dir / PU - COST; c++;
    }
    acc.push(s / c);
  }
  const tot = ln + sn;
  const la = ln ? lnet / ln - bl[0] : 0, sa = sn ? snet / sn - bs[0] : 0;
  return { n: tot, raw: (lnet + snet) / tot, alpha: (la * ln + sa * sn) / tot };
}

function stage7(cfgs) {
  console.log(hr('7.  IS IT A FINDING OR ONE LUCKY CELL?'));
  for (const c of cfgs) {
    const ti = TP_GRID.indexOf(c.tp), si = SL_GRID.indexOf(c.sl), hi = HOLD_GRID.indexOf(c.hold);
    console.log(`\n  ── ${c.name}:  ${TF_NAME[c.tf]} ATR, ${c.kind}${c.flip ? ' inverted' : ''}, TP ${c.tp} / SL ${c.sl} / hold ${c.hold}`);

    console.log('     FAMILY — the identical configuration at every anchor of the day:');
    const fam = [];
    for (const m of ANCHORS) {
      const ev = eventsFor(m, c.tf);
      const set = c.kind === 'all' ? ev : ev.filter(e => e.kind === c.kind);
      const s = scoreAt(set, ti, si, hi, c.flip);
      if (s.n >= 60) fam.push({ m, ...s });
    }
    fam.sort((a, b) => b.alpha - a.alpha);
    const av = fam.map(x => x.alpha);
    const am = av.reduce((a, b) => a + b, 0) / av.length;
    const asd = Math.sqrt(av.reduce((a, v) => a + (v - am) ** 2, 0) / (av.length - 1));
    console.log('       ' + fam.map(x => `${hhmm(x.m)} ${f(x.alpha, 0)}`).join('  '));
    const target = fam.find(x => x.m === c.anchor);
    console.log(`       ${fam.length} anchors: mean ${f(am)}  sd ${fp(asd)}  positive at ${av.filter(x => x > 0).length}/${av.length}`);
    if (target) console.log(`       the chosen anchor ${hhmm(c.anchor)} scores ${f(target.alpha)} = ${fp((target.alpha - am) / asd, 2)} sd above the family mean`);
    console.log(`       → ${am > 0 && av.filter(x => x > 0).length > av.length * 0.6 ? 'the whole family leans positive: the effect is not one cell' : 'the family sits at zero: this is one cell, not an effect'}`);

    console.log('     ENGINE — the same events with NO target and NO stop, exit purely on time:');
    const ev = eventsFor(c.anchor, c.tf);
    const set = c.kind === 'all' ? ev : ev.filter(e => e.kind === c.kind);
    for (const h of HOLD_GRID) {
      const t = timeExitAlpha(set, c.flip, h);
      console.log(`       hold ${String(h).padStart(4)} min   n=${String(t.n).padStart(4)}   raw ${f(t.raw).padStart(8)}   alpha ${f(t.alpha).padStart(8)}`);
    }
    const withStops = scoreAt(set, ti, si, hi, c.flip);
    const noStops = timeExitAlpha(set, c.flip, c.hold);
    console.log(`       with ${c.tp}/${c.sl}: ${f(withStops.alpha)}   without any target or stop: ${f(noStops.alpha)}`);
    console.log(`       → ${Math.abs(noStops.alpha - withStops.alpha) < Math.abs(withStops.alpha) * 0.35 ? 'the target and stop are decoration; this is a timed directional bet' : 'the target and stop are doing real work'}`);
  }
}

// ---- stage 8: the open as a DIRECTIONAL STATE, not a bounce level ----------
/**
 * Everything above treats the open as a wall and asks whether price bounces off
 * it. Stage 2 says it is not a wall: against a matched placebo it has no respect
 * edge worth the name. So take the other reading, the one the brief points at —
 * price relative to the open is a STATEMENT ABOUT DIRECTION.
 *
 * The construction has almost no freedom in it, which is the point after a
 * hundred thousand-cell grid search:
 *
 *   at `wait` minutes after the session open, compare price to the open
 *   above the open → long, below → short (or the inverse)
 *   exit after `hold` minutes, or on the target or stop
 *   one trade per session per day, no overlap inside an anchor
 *
 * The controls are the same trade with the reference price replaced: a real
 * traded price from earlier in the session, and the price `wait` minutes before
 * entry. If "above the open" beats "above an arbitrary earlier price", the open
 * is carrying the information. If it does not, it is not the open, it is
 * momentum.
 */
function stateEvents(anchorMin, wait, opts = {}) {
  const ref = opts.ref ?? 'open';       // 'open' | 'earlier' | 'lagged'
  const seed = opts.seed ?? 1;
  const r = rng(seed);
  const { anchors } = sessionOpenLine(bars, anchorMin, {});
  const out = [];
  for (let a = 0; a < anchors.length; a++) {
    const k = anchors[a];
    const stop = a + 1 < anchors.length ? anchors[a + 1] : N;
    const j = k + wait;
    if (j >= stop || j >= N - 5) continue;
    let refPx;
    if (ref === 'open') refPx = bars[k].o;
    else if (ref === 'lagged') refPx = bars[Math.max(k, j - wait / 2 | 0)].c;
    else { const off = Math.floor(r() * Math.max(1, wait)); refPx = bars[k + off].c; }
    const d = bars[j].c - refPx;
    if (d === 0) continue;
    out.push({ i: j, dir: d > 0 ? 1 : -1, kind: 'state', level: refPx });
  }
  return attach(out);
}

function stage8() {
  console.log(hr('8.  THE OPEN AS A DIRECTIONAL STATE, NOT A BOUNCE LEVEL'));
  console.log('  One trade per session per day: at `wait` minutes past the open, go with the side');
  console.log('  of the open price is on. Direction-adjusted, and shown against two controls that');
  console.log('  replace the open with another reference price and change nothing else.\n');

  const WAITS = [15, 30, 60, 120, 240];
  const sets = [[60, 'Globex 01:00'], [600, 'London 10:00'], [930, 'US data 15:30'], [990, 'NYSE 16:30']];

  console.log('  A. pure time exit, no target or stop — is there any directional information at all?');
  console.log('     anchor        wait   n    ' + HOLD_GRID.map(h => ('h' + h).padStart(9)).join(''));
  console.log('     ' + '─'.repeat(24 + 9 * NH));
  for (const [m, nm] of sets) {
    for (const wait of WAITS) {
      const ev = stateEvents(m, wait);
      if (ev.length < 60) continue;
      const cells = HOLD_GRID.map(h => f(timeExitAlpha(ev, false, h).alpha, 1).padStart(9)).join('');
      console.log(`     ${nm.padEnd(14)}${String(wait).padStart(4)}  ${String(ev.length).padStart(4)} ${cells}`);
    }
  }

  console.log('\n  B. the same thing pooled over all 28 anchors, so no single session is cherry-picked:');
  console.log('     wait   n     ' + HOLD_GRID.map(h => ('h' + h).padStart(9)).join(''));
  console.log('     ' + '─'.repeat(14 + 9 * NH));
  const pooledByWait = new Map();
  for (const wait of WAITS) {
    const ev = [];
    for (const m of ANCHORS) ev.push(...stateEvents(m, wait));
    pooledByWait.set(wait, ev);
    console.log(`     ${String(wait).padStart(4)}  ${String(ev.length).padStart(5)} ${HOLD_GRID.map(h => f(timeExitAlpha(ev, false, h).alpha, 1).padStart(9)).join('')}`);
  }

  console.log('\n  C. controls — the identical trade with the open swapped for another reference:');
  console.log('     reference                       wait  n     ' + HOLD_GRID.map(h => ('h' + h).padStart(9)).join(''));
  console.log('     ' + '─'.repeat(45 + 9 * NH));
  for (const wait of [30, 60, 120]) {
    for (const [ref, label] of [['open', 'the session open'], ['lagged', 'the price halfway through the wait'], ['earlier', 'a random traded price in the wait window']]) {
      const ev = [];
      for (let s = 0; s < (ref === 'earlier' ? 4 : 1); s++)
        for (const m of ANCHORS) ev.push(...stateEvents(m, wait, { ref, seed: 7717 + s * 331 + m }));
      console.log(`     ${label.padEnd(40)}${String(wait).padStart(4)} ${String(ev.length).padStart(5)} ${HOLD_GRID.map(h => f(timeExitAlpha(ev, false, h).alpha, 1).padStart(9)).join('')}`);
    }
  }

  console.log('\n  D. with a target and stop, and an honest error bar, at the best pooled wait/hold:');
  let best = null;
  for (const wait of WAITS) {
    for (let hi = 0; hi < NH; hi++) {
      const a = timeExitAlpha(pooledByWait.get(wait), false, HOLD_GRID[hi]).alpha;
      if (!best || a > best.a) best = { wait, hi, a };
    }
  }
  const ev = pooledByWait.get(best.wait);
  console.log(`     best pooled cell: wait ${best.wait} min, hold ${HOLD_GRID[best.hi]} min, time-exit alpha ${f(best.a)}`);
  const b = bestConfig(ev, false, 200);
  const s = scoreAt(ev, b.ti, b.si, b.hi, false);
  console.log(`     with a swept target/stop: TP ${TP_GRID[b.ti]} / SL ${SL_GRID[b.si]} / hold ${HOLD_GRID[b.hi]}   n=${s.n}  win ${fp(s.win)}%  alpha ${f(s.alpha)}`);
  const bb = dayBlockBootstrap(ev, b.ti, b.si, b.hi, false);
  if (bb) console.log(`     day-block bootstrap over ${bb.days} days: 95% interval ${f(bb.lo)} … ${f(bb.hi)}   one-sided p = ${bb.pOneSided.toFixed(3)}`);
  const isSet = ev.filter(e => e.i < SPLIT_I), oo = ev.filter(e => e.i >= SPLIT_I);
  const bIS = bestConfig(isSet, false, 100, 0);
  if (bIS) {
    const oS = scoreAt(oo, bIS.ti, bIS.si, bIS.hi, false, 1);
    console.log(`     chosen on Jan–Apr (TP ${TP_GRID[bIS.ti]}/SL ${SL_GRID[bIS.si]}/hold ${HOLD_GRID[bIS.hi]}, IS alpha ${f(bIS.s.alpha)}) → May–Jul alpha ${f(oS.alpha)} on ${oS.n} trades`);
  }
  return { pooledByWait, best };
}

// ---- stage 9: the final, low-freedom head-to-head --------------------------
/**
 * After stages 7 and 8 the grid search is discredited: its winners are single
 * cells that the family test rejects. So this is the opposite approach — no
 * search at all. The target and the stop are DICTATED by the measured excursion
 * (stage 3): at each hold, target = stop = the median favourable travel at that
 * hold, rounded to the grid. Nothing is chosen to make the number look good.
 *
 * Each row is scored against the matched intraday placebo, and the honest error
 * bar is a day-block bootstrap. NET is the only column that means anything.
 */
function nearest(grid, v) { let b = grid[0]; for (const g of grid) if (Math.abs(g - v) < Math.abs(b - v)) b = g; return b; }

function stage9() {
  console.log(hr('9.  FINAL HEAD-TO-HEAD — target and stop DICTATED by the excursion, not searched'));
  console.log('  For every row: target = stop = median favourable travel at that hold (stage 3),');
  console.log('  rounded to the grid. No sweep, no choice. Real vs the matched intraday placebo.');
  console.log('  NET = real − placebo is the part attributable to the open.\n');
  const rows = [];
  console.log('  pool          atrTF reading  hold  TP=SL   n     alpha    placebo     NET    boot 95%          p');
  console.log('  ' + '─'.repeat(100));
  for (const [pool, anchors, plabel] of [[SESSION_SET, SESSION_SET, 'session (5)'], [ANCHORS, ANCHORS, 'all (28)']]) {
    for (const tf of [5, 15, 60]) {
      const ev = pooled(pool, tf);
      for (const [kind, flip, rlabel] of [['reject', false, 'bounce'], ['reject', true, 'fade  '], ['break', false, 'break '], ['break', true, 'antibrk']]) {
        const set = ev.filter(e => e.kind === kind);
        if (set.length < 100) continue;
        for (const hold of [30, 60, 120, 240]) {
          const hi = HOLD_GRID.indexOf(hold);
          const med = median(set.map(e => e._w[flip ? 1 : 0].mfeH[hi]));
          const v = nearest(TP_GRID, med);
          const ti = TP_GRID.indexOf(v), si = SL_GRID.indexOf(v);
          const s = scoreAt(set, ti, si, hi, flip);
          if (s.n < 100) continue;
          const p = placeboAlpha(anchors, tf, kind, flip, ti, si, hi, 8, undefined, 'intraday');
          const bb = dayBlockBootstrap(set, ti, si, hi, flip);
          const net = s.alpha - p.mean;
          rows.push({ pool: plabel, tf, kind, flip, rlabel, hold, v, s, p, bb, net, ti, si, hi, anchors });
          console.log(`  ${plabel.padEnd(13)} ${TF_NAME[tf].padStart(4)}  ${rlabel.padEnd(8)}${String(hold).padStart(4)} ${String(v).padStart(6)} ${String(s.n).padStart(5)} ${f(s.alpha).padStart(8)} ${f(p.mean).padStart(9)} ${f(net).padStart(8)}   ${bb ? (f(bb.lo, 1) + '…' + f(bb.hi, 1)).padStart(16) : '—'.padStart(16)} ${bb ? bb.pOneSided.toFixed(3) : '—'}`);
        }
      }
    }
  }
  rows.sort((a, b) => b.net - a.net);
  console.log('\n  Ranked by NET (what the open contributes over an arbitrary earlier price):');
  for (const r of rows.slice(0, 6)) {
    console.log(`    ${r.pool} ${TF_NAME[r.tf]} ${r.rlabel} hold ${r.hold} TP=SL ${r.v}: alpha ${f(r.s.alpha)}, placebo ${f(r.p.mean)}±${fp(r.p.sd, 1)}, NET ${f(r.net)}  (${fp(r.p.sd ? r.net / r.p.sd : NaN, 2)} placebo sd)`);
  }

  // family test on the best NET row: the check that killed the grid winner
  const top = rows[0];
  if (top) {
    console.log(`\n  FAMILY TEST on the best NET row (${top.pool}, ${TF_NAME[top.tf]}, ${top.rlabel}, hold ${top.hold}, TP=SL ${top.v}):`);
    const fam = [];
    for (const m of ANCHORS) {
      const e2 = eventsFor(m, top.tf).filter(e => e.kind === top.kind);
      const s2 = scoreAt(e2, top.ti, top.si, top.hi, top.flip);
      if (s2.n >= 60) fam.push({ m, a: s2.alpha });
    }
    const av = fam.map(x => x.a), am = av.reduce((a, b) => a + b, 0) / av.length;
    const asd = Math.sqrt(av.reduce((a, v) => a + (v - am) ** 2, 0) / (av.length - 1));
    console.log('    ' + fam.sort((a, b) => b.a - a.a).map(x => `${hhmm(x.m)} ${f(x.a, 0)}`).join('  '));
    console.log(`    ${fam.length} anchors: mean ${f(am)}  sd ${fp(asd)}  positive at ${av.filter(x => x > 0).length}/${av.length}`);
    // IS / OOS on the same fixed cell (no re-search)
    const ev = pooled(top.pool === 'all (28)' ? ANCHORS : SESSION_SET, top.tf).filter(e => e.kind === top.kind);
    const a1 = scoreAt(ev.filter(e => e.i < SPLIT_I), top.ti, top.si, top.hi, top.flip, 0);
    const a2 = scoreAt(ev.filter(e => e.i >= SPLIT_I), top.ti, top.si, top.hi, top.flip, 1);
    console.log(`    the SAME fixed cell, no re-search:  Jan–Apr alpha ${f(a1.alpha)} (n=${a1.n})   May–Jul alpha ${f(a2.alpha)} (n=${a2.n})`);
  }
  return rows;
}

module.exports = {
  bars, atr1, N, ATR_TF, TFS, TF_NAME, sessionOpenLine, walk, pnl, scoreAt, attach,
  stage7, stage8, stage9, stateEvents, timeExitAlpha, dayBlockBootstrap, placeboAlpha, excursion,
  TP_GRID, SL_GRID, HOLD_GRID, buildBaselines, BLIND, BLIND_SEG, bIdx, EV, ANCHORS,
  SESSION_SET, NAMED, hhmm, median, quant, f, fp, respectRate, levelTestEvents,
  RANDOM_RESPECT, bestConfig, eventsFor, pooled, placeboEvents, placeboLine,
  READINGS, blindIndices, rng, get SPLIT_I() { return SPLIT_I; },
  stage0, stage1, stage2, stage3, stage4, stage5, stage6,
};

if (require.main === module) {
  const t0 = Date.now();
  process.stdout.write('  building blind baselines over the whole target/stop/hold grid …\r');
  buildBaselines();
  console.log(`  blind baselines: ${NT}×${NS}×${NH} = ${NT * NS * NH} configs × ${NB.toLocaleString()} samples × 2 directions × 3 windows  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  if (on(0)) stage0();
  if (on(1)) stage1();
  if (on(2)) stage2();

  // Candidate sets. Individual named sessions, plus two pools. Pools exist
  // because the honest scale (1H ATR) leaves only ~100 events per anchor and
  // the brief demands at least 100 before believing anything.
  const picks = [];
  for (const tf of [5, 15, 60]) {
    picks.push({ label: 'Globex 01:00 [CURRENT]', anchors: [60], tf, ev: eventsFor(60, tf) });
    picks.push({ label: 'London 10:00', anchors: [600], tf, ev: eventsFor(600, tf) });
    picks.push({ label: 'US data 15:30', anchors: [930], tf, ev: eventsFor(930, tf) });
    picks.push({ label: 'NYSE 16:30', anchors: [990], tf, ev: eventsFor(990, tf) });
    picks.push({ label: 'session pool (5)', anchors: SESSION_SET, tf, ev: pooled(SESSION_SET, tf) });
    picks.push({ label: 'all anchors pool', anchors: ANCHORS, tf, ev: pooled(ANCHORS, tf) });
  }

  if (on(3)) stage3([
    { ...picks.find(p => p.tf === 15 && p.label.startsWith('session')), kind: 'reject' },
    { ...picks.find(p => p.tf === 15 && p.label.startsWith('session')), kind: 'break' },
    { ...picks.find(p => p.tf === 5 && p.label.startsWith('all anchors')), kind: 'reject' },
    { ...picks.find(p => p.tf === 60 && p.label.startsWith('all anchors')), kind: 'reject' },
  ]);
  let all = [];
  if (on(4)) all = stage4(picks, 100, true);
  let split = [];
  if (on(5)) split = stage5(all, 100, 60);
  if (on(6)) {
    const w = split.filter(x => x.oos.n >= 60).sort((a, b) => b.oos.alpha - a.oos.alpha)[0];
    if (w) stage6(w);
  }
  if (on(8)) stage8();
  if (on(9)) stage9();
  if (on(7)) stage7([
    { name: 'the split survivor', anchor: 60, tf: 15, kind: 'reject', flip: true, tp: 320, sl: 320, hold: 480 },
    { name: 'the split survivor at 5m', anchor: 60, tf: 5, kind: 'reject', flip: true, tp: 320, sl: 320, hold: 480 },
    { name: 'London short-hold bounce', anchor: 600, tf: 15, kind: 'reject', flip: false, tp: 320, sl: 240, hold: 30 },
  ]);
  console.log(`\n  total ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
