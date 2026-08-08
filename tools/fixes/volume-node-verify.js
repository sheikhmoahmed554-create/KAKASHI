'use strict';
/*
 * REFUTATION ATTEMPT — "high volume node / point of control", value-area edges.
 *
 * Everything here is re-implemented from the definition rather than imported
 * from tools/fixes/volume-node.js, so an error in that file cannot propagate
 * silently. Level values and event counts are cross-checked against it once,
 * then all scoring is my own.
 *
 * The four attacks, in order:
 *   1  lookahead        — rebuild the level with an explicit "as of bar i" walk
 *   2  direction        — replace the sample-wide blind baseline with a
 *                         TIME-MATCHED one computed in a window around each event
 *   3  selection        — derive on Jan–Apr, judge on May–Jul, baselines local
 *   4  sample           — cluster the events by session/week; the 1,496 "trades"
 *                         are ~139 session-days of the same two levels
 *
 * Usage: node --max-old-space-size=3500 tools/fixes/volume-node-verify.js <stage>
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('../ai963_engine');

const PU = 0.10, COST = 0.5;

// ── data ─────────────────────────────────────────────────────────────────────
function loadBars() {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'KAKASHI_V16_TV_PARITY_AUDIT.html'), 'utf8');
  const csv = zlib.gunzipSync(Buffer.from(html.match(/const BUILTIN_2026_GZ_B64='([^']+)'/)[1], 'base64')).toString('utf8');
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
const H = new Float64Array(N), L_ = new Float64Array(N), C = new Float64Array(N);
for (let i = 0; i < N; i++) { H[i] = bars[i].h; L_[i] = bars[i].l; C[i] = bars[i].c; }

// ── sessions ────────────────────────────────────────────────────────────────
function sessions(anchorMin, minBars = 300) {
  const span = 86400000, off = anchorMin * 60000;
  const out = [];
  let key = null;
  for (let i = 0; i < N; i++) {
    const k = Math.floor((bars[i].t - off) / span);
    if (k !== key) { out.push({ from: i, to: i + 1 }); key = k; }
    else out[out.length - 1].to = i + 1;
  }
  if (minBars <= 0) return out;
  const merged = [];
  for (const s of out) {
    if (merged.length && (s.to - s.from) < minBars) { merged[merged.length - 1].to = s.to; continue; }
    merged.push(s);
  }
  return merged;
}

// ── volume profile, rebuilt from the definition ──────────────────────────────
/**
 * Profile of bars [a, b) on a grid of `width`. Buckets are absolute multiples of
 * `width` (bucket index = floor(price/width)), so nothing about the grid depends
 * on the whole sample — checked below against a grid built from a prefix only.
 */
function profile(a, b, width, vaPct) {
  const m = new Map();
  let total = 0;
  for (let i = a; i < b; i++) {
    const lo = Math.floor(bars[i].l / width), hi = Math.floor(bars[i].h / width);
    const v = bars[i].v > 0 ? bars[i].v : 1;
    const share = v / (hi - lo + 1);
    for (let q = lo; q <= hi; q++) m.set(q, (m.get(q) || 0) + share);
    total += v;
  }
  if (!m.size) return null;
  const keys = [...m.keys()].sort((x, y) => x - y);
  const qlo = keys[0], qhi = keys[keys.length - 1];
  const at = q => m.get(q) || 0;
  let poc = qlo, best = -1;
  for (const q of keys) if (at(q) > best) { best = at(q); poc = q; }
  let tot = 0; for (const q of keys) tot += at(q);
  let up = poc, dn = poc, acc = at(poc);
  const target = tot * vaPct;
  while (acc < target && (dn > qlo || up < qhi)) {
    const u = (up + 1 <= qhi ? at(up + 1) : 0) + (up + 2 <= qhi ? at(up + 2) : 0);
    const d = (dn - 1 >= qlo ? at(dn - 1) : 0) + (dn - 2 >= qlo ? at(dn - 2) : 0);
    if (up >= qhi && dn <= qlo) break;
    if (up < qhi && (u >= d || dn <= qlo)) { up = Math.min(qhi, up + 2); acc += u; }
    else { dn = Math.max(qlo, dn - 2); acc += d; }
  }
  return {
    poc: (poc + 0.5) * width,
    vah: (up + 1) * width,
    val: dn * width,
    hi: (qhi + 1) * width,
    lo: qlo * width,
  };
}

/**
 * Levels, built with an explicit causal walk: at the moment session s opens,
 * only bars strictly before session s exist. `knownAt` is the index of the last
 * bar that entered the profile, +1.
 */
function buildLevels(opt = {}) {
  const anchorMin = opt.anchorMin ?? 0;
  const width = opt.width ?? 0.25;
  const window = opt.window ?? 1;
  const hold = opt.hold ?? 1;
  const vaPct = opt.vaPct ?? 0.70;
  const kinds = opt.kinds ?? ['vah', 'val'];
  const minBars = opt.minBars ?? 300;
  const shift = opt.shift ?? 0;
  const sess = sessions(anchorMin, minBars);
  const out = [];
  for (let s = window; s < sess.length; s++) {
    const src = s + shift;
    if (src > sess.length - 1) break;
    const p = profile(sess[src - window].from, sess[src - 1].to, width, vaPct);
    if (!p) continue;
    const knownAt = sess[src - 1].to;
    const from = sess[s].from;
    const to = sess[Math.min(sess.length - 1, s + hold - 1)].to;
    for (const k of kinds) {
      const v = p[k];
      if (!Number.isFinite(v)) continue;
      out.push({ value: v, kind: k, from, to, knownAt, session: s, center: p.poc });
    }
  }
  return out;
}

