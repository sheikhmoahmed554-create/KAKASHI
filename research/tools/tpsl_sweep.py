"""أعلى نسبة ربح على نظام الأهداف الموجود في SYR30.

نثبّت دخولات المؤشر الفعلية (٦,٤٦٣ صفقة على ٢٠٢٦) ونعيد محاكاة خطط الخروج وحدها،
فيصير كل فرق في النتيجة عائداً لنظام الأهداف لا لتغيّر الدخولات.

نموذج التنفيذ مُتحقَّق منه مقابل المحرك: تطابق ٩٩.٨١٪ صفقةً بصفقة.
  • الدخول على إغلاق شمعة الإشارة
  • الفحص يبدأ من الشمعة التالية
  • الوقف له الأولوية عند التصادم في الشمعة نفسها
  • أفق الحسم ٢٤٠ شمعة

    python3 research/tools/tpsl_sweep.py
"""
import csv
import gzip
import json
from collections import Counter

import numpy as np

PU = 0.1
MAXBARS = 240
TRADES = 'research/results/ab/A_baseline_trades.json.gz'
BARS = 'research/data/builtin2026.csv'      # الداتا التي شغّل عليها المحرك
NEVER = np.int32(1 << 30)

R16 = {(50, 60): 'BUY aligned', (40, 65): 'SELL aligned',
       (60, 60): 'BUY late', (45, 60): 'SELL late'}


def load_bars():
    t, h, l, c = [], [], [], []
    with open(BARS) as f:
        for r in csv.DictReader(f):
            t.append(r['time'][:19]); h.append(float(r['high']))
            l.append(float(r['low'])); c.append(float(r['close']))
    return t, np.array(h), np.array(l), np.array(c)


def build_paths(idx, side, h, l, c):
    """منحنى أقصى ربح متاح وأقصى خسارة متاحة، بالنقاط، عند كل شمعة بعد الدخول."""
    n, k = len(h), len(idx)
    mfe = np.zeros((k, MAXBARS), np.float32)
    mae = np.zeros((k, MAXBARS), np.float32)
    for a in range(k):
        i = idx[a]; ep = c[i]
        j0, j1 = i + 1, min(i + 1 + MAXBARS, n)
        m = j1 - j0
        if m <= 0:
            mfe[a, :] = -1e9; mae[a, :] = -1e9
            continue
        hh, ll = h[j0:j1], l[j0:j1]
        fav, adv = ((hh - ep) / PU, (ep - ll) / PU) if side[a] == 1 else ((ep - ll) / PU, (hh - ep) / PU)
        mfe[a, :m] = np.maximum.accumulate(fav)
        mae[a, :m] = np.maximum.accumulate(adv)
        if m < MAXBARS:
            mfe[a, m:] = mfe[a, m - 1]; mae[a, m:] = mae[a, m - 1]
    return mfe, mae


def evaluate(mfe, mae, tp, sl):
    """1 فوز / 0 خسارة / -1 غير محسوم. الوقف أولاً عند التعادل."""
    t_tp = np.where(mfe[:, -1] >= tp, (mfe >= tp).argmax(1).astype(np.int32), NEVER)
    t_sl = np.where(mae[:, -1] >= sl, (mae >= sl).argmax(1).astype(np.int32), NEVER)
    out = np.full(len(mfe), -1, np.int8)
    out[t_tp < t_sl] = 1
    out[(t_sl <= t_tp) & (t_sl < NEVER)] = 0
    return out, np.minimum(t_tp, t_sl)


def score(out, bars, tp, sl, label=None):
    w = int((out == 1).sum()); ls = int((out == 0).sum()); n = w + ls
    if n == 0:
        return None
    wr = 100.0 * w / n
    be = 100.0 * sl / (tp + sl)
    net = w * tp - ls * sl
    d = out >= 0
    r = {'tp': tp, 'sl': sl, 'trades': n, 'wins': w, 'losses': ls,
         'win_rate': round(wr, 2), 'breakeven': round(be, 2), 'edge': round(wr - be, 2),
         'net_points': int(net), 'per_trade': round(net / n, 3),
         'unresolved': int((~d).sum()),
         'avg_bars': round(float(bars[d].mean()), 1) if d.any() else 0}
    if label:
        r['label'] = label
    return r


def table(title, rows, k=12, note=''):
    print(f"\n═══ {title} ═══{note}")
    print(f"{'هدف':>5}{'وقف':>5}{'صفقات':>8}{'فوز%':>8}{'تعادل%':>9}{'حافة':>8}"
          f"{'صافي':>9}{'نقطة/صفقة':>11}{'شمعة':>7}")
    for r in rows[:k]:
        print(f"{r['tp']:>5}{r['sl']:>5}{r['trades']:>8}{r['win_rate']:>8.2f}"
              f"{r['breakeven']:>9.2f}{r['edge']:>+8.2f}{r['net_points']:>9}"
              f"{r['per_trade']:>11.3f}{r['avg_bars']:>7.0f}")


