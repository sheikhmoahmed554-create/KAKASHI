'use strict';
/*
 * Independent audit of the "Absorption" claim in tools/fixes/absorption.js.
 *
 * Everything here is written from scratch against the stated spec so a bug in
 * the original would not be inherited. Where a cross-check is useful the
 * original module is required (with argv neutered so its own main does not run)
 * and the event streams compared.
 *
 * The metric of record here is NOT the global blind baseline. With a symmetric
 * target and stop, pnl(i,+1) + pnl(i,-1) = -2*COST exactly, so the expectation
 * of a coin flip AT THE SAME MOMENT is exactly -COST. That makes
 *
 *     timeAlpha = mean(pnl) + COST
 *
 * a direction-, time- AND volatility-matched adjustment, strictly stronger than
 * subtracting a globally sampled blind long/short. Both are reported.
 *
 * Usage: node --max-old-space-size=3500 tools/fixes/absorption-verify.js <mode>
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('../ai963_engine');

const PU = 0.10, COST = 0.5;

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

function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// ── trade: symmetric barrier race, returns pnl AND the exit bar ──────────────
function trade(i, dir, TP, SL, MAXH) {
  const e = bars[i].c;
  const tp = e + dir * TP * PU, sl = e - dir * SL * PU;
  const end = Math.min(N - 1, i + MAXH);
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    const ht = dir === 1 ? b.h >= tp : b.l <= tp;
    const hs = dir === 1 ? b.l <= sl : b.h >= sl;
    if (ht && hs) return null;                  // ambiguous, discarded
    if (ht) return { p: TP - COST, exit: j };
    if (hs) return { p: -SL - COST, exit: j };
  }
  return { p: (bars[end].c - e) * dir / PU - COST, exit: end };
}

const BLIND = new Map();
function blind(dir, TP, SL, MAXH, n = 40000, seed) {
  const key = `${dir}|${TP}|${SL}|${MAXH}|${n}`;
  if (BLIND.has(key)) return BLIND.get(key);
  const r = rng(seed ?? (dir === 1 ? 31337 : 73331));
  const lo = 100, hi = N - MAXH - 2;
  let s = 0, c = 0;
  for (let k = 0; k < n; k++) {
    const t = trade(lo + Math.floor(r() * (hi - lo)), dir, TP, SL, MAXH);
    if (t) { s += t.p; c++; }
  }
  const v = s / c;
  BLIND.set(key, v);
  return v;
}

// ── level construction, written from the spec ────────────────────────────────
const RANK_CACHE = new Map();
function rank(fn, name, look) {
  const key = `${name}|${look}`;
  if (RANK_CACHE.has(key)) return RANK_CACHE.get(key);
  const s = new Float64Array(N);
  for (let j = 0; j < N; j++) s[j] = fn(bars[j]);
  const p = new Float64Array(N).fill(NaN);
  for (let j = look; j < N; j++) {
    let c = 0;
    for (let k = j - look; k < j; k++) if (s[k] < s[j]) c++;   // strictly previous `look` bars
    p[j] = c / look;
  }
  RANK_CACHE.set(key, p);
  return p;
}
const rVol = look => rank(b => (Number.isFinite(b.v) ? b.v : 0), 'vol', look);
const rProg = look => rank(b => Math.abs(b.c - b.o), 'prog', look);

/** dir0/price rule from the claim: the extreme facing the close. */
function extremeOf(b) {
  const mid = (b.h + b.l) / 2;
  const up = b.c >= mid;
  return { price: up ? b.l : b.h, dir0: up ? 1 : -1 };
}

function absorptionLevels(opt = {}) {
  const look = opt.look ?? 250;
  const volMin = opt.volMin ?? 0.90;
  const progMax = opt.progMax ?? 0.30;
  const ageMin = opt.ageMin ?? 1440;
  const lag = opt.lag ?? 0;               // extra bars of publication delay; -1 = deliberate lookahead
  const pv = volMin > 0 ? rVol(look) : null;
  const pp = progMax < 1 ? rProg(look) : null;
  const out = [];
  for (let j = look; j < N - 1; j++) {
    const b = bars[j];
    if (!(b.h - b.l > 0)) continue;
    if (pv && !(pv[j] >= volMin)) continue;
    if (pp && !(pp[j] <= progMax)) continue;
    const { price, dir0 } = extremeOf(b);
    const visibleAt = j + 1 + lag;
    if (visibleAt < 1 || visibleAt >= N) continue;
    out.push({ price, dir0, visibleAt, expire: visibleAt + ageMin, src: j });
  }
  return out;
}

