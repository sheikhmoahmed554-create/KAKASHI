'use strict';
// Candidate centre-lines for the KNN navigator. The indicator ships with an HMA
// value / RMA target pair; these are the alternatives worth putting against it.
// Every one takes (series, length) and returns a Float64Array with NaN warm-up.

function sma(s, n) {
  const o = new Float64Array(s.length).fill(NaN);
  let a = 0;
  for (let i = 0; i < s.length; i++) {
    a += s[i];
    if (i >= n) a -= s[i - n];
    if (i >= n - 1) o[i] = a / n;
  }
  return o;
}
function wma(s, n) {
  const o = new Float64Array(s.length).fill(NaN), d = n * (n + 1) / 2;
  for (let i = n - 1; i < s.length; i++) { let a = 0; for (let k = 0; k < n; k++) a += s[i - k] * (n - k); o[i] = a / d; }
  return o;
}
function ema(s, n) {
  const o = new Float64Array(s.length).fill(NaN), a = 2 / (n + 1);
  let p = NaN;
  for (let i = 0; i < s.length; i++) { const v = s[i]; if (!Number.isFinite(v)) continue; p = Number.isFinite(p) ? (v - p) * a + p : v; o[i] = p; }
  return o;
}
function rma(s, n) {
  const o = new Float64Array(s.length).fill(NaN);
  let p = NaN, sd = 0, c = 0;
  for (let i = 0; i < s.length; i++) {
    const v = s[i]; if (!Number.isFinite(v)) continue;
    if (!Number.isFinite(p)) { sd += v; if (++c === n) { p = sd / n; o[i] = p; } }
    else { p = (p * (n - 1) + v) / n; o[i] = p; }
  }
  return o;
}
function hma(s, n) {
  const h = Math.max(1, Math.floor(n / 2)), q = Math.max(1, Math.floor(Math.sqrt(n)));
  const a = wma(s, h), b = wma(s, n), d = new Float64Array(s.length).fill(NaN);
  for (let i = 0; i < s.length; i++) d[i] = 2 * a[i] - b[i];
  return wma(d, q);
}
function dema(s, n) {
  const e1 = ema(s, n), e2 = ema(e1, n), o = new Float64Array(s.length).fill(NaN);
  for (let i = 0; i < s.length; i++) o[i] = 2 * e1[i] - e2[i];
  return o;
}
function tema(s, n) {
  const e1 = ema(s, n), e2 = ema(e1, n), e3 = ema(e2, n), o = new Float64Array(s.length).fill(NaN);
  for (let i = 0; i < s.length; i++) o[i] = 3 * e1[i] - 3 * e2[i] + e3[i];
  return o;
}
// Tillson T3 — smoother than TEMA at the same length, much less overshoot
function t3(s, n, vf) {
  const v = vf === undefined ? 0.7 : vf;
  const e1 = ema(s, n), e2 = ema(e1, n), e3 = ema(e2, n), e4 = ema(e3, n), e5 = ema(e4, n), e6 = ema(e5, n);
  const c1 = -v * v * v, c2 = 3 * v * v + 3 * v * v * v, c3 = -6 * v * v - 3 * v - 3 * v * v * v, c4 = 1 + 3 * v + v * v * v + 3 * v * v;
  const o = new Float64Array(s.length).fill(NaN);
  for (let i = 0; i < s.length; i++) o[i] = c1 * e6[i] + c2 * e5[i] + c3 * e4[i] + c4 * e3[i];
  return o;
}
// Arnaud Legoux — gaussian window with an offset, the usual 0.85 / 6
function alma(s, n, off, sig) {
  off = off === undefined ? 0.85 : off; sig = sig === undefined ? 6 : sig;
  const m = off * (n - 1), sd = n / sig, w = new Float64Array(n);
  let norm = 0;
  for (let k = 0; k < n; k++) { w[k] = Math.exp(-((k - m) * (k - m)) / (2 * sd * sd)); norm += w[k]; }
  const o = new Float64Array(s.length).fill(NaN);
  for (let i = n - 1; i < s.length; i++) { let a = 0; for (let k = 0; k < n; k++) a += s[i - (n - 1 - k)] * w[k]; o[i] = a / norm; }
  return o;
}
// least-squares (linear regression) line value at the current bar
function lsma(s, n) {
  const o = new Float64Array(s.length).fill(NaN);
  const sx = n * (n - 1) / 2, sxx = (n - 1) * n * (2 * n - 1) / 6, den = n * sxx - sx * sx;
  for (let i = n - 1; i < s.length; i++) {
    let sy = 0, sxy = 0;
    for (let k = 0; k < n; k++) { const y = s[i - (n - 1 - k)]; sy += y; sxy += k * y; }
    const slope = (n * sxy - sx * sy) / den, inter = (sy - slope * sx) / n;
    o[i] = inter + slope * (n - 1);
  }
  return o;
}
// Kaufman adaptive — speeds up in trend, crawls in chop
function kama(s, n, fast, slow) {
  fast = fast === undefined ? 2 : fast; slow = slow === undefined ? 30 : slow;
  const fc = 2 / (fast + 1), sc = 2 / (slow + 1);
  const o = new Float64Array(s.length).fill(NaN);
  let p = NaN;
  for (let i = 0; i < s.length; i++) {
    if (i < n) continue;
    let vol = 0;
    for (let k = 0; k < n; k++) vol += Math.abs(s[i - k] - s[i - k - 1]);
    const er = vol === 0 ? 0 : Math.abs(s[i] - s[i - n]) / vol;
    const a = Math.pow(er * (fc - sc) + sc, 2);
    p = Number.isFinite(p) ? p + a * (s[i] - p) : s[i];
    o[i] = p;
  }
  return o;
}
// Chande VIDYA — EMA whose alpha scales with the CMO
function vidya(s, n) {
  const o = new Float64Array(s.length).fill(NaN), a = 2 / (n + 1);
  let p = NaN;
  for (let i = 0; i < s.length; i++) {
    if (i < n) continue;
    let up = 0, dn = 0;
    for (let k = 0; k < n; k++) { const d = s[i - k] - s[i - k - 1]; if (d > 0) up += d; else dn -= d; }
    const cmo = (up + dn) === 0 ? 0 : Math.abs((up - dn) / (up + dn));
    p = Number.isFinite(p) ? p + a * cmo * (s[i] - p) : s[i];
    o[i] = p;
  }
  return o;
}
// McGinley dynamic — self-adjusting, hugs price without the lag of an EMA
function mcginley(s, n) {
  const o = new Float64Array(s.length).fill(NaN);
  let p = NaN;
  for (let i = 0; i < s.length; i++) {
    const v = s[i]; if (!Number.isFinite(v)) continue;
    if (!Number.isFinite(p)) p = v;
    else { const r = v / p; p = p + (v - p) / (n * Math.pow(r === 0 ? 1 : r, 4)); }
    o[i] = p;
  }
  return o;
}
// Ehlers 2-pole super smoother — near-zero lag, kills the 2-bar noise
function supersmoother(s, n) {
  const a = Math.exp(-Math.PI * Math.SQRT2 / n);
  const b = 2 * a * Math.cos(Math.PI * Math.SQRT2 / n);
  const c2 = b, c3 = -a * a, c1 = 1 - c2 - c3;
  const o = new Float64Array(s.length).fill(NaN);
  for (let i = 0; i < s.length; i++) {
    if (i < 2) { o[i] = s[i]; continue; }
    o[i] = c1 * (s[i] + s[i - 1]) / 2 + c2 * o[i - 1] + c3 * o[i - 2];
  }
  return o;
}
// rolling median — ignores the spike bars that drag every average around
function medianLine(s, n) {
  const o = new Float64Array(s.length).fill(NaN), buf = new Float64Array(n);
  for (let i = n - 1; i < s.length; i++) {
    for (let k = 0; k < n; k++) buf[k] = s[i - k];
    const a = Array.prototype.slice.call(buf).sort((x, y) => x - y);
    o[i] = n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }
  return o;
}
// the navigator's own line: mean of the k closest past HMA values to the RMA target
function knnLine(close, pLen, tLen, k) {
  const n = close.length, value = hma(close, pLen), target = rma(close, tLen), win = Math.max(k, 30);
  const out = new Float64Array(n).fill(NaN), dist = new Float64Array(k), vals = new Float64Array(k);
  for (let i = win; i < n; i++) {
    if (!Number.isFinite(target[i])) continue;
    dist.fill(1e10); vals.fill(0);
    for (let j = 1; j <= win; j++) {
      const v = value[i - j]; if (!Number.isFinite(v)) continue;
      const d = Math.abs(target[i] - v);
      let mi = 0, mv = dist[0];
      for (let q = 1; q < k; q++) if (dist[q] > mv) { mi = q; mv = dist[q]; }
      if (d < mv) { dist[mi] = d; vals[mi] = v; }
    }
    let a = 0; for (let q = 0; q < k; q++) a += vals[q];
    out[i] = a / k;
  }
  return out;
}

const BY_NAME = { SMA: sma, WMA: wma, EMA: ema, RMA: rma, HMA: hma, DEMA: dema, TEMA: tema,
  T3: t3, ALMA: alma, LSMA: lsma, KAMA: kama, VIDYA: vidya, MCG: mcginley, SSF: supersmoother,
  MEDIAN: medianLine };

module.exports = { sma, wma, ema, rma, hma, dema, tema, t3, alma, lsma, kama, vidya,
  mcginley, supersmoother, medianLine, knnLine, BY_NAME, NAMES: Object.keys(BY_NAME) };