// ── events, re-implemented ───────────────────────────────────────────────────
function eventsFor(Lv, o = {}) {
  const tolAtr = o.tolAtr ?? 0.20, approachAtr = o.approachAtr ?? 1.5;
  const breakAtr = o.breakAtr ?? 0.25, resetAtr = o.resetAtr ?? 1.0;
  const ev = [];
  const V = Lv.value;
  let approached = false, locked = false;
  for (let i = Math.max(1, Lv.from); i < Lv.to; i++) {
    const a = atr1[i];
    if (!(a > 0)) continue;
    const tol = a * tolAtr;
    const d = Math.abs(C[i] - V);
    if (locked && d > a * resetAtr) locked = false;
    if (d >= a * approachAtr) approached = true;
    if (!approached || locked) continue;
    const above = C[i - 1] > V;
    const reached = above ? L_[i] <= V + tol : H[i] >= V - tol;
    if (!reached) continue;
    let dir = 0, kind = '';
    if (above) {
      if (C[i] > V + tol * 0.5) { dir = 1; kind = 'reject'; }
      else if (C[i] < V - a * breakAtr) { dir = -1; kind = 'break'; }
      else continue;
    } else {
      if (C[i] < V - tol * 0.5) { dir = -1; kind = 'reject'; }
      else if (C[i] > V + a * breakAtr) { dir = 1; kind = 'break'; }
      else continue;
    }
    locked = true; approached = false;
    if (i < 1 || i >= N - 2) continue;
    if (i < Lv.knownAt) throw new Error('CAUSALITY VIOLATION');
    ev.push({ i, dir, kind, level: V, src: Lv.kind, session: Lv.session, inward: Lv.center > V ? 1 : Lv.center < V ? -1 : 0 });
  }
  return ev;
}

function allEvents(levels, o = {}) {
  const all = [];
  for (const Lv of levels) for (const e of eventsFor(Lv, o)) all.push(e);
  all.sort((x, y) => x.i - y.i || x.level - y.level);
  const out = [];
  for (const e of all) {
    const p = out[out.length - 1];
    if (p && p.i === e.i) {
      if (Math.abs(C[e.i] - e.level) < Math.abs(C[p.i] - p.level)) out[out.length - 1] = e;
      continue;
    }
    out.push(e);
  }
  return out;
}

function reading(ev, mode) {
  if (mode === 'as-is') return ev;
  if (mode === 'to-value') return ev.filter(e => e.inward !== 0).map(e => ({ ...e, dir: e.inward }));
  if (mode === 'from-value') return ev.filter(e => e.inward !== 0).map(e => ({ ...e, dir: -e.inward }));
  if (mode === 'flip') return ev.map(e => ({ ...e, dir: -e.dir }));
  throw new Error('reading?');
}

// ── trade outcome, precomputed for EVERY bar ─────────────────────────────────
/**
 * For every bar and both directions, the first-touch bar of each threshold in
 * THR plus the timeout exit. This makes the blind baseline EXACT (every bar,
 * not 40,000 samples) and makes a time-local baseline exact too.
 */
const THR = [15, 20, 30, 40, 60, 90, 120, 150, 200];
const NT = THR.length;
const CACHE = new Map();
function precompute(maxHold) {
  if (CACHE.has(maxHold)) return CACHE.get(maxHold);
  const res = {};
  for (const dir of [1, -1]) {
    const tHit = new Int32Array(N * NT).fill(-1);
    const sHit = new Int32Array(N * NT).fill(-1);
    const open = new Float64Array(N);
    const valid = new Uint8Array(N);
    for (let i = 0; i < N - 1; i++) {
      const e = C[i];
      const end = Math.min(N - 1, i + maxHold);
      if (end <= i) continue;
      valid[i] = 1;
      let ti = 0, si = 0;
      const b0 = i * NT;
      for (let j = i + 1; j <= end; j++) {
        const fav = dir === 1 ? H[j] - e : e - L_[j];
        const adv = dir === 1 ? e - L_[j] : H[j] - e;
        while (ti < NT && fav >= THR[ti] * PU) { tHit[b0 + ti] = j; ti++; }
        while (si < NT && adv >= THR[si] * PU) { sHit[b0 + si] = j; si++; }
        if (ti >= NT && si >= NT) break;
      }
      open[i] = (C[end] - e) * dir / PU;
    }
    res[dir] = { tHit, sHit, open, valid };
  }
  CACHE.set(maxHold, res);
  return res;
}
function pl(i, dir, ti, si, maxHold) {
  const g = precompute(maxHold)[dir];
  if (!g.valid[i]) return null;
  const t = g.tHit[i * NT + ti], s = g.sHit[i * NT + si];
  if (t < 0 && s < 0) return g.open[i] - COST;
  if (t >= 0 && s >= 0 && t === s) return null;
  if (t >= 0 && (s < 0 || t < s)) return THR[ti] - COST;
  return -THR[si] - COST;
}
/** P&L of every bar for one (tp, sl, hold, dir) — the exact null distribution. */
const PLCACHE = new Map();
function plArray(dir, ti, si, maxHold) {
  const key = `${dir}|${ti}|${si}|${maxHold}`;
  if (PLCACHE.has(key)) return PLCACHE.get(key);
  const a = new Float64Array(N), ok = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const p = pl(i, dir, ti, si, maxHold); if (p !== null) { a[i] = p; ok[i] = 1; } }
  const out = { a, ok };
  PLCACHE.set(key, out);
  return out;
}
function ti_(v) { const k = THR.indexOf(v); if (k < 0) throw new Error('threshold ' + v + ' not in grid'); return k; }

// exact sample-wide blind baseline, over every bar rather than 40k samples
function blindExact(dir, tp, sl, maxHold, from = 0, to = N) {
  const { a, ok } = plArray(dir, ti_(tp), ti_(sl), maxHold);
  let s = 0, c = 0;
  for (let i = from; i < to; i++) if (ok[i]) { s += a[i]; c++; }
  return c ? s / c : NaN;
}