/** Same event rules as tools/level_events.js, one state per fixed level. */
function multiEvents(levels, opt = {}) {
  const tolAtr = opt.tolAtr ?? 0.20;
  const approachAtr = opt.approachAtr ?? 1.5;
  const breakAtr = opt.breakAtr ?? 0.25;
  const resetAtr = opt.resetAtr ?? 1.0;
  const maxPool = opt.maxPool ?? 24;
  const dedupeAtr = opt.dedupeAtr ?? 0.3;
  const events = [];
  let pool = [], li = 0, lastBar = -1;
  for (let i = 1; i < N; i++) {
    const a = atr1[i];
    if (!Number.isFinite(a) || a <= 0) continue;
    while (li < levels.length && levels[li].visibleAt <= i) {
      const L = levels[li++];
      const dup = pool.find(z => Math.abs(z.price - L.price) <= a * dedupeAtr);
      if (dup) { dup.expire = Math.max(dup.expire, L.expire); continue; }
      pool.push({ price: L.price, dir0: L.dir0, expire: L.expire, src: L.src, approached: false, locked: false });
      if (pool.length > maxPool) pool.shift();
    }
    if (pool.length && pool[0].expire < i) pool = pool.filter(z => z.expire >= i);
    const b = bars[i], pc = bars[i - 1].c, tol = a * tolAtr;
    for (const z of pool) {
      const d = Math.abs(b.c - z.price);
      if (z.locked) { if (d > a * resetAtr) z.locked = false; else continue; }
      if (d >= a * approachAtr) z.approached = true;
      if (!z.approached) continue;
      const above = pc > z.price;
      const reached = above ? b.l <= z.price + tol : b.h >= z.price - tol;
      if (!reached) continue;
      let dir = 0, kind = null;
      if (above) {
        if (b.c > z.price + tol * 0.5) { dir = 1; kind = 'reject'; }
        else if (b.c < z.price - a * breakAtr) { dir = -1; kind = 'break'; }
      } else {
        if (b.c < z.price - tol * 0.5) { dir = -1; kind = 'reject'; }
        else if (b.c > z.price + a * breakAtr) { dir = 1; kind = 'break'; }
      }
      if (!kind) continue;
      z.locked = true; z.approached = false;
      if (i === lastBar) continue;
      lastBar = i;
      events.push({ i, dir, kind, level: z.price, dir0: z.dir0, from: above ? 1 : -1, src: z.src });
    }
  }
  return events;
}

const READ = {
  defence:    e => (e.from === e.dir0 ? e.dir0 : 0),
  antiDefence:e => (e.from === -e.dir0 ? e.dir0 : 0),
  polarity:   e => (e.kind === 'reject' && e.dir === e.dir0 ? e.dir : 0),
  engine:     e => e.dir,
};
function apply(events, name) {
  const f = READ[name];
  const out = [];
  for (const e of events) { const d = f(e); if (d) out.push({ ...e, dir: d }); }
  return out;
}

// ── measurement ──────────────────────────────────────────────────────────────
/**
 * pnl per trade plus the two adjustments.
 *   timeAlpha  raw + COST — exact same-moment coin-flip baseline (symmetric TP/SL)
 *   blindAlpha longs vs blind long, shorts vs blind short, weighted (their metric)
 */
function measure(events, TP, SL, MAXH) {
  const rows = [];
  let ln = 0, lnet = 0, sn = 0, snet = 0;
  for (const e of events) {
    const t = trade(e.i, e.dir, TP, SL, MAXH);
    if (!t) continue;
    rows.push({ i: e.i, dir: e.dir, p: t.p, exit: t.exit, t: bars[e.i].t });
    if (e.dir === 1) { ln++; lnet += t.p; } else { sn++; snet += t.p; }
  }
  const tot = ln + sn;
  if (!tot) return { n: 0 };
  const raw = (lnet + snet) / tot;
  const BL = blind(1, TP, SL, MAXH), BS = blind(-1, TP, SL, MAXH);
  const la = ln ? lnet / ln - BL : 0, sa = sn ? snet / sn - BS : 0;
  return {
    n: tot, longs: ln, shorts: sn,
    rawLong: ln ? lnet / ln : NaN, rawShort: sn ? snet / sn : NaN,
    raw, timeAlpha: raw + COST,
    blindAlpha: (la * ln + sa * sn) / tot,
    blindLong: BL, blindShort: BS,
    rows,
  };
}

const f = (x, d = 2) => Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '—';
const f0 = (x, d = 1) => Number.isFinite(x) ? x.toFixed(d) : '—';

/** Greedy non-overlapping subsample: no two trades open at the same time. */
function nonOverlapping(rows) {
  const s = rows.slice().sort((a, b) => a.i - b.i);
  const out = [];
  let free = -1;
  for (const r of s) { if (r.i > free) { out.push(r); free = r.exit; } }
  return out;
}
function tstat(vals) {
  const n = vals.length;
  if (n < 3) return { n, mean: NaN, t: NaN };
  const m = vals.reduce((a, b) => a + b, 0) / n;
  const v = vals.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  return { n, mean: m, sd: Math.sqrt(v), se: Math.sqrt(v / n), t: m / Math.sqrt(v / n) };
}

