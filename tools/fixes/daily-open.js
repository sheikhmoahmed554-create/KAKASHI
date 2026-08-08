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
  let ti = 0, si = 0, hi = 0, mfe = 0, mae = 0;
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    const fav = dir === 1 ? (b.h - e) / PU : (e - b.l) / PU;
    const adv = dir === 1 ? (e - b.l) / PU : (b.h - e) / PU;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
    while (ti < NT && mfe >= TP_GRID[ti]) ftp[ti++] = j - i;
    while (si < NS && mae >= SL_GRID[si]) fsl[si++] = j - i;
    while (hi < NH && j - i >= HOLD_GRID[hi]) { closeP[hi] = (b.c - e) * dir / PU - COST; hi++; }
  }
  while (hi < NH) { closeP[hi] = (bars[end].c - e) * dir / PU - COST; hi++; }
  return { ftp, fsl, closeP, mfe, mae };
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
function placeboLine(anchorMin, tf, seed, opts = {}) {
  const lag = opts.lag ?? 1;
  const lifeMin = opts.lifeMin ?? 1440;
  const r = rng(seed);
  const { anchors } = sessionOpenLine(bars, anchorMin, opts);
  const A = ATR_TF.get(tf);
  const out = new Array(N).fill(NaN);
  for (let a = 0; a < anchors.length; a++) {
    const k = anchors[a];
    const at = Number.isFinite(A[k]) ? A[k] : atr1[k];
    if (!Number.isFinite(at) || at <= 0) continue;
    let u = (r() * 2 - 1) * 3;                  // ±3 ATR of the true open
    if (Math.abs(u) < 0.6) u += u >= 0 ? 0.6 : -0.6;   // never accidentally be the open
    const px = bars[k].o + u * at;
    const stop = a + 1 < anchors.length ? anchors[a + 1] : N;
    const tCut = bars[k].t + lifeMin * 60000;
    for (let i = k + lag; i < stop; i++) { if (bars[i].t > tCut) break; out[i] = px; }
  }
  return out;
}
function placeboEvents(anchorMin, tf, seed, opts) {
  return attach(levelTestEvents(bars, placeboLine(anchorMin, tf, seed, opts), ATR_TF.get(tf)));
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

// ---- stage 3: excursion ----------------------------------------------------
function stage3(picks) {
  console.log(hr('3.  EXCURSION — how far does price really travel after a test of the open?'));
  console.log('  Points from the entry close over the whole 1440-bar horizon. "sig" is the');
  console.log('  direction the event signals, "inv" the opposite. A target must fit inside medMFE');
  console.log('  and a stop must sit outside medMAE or the trade is not measuring the level.\n');
  console.log('  set                       atrTF kind      n     sig:medMFE medMAE  p25MFE    inv:medMFE medMAE');
  console.log('  ' + '─'.repeat(97));
  for (const p of picks) {
    for (const kind of ['reject', 'break']) {
      const sub = p.ev.filter(e => e.kind === kind);
      if (sub.length < 40) continue;
      console.log(`  ${p.label.padEnd(25)} ${TF_NAME[p.tf].padStart(4)} ${kind.padEnd(7)} ${String(sub.length).padStart(4)}     ${fp(median(sub.map(e => e._w[0].mfe))).padStart(7)} ${fp(median(sub.map(e => e._w[0].mae))).padStart(6)} ${fp(quant(sub.map(e => e._w[0].mfe), .25)).padStart(7)}      ${fp(median(sub.map(e => e._w[1].mfe))).padStart(7)} ${fp(median(sub.map(e => e._w[1].mae))).padStart(6)}`);
    }
  }
  console.log('\n  Compare with the 90/90 everything was forced onto. Median daily range here is');
  console.log('  1095 pts, so 90/90 is not "too wide" — it is simply unrelated to what a test of');
  console.log('  the open produces, which is what makes sizing the single biggest lever.');
}

// ---- stage 4: size the trade -----------------------------------------------
function stage4(picks, minN) {
  console.log(hr('4.  TARGET AND STOP SIZED TO THE LEVEL   blind baseline recomputed at every cell'));
  console.log(`  Best (target / stop / hold) per reading, full sample, minimum ${minN} events.`);
  console.log(`  Grid searched: ${NT} targets × ${NS} stops × ${NH} holds = ${NT * NS * NH} cells per reading.\n`);
  const all = [];
  for (const p of picks) {
    console.log(`  ── ${p.label}   ${TF_NAME[p.tf]} ATR   (${p.ev.length} events)`);
    for (const [name, kind, flip] of READINGS) {
      const set = kind ? p.ev.filter(e => e.kind === kind) : p.ev;
      const b = bestConfig(set, flip, minN);
      if (!b) continue;
      console.log(`     ${name.padEnd(32)} n=${String(b.s.n).padStart(4)}  TP ${String(TP_GRID[b.ti]).padStart(3)} / SL ${String(SL_GRID[b.si]).padStart(3)} / hold ${String(HOLD_GRID[b.hi]).padStart(4)}   raw ${f(b.s.raw).padStart(7)}  win ${fp(b.s.win).padStart(5)}%  ALPHA ${f(b.s.alpha).padStart(7)}`);
      all.push({ ...p, name, kind, flip, ...b });
    }
  }
  all.sort((a, b) => b.s.alpha - a.s.alpha);
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

  // THE PLACEBO — the number that decides whether any of this is the level.
  console.log('\n  PLACEBO: the identical pipeline on invented levels in the same neighbourhood');
  const pa = [];
  for (let s = 0; s < 12; s++) {
    const pev = [];
    for (const m of win.anchors) pev.push(...placeboEvents(m, tf, 55001 + s * 9173 + m));
    const pset = kind ? pev.filter(e => e.kind === kind) : pev;
    const ps = scoreAt(pset, ti, si, hi, flip);
    if (ps.n >= 50) pa.push(ps.alpha);
  }
  const pm = pa.reduce((a, b) => a + b, 0) / pa.length;
  const psd = Math.sqrt(pa.reduce((a, v) => a + (v - pm) ** 2, 0) / (pa.length - 1));
  console.log(`    ${pa.length} placebo runs   mean alpha ${f(pm)}   sd ${fp(psd, 2)}   range ${f(Math.min(...pa))} … ${f(Math.max(...pa))}`);
  console.log(`    the real level sits ${f((full.alpha - pm) / psd, 2)} placebo standard deviations away from the placebo mean.`);

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

module.exports = {
  bars, atr1, N, ATR_TF, TFS, TF_NAME, sessionOpenLine, walk, pnl, scoreAt, attach,
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

  if (on(3)) stage3(picks.filter(p => p.tf === 15 || p.label.startsWith('session')));
  let all = [];
  if (on(4)) all = stage4(picks, 100);
  let split = [];
  if (on(5)) split = stage5(all, 100, 60);
  if (on(6)) {
    const w = split.filter(x => x.oos.n >= 60).sort((a, b) => b.oos.alpha - a.oos.alpha)[0];
    if (w) stage6(w);
  }
  console.log(`\n  total ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