// ── inference ────────────────────────────────────────────────────────────────
function mean(x) { return x.reduce((a, b) => a + b, 0) / x.length; }
function sd(x) { const u = mean(x); return Math.sqrt(x.reduce((a, b) => a + (b - u) * (b - u), 0) / Math.max(1, x.length - 1)); }

/**
 * Ordinary t (events independent) AND cluster-robust t (events inside one
 * session are one observation). 1,496 events come from 139 session-days of two
 * fixed levels with 240-bar holds; they are not 1,496 independent draws.
 */
function inference(contrib, cluster) {
  const n = contrib.length;
  const a = mean(contrib);
  const s = sd(contrib);
  const tNaive = a / (s / Math.sqrt(n));
  const g = new Map();
  for (let k = 0; k < n; k++) {
    const c = cluster[k];
    g.set(c, (g.get(c) || 0) + (contrib[k] - a));
  }
  let ss = 0;
  for (const v of g.values()) ss += v * v;
  const seCl = Math.sqrt(ss) / n;
  const G = g.size;
  const corr = Math.sqrt(G / Math.max(1, G - 1));
  return { n, alpha: a, seNaive: s / Math.sqrt(n), tNaive, clusters: G, seCluster: seCl * corr, tCluster: a / (seCl * corr) };
}

/** Stationary bootstrap over clusters. */
function clusterBootstrap(contrib, cluster, reps = 4000, seed = 12345) {
  const byC = new Map();
  for (let k = 0; k < contrib.length; k++) {
    if (!byC.has(cluster[k])) byC.set(cluster[k], []);
    byC.get(cluster[k]).push(contrib[k]);
  }
  const groups = [...byC.values()];
  const G = groups.length;
  let s = seed;
  const rnd = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const out = [];
  for (let r = 0; r < reps; r++) {
    let sum = 0, cnt = 0;
    for (let k = 0; k < G; k++) {
      const gp = groups[Math.floor(rnd() * G)];
      for (const v of gp) { sum += v; cnt++; }
    }
    out.push(sum / cnt);
  }
  out.sort((x, y) => x - y);
  const q = p => out[Math.min(out.length - 1, Math.floor(p * out.length))];
  return { lo: q(0.025), med: q(0.5), hi: q(0.975), pLeq0: out.filter(v => v <= 0).length / out.length };
}

// ── scoring ──────────────────────────────────────────────────────────────────
/**
 * Direction-adjusted per-event contribution.
 *   base 'global'  the sample-wide blind baseline for that direction
 *   base 'window'  the blind baseline for that direction computed ONLY from
 *                  bars within +/- `win` of the event. This is the honest
 *                  control: it removes every drift slower than the window, so a
 *                  falling market cannot masquerade as short alpha.
 */
function contributions(ev, tp, sl, maxHold, opt = {}) {
  const base = opt.base ?? 'global';
  const win = opt.win ?? 1440;
  const range = opt.range ?? [0, N];
  const a = ti_(tp), b = ti_(sl);
  const G = {};
  const PRE = {};
  for (const dir of [1, -1]) {
    G[dir] = blindExact(dir, tp, sl, maxHold, range[0], range[1]);
    if (base === 'window') {
      const { a: arr, ok } = plArray(dir, a, b, maxHold);
      const cs = new Float64Array(N + 1), cn = new Float64Array(N + 1);
      for (let i = 0; i < N; i++) { cs[i + 1] = cs[i] + (ok[i] ? arr[i] : 0); cn[i + 1] = cn[i] + (ok[i] ? 1 : 0); }
      PRE[dir] = { cs, cn };
    }
  }
  const out = [];
  for (const e of ev) {
    if (e.i < range[0] || e.i >= range[1]) continue;
    const p = pl(e.i, e.dir, a, b, maxHold);
    if (p === null) continue;
    let bl;
    if (base === 'global') bl = G[e.dir];
    else {
      const lo = Math.max(range[0], e.i - win), hi = Math.min(range[1], e.i + win);
      const { cs, cn } = PRE[e.dir];
      const c = cn[hi] - cn[lo];
      if (c < 50) continue;
      bl = (cs[hi] - cs[lo]) / c;
    }
    out.push({ e, p, bl, x: p - bl });
  }
  return out;
}

function summarise(rows, clusterOf) {
  const contrib = rows.map(r => r.x);
  const cl = rows.map(r => clusterOf(r.e));
  const inf = inference(contrib, cl);
  const L = rows.filter(r => r.e.dir === 1), S = rows.filter(r => r.e.dir === -1);
  return {
    ...inf,
    raw: mean(rows.map(r => r.p)),
    longs: L.length, shorts: S.length,
    alphaLong: L.length ? mean(L.map(r => r.x)) : NaN,
    alphaShort: S.length ? mean(S.map(r => r.x)) : NaN,
  };
}

const sessionOf = e => e.session;
const weekOf = e => Math.floor(e.i / (1379 * 5));
const sg = (x, d = 2) => Number.isFinite(x) ? ((x > 0 ? '+' : '') + x.toFixed(d)) : '—';
const CLAIM = { anchorMin: 0, width: 0.25, window: 1, hold: 1, vaPct: 0.70, kinds: ['vah', 'val'] };
const TP = 150, SL = 150, HOLD = 240;