/** Circular block bootstrap on the calendar-day axis, block = `blk` days. */
function blockBoot(rows, blkDays, seed = 909091, B = 2000) {
  const day0 = Math.floor(bars[0].t / 86400000);
  const dayN = Math.floor(bars[N - 1].t / 86400000);
  const nd = dayN - day0 + 1;
  const byDay = new Array(nd).fill(null).map(() => []);
  for (const r of rows) byDay[Math.floor(r.t / 86400000) - day0].push(r.p + COST); // time-matched excess
  const nb = Math.ceil(nd / blkDays);
  const r = rng(seed);
  const out = [];
  for (let b = 0; b < B; b++) {
    let s = 0, c = 0;
    for (let k = 0; k < nb; k++) {
      const st = Math.floor(r() * nd);
      for (let d = 0; d < blkDays; d++) for (const v of byDay[(st + d) % nd]) { s += v; c++; }
    }
    if (c) out.push(s / c);
  }
  out.sort((a, b) => a - b);
  return { p5: out[Math.floor(0.05 * out.length)], p50: out[Math.floor(0.5 * out.length)], p95: out[Math.floor(0.95 * out.length)], pos: out.filter(v => v > 0).length / out.length };
}

// ── modes ────────────────────────────────────────────────────────────────────
const CH = { look: 250, volMin: 0.90, progMax: 0.30, ageMin: 1440, TP: 120, SL: 120, MAXH: 1440, reading: 'defence' };

function baseEvents(opt = {}) {
  return apply(multiEvents(absorptionLevels({ ...CH, ...opt })), opt.reading ?? CH.reading);
}

/* 0. reproduce, and cross-check against their own module */
function modeRepro() {
  const argv = process.argv.slice();
  process.argv = [argv[0], argv[1], '__none__'];
  const M = require('./absorption.js');
  process.argv = argv;
  const theirLv = M.absorption(1, { sel: [['vol', '>=', 0.90], ['prog', '<=', 0.30]], priceMode: 'extreme', look: 250, ageMin: 1440 });
  const theirEv = M.apply(M.multiEvents(theirLv), 'defence');

  const myLv = absorptionLevels();
  const myAll = multiEvents(myLv);
  const myEv = apply(myAll, 'defence');
  console.log(`levels   theirs ${theirLv.length}   mine ${myLv.length}`);
  console.log(`defence  theirs ${theirEv.length}   mine ${myEv.length}`);
  let same = 0;
  const key = e => `${e.i}|${e.dir}`;
  const set = new Set(theirEv.map(key));
  for (const e of myEv) if (set.has(key(e))) same++;
  console.log(`identical (bar,dir) pairs: ${same}  (${(100 * same / Math.max(1, myEv.length)).toFixed(2)}% of mine)`);

  const s = measure(myEv, CH.TP, CH.SL, CH.MAXH);
  console.log(`\nmy measurement, ${CH.TP}/${CH.SL}/${CH.MAXH}`);
  console.log(`  trades ${s.n}  (${s.longs} long / ${s.shorts} short)`);
  console.log(`  raw ${f(s.raw)}   long ${f(s.rawLong)}  short ${f(s.rawShort)}`);
  console.log(`  blind long ${f(s.blindLong)}  blind short ${f(s.blindShort)}`);
  console.log(`  blindAlpha (their metric) ${f(s.blindAlpha)}`);
  console.log(`  timeAlpha  (raw + cost)   ${f(s.timeAlpha)}`);

  // verify the symmetric-barrier identity that makes timeAlpha exact
  let bad = 0, checked = 0;
  for (let k = 0; k < myEv.length; k += 37) {
    const e = myEv[k];
    const a = trade(e.i, 1, CH.TP, CH.SL, CH.MAXH), b = trade(e.i, -1, CH.TP, CH.SL, CH.MAXH);
    if (a === null || b === null) { if ((a === null) !== (b === null)) bad++; continue; }
    checked++;
    if (Math.abs(a.p + b.p + 2 * COST) > 1e-9) bad++;
  }
  console.log(`  symmetric-barrier identity pnl(+1)+pnl(-1) = -2*cost: checked ${checked}, violations ${bad}`);
}

