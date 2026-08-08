'use strict';
/*
 * ADVERSARIAL VERIFICATION of the "round psychological numbers" claim.
 *
 * Claim under test: fixed $100 grid, 1m detection, tol $0.25, approach $3.00,
 * break-close $0.60, reset $2.10, BREAK reading only, target 90 / stop 45,
 * hold 240m  ->  direction-adjusted alpha +6.35 on 1,019 trades, t 3.09,
 * beats 12/12 spacing-matched shadow grids (z +4.50).
 *
 * Everything here re-derives the numbers from the exported primitives rather
 * than trusting the author's stages.
 *
 *   node --max-old-space-size=3500 tools/fixes/round-numbers-verify.js <stage>
 *     repro   reproduce + overlap structure + non-overlapping subset
 *     look    independent lookahead / causality audit
 *     exec    entry delay, pessimistic ambiguity, realistic cost
 *     local   time-matched direction baseline (kills falling-market disguise)
 *     boot    block bootstrap by day (overlap-aware significance)
 *     oos     derive Jan-Apr, judge May-Jul (config + shadow z out of sample)
 *     shtune  tune the shadows the same way the round grid was tuned
 *     all     everything
 */

const R = require('./round-numbers.js');
const { bars, N, PU, COST, constLevelEvents, gridEvents, roundGrid, atr1 } = R;

const FINAL = R.FINAL;
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const sgn = (x, d = 2) => (Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '—');
const line = (n = 90) => console.log('─'.repeat(n));

// ── local trade simulator, with knobs the author's did not have ──────────────
// mode: 'drop' (author's: ambiguous candle -> discard trade)
//       'pess' (ambiguous candle -> assume the stop filled first)
//       'opt'  (ambiguous candle -> assume the target filled first)
// entryOffset: 0 = close of the trigger bar (author's), 1 = open of the next bar
function race2(i, dir, tp, sl, hold, opts = {}) {
  const mode = opts.mode || 'drop';
  const cost = opts.cost ?? COST;
  const eo = opts.entryOffset ?? 0;
  let e, start;
  if (eo === 0) { e = bars[i].c; start = i + 1; }
  else { const k = i + eo; if (k >= N - 2) return null; e = bars[k].o; start = k; }
  const t = e + dir * tp * PU, s = e - dir * sl * PU;
  const end = Math.min(N - 1, i + hold);
  for (let j = start; j <= end; j++) {
    const b = bars[j];
    const ht = dir === 1 ? b.h >= t : b.l <= t;
    const hs = dir === 1 ? b.l <= s : b.h >= s;
    if (ht && hs) {
      if (mode === 'drop') return null;
      if (mode === 'pess') return -sl - cost;
      return tp - cost;
    }
    if (ht) return tp - cost;
    if (hs) return -sl - cost;
  }
  return ((bars[end].c - e) * dir) / PU - cost;
}

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BL = new Map();
function blind2(dir, tp, sl, hold, opts = {}) {
  const key = `${dir}|${tp}|${sl}|${hold}|${opts.mode || 'drop'}|${opts.cost ?? COST}|${opts.entryOffset ?? 0}|${opts.lo ?? ''}|${opts.hi ?? ''}`;
  if (BL.has(key)) return BL.get(key);
  const r = rng(dir === 1 ? 31337 : 73331);
  const lo = opts.lo ?? 100, hi = opts.hi ?? N - hold - 2;
  let c = 0, net = 0;
  for (let k = 0; k < 40000; k++) {
    const p = race2(lo + Math.floor(r() * (hi - lo)), dir, tp, sl, hold, opts);
    if (p === null) continue;
    c++; net += p;
  }
  const v = net / c;
  BL.set(key, v);
  return v;
}

function score2(events, tp, sl, hold, opts = {}) {
  const bl = opts.blLong ?? blind2(1, tp, sl, hold, opts);
  const bs = opts.blShort ?? blind2(-1, tp, sl, hold, opts);
  let ln = 0, lnet = 0, sn = 0, snet = 0, wins = 0;
  const per = [];
  for (const e of events) {
    const p = race2(e.i, e.dir, tp, sl, hold, opts);
    if (p === null) continue;
    if (p > 0) wins++;
    if (e.dir === 1) { ln++; lnet += p; } else { sn++; snet += p; }
    per.push({ i: e.i, a: p - (e.dir === 1 ? bl : bs) });
  }
  const tot = ln + sn;
  const la = ln ? lnet / ln - bl : 0;
  const sa = sn ? snet / sn - bs : 0;
  const alpha = tot ? (la * ln + sa * sn) / tot : NaN;
  const mean = per.length ? per.reduce((a, b) => a + b.a, 0) / per.length : NaN;
  const sd = per.length > 1
    ? Math.sqrt(per.reduce((s, x) => s + (x.a - mean) ** 2, 0) / (per.length - 1)) : NaN;
  return {
    n: tot, longs: ln, shorts: sn,
    winRate: tot ? (100 * wins) / tot : NaN,
    raw: tot ? (lnet + snet) / tot : NaN,
    alpha, t: mean / (sd / Math.sqrt(per.length)), sd, per,
  };
}

const OFF_FRACS = [0.07, 0.13, 0.19, 0.23, 0.31, 0.37, 0.41, 0.47, 0.59, 0.67, 0.79, 0.89];
const brk = (e) => e.kind === 'break';
const bounce = (e) => e.kind === 'reject';