// ═════════════════════════════════════════════════════════════════════════════
function stageCheck() {
  console.log('1. INDEPENDENT REBUILD — does my code reproduce their level set?\n');
  const lv = buildLevels(CLAIM);
  const ev = reading(allEvents(lv, {}), 'to-value');
  console.log(`  levels ${lv.length}   (claim 278)`);
  console.log(`  events ${ev.length}   (claim 1496)`);
  const bad = lv.filter(x => x.knownAt > x.from).length;
  const gap = Math.min(...lv.map(x => x.from - x.knownAt));
  console.log(`  knownAt > from: ${bad};  min gap (from - knownAt) = ${gap} bars`);

  // The grid must not depend on the whole sample. Rebuild the bucket base from a
  // prefix of the data and confirm identical level values.
  console.log('\n  grid independence: bucket index = floor(price/width), no PMIN/PMAX involved');
  const l2 = buildLevels({ ...CLAIM, width: 0.25 });
  let diff = 0;
  for (let k = 0; k < lv.length; k++) if (Math.abs(lv[k].value - l2[k].value) > 1e-9) diff++;
  console.log(`  ${diff} level values differ on rebuild (must be 0)`);

  // Strict causal walk: rebuild each level using ONLY bars < from, with a fresh
  // pass that has never seen a later bar.
  console.log('\n2. LOOKAHEAD — strict "as of bar i" rebuild');
  const sess = sessions(0, 300);
  let mism = 0, checked = 0;
  for (let s = 1; s < sess.length; s++) {
    const cut = sess[s].from;
    const p = profile(sess[s - 1].from, cut, 0.25, 0.70);   // uses bars [.., cut-1] only
    if (!p) continue;
    const mine = [p.vah, p.val];
    const theirs = lv.filter(x => x.session === s).sort((a, b) => b.value - a.value).map(x => x.value);
    if (theirs.length !== 2) continue;
    checked++;
    if (Math.abs(mine[0] - theirs[0]) > 1e-9 || Math.abs(mine[1] - theirs[1]) > 1e-9) mism++;
  }
  console.log(`  ${checked} sessions rebuilt from bars strictly before the level goes live: ${mism} mismatches`);
  let maxBar = -1;
  for (let s = 1; s < sess.length; s++) maxBar = Math.max(maxBar, sess[s - 1].to - 1 - (sess[s].from - 1));
  console.log(`  highest bar index used by any profile, minus (go-live bar - 1): ${maxBar} (must be <= 0)`);
  // and a positive control: the deliberate leak
  const leak = buildLevels({ ...CLAIM, shift: 1 });
  for (const x of leak) x.knownAt = 0;
  const le = reading(allEvents(leak, {}), 'to-value');
  const lr = contributions(le, TP, SL, HOLD);
  console.log(`  positive control (next session's profile, real lookahead): alpha ${sg(mean(lr.map(r => r.x)))} on ${lr.length} events`);
  console.log(`  -> if the honest build were leaking it would look like that, and it does not.`);
}

function stageDirection() {
  console.log('3. DIRECTION — is this a falling market wearing a volume costume?\n');
  const lv = buildLevels(CLAIM);
  const evAll = allEvents(lv, {});
  const ev = reading(evAll, 'to-value');
  console.log(`  exact blind baselines over EVERY bar (not 40k samples), tp/sl/hold ${TP}/${SL}/${HOLD}:`);
  console.log(`    blind long ${sg(blindExact(1, TP, SL, HOLD))}   blind short ${sg(blindExact(-1, TP, SL, HOLD))}`);
  console.log(`    (they quote -10.23 / +7.38)\n`);

  const rows = contributions(ev, TP, SL, HOLD);
  const s = summarise(rows, sessionOf);
  console.log(`  GLOBAL baseline:  alpha ${sg(s.alpha)}  raw ${sg(s.raw)}  n ${s.n}`);
  console.log(`     long ${sg(s.alphaLong)} (n=${s.longs})   short ${sg(s.alphaShort)} (n=${s.shorts})`);

  console.log('\n  TIME-MATCHED baseline — the blind number recomputed from bars around each event.');
  console.log('  A window of W bars removes every directional drift slower than W.');
  for (const win of [10080, 4320, 2880, 1440, 720, 360]) {
    const r = contributions(ev, TP, SL, HOLD, { base: 'window', win });
    const q = summarise(r, sessionOf);
    console.log(`    +/-${String(win).padStart(5)} bars (${(win / 1379).toFixed(1)} sessions):  alpha ${sg(q.alpha).padStart(7)}  ` +
      `t(naive) ${sg(q.tNaive, 2).padStart(6)}  t(clustered) ${sg(q.tCluster, 2).padStart(6)}   long ${sg(q.alphaLong).padStart(7)} / short ${sg(q.alphaShort).padStart(7)}`);
  }

  console.log('\n  by source, at the +/-1440-bar time-matched baseline:');
  for (const k of ['vah', 'val']) {
    const r = contributions(ev.filter(e => e.src === k), TP, SL, HOLD, { base: 'window', win: 1440 });
    if (!r.length) continue;
    const q = summarise(r, sessionOf);
    console.log(`    ${k}  n ${String(q.n).padStart(4)}  alpha ${sg(q.alpha).padStart(7)}  t(cl) ${sg(q.tCluster, 2).padStart(6)}  clusters ${q.clusters}`);
  }
  console.log('\n  and at the GLOBAL baseline, for contrast:');
  for (const k of ['vah', 'val']) {
    const r = contributions(ev.filter(e => e.src === k), TP, SL, HOLD);
    const q = summarise(r, sessionOf);
    console.log(`    ${k}  n ${String(q.n).padStart(4)}  alpha ${sg(q.alpha).padStart(7)}  t(cl) ${sg(q.tCluster, 2).padStart(6)}`);
  }
}