/* 1. causality */
function modeLookahead() {
  console.log('publication lag: -N means the level is exposed N bars BEFORE the candle closed (a deliberate bug)\n');
  console.log('lag'.padStart(5) + 'levels'.padStart(9) + 'trades'.padStart(9) + 'raw'.padStart(9) + 'timeAlpha'.padStart(11) + 'blindAlpha'.padStart(12));
  for (const lag of [-3, -2, -1, 0, 1, 2, 5, 20, 60]) {
    const ev = baseEvents({ lag });
    const s = measure(ev, CH.TP, CH.SL, CH.MAXH);
    console.log(String(lag).padStart(5) + String(absorptionLevels({ ...CH, lag }).length).padStart(9) + String(s.n).padStart(9) +
      f(s.raw).padStart(9) + f(s.timeAlpha).padStart(11) + f(s.blindAlpha).padStart(12));
  }
  // explicit: is any level's defining bar at or after the bar it can first fire on?
  const lv = absorptionLevels();
  let minGap = Infinity, viol = 0;
  for (const L of lv) { const g = L.visibleAt - L.src; if (g < minGap) minGap = g; if (g < 1) viol++; }
  console.log(`\nmin (visibleAt - defining bar) = ${minGap}   levels visible at or before their defining bar: ${viol}`);
  const ev = baseEvents();
  let early = 0;
  for (const e of ev) if (e.src !== undefined && e.i <= e.src) early++;
  console.log(`events firing at or before the defining bar: ${early} / ${ev.length}`);
}

/* 2. the honest error bar under overlap */
function modeSignificance() {
  const ev = baseEvents();
  const s = measure(ev, CH.TP, CH.SL, CH.MAXH);
  console.log(`trades ${s.n}   raw ${f(s.raw)}   timeAlpha ${f(s.timeAlpha)}   blindAlpha ${f(s.blindAlpha)}\n`);

  const ex = s.rows.map(r => r.p + COST);
  const t0 = tstat(ex);
  console.log(`naive iid t-stat (wrong, trades overlap): mean ${f(t0.mean)}  se ${f0(t0.se, 2)}  t ${f0(t0.t, 2)}`);

  const holds = s.rows.map(r => r.exit - r.i).sort((a, b) => a - b);
  console.log(`hold minutes p25/p50/p75/p90 ${holds[Math.floor(.25 * holds.length)]}/${holds[Math.floor(.5 * holds.length)]}/${holds[Math.floor(.75 * holds.length)]}/${holds[Math.floor(.9 * holds.length)]}   mean ${f0(holds.reduce((a, b) => a + b, 0) / holds.length)}`);
  const avgConc = s.rows.reduce((a, r) => a + (r.exit - r.i), 0) / N;
  console.log(`average concurrent open trades: ${f0(avgConc, 1)}`);

  const no = nonOverlapping(s.rows);
  const tn = tstat(no.map(r => r.p + COST));
  console.log(`\nNON-OVERLAPPING greedy subsample: n ${tn.n}   timeAlpha ${f(tn.mean)}   se ${f0(tn.se, 2)}   t ${f0(tn.t, 2)}`);
  const nl = no.filter(r => r.dir === 1), ns = no.filter(r => r.dir === -1);
  console.log(`   longs n ${nl.length} timeAlpha ${f(tstat(nl.map(r => r.p + COST)).mean)}   shorts n ${ns.length} timeAlpha ${f(tstat(ns.map(r => r.p + COST)).mean)}`);

  console.log('\nblock bootstrap of timeAlpha (blocks of whole calendar days):');
  for (const blk of [1, 3, 7, 14, 21]) {
    const b = blockBoot(s.rows, blk);
    console.log(`  block ${String(blk).padStart(2)}d   5th ${f(b.p5)}   50th ${f(b.p50)}   95th ${f(b.p95)}   share>0 ${(100 * b.pos).toFixed(1)}%`);
  }

  // month by month on the time-matched metric
  const byM = new Map();
  for (const r of s.rows) {
    const k = new Date(r.t).toISOString().slice(0, 7);
    if (!byM.has(k)) byM.set(k, []);
    byM.get(k).push(r.p + COST);
  }
  console.log('\nmonthly timeAlpha:');
  for (const k of [...byM.keys()].sort()) {
    const a = byM.get(k);
    console.log(`  ${k}  n ${String(a.length).padStart(5)}   ${f(a.reduce((x, y) => x + y, 0) / a.length)}`);
  }
}

