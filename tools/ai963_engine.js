'use strict';
/*
 * AI 963 V12 — JavaScript port used to measure the indicator on real data.
 *
 * The goal is fidelity, not elegance: every series is produced the way Pine
 * produces it, so a number that comes out of here can be trusted to describe
 * what the Pine build does on a TradingView chart.
 *
 * Fidelity notes, all of them deliberate:
 *   - Higher-timeframe lines are built on resampled candles and then exposed to
 *     the 1m stream with a one-bar lag, which is what `[1]` plus
 *     lookahead_on does in Pine: the last fully closed higher-timeframe value.
 *   - ta.rma / ta.ema / ta.hma / ta.wma / ta.atr follow Pine's recursions,
 *     including the SMA seed that ta.rma and ta.ema use on their first bar.
 *   - Signals are evaluated on closed candles only, matching barstate.isconfirmed.
 *   - Exits are computed into a pending buffer before entries and applied after,
 *     so a trade cannot close on its own entry candle and a slot freed on a bar
 *     is not reused on that same bar.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  Pine series primitives
//
//  Pine's ta.* functions ignore the leading na values a source may carry and
//  start counting from its first real value. Every primitive below therefore
//  finds that offset first; feeding a warmup NaN into a recursive average would
//  otherwise poison the whole series.
// ─────────────────────────────────────────────────────────────────────────────
function firstFinite(src) {
  for (let i = 0; i < src.length; i++) if (Number.isFinite(src[i])) return i;
  return src.length;
}

function sma(src, len) {
  const out = new Array(src.length).fill(NaN);
  const off = firstFinite(src);
  let sum = 0;
  for (let i = off; i < src.length; i++) {
    sum += src[i];
    if (i - off >= len) sum -= src[i - len];
    if (i - off >= len - 1) out[i] = sum / len;
  }
  return out;
}

/** Shared shape for the two recursive averages: SMA seed, then a fixed alpha. */
function recursive(src, len, alpha) {
  const out = new Array(src.length).fill(NaN);
  const off = firstFinite(src);
  let seed = 0;
  for (let i = off; i < src.length; i++) {
    const k = i - off;
    if (k < len - 1) { seed += src[i]; continue; }
    if (k === len - 1) { seed += src[i]; out[i] = seed / len; continue; }
    out[i] = alpha * src[i] + (1 - alpha) * out[i - 1];
  }
  return out;
}

const ema = (src, len) => recursive(src, len, 2 / (len + 1));
const rma = (src, len) => recursive(src, len, 1 / len);

function wma(src, len) {
  const out = new Array(src.length).fill(NaN);
  const off = firstFinite(src);
  const denom = (len * (len + 1)) / 2;
  for (let i = off + len - 1; i < src.length; i++) {
    let acc = 0;
    for (let k = 0; k < len; k++) acc += src[i - k] * (len - k);
    out[i] = acc / denom;
  }
  return out;
}

function hma(src, len) {
  const half = Math.max(1, Math.round(len / 2));
  const sqrtLen = Math.max(1, Math.round(Math.sqrt(len)));
  const a = wma(src, half);
  const b = wma(src, len);
  const diff = src.map((_, i) => 2 * a[i] - b[i]);
  return wma(diff, sqrtLen);
}

function atr(bars, len) {
  const tr = new Array(bars.length).fill(NaN);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    tr[i] = i === 0
      ? b.h - b.l
      : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c));
  }
  return rma(tr, len);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Line types offered by f_smooth. Only the ones reachable from the preset are