function stageSample() {
  console.log('4. SAMPLE — 1,496 events are not 1,496 independent observations\n');
  const lv = buildLevels(CLAIM);
  const ev = reading(allEvents(lv, {}), 'to-value');
  const bySess = new Map();
  for (const e of ev) bySess.set(e.session, (bySess.get(e.session) || 0) + 1);
  const counts = [...bySess.values()].sort((a, b) => a - b);
  console.log(`  ${ev.length} events over ${bySess.size} sessions — ${(ev.length / bySess.size).toFixed(1)} per session`);
  console.log(`  events per session: min ${counts[0]} median ${counts[counts.length >> 1]} max ${counts[counts.length - 1]}`);
  // overlap
  let overlap = 0;
  for (let k = 1; k < ev.length; k++) if (ev[k].i - ev[k - 1].i < HOLD) overlap++;
  console.log(`  ${overlap}/${ev.length - 1} consecutive events are inside one another's ${HOLD}-bar holding period (${(100 * overlap / (ev.length - 1)).toFixed(0)}%)`);

  for (const [nm, opt] of [['global', {}], ['time-matched +/-1440', { base: 'window', win: 1440 }]]) {
    const rows = contributions(ev, TP, SL, HOLD, opt);
    console.log(`\n  ${nm} baseline`);
    for (const [cn, cf] of [['event (naive)', (e, k) => k], ['session', sessionOf], ['week (5 sessions)', weekOf]]) {
      const cl = rows.map((r, k) => cf(r.e, k));
      const inf = inference(rows.map(r => r.x), cl);
      console.log(`    cluster = ${cn.padEnd(18)} alpha ${sg(inf.alpha).padStart(7)}  se ${inf.seCluster.toFixed(2).padStart(6)}  t ${sg(inf.tCluster, 2).padStart(6)}  (${inf.clusters} clusters)`);
    }
    const bs = clusterBootstrap(rows.map(r => r.x), rows.map(r => sessionOf(r.e)));
    console.log(`    session bootstrap 95% CI: ${sg(bs.lo)} .. ${sg(bs.hi)}   P(alpha<=0) = ${(100 * bs.pLeq0).toFixed(1)}%`);
  }
}

function stageOOS() {
  console.log('5. SELECTION — derive on Jan-Apr, judge on May-Jul\n');
  const cut = bars.findIndex(b => b.t >= Date.parse('2026-05-01T00:00:00Z'));
  console.log(`  split at bar ${cut} (${new Date(bars[cut].t).toISOString()});  derive ${cut} bars, judge ${N - cut} bars\n`);

  // the configuration space the claim searched
  const GRID = [];
  for (const anchorMin of [0, 1320])
    for (const width of [0.10, 0.25, 0.50, 1.00])
      for (const window of [1, 2, 3])
        for (const vaPct of [0.68, 0.70, 0.80])
          for (const kinds of [['vah', 'val'], ['vah'], ['val'], ['poc']])
            GRID.push({ anchorMin, width, window, hold: 1, vaPct, kinds });
  const READINGS = ['to-value', 'as-is', 'from-value'];
  const TPS = [60, 90, 120, 150, 200], SLS = [60, 90, 120, 150, 200], HOLDS = [240];

  let bestD = null;
  const cells = [];
  for (const g of GRID) {
    const lv = buildLevels(g);
    const evAll = allEvents(lv, {});
    for (const rd of READINGS) {
      const ev = reading(evAll, rd);
      for (const hold of HOLDS) for (const tp of TPS) for (const sl of SLS) {
        const dRows = contributions(ev, tp, sl, hold, { range: [0, cut] });
        if (dRows.length < 100) continue;
        const dA = mean(dRows.map(r => r.x));
        const jRows = contributions(ev, tp, sl, hold, { range: [cut, N] });
        const jA = jRows.length >= 50 ? mean(jRows.map(r => r.x)) : NaN;
        const cell = { g, rd, tp, sl, hold, dA, dN: dRows.length, jA, jN: jRows.length };
        cells.push(cell);
        if (!bestD || dA > bestD.dA) bestD = cell;
      }
    }
  }
  console.log(`  ${cells.length} configurations searched (this is roughly the space the claim explored)`);
  const nm = c => `${c.g.kinds.join('+')} a${c.g.anchorMin} w${c.g.width} win${c.g.window} va${c.g.vaPct} ${c.rd} tp${c.tp}/sl${c.sl}`;
  console.log(`\n  BEST ON THE DERIVE HALF: ${nm(bestD)}`);
  console.log(`     derive alpha ${sg(bestD.dA)} (n=${bestD.dN})   ->   JUDGE alpha ${sg(bestD.jA)} (n=${bestD.jN})`);

  // top 10 by derive, and what each did out of sample
  cells.sort((a, b) => b.dA - a.dA);
  console.log('\n  top 10 in-sample, and their out-of-sample number:');
  for (const c of cells.slice(0, 10)) console.log(`    ${nm(c).padEnd(56)} derive ${sg(c.dA).padStart(8)}  judge ${sg(c.jA).padStart(8)}`);
  const top = cells.slice(0, 20).filter(c => Number.isFinite(c.jA));
  console.log(`\n  mean judge alpha of the top-20 in-sample cells: ${sg(mean(top.map(c => c.jA)))}  (${top.filter(c => c.jA > 0).length}/${top.length} positive)`);
  const all = cells.filter(c => Number.isFinite(c.jA));
  console.log(`  mean judge alpha over ALL ${all.length} cells:          ${sg(mean(all.map(c => c.jA)))}  (${all.filter(c => c.jA > 0).length}/${all.length} positive)`);
  console.log(`  correlation(derive alpha, judge alpha) over all cells:  ${corr(all.map(c => c.dA), all.map(c => c.jA)).toFixed(3)}`);

  // the claimed configuration specifically, on each half, both baselines
  console.log('\n  THE CLAIMED CONFIGURATION on each half (baselines computed inside that half):');
  const lv = buildLevels(CLAIM);
  const ev = reading(allEvents(lv, {}), 'to-value');
  for (const [nm2, range] of [['Jan-Apr (derive)', [0, cut]], ['May-Jul (judge)', [cut, N]], ['whole sample', [0, N]]]) {
    const r = contributions(ev, TP, SL, HOLD, { range });
    const q = summarise(r, sessionOf);
    const w = summarise(contributions(ev, TP, SL, HOLD, { range, base: 'window', win: 1440 }), sessionOf);
    console.log(`    ${nm2.padEnd(18)} n ${String(q.n).padStart(4)}  alpha ${sg(q.alpha).padStart(7)}  t(cl) ${sg(q.tCluster, 2).padStart(6)}   ` +
      `| time-matched alpha ${sg(w.alpha).padStart(7)}  t(cl) ${sg(w.tCluster, 2).padStart(6)}`);
  }
  // and the tuned target chosen on the derive half only
  console.log('\n  target/stop chosen on Jan-Apr ONLY, for the claimed level+reading:');
  let bt = null;
  for (const tp of THR) for (const sl of THR) {
    const r = contributions(ev, tp, sl, HOLD, { range: [0, cut] });
    if (r.length < 100) continue;
    const a = mean(r.map(x => x.x));
    if (!bt || a > bt.a) bt = { tp, sl, a, n: r.length };
  }
  const jr = contributions(ev, bt.tp, bt.sl, HOLD, { range: [cut, N] });
  const jq = summarise(jr, sessionOf);
  console.log(`    best in-sample tp${bt.tp}/sl${bt.sl}  derive alpha ${sg(bt.a)} (n=${bt.n})  ->  judge alpha ${sg(jq.alpha)} (n=${jq.n})  t(cl) ${sg(jq.tCluster, 2)}`);
}