/* 3. what is actually doing the work — the absorption filter, or the price/dir rule? */
function modeControls() {
  const lv = absorptionLevels();
  const s = measure(baseEvents(), CH.TP, CH.SL, CH.MAXH);
  console.log(`REAL   levels ${lv.length}  trades ${s.n}  raw ${f(s.raw)}  timeAlpha ${f(s.timeAlpha)}  blindAlpha ${f(s.blindAlpha)}\n`);
  const SEEDS = [778899, 121212, 313131, 606060, 909090, 424242, 171717];

  const run = (label, make) => {
    const ta = [], ba = [], ns = [];
    for (const seed of SEEDS) {
      const r = rng(seed);
      const c = make(r).sort((a, b) => a.visibleAt - b.visibleAt);
      const m = measure(apply(multiEvents(c), CH.reading), CH.TP, CH.SL, CH.MAXH);
      ta.push(m.timeAlpha); ba.push(m.blindAlpha); ns.push(m.n);
    }
    const mu = a => a.reduce((x, y) => x + y, 0) / a.length;
    const sd = a => { const m = mu(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
    console.log(label.padEnd(46) + `n ~${String(Math.round(mu(ns))).padStart(6)}   timeAlpha ${f(mu(ta))} ± ${f0(sd(ta), 2)}   blindAlpha ${f(mu(ba))} ± ${f0(sd(ba), 2)}`);
    return mu(ta);
  };

  // A. their control: random price near the birth close, random side
  run('random price ±6 ATR + random side (theirs)', r => lv.map(L => {
    const a = atr1[L.visibleAt] || 1;
    return { ...L, price: bars[L.visibleAt].c + (r() * 2 - 1) * a * 6, dir0: r() < 0.5 ? 1 : -1 };
  }));
  // B. keep the real prices, scramble only the defended side
  run('real price, scrambled side', r => lv.map(L => ({ ...L, dir0: r() < 0.5 ? 1 : -1 })));
  // C. keep everything, flip the side deterministically
  {
    const m = measure(apply(multiEvents(lv.map(L => ({ ...L, dir0: -L.dir0 }))), CH.reading), CH.TP, CH.SL, CH.MAXH);
    console.log('real price, side FLIPPED'.padEnd(46) + `n ${String(m.n).padStart(7)}   timeAlpha ${f(m.timeAlpha)}              blindAlpha ${f(m.blindAlpha)}`);
  }
  // D. THE CONTROL THAT MATTERS: the identical price/side rule on candles that
  //    are NOT absorption candles — same count, drawn at random.
  const K = lv.length;
  run('RANDOM candles, same extreme/side rule', r => {
    const out = [];
    for (let k = 0; k < K; k++) {
      const j = 250 + Math.floor(r() * (N - 252));
      const b = bars[j];
      if (!(b.h - b.l > 0)) continue;
      const { price, dir0 } = extremeOf(b);
      out.push({ price, dir0, visibleAt: j + 1, expire: j + 1 + CH.ageMin, src: j });
    }
    return out;
  });
  // E. volume filter alone / no-progress filter alone
  for (const [lab, o] of [['volume rank >= .90 only', { progMax: 1 }], ['no-progress rank <= .30 only', { volMin: 0 }],
                          ['volume >= .90 & prog <= .30 (chosen)', {}], ['volume <= .50 & prog <= .30 (LOW volume)', { volMin: 0, progMax: 0.30, invertVol: true }]]) {
    let l2;
    if (o.invertVol) {
      const pv = rVol(CH.look), pp = rProg(CH.look);
      l2 = [];
      for (let j = CH.look; j < N - 1; j++) {
        const b = bars[j];
        if (!(b.h - b.l > 0) || !(pv[j] <= 0.50) || !(pp[j] <= 0.30)) continue;
        const { price, dir0 } = extremeOf(b);
        l2.push({ price, dir0, visibleAt: j + 1, expire: j + 1 + CH.ageMin, src: j });
      }
    } else l2 = absorptionLevels({ ...CH, ...o });
    const m = measure(apply(multiEvents(l2), CH.reading), CH.TP, CH.SL, CH.MAXH);
    console.log(lab.padEnd(46) + `n ${String(m.n).padStart(7)}   timeAlpha ${f(m.timeAlpha)}              blindAlpha ${f(m.blindAlpha)}   levels ${l2.length}`);
  }
}

/* 4. derive on Jan-Apr, judge on May-Jul */
function modeSplit() {
  const midT = Date.parse('2026-05-01T00:00:00Z');
  const TH = [20, 40, 60, 90, 120, 160, 220];
  const ev = baseEvents();
  const dev = ev.filter(e => bars[e.i].t < midT), hold = ev.filter(e => bars[e.i].t >= midT);
  console.log(`derive Jan-Apr: ${dev.length} trades    judge May-Jul: ${hold.length} trades\n`);
  console.log('TP=SL'.padStart(7) + 'derive n'.padStart(10) + 'derive tA'.padStart(11) + 'judge n'.padStart(10) + 'judge tA'.padStart(11) + 'judge blindA'.padStart(14) + 'judge t(NO)'.padStart(12));
  for (const T of TH) {
    const a = measure(dev, T, T, CH.MAXH), b = measure(hold, T, T, CH.MAXH);
    const no = nonOverlapping(b.rows);
    const tt = tstat(no.map(r => r.p + COST));
    console.log(String(T).padStart(7) + String(a.n).padStart(10) + f(a.timeAlpha).padStart(11) + String(b.n).padStart(10) +
      f(b.timeAlpha).padStart(11) + f(b.blindAlpha).padStart(14) + (f0(tt.t, 2) + `/${tt.n}`).padStart(12));
  }
  // hold horizon too
  console.log('\nhold sensitivity at 120/120');
  for (const H of [60, 180, 360, 720, 1440, 2880]) {
    const a = measure(dev, 120, 120, H), b = measure(hold, 120, 120, H);
    console.log(`  hold ${String(H).padStart(4)}   derive ${f(a.timeAlpha)} (n ${a.n})    judge ${f(b.timeAlpha)} (n ${b.n})`);
  }
  // readings on the holdout
  console.log('\nreadings on the holdout (May-Jul), 120/120/1440');
  const all = multiEvents(absorptionLevels());
  for (const rd of ['defence', 'antiDefence', 'polarity', 'engine']) {
    const sub = apply(all, rd).filter(e => bars[e.i].t >= midT);
    if (sub.length < 50) continue;
    const m = measure(sub, 120, 120, 1440);
    console.log(`  ${rd.padEnd(12)} n ${String(m.n).padStart(6)}  timeAlpha ${f(m.timeAlpha)}  blindAlpha ${f(m.blindAlpha)}`);
  }
}

/* 5. the null distribution of the SAME machinery on candles that are not absorption candles */
function levelsFrom(idx) {
  const out = [];
  for (const j of idx) {
    const b = bars[j];
    if (!(b.h - b.l > 0)) continue;
    const { price, dir0 } = extremeOf(b);
    out.push({ price, dir0, visibleAt: j + 1, expire: j + 1 + CH.ageMin, src: j });
  }
  return out.sort((a, b) => a.visibleAt - b.visibleAt);
}
function poolOf(pred) {
  const pv = rVol(CH.look), pp = rProg(CH.look), out = [];
  for (let j = CH.look; j < N - 1; j++) if (bars[j].h - bars[j].l > 0 && pred(pv[j], pp[j])) out.push(j);
  return out;
}
function drawFrom(pool, k, r) {
  const a = pool.slice();
  const out = [];
  for (let z = 0; z < k && a.length; z++) { const q = Math.floor(r() * a.length); out.push(a[q]); a[q] = a[a.length - 1]; a.pop(); }
  return out.sort((x, y) => x - y);
}
/** Draw from `pool` matching the hour-of-day histogram of `ref`. */
function drawHourMatched(pool, ref, r) {
  const hr = j => new Date(bars[j].t).getUTCHours();
  const want = new Array(24).fill(0);
  for (const j of ref) want[hr(j)]++;
  const byH = new Array(24).fill(null).map(() => []);
  for (const j of pool) byH[hr(j)].push(j);
  const out = [];
  for (let h = 0; h < 24; h++) out.push(...drawFrom(byH[h], Math.min(want[h], byH[h].length), r));
  return out.sort((x, y) => x - y);
}
function nullDist(label, make, draws) {
  const tA = [], bA = [], ns = [];
  for (let d = 0; d < draws; d++) {
    const r = rng(1000003 + d * 7919);
    const m = measure(apply(multiEvents(make(r)), CH.reading), CH.TP, CH.SL, CH.MAXH);
    tA.push(m.timeAlpha); bA.push(m.blindAlpha); ns.push(m.n);
  }
  const mu = a => a.reduce((x, y) => x + y, 0) / a.length;
  const sd = a => { const m = mu(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
  return { label, tA, bA, n: Math.round(mu(ns)), muT: mu(tA), sdT: sd(tA), muB: mu(bA), sdB: sd(bA) };
}
function modeNull(draws = 50) {
  const real = measure(baseEvents(), CH.TP, CH.SL, CH.MAXH);
  const realLv = absorptionLevels();
  const K = realLv.length;
  const refIdx = realLv.map(L => L.src);
  console.log(`REAL  levels ${K}  trades ${real.n}  timeAlpha ${f(real.timeAlpha)}  blindAlpha ${f(real.blindAlpha)}`);
  console.log(`\nnull distributions, ${draws} draws each, identical price/side rule and identical event machinery,`);
  console.log('only the SET of source candles changes.\n');
  const anyPool = poolOf(() => true);
  const volPool = poolOf((v) => v >= CH.volMin);
  const progPool = poolOf((v, p) => p <= CH.progMax);
  const rows = [
    nullDist('any candle', r => levelsFrom(drawFrom(anyPool, K, r)), draws),
    nullDist('any candle, hour-of-day matched', r => levelsFrom(drawHourMatched(anyPool, refIdx, r)), draws),
    nullDist('vol>=.90 pool (isolates prog<=.30)', r => levelsFrom(drawFrom(volPool, K, r)), draws),
    nullDist('prog<=.30 pool (isolates vol>=.90)', r => levelsFrom(drawFrom(progPool, K, r)), draws),
  ];
  console.log('null'.padEnd(38) + 'n'.padStart(8) + 'timeAlpha mean±sd'.padStart(20) + '   z(real)' + '  p1' + '     blindAlpha mean±sd'.padStart(24) + '   z(real)' + '  p1');
  for (const R of rows) {
    const zT = (real.timeAlpha - R.muT) / R.sdT, zB = (real.blindAlpha - R.muB) / R.sdB;
    const pT = (R.tA.filter(v => v >= real.timeAlpha).length + 1) / (R.tA.length + 1);
    const pB = (R.bA.filter(v => v >= real.blindAlpha).length + 1) / (R.bA.length + 1);
    console.log(R.label.padEnd(38) + String(R.n).padStart(8) + `${f(R.muT)} ± ${f0(R.sdT, 2)}`.padStart(20) + f0(zT, 2).padStart(10) + pT.toFixed(3).padStart(6) +
      `${f(R.muB)} ± ${f0(R.sdB, 2)}`.padStart(24) + f0(zB, 2).padStart(10) + pB.toFixed(3).padStart(6));
  }
}

/* 6. is (vol>=.90, prog<=.30) a plateau or a spike, and does it hold out of sample? */
function modeGrid() {
  const midT = Date.parse('2026-05-01T00:00:00Z');
  const VS = [0.70, 0.80, 0.85, 0.90, 0.95, 0.98];
  const PS = [0.10, 0.20, 0.30, 0.40, 0.50, 0.70];
  console.log('blindAlpha at 120/120/1440, reading=defence.  cell = full | Jan-Apr | May-Jul   (n = full trades)\n');
  console.log('vol\\prog'.padEnd(10) + PS.map(p => String(p).padStart(24)).join(''));
  for (const v of VS) {
    const cells = [];
    for (const p of PS) {
      const ev = baseEvents({ volMin: v, progMax: p });
      const a = measure(ev, CH.TP, CH.SL, CH.MAXH);
      const d = measure(ev.filter(e => bars[e.i].t < midT), CH.TP, CH.SL, CH.MAXH);
      const h = measure(ev.filter(e => bars[e.i].t >= midT), CH.TP, CH.SL, CH.MAXH);
      cells.push((a.n < 100 ? `[n${a.n}]` : `${f(a.blindAlpha, 1)}|${f(d.blindAlpha, 1)}|${f(h.blindAlpha, 1)}`).padStart(24));
    }
    console.log(String(v).padEnd(10) + cells.join(''));
  }
}

/* 7. the four (from, dir0) cells, each traded both ways */
function modeCells() {
  const all = multiEvents(absorptionLevels());
  const midT = Date.parse('2026-05-01T00:00:00Z');
  console.log('every arrival, split by which side price came from and which side the candle defended.');
  console.log('blindAlpha of trading dir0, and of trading -dir0.  full | Jan-Apr | May-Jul\n');
  console.log('cell'.padEnd(34) + 'n'.padStart(7) + 'trade dir0'.padStart(26) + 'trade -dir0'.padStart(26));
  for (const [lab, pick] of [
    ['from=+1 dir0=+1  at a defended LOW', e => e.from === 1 && e.dir0 === 1],
    ['from=-1 dir0=-1  at a defended HIGH', e => e.from === -1 && e.dir0 === -1],
    ['from=-1 dir0=+1  LOW already broken', e => e.from === -1 && e.dir0 === 1],
    ['from=+1 dir0=-1  HIGH already broken', e => e.from === 1 && e.dir0 === -1],
  ]) {
    const sub = all.filter(pick);
    const cell = sign => {
      const ev = sub.map(e => ({ ...e, dir: sign * e.dir0 }));
      const a = measure(ev, CH.TP, CH.SL, CH.MAXH);
      const d = measure(ev.filter(e => bars[e.i].t < midT), CH.TP, CH.SL, CH.MAXH);
      const h = measure(ev.filter(e => bars[e.i].t >= midT), CH.TP, CH.SL, CH.MAXH);
      return `${f(a.blindAlpha, 1)}|${f(d.blindAlpha, 1)}|${f(h.blindAlpha, 1)}`.padStart(26);
    };
    console.log(lab.padEnd(34) + String(sub.length).padStart(7) + cell(1) + cell(-1));
  }
}

/* 8. honest t-stat from many randomised non-overlapping subsamples */
function modeIndep() {
  const s = measure(baseEvents(), CH.TP, CH.SL, CH.MAXH);
  const rows = s.rows.slice().sort((a, b) => a.i - b.i);
  const means = [], ts = [], ns = [];
  for (let d = 0; d < 200; d++) {
    const r = rng(50021 + d * 613);
    const pick = [];
    let free = -1;
    // random start offset, then greedy forward with a random skip so the subsample is not always the same
    let k = Math.floor(r() * 40);
    for (; k < rows.length; k++) {
      const row = rows[k];
      if (row.i > free) { pick.push(row.p + COST); free = row.exit; }
    }
    const t = tstat(pick);
    means.push(t.mean); ts.push(t.t); ns.push(t.n);
  }
  const mu = a => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`randomised non-overlapping subsamples (200): mean n ${Math.round(mu(ns))}   mean timeAlpha ${f(mu(means))}   mean t ${f0(mu(ts), 2)}`);
  const st = ts.slice().sort((a, b) => a - b);
  console.log(`  t across subsamples  5th ${f0(st[10], 2)}  50th ${f0(st[100], 2)}  95th ${f0(st[190], 2)}`);
  // and the same for the random-candle null, so the two are compared like for like
  const anyPool = poolOf(() => true);
  const K = absorptionLevels().length;
  const nm = [];
  for (let d = 0; d < 12; d++) {
    const r = rng(88001 + d * 331);
    const m = measure(apply(multiEvents(levelsFrom(drawFrom(anyPool, K, r))), CH.reading), CH.TP, CH.SL, CH.MAXH);
    const no = nonOverlapping(m.rows);
    nm.push(tstat(no.map(x => x.p + COST)).mean);
  }
  const m2 = mu(nm), sd2 = Math.sqrt(nm.reduce((a, b) => a + (b - m2) ** 2, 0) / (nm.length - 1));
  console.log(`  random-candle null, same subsampling: ${f(m2)} ± ${f0(sd2, 2)}   (12 draws)`);
}

/* 9. the frozen config judged on May-Jul only, against the same null on May-Jul only */
function modeHoldout(draws = 50) {
  const midT = Date.parse('2026-05-01T00:00:00Z');
  const K = absorptionLevels().length;
  const anyPool = poolOf(() => true);
  const win = (rows, lo, hi) => rows.filter(e => bars[e.i].t >= lo && bars[e.i].t < hi);
  const HI = Infinity, LO = -Infinity;
  const seg = [['Jan-Apr (derive)', LO, midT], ['May-Jul (judge)', midT, HI]];

  const realEv = baseEvents();
  console.log('the SAME machinery, only the source candles change. blindAlpha at 120/120/1440.\n');
  console.log('window'.padEnd(20) + 'real n'.padStart(9) + 'real'.padStart(9) + 'null mean±sd'.padStart(18) + 'z'.padStart(7) + 'p1'.padStart(7) + '  excess');
  for (const [lab, lo, hi] of seg) {
    const r0 = measure(win(realEv, lo, hi), CH.TP, CH.SL, CH.MAXH);
    const vals = [];
    for (let d = 0; d < draws; d++) {
      const r = rng(1000003 + d * 7919);
      const ev = apply(multiEvents(levelsFrom(drawFrom(anyPool, K, r))), CH.reading);
      vals.push(measure(win(ev, lo, hi), CH.TP, CH.SL, CH.MAXH).blindAlpha);
    }
    const mu = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mu) ** 2, 0) / (vals.length - 1));
    const p = (vals.filter(v => v >= r0.blindAlpha).length + 1) / (vals.length + 1);
    console.log(lab.padEnd(20) + String(r0.n).padStart(9) + f(r0.blindAlpha).padStart(9) + `${f(mu)} ± ${f0(sd, 2)}`.padStart(18) +
      f0((r0.blindAlpha - mu) / sd, 2).padStart(7) + p.toFixed(3).padStart(7) + f(r0.blindAlpha - mu).padStart(9));
  }
  // and the two legs of `defence` separately, out of sample
  const all = multiEvents(absorptionLevels());
  console.log('\nthe two legs of the defence reading, judged separately:');
  for (const [lab, pick] of [['long leg  (defended LOW)', e => e.from === 1 && e.dir0 === 1], ['short leg (defended HIGH)', e => e.from === -1 && e.dir0 === -1]]) {
    const sub = all.filter(pick).map(e => ({ ...e, dir: e.dir0 }));
    const a = measure(win(sub, LO, midT), CH.TP, CH.SL, CH.MAXH);
    const b = measure(win(sub, midT, HI), CH.TP, CH.SL, CH.MAXH);
    console.log(`  ${lab.padEnd(28)} Jan-Apr ${f(a.blindAlpha)} (n ${a.n})    May-Jul ${f(b.blindAlpha)} (n ${b.n})`);
  }
}

const MODE = process.argv[2] || 'repro';
if (MODE === 'holdout') modeHoldout(+(process.argv[3] || 50));
else if (MODE === 'null') modeNull(+(process.argv[3] || 50));
else if (MODE === 'grid') modeGrid();
else if (MODE === 'cells') modeCells();
else if (MODE === 'indep') modeIndep();
else if (MODE === 'repro') modeRepro();
else if (MODE === 'lookahead') modeLookahead();
else if (MODE === 'sig') modeSignificance();
else if (MODE === 'controls') modeControls();
else if (MODE === 'split') modeSplit();
else if (MODE !== '__none__') console.log('modes: repro lookahead sig controls split');

module.exports = { bars, atr1, trade, measure, absorptionLevels, multiEvents, apply, nonOverlapping, tstat, blockBoot, rng, extremeOf, rVol, rProg, blind, CH };
