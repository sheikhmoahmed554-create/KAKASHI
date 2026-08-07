'use strict';
// A band built out of measured reversals instead of a formula.
//
// Bollinger sets its distance from the standard deviation of closes, Keltner
// from a multiple of bar range, Donchian from the single most extreme bar and an
// envelope from a fixed percentage. None of them asks the question the chart
// actually poses: how far does price usually get before it turns around here.
//
// So: every time the market prints a local swing high, record how far that high
// sat above the centre, measured in bar-ranges. Keep the last M of those. The
// upper band is the distance that 70% of them stayed under. Same below, from the
// swing lows. The band is therefore asymmetric whenever rallies and dips are
// being punished differently, it is built from the wicks where the rejection
// actually happens rather than from closes, and it has no distance in points
// anywhere in it.
//
// Measured here against Bollinger and Keltner under the identical entry rule and
// the identical plan, so the only thing being compared is the band itself.
const { parseCSVFast } = require('./harness.js');
const fs = require('fs');
const PU = 0.1;

function sma(s, n) {
  const o = new Float64Array(s.length).fill(NaN);
  let a = 0;
  for (let i = 0; i < s.length; i++) { a += s[i]; if (i >= n) a -= s[i - n]; if (i >= n - 1) o[i] = a / n; }
  return o;
}
function ema(s, n) {
  const o = new Float64Array(s.length), a = 2 / (n + 1);
  let p = NaN;
  for (let i = 0; i < s.length; i++) { p = Number.isFinite(p) ? (s[i] - p) * a + p : s[i]; o[i] = p; }
  return o;
}
function stdev(s, n) {
  const o = new Float64Array(s.length).fill(NaN);
  let a = 0, q = 0;
  for (let i = 0; i < s.length; i++) {
    a += s[i]; q += s[i] * s[i];
    if (i >= n) { a -= s[i - n]; q -= s[i - n] * s[i - n]; }
    if (i >= n - 1) { const m = a / n; o[i] = Math.sqrt(Math.max(0, q / n - m * m)); }
  }
  return o;
}

function common(rows) {
  const n = rows.length;
  const H = new Float64Array(n), L = new Float64Array(n), C = new Float64Array(n), O = new Float64Array(n);
  for (let i = 0; i < n; i++) { H[i] = rows[i].high; L[i] = rows[i].low; C[i] = rows[i].close; O[i] = rows[i].open; }
  const rng = new Float64Array(n);
  for (let i = 0; i < n; i++) rng[i] = (H[i] - L[i]) / PU;
  return { n, H, L, C, O, rng, unit: sma(rng, 500) };
}

// ── the invention ────────────────────────────────────────────────────────────
// K is the swing half-width, M how many past swings the band remembers, P the
// percentile of them the band sits at.
function reversionBand(F, centreLen, K, M, P) {
  const { n, H, L, C, unit } = F;
  const centre = sma(C, centreLen);
  const up = new Float64Array(n).fill(NaN), dn = new Float64Array(n).fill(NaN);
  const hiD = [], loD = [];
  let lastUp = NaN, lastDn = NaN;
  for (let i = 0; i < n; i++) {
    // a swing is only known K bars after it happened, so the band never uses
    // information the chart did not have at the time
    const p = i - K;
    if (p - K >= 0 && Number.isFinite(centre[p]) && unit[p] > 0) {
      let isHi = true, isLo = true;
      for (let k = 1; k <= K; k++) {
        if (H[p - k] > H[p] || H[p + k] > H[p]) isHi = false;
        if (L[p - k] < L[p] || L[p + k] < L[p]) isLo = false;
      }
      if (isHi) {
        const d = (H[p] - centre[p]) / PU / unit[p];
        if (d > 0) { hiD.push(d); if (hiD.length > M) hiD.shift(); }
      }
      if (isLo) {
        const d = (centre[p] - L[p]) / PU / unit[p];
        if (d > 0) { loD.push(d); if (loD.length > M) loD.shift(); }
      }
    }
    if (hiD.length >= 20) {
      const a = hiD.slice().sort((x, y) => x - y);
      lastUp = a[Math.min(a.length - 1, Math.floor(a.length * P))];
    }
    if (loD.length >= 20) {
      const a = loD.slice().sort((x, y) => x - y);
      lastDn = a[Math.min(a.length - 1, Math.floor(a.length * P))];
    }
    if (Number.isFinite(centre[i]) && unit[i] > 0 && Number.isFinite(lastUp) && Number.isFinite(lastDn)) {
      up[i] = centre[i] + lastUp * unit[i] * PU;
      dn[i] = centre[i] - lastDn * unit[i] * PU;
    }
  }
  return { up, dn };
}

function bollinger(F, len, mult) {
  const m = sma(F.C, len), sd = stdev(F.C, len), n = F.n;
  const up = new Float64Array(n).fill(NaN), dn = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) { up[i] = m[i] + mult * sd[i]; dn[i] = m[i] - mult * sd[i]; }
  return { up, dn };
}
function keltner(F, len, mult) {
  const m = ema(F.C, len), r = new Float64Array(F.n), n = F.n;
  for (let i = 0; i < n; i++) r[i] = F.H[i] - F.L[i];
  const a = sma(r, len);
  const up = new Float64Array(n).fill(NaN), dn = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) { up[i] = m[i] + mult * a[i]; dn[i] = m[i] - mult * a[i]; }
  return { up, dn };
}
function donchian(F, len) {
  const n = F.n, up = new Float64Array(n).fill(NaN), dn = new Float64Array(n).fill(NaN);
  for (let i = len; i < n; i++) {
    let h = -1e18, l = 1e18;
    for (let k = 1; k <= len; k++) { if (F.H[i - k] > h) h = F.H[i - k]; if (F.L[i - k] < l) l = F.L[i - k]; }
    up[i] = h; dn[i] = l;
  }
  return { up, dn };
}