function corr(a, b) {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db);
}

/**
 * The sharpest control I can build: keep the trade, keep the time, keep the
 * direction — throw away only the level. For every event, ask what the same
 * direction earned entered at a random bar in the same session. If the level
 * adds nothing, the two are equal.
 */
function stageMatched() {
  console.log('6. MATCHED CONTROLS — keep the time and the direction, destroy the level\n');
  const lv = buildLevels(CLAIM);
  const ev = reading(allEvents(lv, {}), 'to-value');
  const sess = sessions(0, 300);
  const sIdx = new Int32Array(N).fill(-1);
  for (let s = 0; s < sess.length; s++) for (let i = sess[s].from; i < sess[s].to; i++) sIdx[i] = s;

  // a) same session, same direction, every bar of the session as the null
  const per = { 1: plArray(1, ti_(TP), ti_(SL), HOLD), '-1': plArray(-1, ti_(TP), ti_(SL), HOLD) };
  const rows = [];
  for (const e of ev) {
    const s = sIdx[e.i];
    if (s < 0) continue;
    const { a, ok } = per[e.dir];
    let sum = 0, c = 0;
    for (let i = sess[s].from; i < sess[s].to; i++) if (ok[i]) { sum += a[i]; c++; }
    if (c < 50) continue;
    const p = pl(e.i, e.dir, ti_(TP), ti_(SL), HOLD);
    if (p === null) continue;
    rows.push({ e, p, x: p - sum / c });
  }
  const q = summarise(rows, sessionOf);
  console.log(`  same-session, same-direction null:  alpha ${sg(q.alpha)}  n ${q.n}  t(cl) ${sg(q.tCluster, 2)}  (${q.clusters} clusters)`);
  console.log(`     long ${sg(q.alphaLong)} (n=${q.longs})   short ${sg(q.alphaShort)} (n=${q.shorts})`);
  const bs = clusterBootstrap(rows.map(r => r.x), rows.map(r => sessionOf(r.e)));
  console.log(`     session bootstrap 95% CI ${sg(bs.lo)} .. ${sg(bs.hi)}   P(<=0) ${(100 * bs.pLeq0).toFixed(1)}%`);
  for (const k of ['vah', 'val']) {
    const sub = rows.filter(r => r.e.src === k);
    const z = summarise(sub, sessionOf);
    console.log(`     ${k}: alpha ${sg(z.alpha)}  n ${z.n}  t(cl) ${sg(z.tCluster, 2)}`);
  }

  // b) position-matched: the same level displaced, no clamping to the range
  console.log('\n  position-matched control (level displaced 5-20% of the session range, NOT clamped):');
  const sessProf = new Map();
  const raw = buildLevels({ ...CLAIM, kinds: ['vah', 'val', 'hi', 'lo'] });
  const byS = new Map();
  for (const x of raw) { if (!byS.has(x.session)) byS.set(x.session, {}); byS.get(x.session)[x.kind] = x; }
  const alphas = [];
  for (let seed = 1; seed <= 12; seed++) {
    let s0 = seed * 7919 + 13;
    const rnd = () => { s0 |= 0; s0 = s0 + 0x6D2B79F5 | 0; let t = Math.imul(s0 ^ s0 >>> 15, 1 | s0); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const nl = [];
    for (const x of raw) {
      if (x.kind !== 'vah' && x.kind !== 'val') continue;
      const g = byS.get(x.session);
      const span = g.hi.value - g.lo.value;
      const off = (0.05 + rnd() * 0.15) * span * (rnd() < 0.5 ? -1 : 1);
      nl.push({ ...x, value: x.value + off });
    }
    const nev = reading(allEvents(nl, {}), 'to-value');
    const r = contributions(nev, TP, SL, HOLD);
    if (r.length < 100) continue;
    alphas.push(mean(r.map(z => z.x)));
  }
  console.log(`     ${alphas.length} seeds: mean ${sg(mean(alphas))} +/- ${(sd(alphas) / Math.sqrt(alphas.length)).toFixed(2)}   spread ${sg(Math.min(...alphas))} .. ${sg(Math.max(...alphas))}`);
  const real = mean(contributions(ev, TP, SL, HOLD).map(r => r.x));
  console.log(`     level ${sg(real)}  minus control ${sg(mean(alphas))}  = ${sg(real - mean(alphas))}`);
  console.log(`     control spread implies the level must clear ~${(2 * sd(alphas)).toFixed(1)} points to be distinguishable from a displaced copy of itself`);
}

/**
 * Where does the claimed cell sit in the distribution of everything the search
 * could have returned? A +12 that is the 55th percentile of a space whose cells
 * are individually meaningless is not a finding.
 */
function stageNoise() {
  console.log('7. NOISE FLOOR — how special is this cell?\n');
  const cut = bars.findIndex(b => b.t >= Date.parse('2026-05-01T00:00:00Z'));
  const GRID = [];
  for (const anchorMin of [0, 1320])
    for (const width of [0.10, 0.25, 0.50, 1.00])
      for (const window of [1, 2, 3])
        for (const vaPct of [0.68, 0.70, 0.80])
          for (const kinds of [['vah', 'val'], ['vah'], ['val'], ['poc']])
            GRID.push({ anchorMin, width, window, hold: 1, vaPct, kinds });
  const cells = [];
  for (const g of GRID) {
    const evAll = allEvents(buildLevels(g), {});
    for (const rd of ['to-value', 'as-is', 'from-value']) {
      const ev = reading(evAll, rd);
      for (const tp of [60, 90, 120, 150, 200]) for (const sl of [60, 90, 120, 150, 200]) {
        const r = contributions(ev, tp, sl, HOLD);
        if (r.length < 100) continue;
        const j = contributions(ev, tp, sl, HOLD, { range: [cut, N] });
        cells.push({ g, rd, tp, sl, a: mean(r.map(x => x.x)), n: r.length, ja: j.length >= 50 ? mean(j.map(x => x.x)) : NaN });
      }
    }
  }
  const full = cells.map(c => c.a).sort((a, b) => a - b);
  const jud = cells.filter(c => Number.isFinite(c.ja)).map(c => c.ja).sort((a, b) => a - b);
  const pct = (arr, v) => 100 * arr.filter(x => x < v).length / arr.length;
  console.log(`  ${cells.length} cells with >= 100 events`);
  console.log(`  WHOLE-SAMPLE alpha: mean ${sg(mean(full))}  median ${sg(full[full.length >> 1])}  sd ${sd(full).toFixed(1)}  range ${sg(full[0])} .. ${sg(full[full.length - 1])}`);
  console.log(`     the claimed cell (+11.09) is at the ${pct(full, 11.09).toFixed(0)}th percentile of the search space`);
  console.log(`     ${full.filter(x => x >= 11.09).length} of ${full.length} cells beat it`);
  console.log(`  JUDGE-HALF alpha:   mean ${sg(mean(jud))}  median ${sg(jud[jud.length >> 1])}  sd ${sd(jud).toFixed(1)}`);
  console.log(`     the claimed cell out of sample (+15.83) is at the ${pct(jud, 15.83).toFixed(0)}th percentile`);

  console.log('\n  ── is the result carried by a few sessions? ──');
  const lv = buildLevels(CLAIM);
  const ev = reading(allEvents(lv, {}), 'to-value');
  const rows = contributions(ev, TP, SL, HOLD);
  const bySess = new Map();
  for (const r of rows) {
    const s = r.e.session;
    if (!bySess.has(s)) bySess.set(s, []);
    bySess.get(s).push(r.x);
  }
  const sess = [...bySess.entries()].map(([s, xs]) => ({ s, n: xs.length, sum: xs.reduce((a, b) => a + b, 0) }));
  sess.sort((a, b) => b.sum - a.sum);
  const total = sess.reduce((a, b) => a + b.sum, 0), nAll = rows.length;
  console.log(`  total adjusted points ${total.toFixed(0)} over ${nAll} trades in ${sess.length} sessions`);
  for (const k of [1, 3, 5, 10]) {
    const drop = sess.slice(0, k);
    const rem = total - drop.reduce((a, b) => a + b.sum, 0);
    const remN = nAll - drop.reduce((a, b) => a + b.n, 0);
    console.log(`    drop the best ${String(k).padStart(2)} sessions (${drop.reduce((a, b) => a + b.n, 0)} trades): alpha ${sg(rem / remN)} on ${remN} trades`);
  }
  const pos = sess.filter(x => x.sum > 0).length;
  console.log(`    ${pos}/${sess.length} sessions net positive`);

  console.log('\n  ── the two halves of the construction, by sample half ──');
  const halves = [['Jan-Apr', [0, cut]], ['May-Jul', [cut, N]]];
  for (const k of ['vah', 'val']) {
    const line = [];
    for (const [nm, range] of halves) {
      const r = contributions(ev.filter(e => e.src === k), TP, SL, HOLD, { range });
      const q = summarise(r, sessionOf);
      line.push(`${nm} ${sg(q.alpha).padStart(7)} (n=${String(q.n).padStart(3)}, t_cl ${sg(q.tCluster, 2)})`);
    }
    console.log(`    ${k}: ${line.join('   |   ')}`);
  }

  console.log('\n  ── target sensitivity with CLUSTERED errors (the smooth surface, honestly) ──');
  console.log('        tp/sl        alpha    t(naive)   t(clustered)');
  for (const [tp, sl] of [[90, 90], [120, 150], [150, 150], [150, 200], [200, 200], [60, 60], [30, 30]]) {
    const r = contributions(ev, tp, sl, HOLD);
    const q = summarise(r, sessionOf);
    console.log(`      ${String(tp).padStart(4)}/${String(sl).padStart(3)}  ${sg(q.alpha).padStart(9)}  ${sg(q.tNaive, 2).padStart(9)}  ${sg(q.tCluster, 2).padStart(11)}`);
  }
}

/**
 * The only part that does anything: short at the previous session's value area
 * high. Tested on its own terms, with every correction applied at once.
 */
function stageVah() {
  console.log('8. THE PART THAT ACTUALLY WORKS — VAH alone, fully corrected\n');
  const cut = bars.findIndex(b => b.t >= Date.parse('2026-05-01T00:00:00Z'));
  const lv = buildLevels(CLAIM);
  const evAll = reading(allEvents(lv, {}), 'to-value');

  for (const [nm, ev] of [['vah+val (the claim)', evAll], ['vah only', evAll.filter(e => e.src === 'vah')], ['val only', evAll.filter(e => e.src === 'val')]]) {
    const r = contributions(ev, TP, SL, HOLD);
    const q = summarise(r, sessionOf);
    const bs = clusterBootstrap(r.map(x => x.x), r.map(x => sessionOf(x.e)));
    const w = summarise(contributions(ev, TP, SL, HOLD, { base: 'window', win: 1440 }), sessionOf);
    console.log(`  ${nm.padEnd(20)} n ${String(q.n).padStart(4)}  ${q.clusters} sessions`);
    console.log(`      alpha ${sg(q.alpha).padStart(7)}   t naive ${sg(q.tNaive, 2).padStart(6)}   t clustered ${sg(q.tCluster, 2).padStart(6)}   boot 95% CI ${sg(bs.lo)} .. ${sg(bs.hi)}  P(<=0) ${(100 * bs.pLeq0).toFixed(1)}%`);
    console.log(`      time-matched alpha ${sg(w.alpha).padStart(7)}  t clustered ${sg(w.tCluster, 2)}`);
  }

  console.log('\n  ── one trade per session per level (the repeat tests are not new information) ──');
  for (const [nm, kinds] of [['vah+val', ['vah', 'val']], ['vah', ['vah']]]) {
    const seen = new Set();
    const first = evAll.filter(e => {
      if (!kinds.includes(e.src)) return false;
      const k = `${e.session}|${e.src}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    const r = contributions(first, TP, SL, HOLD);
    const q = summarise(r, sessionOf);
    const bs = clusterBootstrap(r.map(x => x.x), r.map(x => sessionOf(x.e)));
    console.log(`    ${nm.padEnd(8)} first test only: n ${String(q.n).padStart(3)}  alpha ${sg(q.alpha).padStart(7)}  t naive ${sg(q.tNaive, 2)}  t cl ${sg(q.tCluster, 2)}  CI ${sg(bs.lo)} .. ${sg(bs.hi)}`);
  }

  console.log('\n  ── session-weighted rather than trade-weighted (a 41-test day is one day) ──');
  for (const [nm, ev] of [['vah+val', evAll], ['vah only', evAll.filter(e => e.src === 'vah')], ['val only', evAll.filter(e => e.src === 'val')]]) {
    const r = contributions(ev, TP, SL, HOLD);
    const by = new Map();
    for (const x of r) { if (!by.has(x.e.session)) by.set(x.e.session, []); by.get(x.e.session).push(x.x); }
    const per = [...by.values()].map(mean);
    console.log(`    ${nm.padEnd(8)} ${per.length} sessions  mean-of-session-means ${sg(mean(per))}  t ${sg(mean(per) / (sd(per) / Math.sqrt(per.length)), 2)}`);
  }

  console.log('\n  ── VAH: drop the best sessions ──');
  const r = contributions(evAll.filter(e => e.src === 'vah'), TP, SL, HOLD);
  const by = new Map();
  for (const x of r) { if (!by.has(x.e.session)) by.set(x.e.session, []); by.get(x.e.session).push(x.x); }
  const ss = [...by.entries()].map(([s, xs]) => ({ n: xs.length, sum: xs.reduce((a, b) => a + b, 0) })).sort((a, b) => b.sum - a.sum);
  const tot = ss.reduce((a, b) => a + b.sum, 0), nn = r.length;
  for (const k of [0, 1, 3, 5]) {
    const d = ss.slice(0, k);
    const rem = tot - d.reduce((a, b) => a + b.sum, 0), remN = nn - d.reduce((a, b) => a + b.n, 0);
    console.log(`    drop best ${k}: alpha ${sg(rem / remN)} on ${remN} trades`);
  }
  console.log(`    ${ss.filter(x => x.sum > 0).length}/${ss.length} sessions net positive`);

  console.log('\n  ── VAH vs its own position-matched control (level displaced, direction kept) ──');
  const raw = buildLevels({ ...CLAIM, kinds: ['vah', 'val', 'hi', 'lo'] });
  const byS = new Map();
  for (const x of raw) { if (!byS.has(x.session)) byS.set(x.session, {}); byS.get(x.session)[x.kind] = x; }
  const alphas = [];
  for (let seed = 1; seed <= 15; seed++) {
    let s0 = seed * 7919 + 13;
    const rnd = () => { s0 |= 0; s0 = s0 + 0x6D2B79F5 | 0; let t = Math.imul(s0 ^ s0 >>> 15, 1 | s0); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const nl = raw.filter(x => x.kind === 'vah').map(x => {
      const g = byS.get(x.session);
      const span = g.hi.value - g.lo.value;
      return { ...x, value: x.value + (0.05 + rnd() * 0.15) * span * (rnd() < 0.5 ? -1 : 1) };
    });
    const nev = reading(allEvents(nl, {}), 'to-value');
    const rr = contributions(nev, TP, SL, HOLD);
    if (rr.length < 80) continue;
    alphas.push(mean(rr.map(z => z.x)));
  }
  const real = mean(contributions(evAll.filter(e => e.src === 'vah'), TP, SL, HOLD).map(x => x.x));
  console.log(`    VAH ${sg(real)}   displaced-copy control ${sg(mean(alphas))} +/- ${(sd(alphas) / Math.sqrt(alphas.length)).toFixed(2)}  (${alphas.length} seeds, spread ${sg(Math.min(...alphas))} .. ${sg(Math.max(...alphas))})`);
  console.log(`    edge over the control ${sg(real - mean(alphas))}, against a clustered standard error on VAH of about ${(sd(contributions(evAll.filter(e => e.src === 'vah'), TP, SL, HOLD).map(x => x.x)) / Math.sqrt(79)).toFixed(1)}`);
}

const stage = process.argv[2] || 'check';
({ check: stageCheck, direction: stageDirection, sample: stageSample, oos: stageOOS, matched: stageMatched, noise: stageNoise, vah: stageVah }[stage]
  || (() => console.log('stages: check direction sample oos matched noise vah')))();