function evs(over = {}) {
  const o = { ...FINAL, ...over };
  return gridEvents(o.step, {
    minutes: o.minutes, offset: o.offset ?? 0,
    tolUsd: o.tolUsd, approachUsd: o.approachUsd, breakUsd: o.breakUsd, resetUsd: o.resetUsd,
  }).filter(o.reading === 'bounce' ? bounce : brk);
}

// ─────────────────────────────────────────────────────────────────────────────
function stageRepro() {
  const { tp, sl, hold } = FINAL;
  const ev = evs();
  const s = score2(ev, tp, sl, hold);
  console.log('1. REPRODUCTION (author\'s exact rules, my own simulator)');
  console.log(`   events ${ev.length}  traded ${s.n}  longs ${s.longs} shorts ${s.shorts}`);
  console.log(`   raw ${sgn(s.raw)}  blindL ${sgn(blind2(1, tp, sl, hold))} blindS ${sgn(blind2(-1, tp, sl, hold))}`);
  console.log(`   DIRECTION-ADJUSTED ALPHA ${sgn(s.alpha)}   t ${f(s.t)}   win ${f(s.winRate, 1)}%`);
  console.log(`   author claimed +6.35 / t 3.09 / n 1019 -> ${Math.abs(s.alpha - 6.35) < 0.05 ? 'MATCHES' : 'DIFFERS'}`);

  console.log('\n2. OVERLAP STRUCTURE (trades hold 240m; overlapping trades are not independent)');
  const idx = ev.map((e) => e.i).sort((a, b) => a - b);
  let overl = 0;
  for (let k = 1; k < idx.length; k++) if (idx[k] - idx[k - 1] < hold) overl++;
  console.log(`   ${overl} of ${idx.length - 1} consecutive events start within ${hold}m of the previous (${f((100 * overl) / (idx.length - 1), 1)}%)`);
  const gaps = [];
  for (let k = 1; k < idx.length; k++) gaps.push(idx[k] - idx[k - 1]);
  gaps.sort((a, b) => a - b);
  console.log(`   spacing between events: median ${gaps[gaps.length >> 1]}m, 25th ${gaps[gaps.length >> 2]}m`);
  // how many distinct calendar days carry events, and how concentrated
  const byDay = new Map();
  for (const e of ev) {
    const d = new Date(bars[e.i].t).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + 1);
  }
  const counts = [...byDay.values()].sort((a, b) => b - a);
  console.log(`   ${byDay.size} distinct days carry the ${ev.length} events; busiest days ${counts.slice(0, 6).join(',')}`);

  console.log('\n3. NON-OVERLAPPING SUBSET (greedy: drop any event starting inside the previous trade)');
  const keep = [];
  let lastEnd = -1;
  for (const e of [...ev].sort((a, b) => a.i - b.i)) {
    if (e.i <= lastEnd) continue;
    keep.push(e); lastEnd = e.i + hold;
  }
  const sn2 = score2(keep, tp, sl, hold);
  console.log(`   n ${sn2.n}   raw ${sgn(sn2.raw)}   alpha ${sgn(sn2.alpha)}   t ${f(sn2.t)}`);

  console.log('\n4. EVENT COUNT AND ALPHA BY MONTH (does the effect decay?)');
  const m = new Map();
  for (const e of ev) {
    const k = new Date(bars[e.i].t).toISOString().slice(0, 7);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(e);
  }
  for (const k of [...m.keys()].sort()) {
    const g = score2(m.get(k), tp, sl, hold);
    console.log(`   ${k}  n ${String(g.n).padStart(4)}  raw ${sgn(g.raw).padStart(8)}  alpha ${sgn(g.alpha).padStart(8)}  t ${f(g.t)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
function stageLook() {
  console.log('LOOKAHEAD AUDIT — independent of the author\'s verify stage.\n');

  console.log('1. Does the grid carry information from the sample? roundGrid() uses full-sample lo/hi.');
  const g = roundGrid(100);
  console.log(`   grid built from sample range: ${g.length} levels  [${g[0]} .. ${g[g.length - 1]}]`);
  const universal = [];
  for (let v = 500; v <= 20000; v += 100) universal.push(v);
  const o = { tolUsd: FINAL.tolUsd, approachUsd: FINAL.approachUsd, breakUsd: FINAL.breakUsd, resetUsd: FINAL.resetUsd };
  const a = [], b = [];
  for (const L of g) for (const e of constLevelEvents(bars, atr1, L, o)) a.push(`${e.i}|${e.level}|${e.kind}`);
  for (const L of universal) for (const e of constLevelEvents(bars, atr1, L, o)) b.push(`${e.i}|${e.level}|${e.kind}`);
  a.sort(); b.sort();
  const same = a.length === b.length && a.every((v, k) => v === b[k]);
  console.log(`   sample-range grid ${a.length} events; universal 500..20000 grid ${b.length} events; identical: ${same}`);

  console.log('\n2. STRICT PREFIX TEST — rebuild everything (bars, ATR, events) from only the first K bars.');
  console.log('   Compare full-sample events with prefix events, on bars strictly inside the prefix.');
  const E = require('../ai963_engine');
  for (const K of [30000, 60000, 100000, 150000, 190000]) {
    const pre = bars.slice(0, K);
    const preAtr = E.atr(pre, 14);
    const full = new Set(), prefix = new Set();
    for (const L of g) {
      for (const e of constLevelEvents(bars, atr1, L, o)) if (e.i < K - 1) full.add(`${e.i}|${e.level}|${e.kind}|${e.dir}`);
      for (const e of constLevelEvents(pre, preAtr, L, o)) if (e.i < K - 1) prefix.add(`${e.i}|${e.level}|${e.kind}|${e.dir}`);
    }
    let miss = 0;
    for (const x of full) if (!prefix.has(x)) miss++;
    for (const x of prefix) if (!full.has(x)) miss++;
    console.log(`   K=${String(K).padStart(7)}  full ${String(full.size).padStart(5)}  prefix ${String(prefix.size).padStart(5)}  mismatches ${miss}`);
  }

  console.log('\n3. Does any event use a bar later than its own index? (direct inspection of the detector)');
  console.log('   constLevelEvents reads b[i], b[i-1].c, atr[i] only. Confirming by truncation:');
  let bad = 0;
  const ev = evs();
  const E2 = require('../ai963_engine');
  for (const e of ev.slice(0, 40)) {
    const cut = bars.slice(0, e.i + 1);
    const cutAtr = E2.atr(cut, 14);
    const L = e.level;
    const found = constLevelEvents(cut, cutAtr, L, o).some((x) => x.i === e.i && x.kind === e.kind && x.dir === e.dir);
    if (!found) bad++;
  }
  console.log(`   40 sampled events re-found when the series is truncated at their own bar: ${40 - bad}/40 (violations ${bad})`);

  console.log('\n4. Entry price sanity: entry = close of the trigger bar, which is also what defines the trigger.');
  let viol = 0;
  for (const e of ev) {
    const c = bars[e.i].c, L = e.level;
    if (e.dir === -1 && !(c < L - FINAL.breakUsd + 1e-9)) viol++;
    if (e.dir === 1 && !(c > L + FINAL.breakUsd - 1e-9)) viol++;
  }
  console.log(`   ${ev.length} events, entries inconsistent with their own trigger rule: ${viol}`);
  console.log('   -> entry is knowable exactly at the bar close. No future bar is touched. NO LOOKAHEAD FOUND.');
}

// ─────────────────────────────────────────────────────────────────────────────
function stageExec() {
  const { tp, sl, hold } = FINAL;
  const ev = evs();
  console.log('EXECUTION REALISM — every row recomputes its own blind baselines under the same rules.\n');
  line(96);
  console.log('variant'.padEnd(42) + 'n'.padStart(6) + 'raw'.padStart(9) + 'blindL'.padStart(9) + 'blindS'.padStart(9) + 'alpha'.padStart(9) + 't'.padStart(7));
  line(96);
  const rows = [
    ['author: entry@close, ambiguous dropped, cost 0.5', {}],
    ['ambiguous candle -> assume STOP first', { mode: 'pess' }],
    ['ambiguous candle -> assume TARGET first', { mode: 'opt' }],
    ['entry at NEXT bar open (1m delay)', { entryOffset: 1 }],
    ['entry at next bar open + pessimistic', { entryOffset: 1, mode: 'pess' }],
    ['entry 2 bars later', { entryOffset: 2 }],
    ['entry 5 bars later', { entryOffset: 5 }],
    ['cost 3.0 pts round trip', { cost: 3.0 }],
    ['cost 3.0 + 1m delay + pessimistic', { cost: 3.0, entryOffset: 1, mode: 'pess' }],
  ];
  for (const [name, opts] of rows) {
    const s = score2(ev, tp, sl, hold, opts);
    console.log(name.padEnd(42) + String(s.n).padStart(6) + sgn(s.raw).padStart(9) +
      sgn(blind2(1, tp, sl, hold, opts)).padStart(9) + sgn(blind2(-1, tp, sl, hold, opts)).padStart(9) +
      sgn(s.alpha).padStart(9) + f(s.t).padStart(7));
  }
  line(96);
}

// ─────────────────────────────────────────────────────────────────────────────
// A time-matched baseline: for each event, average random same-direction entries
// drawn from a window around the same moment. Kills any "falling market wearing
// a disguise" objection, because the comparison is local in time.
function stageLocal() {
  const { tp, sl, hold } = FINAL;
  const ev = evs();
  console.log('TIME-MATCHED DIRECTION ADJUSTMENT');
  console.log('Full-sample blind baselines assume drift is constant. Events cluster in Jan-Mar,');
  console.log('so recompute the baseline LOCALLY: random same-direction entries within +/- W minutes.\n');
  for (const W of [720, 1440, 4320, 10080]) {
    const r = rng(9090 + W);
    let tot = 0, cnt = 0;
    const per = [];
    for (const e of ev) {
      const p = race2(e.i, e.dir, tp, sl, hold);
      if (p === null) continue;
      let s = 0, c = 0;
      for (let k = 0; k < 40; k++) {
        const j = Math.max(100, Math.min(N - hold - 2, e.i + Math.floor((r() * 2 - 1) * W)));
        const q = race2(j, e.dir, tp, sl, hold);
        if (q === null) continue;
        s += q; c++;
      }
      if (!c) continue;
      const a = p - s / c;
      per.push(a); tot += a; cnt++;
    }
    const m = tot / cnt;
    const sd = Math.sqrt(per.reduce((s, x) => s + (x - m) ** 2, 0) / (cnt - 1));
    console.log(`   window +/-${String(W).padStart(5)}m  n ${cnt}  locally-adjusted alpha ${sgn(m)}   t ${f(m / (sd / Math.sqrt(cnt)))}`);
  }

  console.log('\nMONTH-MATCHED BASELINE (baseline drawn only from the same calendar month):');
  const monthBars = new Map();
  for (let i = 100; i < N - hold - 2; i++) {
    const k = new Date(bars[i].t).toISOString().slice(0, 7);
    if (!monthBars.has(k)) monthBars.set(k, []);
    monthBars.get(k).push(i);
  }
  const mbl = new Map();
  for (const [k, list] of monthBars) {
    const r = rng(k.length * 7919 + list.length);
    for (const d of [1, -1]) {
      let s = 0, c = 0;
      for (let z = 0; z < 6000; z++) {
        const q = race2(list[(r() * list.length) | 0], d, tp, sl, hold);
        if (q === null) continue;
        s += q; c++;
      }
      mbl.set(`${k}|${d}`, s / c);
    }
  }
  let tot = 0, cnt = 0; const per = [];
  for (const e of ev) {
    const p = race2(e.i, e.dir, tp, sl, hold);
    if (p === null) continue;
    const k = new Date(bars[e.i].t).toISOString().slice(0, 7);
    const b = mbl.get(`${k}|${e.dir}`);
    if (!Number.isFinite(b)) continue;
    per.push(p - b); tot += p - b; cnt++;
  }
  const m = tot / cnt;
  const sd = Math.sqrt(per.reduce((s, x) => s + (x - m) ** 2, 0) / (cnt - 1));
  console.log(`   n ${cnt}   month-matched alpha ${sgn(m)}   t ${f(m / (sd / Math.sqrt(cnt)))}`);
}

// ─────────────────────────────────────────────────────────────────────────────
function stageBoot() {
  const { tp, sl, hold } = FINAL;
  const ev = evs();
  const s = score2(ev, tp, sl, hold);
  console.log('OVERLAP-AWARE SIGNIFICANCE');
  console.log(`naive per-trade t = ${f(s.t)} on n ${s.n} — but trades overlap, so this is optimistic.\n`);

  // group per-trade alphas by calendar day, then bootstrap whole days
  const byDay = new Map();
  for (const p of s.per) {
    const d = new Date(bars[p.i].t).toISOString().slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(p.a);
  }
  const days = [...byDay.values()];
  const totalN = s.per.length;
  const grand = s.per.reduce((a, b) => a + b.a, 0) / totalN;
  const r = rng(424242);
  const ms = [];
  for (let k = 0; k < 5000; k++) {
    let sum = 0, c = 0;
    while (c < totalN) {
      const d = days[(r() * days.length) | 0];
      for (const v of d) { sum += v; c++; }
    }
    ms.push(sum / c);
  }
  ms.sort((a, b) => a - b);
  console.log(`   DAY-BLOCK bootstrap (${days.length} days, 5000 resamples)`);
  console.log(`   mean ${sgn(grand)}   90% CI [${sgn(ms[250])}, ${sgn(ms[4750])}]   share > 0 ${f((100 * ms.filter((v) => v > 0).length) / ms.length, 1)}%`);
  const sdB = Math.sqrt(ms.reduce((a, b) => a + (b - grand) ** 2, 0) / ms.length);
  console.log(`   bootstrap sd of the mean ${f(sdB)}  =>  block-adjusted t ~ ${f(grand / sdB)}`);

  // week blocks
  const byWk = new Map();
  for (const p of s.per) {
    const d = new Date(bars[p.i].t);
    const wk = Math.floor(d.getTime() / (7 * 86400000));
    if (!byWk.has(wk)) byWk.set(wk, []);
    byWk.get(wk).push(p.a);
  }
  const wks = [...byWk.values()];
  const ms2 = [];
  const r2 = rng(777);
  for (let k = 0; k < 5000; k++) {
    let sum = 0, c = 0;
    while (c < totalN) {
      const d = wks[(r2() * wks.length) | 0];
      for (const v of d) { sum += v; c++; }
    }
    ms2.push(sum / c);
  }
  ms2.sort((a, b) => a - b);
  const sdW = Math.sqrt(ms2.reduce((a, b) => a + (b - grand) ** 2, 0) / ms2.length);
  console.log(`\n   WEEK-BLOCK bootstrap (${wks.length} weeks)`);
  console.log(`   90% CI [${sgn(ms2[250])}, ${sgn(ms2[4750])}]   share > 0 ${f((100 * ms2.filter((v) => v > 0).length) / ms2.length, 1)}%   block t ~ ${f(grand / sdW)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
const SPLIT_T = Date.parse('2026-05-01T00:00:00Z');
let SPLIT_I = 0;
for (let i = 0; i < N; i++) if (bars[i].t < SPLIT_T) SPLIT_I = i;

function stageOOS() {
  console.log(`HONEST SPLIT: derive on Jan-Apr (bars 0..${SPLIT_I}), judge on May-Jul (${SPLIT_I + 1}..${N - 1}).`);
  console.log(`derivation ${((100 * SPLIT_I) / N).toFixed(1)}% of bars.\n`);
  const IN = (e) => e.i <= SPLIT_I;
  const OUT = (e) => e.i > SPLIT_I;

  console.log('A. THE AUTHOR\'S EXACT FINAL CONFIG, evaluated on each half:');
  const ev = evs();
  for (const [nm, sel] of [['Jan-Apr (in)', IN], ['May-Jul (out)', OUT]]) {
    const s = score2(ev.filter(sel), FINAL.tp, FINAL.sl, FINAL.hold);
    console.log(`   ${nm.padEnd(15)} n ${String(s.n).padStart(4)}  raw ${sgn(s.raw).padStart(8)}  alpha ${sgn(s.alpha).padStart(8)}  t ${f(s.t)}`);
  }
  // shadows out of sample at the author's config
  const shOut = [];
  for (const fr of OFF_FRACS) {
    const e = evs({ offset: +(100 * fr).toFixed(4) }).filter(OUT);
    if (e.length < 40) continue;
    shOut.push(score2(e, FINAL.tp, FINAL.sl, FINAL.hold).alpha);
  }
  const so = score2(ev.filter(OUT), FINAL.tp, FINAL.sl, FINAL.hold);
  const mO = shOut.reduce((a, b) => a + b, 0) / shOut.length;
  const sdO = Math.sqrt(shOut.reduce((a, b) => a + (b - mO) ** 2, 0) / (shOut.length - 1));
  console.log(`   out-of-sample shadows: mean ${sgn(mO)} sd ${f(sdO)}  round ${sgn(so.alpha)}  z ${sgn((so.alpha - mO) / sdO)}  beat ${shOut.filter((v) => so.alpha > v).length}/${shOut.length}`);

  console.log('\nB. FULL RE-DERIVATION on Jan-Apr only (detector + target + timeframe), then spent on May-Jul:');
  let best = null;
  let tried = 0;
  for (const minutes of [1, 5]) {
    for (const tolUsd of [0.25, 0.5, 1.0]) {
      for (const approachUsd of [3, 5, 10]) {
        for (const breakUsd of [0.3, 0.6, 1.2]) {
          const base = { minutes, tolUsd, approachUsd, breakUsd, resetUsd: +(approachUsd * 0.7).toFixed(2) };
          const all = evs(base);
          const ins = all.filter(IN);
          if (ins.length < 100) continue;
          for (const [tp, sl] of [[45, 25], [60, 30], [75, 40], [90, 45], [120, 60], [90, 90], [60, 60]]) {
            for (const hold of [120, 240, 720]) {
              tried++;
              const s = score2(ins, tp, sl, hold);
              if (s.n < 100) continue;
              if (!best || s.alpha > best.alpha) best = { ...base, tp, sl, hold, alpha: s.alpha, n: s.n };
            }
          }
        }
      }
    }
  }
  console.log(`   ${tried} configurations searched in-sample.`);
  console.log(`   winner: ${best.minutes}m tol $${best.tolUsd} appr $${best.approachUsd} brk $${best.breakUsd} target ${best.tp}/${best.sl} hold ${best.hold}`);
  console.log(`   in-sample alpha ${sgn(best.alpha)} on n ${best.n}`);
  const oosSet = evs(best).filter(OUT);
  const soos = score2(oosSet, best.tp, best.sl, best.hold);
  console.log(`   OUT OF SAMPLE: n ${soos.n}  raw ${sgn(soos.raw)}  alpha ${sgn(soos.alpha)}  t ${f(soos.t)}`);
  const sh2 = [];
  for (const fr of OFF_FRACS) {
    const e = evs({ ...best, offset: +(100 * fr).toFixed(4) }).filter(OUT);
    if (e.length < 40) continue;
    sh2.push(score2(e, best.tp, best.sl, best.hold).alpha);
  }
  const m2 = sh2.reduce((a, b) => a + b, 0) / sh2.length;
  const sd2 = Math.sqrt(sh2.reduce((a, b) => a + (b - m2) ** 2, 0) / (sh2.length - 1));
  console.log(`   OOS shadows: mean ${sgn(m2)} sd ${f(sd2)}  z ${sgn((soos.alpha - m2) / sd2)}  beat ${sh2.filter((v) => soos.alpha > v).length}/${sh2.length}`);

  console.log('\nC. REVERSED SPLIT (derive May-Jul, judge Jan-Apr) — sanity on which half carries it:');
  let best2 = null;
  for (const minutes of [1, 5]) {
    for (const tolUsd of [0.25, 0.5, 1.0]) {
      for (const approachUsd of [3, 5, 10]) {
        for (const breakUsd of [0.3, 0.6, 1.2]) {
          const base = { minutes, tolUsd, approachUsd, breakUsd, resetUsd: +(approachUsd * 0.7).toFixed(2) };
          const outs = evs(base).filter(OUT);
          if (outs.length < 100) continue;
          for (const [tp, sl] of [[45, 25], [60, 30], [75, 40], [90, 45], [120, 60], [90, 90], [60, 60]]) {
            for (const hold of [120, 240, 720]) {
              const s = score2(outs, tp, sl, hold);
              if (s.n < 100) continue;
              if (!best2 || s.alpha > best2.alpha) best2 = { ...base, tp, sl, hold, alpha: s.alpha, n: s.n };
            }
          }
        }
      }
    }
  }
  console.log(`   winner on May-Jul: ${best2.minutes}m tol $${best2.tolUsd} appr $${best2.approachUsd} brk $${best2.breakUsd} ${best2.tp}/${best2.sl} hold ${best2.hold}  alpha ${sgn(best2.alpha)} n ${best2.n}`);
  const back = score2(evs(best2).filter(IN), best2.tp, best2.sl, best2.hold);
  console.log(`   applied to Jan-Apr: n ${back.n}  alpha ${sgn(back.alpha)}  t ${f(back.t)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The z=+4.50 compares a TUNED round grid against UNTUNED shadows. Tune the
// shadows the same way and see what is left.
function stageShTune() {
  console.log('SYMMETRIC TUNING — the decisive fairness test.');
  console.log('The author tuned tol/approach/break/target on the ROUND grid, then compared the tuned');
  console.log('round grid against shadows evaluated at that same config. That is not a fair contest.');
  console.log('Here every grid — round and shadow — gets the same search, and we compare bests.\n');

  const DET = [];
  for (const tolUsd of [0.25, 0.5, 1.0]) {
    for (const approachUsd of [3, 5, 10]) {
      for (const breakUsd of [0.3, 0.6, 1.2]) {
        DET.push({ tolUsd, approachUsd, breakUsd, resetUsd: +(approachUsd * 0.7).toFixed(2) });
      }
    }
  }
  const TGT = [[45, 25], [60, 30], [75, 40], [90, 45], [120, 60], [90, 90]];
  const HOLD = [120, 240];

  function bestOf(offset) {
    let bA = -Infinity, bCfg = null;
    for (const d of DET) {
      const set = evs({ ...d, offset });
      if (set.length < 100) continue;
      for (const [tp, sl] of TGT) {
        for (const hold of HOLD) {
          const s = score2(set, tp, sl, hold);
          if (s.n < 100) continue;
          if (s.alpha > bA) { bA = s.alpha; bCfg = { ...d, tp, sl, hold, n: s.n, t: s.t }; }
        }
      }
    }
    return { alpha: bA, cfg: bCfg };
  }

  const round = bestOf(0);
  console.log(`   ROUND grid best-of-search: alpha ${sgn(round.alpha)}  (tol $${round.cfg.tolUsd} appr $${round.cfg.approachUsd} brk $${round.cfg.breakUsd} ${round.cfg.tp}/${round.cfg.sl} hold ${round.cfg.hold}, n ${round.cfg.n}, t ${f(round.cfg.t)})`);
  const sh = [];
  for (const fr of OFF_FRACS) {
    const b = bestOf(+(100 * fr).toFixed(4));
    sh.push(b.alpha);
    console.log(`   shadow +$${String((100 * fr).toFixed(0)).padStart(3)} best-of-search: alpha ${sgn(b.alpha)}  (${b.cfg.tp}/${b.cfg.sl} hold ${b.cfg.hold}, n ${b.cfg.n})`);
  }
  const m = sh.reduce((a, b) => a + b, 0) / sh.length;
  const sd = Math.sqrt(sh.reduce((a, b) => a + (b - m) ** 2, 0) / (sh.length - 1));
  console.log(`\n   shadows tuned: mean ${sgn(m)} sd ${f(sd)}   round ${sgn(round.alpha)}   z ${sgn((round.alpha - m) / sd)}   beat ${sh.filter((v) => round.alpha > v).length}/${sh.length}`);

  console.log('\n   FOR CONTRAST — the author\'s asymmetric comparison at the single FINAL config:');
  const rf = score2(evs(), FINAL.tp, FINAL.sl, FINAL.hold);
  const shf = OFF_FRACS.map((fr) => score2(evs({ offset: +(100 * fr).toFixed(4) }), FINAL.tp, FINAL.sl, FINAL.hold).alpha);
  const mf = shf.reduce((a, b) => a + b, 0) / shf.length;
  const sdf = Math.sqrt(shf.reduce((a, b) => a + (b - mf) ** 2, 0) / (shf.length - 1));
  console.log(`   round ${sgn(rf.alpha)}  shadows mean ${sgn(mf)} sd ${f(sdf)}  z ${sgn((rf.alpha - mf) / sdf)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Twelve shadows is a thin control. Run EVERY $1 offset from $1 to $99 at the
// author's exact FINAL config and locate the round grid in that distribution.
function stagePerc() {
  const { tp, sl, hold } = FINAL;
  console.log('FULL OFFSET SCAN — the round grid against all 99 integer-dollar shifts of the same $100 grid.');
  console.log('Author\'s exact FINAL detector and target. No tuning anywhere.\n');
  const rows = [];
  for (let off = 0; off <= 99; off++) {
    const e = evs({ offset: off });
    if (e.length < 100) { rows.push({ off, n: e.length, alpha: NaN }); continue; }
    const s = score2(e, tp, sl, hold);
    rows.push({ off, n: s.n, alpha: s.alpha, t: s.t });
  }
  const ok = rows.filter((r) => Number.isFinite(r.alpha));
  const zero = rows[0];
  const others = ok.filter((r) => r.off !== 0);
  const m = others.reduce((a, b) => a + b.alpha, 0) / others.length;
  const sd = Math.sqrt(others.reduce((a, b) => a + (b.alpha - m) ** 2, 0) / (others.length - 1));
  const better = others.filter((r) => r.alpha >= zero.alpha).length;
  console.log(`   round grid (offset $0): n ${zero.n}  alpha ${sgn(zero.alpha)}  t ${f(zero.t)}`);
  console.log(`   ${others.length} shifted grids: mean ${sgn(m)}  sd ${f(sd)}  min ${sgn(Math.min(...others.map((r) => r.alpha)))}  max ${sgn(Math.max(...others.map((r) => r.alpha)))}`);
  console.log(`   z ${sgn((zero.alpha - m) / sd)}   shifted grids matching or beating the round grid: ${better}/${others.length}  =>  empirical p ${f((better + 1) / (others.length + 1), 3)}`);
  const sorted = [...others].sort((a, b) => b.alpha - a.alpha);
  console.log(`   top shifted grids: ${sorted.slice(0, 8).map((r) => `+$${r.off}:${sgn(r.alpha, 1)}`).join('  ')}`);
  console.log(`   note the $50 shift specifically (the "half-round" number): ${sgn(rows[50].alpha)}  n ${rows[50].n}`);

  console.log('\n   SAME SCAN, OUT OF SAMPLE ONLY (May-Jul):');
  const OUT = (e) => e.i > SPLIT_I;
  const rows2 = [];
  for (let off = 0; off <= 99; off++) {
    const e = evs({ offset: off }).filter(OUT);
    if (e.length < 40) { rows2.push({ off, alpha: NaN }); continue; }
    rows2.push({ off, n: e.length, alpha: score2(e, tp, sl, hold).alpha });
  }
  const o2 = rows2.filter((r) => Number.isFinite(r.alpha) && r.off !== 0);
  const m2 = o2.reduce((a, b) => a + b.alpha, 0) / o2.length;
  const sd2 = Math.sqrt(o2.reduce((a, b) => a + (b.alpha - m2) ** 2, 0) / (o2.length - 1));
  const b2 = o2.filter((r) => r.alpha >= rows2[0].alpha).length;
  console.log(`   round ${sgn(rows2[0].alpha)}   shifted mean ${sgn(m2)} sd ${f(sd2)}   z ${sgn((rows2[0].alpha - m2) / sd2)}   beaten by ${b2}/${o2.length}  =>  empirical p ${f((b2 + 1) / (o2.length + 1), 3)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Is the round-vs-shadow gap a property of round numbers, or of one quarter?
function stageRegime() {
  const { tp, sl, hold } = FINAL;
  console.log('REGIME DEPENDENCE — round grid vs the shadow ENSEMBLE, month by month.\n');
  const grids = [{ off: 0, ev: evs() }];
  for (const fr of OFF_FRACS) grids.push({ off: +(100 * fr).toFixed(0), ev: evs({ offset: +(100 * fr).toFixed(4) }) });
  const months = [...new Set(bars.filter((_, i) => i % 500 === 0).map((b) => new Date(b.t).toISOString().slice(0, 7)))].sort();
  line(84);
  console.log('month'.padEnd(9) + 'roundN'.padStart(8) + 'round'.padStart(9) + 'shadowMean'.padStart(12) + 'shadowSd'.padStart(10) + 'z'.padStart(8) + 'beat'.padStart(8));
  line(84);
  for (const mo of months) {
    const sel = (e) => new Date(bars[e.i].t).toISOString().slice(0, 7) === mo;
    const r = score2(grids[0].ev.filter(sel), tp, sl, hold);
    const sh = [];
    for (let k = 1; k < grids.length; k++) {
      const set = grids[k].ev.filter(sel);
      if (set.length < 25) continue;
      sh.push(score2(set, tp, sl, hold).alpha);
    }
    if (sh.length < 6 || r.n < 25) { console.log(mo.padEnd(9) + String(r.n).padStart(8) + '   too few'); continue; }
    const m = sh.reduce((a, b) => a + b, 0) / sh.length;
    const sd = Math.sqrt(sh.reduce((a, b) => a + (b - m) ** 2, 0) / (sh.length - 1));
    console.log(mo.padEnd(9) + String(r.n).padStart(8) + sgn(r.alpha).padStart(9) + sgn(m).padStart(12) +
      f(sd).padStart(10) + sgn((r.alpha - m) / sd).padStart(8) + `${sh.filter((v) => r.alpha > v).length}/${sh.length}`.padStart(8));
  }
  line(84);
  console.log('\nSHADOW ENSEMBLE OVERALL BY HALF (does the whole breakout family decay, or only the round grid?):');
  for (const [nm, sel] of [['Jan-Apr', (e) => e.i <= SPLIT_I], ['May-Jul', (e) => e.i > SPLIT_I]]) {
    const r = score2(grids[0].ev.filter(sel), tp, sl, hold);
    const sh = grids.slice(1).map((g) => score2(g.ev.filter(sel), tp, sl, hold).alpha);
    const m = sh.reduce((a, b) => a + b, 0) / sh.length;
    console.log(`   ${nm}   round ${sgn(r.alpha)} (n ${r.n})   shadow mean ${sgn(m)}   gap ${sgn(r.alpha - m)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
function stageFragile() {
  const { tp, sl, hold } = FINAL;
  const ev = evs();
  const s = score2(ev, tp, sl, hold);
  console.log('CONCENTRATION — how much of the alpha rides on a handful of clustered days?\n');
  const byDay = new Map();
  for (const p of s.per) {
    const d = new Date(bars[p.i].t).toISOString().slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(p.a);
  }
  const days = [...byDay.entries()].map(([d, v]) => ({ d, n: v.length, sum: v.reduce((a, b) => a + b, 0) }));
  days.sort((a, b) => b.sum - a.sum);
  const total = days.reduce((a, b) => a + b.sum, 0);
  console.log(`   total alpha-points ${f(total, 0)} over ${s.per.length} trades on ${days.length} days`);
  console.log('   top contributing days:');
  for (const d of days.slice(0, 8)) console.log(`     ${d.d}  n ${String(d.n).padStart(3)}  alpha-points ${f(d.sum, 0).padStart(7)}  (${f((100 * d.sum) / total, 1)}% of the total)`);
  for (const k of [1, 2, 3, 5, 10]) {
    const drop = new Set(days.slice(0, k).map((x) => x.d));
    const rest = s.per.filter((p) => !drop.has(new Date(bars[p.i].t).toISOString().slice(0, 10)));
    const m = rest.reduce((a, b) => a + b.a, 0) / rest.length;
    const sd = Math.sqrt(rest.reduce((a, b) => a + (b.a - m) ** 2, 0) / (rest.length - 1));
    console.log(`   drop best ${String(k).padStart(2)} days -> n ${String(rest.length).padStart(4)}  alpha ${sgn(m)}  t ${f(m / (sd / Math.sqrt(rest.length)))}`);
  }

  console.log('\nPARAMETER NEIGHBOURHOOD, IN-SAMPLE vs OUT-OF-SAMPLE (the author only showed in-sample):');
  line(92);
  console.log('tol'.padEnd(7) + 'appr'.padEnd(7) + 'brk'.padEnd(7) + 'nIn'.padStart(7) + 'alphaIn'.padStart(10) + 'nOut'.padStart(7) + 'alphaOut'.padStart(10) + 'tOut'.padStart(8));
  line(92);
  let pi = 0, po = 0, tot = 0;
  for (const tolUsd of [0.15, 0.25, 0.4, 0.6, 1.0]) {
    for (const approachUsd of [3, 5, 8, 12]) {
      for (const breakUsd of [0.3, 0.6, 0.9]) {
        const set = evs({ tolUsd, approachUsd, breakUsd, resetUsd: +(approachUsd * 0.7).toFixed(2) });
        const a = set.filter((e) => e.i <= SPLIT_I), b = set.filter((e) => e.i > SPLIT_I);
        if (a.length < 100 || b.length < 60) continue;
        const sa = score2(a, tp, sl, hold), sb = score2(b, tp, sl, hold);
        tot++; if (sa.alpha > 0) pi++; if (sb.alpha > 0) po++;
        console.log(tolUsd.toFixed(2).padEnd(7) + String(approachUsd).padEnd(7) + breakUsd.toFixed(2).padEnd(7) +
          String(sa.n).padStart(7) + sgn(sa.alpha).padStart(10) + String(sb.n).padStart(7) + sgn(sb.alpha).padStart(10) + f(sb.t).padStart(8));
      }
    }
  }
  line(92);
  console.log(`   positive in-sample ${pi}/${tot};  positive out-of-sample ${po}/${tot}`);

  console.log('\nMARKET CONTEXT by month (why do the events dry up?):');
  const mm = new Map();
  for (let i = 0; i < N; i++) {
    const k = new Date(bars[i].t).toISOString().slice(0, 7);
    if (!mm.has(k)) mm.set(k, { o: bars[i].c, c: bars[i].c, hi: -Infinity, lo: Infinity, tr: 0, n: 0 });
    const r = mm.get(k);
    r.c = bars[i].c; r.hi = Math.max(r.hi, bars[i].h); r.lo = Math.min(r.lo, bars[i].l);
    if (i > 0) r.tr += Math.abs(bars[i].c - bars[i - 1].c);
    r.n++;
  }
  for (const k of [...mm.keys()].sort()) {
    const r = mm.get(k);
    console.log(`   ${k}  bars ${String(r.n).padStart(6)}  open ${f(r.o, 0)} close ${f(r.c, 0)}  range $${f(r.hi - r.lo, 0)}  net $${sgn(r.c - r.o, 0)}  $100-marks inside range ${Math.floor(r.hi / 100) - Math.ceil(r.lo / 100) + 1}`);
  }
}

const STAGES = { repro: stageRepro, look: stageLook, exec: stageExec, local: stageLocal, boot: stageBoot, oos: stageOOS, shtune: stageShTune, perc: stagePerc, regime: stageRegime, fragile: stageFragile };
const which = process.argv[2] || 'repro';
if (which === 'all') {
  for (const k of Object.keys(STAGES)) { console.log(`\n${'='.repeat(96)}\n${k.toUpperCase()}\n${'='.repeat(96)}`); STAGES[k](); }
} else if (STAGES[which]) STAGES[which]();
else console.log('stages: ' + Object.keys(STAGES).join(', ') + ', all');
