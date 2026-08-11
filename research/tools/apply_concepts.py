"""يطبّق المفاهيم الصامدة على صفقات SYR30 الفعلية، كمرشّحات.

    PYTHONPATH=research/tools python3 research/tools/apply_concepts.py <الخرج.json>

السؤال: لو لم يدخل المؤشر إلا حين يتحقق المفهوم س، كيف تتغيّر نتيجته؟
لا يحتاج إعادة تشغيل المحرك — صفقات المؤشر مسجّلة بأوقاتها، فنحسب حالة كل
مفهوم عند شمعة الدخول ونقسّم الصفقات عليه.

المفاهيم مأخوذة من نوافذ الكتالوج، ولا يُجرّب إلا ما صمد في السنوات الأربع.
"""
import datetime
import glob
import gzip
import io
import json
import re
import base64
import csv
import sys

import numpy as np

import window as W

FIELDS = ['entry_time', 'side', 'outcome', 'points', 'target', 'stop',
          'source', 'sc', 'kind', 'ep', 'xt']
MIN_KEEP = 200


def load_page_bars():
    """داتا الصفحة نفسها التي وُلّدت منها صفقات المؤشر، فالتوقيتات متطابقة."""
    page = open('KAKASHI_V16_TV_PARITY_AUDIT.html', encoding='utf-8').read()
    raw = gzip.decompress(base64.b64decode(
        re.search(r"BUILTIN_2026_GZ_B64='([^']*)'", page).group(1))).decode()
    t, o, h, l, c, v, sp = [], [], [], [], [], [], []
    for r in csv.DictReader(io.StringIO(raw)):
        t.append(r['time'])
        o.append(float(r['open'])); h.append(float(r['high'])); l.append(float(r['low']))
        c.append(float(r['close'])); v.append(float(r['volume'])); sp.append(float(r['spread']))
    return t, *(np.array(x) for x in (o, h, l, c, v, sp))


def build_features(t, o, h, l, c, v, sp):
    """نبني نفس القاموس الذي تتوقعه مولّدات النوافذ، من داتا الصفحة."""
    n = len(c)
    pc = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))
    d = {'o': o, 'h': h, 'l': l, 'c': c, 'v': v, 'sp': sp,
         'atr': W.rma(tr, 14) / W.PU, 'n': n}
    d['A'] = np.maximum(d['atr'], 1e-9)
    d['rng'] = np.maximum(h - l, 1e-9)
    for w in (10, 20, 60, 120, 240):
        hi, lo = W.roll(h, w, np.nanmax), W.roll(l, w, np.nanmin)
        d[f'phi{w}'], d[f'plo{w}'] = W.prev(hi), W.prev(lo)
        d[f'pos{w}'] = 100 * (c - lo) / np.maximum(hi - lo, 1e-9)
    for w in (30, 120, 480):
        d[f'slope{w}'] = ((c - W.prev(c, w)) / W.PU) / d['A']
    for p in (20, 50, 200):
        d[f'ema{p}'] = W.ema(c, p)
    dd = np.diff(c, prepend=c[0])
    for p in (3, 7, 14, 21):
        ru, rd = W.rma(np.maximum(dd, 0), p), W.rma(-np.minimum(dd, 0), p)
        d[f'rsi{p}'] = 100 - 100 / (1 + ru / np.maximum(rd, 1e-9))
    up = (c > o).astype(int); run = np.zeros(n)
    for i in range(1, n):
        run[i] = run[i - 1] + 1 if up[i] == up[i - 1] else 1
    d['run'] = run * np.where(up, 1, -1)
    d['warm'] = np.arange(n) > 500
    day = np.array([x[:10] for x in t])
    _, d['day_idx'] = np.unique(day, return_inverse=True)
    d['hour'] = np.array([int(x[11:13]) for x in t], np.int8)
    d['ndays'] = len(set(day))
    d['base_sig'] = W.base_signal(d)
    return d


def survivors():
    """أسماء المفاهيم التي اتفقت إشارتها في السنوات الأربع."""
    ok = set()
    for p in glob.glob('research/results/windows/*.json'):
        if 'trade_' in p:
            continue
        for nm, v in json.load(open(p)).items():
            ys = v.get('years', {})
            lifts = [ys.get(str(y), ys.get(y, {})).get('lift') for y in W.YEARS]
            if any(x is None for x in lifts):
                continue
            if min(lifts) > 0 or max(lifts) < 0:
                ok.add(nm)
    return ok


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else 'research/results/concepts_on_indicator.json'
    t, o, h, l, c, v, sp = load_page_bars()
    d = build_features(t, o, h, l, c, v, sp)
    idx = {datetime.datetime.fromisoformat(x).timestamp(): i for i, x in enumerate(t)}

    seen, rows = set(), []
    for p in sorted(glob.glob('research/results/seg/base_s*_trades.json.gz')):
        for r in json.loads(gzip.open(p).read()):
            x = dict(zip(FIELDS, r))
            if x['entry_time'] in seen:
                continue
            seen.add(x['entry_time'])
            ts = datetime.datetime.fromisoformat(x['entry_time'].replace('Z', '+00:00')).timestamp()
            i = idx.get(ts)
            if i is None:
                continue
            rows.append((i, 1 if x['outcome'] == 'WIN' else 0, float(x['points'] or 0),
                         1 if x['side'] == 'BUY' else -1))
    bars = np.array([r[0] for r in rows])
    win = np.array([r[1] for r in rows])
    pts = np.array([r[2] for r in rows])
    sides = np.array([r[3] for r in rows])
    base_wr = 100.0 * win.mean()
    base_pt = pts.mean()
    print(f'{len(rows)} صفقة من المؤشر • الأساس {base_wr:.2f}% • {base_pt:+.3f} نقطة/صفقة\n')

    keep = survivors()
    res = []
    for gname, gen in W.GROUPS.items():
        for name, side, mask in gen(d):
            if name not in keep:
                continue
            m = np.nan_to_num(mask, nan=False).astype(bool)[bars]
            # المرشّح يُطبّق على الصفقات التي توافق جهته
            sel = m & (sides == side)
            if sel.sum() < MIN_KEEP:
                continue
            wr = 100.0 * win[sel].mean()
            pt = pts[sel].mean()
            res.append({'group': gname, 'concept': name, 'side': int(side),
                        'kept': int(sel.sum()), 'share': round(100.0 * sel.sum() / len(rows), 1),
                        'win_rate': round(wr, 2), 'per_trade': round(float(pt), 3),
                        'd_win': round(wr - base_wr, 2), 'd_pts': round(float(pt - base_pt), 3)})
    res.sort(key=lambda r: -r['d_pts'])
    print(f"{'المفهوم':<34}{'جهة':<6}{'صفقات':>7}{'حصة':>7}{'فوز٪':>8}{'Δفوز':>8}{'نقطة':>9}{'Δنقطة':>9}")
    for r in res[:30]:
        s = 'شراء' if r['side'] == 1 else 'بيع'
        print(f"{r['concept'][:33]:<34}{s:<6}{r['kept']:>7}{r['share']:>6.1f}%"
              f"{r['win_rate']:>8.2f}{r['d_win']:>+8.2f}{r['per_trade']:>+9.2f}{r['d_pts']:>+9.2f}")
    json.dump({'baseline': {'trades': len(rows), 'win_rate': round(base_wr, 2),
                            'per_trade': round(float(base_pt), 3)}, 'filters': res},
              open(out_path, 'w'), ensure_ascii=False, indent=1)
    print(f'\n{len(res)} مرشّحاً مختبراً → {out_path}')


if __name__ == '__main__':
    main()