// the entry rule, identical for every band: price pierces the band and the bar
// closes back inside it
function signals(F, B) {
  const n = F.n, S = new Uint8Array(n), Bu = new Uint8Array(n);
  for (let i = 1; i < n; i++) {
    if (!Number.isFinite(B.up[i]) || !Number.isFinite(B.dn[i])) continue;
    if (F.H[i] > B.up[i] && F.C[i] < B.up[i]) S[i] = 1;
    if (F.L[i] < B.dn[i] && F.C[i] > B.dn[i]) Bu[i] = 1;
  }
  return { S, Bu };
}

// one position, stop wins a same-bar tie, plan stated in bar-ranges
function run(F, mask, side, tgt, stp) {
  const n = F.n, T = [];
  let live = null;
  for (let i = 600; i < n - 1; i++) {
    if (live) {
      const ht = side === 1 ? F.H[i] >= live.tp : F.L[i] <= live.tp;
      const hs = side === 1 ? F.L[i] <= live.sl : F.H[i] >= live.sl;
      let r = null;
      if (ht && hs) r = -live.s; else if (ht) r = live.t; else if (hs) r = -live.s;
      else if (i - live.bar >= 600) r = (side === 1 ? F.C[i] - live.en : live.en - F.C[i]) / PU;
      if (r !== null) { T.push(r); live = null; }
      continue;
    }
    if (!mask[i] || !(F.unit[i] > 0)) continue;
    const t = Math.max(10, F.unit[i] * tgt), s = Math.max(10, F.unit[i] * stp), en = F.C[i];
    live = { en, bar: i, t, s,
      tp: side === 1 ? en + t * PU : en - t * PU,
      sl: side === 1 ? en - s * PU : en + s * PU };
  }
  let net = 0, w = 0, eq = 0, peak = 0, dd = 0;
  for (const p of T) { net += p; if (p > 0) w++; eq += p; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
  return { n: T.length, wr: T.length ? +(100 * w / T.length).toFixed(1) : 0,
    net: Math.round(net), dd: Math.round(dd), per: T.length ? +(net / T.length).toFixed(2) : 0 };
}

// entering on every bar, same side and plan — what the year pays for no skill
function drift(F, side, tgt, stp) {
  const m = new Uint8Array(F.n).fill(1);
  return run(F, m, side, tgt, stp).per;
}

const TGT = 3, STP = 2;
const YEARS = [['2026', 'data2026.csv'], ['2021', 'data2021.csv'], ['2023', 'data2023.csv']];
const F = {}, DR = {};
for (const [yr, f] of YEARS) {
  F[yr] = common(parseCSVFast(fs.readFileSync(f, 'utf8')));
  DR[yr] = { 1: drift(F[yr], 1, TGT, STP), '-1': drift(F[yr], -1, TGT, STP) };
  process.stderr.write(yr + '  random entry pays  BUY ' + DR[yr][1] + '  SELL ' + DR[yr]['-1'] + ' pts/trade\n');
}

const BANDS = [
  ['REVERSION 200/8/60 p70', F2 => reversionBand(F2, 200, 8, 60, 0.70)],
  ['REVERSION 200/8/60 p85', F2 => reversionBand(F2, 200, 8, 60, 0.85)],
  ['REVERSION 100/5/80 p70', F2 => reversionBand(F2, 100, 5, 80, 0.70)],
  ['REVERSION 400/15/40 p70', F2 => reversionBand(F2, 400, 15, 40, 0.70)],
  ['Bollinger 20 x2', F2 => bollinger(F2, 20, 2)],
  ['Bollinger 100 x2.5', F2 => bollinger(F2, 100, 2.5)],
  ['Keltner 20 x2', F2 => keltner(F2, 20, 2)],
  ['Keltner 100 x2.5', F2 => keltner(F2, 100, 2.5)],
  ['Donchian 60', F2 => donchian(F2, 60)],
];

const out = [];
for (const [name, mk] of BANDS) {
  for (const side of [1, -1]) {
    const row = { band: name, side: side === 1 ? 'BUY' : 'SELL' };
    let worst = 1e9;
    for (const [yr] of YEARS) {
      const B = mk(F[yr]), sg = signals(F[yr], B);
      const r = run(F[yr], side === 1 ? sg.Bu : sg.S, side, TGT, STP);
      const edge = +(r.per - DR[yr][side]).toFixed(2);
      row['edge' + yr.slice(2)] = edge;
      row['n' + yr.slice(2)] = r.n;
      if (yr === '2026') { row.net26 = r.net; row.wr26 = r.wr; }
      if (edge < worst) worst = edge;
    }
    row.worst = worst;
    out.push(row);
  }
}
out.sort((a, b) => b.edge26 - a.edge26);
console.log('\nedge = points per trade above entering at random, same side, same year, same plan.\n');
console.table(out);
