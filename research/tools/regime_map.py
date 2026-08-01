"""KAKASHI — Stage 1: market-regime mapping over the built-in 2026 XAUUSD M1 vault.

Every H1 bar gets a real label — TREND_UP / TREND_DOWN / RANGE / VOLATILE — scored
against the distribution of the dataset itself rather than hard-coded constants, so
the map reflects what this instrument actually did instead of a textbook threshold.
Output: labelled bars, contiguous segments with their realised price behaviour, and
the calendar stretches pure enough to use as per-regime tuning windows.
"""
import json
import numpy as np
import pandas as pd

SRC = "builtin2026.csv"
HTF = "1h"
WIN = 120                 # 5 trading days of H1 bars — regime is a multi-day property
ATR_LEN = 14
ADX_LEN = 14
VOL_LOOKBACK = 480        # ~20 days, trailing volatility reference
DWELL = 48                # a regime must hold 2 days before we believe it

TREND_CUT = 0.58          # trendiness percentile above which we call it a trend
VOL_CUT = 0.62            # volatility percentile that separates VOLATILE from RANGE


def wilder(s, n):
    return s.ewm(alpha=1.0 / n, adjust=False).mean()


def load_h1():
    df = pd.read_csv(SRC, usecols=["time", "open", "high", "low", "close", "volume"])
    df["time"] = pd.to_datetime(df["time"], utc=True, format="mixed")
    df = df.set_index("time").sort_index()
    h = df.resample(HTF).agg(
        {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    ).dropna(subset=["close"])
    return df, h


def add_metrics(h):
    high, low, close = h["high"], h["low"], h["close"]
    prev = close.shift(1)

    tr = pd.concat([high - low, (high - prev).abs(), (low - prev).abs()], axis=1).max(axis=1)
    h["atr"] = wilder(tr, ATR_LEN)

    up, dn = high.diff(), -low.diff()
    pdm = pd.Series(np.where((up > dn) & (up > 0), up, 0.0), index=h.index)
    mdm = pd.Series(np.where((dn > up) & (dn > 0), dn, 0.0), index=h.index)
    atr_adx = wilder(tr, ADX_LEN)
    pdi = 100 * wilder(pdm, ADX_LEN) / atr_adx
    mdi = 100 * wilder(mdm, ADX_LEN) / atr_adx
    dx = 100 * (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan)
    h["adx"] = wilder(dx.fillna(0), ADX_LEN)

    # Kaufman efficiency ratio — 1.0 is a straight line, 0.0 is pure back-and-forth
    net = (close - close.shift(WIN)).abs()
    path = close.diff().abs().rolling(WIN).sum()
    h["er"] = net / path.replace(0, np.nan)

    # least-squares fit of close over the window; slope scaled into ATR units
    x_c = np.arange(WIN, dtype=float) - (WIN - 1) / 2
    sxx = (x_c ** 2).sum()
    vals = close.to_numpy()
    slope = np.full(len(vals), np.nan)
    r2 = np.full(len(vals), np.nan)
    w = np.lib.stride_tricks.sliding_window_view(vals, WIN)
    y_c = w - w.mean(axis=1, keepdims=True)
    b = (y_c * x_c).sum(axis=1) / sxx
    ss_tot = (y_c ** 2).sum(axis=1)
    ss_res = ((y_c - b[:, None] * x_c) ** 2).sum(axis=1)
    slope[WIN - 1:] = b
    with np.errstate(invalid="ignore", divide="ignore"):
        r2[WIN - 1:] = np.where(ss_tot > 0, 1 - ss_res / ss_tot, np.nan)
    h["slope"] = slope
    h["r2"] = r2
    h["slope_atr"] = (h["slope"] * WIN) / h["atr"]   # total trend travel in ATRs

    h["atr_pct"] = h["atr"] / close * 100
    h["vol_rank"] = h["atr_pct"].rolling(VOL_LOOKBACK, min_periods=120).rank(pct=True)
    return h.dropna(subset=["adx", "er", "slope_atr", "r2", "vol_rank"])


def classify(h):
    """Blend four trend measures into one percentile score, then bucket every bar."""
    rank = lambda s: s.rank(pct=True)
    h["trendiness"] = (
        rank(h["er"]) + rank(h["adx"]) + rank(h["slope_atr"].abs()) + rank(h["r2"])
    ) / 4.0

    lab = pd.Series(index=h.index, dtype=object)
    is_trend = h["trendiness"] >= TREND_CUT
    lab[is_trend] = np.where(h.loc[is_trend, "slope_atr"] > 0, "TREND_UP", "TREND_DOWN")
    rest = ~is_trend
    lab[rest] = np.where(h.loc[rest, "vol_rank"] >= VOL_CUT, "VOLATILE", "RANGE")
    return lab


def smooth(lab, dwell=DWELL):
    """Majority vote, then absorb any run shorter than the dwell into its longer neighbour."""
    codes, uniq = pd.factorize(lab)
    s = pd.Series(codes, index=lab.index)
    maj = s.rolling(dwell, center=True, min_periods=dwell // 2).apply(
        lambda a: np.bincount(a.astype(int)).argmax(), raw=True
    )
    out = pd.Series(uniq[maj.ffill().bfill().astype(int)], index=lab.index)

    for _ in range(8):
        grp = (out != out.shift()).cumsum()
        if (out.groupby(grp).transform("size") >= dwell).all():
            break
        vals = out.to_numpy().copy()
        starts = np.flatnonzero((grp != grp.shift()).to_numpy())
        bounds = np.append(starts, len(vals))
        runs = [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]
        a, b = min(runs, key=lambda r: r[1] - r[0])          # shortest run first
        if b - a >= dwell:
            break
        left_len = a - starts[max(0, np.searchsorted(starts, a) - 1)] if a > 0 else -1
        right_len = (bounds[min(len(bounds) - 1, np.searchsorted(bounds, b) + 1)] - b) if b < len(vals) else -1
        take = vals[a - 1] if (a > 0 and left_len >= right_len) else (vals[b] if b < len(vals) else vals[a - 1])
        vals[a:b] = take
        out = pd.Series(vals, index=out.index)
    return out


def segments(lab, h):
    grp = (lab != lab.shift()).cumsum()
    rows = []
    for _, g in lab.groupby(grp):
        sl = h.loc[g.index]
        c0, c1 = sl["close"].iloc[0], sl["close"].iloc[-1]
        rows.append({
            "regime": g.iloc[0],
            "start": g.index[0].strftime("%Y-%m-%d %H:%M"),
            "end": g.index[-1].strftime("%Y-%m-%d %H:%M"),
            "hours": int(len(g)),
            "days": round(len(g) / 24, 1),
            "move_pts": round(c1 - c0, 1),
            "move_pct": round(100 * (c1 - c0) / c0, 2),
            "hi_lo_pts": round(sl["high"].max() - sl["low"].min(), 1),
            # how much of the range the net move captured: high = clean trend, low = chop
            "capture": round(abs(c1 - c0) / max(1e-9, sl["high"].max() - sl["low"].min()), 2),
            "avg_atr": round(sl["atr"].mean(), 2),
            "avg_adx": round(sl["adx"].mean(), 1),
            "avg_er": round(sl["er"].mean(), 3),
        })
    return pd.DataFrame(rows)


def main():
    m1, h = load_h1()
    h = add_metrics(h)
    lab = smooth(classify(h))
    h["regime"] = lab

    seg = segments(lab, h)
    seg.to_csv("regime_segments.csv", index=False)

    px = m1["close"]
    print(f"M1 candles      : {len(m1):,}")
    print(f"span            : {m1.index[0]:%Y-%m-%d} -> {m1.index[-1]:%Y-%m-%d}")
    print(f"H1 bars labelled: {len(h):,}")
    print(f"price           : {px.iloc[0]:.2f} -> {px.iloc[-1]:.2f}   "
          f"(low {px.min():.2f} / high {px.max():.2f})")

    print("\n=== time per regime ===")
    for k, v in lab.value_counts().items():
        print(f"{k:<11}{v:>5} bars{v/24:>7.1f} days{100*v/len(lab):>7.1f}%")

    print("\n=== monthly composition (% of hours) ===")
    idx = lab.index.tz_convert(None).to_period("M")
    month = lab.groupby([idx, lab.values]).size().unstack(fill_value=0)
    print((100 * month.T / month.sum(axis=1)).T.round(1).to_string())

    print("\n=== segments (>= 3 days) ===")
    big = seg[seg["days"] >= 3]
    print(big.to_string(index=False))

    print("\n=== longest stretch per regime ===")
    cand = {}
    for r in ["TREND_UP", "TREND_DOWN", "RANGE", "VOLATILE"]:
        s = seg[seg["regime"] == r].sort_values("days", ascending=False)
        cand[r] = s.head(5).to_dict("records")
        tot = seg.loc[seg["regime"] == r, "days"].sum()
        print(f"\n--- {r} (total {tot:.1f} days across {len(s)} segments) ---")
        print(s.head(5).to_string(index=False) if len(s) else "  none")
    json.dump(cand, open("regime_candidates.json", "w"), indent=2)

    h[["open", "high", "low", "close", "atr", "adx", "er", "slope_atr", "r2",
       "atr_pct", "vol_rank", "trendiness", "regime"]].to_csv("regime_h1.csv")
    print("\nwrote regime_segments.csv, regime_candidates.json, regime_h1.csv")


if __name__ == "__main__":
    main()