def main():
    raw = json.load(gzip.open(TRADES, 'rt'))
    t, h, l, c = load_bars()
    pos = {ts: i for i, ts in enumerate(t)}

    idx, side, own_tp, own_sl, own_win, months = [], [], [], [], [], []
    for tr in raw:
        i = pos.get(tr[0].replace('T', ' ')[:19])
        if i is None:
            continue
        idx.append(i); side.append(1 if tr[1] == 'BUY' else -1)
        own_tp.append(float(tr[4])); own_sl.append(float(tr[5]))
        own_win.append(1 if tr[2] == 'WIN' else 0)
        months.append(tr[0][:7])
    idx = np.array(idx); side = np.array(side)
    own_tp = np.array(own_tp); own_sl = np.array(own_sl)
    own_win = np.array(own_win); months = np.array(months)

    print(f"صفقات المؤشر المحمّلة: {len(idx):,} من {len(raw):,}")
    print("بناء مسارات الصفقات…", flush=True)
    mfe, mae = build_paths(idx, side, h, l, c)

    # ── التحقق ───────────────────────────────────────────────────────────────
    rep = np.full(len(idx), -1, np.int8)
    for (a, b) in set(zip(own_tp, own_sl)):
        m = (own_tp == a) & (own_sl == b)
        rep[m], _ = evaluate(mfe[m], mae[m], a, b)
    d = rep >= 0
    print(f"تحقّق: تطابق {100*(rep[d]==own_win[d]).mean():.2f}% • "
          f"محاكاة {100*rep[d].mean():.2f}% • مؤشر {100*own_win.mean():.2f}%")

    # ── وضع المؤشر الحالي كخط أساس ───────────────────────────────────────────
    base_w = int(own_win.sum()); base_n = len(own_win)
    base_net = int(sum(own_tp[i] if own_win[i] else -own_sl[i] for i in range(base_n)))
    print(f"\n╔══ خط الأساس — المؤشر كما هو الآن ══╗")
    print(f"  {base_n:,} صفقة • فوز {100*base_w/base_n:.2f}% • صافي {base_net:+,} نقطة "
          f"• {base_net/base_n:+.3f} نقطة/صفقة")

    print("\n═══ الخطط التي أصدرها نظام R16 فعلياً ═══")
    print(f"{'هدف':>5}{'وقف':>5}{'صفقات':>8}{'فوز%':>8}{'تعادل%':>9}{'حافة':>8}{'صافي':>9}   البروفايل")
    for (a, b), cnt in Counter(zip(own_tp, own_sl)).most_common(8):
        m = (own_tp == a) & (own_sl == b)
        wr = 100.0 * own_win[m].mean(); be = 100.0 * b / (a + b)
        net = int(own_win[m].sum() * a - (cnt - own_win[m].sum()) * b)
        print(f"{int(a):>5}{int(b):>5}{cnt:>8}{wr:>8.2f}{be:>9.2f}{wr-be:>+8.2f}{net:>9}"
              f"   {R16.get((int(a), int(b)), '—')}")

    # ── مسح الشبكة الكاملة ───────────────────────────────────────────────────
    TPS = list(range(10, 91, 1))
    SLS = list(range(20, 121, 1))
    print(f"\nمسح {len(TPS)*len(SLS):,} تركيبة هدف/وقف على {len(idx):,} صفقة…", flush=True)
    rows = []
    for tp in TPS:
        for sl in SLS:
            o, b = evaluate(mfe, mae, tp, sl)
            s = score(o, b, tp, sl)
            if s:
                rows.append(s)
    json.dump(rows, open('research/results/tpsl_grid_2026.json', 'w'), indent=1)

    ok = [r for r in rows if r['unresolved'] <= 0.02 * (r['trades'] + r['unresolved'])]
    table("أعلى نسبة فوز — بلا أي قيد", sorted(ok, key=lambda r: -r['win_rate']),
          note='   ⚠️ انظر عمود الصافي')
    table("أعلى نسبة فوز مع بقاء الصافي موجباً",
          sorted([r for r in ok if r['net_points'] > 0], key=lambda r: -r['win_rate']))
    table("أعلى حافة فوق التعادل", sorted(ok, key=lambda r: -r['edge']))
    table("أعلى صافي نقاط", sorted(ok, key=lambda r: -r['net_points']))
    table("ضمن قيود المشروع: هدف ٣٠–٦٠ ووقف ≤ هدف+٢٠، بأعلى فوز",
          sorted([r for r in ok if 30 <= r['tp'] <= 60 and r['sl'] <= r['tp'] + 20
                  and r['net_points'] > 0], key=lambda r: -r['win_rate']))

    # ── ثبات شهري لأفضل المرشّحين ────────────────────────────────────────────
    cands = sorted([r for r in ok if r['net_points'] > 0], key=lambda r: -r['win_rate'])[:3]
    cands += sorted(ok, key=lambda r: -r['net_points'])[:2]
    seen, uniq = set(), []
    for r in cands:
        k = (r['tp'], r['sl'])
        if k not in seen:
            seen.add(k); uniq.append(r)
    print("\n═══ الثبات الشهري لأفضل المرشّحين (نسبة الفوز لكل شهر) ═══")
    mons = sorted(set(months))
    print(f"{'خطة':>12}" + "".join(f"{m[-2:]:>8}" for m in mons) + f"{'أدنى':>8}")
    for r in uniq:
        o, _ = evaluate(mfe, mae, r['tp'], r['sl'])
        cells, lows = [], []
        for m in mons:
            sel = (months == m) & (o >= 0)
            v = 100.0 * o[sel].mean() if sel.sum() else float('nan')
            cells.append(f"{v:>8.1f}"); lows.append(v)
        print(f"{'TP'+str(r['tp'])+'/SL'+str(r['sl']):>12}" + "".join(cells) + f"{min(lows):>8.1f}")

    o, _ = evaluate(mfe, mae, 30, 50)
    print(f"\nللمقارنة، خطة المؤشر الأكثر استخداماً TP30/SL50 على كل الصفقات: "
          f"فوز {100*o[o>=0].mean():.2f}%")

    np.savez_compressed('research/results/tpsl_paths_2026.npz',
                        idx=idx, side=side, own_tp=own_tp, own_sl=own_sl,
                        own_win=own_win, months=months, mfe=mfe, mae=mae)
    print("\nكُتب research/results/tpsl_grid_2026.json + tpsl_paths_2026.npz")


if __name__ == '__main__':
    main()