//  ported; asking for anything else is an error rather than a silent fallback.
// ─────────────────────────────────────────────────────────────────────────────
function smoothLine(type, src, len) {
  switch (type) {
    case 'RMA (original)': return rma(src, len);
    case 'EMA': return ema(src, len);
    case 'SMA': return sma(src, len);
    case 'WMA': return wma(src, len);
    case 'HMA': return hma(src, len);
    case 'DEMA': {
      const e1 = ema(src, len), e2 = ema(e1, len);
      return src.map((_, i) => 2 * e1[i] - e2[i]);
    }
    case 'TEMA': {
      const e1 = ema(src, len), e2 = ema(e1, len), e3 = ema(e2, len);
      return src.map((_, i) => 3 * e1[i] - 3 * e2[i] + e3[i]);
    }
    default: throw new Error(`line type not ported: ${type}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  KNN line. Mirrors meanOfKClosest: scan the last `window` values of the price
//  series, keep the `k` whose distance to the current target is smallest, and
//  average them. The replacement rule matches Pine's — a candidate replaces the
//  worst kept entry, and the initial 1e10 distances mean the first k candidates
//  always take a slot.
// ─────────────────────────────────────────────────────────────────────────────
function knnSeries(valueSeries, targetSeries, k, window) {
  const n = valueSeries.length;
  const out = new Array(n).fill(NaN);
  const dist = new Float64Array(k);
  const vals = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    const target = targetSeries[i];
    if (!Number.isFinite(target) || i < window) continue;
    dist.fill(1e10);
    vals.fill(0);
    let usable = true;
    for (let back = 1; back <= window; back++) {
      const v = valueSeries[i - back];
      if (!Number.isFinite(v)) { usable = false; break; }
      const d = Math.abs(target - v);
      let worstIdx = 0, worstVal = dist[0];
      for (let j = 1; j < k; j++) {
        if (dist[j] > worstVal) { worstIdx = j; worstVal = dist[j]; }
      }
      if (d < worstVal) { dist[worstIdx] = d; vals[worstIdx] = v; }
    }
    if (!usable) continue;
    let sum = 0;
    for (let j = 0; j < k; j++) sum += vals[j];
    out[i] = sum / k;
  }
  return out;
}

function priceSeries(kind, bars, len) {
  const close = bars.map(b => b.c);
  switch (kind) {
    case 'hl2': return sma(bars.map(b => (b.h + b.l) / 2), len);
    case 'sma': return sma(close, len);
    case 'wma': return wma(close, len);
    case 'ema': return ema(close, len);
    case 'hma': return hma(close, len);
    default: throw new Error(`price value not ported: ${kind}`);
  }
}

function targetSeries(kind, bars, len) {
  const close = bars.map(b => b.c);
  switch (kind) {
    case 'Price Action': return rma(close, len);
    case 'Volatility': return atr(bars, 14);
    case 'sma': return sma(close, len);
    case 'wma': return wma(close, len);
    case 'ema': return ema(close, len);
    case 'hma': return hma(close, len);
    default: throw new Error(`target value not ported: ${kind}`);
  }
}

/** Full KNN support/resistance line for one timeframe's candles. */
function knnLine(bars, cfg) {
  const value = priceSeries(cfg.priceValue, bars, cfg.priceLen);
  const target = targetSeries(cfg.targetValue, bars, cfg.targetLen);
  const window = Math.max(cfg.closest, 30);
  const knn = knnSeries(value, target, cfg.closest, window);
  return cfg.signalLine === 'KNN Classifier'
    ? wma(knn, 5)
    : smoothLine(cfg.lineType, knn, cfg.smoothing);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Resampling. Higher-timeframe candles are built from 1m bars on wall-clock
//  boundaries, the same buckets TradingView uses.
// ─────────────────────────────────────────────────────────────────────────────
function resample(bars, minutes) {
  if (minutes === 1) return { bars: bars.slice(), index: bars.map((_, i) => i) };
  const span = minutes * 60000;
  const out = [];
  const index = new Array(bars.length).fill(-1);
  let cur = null, curStart = -1;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const bucket = Math.floor(b.t / span) * span;
    if (cur === null || bucket !== curStart) {
      if (cur !== null) out.push(cur);
      cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c };
      curStart = bucket;
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
    }
    // Index of the higher-timeframe candle this 1m bar belongs to.
    index[i] = out.length;
  }
  if (cur !== null) out.push(cur);
  return { bars: out, index };
}

/**
 * Project a higher-timeframe series onto the 1m stream the way Pine's
 * `request.security(..., expr[1], lookahead_on)` does: while 1m bar i sits
 * inside higher-timeframe candle j, the visible value is the one from candle
 * j-1, which is the last candle that has fully closed.
 */
function projectConfirmed(series, index) {
  const out = new Array(index.length).fill(NaN);
  for (let i = 0; i < index.length; i++) {
    const j = index[i] - 1;
    out[i] = j >= 0 ? series[j] : NaN;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Signal engine — a direct transcription of f_lineSignalSet.
// ─────────────────────────────────────────────────────────────────────────────
function signalSet(bars, line, atr14, cfg, pointUnit) {
  const n = bars.length;
  const buyRej = new Uint8Array(n);
  const sellRej = new Uint8Array(n);
  const buyBrk = new Uint8Array(n);
  const sellBrk = new Uint8Array(n);

  for (let i = 1; i < n; i++) {
    const L = line[i], Lp = line[i - 1];
    if (!Number.isFinite(L) || !Number.isFinite(Lp)) continue;
    const a = cfg.useAtr ? atr14[i] : 1;
    if (cfg.useAtr && !Number.isFinite(a)) continue;

    const tol = cfg.useAtr ? a * cfg.touchAtr : cfg.touchPts * pointUnit;
    const minWick = cfg.useAtr ? a * cfg.wickAtr : cfg.wickPts * pointUnit;
    const buffer = cfg.useAtr ? a * cfg.bufferAtr : cfg.bufferPts * pointUnit;

    const b = bars[i], prevClose = bars[i - 1].c;
    const bodyLow = Math.min(b.o, b.c);
    const bodyHigh = Math.max(b.o, b.c);
    const lowerWick = Math.max(bodyLow - b.l, 0);
    const upperWick = Math.max(b.h - bodyHigh, 0);

    const wasAbove = prevClose > Lp;
    const wasBelow = prevClose < Lp;
    const touchFromAbove = b.l <= L + tol;
    const touchFromBelow = b.h >= L - tol;

    if (wasAbove && touchFromAbove && b.c > L && lowerWick > 0 && lowerWick >= minWick &&
        (!cfg.bodySameSide || bodyLow >= L)) buyRej[i] = 1;
    if (wasBelow && touchFromBelow && b.c < L && upperWick > 0 && upperWick >= minWick &&
        (!cfg.bodySameSide || bodyHigh <= L)) sellRej[i] = 1;
    if (prevClose <= Lp && b.l <= L + tol && b.c > L + buffer) buyBrk[i] = 1;
    if (prevClose >= Lp && b.h >= L - tol && b.c < L - buffer) sellBrk[i] = 1;
  }
  return { buyRej, sellRej, buyBrk, sellBrk };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Trade engine — eight slots, per-source cooldowns, fixed targets and stops.
//  `costPoints` charges the round-trip spread so a measured result is what the
//  account would have seen, not what the chart drew.
// ─────────────────────────────────────────────────────────────────────────────
function runBacktest(bars, sources, opts = {}) {
  const pointUnit = opts.pointUnit ?? 0.10;
  const sameCandleRule = opts.sameCandleRule ?? 'Skip';
  const costPoints = opts.costPoints ?? 0;
  const N = sources.length;

  const active = new Array(N).fill(false);
  const side = new Array(N).fill(0);
  const entryPx = new Array(N).fill(NaN);
  const tpPx = new Array(N).fill(NaN);
  const slPx = new Array(N).fill(NaN);
  const entryBar = new Array(N).fill(-1);
  const entryType = new Array(N).fill('');
  const lastTradeBar = new Array(N).fill(NaN);
  const lastBuyLossBar = new Array(N).fill(NaN);
  const lastSellLossBar = new Array(N).fill(NaN);

  const trades = [];
  let openCount = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // ── exits are decided first and cached, exactly like the Pine build ──
    const pending = [];
    for (let s = 0; s < N; s++) {
      if (!active[s] || i <= entryBar[s]) continue;
      const long = side[s] === 1;
      const hitTP = long ? bar.h >= tpPx[s] : bar.l <= tpPx[s];
      const hitSL = long ? bar.l <= slPx[s] : bar.h >= slPx[s];
      if (!hitTP && !hitSL) continue;

      let reason;
      if (hitTP && hitSL) {
        if (sameCandleRule === 'Skip') reason = 'SKIP';
        else if (sameCandleRule === 'Stop First') reason = 'SL';
        else reason = 'TP';
      } else reason = hitTP ? 'TP' : 'SL';

      const gross = reason === 'SKIP' ? 0
        : reason === 'TP' ? sources[s].tp
        : -sources[s].sl;
      pending.push({ s, reason, gross });
    }

    // ── entries, highest timeframe first so it wins a contested slot ──
    for (let off = 0; off < N; off++) {
      const s = N - 1 - off;
      const src = sources[s];
      const buy = src.buy[i] === 1;
      const sell = src.sell[i] === 1;
      const dir = buy && !sell ? 1 : sell && !buy ? -1 : 0;
      if (dir === 0 || active[s]) continue;
      if (src.respectOthers && openCount > 0) continue;

      const cdOK = !Number.isFinite(lastTradeBar[s]) || i - lastTradeBar[s] >= src.cooldown;
      const lossBar = dir === 1 ? lastBuyLossBar[s] : lastSellLossBar[s];
      const lossCd = dir === 1 ? src.buyCooldown : src.sellCooldown;
      const dirOK = !Number.isFinite(lossBar) || i - lossBar >= lossCd;
      if (!cdOK || !dirOK) continue;

      active[s] = true;
      side[s] = dir;
      entryPx[s] = bar.c;
      tpPx[s] = bar.c + dir * src.tp * pointUnit;
      slPx[s] = bar.c - dir * src.sl * pointUnit;
      entryBar[s] = i;
      entryType[s] = src.rejection[i] === 1 ? 'REJECTION' : 'BREAKOUT';
      openCount++;
    }

    // ── apply the cached exits ──
    for (const p of pending) {
      const s = p.s;
      const net = p.reason === 'SKIP' ? 0 : p.gross - costPoints;
      if (p.reason !== 'SKIP') {
        trades.push({
          source: sources[s].name,
          side: side[s] === 1 ? 'BUY' : 'SELL',
          type: entryType[s],
          entryBar: entryBar[s],
          exitBar: i,
          entryTime: bars[entryBar[s]].t,
          exitTime: bar.t,
          entryPrice: entryPx[s],
          reason: p.reason,
          grossPoints: p.gross,
          points: net,
          barsHeld: i - entryBar[s],
        });
      }
      lastTradeBar[s] = i;
      if (p.reason !== 'SKIP' && net <= 0) {
        if (side[s] === 1) lastBuyLossBar[s] = i; else lastSellLossBar[s] = i;
      }
      active[s] = false;
      side[s] = 0;
      entryPx[s] = NaN; tpPx[s] = NaN; slPx[s] = NaN;
      entryBar[s] = -1;
      openCount--;
    }
  }

  return { trades, openAtEnd: active.filter(Boolean).length };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Summary statistics, including the ones the chart table does not show:
//  profit factor, expectancy, and the worst peak-to-trough run in points.
// ─────────────────────────────────────────────────────────────────────────────
function summarize(trades) {
  const n = trades.length;
  if (n === 0) return { trades: 0 };
  let wins = 0, grossWin = 0, grossLoss = 0, net = 0;
  let curW = 0, curL = 0, maxW = 0, maxL = 0;
  let peak = 0, equity = 0, maxDD = 0;

  for (const t of trades) {
    net += t.points;
    equity += t.points;
    if (equity > peak) peak = equity;
    if (peak - equity > maxDD) maxDD = peak - equity;
    if (t.points > 0) {
      wins++; grossWin += t.points; curW++; curL = 0;
      if (curW > maxW) maxW = curW;
    } else {
      grossLoss += Math.abs(t.points); curL++; curW = 0;
      if (curL > maxL) maxL = curL;
    }
  }
  const losses = n - wins;
  return {
    trades: n,
    wins,
    losses,
    winRate: (100 * wins) / n,
    netPoints: net,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    expectancy: net / n,
    avgWin: wins ? grossWin / wins : 0,
    avgLoss: losses ? grossLoss / losses : 0,
    maxWinStreak: maxW,
    maxLossStreak: maxL,
    maxDrawdownPoints: maxDD,
  };
}

module.exports = {
  sma, ema, rma, wma, hma, atr,
  smoothLine, knnSeries, knnLine,
  resample, projectConfirmed,
  signalSet, runBacktest, summarize,
};
